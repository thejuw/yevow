import type {
  BayesianUpdateTrace,
  GlobalRiskConfig,
  InternalOrderBook,
  MarketRegime,
  MarketTick,
  OracleInstrumentState,
  OracleMemoryState,
  OraclePdf,
  OracleState,
  ProbabilityPoint
} from "../types";

const UPDATE_INTERVAL_MS = 300_000;
const PDF_POINTS = 41;
const EPSILON = 0.000001;
type OracleGovernanceConfig = Pick<
  GlobalRiskConfig,
  "ORACLE_GOVERNANCE_MODE" | "ORACLE_MANUAL_SKEPTICISM" | "ORACLE_MAX_SKEPTICISM"
>;

const DEFAULT_GOVERNANCE_CONFIG: OracleGovernanceConfig = {
  ORACLE_GOVERNANCE_MODE: "HYBRID",
  ORACLE_MANUAL_SKEPTICISM: 1.4,
  ORACLE_MAX_SKEPTICISM: 4
};

export class OracleAgent {
  private state: OracleState = defaultOracleState();
  private memory: OracleMemoryState = defaultOracleMemory();
  private states = new Map<string, OracleInstrumentState>();
  private memories = new Map<string, OracleMemoryState>();

  hydrate(state: OracleState | null | undefined): void {
    if (state?.schemaVersion === "oracle.v1") {
      this.state = sanitizeOracleState(state);
      this.states = new Map(Object.entries(state.instrumentStates ?? {}));
      this.memories = new Map(
        Object.entries(state.memoryByInstrument ?? {}).map(([instrument, memory]) => [
          instrument,
          sanitizeOracleMemory(memory)
        ])
      );
      if (state.instrumentCode) {
        const currentInstrumentState =
          this.states.get(state.instrumentCode) ?? stripOracleCollections(this.state);
        this.states.set(state.instrumentCode, currentInstrumentState);
        this.memory =
          this.memories.get(state.instrumentCode) ??
          {
            ...defaultOracleMemory(),
            variance: state.volatility ** 2,
            atr: state.atr,
            lastUpdateMs: state.updatedAt ? Date.parse(state.updatedAt) : 0
          };
        this.memories.set(state.instrumentCode, this.memory);
      }
    }
  }

  snapshot(): OracleState {
    return structuredCloneCompat({
      ...this.state,
      instrumentStates: Object.fromEntries(this.states),
      memoryByInstrument: Object.fromEntries(this.memories)
    });
  }

  processTick(input: {
    tick: MarketTick;
    book: InternalOrderBook;
    observedAt: string;
    config?: OracleGovernanceConfig;
  }): { state: OracleState; bayesianTrace: BayesianUpdateTrace | null; regimeChanged: boolean } {
    const instrumentCode = input.tick.instrumentCode;
    this.state = {
      ...defaultOracleState(),
      ...(this.states.get(instrumentCode) ?? {}),
      instrumentCode
    };
    this.memory = this.memories.get(instrumentCode) ?? defaultOracleMemory();
    const midPrice = input.book.midPrice ?? input.tick.price;
    const previousRegime = this.state.regime;
    this.updateSensors(midPrice, input.tick.size);
    const nowMs = Date.parse(input.observedAt);
    const shouldRefresh = nowMs - this.memory.lastUpdateMs >= UPDATE_INTERVAL_MS;
    const regime = shouldRefresh
      ? this.classifyRegime(input.book.weightedImbalance)
      : this.state.regime;
    const volatility = Math.max(Math.sqrt(this.memory.variance), EPSILON);
    const adx = this.calculateAdx();
    const atrToVolumeEfficiency = this.calculateAtrToVolumeEfficiency();
    const governance = resolveGovernanceConfig(input.config);
    const skepticismMultiplier = this.resolveSkepticismMultiplier(
      regime,
      adx,
      atrToVolumeEfficiency,
      governance
    );
    const pdf = this.generatePDF(midPrice, volatility, input.tick.instrumentCode);
    const bayesianTrace = this.maybeUpdatePosterior(
      pdf,
      input.book.weightedImbalance,
      input.observedAt,
      skepticismMultiplier
    );

    this.state = {
      schemaVersion: "oracle.v1",
      instrumentCode: input.tick.instrumentCode,
      regime,
      volatility,
      atr: this.memory.atr,
      adx,
      atrToVolumeEfficiency,
      skepticismMultiplier,
      governanceMode: governance.ORACLE_GOVERNANCE_MODE,
      manualSkepticism: governance.ORACLE_MANUAL_SKEPTICISM,
      maxSkepticism: governance.ORACLE_MAX_SKEPTICISM,
      profitTargetBps: profitTargetForRegime(regime),
      pdf,
      posteriorPdf: bayesianTrace ? this.state.posteriorPdf : this.state.posteriorPdf ?? pdf,
      lastBayesianUpdate: bayesianTrace ?? this.state.lastBayesianUpdate,
      updatedAt: input.observedAt
    };

    if (shouldRefresh) {
      this.memory.lastUpdateMs = nowMs;
    }

    this.states.set(instrumentCode, stripOracleCollections(this.state));
    this.memories.set(instrumentCode, { ...this.memory });

    return {
      state: this.snapshot(),
      bayesianTrace,
      regimeChanged: previousRegime !== this.state.regime
    };
  }

  generatePDF(
    currentPrice: number,
    volatility: number,
    instrumentCode: string,
    horizonSeconds = 60
  ): OraclePdf {
    const sigma = Math.max(currentPrice * volatility * Math.sqrt(horizonSeconds / 3600), EPSILON);
    const degreesOfFreedom = 5;
    const points: ProbabilityPoint[] = [];
    const minPrice = Math.max(EPSILON, currentPrice - sigma * 4);
    const step = (sigma * 8) / (PDF_POINTS - 1);
    let total = 0;

    for (let index = 0; index < PDF_POINTS; index += 1) {
      const price = minPrice + step * index;
      const z = (price - currentPrice) / sigma;
      const density = studentTDensity(z, degreesOfFreedom);
      const tailInflation = Math.abs(z) > 2 ? 1.25 : 1;
      const probability = density * tailInflation;
      points.push({ price: round(price, 8), probability });
      total += probability;
    }

    return {
      schemaVersion: "oracle.pdf.v1",
      instrumentCode,
      horizonSeconds,
      currentPrice: round(currentPrice, 8),
      volatility: round(volatility, 8),
      degreesOfFreedom,
      points: points.map((point) => ({
        ...point,
        probability: boundProbability(point.probability / Math.max(total, EPSILON))
      })),
      generatedAt: new Date().toISOString()
    };
  }

  probabilityAbove(price: number, pdf: OraclePdf | null = this.state.posteriorPdf): number {
    if (!pdf) {
      return 0.5;
    }

    return boundProbability(
      pdf.points
        .filter((point) => point.price >= price)
        .reduce((sum, point) => sum + point.probability, 0)
    );
  }

  private updateSensors(price: number, volume: number): void {
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }

    if (Number.isFinite(volume) && volume > 0) {
      this.observeVolume(volume);
    }

    if (this.memory.lastPrice === null) {
      this.memory.lastPrice = price;
      return;
    }

    const returnPct = Math.log(price / this.memory.lastPrice);
    this.memory.variance =
      0.000001 + 0.08 * returnPct ** 2 + 0.9 * Math.max(this.memory.variance, 0);
    this.memory.atr = this.memory.atr * 0.9 + Math.abs(price - this.memory.lastPrice) * 0.1;
    this.memory.trendEma = this.memory.trendEma * 0.9 + returnPct * 0.1;
    this.memory.lastPrice = price;
  }

  private classifyRegime(imbalance: number | null): MarketRegime {
    const adx = this.calculateAdx();
    const volatility = Math.max(Math.sqrt(this.memory.variance), EPSILON);

    if (volatility > 0.04 || Math.abs(imbalance ?? 0) > 0.85) {
      return "REGIME_CRISIS";
    }

    return adx >= 25 ? "REGIME_TREND" : "REGIME_RANGE";
  }

  private maybeUpdatePosterior(
    prior: OraclePdf,
    imbalance: number | null,
    observedAt: string,
    skepticismMultiplier: number
  ): BayesianUpdateTrace | null {
    if (imbalance === null || !Number.isFinite(imbalance)) {
      return null;
    }

    this.observeImbalance(imbalance);
    const sigma = Math.sqrt(this.memory.imbalanceM2 / Math.max(1, this.memory.imbalanceCount - 1));
    const adjustedSigma = sigma * skepticismMultiplier;
    const shifted =
      this.memory.lastImbalance !== null &&
      sigma > 0 &&
      Math.abs(imbalance - this.memory.lastImbalance) > adjustedSigma;
    this.memory.lastImbalance = imbalance;

    if (!shifted) {
      return null;
    }

    const priorBullishProbability = boundProbability(
      prior.points
        .filter((point) => point.price >= prior.currentPrice)
        .reduce((sum, point) => sum + point.probability, 0)
    );
    const likelihood = boundProbability(0.5 + imbalance / (2 * skepticismMultiplier));
    const posteriorBullishProbability = bayes(priorBullishProbability, likelihood);
    const scale = posteriorBullishProbability / Math.max(priorBullishProbability, EPSILON);
    const posteriorPoints = prior.points.map((point) => ({
      ...point,
      probability:
        point.price >= prior.currentPrice
          ? point.probability * scale
          : point.probability * (1 - posteriorBullishProbability) /
            Math.max(1 - priorBullishProbability, EPSILON)
    }));
    const total = posteriorPoints.reduce((sum, point) => sum + point.probability, 0);
    this.state.posteriorPdf = {
      ...prior,
      points: posteriorPoints.map((point) => ({
        ...point,
        probability: boundProbability(point.probability / Math.max(total, EPSILON))
      })),
      generatedAt: observedAt
    };

    return {
      priorBullishProbability,
      posteriorBullishProbability,
      delta: round(posteriorBullishProbability - priorBullishProbability, 8),
      evidence: { imbalance, sigma, adjustedSigma, skepticismMultiplier },
      updatedAt: observedAt
    };
  }

  private observeImbalance(value: number): void {
    this.memory.imbalanceCount += 1;
    const delta = value - this.memory.imbalanceMean;
    this.memory.imbalanceMean += delta / this.memory.imbalanceCount;
    this.memory.imbalanceM2 += delta * (value - this.memory.imbalanceMean);
  }

  private observeVolume(value: number): void {
    this.memory.volumeCount += 1;
    const delta = value - this.memory.volumeMean;
    this.memory.volumeMean += delta / this.memory.volumeCount;
    this.memory.volumeM2 += delta * (value - this.memory.volumeMean);
  }

  private calculateAdx(): number {
    return Math.min(100, Math.abs(this.memory.trendEma) * 100);
  }

  private calculateAtrToVolumeEfficiency(): number {
    if (this.memory.volumeMean <= 0) {
      return 0;
    }

    return round(this.memory.atr / Math.max(this.memory.volumeMean, EPSILON), 8);
  }

  private resolveSkepticismMultiplier(
    regime: MarketRegime,
    adx: number,
    atrToVolumeEfficiency: number,
    config: OracleGovernanceConfig
  ): number {
    const maxSkepticism = Math.max(1, config.ORACLE_MAX_SKEPTICISM);
    const manual = Math.min(maxSkepticism, Math.max(1, config.ORACLE_MANUAL_SKEPTICISM));

    if (config.ORACLE_GOVERNANCE_MODE === "MANUAL") {
      return round(manual, 4);
    }

    const rangingPenalty = regime === "REGIME_RANGE" ? 1 + Math.max(0, 25 - adx) / 25 : 1;
    const crisisPenalty = regime === "REGIME_CRISIS" ? 1.5 : 1;
    const liquidityPenalty = Math.min(1.5, Math.max(0, atrToVolumeEfficiency) * 10);
    const autonomous = Math.min(maxSkepticism, Math.max(1, rangingPenalty * crisisPenalty + liquidityPenalty));

    if (config.ORACLE_GOVERNANCE_MODE === "AUTONOMOUS") {
      return round(autonomous, 4);
    }

    return round(Math.min(maxSkepticism, Math.max(manual, autonomous)), 4);
  }
}

export function defaultOracleState(): OracleState {
  return {
    schemaVersion: "oracle.v1",
    instrumentCode: null,
    regime: "REGIME_RANGE",
    volatility: 0,
    atr: 0,
    adx: 0,
    atrToVolumeEfficiency: 0,
    skepticismMultiplier: DEFAULT_GOVERNANCE_CONFIG.ORACLE_MANUAL_SKEPTICISM,
    governanceMode: DEFAULT_GOVERNANCE_CONFIG.ORACLE_GOVERNANCE_MODE,
    manualSkepticism: DEFAULT_GOVERNANCE_CONFIG.ORACLE_MANUAL_SKEPTICISM,
    maxSkepticism: DEFAULT_GOVERNANCE_CONFIG.ORACLE_MAX_SKEPTICISM,
    profitTargetBps: profitTargetForRegime("REGIME_RANGE"),
    pdf: null,
    posteriorPdf: null,
    lastBayesianUpdate: null,
    instrumentStates: {},
    memoryByInstrument: {},
    updatedAt: null
  };
}

function sanitizeOracleState(state: OracleState): OracleState {
  return {
    ...state,
    volatility: Math.max(0, state.volatility),
    atr: Math.max(0, state.atr),
    adx: Math.max(0, state.adx),
    atrToVolumeEfficiency: Math.max(0, state.atrToVolumeEfficiency ?? 0),
    skepticismMultiplier: Math.max(1, state.skepticismMultiplier ?? DEFAULT_GOVERNANCE_CONFIG.ORACLE_MANUAL_SKEPTICISM),
    governanceMode:
      state.governanceMode === "MANUAL" ||
      state.governanceMode === "AUTONOMOUS" ||
      state.governanceMode === "HYBRID"
        ? state.governanceMode
        : DEFAULT_GOVERNANCE_CONFIG.ORACLE_GOVERNANCE_MODE,
    manualSkepticism: Math.max(
      1,
      state.manualSkepticism ?? DEFAULT_GOVERNANCE_CONFIG.ORACLE_MANUAL_SKEPTICISM
    ),
    maxSkepticism: Math.max(
      1,
      state.maxSkepticism ?? DEFAULT_GOVERNANCE_CONFIG.ORACLE_MAX_SKEPTICISM
    ),
    instrumentStates: state.instrumentStates ?? {},
    memoryByInstrument: state.memoryByInstrument ?? {}
  };
}

function defaultOracleMemory(): OracleMemoryState {
  return {
    lastPrice: null,
    lastUpdateMs: 0,
    variance: 0,
    atr: 0,
    trendEma: 0,
    imbalanceMean: 0,
    imbalanceM2: 0,
    imbalanceCount: 0,
    lastImbalance: null,
    volumeMean: 0,
    volumeM2: 0,
    volumeCount: 0
  };
}

function sanitizeOracleMemory(memory: OracleMemoryState): OracleMemoryState {
  return {
    lastPrice: Number.isFinite(memory.lastPrice) ? memory.lastPrice : null,
    lastUpdateMs: Number.isFinite(memory.lastUpdateMs) ? memory.lastUpdateMs : 0,
    variance: Math.max(0, Number(memory.variance) || 0),
    atr: Math.max(0, Number(memory.atr) || 0),
    trendEma: Number.isFinite(memory.trendEma) ? memory.trendEma : 0,
    imbalanceMean: Number.isFinite(memory.imbalanceMean) ? memory.imbalanceMean : 0,
    imbalanceM2: Math.max(0, Number(memory.imbalanceM2) || 0),
    imbalanceCount: Math.max(0, Math.floor(Number(memory.imbalanceCount) || 0)),
    lastImbalance: Number.isFinite(memory.lastImbalance) ? memory.lastImbalance : null,
    volumeMean: Number.isFinite(memory.volumeMean) ? memory.volumeMean : 0,
    volumeM2: Math.max(0, Number(memory.volumeM2) || 0),
    volumeCount: Math.max(0, Math.floor(Number(memory.volumeCount) || 0))
  };
}

function resolveGovernanceConfig(
  config: OracleGovernanceConfig | undefined
): OracleGovernanceConfig {
  return {
    ORACLE_GOVERNANCE_MODE:
      config?.ORACLE_GOVERNANCE_MODE === "MANUAL" ||
      config?.ORACLE_GOVERNANCE_MODE === "AUTONOMOUS" ||
      config?.ORACLE_GOVERNANCE_MODE === "HYBRID"
        ? config.ORACLE_GOVERNANCE_MODE
        : DEFAULT_GOVERNANCE_CONFIG.ORACLE_GOVERNANCE_MODE,
    ORACLE_MANUAL_SKEPTICISM: Math.max(
      1,
      Number(config?.ORACLE_MANUAL_SKEPTICISM) ||
        DEFAULT_GOVERNANCE_CONFIG.ORACLE_MANUAL_SKEPTICISM
    ),
    ORACLE_MAX_SKEPTICISM: Math.max(
      1,
      Number(config?.ORACLE_MAX_SKEPTICISM) ||
        DEFAULT_GOVERNANCE_CONFIG.ORACLE_MAX_SKEPTICISM
    )
  };
}

function stripOracleCollections(state: OracleState): OracleInstrumentState {
  const { instrumentStates: _instrumentStates, memoryByInstrument: _memoryByInstrument, ...rest } = state;
  return rest;
}

function profitTargetForRegime(regime: MarketRegime): number {
  switch (regime) {
    case "REGIME_TREND":
      return 35;
    case "REGIME_CRISIS":
      return 80;
    default:
      return 12;
  }
}

function studentTDensity(z: number, degreesOfFreedom: number): number {
  return (1 + z ** 2 / degreesOfFreedom) ** (-(degreesOfFreedom + 1) / 2);
}

function bayes(prior: number, likelihood: number): number {
  const numerator = likelihood * prior;
  const denominator = numerator + (1 - likelihood) * (1 - prior);
  return boundProbability(numerator / Math.max(denominator, EPSILON));
}

function boundProbability(value: number): number {
  return Math.min(1 - EPSILON, Math.max(EPSILON, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function structuredCloneCompat<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

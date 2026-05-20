import { defaultConfig } from "../../../ConfigManager";
import { neutralMacroBias } from "../../../Governor";
import { defaultLiquidationHeatmapState } from "../../../agents/HeatmapAgent";
import { defaultOracleState } from "../../../agents/OracleAgent";
import { defaultSentimentState } from "../../../agents/SentimentAgent";
import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import { defaultEngineLocation } from "../helpers/PlacementResolver";
import { roundMetric } from "../book/SortedBookSide";
import { finiteNumber, readPositiveNumber } from "../helpers/RuntimeParsing";
import { finiteMetric, nullableFiniteMetric } from "../helpers/RuntimeMetrics";
import {
  defaultAssetMatrix,
  defaultAssetQuoteStates,
  defaultQuoteState
} from "./AssetStateRuntime";
import {
  DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
  DEFAULT_JITTER_SAMPLE_WINDOW,
  DEFAULT_JITTER_THRESHOLD_MS,
  DEFAULT_MAX_INVENTORY_DELTA,
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_MAX_LATENCY_MS,
  DEFAULT_PAPER_BANKROLL_USD,
  DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
  DEFAULT_SHADOW_VLO_CAPACITY,
  DEFAULT_SHADOW_VLO_DRIFT_TRADES,
  DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
  DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
  DEFAULT_SOURCE_WEIGHT
} from "../../../TradingEngineConstants";
import type {
  AdminConfigUpdate,
  AgentHealth,
  AgentName,
  AgentSignal,
  EngineState,
  Env,
  ExecutionProfile,
  InventoryState,
  MicrostructureMetrics,
  PriceDiscoveryMetrics,
  ProfilerState,
  RiskLimits,
  ShadowQueueState
} from "../../../types";

export function defaultEngineState(engineId: string): EngineState {
  const now = new Date().toISOString();
  const agentHealth = Object.fromEntries(
    (
      [
        "ORACLE",
        "SENTIMENT",
        "PROFILER",
        "CROUPIER",
        "PIT_BOSS",
        "JANITOR",
        "EXECUTIONER",
        "MOLTWORKER",
        "RISK",
        "SYSTEM"
      ] as AgentName[]
    ).map((agent) => [
      agent,
      {
        status: "YELLOW",
        heartbeatAt: now,
        latencyMs: 0,
        failures24h: 0
      } satisfies AgentHealth
    ])
  ) as Record<AgentName, AgentHealth>;

  return {
    engineId,
    mode: "PAPER",
    bankroll: {
      currency: "USD",
      cash: 0,
      equity: 0,
      realizedPnl: 0,
      updatedAt: now
    },
    openPositions: {},
    agentHealth,
    risk: defaultRiskLimits(),
    processedTicks: 0,
    acceptedSignals: 0,
    internalOrderBookDepth: 0,
    averageLatency: 0,
    latencySampleCount: 0,
    staleTickCount: 0,
    toxicityScore: 0,
    current_inventory_delta: 0,
    liquidationHeatmap: defaultLiquidationHeatmapState(),
    maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
    cachedConfig: { ...defaultConfig },
    macroBias: neutralMacroBias(),
    temporaryOverride: null,
    assetMatrix: defaultAssetMatrix(defaultConfig, neutralMacroBias(), now),
    profilerStates: {},
    location: defaultEngineLocation(),
    fundingRates: {},
    microstructure: defaultMicrostructure(),
    priceDiscovery: defaultPriceDiscovery(),
    oracle: defaultOracleState(),
    sentiment: defaultSentimentState(),
    ensemble: defaultEnsembleState(now),
    leadLag: defaultLeadLagMetrics(),
    inventory: defaultInventoryState(DEFAULT_MAX_INVENTORY_UNITS),
    riskMetrics: defaultRiskMetrics(0, now),
    quoteState: defaultQuoteState(),
    assetQuoteStates: defaultAssetQuoteStates(defaultConfig, neutralMacroBias(), now),
    shadowQueue: defaultShadowQueueState(null),
    lastTradeIntent: null,
    inventoryGuard: defaultInventoryGuardState(),
    janitor: defaultJanitorState(),
    slippage: defaultSlippageAnalytics(),
    orderMap: {},
    executionProfile: defaultExecutionProfile(
      DEFAULT_JITTER_THRESHOLD_MS,
      DEFAULT_JITTER_SAMPLE_WINDOW,
      DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
      0
    ),
    citadel: defaultCitadelState(now),
    dom: null,
    anomaly: defaultAnomalyStatus(),
    heartbeatAt: now,
    updatedAt: now
  };
}

export function defaultEnsembleState(observedAt: string): EngineState["ensemble"] {
  return {
    schemaVersion: "ensemble.v1",
    confidence: 0,
    kellyMultiplier: 0,
    regimeMultiplier: 1,
    anomalyCircuitBreaker: false,
    votes: [],
    rationale: "ENSEMBLE_NOT_EVALUATED",
    updatedAt: observedAt
  };
}

export function normalizePaperBankroll(
  bankroll: EngineState["bankroll"],
  env: Env,
  observedAt: string
): EngineState["bankroll"] {
  const cash = bankroll.cash;
  const equity = bankroll.equity;

  if (
    !isShadowMode(env) ||
    (Number.isFinite(cash) && cash > 0) ||
    (Number.isFinite(equity) && equity > 0)
  ) {
    return bankroll;
  }

  const paperBankroll = readPositiveNumber(env.PAPER_BANKROLL_USD, DEFAULT_PAPER_BANKROLL_USD);

  return {
    ...bankroll,
    cash: paperBankroll,
    equity: paperBankroll,
    realizedPnl: bankroll.realizedPnl ?? 0,
    updatedAt: observedAt
  };
}

export function parseDeltaNormalizationWeights(value: string | undefined): Record<string, number> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, weight]) => [key.toLowerCase(), Number(weight)] as const)
        .filter(([, weight]) => Number.isFinite(weight) && weight >= 0)
    );
  } catch {
    return {};
  }
}

export function inferSignalBias(signal: AgentSignal): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (signal.action === "BUY" || signal.expectedValue > 0) {
    return "BULLISH";
  }

  if (signal.action === "SELL" || signal.action === "REDUCE" || signal.expectedValue < 0) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

export function hawkesEvacuationSignal(signal: AgentSignal): boolean {
  return signal.action === "PAUSE" && signal.featureVector?.signalType === "HAWKES_FLOW_CLUSTER";
}

export function touchAgentHealth(
  current: Record<AgentName, AgentHealth>,
  agentName: AgentName,
  status: AgentHealth["status"],
  heartbeatAt: string,
  latencyMs: number,
  lastSignalId?: string
): Record<AgentName, AgentHealth> {
  return {
    ...current,
    [agentName]: {
      status,
      heartbeatAt,
      latencyMs,
      lastSignalId: lastSignalId ?? current[agentName].lastSignalId,
      failures24h: current[agentName].failures24h
    }
  };
}

export function disabledProfilerEvaluation(
  state: ProfilerState,
  observedAt: string
): ProfilerEvaluation {
  return {
    processed: false,
    skippedReason: "PROFILER_AGENT_DISABLED",
    closedBuckets: 0,
    toxicityScore: 0,
    state: {
      ...state,
      toxicityScore: 0,
      amVpinScore: 0,
      toxicityState: "NORMAL",
      pressureSide: "NEUTRAL",
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      quoteHaltUntil: null,
      updatedAt: observedAt
    },
    signal: null
  };
}

export function disabledCroupierDecision(minEvThreshold: number): CroupierDecision {
  return {
    intent: null,
    quote: null,
    pullAllQuotes: false,
    adverseSelectionCost: 0,
    minEvThreshold: Number.isFinite(minEvThreshold) ? minEvThreshold : 0
  };
}

export function defaultExecutionProfile(
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number
): ExecutionProfile {
  return {
    status: "STABLE",
    jitterMs: 0,
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: null,
    maxProcessingLatencyMs: null,
    lastProcessingLatencyMs: null,
    wakeUpTimeMs: null,
    coldStartSuspected: false,
    orderBookUpdateMs: null,
    agentLogicMs: null,
    totalHotPathMs: null,
    lastComputedAt: null,
    updatedAt: null
  };
}

export function defaultAnomalyStatus() {
  return {
    status: "CLEAR" as const,
    priceZScore: null,
    volumeZScore: null,
    cancellationToExecutionRatio: 0,
    cancellationCount: 0,
    executionCount: 0,
    lastAnomaly: null,
    updatedAt: null
  };
}

export function normalizeExecutionProfile(
  profile: ExecutionProfile | undefined,
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number,
  observedAt: string
): ExecutionProfile {
  const fallback = defaultExecutionProfile(
    jitterThresholdMs,
    sampleWindow,
    computeIntervalTicks,
    sampleCount
  );

  if (!profile) {
    return {
      ...fallback,
      updatedAt: observedAt
    };
  }

  return {
    ...fallback,
    ...profile,
    status: profile.status === "UNSTABLE" ? "UNSTABLE" : "STABLE",
    jitterMs: finiteMetric(profile.jitterMs, 0),
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: nullableFiniteMetric(profile.averageProcessingLatencyMs),
    maxProcessingLatencyMs: nullableFiniteMetric(profile.maxProcessingLatencyMs),
    lastProcessingLatencyMs: nullableFiniteMetric(profile.lastProcessingLatencyMs),
    wakeUpTimeMs: nullableFiniteMetric(profile.wakeUpTimeMs),
    coldStartSuspected: profile.coldStartSuspected,
    orderBookUpdateMs: nullableFiniteMetric(profile.orderBookUpdateMs),
    agentLogicMs: nullableFiniteMetric(profile.agentLogicMs),
    totalHotPathMs: nullableFiniteMetric(profile.totalHotPathMs),
    lastComputedAt: typeof profile.lastComputedAt === "string" ? profile.lastComputedAt : null,
    updatedAt: observedAt
  };
}

export function defaultMicrostructure(): MicrostructureMetrics {
  return {
    marketKey: null,
    instrumentCode: null,
    exchangeCode: null,
    source_exchange: null,
    sourceWeight: DEFAULT_SOURCE_WEIGHT,
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    bidVolume: 0,
    askVolume: 0,
    weightedImbalance: null,
    depthLevels: 0,
    lastSequence: null,
    timeToBookMs: null,
    isSynced: false,
    updatedAt: null
  };
}

export function defaultPriceDiscovery(): PriceDiscoveryMetrics {
  return {
    instrumentCode: null,
    weightedMidPrice: null,
    primaryExchange: null,
    primaryWeight: 0,
    sourceCount: 0,
    sources: [],
    updatedAt: null
  };
}

export function defaultLeadLagMetrics(): EngineState["leadLag"] {
  return {
    schemaVersion: "lead-lag.v1",
    leadInstrument: null,
    lagInstrument: null,
    correlation: null,
    lagMs: null,
    leadLagDelta: null,
    expectedValue: null,
    executable: false,
    sampleCount: 0,
    updatedAt: null
  };
}

export function defaultInventoryState(
  maxInventoryUnits: number,
  maxInventoryDelta = DEFAULT_MAX_INVENTORY_DELTA
): EngineState["inventory"] {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "BTC",
    normalization: {},
    maxInventoryUnits,
    maxInventoryDelta,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: null
  };
}

export function normalizeInventoryState(
  value: EngineState["inventory"] | undefined,
  maxInventoryUnits: number,
  maxInventoryDelta: number
): EngineState["inventory"] {
  const base = defaultInventoryState(maxInventoryUnits, maxInventoryDelta);

  if (!value) {
    return base;
  }

  return {
    ...base,
    ...value,
    current_inventory_delta:
      finiteNumber(value.current_inventory_delta) ?? finiteNumber(value.netDelta) ?? 0,
    baseAsset:
      typeof value.baseAsset === "string" && value.baseAsset.trim() !== ""
        ? value.baseAsset
        : "BTC",
    normalization:
      value.normalization && typeof value.normalization === "object" ? value.normalization : {},
    maxInventoryUnits,
    maxInventoryDelta
  };
}

export function defaultRiskMetrics(equity: number, observedAt: string): EngineState["riskMetrics"] {
  return {
    highWaterMark: Math.max(0, equity),
    rollingDrawdownPct: 0,
    var99OneHour: 0,
    isTradingEnabled: false,
    updatedAt: observedAt
  };
}

export function defaultShadowQueueState(observedAt: string | null): ShadowQueueState {
  return {
    schemaVersion: "shadow-queue.v1",
    capacity: DEFAULT_SHADOW_VLO_CAPACITY,
    activeOrders: 0,
    pendingDrifts: 0,
    ghostFills: 0,
    greenLights: 0,
    redLights: 0,
    noEdgeSignals: 0,
    invertedSignals: 0,
    confirmedSignals: 0,
    driftTradeDelay: DEFAULT_SHADOW_VLO_DRIFT_TRADES,
    latencyBudgetMs: DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
    baseSpreadBps: DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
    queueDepthMultiplier: DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
    lastFill: null,
    lastDecision: null,
    updatedAt: observedAt
  };
}

export function defaultCitadelState(observedAt: string): EngineState["citadel"] {
  return {
    status: "NOMINAL",
    reason: null,
    shadowMode: false,
    lastEvacuationAt: null,
    updatedAt: observedAt
  };
}

export function maintenanceRecoveryInstruments(payload: {
  resetInstruments?: string[] | string;
  instrumentCode?: string;
}): string[] {
  const values = [
    ...(Array.isArray(payload.resetInstruments)
      ? payload.resetInstruments
      : typeof payload.resetInstruments === "string"
        ? payload.resetInstruments.split(",")
        : []),
    ...(typeof payload.instrumentCode === "string" ? [payload.instrumentCode] : [])
  ];
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.includes("-") ? value : `${value}-usd`));

  return [...new Set(normalized)];
}

export function defaultInventoryGuardState(): EngineState["inventoryGuard"] {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    maxInventoryDelta: DEFAULT_MAX_INVENTORY_DELTA,
    hardCapReached: false,
    quoteHaltRequired: false,
    skewRatio: 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: null
  };
}

export function passiveInventoryGuardStateFromInventory(
  inventory: InventoryState,
  observedAt: string
): EngineState["inventoryGuard"] {
  const hardCapBreached =
    inventory.maxInventoryDelta > 0 &&
    Math.abs(inventory.current_inventory_delta) >= inventory.maxInventoryDelta;

  return {
    netDelta: inventory.netDelta,
    current_inventory_delta: inventory.current_inventory_delta,
    maxInventoryDelta: inventory.maxInventoryDelta,
    hardCapReached: hardCapBreached,
    quoteHaltRequired: hardCapBreached,
    skewRatio:
      inventory.maxInventoryDelta > 0
        ? roundMetric(inventory.current_inventory_delta / inventory.maxInventoryDelta, 8)
        : 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: observedAt
  };
}

export function defaultJanitorState(): EngineState["janitor"] {
  return {
    lastRunAt: null,
    zombieOrders: [],
    orphanExchangeOrders: [],
    reconciledOrders: [],
    cancelledOrders: [],
    dustPositions: [],
    dustCloseIntents: [],
    prunedTelemetryCount: 0,
    updatedAt: null
  };
}

export function defaultSlippageAnalytics(): EngineState["slippage"] {
  return {
    schemaVersion: "slippage.v1",
    points: [],
    averageSlippageBps: 0,
    latencyCorrelation: null,
    executionCostBufferBps: 0,
    updatedAt: null
  };
}

export function defaultRiskLimits(): RiskLimits {
  return {
    configVersion: "bootstrap",
    killSwitch: true,
    maxGrossExposure: 0,
    maxNetExposure: 0,
    maxOrderNotional: 0,
    maxDrawdownPct: 0,
    perAssetMaxPosition: {},
    updatedAt: new Date().toISOString()
  };
}

export function mergeRiskLimits(
  current?: RiskLimits,
  update?: Partial<RiskLimits> | null
): RiskLimits {
  return {
    ...(current ?? defaultRiskLimits()),
    ...(update ?? {}),
    perAssetMaxPosition: {
      ...(current?.perAssetMaxPosition ?? {}),
      ...(update?.perAssetMaxPosition ?? {})
    }
  };
}

export function resolveMaxLatencyMs(
  config: AdminConfigUpdate | null | undefined,
  fallback: number | undefined
): number {
  const candidate =
    config?.performance?.maxLatencyMs ??
    config?.maxLatencyMs ??
    config?.MAX_LATENCY ??
    fallback ??
    DEFAULT_MAX_LATENCY_MS;

  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_MAX_LATENCY_MS;
}

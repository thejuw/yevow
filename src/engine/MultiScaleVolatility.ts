export interface MultiScaleVolatilitySnapshot {
  instrumentCode: string;
  midPrice: number;
  ret: number;
  oneMinuteVol: number;
  fiveMinuteVol: number;
  thirtyMinuteVol: number;
  maxVol: number;
  jumpDetected: boolean;
  jumpZScore: number;
  observedAt: string;
}

interface WelfordState {
  count: number;
  mean: number;
  m2: number;
}

interface InstrumentVolState {
  lastPrice: number | null;
  oneMinuteVariance: number;
  fiveMinuteVariance: number;
  thirtyMinuteVariance: number;
  returns: WelfordState;
  snapshot: MultiScaleVolatilitySnapshot | null;
}

const DEFAULT_STATE: InstrumentVolState = {
  lastPrice: null,
  oneMinuteVariance: 0,
  fiveMinuteVariance: 0,
  thirtyMinuteVariance: 0,
  returns: { count: 0, mean: 0, m2: 0 },
  snapshot: null
};

export class MultiScaleVolatilityModel {
  private readonly states = new Map<string, InstrumentVolState>();

  update(
    instrumentCode: string,
    midPrice: number | null,
    observedAt: string
  ): MultiScaleVolatilitySnapshot | null {
    if (!midPrice || midPrice <= 0 || !Number.isFinite(midPrice)) {
      return this.states.get(instrumentCode)?.snapshot ?? null;
    }

    const state = this.stateFor(instrumentCode);
    const previousPrice = state.lastPrice;
    state.lastPrice = midPrice;

    if (!previousPrice || previousPrice <= 0) {
      state.snapshot = {
        instrumentCode,
        midPrice,
        ret: 0,
        oneMinuteVol: 0,
        fiveMinuteVol: 0,
        thirtyMinuteVol: 0,
        maxVol: 0,
        jumpDetected: false,
        jumpZScore: 0,
        observedAt
      };
      return state.snapshot;
    }

    const ret = Math.log(midPrice / previousPrice);
    const previousVariance =
      state.returns.count > 1 ? state.returns.m2 / (state.returns.count - 1) : 0;
    const previousSigma = Math.sqrt(Math.max(previousVariance, 0));
    const jumpZScore = previousSigma > 0 ? Math.abs(ret - state.returns.mean) / previousSigma : 0;
    state.oneMinuteVariance = ewmaVariance(state.oneMinuteVariance, ret, 0.18);
    state.fiveMinuteVariance = ewmaVariance(state.fiveMinuteVariance, ret, 0.06);
    state.thirtyMinuteVariance = ewmaVariance(state.thirtyMinuteVariance, ret, 0.015);
    updateWelford(state.returns, ret);

    state.snapshot = {
      instrumentCode,
      midPrice,
      ret,
      oneMinuteVol: Math.sqrt(Math.max(0, state.oneMinuteVariance)),
      fiveMinuteVol: Math.sqrt(Math.max(0, state.fiveMinuteVariance)),
      thirtyMinuteVol: Math.sqrt(Math.max(0, state.thirtyMinuteVariance)),
      maxVol: Math.max(
        Math.sqrt(Math.max(0, state.oneMinuteVariance)),
        Math.sqrt(Math.max(0, state.fiveMinuteVariance)),
        Math.sqrt(Math.max(0, state.thirtyMinuteVariance))
      ),
      jumpDetected: jumpZScore >= 6,
      jumpZScore,
      observedAt
    };

    return state.snapshot;
  }

  snapshot(instrumentCode: string): MultiScaleVolatilitySnapshot | null {
    return this.states.get(instrumentCode)?.snapshot ?? null;
  }

  private stateFor(instrumentCode: string): InstrumentVolState {
    const existing = this.states.get(instrumentCode);
    if (existing) {
      return existing;
    }

    const next: InstrumentVolState = {
      ...DEFAULT_STATE,
      returns: { count: 0, mean: 0, m2: 0 }
    };
    this.states.set(instrumentCode, next);
    return next;
  }
}

function ewmaVariance(previous: number, ret: number, alpha: number): number {
  return alpha * ret * ret + (1 - alpha) * previous;
}

function updateWelford(state: WelfordState, value: number): void {
  state.count += 1;
  const delta = value - state.mean;
  state.mean += delta / state.count;
  state.m2 += delta * (value - state.mean);
}

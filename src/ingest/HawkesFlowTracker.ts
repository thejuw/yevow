export const DEFAULT_HAWKES_BASELINE_MU = 0.1;
export const DEFAULT_HAWKES_JUMP_BETA = 0.9;
export const DEFAULT_HAWKES_DECAY_ALPHA = 2.2;
export const DEFAULT_HAWKES_THRESHOLD_QUANTILE = 0.95;
export const DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS = 60_000;

const HAWKES_WINDOW_SECONDS = 3_600;

export type HawkesFlowSide = "BUY" | "SELL" | "UNKNOWN";

export interface HawkesFlowObservation {
  triggered: boolean;
  instrumentCode: string;
  side: HawkesFlowSide;
  pullSide: "BID" | "ASK" | "BOTH";
  size: number;
  intensity: number;
  threshold: number;
  confidence: number;
  baselineMu: number;
  jumpBeta: number;
  decayAlpha: number;
  observedAtMs: number;
  receivedAt: string;
  cooldownMs: number;
}

export interface HawkesFlowTrackerConfig {
  baselineMu: number;
  jumpBeta: number;
  decayAlpha: number;
  thresholdQuantile: number;
  signalCooldownMs: number;
}

interface HawkesInstrumentState {
  excitation: number;
  lastEventMs: number | null;
  sampleValues: Float32Array;
  sampleTimes: Float64Array;
  scratch: Float32Array;
  sampleIndex: number;
  sampleCount: number;
  lastSampleSecond: number;
  lastThreshold: number;
  lastSignalMs: number;
}

export class HawkesFlowTracker {
  private readonly states = new Map<string, HawkesInstrumentState>();
  private readonly baselineMu: number;
  private readonly jumpBeta: number;
  private readonly decayAlpha: number;
  private readonly thresholdQuantile: number;
  private readonly signalCooldownMs: number;

  constructor(config: HawkesFlowTrackerConfig) {
    this.baselineMu = positiveConfigNumber(config.baselineMu, DEFAULT_HAWKES_BASELINE_MU);
    this.jumpBeta = positiveConfigNumber(config.jumpBeta, DEFAULT_HAWKES_JUMP_BETA);
    this.decayAlpha = positiveConfigNumber(config.decayAlpha, DEFAULT_HAWKES_DECAY_ALPHA);
    this.thresholdQuantile = clampNumber(
      config.thresholdQuantile,
      0.5,
      0.999,
      DEFAULT_HAWKES_THRESHOLD_QUANTILE
    );
    this.signalCooldownMs = positiveConfigNumber(
      config.signalCooldownMs,
      DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS
    );
  }

  observe(input: {
    instrumentCode: string;
    side: HawkesFlowSide;
    size: number;
    observedAtMs: number;
    receivedAt: string;
  }): HawkesFlowObservation {
    const observedAtMs = Number.isFinite(input.observedAtMs)
      ? input.observedAtMs
      : Date.parse(input.receivedAt);
    const state = this.stateFor(input.instrumentCode);
    const dtSeconds =
      state.lastEventMs === null ? 0 : Math.max(0, (observedAtMs - state.lastEventMs) / 1_000);
    const decay = Math.exp(-this.decayAlpha * dtSeconds);
    const sizeScale = Math.max(1, Math.log1p(Math.max(0, input.size)));

    state.excitation = state.excitation * decay + this.jumpBeta * sizeScale;
    state.lastEventMs = observedAtMs;
    const intensity = this.baselineMu + state.excitation;
    const second = Math.floor(observedAtMs / 1_000);

    if (second !== state.lastSampleSecond) {
      this.recordSample(state, intensity, observedAtMs);
      state.lastSampleSecond = second;
      state.lastThreshold = this.quantile(state);
    }

    const threshold = Math.max(state.lastThreshold, this.baselineMu + this.jumpBeta);
    const cooldownOpen = observedAtMs - state.lastSignalMs >= this.signalCooldownMs;
    const triggered =
      state.sampleCount >= 30 && cooldownOpen && input.side !== "UNKNOWN" && intensity > threshold;

    if (triggered) {
      state.lastSignalMs = observedAtMs;
    }

    return {
      triggered,
      instrumentCode: input.instrumentCode,
      side: input.side,
      pullSide: input.side === "BUY" ? "ASK" : input.side === "SELL" ? "BID" : "BOTH",
      size: input.size,
      intensity,
      threshold,
      confidence: clampNumber(intensity / Math.max(threshold, 1e-9) - 1, 0, 1, 0),
      baselineMu: this.baselineMu,
      jumpBeta: this.jumpBeta,
      decayAlpha: this.decayAlpha,
      observedAtMs,
      receivedAt: input.receivedAt,
      cooldownMs: this.signalCooldownMs
    };
  }

  private stateFor(instrumentCode: string): HawkesInstrumentState {
    const existing = this.states.get(instrumentCode);
    if (existing) {
      return existing;
    }

    const created: HawkesInstrumentState = {
      excitation: 0,
      lastEventMs: null,
      sampleValues: new Float32Array(HAWKES_WINDOW_SECONDS),
      sampleTimes: new Float64Array(HAWKES_WINDOW_SECONDS),
      scratch: new Float32Array(HAWKES_WINDOW_SECONDS),
      sampleIndex: 0,
      sampleCount: 0,
      lastSampleSecond: -1,
      lastThreshold: 0,
      lastSignalMs: 0
    };
    this.states.set(instrumentCode, created);
    return created;
  }

  private recordSample(
    state: HawkesInstrumentState,
    intensity: number,
    observedAtMs: number
  ): void {
    state.sampleValues[state.sampleIndex] = intensity;
    state.sampleTimes[state.sampleIndex] = observedAtMs;
    state.sampleIndex = (state.sampleIndex + 1) % HAWKES_WINDOW_SECONDS;
    state.sampleCount = Math.min(HAWKES_WINDOW_SECONDS, state.sampleCount + 1);
  }

  private quantile(state: HawkesInstrumentState): number {
    const cutoffMs = (state.lastEventMs ?? Date.now()) - 3_600_000;
    let count = 0;

    for (let index = 0; index < state.sampleCount; index += 1) {
      if (state.sampleTimes[index] >= cutoffMs) {
        state.scratch[count] = state.sampleValues[index];
        count += 1;
      }
    }

    if (count === 0) {
      return this.baselineMu + this.jumpBeta;
    }

    const targetIndex = Math.min(count - 1, Math.floor((count - 1) * this.thresholdQuantile));
    return quickSelect(state.scratch, 0, count - 1, targetIndex);
  }
}

export function clampNumber(value: number, min: number, max: number, fallback = min): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function positiveConfigNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function quickSelect(values: Float32Array, left: number, right: number, target: number): number {
  let low = left;
  let high = right;

  while (low < high) {
    const pivotIndex = partition(values, low, high, Math.floor((low + high) / 2));
    if (target === pivotIndex) {
      return values[target];
    }
    if (target < pivotIndex) {
      high = pivotIndex - 1;
    } else {
      low = pivotIndex + 1;
    }
  }

  return values[target];
}

function partition(values: Float32Array, left: number, right: number, pivotIndex: number): number {
  const pivotValue = values[pivotIndex];
  swapFloat32(values, pivotIndex, right);
  let storeIndex = left;

  for (let index = left; index < right; index += 1) {
    if (values[index] < pivotValue) {
      swapFloat32(values, storeIndex, index);
      storeIndex += 1;
    }
  }

  swapFloat32(values, right, storeIndex);
  return storeIndex;
}

function swapFloat32(values: Float32Array, left: number, right: number): void {
  const temp = values[left];
  values[left] = values[right];
  values[right] = temp;
}

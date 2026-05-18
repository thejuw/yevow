import type { JsonRecord, JsonValue } from "../../types";
import type {
  Candle,
  CascadeRecoveryDirection,
  CascadeRecoverySignal,
  CascadeRecoverySignalConfig,
  CascadeRecoverySignalInput,
  CascadeRecoverySignalResult,
  CascadeRecoveryTriggerType
} from "./types";

const BPS = 10_000;

export const defaultCascadeRecoverySignalConfig: CascadeRecoverySignalConfig = {
  entryWindowSeconds: 5 * 60,
  impulsiveBarBodyAtr: 1.5,
  impulsiveBarVolumeMult: 1.5,
  stopBufferAtr: 0.25,
  minStopDistanceBps: 40,
  maxStopDistanceBps: 400,
  minTimeSinceLastCascadeSeconds: 30 * 60,
  newsBlackoutMinutes: 60,
  maxRealizedVolPercentile: 0.95,
  timeStopHours: 24,
  partial1R: 2,
  partial1SizePct: 30,
  partial2R: 3,
  partial2SizePct: 30,
  runnerTrailingType: "ATR",
  runnerTrailingParam: 2
};

interface TriggerEvaluation {
  triggerType: CascadeRecoveryTriggerType;
  passed: boolean;
  reason: string;
  level: number | null;
}

export class CascadeRecoverySignalEngine {
  constructor(
    private readonly config: CascadeRecoverySignalConfig = defaultCascadeRecoverySignalConfig
  ) {}

  evaluate(input: CascadeRecoverySignalInput): CascadeRecoverySignalResult {
    const emittedAt = normalizeIso(input.observedAt) ?? new Date().toISOString();
    const direction = recoveryDirection(input.cascade.direction);
    const triggers = this.evaluateTriggers(input, direction);
    const selectedTrigger = triggers.find((trigger) => trigger.passed) ?? null;
    const gates = this.evaluateGates(input, direction, emittedAt, selectedTrigger);
    const stop = this.calculateStop(input, direction);
    const stopGate = this.evaluateStopGate(stop, input.reclaimCandle.close);
    const context = buildContext(input, direction, triggers, gates, stop, stopGate, this.config);
    const reasons = [
      ...Object.entries(gates)
        .filter(([, gate]) => !gatePassed(gate))
        .map(([name]) => name),
      ...(stopGate.passed ? [] : [String(stopGate.reason)])
    ];

    if (!selectedTrigger) {
      reasons.unshift("NO_ENTRY_TRIGGER");
    }

    if (reasons.length > 0 || !selectedTrigger || !stop) {
      return {
        accepted: false,
        rejection: {
          schemaVersion: "cascade.recovery-signal-rejection.v1",
          cascadeId: input.cascade.cascadeId,
          instrumentCode: input.cascade.instrumentCode,
          rejectedAt: emittedAt,
          reasons,
          context
        }
      };
    }

    const entryPrice = roundPrice(input.reclaimCandle.close);
    const rDistance = roundPrice(Math.abs(entryPrice - stop.stopPrice));
    const signal: CascadeRecoverySignal = {
      schemaVersion: "cascade.recovery-signal.v1",
      signalId: signalId(input.cascade.cascadeId, selectedTrigger.triggerType, emittedAt),
      cascadeId: input.cascade.cascadeId,
      instrumentCode: input.cascade.instrumentCode,
      direction,
      triggerType: selectedTrigger.triggerType,
      entryPrice,
      stopPrice: stop.stopPrice,
      rDistance,
      targets: {
        partial1: {
          price: targetPrice(direction, entryPrice, rDistance, this.config.partial1R),
          rMultiple: this.config.partial1R,
          sizePct: this.config.partial1SizePct
        },
        partial2: {
          price: targetPrice(direction, entryPrice, rDistance, this.config.partial2R),
          rMultiple: this.config.partial2R,
          sizePct: this.config.partial2SizePct
        },
        runner: {
          trailingType: this.config.runnerTrailingType,
          trailingParam: this.config.runnerTrailingParam,
          sizePct: Math.max(0, 100 - this.config.partial1SizePct - this.config.partial2SizePct)
        }
      },
      timeStopAt: new Date(
        Date.parse(emittedAt) + this.config.timeStopHours * 3_600_000
      ).toISOString(),
      confidence: confidence(triggers, input.absorption.criteria),
      context,
      emittedAt
    };

    return { accepted: true, signal };
  }

  private evaluateTriggers(
    input: CascadeRecoverySignalInput,
    direction: CascadeRecoveryDirection
  ): TriggerEvaluation[] {
    return [
      structuralReclaim(input, direction),
      vwapReclaim(input, direction),
      impulsiveBar(input, direction, this.config)
    ];
  }

  private evaluateGates(
    input: CascadeRecoverySignalInput,
    direction: CascadeRecoveryDirection,
    emittedAt: string,
    selectedTrigger: TriggerEvaluation | null
  ): Record<string, JsonRecord> {
    const secondsSinceAbsorption =
      (Date.parse(emittedAt) - Date.parse(input.absorption.confirmedAt)) / 1_000;
    const secondsSinceSecondCascade =
      input.recentSecondCascadeAt === null
        ? null
        : (Date.parse(emittedAt) - Date.parse(input.recentSecondCascadeAt)) / 1_000;
    const cvdAligned = direction === "LONG" ? input.cvd1m > 0 : input.cvd1m < 0;

    return {
      entryWindow: gate(
        Number.isFinite(secondsSinceAbsorption) &&
          secondsSinceAbsorption >= 0 &&
          secondsSinceAbsorption <= this.config.entryWindowSeconds,
        "ENTRY_WINDOW_SECONDS",
        secondsSinceAbsorption,
        this.config.entryWindowSeconds
      ),
      triggerPresent: gate(
        selectedTrigger !== null,
        "TRIGGER_PRESENT",
        selectedTrigger?.triggerType ?? null
      ),
      oracleRegime: gate(
        input.oracleRegime !== "REGIME_CRISIS",
        "ORACLE_NOT_CRISIS",
        input.oracleRegime
      ),
      cvdAlignment: gate(cvdAligned, "CVD_ALIGNED", input.cvd1m),
      openInterest: gate(
        input.openInterestDelta !== null && input.openInterestDelta >= 0,
        "OI_NOT_DECLINING",
        input.openInterestDelta
      ),
      secondCascade: gate(
        secondsSinceSecondCascade === null ||
          secondsSinceSecondCascade >= this.config.minTimeSinceLastCascadeSeconds,
        "MIN_TIME_SINCE_LAST_CASCADE_SECONDS",
        secondsSinceSecondCascade,
        this.config.minTimeSinceLastCascadeSeconds
      ),
      newsBlackout: gate(
        !input.majorNewsWithinBlackout,
        "NEWS_BLACKOUT_MINUTES",
        input.majorNewsWithinBlackout,
        this.config.newsBlackoutMinutes
      ),
      realizedVolatility: gate(
        input.realizedVolPercentile1h !== null &&
          input.realizedVolPercentile1h <= this.config.maxRealizedVolPercentile,
        "MAX_REALIZED_VOL_PERCENTILE",
        input.realizedVolPercentile1h,
        this.config.maxRealizedVolPercentile
      ),
      dailyLossLimit: gate(
        !input.dailyLossLimitBreached,
        "DAILY_LOSS_LIMIT",
        input.dailyLossLimitBreached
      ),
      weeklyLossLimit: gate(
        !input.weeklyLossLimitBreached,
        "WEEKLY_LOSS_LIMIT",
        input.weeklyLossLimitBreached
      )
    };
  }

  private calculateStop(
    input: CascadeRecoverySignalInput,
    direction: CascadeRecoveryDirection
  ): { stopPrice: number; distanceBps: number } | null {
    const atr1h = input.atr1h;
    const entryPrice = input.reclaimCandle.close;

    if (atr1h === null || !Number.isFinite(atr1h) || atr1h <= 0 || entryPrice <= 0) {
      return null;
    }

    const stopPrice =
      direction === "LONG"
        ? input.cascade.priceAtPeak - this.config.stopBufferAtr * atr1h
        : input.cascade.priceAtPeak + this.config.stopBufferAtr * atr1h;
    const rDistance = direction === "LONG" ? entryPrice - stopPrice : stopPrice - entryPrice;

    if (!Number.isFinite(rDistance) || rDistance <= 0) {
      return null;
    }

    return {
      stopPrice: roundPrice(stopPrice),
      distanceBps: (rDistance / entryPrice) * BPS
    };
  }

  private evaluateStopGate(
    stop: { stopPrice: number; distanceBps: number } | null,
    entryPrice: number
  ): JsonRecord {
    if (!stop || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return gate(false, "STOP_UNAVAILABLE", null);
    }

    return gate(
      stop.distanceBps >= this.config.minStopDistanceBps &&
        stop.distanceBps <= this.config.maxStopDistanceBps,
      "STOP_DISTANCE_BPS",
      roundMetric(stop.distanceBps, 4),
      `${this.config.minStopDistanceBps}-${this.config.maxStopDistanceBps}`
    );
  }
}

function structuralReclaim(
  input: CascadeRecoverySignalInput,
  direction: CascadeRecoveryDirection
): TriggerEvaluation {
  const level = direction === "LONG" ? input.preCascadeSwingLow : input.preCascadeSwingHigh;
  if (level === null || !Number.isFinite(level)) {
    return {
      triggerType: "STRUCTURAL_RECLAIM",
      passed: false,
      reason: "MISSING_SWING_LEVEL",
      level: null
    };
  }

  const previousClose = previousClosedCandle(input)?.close ?? null;
  const close = input.reclaimCandle.close;
  const passed =
    direction === "LONG"
      ? close > level && (previousClose === null || previousClose <= level)
      : close < level && (previousClose === null || previousClose >= level);

  return {
    triggerType: "STRUCTURAL_RECLAIM",
    passed,
    reason: passed ? "STRUCTURE_RECLAIMED" : "STRUCTURE_NOT_RECLAIMED",
    level
  };
}

function vwapReclaim(
  input: CascadeRecoverySignalInput,
  direction: CascadeRecoveryDirection
): TriggerEvaluation {
  const level = input.cascadeVwap;
  if (level === null || !Number.isFinite(level)) {
    return {
      triggerType: "VWAP_RECLAIM",
      passed: false,
      reason: "MISSING_CASCADE_VWAP",
      level: null
    };
  }

  const previousClose = previousClosedCandle(input)?.close ?? null;
  const close = input.reclaimCandle.close;
  const passed =
    direction === "LONG"
      ? close > level && (previousClose === null || previousClose <= level)
      : close < level && (previousClose === null || previousClose >= level);

  return {
    triggerType: "VWAP_RECLAIM",
    passed,
    reason: passed ? "VWAP_RECLAIMED" : "VWAP_NOT_RECLAIMED",
    level
  };
}

function impulsiveBar(
  input: CascadeRecoverySignalInput,
  direction: CascadeRecoveryDirection,
  config: CascadeRecoverySignalConfig
): TriggerEvaluation {
  const candle = input.reclaimCandle;
  const atr1m = input.atr1m;
  if (atr1m === null || !Number.isFinite(atr1m) || atr1m <= 0) {
    return {
      triggerType: "IMPULSIVE_BAR",
      passed: false,
      reason: "MISSING_ATR_1M",
      level: null
    };
  }

  const body = Math.abs(candle.close - candle.open);
  const range = Math.max(0, candle.high - candle.low);
  const closeLocation = range > 0 ? (candle.close - candle.low) / range : 0.5;
  const averageVolume = averagePriorVolume(input.recent1mCandles, candle);
  const directionalCloseOk = direction === "LONG" ? closeLocation >= 2 / 3 : closeLocation <= 1 / 3;
  const passed =
    body >= config.impulsiveBarBodyAtr * atr1m &&
    directionalCloseOk &&
    averageVolume > 0 &&
    candle.volume >= config.impulsiveBarVolumeMult * averageVolume;

  return {
    triggerType: "IMPULSIVE_BAR",
    passed,
    reason: passed ? "IMPULSIVE_BAR_CONFIRMED" : "IMPULSIVE_BAR_INSUFFICIENT",
    level: roundMetric(config.impulsiveBarBodyAtr * atr1m, 8)
  };
}

function previousClosedCandle(input: CascadeRecoverySignalInput): Candle | null {
  const candidates = input.recent1mCandles.filter(
    (candle) => candle.isClosed && candle.closedAt < input.reclaimCandle.closedAt
  );
  return candidates.at(-1) ?? null;
}

function averagePriorVolume(candles: Candle[], reclaimCandle: Candle): number {
  const prior = candles
    .filter((candle) => candle.isClosed && candle.closedAt < reclaimCandle.closedAt)
    .slice(-20);

  if (prior.length === 0) {
    return 0;
  }

  let total = 0;
  for (const candle of prior) {
    total += candle.volume;
  }

  return total / prior.length;
}

function recoveryDirection(direction: string): CascadeRecoveryDirection {
  return direction === "SHORT_LIQUIDATION" ? "SHORT" : "LONG";
}

function confidence(
  triggers: TriggerEvaluation[],
  criteria: {
    priceHeld: boolean;
    takerExhaustion: boolean;
    cvdReversal: boolean;
    openInterestStabilized: boolean;
  }
): number {
  const triggerScore = triggers.filter((trigger) => trigger.passed).length;
  const absorptionScore = [
    criteria.priceHeld,
    criteria.takerExhaustion,
    criteria.cvdReversal,
    criteria.openInterestStabilized
  ].filter(Boolean).length;

  return roundMetric(Math.max(0.5, (triggerScore + absorptionScore) / 7), 4);
}

function targetPrice(
  direction: CascadeRecoveryDirection,
  entryPrice: number,
  rDistance: number,
  multiple: number
): number {
  return roundPrice(
    direction === "LONG" ? entryPrice + rDistance * multiple : entryPrice - rDistance * multiple
  );
}

function buildContext(
  input: CascadeRecoverySignalInput,
  direction: CascadeRecoveryDirection,
  triggers: TriggerEvaluation[],
  gates: Record<string, JsonRecord>,
  stop: { stopPrice: number; distanceBps: number } | null,
  stopGate: JsonRecord,
  config: CascadeRecoverySignalConfig
): JsonRecord {
  return {
    direction,
    cascadeId: input.cascade.cascadeId,
    absorptionConfirmedAt: input.absorption.confirmedAt,
    reclaimCandle: candleContext(input.reclaimCandle),
    triggers: triggers.map((trigger) => ({
      triggerType: trigger.triggerType,
      passed: trigger.passed,
      reason: trigger.reason,
      level: trigger.level
    })),
    gates,
    stop: stop
      ? {
          stopPrice: stop.stopPrice,
          distanceBps: roundMetric(stop.distanceBps, 4),
          minStopDistanceBps: config.minStopDistanceBps,
          maxStopDistanceBps: config.maxStopDistanceBps
        }
      : null,
    stopGate,
    inputs: {
      atr1m: input.atr1m,
      atr1h: input.atr1h,
      cascadeVwap: input.cascadeVwap,
      preCascadeSwingLow: input.preCascadeSwingLow,
      preCascadeSwingHigh: input.preCascadeSwingHigh,
      cvd1m: input.cvd1m,
      openInterestDelta: input.openInterestDelta,
      oracleRegime: input.oracleRegime,
      realizedVolPercentile1h: input.realizedVolPercentile1h,
      majorNewsWithinBlackout: input.majorNewsWithinBlackout,
      dailyLossLimitBreached: input.dailyLossLimitBreached,
      weeklyLossLimitBreached: input.weeklyLossLimitBreached
    }
  };
}

function candleContext(candle: Candle): JsonRecord {
  return {
    instrumentCode: candle.instrumentCode,
    openedAt: candle.openedAt,
    closedAt: candle.closedAt,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    buyVolume: candle.buyVolume,
    sellVolume: candle.sellVolume
  };
}

function gate(
  passed: boolean,
  reason: string,
  value: JsonValue = null,
  threshold: JsonValue = null
): JsonRecord {
  return { passed, reason, value, threshold };
}

function gatePassed(gateRecord: JsonRecord): boolean {
  return gateRecord.passed === true;
}

function signalId(
  cascadeId: string,
  triggerType: CascadeRecoveryTriggerType,
  emittedAt: string
): string {
  return `signal:${hashString(`${cascadeId}:${triggerType}:${emittedAt}`)}`;
}

function normalizeIso(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function roundPrice(value: number): number {
  return roundMetric(value, 8);
}

function roundMetric(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

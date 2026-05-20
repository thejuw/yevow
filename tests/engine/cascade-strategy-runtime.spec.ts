import { describe, expect, it } from "vitest";
import {
  applyCascadeOpenPositionSideEffects,
  applyCascadePositionUpdateSideEffects,
  applyCascadeSignalRejectionSideEffects,
  applyCascadeSizeRejectionSideEffects,
  closedOneMinuteCandlesForTick,
  processCascadeClosedCandleSignals,
  processAcceptedCascadeSignalFlow,
  type CascadeAcceptedSignalFlowHandlers,
  type CascadeOpenPositionSideEffectHandlers,
  type CascadeSignalRejectionSideEffectHandlers,
  type CascadeSizeRejectionSideEffectHandlers,
  shouldEvaluateCascadeStrategy
} from "../../src/engine/trading/cascade/CascadeStrategyRuntime";
import type { CascadeAssetProfile } from "../../src/strategy/cascade/AssetProfiles";
import type {
  AbsorptionConfirmed,
  Candle,
  CascadeEvent,
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignal,
  CascadeRecoverySignalRejection,
  PositionSizeDecision
} from "../../src/strategy/cascade/types";
import type { TradeIntent } from "../../src/types";

describe("CascadeStrategyRuntime", () => {
  it("gates cascade evaluation by strategy mode", () => {
    expect(shouldEvaluateCascadeStrategy("OFF")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("MARKET_MAKING")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("CASCADE_RECOVERY")).toBe(true);
  });

  it("selects only closed one-minute candles for the active tick instrument", () => {
    const btc = candle({ instrumentCode: "BTC-USD", timeframe: "1m" });
    const btcFiveMinute = candle({ instrumentCode: "btc-usd", timeframe: "5m" });
    const hype = candle({ instrumentCode: "hype-usd", timeframe: "1m" });

    expect(
      closedOneMinuteCandlesForTick([btcFiveMinute, hype, btc], { instrumentCode: "btc-usd" })
    ).toEqual([btc]);
  });

  it("dispatches cascade position close updates and persists changed positions", () => {
    const close = positionIntent("close", "STOP_LOSS", 1);
    const zeroClose = positionIntent("zero", "STOP_LOSS", 0);
    const stopUpdate = positionIntent("stop-update", undefined, 1, "STOP_UPDATE");
    const calls: string[] = [];

    applyCascadePositionUpdateSideEffects(
      [
        {
          position: position(),
          intents: [stopUpdate, zeroClose, close]
        }
      ],
      "2026-05-18T20:01:00.000Z",
      {
        dispatchCloseIntent(intent) {
          calls.push(`dispatch:${intent.intentId}`);
        },
        emitOperationalAlert(alert) {
          calls.push(`alert:${alert.eventType}:${alert.dedupeKey}`);
        },
        persistPositions() {
          calls.push("persist");
        }
      }
    );

    expect(calls).toEqual(["dispatch:close", "alert:STOP_HIT:position-1", "persist"]);
  });

  it("emits cascade open-position side effects in order", async () => {
    const sideEffects = cascadeOpenPositionSideEffectSpy();

    applyCascadeOpenPositionSideEffects(
      {
        signal: recoverySignal("signal-1", "btc-usd"),
        intent: tradeIntent(),
        engineId: "engine-1",
        position: position(),
        assetProfile: assetProfile(),
        sizeDecision: positionSizeDecision(),
        currentHeat: 0.1,
        observedAt: "2026-05-18T20:01:00.000Z"
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "signal:signal-1:TAKEN",
      "trace:cascade-entry-signal-1",
      "dispatch:intent-1",
      "schedule",
      "persist",
      "schedule",
      "alert:POSITION_OPENED:position-1:position-1"
    ]);
    await Promise.all(sideEffects.scheduled);
  });

  it("emits cascade signal rejection side effects in order", () => {
    const sideEffects = cascadeSignalRejectionSideEffectSpy();

    applyCascadeSignalRejectionSideEffects(
      {
        rejection: rejection("cascade-rejected", "btc-usd"),
        engineId: "engine-1",
        observedAt: "2026-05-18T20:01:00.000Z",
        entryWindowMs: 60_000
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "log:CASCADE_SIGNAL_REJECTED:cascade-rejected",
      "signal:PIT_BOSS:HOLD:SKIPPED:60000:Cascade recovery skipped: TEST_REJECTION"
    ]);
  });

  it("emits cascade size rejection logs and heat alerts when applicable", () => {
    const riskSideEffects = cascadeSizeRejectionSideEffectSpy();
    applyCascadeSizeRejectionSideEffects(
      {
        signal: recoverySignal("signal-risk", "btc-usd"),
        sizeDecision: positionSizeDecision({ limitingFactor: "RISK", reason: "risk cap" }),
        currentHeat: 0.2,
        heatCapPct: 0.25
      },
      riskSideEffects.handlers
    );

    const heatSideEffects = cascadeSizeRejectionSideEffectSpy();
    applyCascadeSizeRejectionSideEffects(
      {
        signal: recoverySignal("signal-heat", "btc-usd"),
        sizeDecision: positionSizeDecision({ limitingFactor: "HEAT", reason: "heat cap" }),
        currentHeat: 0.24,
        heatCapPct: 0.25
      },
      heatSideEffects.handlers
    );

    expect(riskSideEffects.events).toEqual(["warn:CASCADE_SIZE_REJECTED:signal-risk:RISK"]);
    expect(heatSideEffects.events).toEqual([
      "warn:CASCADE_SIZE_REJECTED:signal-heat:HEAT",
      "alert:HEAT_CAP_EXCEEDED:signal-heat:signal-heat:0.24:0.25"
    ]);
  });

  it("processes accepted cascade signals through sizing, position open, and rejection branches", async () => {
    const accepted = cascadeAcceptedSignalFlowSpy();
    const acceptedResult = processAcceptedCascadeSignalFlow(
      {
        signal: recoverySignal("signal-accepted", "btc-usd"),
        observedAt: "2026-05-18T20:01:00.000Z",
        engineId: "engine-1",
        equity: 10_000,
        riskPerTradePct: 0.01,
        assetProfile: assetProfile(),
        currentHeat: 0.1,
        heatCapPct: 0.25
      },
      accepted.handlers
    );

    expect(acceptedResult.sizeDecision.approved).toBe(true);
    expect(acceptedResult.position?.positionId).toBe("position-1");
    expect(acceptedResult.intent?.intentId).toBe("intent-1");
    expect(accepted.events).toEqual([
      "alert:SIGNAL_EMITTED:signal-accepted",
      "register:signal-accepted:20",
      "build:intent:signal-accepted:20",
      "signal:signal-accepted:TAKEN",
      "trace:cascade-entry-signal-accepted",
      "dispatch:intent-1",
      "schedule",
      "persist",
      "schedule",
      "alert:POSITION_OPENED:position-1"
    ]);
    await Promise.all(accepted.scheduled);

    const rejected = cascadeAcceptedSignalFlowSpy();
    const rejectedResult = processAcceptedCascadeSignalFlow(
      {
        signal: recoverySignal("signal-rejected", "btc-usd"),
        observedAt: "2026-05-18T20:01:00.000Z",
        engineId: "engine-1",
        equity: 10_000,
        riskPerTradePct: 0.01,
        assetProfile: assetProfile(),
        currentHeat: 0.25,
        heatCapPct: 0.25
      },
      rejected.handlers
    );

    expect(rejectedResult.sizeDecision).toMatchObject({
      approved: false,
      limitingFactor: "HEAT"
    });
    expect(rejectedResult.position).toBeNull();
    expect(rejected.events).toEqual([
      "alert:SIGNAL_EMITTED:signal-rejected",
      "warn:CASCADE_SIZE_REJECTED:signal-rejected:HEAT",
      "alert:HEAT_CAP_EXCEEDED:signal-rejected"
    ]);
  });

  it("processes closed one-minute candles through cascade signal handlers", async () => {
    const acceptedSignal = recoverySignal("signal-accepted", "btc-usd");
    const rejected = rejection("cascade-rejected", "btc-usd");
    const calls: string[] = [];

    await processCascadeClosedCandleSignals(
      [
        candle({ instrumentCode: "btc-usd", close: 101 }),
        candle({ instrumentCode: "btc-usd", close: 99 }),
        candle({ instrumentCode: "eth-usd", close: 2_000 })
      ],
      { instrumentCode: "btc-usd" },
      "2026-05-18T20:01:00.000Z",
      {
        latestAbsorptionForInstrument(instrumentCode) {
          calls.push(`absorption:${instrumentCode}`);
          return absorption(instrumentCode);
        },
        cascadeForAbsorption(foundAbsorption) {
          calls.push(`cascade:${foundAbsorption.cascadeId}`);
          return cascade(foundAbsorption.cascadeId, foundAbsorption.instrumentCode);
        },
        evaluateSignal(_cascade, _absorption, reclaimCandle) {
          calls.push(`evaluate:${reclaimCandle.close}`);
          return reclaimCandle.close > 100
            ? { accepted: true, signal: acceptedSignal }
            : { accepted: false, rejection: rejected };
        },
        recordRejectedSignal(signalRejection, observedAt) {
          calls.push(`reject:${signalRejection.cascadeId}:${observedAt}`);
        },
        async processAcceptedSignal(signal, observedAt) {
          calls.push(`accept:${signal.signalId}:${observedAt}`);
        }
      }
    );

    expect(calls).toEqual([
      "absorption:btc-usd",
      "cascade:cascade-btc-usd",
      "evaluate:101",
      "accept:signal-accepted:2026-05-18T20:01:00.000Z",
      "absorption:btc-usd",
      "cascade:cascade-btc-usd",
      "evaluate:99",
      "reject:cascade-rejected:2026-05-18T20:01:00.000Z"
    ]);
  });
});

function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrumentCode: "btc-usd",
    timeframe: "1m",
    openedAt: "2026-05-18T20:00:00.000Z",
    closedAt: "2026-05-18T20:01:00.000Z",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    notionalVolume: 1_000,
    buyVolume: 6,
    sellVolume: 4,
    trades: 12,
    isClosed: true,
    ...overrides
  };
}

function position(overrides: Partial<CascadeOpenPosition> = {}): CascadeOpenPosition {
  return {
    positionId: "position-1",
    signalId: "signal-1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG",
    status: "OPEN",
    entryPrice: 100,
    currentStopPrice: 95,
    initialStopPrice: 95,
    totalSize: 1,
    remainingSize: 1,
    initialRiskPct: 0.01,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2, sizePct: 0.5 },
      partial2: { price: 115, rMultiple: 3, sizePct: 0.25 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.25 }
    },
    timeStopAt: "2026-05-18T21:00:00.000Z",
    firstTargetTaken: false,
    secondTargetTaken: false,
    enteredAt: "2026-05-18T20:00:00.000Z",
    updatedAt: "2026-05-18T20:00:00.000Z",
    ...overrides
  };
}

function positionIntent(
  intentId: string,
  closeReason: CascadePositionIntent["closeReason"],
  size: number,
  kind: CascadePositionIntent["kind"] = "CLOSE"
): CascadePositionIntent {
  return {
    intentId,
    positionId: "position-1",
    signalId: "signal-1",
    instrumentCode: "btc-usd",
    kind,
    closeReason,
    action: "SELL",
    orderType: "IOC",
    executionStyle: "TAKER_IOC",
    size,
    referencePrice: 99,
    createdAt: "2026-05-18T20:01:00.000Z"
  };
}

function tradeIntent(): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-1",
    instrumentCode: "btc-usd",
    marketKey: "BTC",
    source_exchange: "hyperliquid",
    direction: "LONG",
    executionStyle: "TAKER_IOC",
    action: "BUY",
    orderType: "IOC",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: 101,
    expectedPrice: 101,
    requestedSize: 1,
    approvedSize: 1,
    probabilityWin: 0.55,
    probabilityLoss: 0.45,
    profit: 10,
    loss: 5,
    executionCosts: 0.1,
    adverseSelectionCost: 0.2,
    expectedValue: 2,
    minEvThreshold: 0.1,
    maxSlippageBps: 8,
    confidence: 0.8,
    rationale: "test cascade entry",
    createdAt: "2026-05-18T20:01:00.000Z"
  };
}

function assetProfile(): CascadeAssetProfile {
  return {
    asset: "BTC",
    notionalThresholdUsd: 50_000_000,
    zScoreThreshold: 3,
    minPriceMoveAtr: 1.5,
    maxPositionNotionalPct: 0.25,
    assetLiquidityCapUsd: 25_000,
    maxSlippageBps: 8,
    rationale: "test profile"
  };
}

function positionSizeDecision(overrides: Partial<PositionSizeDecision> = {}): PositionSizeDecision {
  return {
    approved: true,
    units: 1,
    notionalUsd: 101,
    riskUsd: 5,
    riskPct: 0.01,
    heatAfterPct: 0.2,
    limitingFactor: "RISK",
    reason: "approved",
    bounds: {
      riskUnits: 1,
      notionalUnits: 2,
      liquidityUnits: 3,
      heatUnits: 4
    },
    ...overrides
  };
}

function cascadeOpenPositionSideEffectSpy(): {
  events: string[];
  scheduled: Promise<void>[];
  handlers: CascadeOpenPositionSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<void>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      recordUiSignal(signal, outcome) {
        events.push(`signal:${signal.signalId}:${outcome}`);
      },
      traceDecision(decision) {
        events.push(`trace:${decision.decisionId}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      dispatchExecution(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      },
      persistPositions() {
        events.push("persist");
        return Promise.resolve();
      },
      emitOperationalAlert(eventType, _title, _message, metadata, dedupeKey) {
        events.push(`alert:${eventType}:${dedupeKey}:${metadata.positionId}`);
      }
    }
  };
}

function cascadeSignalRejectionSideEffectSpy(): {
  events: string[];
  handlers: CascadeSignalRejectionSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      logInfo(event, _message, metadata) {
        events.push(`log:${event}:${metadata.cascadeId}`);
      },
      recordUiSignal(signal, outcome) {
        events.push(
          `signal:${signal.sourceAgent}:${signal.action}:${outcome}:${signal.horizonMs}:${signal.rationale}`
        );
      }
    }
  };
}

function cascadeSizeRejectionSideEffectSpy(): {
  events: string[];
  handlers: CascadeSizeRejectionSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      logWarn(event, _message, metadata) {
        events.push(`warn:${event}:${metadata.signalId}:${metadata.limitingFactor}`);
      },
      emitOperationalAlert(eventType, _title, _message, metadata, dedupeKey) {
        events.push(
          `alert:${eventType}:${dedupeKey}:${metadata.signalId}:${metadata.currentHeat}:${metadata.heatCapPct}`
        );
      }
    }
  };
}

function cascadeAcceptedSignalFlowSpy(): {
  events: string[];
  scheduled: Promise<void>[];
  handlers: CascadeAcceptedSignalFlowHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<void>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      emitOperationalAlert(eventType, _title, _message, _metadata, dedupeKey) {
        events.push(`alert:${eventType}:${dedupeKey}`);
      },
      registerPosition(signal, sizeDecision) {
        events.push(`register:${signal.signalId}:${sizeDecision.units}`);
        return position({ signalId: signal.signalId });
      },
      buildEntryIntent(signal, size) {
        events.push(`build:intent:${signal.signalId}:${size}`);
        return tradeIntent();
      },
      recordUiSignal(signal, outcome) {
        events.push(`signal:${signal.signalId}:${outcome}`);
      },
      traceDecision(decision) {
        events.push(`trace:${decision.decisionId}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      dispatchExecution(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      },
      persistPositions() {
        events.push("persist");
        return Promise.resolve();
      },
      logWarn(event, _message, metadata) {
        events.push(`warn:${event}:${metadata.signalId}:${metadata.limitingFactor}`);
      }
    }
  };
}

function absorption(instrumentCode: string): AbsorptionConfirmed {
  return {
    schemaVersion: "cascade.absorption-confirmed.v1",
    cascadeId: `cascade-${instrumentCode}`,
    instrumentCode,
    direction: "LONG_LIQUIDATION",
    confirmedAt: "2026-05-18T20:00:30.000Z",
    elapsedMs: 30_000,
    price: 100,
    criteria: {
      priceHeld: true,
      takerExhaustion: true,
      cvdReversal: true,
      openInterestStabilized: true
    },
    observations: 10
  };
}

function cascade(cascadeId: string, instrumentCode: string): CascadeEvent {
  return {
    schemaVersion: "cascade.event.v1",
    cascadeId,
    instrumentCode,
    direction: "LONG_LIQUIDATION",
    detectedAt: "2026-05-18T20:00:00.000Z",
    windowStartAt: "2026-05-18T19:55:00.000Z",
    windowEndAt: "2026-05-18T20:00:00.000Z",
    liquidationNotional: 50_000_000,
    liquidationCount: 5,
    zScore: 3.5,
    priceAtStart: 100,
    priceAtPeak: 95,
    priceMoveAtr: 2,
    directionalPct: 0.9,
    rawEvents: []
  };
}

function recoverySignal(signalId: string, instrumentCode: string): CascadeRecoverySignal {
  return {
    schemaVersion: "cascade.recovery-signal.v1",
    signalId,
    cascadeId: `cascade-${instrumentCode}`,
    instrumentCode,
    direction: "LONG",
    triggerType: "VWAP_RECLAIM",
    entryPrice: 101,
    stopPrice: 96,
    rDistance: 5,
    targets: {
      partial1: { price: 111, rMultiple: 2, sizePct: 0.5 },
      partial2: { price: 116, rMultiple: 3, sizePct: 0.25 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.25 }
    },
    timeStopAt: "2026-05-18T21:01:00.000Z",
    confidence: 0.8,
    context: {},
    emittedAt: "2026-05-18T20:01:00.000Z"
  };
}

function rejection(cascadeId: string, instrumentCode: string): CascadeRecoverySignalRejection {
  return {
    schemaVersion: "cascade.recovery-signal-rejection.v1",
    cascadeId,
    instrumentCode,
    rejectedAt: "2026-05-18T20:01:00.000Z",
    reasons: ["TEST_REJECTION"],
    context: {}
  };
}

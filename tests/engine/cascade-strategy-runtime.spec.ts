import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  applyCascadeOpenPositionSideEffects,
  applyCascadePositionUpdateSideEffects,
  applyCascadeSignalRejectionSideEffects,
  applyCascadeSizeRejectionSideEffects,
  closedOneMinuteCandlesForTick,
  dispatchTradingCascadePositionUpdates,
  evaluateCascadeStrategyFlow,
  evaluateTradingCascadeStrategy,
  evaluateTradingEngineCascadeRecoverySignal,
  evaluateTradingCascadeRecoverySignal,
  processCascadeClosedCandleSignals,
  processAcceptedCascadeSignalFlow,
  processTradingAcceptedCascadeSignal,
  type CascadeAcceptedSignalFlowHandlers,
  type CascadeOpenPositionSideEffectHandlers,
  type CascadeSignalRejectionSideEffectHandlers,
  type CascadeStrategyEvaluationHandlers,
  type CascadeSizeRejectionSideEffectHandlers,
  type TradingAcceptedCascadeSignalTarget,
  type TradingCascadeRecoverySignalTarget,
  type TradingCascadeStrategyTarget,
  type TradingCascadePositionUpdateTarget,
  shouldEvaluateCascadeStrategy
} from "../../src/engine/trading/cascade/CascadeStrategyRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
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
import type { MarketTick, TradeIntent } from "../../src/types";

describe("CascadeStrategyRuntime", () => {
  it("gates cascade evaluation by strategy mode", () => {
    expect(shouldEvaluateCascadeStrategy("OFF")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("MARKET_MAKING")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("CASCADE_RECOVERY")).toBe(true);
  });

  it("orchestrates cascade strategy evaluation order around gates", async () => {
    const disabled = cascadeStrategyEvaluationSpy();
    const disabledResult = await evaluateCascadeStrategyFlow(
      {
        strategyMode: "OFF",
        tick: marketTick(),
        observedAt: "2026-05-18T20:01:00.000Z"
      },
      disabled.handlers
    );

    expect(disabledResult).toEqual({
      evaluated: false,
      closedCandles: [],
      reason: "STRATEGY_DISABLED"
    });
    expect(disabled.events).toEqual([]);

    const instrumentDisabled = cascadeStrategyEvaluationSpy({ instrumentEnabled: false });
    const instrumentDisabledResult = await evaluateCascadeStrategyFlow(
      {
        strategyMode: "CASCADE_RECOVERY",
        tick: marketTick(),
        observedAt: "2026-05-18T20:01:00.000Z"
      },
      instrumentDisabled.handlers
    );

    expect(instrumentDisabledResult.reason).toBe("INSTRUMENT_DISABLED");
    expect(instrumentDisabled.events).toEqual([
      "ingest:btc-usd",
      "positions:btc-usd:2026-05-18T20:01:00.000Z",
      "enabled:btc-usd"
    ]);

    const evaluated = cascadeStrategyEvaluationSpy();
    const evaluatedResult = await evaluateCascadeStrategyFlow(
      {
        strategyMode: "CASCADE_RECOVERY",
        tick: marketTick(),
        observedAt: "2026-05-18T20:01:00.000Z"
      },
      evaluated.handlers
    );

    expect(evaluatedResult.reason).toBe("EVALUATED");
    expect(evaluated.events).toEqual([
      "ingest:btc-usd",
      "positions:btc-usd:2026-05-18T20:01:00.000Z",
      "enabled:btc-usd",
      "refresh-news",
      "absorption:btc-usd",
      "cascade:cascade-btc-usd",
      "evaluate:100.5",
      "accept:signal-flow:2026-05-18T20:01:00.000Z"
    ]);
  });

  it("evaluates cascade strategy through the trading engine target adapter", async () => {
    const calls: string[] = [];
    const scheduled: Promise<void>[] = [];
    const engineState = defaultEngineState("cascade-strategy-target");
    engineState.bankroll.equity = 10_000;
    engineState.microstructure.midPrice = 100;
    engineState.oracle.regime = "REGIME_RANGE";
    engineState.riskMetrics.isTradingEnabled = true;
    const target: TradingCascadeStrategyTarget = {
      cachedConfig: {
        ...defaultConfig,
        STRATEGY_MODE: "CASCADE_RECOVERY",
        CASCADE_INSTRUMENTS: "BTC",
        RISK_PER_TRADE_PCT: 0.01,
        HEAT_CAP_PCT: 0.5
      },
      engineState,
      cascadeAbsorptionsById: new Map(),
      cascadeEventsById: new Map(),
      env: {},
      candleAggregator: {
        ingestTick(tick) {
          calls.push(`ingest:${tick.instrumentCode}`);
          return [candle({ instrumentCode: tick.instrumentCode })];
        },
        snapshot(instrumentCode, timeframe, limit) {
          calls.push(`snapshot:${instrumentCode}:${timeframe}:${limit}`);
          return [candle({ instrumentCode })];
        }
      },
      cascadePositionManager: {
        onTick(input) {
          calls.push(`position:${input.instrumentCode}:${input.price}:${String(input.atr)}`);
          return [];
        },
        snapshot() {
          calls.push("positions:snapshot");
          return [];
        },
        registerFromSignal(signal) {
          calls.push(`register:${signal.signalId}`);
          return position({ signalId: signal.signalId });
        }
      },
      cascadeHeatManager: {
        currentHeat(positions) {
          calls.push(`heat:${positions.length}`);
          return 0;
        }
      },
      cascadeNewsCalendar: {
        async refresh() {
          calls.push("refresh-news");
        },
        isWithinBlackout(_observedAt, baseAsset) {
          calls.push(`blackout:${baseAsset}`);
          return { blocked: false };
        }
      },
      state: {
        waitUntil(work) {
          calls.push("schedule");
          scheduled.push(work);
        }
      },
      logger: {
        info(eventType, _message, metadata) {
          calls.push(`info:${eventType}:${metadata?.cascadeId as string}`);
        },
        traceDecision(decision) {
          calls.push(`trace:${decision.decisionId}`);
        },
        warn(eventType, _message, metadata) {
          calls.push(`warn:${eventType}:${metadata?.signalId as string}`);
        }
      },
      recordCascadeUiSignal(agentSignal, outcome) {
        calls.push(`signal:${agentSignal.signalId}:${outcome}`);
      },
      async dispatchExecution(intent) {
        calls.push(`dispatch:${intent.intentId}`);
      },
      async safeStoragePut(key, value, reason) {
        calls.push(`persist:${key}:${(value as unknown[]).length}:${reason}`);
      },
      emitCascadeOperationalAlert(eventType, _title, _message, _metadata, dedupeKey) {
        calls.push(`alert:${eventType}:${dedupeKey}`);
      }
    };

    const result = await evaluateTradingCascadeStrategy(
      marketTick(),
      "2026-05-18T20:01:00.000Z",
      target
    );

    expect(result.reason).toBe("EVALUATED");
    expect(calls).toEqual([
      "ingest:btc-usd",
      "snapshot:btc-usd:1m:32",
      "position:btc-usd:100:null",
      "refresh-news"
    ]);
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

  it("dispatches cascade position updates through the trading engine target adapter", async () => {
    const scheduled: Promise<void>[] = [];
    const calls: string[] = [];
    const close = positionIntent("close", "STOP_LOSS", 1);
    const target: TradingCascadePositionUpdateTarget = {
      cachedConfig: defaultConfig,
      engineState: defaultEngineState("cascade-position-update-target"),
      cascadePositionManager: {
        onTick(input) {
          calls.push(`tick:${input.instrumentCode}:${input.price}:${String(input.atr)}`);
          return [{ position: position(), intents: [close] }];
        },
        snapshot() {
          calls.push("snapshot");
          return [position()];
        }
      },
      candleAggregator: {
        snapshot(instrumentCode, timeframe, limit) {
          calls.push(`candles:${instrumentCode}:${timeframe}:${limit}`);
          return [candle({ instrumentCode })];
        }
      },
      state: {
        waitUntil(work) {
          calls.push("schedule");
          scheduled.push(work);
        }
      },
      async dispatchExecution(intent) {
        calls.push(`dispatch:${intent.intentId}`);
      },
      emitCascadeOperationalAlert(eventType, _title, _message, metadata, dedupeKey) {
        calls.push(`alert:${eventType}:${metadata.positionId as string}:${dedupeKey}`);
      },
      async safeStoragePut(key, value, reason) {
        calls.push(`persist:${key}:${(value as unknown[]).length}:${reason}`);
      }
    };

    await dispatchTradingCascadePositionUpdates(marketTick(), "2026-05-18T20:01:00.000Z", target);
    await Promise.all(scheduled);

    expect(calls).toEqual([
      "candles:btc-usd:1m:32",
      "tick:btc-usd:100:null",
      "dispatch:cascade-exit-close",
      "schedule",
      "alert:STOP_HIT:position-1:position-1",
      "snapshot",
      "persist:cascade:positions:1:CASCADE_POSITION_UPDATE",
      "schedule"
    ]);
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

  it("processes accepted cascade signals through the trading engine target adapter", async () => {
    const calls: string[] = [];
    const scheduled: Promise<void>[] = [];
    const engineState = defaultEngineState("accepted-cascade-target");
    engineState.bankroll.equity = 10_000;
    const target: TradingAcceptedCascadeSignalTarget = {
      cachedConfig: {
        ...defaultConfig,
        RISK_PER_TRADE_PCT: 0.01,
        HEAT_CAP_PCT: 0.5
      },
      engineState,
      cascadePositionManager: {
        snapshot() {
          calls.push("snapshot");
          return [position()];
        },
        registerFromSignal(signal, sizeDecision) {
          calls.push(`register:${signal.signalId}:${sizeDecision.units}`);
          return position({ signalId: signal.signalId });
        }
      },
      cascadeHeatManager: {
        currentHeat(positions) {
          calls.push(`heat:${positions.length}`);
          return 0.1;
        }
      },
      state: {
        waitUntil(work) {
          calls.push("schedule");
          scheduled.push(work);
        }
      },
      logger: {
        traceDecision(decision) {
          calls.push(`trace:${decision.decisionId}`);
        },
        warn(eventType, _message, metadata) {
          calls.push(`warn:${eventType}:${metadata?.signalId as string}`);
        }
      },
      recordCascadeUiSignal(agentSignal, outcome) {
        calls.push(`signal:${agentSignal.signalId}:${outcome}`);
      },
      async dispatchExecution(intent) {
        calls.push(`dispatch:${intent.intentId}`);
      },
      async safeStoragePut(key, value, reason) {
        calls.push(`persist:${key}:${(value as unknown[]).length}:${reason}`);
      },
      emitCascadeOperationalAlert(eventType, _title, _message, _metadata, dedupeKey) {
        calls.push(`alert:${eventType}:${dedupeKey}`);
      }
    };

    const result = await processTradingAcceptedCascadeSignal(
      recoverySignal("signal-target", "btc-usd"),
      "2026-05-18T20:01:00.000Z",
      target
    );
    await Promise.all(scheduled);

    expect(result.position?.signalId).toBe("signal-target");
    expect(result.intent?.intentId).toBe("cascade-entry-signal-target");
    expect(calls).toEqual([
      "snapshot",
      "heat:1",
      "alert:SIGNAL_EMITTED:signal-target",
      "register:signal-target:20",
      "signal:signal-target:TAKEN",
      "trace:cascade-entry-signal-target",
      "dispatch:cascade-entry-signal-target",
      "schedule",
      "snapshot",
      "persist:cascade:positions:1:CASCADE_POSITION_OPENED",
      "schedule",
      "alert:POSITION_OPENED:position-1"
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

  it("builds trading cascade recovery signal context from runtime collaborators", () => {
    const calls: string[] = [];
    const result = evaluateTradingCascadeRecoverySignal(
      {
        cascade: cascade("cascade-btc-usd", "btc-usd"),
        absorption: absorption("btc-usd"),
        reclaimCandle: candle({ close: 101 }),
        observedAt: "2026-05-18T20:01:00.000Z",
        config: defaultConfig,
        midPrice: 100,
        oracleRegime: "REGIME_RANGE",
        riskTradingEnabled: true,
        cascadeEventsById: new Map(),
        env: {}
      },
      {
        snapshotCandles: (instrumentCode, timeframe, limit) => {
          calls.push(`candles:${instrumentCode}:${timeframe}:${limit}`);
          return [candle({ close: 99 }), candle({ close: 100 }), candle({ close: 101 })];
        },
        isWithinBlackout: (_observedAt, baseAsset) => {
          calls.push(`blackout:${baseAsset}`);
          return { blocked: false };
        }
      }
    );

    expect(calls).toEqual(["candles:btc-usd:1m:64", "blackout:BTC"]);
    expect(result.accepted).toEqual(expect.any(Boolean));
  });

  it("builds trading cascade recovery signal context through the engine target adapter", () => {
    const calls: string[] = [];
    const engineState = defaultEngineState("cascade-recovery-target");
    engineState.microstructure.midPrice = 100;
    engineState.oracle.regime = "REGIME_RANGE";
    engineState.riskMetrics.isTradingEnabled = true;
    const target: TradingCascadeRecoverySignalTarget = {
      cachedConfig: defaultConfig,
      engineState,
      cascadeEventsById: new Map(),
      env: {},
      candleAggregator: {
        snapshot(instrumentCode, timeframe, limit) {
          calls.push(`candles:${instrumentCode}:${timeframe}:${limit}`);
          return [candle({ close: 99 }), candle({ close: 100 }), candle({ close: 101 })];
        }
      },
      cascadeNewsCalendar: {
        isWithinBlackout(_observedAt, baseAsset) {
          calls.push(`blackout:${baseAsset}`);
          return { blocked: false };
        }
      }
    };

    const result = evaluateTradingEngineCascadeRecoverySignal(
      cascade("cascade-btc-usd", "btc-usd"),
      absorption("btc-usd"),
      candle({ close: 101 }),
      "2026-05-18T20:01:00.000Z",
      target
    );

    expect(calls).toEqual(["candles:btc-usd:1m:64", "blackout:BTC"]);
    expect(result.accepted).toEqual(expect.any(Boolean));
  });
});

function marketTick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 1,
    exchangeTimestamp: "2026-05-18T20:01:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-18T20:01:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-18T20:01:00.010Z",
    sourceWeight: 1,
    ...overrides
  };
}

function cascadeStrategyEvaluationSpy(
  options: {
    instrumentEnabled?: boolean;
  } = {}
): {
  events: string[];
  handlers: CascadeStrategyEvaluationHandlers;
} {
  const events: string[] = [];
  const instrumentEnabled = options.instrumentEnabled ?? true;

  return {
    events,
    handlers: {
      ingestTick(tick) {
        events.push(`ingest:${tick.instrumentCode}`);
        return [candle({ instrumentCode: tick.instrumentCode })];
      },
      dispatchPositionUpdates(tick, observedAt) {
        events.push(`positions:${tick.instrumentCode}:${observedAt}`);
        return Promise.resolve();
      },
      isInstrumentEnabled(instrumentCode) {
        events.push(`enabled:${instrumentCode}`);
        return instrumentEnabled;
      },
      refreshNewsCalendar() {
        events.push("refresh-news");
        return Promise.resolve();
      },
      latestAbsorptionForInstrument(instrumentCode) {
        events.push(`absorption:${instrumentCode}`);
        return absorption(instrumentCode);
      },
      cascadeForAbsorption(foundAbsorption) {
        events.push(`cascade:${foundAbsorption.cascadeId}`);
        return cascade(foundAbsorption.cascadeId, foundAbsorption.instrumentCode);
      },
      evaluateSignal(_cascade, _absorption, reclaimCandle) {
        events.push(`evaluate:${reclaimCandle.close}`);
        return {
          accepted: true,
          signal: recoverySignal("signal-flow", reclaimCandle.instrumentCode)
        };
      },
      recordRejectedSignal(rejection, observedAt) {
        events.push(`reject:${rejection.cascadeId}:${observedAt}`);
      },
      processAcceptedSignal(signal, observedAt) {
        events.push(`accept:${signal.signalId}:${observedAt}`);
        return Promise.resolve();
      }
    }
  };
}

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

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
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
    createdAt: "2026-05-18T20:01:00.000Z",
    ...overrides
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

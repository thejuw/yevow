import { describe, expect, it } from "vitest";
import {
  buildShadowQueueDecisionTrace,
  buildShadowQueueGhostFillRecord,
  buildShadowQueueTradeIntent,
  buildShadowQueueTradeIntentFromDecision,
  enforceShadowQueueDecisionLatency,
  resolveShadowQueueNoEdgeLogInterval,
  resolveShadowQueueSizingConfig,
  shouldLogShadowQueueNoEdge,
  shouldProcessShadowQueueTick,
  shadowQueueKellySize,
  shadowQueuePostOnlyPrice
} from "../../src/engine/trading/shadow/ShadowQueueRuntime";
import { defaultConfig } from "../../src/ConfigManager";
import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  MarketTick,
  ShadowQueueFill,
  ShadowQueueDecision
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T09:00:00.000Z";

describe("ShadowQueueRuntime", () => {
  it("gates VLO processing to synced live books with a valid mid", () => {
    expect(shouldProcessShadowQueueTick({ book: book() })).toBe(true);
    expect(shouldProcessShadowQueueTick({ book: book(), shadowReplay: true })).toBe(false);
    expect(shouldProcessShadowQueueTick({ book: book({ isSynced: false }) })).toBe(false);
    expect(shouldProcessShadowQueueTick({ book: book({ midPrice: null }) })).toBe(false);
    expect(shouldProcessShadowQueueTick({ book: book({ midPrice: 0 }) })).toBe(false);
  });

  it("builds zero-size ghost fill telemetry when paper risk caps prevent execution", () => {
    const record = buildShadowQueueGhostFillRecord({
      fill: shadowFill(),
      tick: marketTick(),
      book: book(),
      observedAt: OBSERVED_AT,
      participationRate: 0.35,
      adverseBps: 1.5,
      makerFeeBps: 0,
      fillModelSource: "fallback",
      paperFillPrice: 99.5,
      paperSizeCap: 0,
      executablePaperSize: 0
    });

    expect(record.trade).toBeNull();
    expect(record.eventPayload).toMatchObject({
      fillId: "fill-1",
      instrumentCode: "btc-usd",
      side: "BUY",
      price: 99.5,
      virtualQueueSize: 2,
      paperExecutionSize: 0,
      reason: "PAPER_RISK_CAP_ZERO",
      participationRate: 0.35,
      adverseBps: 1.5,
      observedAt: OBSERVED_AT
    });
  });

  it("builds D1 ghost fill execution records with modeled fees and metadata", () => {
    const record = buildShadowQueueGhostFillRecord({
      fill: shadowFill(),
      tick: marketTick(),
      book: book(),
      observedAt: OBSERVED_AT,
      participationRate: 0.35,
      adverseBps: 1.5,
      makerFeeBps: 1,
      fillModelSource: "bootstrap",
      paperFillPrice: 99.5,
      paperSizeCap: 0.5,
      executablePaperSize: 0.5
    });

    expect(record.trade).toMatchObject({
      tradeId: "shadow-queue:fill-1:1779094800000",
      orderId: "fill-1",
      venue: "hyperliquid",
      asset: "btc-usd",
      side: "BUY",
      orderType: "LIMIT",
      price: 99.5,
      size: 0.5,
      slippageBps: 1.5,
      primaryDriver: "PROFILER",
      fees: 0.004975,
      status: "GHOST_FILL",
      exchangeTradeId: "fill-1",
      metadata: {
        schemaVersion: "shadow-queue.fill.v1",
        fillModelSource: "bootstrap",
        virtualQueueSize: 2,
        paperExecutionSize: 0.5,
        paperSizeCap: 0.5,
        participationRate: 0.35,
        adverseBps: 1.5,
        makerFeeBps: 1,
        sizeCapped: true,
        tapePrice: 100,
        tapeSize: 1,
        tapeSide: "buy",
        virtualOnly: true
      }
    });
    expect(record.eventPayload).toBe(record.trade);
  });

  it("throttles no-edge shadow queue logs per instrument", () => {
    const lastLoggedAtByInstrument = new Map<string, number>();

    expect(
      shouldLogShadowQueueNoEdge({
        lastLoggedAtByInstrument,
        instrumentCode: "btc-usd",
        nowMs: 1_000,
        intervalMs: 500
      })
    ).toBe(true);
    expect(
      shouldLogShadowQueueNoEdge({
        lastLoggedAtByInstrument,
        instrumentCode: "btc-usd",
        nowMs: 1_250,
        intervalMs: 500
      })
    ).toBe(false);
    expect(
      shouldLogShadowQueueNoEdge({
        lastLoggedAtByInstrument,
        instrumentCode: "eth-usd",
        nowMs: 1_250,
        intervalMs: 500
      })
    ).toBe(true);
    expect(
      shouldLogShadowQueueNoEdge({
        lastLoggedAtByInstrument,
        instrumentCode: "btc-usd",
        nowMs: 1_500,
        intervalMs: 500
      })
    ).toBe(true);
  });

  it("resolves no-edge log throttle intervals from bounded env input", () => {
    expect(resolveShadowQueueNoEdgeLogInterval("2500")).toBe(2_500);
    expect(resolveShadowQueueNoEdgeLogInterval("10")).toBe(1_000);
    expect(resolveShadowQueueNoEdgeLogInterval("600000")).toBe(300_000);
  });

  it("suppresses shadow queue decisions that breach the latency budget", () => {
    const withinBudget = decision({ decisionLatencyMs: 5, reason: "ok" });
    expect(enforceShadowQueueDecisionLatency(withinBudget, 5)).toEqual({
      breached: false,
      decision: withinBudget
    });

    const breached = enforceShadowQueueDecisionLatency(
      decision({ decisionLatencyMs: 6, tradeIntentId: "intent-1", reason: "late" }),
      5
    );

    expect(breached.breached).toBe(true);
    expect(breached.decision).toMatchObject({
      tradeIntentId: null,
      reason: "late Suppressed because drift decision latency exceeded 5ms."
    });
  });

  it("builds shadow queue agent decision traces for audit linkage", () => {
    const intent = buildShadowQueueTradeIntent({
      decision: decision({ microDrift: 0.5, tickThreshold: 0.25 }),
      book: book(),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 99.5
    });
    const trace = buildShadowQueueDecisionTrace({
      decision: decision({
        action: "RED_LIGHT",
        dispatchSide: "SELL",
        tradeIntentId: intent?.intentId ?? null,
        microDrift: -0.5,
        tickThreshold: 0.25
      }),
      intent,
      engineId: "engine-1",
      quoteStateStatus: "ACTIVE",
      inventory: inventory({ netDelta: 0.4 }),
      cachedConfigVersion: "config-v1",
      observedAt: OBSERVED_AT
    });

    expect(trace).toMatchObject({
      decisionId: "decision-1",
      signalId: "fill-1",
      traceId: "engine-1:shadow-queue:fill-1",
      agentName: "PROFILER",
      targetAgent: "EXECUTIONER",
      action: "SUPERVISOR_ACTION",
      confidence: 1,
      expectedValue: intent?.expectedValue,
      maxSlippageBps: intent?.maxSlippageBps,
      featureVector: {
        schemaVersion: "shadow-queue.decision.v1",
        light: "RED_LIGHT",
        dispatchSide: "SELL",
        tradeIntentId: intent?.intentId
      },
      riskSnapshot: {
        quoteState: "ACTIVE",
        cachedConfigVersion: "config-v1"
      },
      rawSignal: {
        action: "RED_LIGHT",
        dispatchSide: "SELL"
      },
      latencyMs: 1,
      createdAt: OBSERVED_AT
    });
  });

  it("snaps post-only prices away from the touch", () => {
    const baseBook = book({ bestBid: 99.5, bestAsk: 100.5, tickSize: 0.5, spread: 1 });

    expect(shadowQueuePostOnlyPrice("BUY", baseBook, 100, 10)).toBe(99);
    expect(shadowQueuePostOnlyPrice("SELL", baseBook, 100, 10)).toBe(101);
    expect(shadowQueuePostOnlyPrice("BUY", book({ bestAsk: null, spread: null }), 100, 10)).toBe(
      99.5
    );
  });

  it("sizes VLO deployment by budget, queue depth, and inventory room", () => {
    const baseBook = book({
      bids: [{ price: 99, size: 10, updatedAt: OBSERVED_AT }],
      asks: [{ price: 101, size: 5, updatedAt: OBSERVED_AT }]
    });

    expect(
      shadowQueueKellySize({
        action: "BUY",
        price: 100,
        book: baseBook,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory({ netDelta: 0, maxInventoryUnits: 2 }),
        positionSizeMultiplier: 1
      })
    ).toBe(0.2);
    expect(
      shadowQueueKellySize({
        action: "SELL",
        price: 100,
        book: baseBook,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory({ netDelta: -2, maxInventoryUnits: 2 }),
        positionSizeMultiplier: 1
      })
    ).toBe(0);
    expect(
      shadowQueueKellySize({
        action: "BUY",
        price: 0,
        book: baseBook,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory(),
        positionSizeMultiplier: 1
      })
    ).toBe(0);
  });

  it("assembles shadow queue trade intents from drift decisions and runtime sizing", () => {
    const intent = buildShadowQueueTradeIntentFromDecision({
      decision: decision({ action: "GREEN_LIGHT", dispatchSide: "BUY", pnMidPrice: 100 }),
      book: book({ bestBid: 99.5, bestAsk: 100.5, tickSize: 0.5, spread: 1 }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 10,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      equity: 1_000,
      maxPositionPct: 0.1,
      kellyFraction: 0.5,
      inventory: inventory({ netDelta: 0, maxInventoryUnits: 2 }),
      positionSizeMultiplier: 1
    });

    expect(intent).toMatchObject({
      action: "BUY",
      expectedPrice: 99,
      requestedSize: 0.2,
      approvedSize: 0.2,
      postOnly: true,
      timeInForce: "ALO"
    });

    expect(
      buildShadowQueueTradeIntentFromDecision({
        decision: decision({ dispatchSide: null }),
        book: book(),
        observedAt: OBSERVED_AT,
        engineId: "engine-1",
        baseSpreadBps: 10,
        exchangeFeeBps: 1,
        toxicityScore: 0.3,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory(),
        positionSizeMultiplier: 1
      })
    ).toBeNull();
  });

  it("builds green and red light trade intents with bounded confidence", () => {
    const green = buildShadowQueueTradeIntent({
      decision: decision({ action: "GREEN_LIGHT", dispatchSide: "BUY", microDrift: 1 }),
      book: book(),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 99.5
    });

    expect(green).toMatchObject({
      intentId: "vlo-intent:decision-1",
      traceId: "engine-1:shadow-queue:fill-1",
      direction: "LONG",
      action: "BUY",
      postOnly: true,
      timeInForce: "ALO",
      requestedSize: 0.25,
      probabilityWin: 0.56,
      adverseSelectionCost: 0.3,
      maxSlippageBps: 20,
      confidence: 1
    });

    const red = buildShadowQueueTradeIntent({
      decision: decision({ action: "RED_LIGHT", dispatchSide: "SELL", microDrift: -0.1 }),
      book: book({ spreadBps: null }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 100.5
    });

    expect(red).toMatchObject({
      direction: "SHORT",
      action: "SELL",
      probabilityWin: 0.53,
      adverseSelectionCost: 0,
      maxSlippageBps: 4,
      confidence: 0.2
    });

    expect(
      buildShadowQueueTradeIntent({
        decision: decision({ dispatchSide: null }),
        book: book(),
        observedAt: OBSERVED_AT,
        engineId: "engine-1",
        baseSpreadBps: 4,
        exchangeFeeBps: 1,
        toxicityScore: 0,
        requestedSize: 0.25,
        price: 99
      })
    ).toBeNull();
  });

  it("resolves sizing config from hot config with bounded env fallback", () => {
    expect(
      resolveShadowQueueSizingConfig({
        cachedConfig: { ...defaultConfig, MAX_POSITION_PCT: 0.03, KELLY_FRACTION: 0.2 },
        envMaxPositionPct: 0.1,
        envKellyFraction: 2
      })
    ).toEqual({ maxPositionPct: 0.03, kellyFraction: 0.2 });
    expect(
      resolveShadowQueueSizingConfig({
        cachedConfig: {
          ...defaultConfig,
          MAX_POSITION_PCT: 0,
          KELLY_FRACTION: 0
        } as GlobalRiskConfig,
        envMaxPositionPct: 0.1,
        envKellyFraction: 2
      })
    ).toEqual({ maxPositionPct: 0.1, kellyFraction: 1 });
  });
});

function book(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [{ price: 99.5, size: 10, updatedAt: OBSERVED_AT }],
    asks: [{ price: 100.5, size: 10, updatedAt: OBSERVED_AT }],
    bestBid: 99.5,
    bestAsk: 100.5,
    midPrice: 100,
    spread: 1,
    spreadBps: 20,
    weightedImbalance: 0,
    lastSequence: 7,
    tickSize: 0.5,
    ttbLatencyMs: 2,
    isSynced: true,
    desyncReason: null,
    sequence: 7,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function inventory(overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "btc",
    normalization: {},
    maxInventoryUnits: 2,
    maxInventoryDelta: 2,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function shadowFill(overrides: Partial<ShadowQueueFill> = {}): ShadowQueueFill {
  return {
    fillId: "fill-1",
    instrumentCode: "btc-usd",
    side: "BUY",
    price: 99.5,
    size: 2,
    queueAhead: 0.5,
    p0MidPrice: 100,
    fillTradeSequence: 12,
    filledAt: OBSERVED_AT,
    ...overrides
  };
}

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
    sequence: 12,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1,
    ...overrides
  };
}

function decision(overrides: Partial<ShadowQueueDecision> = {}): ShadowQueueDecision {
  return {
    decisionId: "decision-1",
    fillId: "fill-1",
    instrumentCode: "btc-usd",
    originalSide: "BUY",
    action: "GREEN_LIGHT",
    dispatchSide: "BUY",
    p0MidPrice: 100,
    pnMidPrice: 101,
    microDrift: 1,
    driftTrades: 3,
    tickThreshold: 0.5,
    decisionLatencyMs: 1,
    tradeIntentId: null,
    reason: "test",
    decidedAt: OBSERVED_AT,
    ...overrides
  };
}

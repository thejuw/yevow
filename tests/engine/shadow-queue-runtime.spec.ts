import { describe, expect, it } from "vitest";
import {
  applyShadowQueueDecisionFlow,
  applyShadowQueueDecisionActionSideEffects,
  applyShadowQueueLatencyBreachSideEffects,
  buildShadowQueueDecisionAction,
  buildShadowQueueDecisionRuntimeArtifacts,
  buildShadowQueueDecisionTrace,
  buildShadowQueueGhostFillRecord,
  buildShadowQueueGhostFillRuntimeRecord,
  buildShadowQueueLatencyBreachTelemetry,
  buildShadowQueueNoEdgeTelemetry,
  buildShadowQueueTradeIntent,
  buildShadowQueueTradeIntentFromDecision,
  emitShadowQueueGhostFillSideEffects,
  emitShadowQueueNoEdgeDecisionSideEffects,
  enforceShadowQueueDecisionLatency,
  processShadowQueueTickRuntime,
  resolveShadowQueueGhostFillConfig,
  resolveShadowQueueNoEdgeLogInterval,
  resolveShadowQueueSizingConfig,
  shouldLogShadowQueueNoEdge,
  shouldProcessShadowQueueTick,
  shadowQueueKellySize,
  shadowQueuePostOnlyPrice,
  type ShadowQueueDecisionActionSideEffectHandlers,
  type ShadowQueueDecisionFlowHandlers,
  type ShadowQueueGhostFillSideEffectHandlers,
  type ShadowQueueLatencyBreachSideEffectHandlers,
  type ShadowQueueNoEdgeSideEffectHandlers,
  type ShadowQueueTickRuntimeHandlers
} from "../../src/engine/trading/shadow/ShadowQueueRuntime";
import { defaultConfig } from "../../src/ConfigManager";
import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  MarketTick,
  ShadowQueueFill,
  ShadowQueueDecision,
  ShadowQueueState,
  SlippageAnalytics
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

  it("processes trade ticks through ghost fill and decision handlers", () => {
    const sideEffects = shadowQueueTickRuntimeSpy();
    const state = processShadowQueueTickRuntime(
      {
        tick: marketTick(),
        book: book(),
        observedAt: OBSERVED_AT
      },
      sideEffects.handlers
    );

    expect(state.lastDecision?.decisionId).toBe("decision-updated");
    expect(sideEffects.events).toEqual([
      "observe:12",
      "fill:fill-1",
      "handle:decision-1",
      "record:decision-updated",
      "inject:btc-usd",
      "snapshot:2026-05-18T09:00:00.000Z",
      "snapshot:2026-05-18T09:00:00.000Z"
    ]);
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

  it("emits ghost fill side effects with execution recording when a paper trade exists", () => {
    const tradeRecord = buildShadowQueueGhostFillRecord({
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
    const zeroSizeRecord = buildShadowQueueGhostFillRecord({
      fill: shadowFill({ fillId: "fill-zero" }),
      tick: marketTick(),
      book: book(),
      observedAt: OBSERVED_AT,
      participationRate: 0.35,
      adverseBps: 1.5,
      makerFeeBps: 1,
      fillModelSource: "bootstrap",
      paperFillPrice: 99.5,
      paperSizeCap: 0,
      executablePaperSize: 0
    });
    const sideEffects = shadowQueueGhostFillSideEffectSpy();

    emitShadowQueueGhostFillSideEffects("fill-1", tradeRecord, sideEffects.handlers);
    emitShadowQueueGhostFillSideEffects("fill-zero", zeroSizeRecord, sideEffects.handlers);

    expect(sideEffects.events).toEqual([
      "record:shadow-queue:fill-1:1779094800000",
      "publish:SHADOW_QUEUE_GHOST_FILL:fill-1",
      "publish:SHADOW_QUEUE_GHOST_FILL:fill-zero"
    ]);
  });

  it("models runtime ghost fills from slippage, participation, and Kelly caps", () => {
    const record = buildShadowQueueGhostFillRuntimeRecord({
      fill: shadowFill(),
      tick: marketTick(),
      book: book(),
      observedAt: OBSERVED_AT,
      slippage: slippageAnalytics(),
      fallbackAdverseBps: 1.5,
      participationRate: 0.35,
      makerFeeBps: 1,
      cachedConfig: { ...defaultConfig, MAX_POSITION_PCT: 0.1, KELLY_FRACTION: 0.5 },
      envMaxPositionPct: 0.01,
      envKellyFraction: 0.1,
      equity: 1_000,
      inventory: inventory({ netDelta: 0, maxInventoryUnits: 2 }),
      positionSizeMultiplier: 1
    });

    expect(record.trade).toMatchObject({
      side: "BUY",
      price: 100,
      size: 0.2,
      slippageBps: 5,
      fees: 0.002,
      metadata: {
        fillModelSource: "EMPIRICAL_BOOTSTRAP",
        paperExecutionSize: 0.2,
        paperSizeCap: 0.2,
        participationRate: 0.35,
        adverseBps: 5,
        makerFeeBps: 1,
        sizeCapped: true
      }
    });
  });

  it("resolves shadow queue ghost-fill config from bounded environment values", () => {
    expect(
      resolveShadowQueueGhostFillConfig({
        paperFillParticipationRate: "1.5",
        paperFillAdverseBps: "-4",
        paperMakerFeeBps: undefined,
        exchangeFeeBps: "2",
        maxPositionPct: "0.2",
        kellyFraction: "0.7"
      })
    ).toEqual({
      participationRate: 1,
      fallbackAdverseBps: 0,
      makerFeeBps: 2,
      envMaxPositionPct: 0.2,
      envKellyFraction: 0.7
    });
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

  it("builds no-edge telemetry from VLO drift decisions", () => {
    const telemetry = buildShadowQueueNoEdgeTelemetry(
      decision({ action: "NO_EDGE", dispatchSide: null, microDrift: 0.1, tickThreshold: 0.5 })
    );

    expect(telemetry).toMatchObject({
      eventType: "SHADOW_QUEUE_NO_EDGE",
      message: "Virtual fill drift stayed inside one tick",
      metadata: {
        decisionId: "decision-1",
        fillId: "fill-1",
        instrumentCode: "btc-usd",
        microDrift: 0.1,
        tickThreshold: 0.5,
        driftTrades: 3,
        sampled: true
      },
      correlationId: "decision-1"
    });
    expect(telemetry.payload).toMatchObject({
      action: "NO_EDGE",
      dispatchSide: null
    });
  });

  it("emits no-edge decision logs through the throttle and always publishes telemetry", () => {
    const sideEffects = shadowQueueNoEdgeSideEffectSpy();
    const lastLoggedAtByInstrument = new Map<string, number>();
    const noEdge = decision({
      action: "NO_EDGE",
      dispatchSide: null,
      microDrift: 0.1,
      tickThreshold: 0.5
    });

    emitShadowQueueNoEdgeDecisionSideEffects(
      { decision: noEdge, lastLoggedAtByInstrument, nowMs: 1_000, intervalMs: 500 },
      sideEffects.handlers
    );
    emitShadowQueueNoEdgeDecisionSideEffects(
      { decision: noEdge, lastLoggedAtByInstrument, nowMs: 1_250, intervalMs: 500 },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "info:SHADOW_QUEUE_NO_EDGE:decision-1",
      "publish:SHADOW_QUEUE_NO_EDGE:decision-1",
      "publish:SHADOW_QUEUE_NO_EDGE:decision-1"
    ]);
  });

  it("builds latency-breach telemetry with suppressed decision payload", () => {
    const originalDecision = decision({
      decisionLatencyMs: 9,
      tradeIntentId: "intent-1",
      reason: "late"
    });
    const suppressedDecision = enforceShadowQueueDecisionLatency(originalDecision, 5).decision;

    const telemetry = buildShadowQueueLatencyBreachTelemetry({
      originalDecision,
      suppressedDecision,
      latencyBudgetMs: 5
    });

    expect(telemetry).toMatchObject({
      eventType: "SHADOW_QUEUE_LATENCY_BREACH",
      message: "VLO matrix decision exceeded 5ms envelope",
      metadata: {
        decisionId: "decision-1",
        instrumentCode: "btc-usd",
        decisionLatencyMs: 9,
        latencyBudgetMs: 5
      },
      correlationId: "decision-1"
    });
    expect(telemetry.payload).toMatchObject({
      tradeIntentId: null,
      reason: "late Suppressed because drift decision latency exceeded 5ms."
    });
  });

  it("applies latency-breach side effects only when the decision exceeds budget", () => {
    const sideEffects = shadowQueueLatencyBreachSideEffectSpy();
    const withinBudget = applyShadowQueueLatencyBreachSideEffects(
      { decision: decision({ decisionLatencyMs: 5 }), latencyBudgetMs: 5 },
      sideEffects.handlers
    );
    const suppressed = applyShadowQueueLatencyBreachSideEffects(
      {
        decision: decision({ decisionLatencyMs: 9, tradeIntentId: "intent-1", reason: "late" }),
        latencyBudgetMs: 5
      },
      sideEffects.handlers
    );

    expect(withinBudget).toBeNull();
    expect(suppressed).toMatchObject({
      tradeIntentId: null,
      reason: "late Suppressed because drift decision latency exceeded 5ms."
    });
    expect(sideEffects.events).toEqual([
      "warn:SHADOW_QUEUE_LATENCY_BREACH:decision-1",
      "publish:SHADOW_QUEUE_LATENCY_BREACH:decision-1"
    ]);
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

  it("plans shadow queue decision side effects without touching runtime IO", () => {
    const intent = buildShadowQueueTradeIntent({
      decision: decision({ action: "RED_LIGHT", dispatchSide: "SELL" }),
      book: book(),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 100.5
    });

    expect(
      buildShadowQueueDecisionAction({
        decision: decision({ action: "GREEN_LIGHT" }),
        intent: null,
        tradingEnabled: true
      })
    ).toMatchObject({
      publish: {
        type: "SHADOW_QUEUE_SIGNAL_SUPPRESSED",
        correlationId: "decision-1"
      },
      cancelReason: null,
      dispatchIntent: null
    });
    expect(
      buildShadowQueueDecisionAction({
        decision: decision({ action: "RED_LIGHT" }),
        intent,
        tradingEnabled: true
      })
    ).toMatchObject({
      publish: {
        type: "SHADOW_QUEUE_RED_LIGHT",
        correlationId: "decision-1"
      },
      cancelReason: "SHADOW_QUEUE_RED_LIGHT",
      dispatchIntent: intent
    });
    expect(
      buildShadowQueueDecisionAction({
        decision: decision({ action: "GREEN_LIGHT" }),
        intent,
        tradingEnabled: false
      })
    ).toMatchObject({
      publish: {
        type: "SHADOW_QUEUE_GREEN_LIGHT"
      },
      cancelReason: null,
      dispatchIntent: null
    });
  });

  it("applies shadow queue decision action side effects in publish then work order", async () => {
    const intent = buildShadowQueueTradeIntent({
      decision: decision({ action: "RED_LIGHT", dispatchSide: "SELL" }),
      book: book(),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 100.5
    });
    const action = buildShadowQueueDecisionAction({
      decision: decision({ action: "RED_LIGHT" }),
      intent,
      tradingEnabled: true
    });
    const sideEffects = shadowQueueDecisionActionSideEffectSpy();

    applyShadowQueueDecisionActionSideEffects(
      { action, instrumentCode: "btc-usd" },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "publish:SHADOW_QUEUE_RED_LIGHT:decision-1",
      "cancel:btc-usd:SHADOW_QUEUE_RED_LIGHT",
      "schedule",
      "dispatch:vlo-intent:decision-1",
      "schedule"
    ]);

    await Promise.all(sideEffects.scheduled);
  });

  it("assembles shadow queue decision runtime artifacts", () => {
    const artifacts = buildShadowQueueDecisionRuntimeArtifacts({
      decision: decision({ action: "GREEN_LIGHT", dispatchSide: "BUY", microDrift: 0.6 }),
      book: book(),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      equity: 1_000,
      maxPositionPct: 0.1,
      kellyFraction: 0.5,
      inventory: inventory({ netDelta: 0, maxInventoryUnits: 2 }),
      positionSizeMultiplier: 1,
      quoteStateStatus: "ACTIVE",
      cachedConfigVersion: "config-v1",
      tradingEnabled: true
    });

    expect(artifacts.intent).toMatchObject({
      intentId: "vlo-intent:decision-1",
      action: "BUY",
      orderType: "LIMIT",
      postOnly: true
    });
    expect(artifacts.decision.tradeIntentId).toBe("vlo-intent:decision-1");
    expect(artifacts.trace).toMatchObject({
      decisionId: "decision-1",
      expectedValue: artifacts.intent?.expectedValue,
      riskSnapshot: {
        quoteState: "ACTIVE",
        cachedConfigVersion: "config-v1"
      }
    });
    expect(artifacts.action).toMatchObject({
      publish: {
        type: "SHADOW_QUEUE_GREEN_LIGHT",
        correlationId: "decision-1"
      },
      cancelReason: null,
      dispatchIntent: artifacts.intent
    });
  });

  it("routes no-edge decisions through the shadow queue flow without tracing execution", () => {
    const flow = shadowQueueDecisionFlowSpy();

    const result = applyShadowQueueDecisionFlow(
      {
        ...shadowQueueDecisionFlowInput({
          decision: decision({ action: "NO_EDGE", dispatchSide: null })
        }),
        noEdgeNowMs: 10_000
      },
      flow.handlers
    );

    expect(result).toMatchObject({
      action: "NO_EDGE",
      dispatchSide: null
    });
    expect(flow.events).toEqual([
      "info:SHADOW_QUEUE_NO_EDGE:decision-1",
      "publish:SHADOW_QUEUE_NO_EDGE:decision-1"
    ]);
  });

  it("routes eligible shadow queue decisions through trace and execution side effects", async () => {
    const flow = shadowQueueDecisionFlowSpy();

    const result = applyShadowQueueDecisionFlow(
      shadowQueueDecisionFlowInput({
        decision: decision({ action: "RED_LIGHT", dispatchSide: "SELL", microDrift: -0.6 })
      }),
      flow.handlers
    );

    expect(result).toMatchObject({
      action: "RED_LIGHT",
      dispatchSide: "SELL",
      tradeIntentId: "vlo-intent:decision-1"
    });
    expect(flow.events).toEqual([
      "trace:decision-1",
      "publish:SHADOW_QUEUE_RED_LIGHT:decision-1",
      "cancel:btc-usd:SHADOW_QUEUE_RED_LIGHT",
      "schedule",
      "dispatch:vlo-intent:decision-1",
      "schedule"
    ]);
    await Promise.all(flow.scheduled);
  });

  it("suppresses shadow queue decisions that exceed the latency envelope", () => {
    const flow = shadowQueueDecisionFlowSpy();

    const result = applyShadowQueueDecisionFlow(
      shadowQueueDecisionFlowInput({
        decision: decision({
          action: "GREEN_LIGHT",
          dispatchSide: "BUY",
          decisionLatencyMs: 9,
          reason: "late"
        }),
        latencyBudgetMs: 5
      }),
      flow.handlers
    );

    expect(result).toMatchObject({
      tradeIntentId: null,
      reason: "late Suppressed because drift decision latency exceeded 5ms."
    });
    expect(flow.events).toEqual([
      "warn:SHADOW_QUEUE_LATENCY_BREACH:decision-1",
      "publish:SHADOW_QUEUE_LATENCY_BREACH:decision-1"
    ]);
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

function shadowQueueGhostFillSideEffectSpy(): {
  events: string[];
  handlers: ShadowQueueGhostFillSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      recordExecution(trade) {
        events.push(`record:${trade.tradeId}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      }
    }
  };
}

function shadowQueueNoEdgeSideEffectSpy(): {
  events: string[];
  handlers: ShadowQueueNoEdgeSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      logInfo(eventType, _message, metadata) {
        events.push(`info:${eventType}:${metadata.decisionId}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      }
    }
  };
}

function shadowQueueLatencyBreachSideEffectSpy(): {
  events: string[];
  handlers: ShadowQueueLatencyBreachSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      warn(eventType, _message, metadata) {
        events.push(`warn:${eventType}:${metadata.decisionId}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      }
    }
  };
}

function shadowQueueDecisionActionSideEffectSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: ShadowQueueDecisionActionSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      cancelAllQuotes(instrumentCode, reason) {
        events.push(`cancel:${instrumentCode}:${reason}`);
        return Promise.resolve();
      },
      dispatchExecution(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      }
    }
  };
}

function shadowQueueDecisionFlowSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: ShadowQueueDecisionFlowHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      logInfo(eventType, _message, metadata) {
        events.push(`info:${eventType}:${metadata.decisionId}`);
      },
      warn(eventType, _message, metadata) {
        events.push(`warn:${eventType}:${metadata.decisionId}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      cancelAllQuotes(instrumentCode, reason) {
        events.push(`cancel:${instrumentCode}:${reason}`);
        return Promise.resolve();
      },
      dispatchExecution(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      },
      traceDecision(trace) {
        events.push(`trace:${trace.decisionId}`);
      }
    }
  };
}

function shadowQueueDecisionFlowInput(
  overrides: Partial<Parameters<typeof applyShadowQueueDecisionFlow>[0]> = {}
): Parameters<typeof applyShadowQueueDecisionFlow>[0] {
  return {
    decision: decision({ action: "GREEN_LIGHT", dispatchSide: "BUY", microDrift: 0.6 }),
    book: book(),
    observedAt: OBSERVED_AT,
    engineId: "engine-1",
    baseSpreadBps: 4,
    exchangeFeeBps: 1,
    toxicityScore: 0.3,
    equity: 1_000,
    maxPositionPct: 0.1,
    kellyFraction: 0.5,
    inventory: inventory({ netDelta: 0, maxInventoryUnits: 2 }),
    positionSizeMultiplier: 1,
    quoteStateStatus: "ACTIVE",
    cachedConfigVersion: "config-v1",
    tradingEnabled: true,
    latencyBudgetMs: 5,
    lastLoggedAtByInstrument: new Map(),
    noEdgeNowMs: 10_000,
    noEdgeLogIntervalMs: 1_000,
    ...overrides
  };
}

function shadowQueueTickRuntimeSpy(): {
  events: string[];
  handlers: ShadowQueueTickRuntimeHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      snapshot(observedAt) {
        events.push(`snapshot:${observedAt}`);
        return shadowQueueState({ lastDecision: decision({ decisionId: "decision-updated" }) });
      },
      observeTrade(tick) {
        events.push(`observe:${tick.sequence}`);
        return {
          fills: [shadowFill()],
          decisions: [decision()],
          state: shadowQueueState()
        };
      },
      recordGhostFill(fill) {
        events.push(`fill:${fill.fillId}`);
      },
      handleDecision(nextDecision) {
        events.push(`handle:${nextDecision.decisionId}`);
        return decision({ decisionId: "decision-updated" });
      },
      recordDecision(nextDecision) {
        events.push(`record:${nextDecision.decisionId}`);
      },
      injectBbo(currentBook) {
        events.push(`inject:${currentBook.instrumentCode}`);
      }
    }
  };
}

function shadowQueueState(overrides: Partial<ShadowQueueState> = {}): ShadowQueueState {
  return {
    schemaVersion: "shadow-queue.v1",
    capacity: 128,
    activeOrders: 0,
    pendingDrifts: 0,
    ghostFills: 0,
    greenLights: 0,
    redLights: 0,
    noEdgeSignals: 0,
    invertedSignals: 0,
    confirmedSignals: 0,
    driftTradeDelay: 3,
    latencyBudgetMs: 5,
    baseSpreadBps: 5,
    queueDepthMultiplier: 1,
    lastFill: null,
    lastDecision: null,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

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
    raw: { eventType: "trade" },
    ...overrides
  };
}

function slippageAnalytics(): SlippageAnalytics {
  return {
    schemaVersion: "slippage.v1",
    points: Array.from({ length: 20 }, () => ({
      expectedPrice: 100,
      achievedPrice: 100.05,
      slippageBps: 5,
      implementationShortfall: 0.05,
      latencyMs: 1,
      observedAt: OBSERVED_AT
    })),
    averageSlippageBps: 2.15,
    latencyCorrelation: null,
    executionCostBufferBps: 2.15,
    updatedAt: OBSERVED_AT
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

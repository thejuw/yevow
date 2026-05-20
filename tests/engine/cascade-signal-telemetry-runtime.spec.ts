import { describe, expect, it } from "vitest";
import {
  buildCascadeOperationalAlertTelemetry,
  buildCascadeSignalTelemetry,
  cascadeCloseOperationalAlert,
  cascadeEntryAgentSignal,
  cascadeEntryDecisionTrace,
  cascadeHeatCapAlertMetadata,
  cascadeManualCloseLogMetadata,
  cascadeManualCloseTelemetryPayload,
  cascadePositionOpenedAlertMetadata,
  cascadeSignalRejectionAgentSignal,
  cascadeSignalRejectionLogMetadata,
  cascadeSignalEmittedAlertMetadata,
  cascadeSizeRejectedLogMetadata,
  emitCascadeOperationalAlertSideEffects,
  type CascadeOperationalAlertSideEffectHandlers,
  recordCascadeUiSignalSideEffects,
  type CascadeUiSignalSideEffectHandlers
} from "../../src/engine/trading/telemetry/CascadeSignalTelemetryRuntime";
import type { AgentName, AgentSignal, TradeIntent } from "../../src/types";
import type { CascadeAssetProfile } from "../../src/strategy/cascade/AssetProfiles";
import type {
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignalRejection,
  CascadeRecoverySignal,
  PositionSizeDecision
} from "../../src/strategy/cascade/types";

describe("CascadeSignalTelemetryRuntime", () => {
  it("builds the dashboard cascade signal event and prefers feature cascade ids", () => {
    expect(
      buildCascadeSignalTelemetry(
        signal({
          featureVector: { cascadeId: "cascade-feature" },
          riskContext: { cascadeId: "cascade-risk" }
        }),
        "TAKEN"
      )
    ).toEqual({
      telemetryType: "CASCADE_SIGNAL",
      correlationId: "signal-1",
      payload: {
        signalId: "signal-1",
        traceId: "trace-1",
        sourceAgent: "ORACLE",
        targetAgent: "CROUPIER",
        instrumentCode: "hype-usd",
        action: "BUY",
        confidence: 0.8,
        expectedValue: 1.2,
        outcome: "TAKEN",
        cascadeId: "cascade-feature",
        createdAt: "2026-05-19T12:00:00.000Z"
      }
    });
  });

  it("falls back to risk-context cascade ids", () => {
    const event = buildCascadeSignalTelemetry(
      signal({ featureVector: {}, riskContext: { cascadeId: "cascade-risk" } }),
      "SKIPPED"
    );

    expect(event.payload).toMatchObject({
      outcome: "SKIPPED",
      cascadeId: "cascade-risk"
    });
  });

  it("records cascade UI signals, schedules persistence, and publishes telemetry", async () => {
    const signals: AgentSignal[] = [];
    const latestAgentSignals = new Map<AgentName, AgentSignal>();
    const sideEffects = cascadeUiSignalSideEffectSpy();

    recordCascadeUiSignalSideEffects(
      {
        signals,
        latestAgentSignals,
        signal: signal({ sourceAgent: "PIT_BOSS" }),
        outcome: "TAKEN",
        signalBufferLimit: 5
      },
      sideEffects.handlers
    );

    await Promise.all(sideEffects.scheduled);

    expect(signals.map((item) => item.signalId)).toEqual(["signal-1"]);
    expect(latestAgentSignals.get("PIT_BOSS")?.signalId).toBe("signal-1");
    expect(sideEffects.events).toEqual(["persist:signal-1", "publish:CASCADE_SIGNAL:signal-1"]);
  });

  it("builds dashboard-only operational alerts without external notifications", () => {
    const event = buildCascadeOperationalAlertTelemetry(
      "CASCADE_DETECTED",
      "Cascade detected",
      "Large liquidation wave detected",
      { cascadeId: "cascade-1", instrumentCode: "btc-usd" },
      "cascade-1"
    );

    expect(event).toEqual({
      telemetryType: "CASCADE_ALERT",
      correlationId: "cascade-1",
      notification: null,
      payload: {
        eventType: "CASCADE_DETECTED",
        priority: "LOW",
        routes: ["DASHBOARD"],
        externalDelivery: false,
        cascadeId: "cascade-1",
        instrumentCode: "btc-usd"
      }
    });
  });

  it("builds externally delivered operational alerts with notifier metadata", () => {
    const event = buildCascadeOperationalAlertTelemetry(
      "POSITION_OPENED",
      "Cascade position opened",
      "Paper cascade entry opened",
      { positionId: "position-1", instrumentCode: "hype-usd" },
      "position-1"
    );

    expect(event).toMatchObject({
      telemetryType: "CASCADE_ALERT",
      correlationId: "position-1",
      payload: {
        eventType: "POSITION_OPENED",
        priority: "HIGH",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS"],
        externalDelivery: true,
        positionId: "position-1",
        instrumentCode: "hype-usd"
      },
      notification: {
        priority: "HIGH",
        title: "Cascade position opened",
        message: "Paper cascade entry opened",
        dedupeKey: "cascade:POSITION_OPENED:position-1",
        metadata: {
          positionId: "position-1"
        }
      }
    });
  });

  it("emits cascade operational alert side effects only when notifications exist", () => {
    const sideEffects = cascadeOperationalAlertSideEffectSpy();
    const dashboardOnly = buildCascadeOperationalAlertTelemetry(
      "CASCADE_DETECTED",
      "Cascade detected",
      "Large liquidation wave detected",
      { cascadeId: "cascade-1" },
      "cascade-1"
    );
    const external = buildCascadeOperationalAlertTelemetry(
      "POSITION_OPENED",
      "Cascade position opened",
      "Paper cascade entry opened",
      { positionId: "position-1" },
      "position-1"
    );

    emitCascadeOperationalAlertSideEffects(dashboardOnly, sideEffects.handlers);
    emitCascadeOperationalAlertSideEffects(external, sideEffects.handlers);

    expect(sideEffects.events).toEqual([
      "publish:CASCADE_ALERT:cascade-1",
      "publish:CASCADE_ALERT:position-1",
      "notify:HIGH"
    ]);
  });

  it("builds cascade entry signal, trace, and alert metadata", () => {
    const recoverySignal = cascadeRecoverySignal();
    const intent = tradeIntent();
    const position = cascadePosition();
    const assetProfile = cascadeAssetProfile();
    const sizeDecision = positionSizeDecision();
    const context = {
      signal: recoverySignal,
      intent,
      engineId: "engine-1",
      position,
      assetProfile,
      sizeDecision,
      observedAt: "2026-05-19T12:00:30.000Z"
    };

    expect(cascadeSignalEmittedAlertMetadata(recoverySignal)).toMatchObject({
      signalId: "cascade-signal-1",
      cascadeId: "cascade-1",
      triggerType: "VWAP_RECLAIM"
    });
    expect(cascadeSizeRejectedLogMetadata(recoverySignal, sizeDecision)).toEqual({
      signalId: "cascade-signal-1",
      instrumentCode: "hype-usd",
      limitingFactor: "RISK",
      reason: "approved"
    });
    expect(cascadeHeatCapAlertMetadata(recoverySignal, sizeDecision, 0.12, 0.2)).toMatchObject({
      signalId: "cascade-signal-1",
      currentHeat: 0.12,
      heatAfterPct: 0.15,
      heatCapPct: 0.2
    });
    expect(cascadeEntryAgentSignal(context)).toMatchObject({
      signalId: "cascade-signal-1",
      traceId: "engine-1:cascade:cascade-signal-1",
      sourceAgent: "PIT_BOSS",
      targetAgent: "EXECUTIONER",
      action: "BUY",
      horizonMs: 7_170_000,
      riskContext: {
        outcome: "TAKEN",
        cascadeId: "cascade-1",
        positionId: "position-1"
      }
    });
    expect(cascadeEntryDecisionTrace({ ...context, currentHeat: 0.1 })).toMatchObject({
      decisionId: "cascade-entry-cascade-signal-1",
      agentName: "PIT_BOSS",
      targetAgent: "EXECUTIONER",
      reasoning: "Cascade recovery entry approved. Heat 0.1 -> 0.15.",
      riskSnapshot: {
        positionId: "position-1"
      }
    });
    expect(cascadePositionOpenedAlertMetadata(context)).toMatchObject({
      signalId: "cascade-signal-1",
      positionId: "position-1",
      entryPrice: 20,
      stopPrice: 18,
      notionalUsd: 100,
      observedAt: "2026-05-19T12:00:30.000Z"
    });
  });

  it("builds cascade rejection telemetry artifacts", () => {
    const rejection = cascadeRejection();

    expect(cascadeSignalRejectionLogMetadata(rejection)).toEqual({
      cascadeId: "cascade-1",
      instrumentCode: "hype-usd",
      reasons: "news_blackout,volatility_cap"
    });
    expect(
      cascadeSignalRejectionAgentSignal({
        rejection,
        engineId: "engine-1",
        observedAt: "2026-05-19T12:00:30.000Z",
        entryWindowMs: 300_000
      })
    ).toMatchObject({
      signalId: "cascade-reject-cascade-1-1779192030000",
      traceId: "engine-1:cascade-reject:cascade-1",
      sourceAgent: "PIT_BOSS",
      targetAgent: "SYSTEM",
      action: "HOLD",
      horizonMs: 300_000,
      riskContext: {
        outcome: "SKIPPED",
        cascadeId: "cascade-1",
        reasons: ["news_blackout", "volatility_cap"]
      }
    });
  });

  it("builds cascade manual close and stop alert metadata", () => {
    const position = cascadePosition();
    const manualClose = {
      position,
      actor: "operator@example.com",
      reason: "risk review",
      markPrice: 21,
      observedAt: "2026-05-19T12:05:00.000Z"
    };

    expect(cascadeManualCloseLogMetadata(manualClose)).toEqual({
      positionId: "position-1",
      actor: "operator@example.com",
      reason: "risk review",
      instrumentCode: "hype-usd",
      markPrice: 21,
      remainingSize: 5
    });
    expect(cascadeManualCloseTelemetryPayload(manualClose)).toMatchObject({
      positionId: "position-1",
      observedAt: "2026-05-19T12:05:00.000Z"
    });
    expect(cascadeCloseOperationalAlert(cascadeCloseIntent(), manualClose.observedAt)).toEqual({
      eventType: "STOP_HIT",
      title: "Cascade stop hit",
      message: "hype-usd cascade position position-1 triggered STOP_LOSS.",
      metadata: {
        positionId: "position-1",
        signalId: "cascade-signal-1",
        instrumentCode: "hype-usd",
        closeReason: "STOP_LOSS",
        size: 5,
        referencePrice: 18,
        observedAt: "2026-05-19T12:05:00.000Z"
      },
      dedupeKey: "position-1"
    });
    expect(
      cascadeCloseOperationalAlert(
        cascadeCloseIntent({ closeReason: "FIRST_TARGET" }),
        manualClose.observedAt
      )
    ).toBeNull();
  });
});

function cascadeOperationalAlertSideEffectSpy(): {
  events: string[];
  handlers: CascadeOperationalAlertSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      publish(telemetryType, _payload, correlationId) {
        events.push(`publish:${telemetryType}:${correlationId}`);
      },
      notify(notification) {
        events.push(`notify:${notification.priority}`);
      }
    }
  };
}

function cascadeUiSignalSideEffectSpy(): {
  events: string[];
  scheduled: Promise<void>[];
  handlers: CascadeUiSignalSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<void>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      schedule(work) {
        scheduled.push(work);
      },
      persistSignal(signalToPersist) {
        events.push(`persist:${signalToPersist.signalId}`);
        return Promise.resolve();
      },
      publish(telemetryType, _payload, correlationId) {
        events.push(`publish:${telemetryType}:${correlationId}`);
      }
    }
  };
}

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    signalId: "signal-1",
    traceId: "trace-1",
    sourceAgent: "ORACLE",
    targetAgent: "CROUPIER",
    instrumentCode: "hype-usd",
    action: "BUY",
    confidence: 0.8,
    horizonMs: 10_000,
    expectedValue: 1.2,
    maxSlippageBps: 5,
    rationale: "cascade recovery",
    featureVector: {},
    riskContext: {},
    createdAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}

function cascadeRecoverySignal(
  overrides: Partial<CascadeRecoverySignal> = {}
): CascadeRecoverySignal {
  return {
    schemaVersion: "cascade.recovery-signal.v1",
    signalId: "cascade-signal-1",
    cascadeId: "cascade-1",
    instrumentCode: "hype-usd",
    direction: "LONG",
    triggerType: "VWAP_RECLAIM",
    entryPrice: 20,
    stopPrice: 18,
    rDistance: 2,
    targets: {
      partial1: { price: 24, rMultiple: 2, sizePct: 0.33 },
      partial2: { price: 26, rMultiple: 3, sizePct: 0.33 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.34 }
    },
    timeStopAt: "2026-05-19T14:00:00.000Z",
    confidence: 0.72,
    context: { trigger: "reclaim" },
    emittedAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}

function cascadeRejection(): CascadeRecoverySignalRejection {
  return {
    schemaVersion: "cascade.recovery-signal-rejection.v1",
    cascadeId: "cascade-1",
    instrumentCode: "hype-usd",
    rejectedAt: "2026-05-19T12:00:30.000Z",
    reasons: ["news_blackout", "volatility_cap"],
    context: { regime: "CRISIS" }
  };
}

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-intent-1",
    instrumentCode: "hype-usd",
    marketKey: "hyperliquid:hype-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    action: "BUY",
    orderType: "IOC",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: 20,
    expectedPrice: 20,
    requestedSize: 5,
    approvedSize: 5,
    probabilityWin: 0.72,
    probabilityLoss: 0.28,
    profit: 4,
    loss: 2,
    executionCosts: 0.0004,
    adverseSelectionCost: 0,
    expectedValue: 2,
    minEvThreshold: 0,
    maxSlippageBps: 10,
    confidence: 0.72,
    rationale: "cascade entry",
    createdAt: "2026-05-19T12:00:30.000Z",
    ...overrides
  };
}

function cascadeCloseIntent(overrides: Partial<CascadePositionIntent> = {}): CascadePositionIntent {
  return {
    intentId: "close-intent-1",
    positionId: "position-1",
    signalId: "cascade-signal-1",
    instrumentCode: "hype-usd",
    kind: "CLOSE",
    closeReason: "STOP_LOSS",
    action: "SELL",
    orderType: "IOC",
    executionStyle: "TAKER_MARKET",
    size: 5,
    referencePrice: 18,
    createdAt: "2026-05-19T12:05:00.000Z",
    ...overrides
  };
}

function cascadeAssetProfile(): CascadeAssetProfile {
  return {
    asset: "HYPE",
    notionalThresholdUsd: 5_000_000,
    zScoreThreshold: 3,
    minPriceMoveAtr: 1.5,
    maxPositionNotionalPct: 0.05,
    assetLiquidityCapUsd: 1_000,
    maxSlippageBps: 12,
    rationale: "test"
  };
}

function positionSizeDecision(): PositionSizeDecision {
  return {
    approved: true,
    units: 5,
    notionalUsd: 100,
    riskUsd: 10,
    riskPct: 0.03,
    heatAfterPct: 0.15,
    limitingFactor: "RISK",
    reason: "approved",
    bounds: {
      riskUnits: 5,
      notionalUnits: 10,
      liquidityUnits: 50,
      heatUnits: 8
    }
  };
}

function cascadePosition(): CascadeOpenPosition {
  return {
    positionId: "position-1",
    signalId: "cascade-signal-1",
    cascadeId: "cascade-1",
    instrumentCode: "hype-usd",
    direction: "LONG",
    status: "ENTERED",
    entryPrice: 20,
    currentStopPrice: 18,
    initialStopPrice: 18,
    totalSize: 5,
    remainingSize: 5,
    initialRiskPct: 0.03,
    rDistance: 2,
    targets: cascadeRecoverySignal().targets,
    timeStopAt: "2026-05-19T14:00:00.000Z",
    firstTargetTaken: false,
    secondTargetTaken: false,
    enteredAt: "2026-05-19T12:00:30.000Z",
    updatedAt: "2026-05-19T12:00:30.000Z"
  };
}

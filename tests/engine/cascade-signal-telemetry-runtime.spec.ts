import { describe, expect, it } from "vitest";
import {
  buildCascadeOperationalAlertTelemetry,
  buildCascadeSignalTelemetry,
  cascadeEntryAgentSignal,
  cascadeEntryDecisionTrace,
  cascadeHeatCapAlertMetadata,
  cascadePositionOpenedAlertMetadata,
  cascadeSignalEmittedAlertMetadata,
  cascadeSizeRejectedLogMetadata
} from "../../src/engine/trading/telemetry/CascadeSignalTelemetryRuntime";
import type { AgentSignal, TradeIntent } from "../../src/types";
import type { CascadeAssetProfile } from "../../src/strategy/cascade/AssetProfiles";
import type {
  CascadeOpenPosition,
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
});

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
    status: "OPEN",
    entryPrice: 20,
    currentStopPrice: 18,
    initialStopPrice: 18,
    totalSize: 5,
    remainingSize: 5,
    initialRiskPct: 0.03,
    rDistance: 2,
    targets: cascadeRecoverySignal().targets,
    timeStopAt: "2026-05-19T14:00:00.000Z",
    openedAt: "2026-05-19T12:00:30.000Z",
    updatedAt: "2026-05-19T12:00:30.000Z",
    closedAt: null,
    realizedPnl: 0,
    partialsTaken: []
  };
}

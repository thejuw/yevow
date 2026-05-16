import { describe, expect, it } from "vitest";
import {
  buildGhostExecutionReport,
  buildGhostTradeExecution,
  buildSignedTradeIntentAudit,
  evaluateGrpcDrop,
  isShadowMode
} from "../../src/utils/CitadelProtocol";
import type { TradeIntent } from "../../src/types";

describe("Citadel Protocol chaos decisions", () => {
  it("promotes a Dwellir gRPC blackout to CRITICAL and emits evacuation intent", () => {
    const observedAt = "2026-05-16T00:00:00.000Z";
    const decision = evaluateGrpcDrop({
      disconnectedForMs: 250,
      thresholdMs: 200,
      reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
      observedAt
    });

    expect(decision.status).toBe("CRITICAL");
    expect(decision.shouldEvacuate).toBe(true);
    expect(decision.evacuationSignal).toMatchObject({
      action: "CANCEL_ALL_QUOTES",
      reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
      observedAt
    });
  });

  it("builds a signed ghost fill audit without sending to Hyperliquid", () => {
    const observedAt = "2026-05-16T00:00:01.000Z";
    const intent = sampleIntent();
    const audit = buildSignedTradeIntentAudit(
      intent,
      {
        endpoint: "https://api.hyperliquid.xyz/exchange",
        init: {
          method: "POST",
          body: JSON.stringify({
            action: { type: "order" },
            nonce: 1778888000000,
            signature: { r: "0x01", s: "0x02", v: 27 }
          })
        },
        signingLatencyMs: 0.42,
        redactedPayload: { adapter: "hyperliquid", tif: "Alo" }
      },
      observedAt
    );
    const report = buildGhostExecutionReport(intent, audit);
    const trade = buildGhostTradeExecution(intent, audit, "hyperliquid");

    expect(isShadowMode({ SHADOW_MODE: "true" })).toBe(true);
    expect(audit.orderType).toBe("LIMIT");
    expect(audit.expectedSlippageBps).toBe(2);
    expect(audit.exactTimestamp).toBe(observedAt);
    expect(audit.signedPayload.signature).toEqual({ r: "0x01", s: "0x02", v: 27 });
    expect(report.status).toBe("GHOST_FILL");
    expect(trade.status).toBe("GHOST_FILL");
    expect(trade.metadata?.signedTradeIntent).toBeTruthy();
  });
});

function sampleIntent(): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-001",
    traceId: "trace-001",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    action: "BUY",
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "GTC",
    intendedPrice: 100000,
    expectedPrice: 100000,
    requestedSize: 0.001,
    approvedSize: 0.001,
    probabilityWin: 0.52,
    probabilityLoss: 0.48,
    profit: 10,
    loss: 8,
    executionCosts: 0.1,
    adverseSelectionCost: 0.05,
    expectedValue: 0.42,
    minEvThreshold: 0,
    maxSlippageBps: 2,
    confidence: 0.71,
    rationale: "citadel test",
    createdAt: "2026-05-16T00:00:00.000Z"
  };
}

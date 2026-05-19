import { describe, expect, it } from "vitest";
import { defaultLiquidationHeatmapState } from "../../src/agents/HeatmapAgent";
import {
  cascadeDetectedAlertMetadata,
  cascadeDetectedLogMetadata,
  cascadeDetectedTelemetryPayload,
  liquidationEventProcessedCount,
  liquidationEventTelemetry,
  stateAfterLiquidationHeatmap
} from "../../src/engine/trading/cascade/CascadeLiquidationRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { CascadeAssetProfile } from "../../src/strategy/cascade/AssetProfiles";
import type { CascadeEvent } from "../../src/strategy/cascade/types";

const OBSERVED_AT = "2026-05-18T18:00:00.000Z";

describe("CascadeLiquidationRuntime", () => {
  it("updates engine state with a refreshed liquidation heatmap", () => {
    const currentState = defaultEngineState("cascade-liquidation");
    const heatmap = {
      ...defaultLiquidationHeatmapState("btc-usd", "hyperliquid", 100, 10_000_000, 0.005),
      totalEstimatedNotionalUsd: 25_000_000,
      updatedAt: OBSERVED_AT
    };

    expect(
      stateAfterLiquidationHeatmap({
        currentState,
        heatmap,
        observedAt: OBSERVED_AT
      })
    ).toMatchObject({
      liquidationHeatmap: heatmap,
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
  });

  it("builds compact liquidation telemetry and processed counts", () => {
    const heatmap = {
      ...defaultLiquidationHeatmapState("btc-usd", "hyperliquid", 100, 10_000_000, 0.005),
      clusters: [
        {
          clusterId: "cluster-1",
          instrumentCode: "btc-usd",
          side: "LONG" as const,
          forcedFlowSide: "SELL" as const,
          priceStart: 99,
          priceEnd: 101,
          centerPrice: 100,
          estimatedNotionalUsd: 12_000_000,
          distanceFromMidPct: 0.002,
          eventCount: 3,
          firstSeenAt: OBSERVED_AT,
          lastSeenAt: OBSERVED_AT
        }
      ],
      nearestCascade: null,
      totalEstimatedNotionalUsd: 12_000_000
    };

    expect(
      liquidationEventTelemetry({
        instrumentCode: "btc-usd",
        heatmap,
        cascadeEventCount: 2,
        observedAt: OBSERVED_AT
      })
    ).toEqual({
      instrumentCode: "btc-usd",
      clusterCount: 1,
      nearestCascade: null,
      totalEstimatedNotionalUsd: 12_000_000,
      cascadeEventCount: 2,
      observedAt: OBSERVED_AT
    });
    expect(
      liquidationEventProcessedCount({
        previousEventCount: 0,
        nextEventCount: 1,
        cascadeLiquidationCount: 0,
        cascadeEventCount: 0
      })
    ).toBe(1);
    expect(
      liquidationEventProcessedCount({
        previousEventCount: 10,
        nextEventCount: 10,
        cascadeLiquidationCount: 4,
        cascadeEventCount: 2
      })
    ).toBe(4);
  });

  it("builds cascade detected log, telemetry, and alert payloads", () => {
    const cascade = cascadeEvent();
    const profile: CascadeAssetProfile = {
      asset: "BTC",
      notionalThresholdUsd: 50_000_000,
      zScoreThreshold: 3,
      minPriceMoveAtr: 1.5,
      maxPositionNotionalPct: 0.25,
      assetLiquidityCapUsd: 25_000,
      maxSlippageBps: 8,
      rationale: "test profile"
    };

    expect(cascadeDetectedLogMetadata(cascade)).toEqual({
      eventType: "CASCADE_DETECTED",
      cascadeId: "cascade-1",
      instrumentCode: "btc-usd",
      direction: "LONG_LIQUIDATION",
      liquidationNotional: 50_000_000,
      liquidationCount: 5,
      zScore: 3.5,
      directionalPct: 0.9,
      priceMoveAtr: 2.1
    });
    expect(cascadeDetectedTelemetryPayload(cascade, profile)).toMatchObject({
      cascadeId: "cascade-1",
      assetProfile: profile,
      detectedAt: OBSERVED_AT
    });
    expect(cascadeDetectedAlertMetadata(cascade)).toEqual({
      cascadeId: "cascade-1",
      instrumentCode: "btc-usd",
      direction: "LONG_LIQUIDATION",
      liquidationNotional: 50_000_000,
      liquidationCount: 5,
      zScore: 3.5,
      priceMoveAtr: 2.1,
      detectedAt: OBSERVED_AT
    });
  });
});

function cascadeEvent(): CascadeEvent {
  return {
    schemaVersion: "cascade.event.v1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    detectedAt: OBSERVED_AT,
    windowStartAt: "2026-05-18T17:59:00.000Z",
    windowEndAt: OBSERVED_AT,
    liquidationNotional: 50_000_000,
    liquidationCount: 5,
    zScore: 3.5,
    priceAtStart: 100,
    priceAtPeak: 96,
    priceMoveAtr: 2.1,
    directionalPct: 0.9,
    rawEvents: []
  };
}

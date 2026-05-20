import { describe, expect, it } from "vitest";
import { defaultLiquidationHeatmapState } from "../../src/agents/HeatmapAgent";
import {
  buildCascadeDetectedArtifacts,
  cascadeLiquidationInsertStatements,
  cascadeDetectedAlertMetadata,
  cascadeDetectedLogMetadata,
  cascadeDetectedTelemetryPayload,
  liquidationHeatmapStorageWrites,
  liquidationEventProcessedCount,
  liquidationEventProcessingResult,
  liquidationEventTelemetry,
  persistCascadeLiquidationEvents,
  processLiquidationIngestRuntime,
  resolveLiquidationEventContext,
  stateAfterLiquidationHeatmap
} from "../../src/engine/trading/cascade/CascadeLiquidationRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { CascadeAssetProfile } from "../../src/strategy/cascade/AssetProfiles";
import type { CascadeEvent, LiquidationEvent } from "../../src/strategy/cascade/types";

const OBSERVED_AT = "2026-05-18T18:00:00.000Z";

describe("CascadeLiquidationRuntime", () => {
  it("resolves liquidation event context from ingest payload and engine defaults", () => {
    expect(
      resolveLiquidationEventContext({
        payload: {
          receivedAt: "2026-05-18T18:00:00.000Z",
          instrumentCode: "HYPE-USD",
          source_exchange: "HyperLiquid"
        },
        currentInstrumentCode: "btc-usd",
        defaultAsset: "ETH",
        midPrice: 25,
        fallbackObservedAt: "fallback"
      })
    ).toEqual({
      observedAt: "2026-05-18T18:00:00.000Z",
      instrumentCode: "hype-usd",
      sourceExchange: "hyperliquid",
      midPrice: 25
    });

    expect(
      resolveLiquidationEventContext({
        payload: { receivedAt: "invalid" },
        currentInstrumentCode: null,
        defaultAsset: "SOL",
        midPrice: null,
        fallbackObservedAt: OBSERVED_AT
      })
    ).toEqual({
      observedAt: OBSERVED_AT,
      instrumentCode: "sol-usd",
      sourceExchange: "hyperliquid",
      midPrice: null
    });
  });

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
    const currentState = defaultEngineState("cascade-liquidation-storage");
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
      liquidationHeatmapStorageWrites({
        engineStateKey: "engine",
        state: currentState,
        liquidationHeatmapKey: "heatmap",
        heatmap
      })
    ).toEqual({
      engine: currentState,
      heatmap
    });
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

  it("builds complete liquidation processing artifacts for the DO", () => {
    const currentState = defaultEngineState("cascade-liquidation-processing");
    const heatmap = {
      ...defaultLiquidationHeatmapState("btc-usd", "hyperliquid", 100, 10_000_000, 0.005),
      recentEvents: [
        {
          eventId: "liq-1",
          instrumentCode: "btc-usd",
          side: "LONG" as const,
          forcedFlowSide: "SELL" as const,
          price: 99,
          estimatedNotionalUsd: 12_000_000,
          baseSize: 1,
          observedAt: OBSERVED_AT
        }
      ],
      totalEstimatedNotionalUsd: 12_000_000
    };

    const result = liquidationEventProcessingResult({
      currentState,
      context: {
        observedAt: OBSERVED_AT,
        instrumentCode: "btc-usd",
        sourceExchange: "hyperliquid",
        midPrice: 100
      },
      heatmap,
      previousEventCount: 0,
      cascadeLiquidationCount: 2,
      cascadeEventCount: 1,
      engineStateKey: "engine",
      liquidationHeatmapKey: "heatmap"
    });

    expect(result.state).toMatchObject({
      liquidationHeatmap: heatmap,
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
    expect(result.storageWrites).toEqual({
      engine: result.state,
      heatmap
    });
    expect(result.shouldPublishTelemetry).toBe(true);
    expect(result.telemetryPayload).toMatchObject({
      instrumentCode: "btc-usd",
      cascadeEventCount: 1,
      totalEstimatedNotionalUsd: 12_000_000
    });
    expect(result.processedCount).toBe(2);
    expect(result.ingestResult).toEqual({
      accepted: true,
      status: "FRESH",
      processedCount: 2
    });
  });

  it("processes liquidation ingest side effects through domain handlers", () => {
    const currentState = defaultEngineState("cascade-liquidation-ingest");
    currentState.microstructure.instrumentCode = "btc-usd";
    const event = liquidationEvent();
    const cascade = cascadeEvent();
    const heatmap = {
      ...defaultLiquidationHeatmapState("btc-usd", "hyperliquid", 100, 10_000_000, 0.005),
      recentEvents: [
        {
          eventId: "heat-1",
          instrumentCode: "btc-usd",
          side: "LONG" as const,
          forcedFlowSide: "SELL" as const,
          price: 99,
          estimatedNotionalUsd: 12_000_000,
          baseSize: 1,
          observedAt: OBSERVED_AT
        }
      ],
      totalEstimatedNotionalUsd: 12_000_000
    };
    const scheduledJournals: LiquidationEvent[][] = [];
    const scheduledWrites: Record<string, unknown>[] = [];
    const published: { type: string; payload: Record<string, unknown> }[] = [];

    const result = processLiquidationIngestRuntime({
      raw: { channel: "userEvents" },
      payload: {
        receivedAt: OBSERVED_AT,
        instrumentCode: "BTC-USD",
        source_exchange: "hyperliquid"
      },
      currentState,
      currentInstrumentCode: currentState.microstructure.instrumentCode,
      defaultAsset: "BTC",
      midPrice: 100,
      engineStateKey: "engine",
      liquidationHeatmapKey: "heatmap",
      handlers: {
        recordHeatmap(raw, context) {
          expect(raw).toEqual({ channel: "userEvents" });
          expect(context).toMatchObject({
            instrumentCode: "btc-usd",
            observedAt: OBSERVED_AT
          });
          return heatmap;
        },
        ingestCascadeLiquidations(raw, context) {
          expect(raw).toEqual({ channel: "userEvents" });
          expect(context.midPrice).toBe(100);
          return [event];
        },
        recordCascadeLiquidations(events, observedAt) {
          expect(events).toEqual([event]);
          expect(observedAt).toBe(OBSERVED_AT);
          return [cascade];
        },
        scheduleCascadeLiquidationJournal(events) {
          scheduledJournals.push(events);
        },
        scheduleStorageWrites(storageWrites) {
          scheduledWrites.push(storageWrites);
        },
        publish(type, payload) {
          published.push({ type, payload });
        }
      }
    });

    expect(result.ingestResult).toEqual({
      accepted: true,
      status: "FRESH",
      processedCount: 1
    });
    expect(result.state.liquidationHeatmap).toBe(heatmap);
    expect(scheduledJournals).toEqual([[event]]);
    expect(scheduledWrites).toHaveLength(1);
    expect(scheduledWrites[0]).toMatchObject({ heatmap });
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("LIQUIDATION_EVENT");
    expect(published[0]?.payload).toMatchObject({
      instrumentCode: "btc-usd",
      cascadeEventCount: 1
    });
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
    expect(buildCascadeDetectedArtifacts(cascade, profile)).toEqual({
      logMetadata: cascadeDetectedLogMetadata(cascade),
      telemetryPayload: cascadeDetectedTelemetryPayload(cascade, profile),
      alertMetadata: cascadeDetectedAlertMetadata(cascade)
    });
  });

  it("builds and persists cascade liquidation journal statements", async () => {
    const db = mockCascadeDb();
    const event = liquidationEvent();
    const statements = cascadeLiquidationInsertStatements(db, [event]);

    expect(statements).toHaveLength(1);
    expect(db.queries[0]).toContain("INSERT OR REPLACE INTO cascade_liquidations");
    expect(db.binds[0]).toEqual([
      "liq-1",
      "btc-usd",
      "hyperliquid",
      "LONG",
      "SELL",
      96,
      12_000_000,
      125,
      "2026-05-18T17:59:59.000Z",
      OBSERVED_AT,
      JSON.stringify({ source: "test" })
    ]);

    await persistCascadeLiquidationEvents(db, [event]);
    await persistCascadeLiquidationEvents(db, []);

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(1);
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

function liquidationEvent(): LiquidationEvent {
  return {
    schemaVersion: "cascade.liquidation-event.v1",
    eventId: "liq-1",
    instrumentCode: "btc-usd",
    sourceExchange: "hyperliquid",
    side: "LONG",
    forcedFlowSide: "SELL",
    price: 96,
    notionalUsd: 12_000_000,
    baseSize: 125,
    exchangeTimestamp: "2026-05-18T17:59:59.000Z",
    observedAt: OBSERVED_AT,
    raw: { source: "test" }
  };
}

function mockCascadeDb(): {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  queries: string[];
  binds: unknown[][];
  batches: D1PreparedStatement[][];
} {
  const queries: string[] = [];
  const binds: unknown[][] = [];
  const batches: D1PreparedStatement[][] = [];

  return {
    queries,
    binds,
    batches,
    prepare(query: string): D1PreparedStatement {
      queries.push(query);
      return {
        bind(...values: unknown[]) {
          binds.push(values);
          return this as D1PreparedStatement;
        }
      } as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      batches.push(statements);
      return [];
    }
  };
}

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
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
  persistCascadeLiquidationEventsSafely,
  handleTradingEngineLiquidationEvents,
  processLiquidationIngestRuntime,
  processTradingLiquidationIngestRuntime,
  recordCascadeLiquidationDetections,
  recordTradingEngineCascadeLiquidations,
  recordTradingCascadeLiquidationDetections,
  resolveLiquidationEventContext,
  stateAfterLiquidationHeatmap,
  type TradingCascadeLiquidationDetectionTarget,
  type TradingLiquidationIngestTarget
} from "../../src/engine/trading/cascade/CascadeLiquidationRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import { defaultAbsorptionAnalyzerConfig } from "../../src/strategy/cascade/AbsorptionAnalyzer";
import type { CascadeAssetProfile } from "../../src/strategy/cascade/AssetProfiles";
import { defaultCascadeDetectorConfig } from "../../src/strategy/cascade/CascadeDetector";
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

  it("applies trading liquidation ingest state through the engine adapter", () => {
    const currentState = defaultEngineState("liquidation-trading-ingest");
    currentState.microstructure = {
      ...currentState.microstructure,
      instrumentCode: "btc-usd",
      midPrice: 100
    };
    const heatmap = {
      ...defaultLiquidationHeatmapState("btc-usd", "hyperliquid"),
      updatedAt: OBSERVED_AT,
      recentEvents: [liquidationEvent()]
    };
    const appliedStates: string[] = [];
    const scheduledWrites: Record<string, unknown>[] = [];

    const result = processTradingLiquidationIngestRuntime(
      {
        raw: { channel: "userEvents" },
        payload: {
          receivedAt: OBSERVED_AT,
          instrumentCode: "BTC-USD",
          source_exchange: "hyperliquid"
        },
        currentState,
        defaultAsset: "BTC"
      },
      {
        recordHeatmap() {
          return heatmap;
        },
        ingestCascadeLiquidations() {
          return [];
        },
        recordCascadeLiquidations() {
          return [];
        },
        scheduleCascadeLiquidationJournal() {
          throw new Error("journal should not run without liquidation events");
        },
        scheduleStorageWrites(storageWrites) {
          scheduledWrites.push(storageWrites);
        },
        publish() {
          // no-op
        },
        applyState(state) {
          appliedStates.push(state.updatedAt);
        }
      }
    );

    expect(result).toMatchObject({ accepted: true, status: "FRESH", processedCount: 1 });
    expect(appliedStates).toEqual([OBSERVED_AT]);
    expect(scheduledWrites[0]).toMatchObject({
      "engine:state": { engineId: "liquidation-trading-ingest" },
      "agent:heatmap:liquidations": heatmap
    });
  });

  it("routes liquidation events through the trading engine target adapter", async () => {
    const currentState = defaultEngineState("liquidation-target-ingest");
    currentState.microstructure = {
      ...currentState.microstructure,
      instrumentCode: "btc-usd",
      midPrice: 100
    };
    const event = liquidationEvent();
    const cascade = cascadeEvent();
    const heatmap = {
      ...defaultLiquidationHeatmapState("btc-usd", "hyperliquid"),
      updatedAt: OBSERVED_AT,
      recentEvents: [
        {
          eventId: "heat-1",
          instrumentCode: "btc-usd",
          side: "LONG" as const,
          forcedFlowSide: "SELL" as const,
          price: 96,
          estimatedNotionalUsd: 12_000_000,
          baseSize: 125,
          observedAt: OBSERVED_AT
        }
      ]
    };
    const db = mockCascadeDb();
    const pending: Promise<unknown>[] = [];
    const storageWrites: Record<string, unknown>[] = [];
    const published: string[] = [];
    const cascadesById = new Map<string, CascadeEvent>();
    const target: TradingLiquidationIngestTarget = {
      engineState: currentState,
      cachedConfig: {
        ...defaultConfig,
        CASCADE_INSTRUMENTS: "BTC"
      },
      env: {
        HL_ASSET: "BTC",
        TRADING_DB: db as unknown as D1Database,
        CASCADE_ATR_FALLBACK_USD: undefined,
        CASCADE_ATR_FALLBACK_PCT: undefined,
        CASCADE_MIN_BASELINE_WINDOWS: undefined,
        CASCADE_MIN_SEPARATION_MS: undefined,
        CASCADE_MAX_EVENTS_PER_INSTRUMENT: undefined,
        ABSORPTION_OI_STABILITY_BPS: undefined,
        ABSORPTION_MAX_ACTIVE_CASCADES: undefined
      },
      state: {
        waitUntil(work) {
          pending.push(work);
        }
      },
      heatmapAgent: {
        recordLiquidationEvent(raw, context) {
          expect(raw).toEqual({ channel: "userEvents" });
          expect(context.midPrice).toBe(100);
          return heatmap;
        }
      },
      cascadeLiquidationStream: {
        ingest(raw, context) {
          expect(raw).toEqual({ channel: "userEvents" });
          expect(context.fallbackPrice).toBe(100);
          return [event];
        }
      },
      absorptionAnalyzer: {
        configure() {
          published.push("configure-absorption");
        },
        trackCascade(observedCascade) {
          expect(observedCascade).toBe(cascade);
          published.push(`track:${observedCascade.cascadeId}`);
        }
      },
      cascadeDetector: {
        configure() {
          published.push("configure-detector");
        },
        observe(observedEvent, context) {
          expect(observedEvent).toBe(event);
          expect(context.observedAt).toBe(OBSERVED_AT);
          return cascade;
        }
      },
      cascadeEventsById: cascadesById,
      logger: {
        warn(eventType) {
          published.push(`log:${eventType}`);
        }
      },
      emitCascadeOperationalAlert(eventType) {
        published.push(`alert:${eventType}`);
      },
      async safeStoragePut(entries) {
        storageWrites.push(entries);
      },
      handleStorageWriteFailure(reason, error) {
        published.push(`${reason}:${String(error)}`);
      },
      publish(type) {
        published.push(type);
      }
    };

    const result = handleTradingEngineLiquidationEvents(
      { channel: "userEvents" },
      {
        receivedAt: OBSERVED_AT,
        instrumentCode: "BTC-USD",
        source_exchange: "hyperliquid"
      },
      target
    );

    await Promise.all(pending);

    expect(result).toMatchObject({ accepted: true, status: "FRESH", processedCount: 1 });
    expect(target.engineState.liquidationHeatmap).toBe(heatmap);
    expect(cascadesById.get("cascade-1")).toBe(cascade);
    expect(storageWrites[0]).toMatchObject({
      "engine:state": { engineId: "liquidation-target-ingest" },
      "agent:heatmap:liquidations": heatmap
    });
    expect(db.batches).toHaveLength(1);
    expect(published).toEqual([
      "configure-absorption",
      "configure-detector",
      "track:cascade-1",
      "log:CASCADE_DETECTED",
      "CASCADE_DETECTED",
      "alert:CASCADE_DETECTED",
      "LIQUIDATION_EVENT"
    ]);
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

  it("records cascade liquidation detections with configured side effects", () => {
    const event = liquidationEvent();
    const cascade = cascadeEvent();
    const calls: string[] = [];
    const published: Record<string, unknown>[] = [];
    const alerts: { cascadeId: string; metadata: Record<string, unknown> }[] = [];

    const detected = recordCascadeLiquidationDetections([event], OBSERVED_AT, {
      configureAbsorptionAnalyzer() {
        calls.push("configure-absorption");
      },
      isInstrumentEnabled(instrumentCode) {
        calls.push(`enabled:${instrumentCode}`);
        return true;
      },
      configureDetector(instrumentCode) {
        calls.push(`configure-detector:${instrumentCode}`);
      },
      observeCascade(observedEvent, observedAt) {
        calls.push(`observe:${observedEvent.eventId}:${observedAt}`);
        return cascade;
      },
      rememberCascade(observedCascade) {
        calls.push(`remember:${observedCascade.cascadeId}`);
      },
      trackCascadeAbsorption(observedCascade) {
        calls.push(`track:${observedCascade.cascadeId}`);
      },
      assetProfile() {
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
      },
      logDetected(metadata) {
        calls.push(`log:${metadata.cascadeId as string}`);
      },
      publishDetected(payload) {
        published.push(payload);
      },
      alertDetected(observedCascade, metadata) {
        alerts.push({ cascadeId: observedCascade.cascadeId, metadata });
      }
    });

    expect(detected).toEqual([cascade]);
    expect(calls).toEqual([
      "configure-absorption",
      "enabled:btc-usd",
      "configure-detector:btc-usd",
      `observe:liq-1:${OBSERVED_AT}`,
      "remember:cascade-1",
      "track:cascade-1",
      "log:cascade-1"
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      cascadeId: "cascade-1",
      instrumentCode: "btc-usd"
    });
    expect(published[0]?.assetProfile).toMatchObject({ asset: "BTC" });
    expect(alerts[0]).toMatchObject({
      cascadeId: "cascade-1",
      metadata: { cascadeId: "cascade-1", instrumentCode: "btc-usd" }
    });
  });

  it("records trading cascade liquidations with config gating and ATR fallback", () => {
    const event = liquidationEvent();
    const cascade = cascadeEvent();
    const calls: string[] = [];

    const detected = recordTradingCascadeLiquidationDetections(
      {
        events: [event],
        observedAt: OBSERVED_AT,
        config: { CASCADE_INSTRUMENTS: "BTC" },
        midPrice: 100,
        env: {
          CASCADE_ATR_FALLBACK_USD: "7.5",
          CASCADE_ATR_FALLBACK_PCT: undefined
        }
      },
      {
        configureAbsorptionAnalyzer() {
          calls.push("configure-absorption");
        },
        configureDetector(instrumentCode) {
          calls.push(`configure-detector:${instrumentCode}`);
        },
        observeCascade(observedEvent, observedAt, atr1h) {
          calls.push(`observe:${observedEvent.eventId}:${observedAt}:${String(atr1h)}`);
          return cascade;
        },
        rememberCascade(observedCascade) {
          calls.push(`remember:${observedCascade.cascadeId}`);
        },
        trackCascadeAbsorption(observedCascade) {
          calls.push(`track:${observedCascade.cascadeId}`);
        },
        assetProfile() {
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
        },
        logDetected(metadata) {
          calls.push(`log:${metadata.cascadeId as string}`);
        },
        publishDetected(payload) {
          calls.push(`publish:${payload.cascadeId as string}`);
        },
        alertDetected(observedCascade) {
          calls.push(`alert:${observedCascade.cascadeId}`);
        }
      }
    );

    expect(detected).toEqual([cascade]);
    expect(calls).toEqual([
      "configure-absorption",
      "configure-detector:btc-usd",
      `observe:liq-1:${OBSERVED_AT}:7.5`,
      "remember:cascade-1",
      "track:cascade-1",
      "log:cascade-1",
      "publish:cascade-1",
      "alert:cascade-1"
    ]);
  });

  it("records cascade detections through the trading engine target adapter", () => {
    const event = liquidationEvent();
    const cascade = cascadeEvent();
    const state = defaultEngineState("liquidation-detection-target");
    state.microstructure = { ...state.microstructure, midPrice: 100 };
    const cascadesById = new Map<string, CascadeEvent>();
    const calls: string[] = [];
    const target: TradingCascadeLiquidationDetectionTarget = {
      cachedConfig: { CASCADE_INSTRUMENTS: "BTC" },
      engineState: state,
      env: {
        CASCADE_ATR_FALLBACK_USD: "7.5",
        CASCADE_ATR_FALLBACK_PCT: undefined
      },
      absorptionAnalyzer: {
        configure() {
          calls.push("configure-absorption");
        },
        trackCascade(observedCascade) {
          calls.push(`track:${observedCascade.cascadeId}`);
        }
      },
      cascadeDetector: {
        configure() {
          calls.push("configure-detector");
        },
        observe(observedEvent, context) {
          calls.push(`observe:${observedEvent.eventId}:${String(context.atr1h)}`);
          return cascade;
        }
      },
      cascadeEventsById: cascadesById,
      logger: {
        warn(eventType, _message, metadata) {
          calls.push(`log:${eventType}:${String(metadata?.cascadeId)}`);
        }
      },
      currentAbsorptionAnalyzerConfig() {
        return defaultAbsorptionAnalyzerConfig;
      },
      currentCascadeDetectorConfig() {
        return defaultCascadeDetectorConfig;
      },
      cascadeAssetProfile() {
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
      },
      publish(type, payload) {
        calls.push(`publish:${type}:${String(payload.cascadeId)}`);
      },
      emitCascadeOperationalAlert(_eventType, _title, _message, _metadata, dedupeKey) {
        calls.push(`alert:${dedupeKey}`);
      }
    };

    const detected = recordTradingEngineCascadeLiquidations([event], OBSERVED_AT, target);

    expect(detected).toEqual([cascade]);
    expect(cascadesById.get("cascade-1")).toBe(cascade);
    expect(calls).toEqual([
      "configure-absorption",
      "configure-detector",
      "observe:liq-1:7.5",
      "track:cascade-1",
      "log:CASCADE_DETECTED:cascade-1",
      "publish:CASCADE_DETECTED:cascade-1",
      "alert:cascade-1"
    ]);
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

  it("captures cascade liquidation journal failures without throwing", async () => {
    const errors: string[] = [];
    const prepareDb = mockCascadeDb();
    const db = {
      prepare(query: string): D1PreparedStatement {
        return prepareDb.prepare(query);
      },
      async batch(): Promise<D1Result[]> {
        throw new Error("d1 unavailable");
      }
    };

    await persistCascadeLiquidationEventsSafely(db, [liquidationEvent()], {
      handleFailure(reason, error) {
        errors.push(`${reason}:${error instanceof Error ? error.message : "unknown"}`);
      }
    });

    expect(errors).toEqual(["CASCADE_LIQUIDATION_JOURNAL:d1 unavailable"]);
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

import { nativeIso, normalizeSourceExchange } from "../helpers/NativeHyperliquidRuntime";
import type { EngineState, JsonRecord, LiquidationHeatmapState } from "../../../types";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type { CascadeEvent, LiquidationEvent } from "../../../strategy/cascade/types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";

export interface LiquidationEventContextInput {
  readonly payload: {
    readonly receivedAt?: string;
    readonly instrumentCode?: string;
    readonly source_exchange?: string;
  };
  readonly currentInstrumentCode: string | null | undefined;
  readonly defaultAsset: string | undefined;
  readonly midPrice: number | null;
  readonly fallbackObservedAt?: string;
}

export interface LiquidationEventContext {
  readonly observedAt: string;
  readonly instrumentCode: string;
  readonly sourceExchange: string;
  readonly midPrice: number | null;
}

export interface LiquidationHeatmapStateInput {
  readonly currentState: EngineState;
  readonly heatmap: LiquidationHeatmapState;
  readonly observedAt: string;
}

export interface LiquidationEventTelemetryInput {
  readonly instrumentCode: string;
  readonly heatmap: LiquidationHeatmapState;
  readonly cascadeEventCount: number;
  readonly observedAt: string;
}

export interface LiquidationEventProcessedCountInput {
  readonly previousEventCount: number;
  readonly nextEventCount: number;
  readonly cascadeLiquidationCount: number;
  readonly cascadeEventCount: number;
}

export interface LiquidationHeatmapStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly liquidationHeatmapKey: string;
  readonly heatmap: LiquidationHeatmapState;
}

export interface LiquidationEventProcessingInput {
  readonly currentState: EngineState;
  readonly context: LiquidationEventContext;
  readonly heatmap: LiquidationHeatmapState;
  readonly previousEventCount: number;
  readonly cascadeLiquidationCount: number;
  readonly cascadeEventCount: number;
  readonly engineStateKey: string;
  readonly liquidationHeatmapKey: string;
}

export interface LiquidationEventProcessingResult {
  readonly state: EngineState;
  readonly storageWrites: Record<string, unknown>;
  readonly shouldPublishTelemetry: boolean;
  readonly telemetryPayload: JsonRecord;
  readonly processedCount: number;
  readonly ingestResult: TickIngestResult;
}

export interface LiquidationIngestSideEffectHandlers {
  readonly recordHeatmap: (
    raw: Record<string, unknown>,
    context: LiquidationEventContext
  ) => LiquidationHeatmapState;
  readonly ingestCascadeLiquidations: (
    raw: Record<string, unknown>,
    context: LiquidationEventContext
  ) => LiquidationEvent[];
  readonly recordCascadeLiquidations: (
    events: LiquidationEvent[],
    observedAt: string
  ) => CascadeEvent[];
  readonly scheduleCascadeLiquidationJournal: (events: LiquidationEvent[]) => void;
  readonly scheduleStorageWrites: (storageWrites: Record<string, unknown>) => void;
  readonly publish: (type: "LIQUIDATION_EVENT", payload: JsonRecord) => void;
}

export interface LiquidationIngestRuntimeInput {
  readonly raw: Record<string, unknown>;
  readonly payload: {
    readonly receivedAt?: string;
    readonly instrumentCode?: string;
    readonly source_exchange?: string;
  };
  readonly currentState: EngineState;
  readonly currentInstrumentCode: string | null | undefined;
  readonly defaultAsset: string | undefined;
  readonly midPrice: number | null;
  readonly engineStateKey: string;
  readonly liquidationHeatmapKey: string;
  readonly handlers: LiquidationIngestSideEffectHandlers;
}

export interface LiquidationIngestRuntimeResult {
  readonly state: EngineState;
  readonly ingestResult: TickIngestResult;
}

export interface CascadeLiquidationDetectionHandlers {
  readonly configureAbsorptionAnalyzer: () => void;
  readonly isInstrumentEnabled: (instrumentCode: string) => boolean;
  readonly configureDetector: (instrumentCode: string) => void;
  readonly observeCascade: (event: LiquidationEvent, observedAt: string) => CascadeEvent | null;
  readonly rememberCascade: (cascade: CascadeEvent) => void;
  readonly trackCascadeAbsorption: (cascade: CascadeEvent) => void;
  readonly assetProfile: (instrumentCode: string) => CascadeAssetProfile;
  readonly logDetected: (metadata: JsonRecord) => void;
  readonly publishDetected: (payload: JsonRecord) => void;
  readonly alertDetected: (cascade: CascadeEvent, metadata: JsonRecord) => void;
}

export interface CascadeDetectedArtifacts {
  readonly logMetadata: JsonRecord;
  readonly telemetryPayload: JsonRecord;
  readonly alertMetadata: JsonRecord;
}

export interface CascadeLiquidationJournalDb {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export function resolveLiquidationEventContext(
  input: LiquidationEventContextInput
): LiquidationEventContext {
  const observedAt =
    nativeIso(input.payload.receivedAt) ?? input.fallbackObservedAt ?? new Date().toISOString();
  const defaultAsset = input.defaultAsset ?? "BTC";

  return {
    observedAt,
    instrumentCode:
      input.payload.instrumentCode?.toLowerCase() ??
      input.currentInstrumentCode ??
      `${defaultAsset.toLowerCase()}-usd`,
    sourceExchange: normalizeSourceExchange(input.payload.source_exchange ?? "hyperliquid"),
    midPrice: input.midPrice
  };
}

export function stateAfterLiquidationHeatmap(input: LiquidationHeatmapStateInput): EngineState {
  return {
    ...input.currentState,
    liquidationHeatmap: input.heatmap,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

export function liquidationHeatmapStorageWrites(
  input: LiquidationHeatmapStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [input.liquidationHeatmapKey]: input.heatmap
  };
}

export function liquidationEventTelemetry(input: LiquidationEventTelemetryInput): JsonRecord {
  return {
    instrumentCode: input.instrumentCode,
    clusterCount: input.heatmap.clusters.length,
    nearestCascade: input.heatmap.nearestCascade
      ? (input.heatmap.nearestCascade as unknown as JsonRecord)
      : null,
    totalEstimatedNotionalUsd: input.heatmap.totalEstimatedNotionalUsd,
    cascadeEventCount: input.cascadeEventCount,
    observedAt: input.observedAt
  };
}

export function liquidationEventProcessedCount(input: LiquidationEventProcessedCountInput): number {
  return Math.max(
    input.nextEventCount > input.previousEventCount ? 1 : 0,
    input.cascadeLiquidationCount,
    input.cascadeEventCount
  );
}

export function liquidationEventProcessingResult(
  input: LiquidationEventProcessingInput
): LiquidationEventProcessingResult {
  const nextEventCount = input.heatmap.recentEvents.length;
  const processedCount = liquidationEventProcessedCount({
    previousEventCount: input.previousEventCount,
    nextEventCount,
    cascadeLiquidationCount: input.cascadeLiquidationCount,
    cascadeEventCount: input.cascadeEventCount
  });
  const state = stateAfterLiquidationHeatmap({
    currentState: input.currentState,
    heatmap: input.heatmap,
    observedAt: input.context.observedAt
  });

  return {
    state,
    storageWrites: liquidationHeatmapStorageWrites({
      engineStateKey: input.engineStateKey,
      state,
      liquidationHeatmapKey: input.liquidationHeatmapKey,
      heatmap: input.heatmap
    }),
    shouldPublishTelemetry: nextEventCount > input.previousEventCount,
    telemetryPayload: liquidationEventTelemetry({
      instrumentCode: input.context.instrumentCode,
      heatmap: input.heatmap,
      cascadeEventCount: input.cascadeEventCount,
      observedAt: input.context.observedAt
    }),
    processedCount,
    ingestResult: {
      accepted: true,
      status: "FRESH",
      processedCount
    }
  };
}

export function processLiquidationIngestRuntime(
  input: LiquidationIngestRuntimeInput
): LiquidationIngestRuntimeResult {
  const context = resolveLiquidationEventContext({
    payload: input.payload,
    currentInstrumentCode: input.currentInstrumentCode,
    defaultAsset: input.defaultAsset,
    midPrice: input.midPrice
  });
  const previousEventCount = input.currentState.liquidationHeatmap.recentEvents.length;
  const heatmap = input.handlers.recordHeatmap(input.raw, context);
  const cascadeLiquidations = input.handlers.ingestCascadeLiquidations(input.raw, context);

  if (cascadeLiquidations.length > 0) {
    input.handlers.scheduleCascadeLiquidationJournal(cascadeLiquidations);
  }

  const cascadeEvents = input.handlers.recordCascadeLiquidations(
    cascadeLiquidations,
    context.observedAt
  );
  const processed = liquidationEventProcessingResult({
    currentState: input.currentState,
    context,
    heatmap,
    previousEventCount,
    cascadeLiquidationCount: cascadeLiquidations.length,
    cascadeEventCount: cascadeEvents.length,
    engineStateKey: input.engineStateKey,
    liquidationHeatmapKey: input.liquidationHeatmapKey
  });

  input.handlers.scheduleStorageWrites(processed.storageWrites);

  if (processed.shouldPublishTelemetry) {
    input.handlers.publish("LIQUIDATION_EVENT", processed.telemetryPayload);
  }

  return {
    state: processed.state,
    ingestResult: processed.ingestResult
  };
}

export function recordCascadeLiquidationDetections(
  events: readonly LiquidationEvent[],
  observedAt: string,
  handlers: CascadeLiquidationDetectionHandlers
): CascadeEvent[] {
  const cascades: CascadeEvent[] = [];
  handlers.configureAbsorptionAnalyzer();

  for (const event of events) {
    if (!handlers.isInstrumentEnabled(event.instrumentCode)) {
      continue;
    }

    handlers.configureDetector(event.instrumentCode);
    const cascade = handlers.observeCascade(event, observedAt);

    if (!cascade) {
      continue;
    }

    cascades.push(cascade);
    handlers.rememberCascade(cascade);
    handlers.trackCascadeAbsorption(cascade);

    const artifacts = buildCascadeDetectedArtifacts(
      cascade,
      handlers.assetProfile(cascade.instrumentCode)
    );
    handlers.logDetected(artifacts.logMetadata);
    handlers.publishDetected(artifacts.telemetryPayload);
    handlers.alertDetected(cascade, artifacts.alertMetadata);
  }

  return cascades;
}

export function cascadeLiquidationInsertStatements(
  db: CascadeLiquidationJournalDb,
  events: readonly LiquidationEvent[]
): D1PreparedStatement[] {
  return events.map((event) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO cascade_liquidations (
           event_id, instrument_code, source_exchange, side, forced_flow_side, price,
           notional_usd, base_size, exchange_timestamp, observed_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.instrumentCode,
        event.sourceExchange,
        event.side,
        event.forcedFlowSide,
        event.price,
        event.notionalUsd,
        event.baseSize,
        event.exchangeTimestamp,
        event.observedAt,
        JSON.stringify(event.raw)
      )
  );
}

export async function persistCascadeLiquidationEvents(
  db: CascadeLiquidationJournalDb,
  events: readonly LiquidationEvent[]
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await db.batch(cascadeLiquidationInsertStatements(db, events));
}

export function cascadeDetectedLogMetadata(cascade: CascadeEvent): JsonRecord {
  return {
    eventType: "CASCADE_DETECTED",
    cascadeId: cascade.cascadeId,
    instrumentCode: cascade.instrumentCode,
    direction: cascade.direction,
    liquidationNotional: cascade.liquidationNotional,
    liquidationCount: cascade.liquidationCount,
    zScore: cascade.zScore,
    directionalPct: cascade.directionalPct,
    priceMoveAtr: cascade.priceMoveAtr
  };
}

export function cascadeDetectedTelemetryPayload(
  cascade: CascadeEvent,
  assetProfile: CascadeAssetProfile
): JsonRecord {
  return {
    cascadeId: cascade.cascadeId,
    instrumentCode: cascade.instrumentCode,
    direction: cascade.direction,
    liquidationNotional: cascade.liquidationNotional,
    liquidationCount: cascade.liquidationCount,
    zScore: cascade.zScore,
    directionalPct: cascade.directionalPct,
    priceMoveAtr: cascade.priceMoveAtr,
    assetProfile: assetProfile as unknown as JsonRecord,
    detectedAt: cascade.detectedAt
  };
}

export function cascadeDetectedAlertMetadata(cascade: CascadeEvent): JsonRecord {
  return {
    cascadeId: cascade.cascadeId,
    instrumentCode: cascade.instrumentCode,
    direction: cascade.direction,
    liquidationNotional: cascade.liquidationNotional,
    liquidationCount: cascade.liquidationCount,
    zScore: cascade.zScore,
    priceMoveAtr: cascade.priceMoveAtr,
    detectedAt: cascade.detectedAt
  };
}

export function buildCascadeDetectedArtifacts(
  cascade: CascadeEvent,
  assetProfile: CascadeAssetProfile
): CascadeDetectedArtifacts {
  return {
    logMetadata: cascadeDetectedLogMetadata(cascade),
    telemetryPayload: cascadeDetectedTelemetryPayload(cascade, assetProfile),
    alertMetadata: cascadeDetectedAlertMetadata(cascade)
  };
}

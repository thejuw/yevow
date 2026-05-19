import { nativeIso, normalizeSourceExchange } from "../../../TradingEngineRuntimeHelpers";
import type { EngineState, JsonRecord, LiquidationHeatmapState } from "../../../types";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type { CascadeEvent, LiquidationEvent } from "../../../strategy/cascade/types";

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

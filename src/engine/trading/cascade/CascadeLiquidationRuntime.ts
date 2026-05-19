import type { EngineState, JsonRecord, LiquidationHeatmapState } from "../../../types";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type { CascadeEvent } from "../../../strategy/cascade/types";

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

export function stateAfterLiquidationHeatmap(input: LiquidationHeatmapStateInput): EngineState {
  return {
    ...input.currentState,
    liquidationHeatmap: input.heatmap,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
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

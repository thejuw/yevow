import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type { CascadeEvent } from "../../../strategy/cascade/types";
import type { JsonRecord } from "../../../types";

export interface CascadeDetectedArtifacts {
  readonly logMetadata: JsonRecord;
  readonly telemetryPayload: JsonRecord;
  readonly alertMetadata: JsonRecord;
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

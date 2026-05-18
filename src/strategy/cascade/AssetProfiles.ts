import type { JsonRecord } from "../../types";

export interface CascadeAssetProfile {
  asset: string;
  notionalThresholdUsd: number;
  zScoreThreshold: number;
  minPriceMoveAtr: number;
  maxPositionNotionalPct: number;
  assetLiquidityCapUsd: number;
  maxSlippageBps: number;
  rationale: string;
}

export type CascadeAssetProfileMap = Record<string, CascadeAssetProfile>;

const DEFAULT_PROFILES: CascadeAssetProfileMap = {
  BTC: {
    asset: "BTC",
    notionalThresholdUsd: 50_000_000,
    zScoreThreshold: 3,
    minPriceMoveAtr: 1.5,
    maxPositionNotionalPct: 0.25,
    assetLiquidityCapUsd: 25_000,
    maxSlippageBps: 8,
    rationale: "Deepest cascade venue; large absolute liquidation threshold."
  },
  ETH: {
    asset: "ETH",
    notionalThresholdUsd: 25_000_000,
    zScoreThreshold: 3,
    minPriceMoveAtr: 1.6,
    maxPositionNotionalPct: 0.18,
    assetLiquidityCapUsd: 15_000,
    maxSlippageBps: 9,
    rationale: "High-liquidity secondary major with lower notional shock floor than BTC."
  },
  SOL: {
    asset: "SOL",
    notionalThresholdUsd: 8_000_000,
    zScoreThreshold: 3.25,
    minPriceMoveAtr: 1.8,
    maxPositionNotionalPct: 0.12,
    assetLiquidityCapUsd: 7_500,
    maxSlippageBps: 12,
    rationale: "Higher beta, thinner liquidity; requires stronger ATR confirmation."
  },
  HYPE: {
    asset: "HYPE",
    notionalThresholdUsd: 2_500_000,
    zScoreThreshold: 3.5,
    minPriceMoveAtr: 2.25,
    maxPositionNotionalPct: 0.08,
    assetLiquidityCapUsd: 3_000,
    maxSlippageBps: 15,
    rationale:
      "Explicitly enabled but treated as small-cap/high-beta: lower notional trigger, stricter sizing, wider slippage guard."
  }
};

export function defaultCascadeAssetProfiles(): CascadeAssetProfileMap {
  return cloneProfiles(DEFAULT_PROFILES);
}

export function serializedDefaultCascadeAssetProfiles(): string {
  return JSON.stringify(defaultCascadeAssetProfiles());
}

export function resolveCascadeAssetProfile(
  instrumentCode: string,
  serializedProfiles: string | null | undefined,
  fallback?: Partial<CascadeAssetProfile>
): CascadeAssetProfile {
  const asset = assetFromInstrument(instrumentCode);
  const parsed = parseCascadeAssetProfiles(serializedProfiles);
  const base = parsed[asset] ?? DEFAULT_PROFILES[asset] ?? defaultProfileForUnknownAsset(asset);

  return sanitizeProfile({
    ...fallback,
    ...base,
    asset
  });
}

export function parseCascadeAssetProfiles(
  serializedProfiles: string | null | undefined
): CascadeAssetProfileMap {
  if (!serializedProfiles || serializedProfiles.trim() === "") {
    return defaultCascadeAssetProfiles();
  }

  try {
    const parsed: unknown = JSON.parse(serializedProfiles);
    if (!isRecord(parsed)) {
      return defaultCascadeAssetProfiles();
    }

    const profiles = defaultCascadeAssetProfiles();
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const asset = normalizeAsset(String(value.asset ?? key));
      if (!asset) {
        continue;
      }
      profiles[asset] = sanitizeProfile({
        ...(profiles[asset] ?? defaultProfileForUnknownAsset(asset)),
        ...value,
        asset
      });
    }
    return profiles;
  } catch {
    return defaultCascadeAssetProfiles();
  }
}

export function cascadeAssetProfilesToJsonRecord(
  serializedProfiles: string | null | undefined
): JsonRecord {
  const profiles = parseCascadeAssetProfiles(serializedProfiles);
  return Object.fromEntries(
    Object.entries(profiles).map(([asset, profile]) => [asset, { ...profile }])
  );
}

export function assetFromInstrument(instrumentCode: string): string {
  const normalized = normalizeAsset(instrumentCode);
  if (!normalized) {
    return "UNKNOWN";
  }

  const [asset] = normalized.split(/[-_/:\s]/u);
  return normalizeAsset(asset);
}

function sanitizeProfile(
  profile: Partial<CascadeAssetProfile> & { asset: string }
): CascadeAssetProfile {
  const fallback = DEFAULT_PROFILES[profile.asset] ?? defaultProfileForUnknownAsset(profile.asset);
  return {
    asset: normalizeAsset(profile.asset) || fallback.asset,
    notionalThresholdUsd: positiveNumber(
      profile.notionalThresholdUsd,
      fallback.notionalThresholdUsd
    ),
    zScoreThreshold: boundedNumber(profile.zScoreThreshold, 0, 20, fallback.zScoreThreshold),
    minPriceMoveAtr: boundedNumber(profile.minPriceMoveAtr, 0, 20, fallback.minPriceMoveAtr),
    maxPositionNotionalPct: boundedNumber(
      profile.maxPositionNotionalPct,
      0.0001,
      1,
      fallback.maxPositionNotionalPct
    ),
    assetLiquidityCapUsd: nonNegativeNumber(
      profile.assetLiquidityCapUsd,
      fallback.assetLiquidityCapUsd
    ),
    maxSlippageBps: positiveBoundedNumber(
      profile.maxSlippageBps,
      0.1,
      500,
      fallback.maxSlippageBps
    ),
    rationale:
      typeof profile.rationale === "string" && profile.rationale.trim()
        ? profile.rationale.trim().slice(0, 500)
        : fallback.rationale
  };
}

function defaultProfileForUnknownAsset(asset: string): CascadeAssetProfile {
  return {
    asset: normalizeAsset(asset) || "UNKNOWN",
    notionalThresholdUsd: DEFAULT_PROFILES.BTC.notionalThresholdUsd,
    zScoreThreshold: DEFAULT_PROFILES.BTC.zScoreThreshold,
    minPriceMoveAtr: DEFAULT_PROFILES.BTC.minPriceMoveAtr,
    maxPositionNotionalPct: DEFAULT_PROFILES.BTC.maxPositionNotionalPct,
    assetLiquidityCapUsd: DEFAULT_PROFILES.BTC.assetLiquidityCapUsd,
    maxSlippageBps: DEFAULT_PROFILES.BTC.maxSlippageBps,
    rationale: "Fallback profile for an operator-added asset."
  };
}

function cloneProfiles(profiles: CascadeAssetProfileMap): CascadeAssetProfileMap {
  return Object.fromEntries(
    Object.entries(profiles).map(([asset, profile]) => [asset, { ...profile }])
  );
}

function normalizeAsset(value: string): string {
  return value.trim().toUpperCase();
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function positiveBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

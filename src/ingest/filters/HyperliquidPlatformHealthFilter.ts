export interface HyperliquidPlatformSnapshot {
  observedAt: string;
  feeRateBps: number;
  feeRateBaselineBps: number;
  platformLiquidationVolume1h: number;
  platformLiquidationVolumeMean: number;
  platformLiquidationVolumeStddev: number;
  api5xxCount60s?: number;
  apiRequestCount60s?: number;
}

export interface PlatformHealthState {
  observedAt: string;
  feeRateBps: number;
  feeRateBaselineBps: number;
  platformLiquidationVolume1h: number;
  platformLiquidationVolumeMean: number;
  platformLiquidationVolumeStddev: number;
  zScore: number;
  feeRateRatio: number;
  api5xxRate: number;
  status: "HEALTHY" | "DEGRADED" | "HALTED";
  reasons: string[];
}

export class HyperliquidPlatformHealthFilter {
  evaluate(snapshot: HyperliquidPlatformSnapshot): PlatformHealthState {
    const feeRateBaselineBps = Math.max(snapshot.feeRateBaselineBps, 0);
    const feeRateRatio =
      feeRateBaselineBps > 0 ? snapshot.feeRateBps / feeRateBaselineBps : Number.POSITIVE_INFINITY;
    const zScore =
      snapshot.platformLiquidationVolumeStddev > 0
        ? (snapshot.platformLiquidationVolume1h - snapshot.platformLiquidationVolumeMean) /
          snapshot.platformLiquidationVolumeStddev
        : 0;
    const apiRequestCount60s = Math.max(0, snapshot.apiRequestCount60s ?? 0);
    const api5xxRate =
      apiRequestCount60s > 0 ? Math.max(0, snapshot.api5xxCount60s ?? 0) / apiRequestCount60s : 0;
    const reasons: string[] = [];

    if (feeRateRatio > 1.5) {
      reasons.push("FEE_RATE_ELEVATED");
    }

    if (feeRateRatio > 2) {
      reasons.push("FEE_RATE_HALTED");
    }

    if (zScore > 5) {
      reasons.push("PLATFORM_LIQUIDATION_ZSCORE_HALTED");
    }

    if (api5xxRate > 0.1) {
      reasons.push("HL_API_5XX_RATE_HALTED");
    }

    const halted = reasons.some((reason) => reason.endsWith("_HALTED"));

    return {
      observedAt: snapshot.observedAt,
      feeRateBps: snapshot.feeRateBps,
      feeRateBaselineBps,
      platformLiquidationVolume1h: snapshot.platformLiquidationVolume1h,
      platformLiquidationVolumeMean: snapshot.platformLiquidationVolumeMean,
      platformLiquidationVolumeStddev: snapshot.platformLiquidationVolumeStddev,
      zScore,
      feeRateRatio,
      api5xxRate,
      status: halted ? "HALTED" : reasons.length > 0 ? "DEGRADED" : "HEALTHY",
      reasons
    };
  }
}

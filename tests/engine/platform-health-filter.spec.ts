import { describe, expect, it } from "vitest";
import { HyperliquidPlatformHealthFilter } from "../../src/ingest/filters/HyperliquidPlatformHealthFilter";

describe("Hyperliquid platform health filter", () => {
  const filter = new HyperliquidPlatformHealthFilter();

  it("marks normal platform conditions healthy", () => {
    expect(filter.evaluate(snapshot()).status).toBe("HEALTHY");
  });

  it("marks fee rate above 1.5x baseline degraded", () => {
    const state = filter.evaluate(snapshot({ feeRateBps: 1.6 }));

    expect(state.status).toBe("DEGRADED");
    expect(state.reasons).toContain("FEE_RATE_ELEVATED");
  });

  it("marks fee rate above 2x baseline halted", () => {
    const state = filter.evaluate(snapshot({ feeRateBps: 2.1 }));

    expect(state.status).toBe("HALTED");
    expect(state.reasons).toContain("FEE_RATE_HALTED");
  });

  it("marks liquidation z-score above five halted", () => {
    const state = filter.evaluate(snapshot({ platformLiquidationVolume1h: 70 }));

    expect(state.status).toBe("HALTED");
    expect(state.reasons).toContain("PLATFORM_LIQUIDATION_ZSCORE_HALTED");
  });

  it("marks high API 5xx rate halted", () => {
    const state = filter.evaluate(snapshot({ api5xxCount60s: 11, apiRequestCount60s: 100 }));

    expect(state.status).toBe("HALTED");
    expect(state.reasons).toContain("HL_API_5XX_RATE_HALTED");
  });

  it("keeps exact fee threshold healthy", () => {
    expect(filter.evaluate(snapshot({ feeRateBps: 1.5 })).status).toBe("HEALTHY");
  });

  it("keeps exact liquidation threshold healthy", () => {
    expect(filter.evaluate(snapshot({ platformLiquidationVolume1h: 60 })).status).toBe("HEALTHY");
  });

  it("calculates fee ratios", () => {
    expect(filter.evaluate(snapshot({ feeRateBps: 1.25 })).feeRateRatio).toBe(1.25);
  });

  it("calculates zero API error rate when there are no requests", () => {
    expect(
      filter.evaluate(snapshot({ api5xxCount60s: 99, apiRequestCount60s: 0 })).api5xxRate
    ).toBe(0);
  });

  it("fails closed on missing fee baseline", () => {
    expect(filter.evaluate(snapshot({ feeRateBaselineBps: 0 })).status).toBe("HALTED");
  });
});

function snapshot(
  overrides: Partial<Parameters<HyperliquidPlatformHealthFilter["evaluate"]>[0]> = {}
): Parameters<HyperliquidPlatformHealthFilter["evaluate"]>[0] {
  return {
    observedAt: "2026-05-18T00:00:00.000Z",
    feeRateBps: 1,
    feeRateBaselineBps: 1,
    platformLiquidationVolume1h: 10,
    platformLiquidationVolumeMean: 10,
    platformLiquidationVolumeStddev: 10,
    api5xxCount60s: 0,
    apiRequestCount60s: 100,
    ...overrides
  };
}

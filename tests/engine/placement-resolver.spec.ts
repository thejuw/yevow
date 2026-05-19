import { describe, expect, it } from "vitest";
import {
  applyLocationRisk,
  defaultEngineLocation,
  locationChanged,
  locationTelemetry,
  parseColoSet,
  placementCode,
  placementColo,
  readTopologyHeaders,
  resolveEngineLocation,
  resolveRiskMultiplier
} from "../../src/engine/trading/helpers/PlacementResolver";
import type { RiskLimits } from "../../src/types";

const baseRisk: RiskLimits = {
  configVersion: "bootstrap",
  killSwitch: true,
  maxGrossExposure: 100,
  maxNetExposure: 50,
  maxOrderNotional: 10,
  maxDrawdownPct: 0.1,
  perAssetMaxPosition: { BTC: 1 },
  updatedAt: "2026-05-18T00:00:00.000Z"
};

describe("PlacementResolver", () => {
  it("normalizes placement and configured colo hints", () => {
    expect(placementColo({ placement: "remote-nrt", colo: "DFW" })).toBe("NRT");
    expect(placementColo({ placement: "local-hnd" })).toBe("HND");
    expect(placementColo({ placement: "edge", colo: "dfw" })).toBe("DFW");
    expect(placementColo(null)).toBe("UNKNOWN");
    expect(placementCode("remote-nrt")).toBe("NRT");
    expect(placementCode("not-a-placement")).toBeNull();
    expect([...parseColoSet("nrt,,unknown, hnd ")]).toEqual(["NRT", "HND"]);
  });

  it("reads topology headers with Cloudflare fallbacks", () => {
    const topology = readTopologyHeaders(
      new Request("https://engine.example/tick", {
        headers: {
          "cf-placement": "remote-nrt",
          "cf-ray": "ray-123",
          "x-sovereign-topology-colo": "HND",
          "x-sovereign-topology-country": "JP",
          "x-sovereign-topology-city": "Tokyo",
          "x-sovereign-topology-observed-at": "2026-05-18T01:00:00.000Z"
        }
      })
    );

    expect(topology).toMatchObject({
      colo: "HND",
      placement: "remote-nrt",
      country: "JP",
      city: "Tokyo",
      requestId: "ray-123",
      observedAt: "2026-05-18T01:00:00.000Z"
    });
  });

  it("fills missing topology with generated request metadata", () => {
    const topology = readTopologyHeaders(new Request("https://engine.example/health"));

    expect(topology.colo).toBeNull();
    expect(topology.placement).toBeNull();
    expect(topology.requestId).toEqual(expect.any(String));
    expect(topology.observedAt).toEqual(expect.any(String));
  });

  it("resolves unknown, target-assumed, golden, and non-golden locations", () => {
    const previous = defaultEngineLocation();
    const observedAt = "2026-05-18T02:00:00.000Z";

    expect(
      resolveEngineLocation(
        { ...previous, requestId: "req-1", observedAt },
        previous,
        {
          PLACEMENT_TARGET_COLO: undefined,
          GOLDEN_COLOS: undefined,
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: undefined
        },
        { GOLDEN_COLOS: "" },
        null
      )
    ).toMatchObject({ colo: null, isGoldenRegion: true, reason: "UNKNOWN_COLO" });

    expect(
      resolveEngineLocation(
        { ...previous, requestId: "req-2", observedAt },
        previous,
        {
          PLACEMENT_TARGET_COLO: "nrt",
          GOLDEN_COLOS: "NRT,HND",
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.4"
        },
        { GOLDEN_COLOS: "" },
        12
      )
    ).toMatchObject({
      colo: "NRT",
      isGoldenRegion: true,
      observedLatencyMs: 12,
      reason: "TARGET_COLO_ASSUMED"
    });

    expect(
      resolveEngineLocation(
        { ...previous, placement: "remote-hnd", requestId: "req-3", observedAt },
        previous,
        {
          PLACEMENT_TARGET_COLO: undefined,
          GOLDEN_COLOS: "NRT,HND",
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.4"
        },
        { GOLDEN_COLOS: "" },
        9
      )
    ).toMatchObject({ colo: "HND", isGoldenRegion: true, reason: "GOLDEN_REGION" });

    expect(
      resolveEngineLocation(
        { ...previous, colo: "DFW", requestId: "req-4", observedAt },
        previous,
        {
          PLACEMENT_TARGET_COLO: undefined,
          GOLDEN_COLOS: "NRT,HND",
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.4"
        },
        { GOLDEN_COLOS: "" },
        40
      )
    ).toMatchObject({
      colo: "DFW",
      isGoldenRegion: false,
      latencyRiskMultiplier: 0.4,
      positionSizeMultiplier: 0.4,
      reason: "NON_GOLDEN_REGION"
    });
  });

  it("applies location-aware risk and telemetry snapshots", () => {
    const location = {
      ...defaultEngineLocation(),
      colo: "DFW",
      placement: "remote-dfw",
      isGoldenRegion: false,
      latencyRiskMultiplier: 0.25,
      positionSizeMultiplier: 0.25,
      observedLatencyMs: 40,
      reason: "NON_GOLDEN_REGION" as const
    };

    expect(
      applyLocationRisk(
        baseRisk,
        {
          version: "risk-v2",
          TRADING_ENABLED: false,
          MAX_POSITION_SIZE: 123.456789,
          MAX_DRAWDOWN_PCT: 0.05
        },
        location,
        "2026-05-18T03:00:00.000Z"
      )
    ).toMatchObject({
      configVersion: "risk-v2",
      killSwitch: true,
      maxOrderNotional: 30.86419725,
      maxDrawdownPct: 0.05,
      updatedAt: "2026-05-18T03:00:00.000Z"
    });

    expect(locationTelemetry(location)).toMatchObject({
      colo: "DFW",
      placement: "remote-dfw",
      isGoldenRegion: false,
      observedLatencyMs: 40,
      reason: "NON_GOLDEN_REGION"
    });
  });

  it("detects location risk changes and validates multiplier bounds", () => {
    const current = defaultEngineLocation();

    expect(locationChanged(current, { ...current })).toBe(false);
    expect(locationChanged(current, { ...current, colo: "NRT" })).toBe(true);
    expect(locationChanged(current, { ...current, placement: "remote-nrt" })).toBe(true);
    expect(locationChanged(current, { ...current, isGoldenRegion: false })).toBe(true);
    expect(locationChanged(current, { ...current, latencyRiskMultiplier: 0.5 })).toBe(true);
    expect(locationChanged(current, { ...current, positionSizeMultiplier: 0.5 })).toBe(true);
    expect(resolveRiskMultiplier("0.333333")).toBe(0.3333);
    expect(resolveRiskMultiplier("0")).toBe(0.5);
    expect(resolveRiskMultiplier("2")).toBe(0.5);
    expect(resolveRiskMultiplier("not-a-number")).toBe(0.5);
  });
});

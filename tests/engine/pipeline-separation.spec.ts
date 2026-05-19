import { describe, expect, it } from "vitest";
import { CascadeRecoveryPipeline } from "../../src/engine/trading/pipelines/CascadeRecoveryPipeline";
import { MarketMakingPipeline } from "../../src/engine/trading/pipelines/MarketMakingPipeline";
import { evaluateSharedTickGate } from "../../src/engine/trading/pipelines/SharedTickGate";
import {
  configuredPlacementColoFromValue,
  configuredPlacementColo,
  isGoldenColo,
  parseColoSet,
  placementCode,
  placementColo
} from "../../src/engine/trading/helpers/PlacementResolver";

describe("trading pipeline separation", () => {
  it("keeps market-making and cascade counters independent", () => {
    const mm = new MarketMakingPipeline();
    const cascade = new CascadeRecoveryPipeline();
    const gate = { tradingEnabled: true, totalLatencyMs: 10, maxLatencyMs: 100, stale: false };

    expect(mm.handleTick(gate).processedTicks).toBe(1);
    expect(mm.handleTick(gate).processedTicks).toBe(2);
    expect(cascade.handleTick(gate).processedTicks).toBe(1);
  });

  it("applies shared kill-switch gate without mutating pipeline counters", () => {
    const mm = new MarketMakingPipeline();
    const rejected = mm.handleTick({
      tradingEnabled: false,
      totalLatencyMs: 10,
      maxLatencyMs: 100,
      stale: false
    });

    expect(rejected).toMatchObject({
      accepted: false,
      strategy: "MARKET_MAKING",
      processedTicks: 0,
      reason: "TRADING_DISABLED"
    });
  });

  it("rejects platform health halts before strategy logic", () => {
    expect(
      evaluateSharedTickGate({
        tradingEnabled: true,
        platformHealthHalted: true,
        totalLatencyMs: 1,
        maxLatencyMs: 100,
        stale: false
      })
    ).toEqual({ ok: false, reason: "PLATFORM_HEALTH_HALTED" });
  });

  it("rejects stale and over-latency ticks through the shared gate", () => {
    expect(
      evaluateSharedTickGate({
        tradingEnabled: true,
        totalLatencyMs: 1,
        maxLatencyMs: 100,
        stale: true
      })
    ).toEqual({ ok: false, reason: "STALE_TICK" });
    expect(
      evaluateSharedTickGate({
        tradingEnabled: true,
        totalLatencyMs: 101,
        maxLatencyMs: 100,
        stale: false
      })
    ).toEqual({ ok: false, reason: "LATENCY_LIMIT" });
  });

  it("keeps cascade rejects isolated from market-making counters", () => {
    const mm = new MarketMakingPipeline();
    const cascade = new CascadeRecoveryPipeline();
    const acceptedGate = {
      tradingEnabled: true,
      totalLatencyMs: 1,
      maxLatencyMs: 100,
      stale: false
    };

    mm.handleTick(acceptedGate);
    expect(
      cascade.handleTick({
        ...acceptedGate,
        stale: true
      })
    ).toMatchObject({ accepted: false, processedTicks: 0 });
    expect(mm.handleTick(acceptedGate).processedTicks).toBe(2);
  });

  it("normalizes placement colos and golden region hints", () => {
    expect(placementColo({ placement: "remote-nrt", colo: "DFW" })).toBe("NRT");
    expect(placementColo({ colo: "dfw" })).toBe("DFW");
    expect(placementColo(null)).toBe("UNKNOWN");
    expect(placementCode("local-hnd")).toBe("HND");
    expect(configuredPlacementColoFromValue("nrt")).toBe("NRT");
    expect(
      configuredPlacementColo({ PLACEMENT_TARGET_COLO: undefined, GOLDEN_COLOS: "nrt,hnd" })
    ).toBe("NRT");
    expect(isGoldenColo({ placement: "remote-nrt" }, { GOLDEN_COLOS: "NRT,HND" })).toBe(true);
    expect([...parseColoSet("nrt,,unknown")]).toEqual(["NRT"]);
  });
});

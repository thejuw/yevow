import { describe, expect, it } from "vitest";
import {
  applyLocationRisk,
  applyTopologyObservationSideEffects,
  applyTopologyWarmUpRuntime,
  buildTopologyObservationLogEvents,
  defaultEngineLocation,
  locationChanged,
  locationTelemetry,
  parseColoSet,
  placementCode,
  placementColo,
  readTopologyHeaders,
  resolveEngineLocation,
  resolveRiskMultiplier,
  scheduleTopologyWarmUpSideEffects,
  stateAfterLocationLatency,
  stateAfterTopologyObservation,
  topologyWarmUpDecision,
  type TopologyWarmUpRuntimeHandlers,
  type TopologyWarmUpSideEffectHandlers,
  type TopologyObservationSideEffectHandlers
} from "../../src/engine/trading/helpers/PlacementResolver";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { EdgeTopology, RiskLimits } from "../../src/types";

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

  it("applies topology observations to engine state and flags risk adjustment", () => {
    const state = defaultEngineState("placement-state");
    const result = stateAfterTopologyObservation({
      state,
      topology: {
        colo: "DFW",
        placement: "remote-dfw",
        country: null,
        city: null,
        region: null,
        timezone: null,
        latitude: null,
        longitude: null,
        requestId: "req-1",
        observedAt: "2026-05-18T04:00:00.000Z"
      },
      env: {
        PLACEMENT_TARGET_COLO: undefined,
        GOLDEN_COLOS: "NRT,HND",
        HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.25"
      },
      config: {
        version: "risk-v3",
        TRADING_ENABLED: true,
        MAX_POSITION_SIZE: 100,
        MAX_DRAWDOWN_PCT: 0.05,
        GOLDEN_COLOS: "NRT,HND"
      }
    });

    expect(result.changed).toBe(true);
    expect(result.placementChanged).toBe(true);
    expect(result.riskAdjustedForNonGoldenRegion).toBe(true);
    expect(result.state).toMatchObject({
      updatedAt: "2026-05-18T04:00:00.000Z",
      location: {
        colo: "DFW",
        placement: "remote-dfw",
        isGoldenRegion: false,
        positionSizeMultiplier: 0.25
      },
      risk: {
        configVersion: "risk-v3",
        killSwitch: false,
        maxOrderNotional: 25,
        maxDrawdownPct: 0.05,
        updatedAt: "2026-05-18T04:00:00.000Z"
      }
    });

    const logEvents = buildTopologyObservationLogEvents({
      observation: result,
      maxOrderNotional: result.state.risk.maxOrderNotional,
      baseMaxPositionSize: 100
    });

    expect(logEvents).toHaveLength(2);
    expect(logEvents[0]).toMatchObject({
      eventType: "COLO_TOPOLOGY_CHANGED",
      message: "Trading engine observed a Cloudflare placement change",
      metadata: {
        colo: "DFW",
        placement: "remote-dfw",
        isGoldenRegion: false,
        positionSizeMultiplier: 0.25
      }
    });
    expect(logEvents[1]).toMatchObject({
      eventType: "PIT_BOSS_RISK_ADJUSTED",
      message: "Pit Boss reduced max order notional for execution-location risk",
      metadata: {
        colo: "DFW",
        maxOrderNotional: 25,
        baseMaxPositionSize: 100
      }
    });
  });

  it("applies topology side effects and only persists changed observations", () => {
    const state = defaultEngineState("placement-side-effects");
    const changedObservation = stateAfterTopologyObservation({
      state,
      topology: {
        colo: "DFW",
        placement: "remote-dfw",
        country: null,
        city: null,
        region: null,
        timezone: null,
        latitude: null,
        longitude: null,
        requestId: "req-1",
        observedAt: "2026-05-18T04:00:00.000Z"
      },
      env: {
        PLACEMENT_TARGET_COLO: undefined,
        GOLDEN_COLOS: "NRT",
        HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.25"
      },
      config: {
        version: "risk-v3",
        TRADING_ENABLED: true,
        MAX_POSITION_SIZE: 100,
        MAX_DRAWDOWN_PCT: 0.05,
        GOLDEN_COLOS: "NRT"
      }
    });
    const changedSideEffects = topologySideEffectSpy();

    applyTopologyObservationSideEffects(
      {
        observation: changedObservation,
        maxOrderNotional: changedObservation.state.risk.maxOrderNotional,
        baseMaxPositionSize: 100
      },
      changedSideEffects.handlers
    );

    expect(changedSideEffects.events).toEqual([
      "state:DFW",
      "persist",
      "warn:COLO_TOPOLOGY_CHANGED",
      "warn:PIT_BOSS_RISK_ADJUSTED"
    ]);

    const unchangedObservation = stateAfterTopologyObservation({
      state: changedObservation.state,
      topology: {
        colo: "DFW",
        placement: "remote-dfw",
        country: null,
        city: null,
        region: null,
        timezone: null,
        latitude: null,
        longitude: null,
        requestId: "req-2",
        observedAt: "2026-05-18T04:00:01.000Z"
      },
      env: {
        PLACEMENT_TARGET_COLO: undefined,
        GOLDEN_COLOS: "NRT",
        HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.25"
      },
      config: {
        version: "risk-v3",
        TRADING_ENABLED: true,
        MAX_POSITION_SIZE: 100,
        MAX_DRAWDOWN_PCT: 0.05,
        GOLDEN_COLOS: "NRT"
      }
    });
    const unchangedSideEffects = topologySideEffectSpy();

    applyTopologyObservationSideEffects(
      {
        observation: unchangedObservation,
        maxOrderNotional: unchangedObservation.state.risk.maxOrderNotional,
        baseMaxPositionSize: 100
      },
      unchangedSideEffects.handlers
    );

    expect(unchangedSideEffects.events).toEqual(["state:DFW"]);
  });

  it("decides and schedules topology warm-up side effects", async () => {
    const topology = edgeTopology({ colo: "NRT", placement: "remote-nrt" });
    const skipped = topologyWarmUpDecision({
      topology,
      warmedColo: "NRT",
      warmedAt: 1_000,
      intervalMs: 5_000,
      nowMs: 2_000
    });
    const scheduled = topologyWarmUpDecision({
      topology,
      warmedColo: "DFW",
      warmedAt: 1_000,
      intervalMs: 5_000,
      nowMs: 2_000
    });

    expect(skipped).toEqual({ shouldWarmUp: false, colo: "NRT", warmedAt: 2_000 });
    expect(scheduled).toEqual({ shouldWarmUp: true, colo: "NRT", warmedAt: 2_000 });

    const skippedSideEffects = topologyWarmUpSideEffectSpy();
    scheduleTopologyWarmUpSideEffects({ topology, decision: skipped }, skippedSideEffects.handlers);
    expect(skippedSideEffects.events).toEqual([]);

    const scheduledSideEffects = topologyWarmUpSideEffectSpy();
    scheduleTopologyWarmUpSideEffects(
      { topology, decision: scheduled },
      scheduledSideEffects.handlers
    );
    expect(scheduledSideEffects.events).toEqual(["read", "config", "schedule"]);

    await Promise.all(scheduledSideEffects.scheduled);

    expect(scheduledSideEffects.events).toEqual([
      "read",
      "config",
      "schedule",
      "info:ENGINE_WARMUP:NRT"
    ]);
  });

  it("applies topology warm-up runtime state marking before scheduling probes", async () => {
    const sideEffects = topologyWarmUpRuntimeSpy();
    const topology = edgeTopology({ colo: "NRT", placement: "remote-nrt" });

    const skipped = applyTopologyWarmUpRuntime(
      {
        topology,
        warmedColo: "NRT",
        warmedAt: 1_000,
        intervalMs: 5_000,
        nowMs: 2_000
      },
      sideEffects.handlers
    );
    const scheduled = applyTopologyWarmUpRuntime(
      {
        topology,
        warmedColo: "DFW",
        warmedAt: 1_000,
        intervalMs: 5_000,
        nowMs: 2_000
      },
      sideEffects.handlers
    );

    expect(skipped.shouldWarmUp).toBe(false);
    expect(scheduled.shouldWarmUp).toBe(true);
    expect(sideEffects.events).toEqual(["mark:NRT:2000", "read", "config", "schedule"]);

    await Promise.all(sideEffects.scheduled);
    expect(sideEffects.events).toEqual([
      "mark:NRT:2000",
      "read",
      "config",
      "schedule",
      "info:ENGINE_WARMUP:NRT"
    ]);
  });

  it("updates observed location latency without changing the placement identity", () => {
    const state = defaultEngineState("placement-latency");
    state.location = {
      ...state.location,
      colo: "NRT",
      placement: "remote-nrt",
      isGoldenRegion: true,
      positionSizeMultiplier: 1,
      latencyRiskMultiplier: 1
    };

    const result = stateAfterLocationLatency({
      state,
      totalLatencyMs: 12.34567,
      observedAt: "2026-05-18T05:00:00.000Z",
      config: {
        version: "risk-v4",
        TRADING_ENABLED: false,
        MAX_POSITION_SIZE: 50,
        MAX_DRAWDOWN_PCT: 0.04
      }
    });

    expect(result.location).toMatchObject({
      colo: "NRT",
      placement: "remote-nrt",
      observedLatencyMs: 12.346,
      lastSeenAt: "2026-05-18T05:00:00.000Z"
    });
    expect(result.risk).toMatchObject({
      configVersion: "risk-v4",
      killSwitch: true,
      maxOrderNotional: 50,
      maxDrawdownPct: 0.04
    });
  });
});

function topologyWarmUpSideEffectSpy(): {
  events: string[];
  scheduled: Promise<void>[];
  handlers: TopologyWarmUpSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<void>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      readEngineState() {
        events.push("read");
        return Promise.resolve({ ok: true });
      },
      fetchConfig() {
        events.push("config");
        return Promise.resolve({ ok: true });
      },
      info(eventType, _message, metadata) {
        events.push(`info:${eventType}:${metadata.colo}`);
      },
      error(eventType, _message, metadata) {
        events.push(`error:${eventType}:${metadata.message}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      }
    }
  };
}

function topologyWarmUpRuntimeSpy(): {
  events: string[];
  scheduled: Promise<void>[];
  handlers: TopologyWarmUpRuntimeHandlers;
} {
  const base = topologyWarmUpSideEffectSpy();

  return {
    ...base,
    handlers: {
      ...base.handlers,
      markWarmUp(colo, warmedAtMs) {
        base.events.push(`mark:${colo}:${warmedAtMs}`);
      }
    }
  };
}

function edgeTopology(overrides: Partial<EdgeTopology> = {}): EdgeTopology {
  return {
    colo: "NRT",
    placement: "remote-nrt",
    country: null,
    city: null,
    region: null,
    timezone: null,
    latitude: null,
    longitude: null,
    requestId: "req-1",
    observedAt: "2026-05-18T04:00:00.000Z",
    ...overrides
  };
}

function topologySideEffectSpy(): {
  events: string[];
  handlers: TopologyObservationSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyState(state) {
        events.push(`state:${state.location.colo ?? "UNKNOWN"}`);
      },
      persistState() {
        events.push("persist");
      },
      warn(event) {
        events.push(`warn:${event.eventType}`);
      }
    }
  };
}

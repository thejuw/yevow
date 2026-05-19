import { describe, expect, it } from "vitest";
import {
  buildAmVpinTelemetry,
  buildProfilerAlertTelemetry
} from "../../src/engine/trading/telemetry/ProfilerTelemetryRuntime";
import type { AgentSignal, ProfilerState } from "../../src/types";

describe("ProfilerTelemetryRuntime", () => {
  it("builds profiler alert telemetry from the signal and profiler state", () => {
    const event = buildProfilerAlertTelemetry(signal(), profilerState());

    expect(event).toMatchObject({
      telemetryType: "PROFILER_ALERT",
      correlationId: "signal-1",
      payload: {
        signalId: "signal-1",
        traceId: "trace-1",
        instrumentCode: "btc-usd",
        toxicityScore: 0.8,
        amVpin: 0.75,
        obi: -0.4,
        toxicityState: "TOXIC",
        pressureSide: "SELL",
        completedBuckets: 2,
        totalBucketsClosed: 7,
        action: "PAUSE",
        targetAgent: "CROUPIER",
        suggestedSpreadWidenBps: 12,
        rationale: "toxic flow"
      }
    });
  });

  it("builds AM-VPIN bucket telemetry with the deterministic correlation id", () => {
    const event = buildAmVpinTelemetry(
      profilerState({ amVpinBucketCompletions: 12, amVpinMean: 0.55 }),
      "hype-usd",
      "2026-05-19T12:00:00.000Z"
    );

    expect(event).toMatchObject({
      telemetryType: "AM_VPIN_TELEMETRY",
      correlationId: "am-vpin:hype-usd:12",
      payload: {
        instrumentCode: "hype-usd",
        observedAt: "2026-05-19T12:00:00.000Z",
        am_vpin: 0.75,
        completedBuckets: 12,
        amVpinMean: 0.55,
        toxicity_state: "TOXIC"
      }
    });
  });
});

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    signalId: "signal-1",
    traceId: "trace-1",
    sourceAgent: "PROFILER",
    targetAgent: "CROUPIER",
    instrumentCode: "btc-usd",
    action: "PAUSE",
    confidence: 0.9,
    horizonMs: 60_000,
    expectedValue: -1,
    maxSlippageBps: 12,
    rationale: "toxic flow",
    featureVector: { vpin: 0.75 },
    riskContext: { haltMs: 60_000 },
    createdAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}

function profilerState(overrides: Partial<ProfilerState> = {}): ProfilerState {
  return {
    schemaVersion: "profiler.v1",
    bucketSize: 10,
    rollingWindow: 50,
    alertThreshold: 0.7,
    toxicityScore: 0.8,
    amVpinScore: 0.75,
    obi: -0.4,
    obiDepth: 5,
    directionalDecay: 0.3,
    latestSignedImbalance: -4,
    latestDirectionalImbalance: -5,
    toxicityState: "TOXIC",
    pressureSide: "SELL",
    spreadMultiplier: 1,
    reservationShiftBps: 0,
    quoteHaltUntil: null,
    amVpinBucketCompletions: 6,
    amVpinMean: 0.5,
    amVpinM2: 0,
    amVpinVariance: 0.01,
    amVpinRing: {
      buyVolumes: [],
      sellVolumes: [],
      signedImbalances: [],
      directionalImbalances: [],
      obiValues: []
    },
    distanceToCascadePct: null,
    cascadeShieldUntil: null,
    cascadeClusterId: null,
    cascadeSide: null,
    activeBucket: null,
    buckets: [{ bucketId: "1" }, { bucketId: "2" }] as ProfilerState["buckets"],
    totalBucketsClosed: 7,
    lastProcessedSequence: null,
    lastSignalId: null,
    lastAlertBucketCount: 0,
    lastSpoofingWallId: null,
    tradeSizeCount: 0,
    tradeSizeMean: 0,
    tradeSizeM2: 0,
    tradeSizeWindow: [],
    quoteSuspendedUntil: null,
    updatedAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}

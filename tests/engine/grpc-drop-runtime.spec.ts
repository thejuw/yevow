import { describe, expect, it } from "vitest";
import {
  buildGrpcFatalDropEventArtifacts,
  resolveGrpcFatalDropPayload,
  stateAfterGrpcFatalDrop
} from "../../src/engine/trading/ingest/GrpcDropRuntime";
import { defaultEngineState } from "../../src/engine/trading/helpers/RuntimeHelpers";

describe("GrpcDropRuntime", () => {
  it("normalizes fatal drop payloads with defensive defaults", () => {
    expect(
      resolveGrpcFatalDropPayload(
        {
          observedAt: "2026-05-18T12:00:00.000Z",
          disconnectedForMs: 275,
          thresholdMs: 200,
          reason: "DWELLIR_TIMEOUT"
        },
        "fallback"
      )
    ).toEqual({
      observedAt: "2026-05-18T12:00:00.000Z",
      disconnectedForMs: 275,
      thresholdMs: 200,
      reason: "DWELLIR_TIMEOUT"
    });

    expect(resolveGrpcFatalDropPayload({}, "2026-05-18T12:00:01.000Z")).toEqual({
      observedAt: "2026-05-18T12:00:01.000Z",
      disconnectedForMs: 0,
      thresholdMs: 200,
      reason: "GRPC_FATAL_DROP"
    });
  });

  it("marks executioner health and suspends quotes on critical drops", () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const currentState = defaultEngineState("grpc-test");
    currentState.quoteState = {
      ...currentState.quoteState,
      status: "ACTIVE",
      reason: null,
      updatedAt: observedAt
    };

    const result = stateAfterGrpcFatalDrop({
      currentState,
      observedAt,
      disconnectedForMs: 250,
      thresholdMs: 200,
      reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
      shadowMode: true
    });

    expect(result.citadel).toMatchObject({
      status: "CRITICAL",
      shouldEvacuate: true,
      evacuationSignal: { action: "CANCEL_ALL_QUOTES" }
    });
    expect(result.state.citadel).toMatchObject({
      status: "CRITICAL",
      reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
      shadowMode: true,
      lastEvacuationAt: observedAt
    });
    expect(result.state.quoteState).toMatchObject({
      status: "SUSPENDED",
      reason: "GRPC_FATAL_DROP"
    });
    expect(result.state.agentHealth.EXECUTIONER.status).toBe("RED");
    expect(result.state.executionProfile.status).toBe("UNSTABLE");
    expect(result.state.updatedAt).toBe(observedAt);
  });

  it("builds fatal-drop log and telemetry artifacts", () => {
    const resolved = resolveGrpcFatalDropPayload(
      {
        streamId: "dwellir-stream",
        source: "DWELLIR_GRPC",
        source_exchange: "hyperliquid",
        connectionId: "connection-1",
        observedAt: "2026-05-18T12:00:00.000Z",
        disconnectedForMs: 250,
        thresholdMs: 200,
        reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT"
      },
      "fallback"
    );
    const { citadel } = stateAfterGrpcFatalDrop({
      currentState: defaultEngineState("grpc-test"),
      ...resolved,
      shadowMode: true
    });

    expect(
      buildGrpcFatalDropEventArtifacts({
        payload: {
          streamId: "dwellir-stream",
          source: "DWELLIR_GRPC",
          source_exchange: "hyperliquid",
          connectionId: "connection-1"
        },
        resolved,
        citadel
      })
    ).toEqual({
      telemetryType: "GRPC_FATAL_DROP",
      shouldCancelAllQuotes: true,
      logMetadata: {
        streamId: "dwellir-stream",
        source: "DWELLIR_GRPC",
        source_exchange: "hyperliquid",
        connectionId: "connection-1",
        reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
        disconnectedForMs: 250,
        thresholdMs: 200,
        observedAt: "2026-05-18T12:00:00.000Z",
        citadelStatus: "CRITICAL",
        evacuationAction: "CANCEL_ALL_QUOTES"
      },
      telemetryPayload: {
        streamId: "dwellir-stream",
        source_exchange: "hyperliquid",
        reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
        disconnectedForMs: 250,
        thresholdMs: 200,
        action: "CANCEL_ALL_QUOTES",
        citadelStatus: "CRITICAL",
        observedAt: "2026-05-18T12:00:00.000Z"
      }
    });
  });

  it("keeps prior evacuation timestamp on watch-level drops", () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const currentState = defaultEngineState("grpc-test");
    currentState.citadel = {
      ...currentState.citadel,
      lastEvacuationAt: "2026-05-18T11:59:00.000Z"
    };

    const result = stateAfterGrpcFatalDrop({
      currentState,
      observedAt,
      disconnectedForMs: 50,
      thresholdMs: 200,
      reason: "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
      shadowMode: false
    });

    expect(result.citadel.status).toBe("WATCH");
    expect(result.citadel.shouldEvacuate).toBe(false);
    expect(result.state.citadel.lastEvacuationAt).toBe("2026-05-18T11:59:00.000Z");
    expect(result.state.agentHealth.EXECUTIONER.status).toBe("YELLOW");
  });
});

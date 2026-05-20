import { nativeIso, nativeNumber, nativeString } from "../helpers/NativeHyperliquidRuntime";
import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import { touchAgentHealth } from "../state/EngineStateDefaults";
import type { CitadelDropDecision } from "../../../utils/CitadelProtocol";
import { evaluateGrpcDrop } from "../../../utils/CitadelProtocol";
import type { EngineState, JsonRecord } from "../../../types";
import type { GrpcFatalDropPayload } from "../TradingEngineRouteTypes";

export interface ResolvedGrpcFatalDrop {
  readonly observedAt: string;
  readonly disconnectedForMs: number;
  readonly thresholdMs: number;
  readonly reason: string;
}

export interface GrpcFatalDropStateInput extends ResolvedGrpcFatalDrop {
  readonly currentState: EngineState;
  readonly shadowMode: boolean;
}

export interface GrpcFatalDropStateResult {
  readonly state: EngineState;
  readonly citadel: CitadelDropDecision;
}

export interface GrpcFatalDropEventInput {
  readonly payload: GrpcFatalDropPayload;
  readonly resolved: ResolvedGrpcFatalDrop;
  readonly citadel: CitadelDropDecision;
}

export interface GrpcFatalDropEventArtifacts {
  readonly telemetryType: "GRPC_FATAL_DROP";
  readonly logMetadata: JsonRecord;
  readonly telemetryPayload: JsonRecord;
  readonly shouldCancelAllQuotes: boolean;
}

export function resolveGrpcFatalDropPayload(
  payload: GrpcFatalDropPayload,
  fallbackObservedAt = new Date().toISOString()
): ResolvedGrpcFatalDrop {
  return {
    observedAt: nativeIso(payload.observedAt) ?? fallbackObservedAt,
    disconnectedForMs: nativeNumber(payload.disconnectedForMs) ?? 0,
    thresholdMs: nativeNumber(payload.thresholdMs) ?? 200,
    reason: nativeString(payload.reason) ?? "GRPC_FATAL_DROP"
  };
}

export function buildGrpcFatalDropEventArtifacts(
  input: GrpcFatalDropEventInput
): GrpcFatalDropEventArtifacts {
  const sourceExchange = input.payload.source_exchange ?? "hyperliquid";
  const source = input.payload.source ?? "DWELLIR_GRPC";

  return {
    telemetryType: "GRPC_FATAL_DROP",
    shouldCancelAllQuotes: input.citadel.shouldEvacuate,
    logMetadata: {
      streamId: input.payload.streamId ?? null,
      source,
      source_exchange: sourceExchange,
      connectionId: input.payload.connectionId ?? null,
      reason: input.resolved.reason,
      disconnectedForMs: input.resolved.disconnectedForMs,
      thresholdMs: input.resolved.thresholdMs,
      observedAt: input.resolved.observedAt,
      citadelStatus: input.citadel.status,
      evacuationAction: input.citadel.evacuationSignal.action
    },
    telemetryPayload: {
      streamId: input.payload.streamId ?? null,
      source_exchange: sourceExchange,
      reason: input.resolved.reason,
      disconnectedForMs: input.resolved.disconnectedForMs,
      thresholdMs: input.resolved.thresholdMs,
      action: input.citadel.evacuationSignal.action,
      citadelStatus: input.citadel.status,
      observedAt: input.resolved.observedAt
    }
  };
}

export function stateAfterGrpcFatalDrop(input: GrpcFatalDropStateInput): GrpcFatalDropStateResult {
  const citadel = evaluateGrpcDrop({
    disconnectedForMs: input.disconnectedForMs,
    thresholdMs: input.thresholdMs,
    reason: input.reason,
    observedAt: input.observedAt
  });
  const assetQuoteStates = suspendAssetQuoteStates(
    input.currentState.assetQuoteStates,
    "GRPC_FATAL_DROP",
    input.observedAt,
    { lastQuote: input.currentState.quoteState.lastQuote }
  );

  return {
    citadel,
    state: {
      ...input.currentState,
      agentHealth: touchAgentHealth(
        input.currentState.agentHealth,
        "EXECUTIONER",
        citadel.status === "CRITICAL" ? "RED" : "YELLOW",
        input.observedAt,
        0,
        input.reason
      ),
      quoteState: aggregateQuoteState(
        assetQuoteStates,
        input.currentState.quoteState,
        input.observedAt
      ),
      assetQuoteStates,
      executionProfile: {
        ...input.currentState.executionProfile,
        status: "UNSTABLE",
        updatedAt: input.observedAt
      },
      citadel: {
        status: citadel.status,
        reason: input.reason,
        shadowMode: input.shadowMode,
        lastEvacuationAt: citadel.shouldEvacuate
          ? input.observedAt
          : input.currentState.citadel.lastEvacuationAt,
        updatedAt: input.observedAt
      },
      heartbeatAt: input.observedAt,
      updatedAt: input.observedAt
    }
  };
}

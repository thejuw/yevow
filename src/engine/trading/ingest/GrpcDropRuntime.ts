import {
  aggregateQuoteState,
  nativeIso,
  nativeNumber,
  nativeString,
  suspendAssetQuoteStates,
  touchAgentHealth
} from "../../../TradingEngineRuntimeHelpers";
import type { CitadelDropDecision } from "../../../utils/CitadelProtocol";
import { evaluateGrpcDrop } from "../../../utils/CitadelProtocol";
import type { EngineState } from "../../../types";
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

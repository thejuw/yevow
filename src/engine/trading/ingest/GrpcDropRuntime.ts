import { nativeIso, nativeNumber, nativeString } from "../helpers/NativeValueRuntime";
import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import { touchAgentHealth } from "../state/AgentStateDefaults";
import type { CitadelDropDecision } from "../../../utils/CitadelProtocol";
import { evaluateGrpcDrop, isShadowMode } from "../../../utils/CitadelProtocol";
import { ENGINE_STATE_KEY } from "../../../TradingEngineConstants";
import type { EngineState, Env, JsonRecord } from "../../../types";
import type { GrpcFatalDropPayload } from "../TradingEngineRouteTypes";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "../quotes/QuoteCancelRuntime";
import { applyHotStorageSnapshotForTargetOrHandler } from "../state/StorageWriteGuard";

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

export interface GrpcFatalDropArtifactsInput {
  readonly payload: GrpcFatalDropPayload;
  readonly currentState: EngineState;
  readonly shadowMode: boolean;
  readonly engineStateKey: string;
  readonly fallbackObservedAt?: string;
}

export interface GrpcFatalDropArtifacts {
  readonly resolved: ResolvedGrpcFatalDrop;
  readonly state: EngineState;
  readonly storageWrites: Record<string, unknown>;
  readonly events: GrpcFatalDropEventArtifacts;
  readonly response: { status: "GRPC_FATAL_DROP" };
}

export interface GrpcFatalDropSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly persistStorage: (
    writes: Record<string, unknown>,
    reason: "GRPC_FATAL_DROP"
  ) => Promise<unknown>;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly logError: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: JsonRecord) => void;
  readonly cancelAllQuotes: (instrumentCode: "ALL", reason: "GRPC_FATAL_DROP") => Promise<unknown>;
}

export interface GrpcFatalDropTarget {
  engineState: EngineState;
  readonly env: Pick<Env, "SHADOW_MODE">;
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  readonly logger: {
    error(eventType: string, message: string, metadata?: JsonRecord): void;
  };
  persistHotStorageSnapshot?(
    writes: Record<string, unknown>,
    reason: "GRPC_FATAL_DROP"
  ): Promise<unknown>;
  publish(type: string, payload: JsonRecord): void;
  cancelAllQuotes?(instrumentCode: "ALL", reason: "GRPC_FATAL_DROP"): Promise<unknown>;
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

export function grpcFatalDropArtifacts(input: GrpcFatalDropArtifactsInput): GrpcFatalDropArtifacts {
  const resolved = resolveGrpcFatalDropPayload(input.payload, input.fallbackObservedAt);
  const grpcDrop = stateAfterGrpcFatalDrop({
    currentState: input.currentState,
    ...resolved,
    shadowMode: input.shadowMode
  });
  const events = buildGrpcFatalDropEventArtifacts({
    payload: input.payload,
    resolved,
    citadel: grpcDrop.citadel
  });

  return {
    resolved,
    state: grpcDrop.state,
    storageWrites: {
      [input.engineStateKey]: grpcDrop.state
    },
    events,
    response: { status: "GRPC_FATAL_DROP" }
  };
}

export function applyGrpcFatalDropSideEffects(
  artifacts: GrpcFatalDropArtifacts,
  handlers: GrpcFatalDropSideEffectHandlers
): void {
  handlers.applyState(artifacts.state);
  handlers.schedule(handlers.persistStorage(artifacts.storageWrites, "GRPC_FATAL_DROP"));
  handlers.logError(
    artifacts.events.telemetryType,
    "Dwellir gRPC blackout forced quote evacuation",
    artifacts.events.logMetadata
  );
  handlers.publish(artifacts.events.telemetryType, artifacts.events.telemetryPayload);

  if (artifacts.events.shouldCancelAllQuotes) {
    handlers.schedule(handlers.cancelAllQuotes("ALL", "GRPC_FATAL_DROP"));
  }
}

export function handleGrpcFatalDropForTarget(
  payload: GrpcFatalDropPayload,
  target: GrpcFatalDropTarget
): { status: "GRPC_FATAL_DROP" } {
  const artifacts = grpcFatalDropArtifacts({
    payload,
    currentState: target.engineState,
    shadowMode: isShadowMode(target.env),
    engineStateKey: ENGINE_STATE_KEY
  });

  applyGrpcFatalDropSideEffects(artifacts, {
    applyState: (state) => {
      target.engineState = state;
    },
    persistStorage: (writes, reason) =>
      applyHotStorageSnapshotForTargetOrHandler(target, writes, reason),
    schedule: (work) => {
      target.state.waitUntil(work);
    },
    logError: (eventType, message, metadata) => {
      target.logger.error(eventType, message, metadata);
    },
    publish: (type, publishPayload) => {
      target.publish(type, publishPayload);
    },
    cancelAllQuotes: (instrumentCode, reason) =>
      target.cancelAllQuotes
        ? target.cancelAllQuotes(instrumentCode, reason)
        : cancelAllTradingQuotesForTarget(
            instrumentCode,
            reason,
            target as unknown as TradingQuoteCancelAllTarget
          )
  });

  return artifacts.response;
}

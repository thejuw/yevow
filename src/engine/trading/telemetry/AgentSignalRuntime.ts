import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import { hawkesEvacuationSignal, inferSignalBias } from "../state/AgentStateDefaults";
import { ENGINE_STATE_KEY, SIGNAL_BUFFER_LIMIT } from "../../../TradingEngineConstants";
import type { AgentHealth, AgentName, AgentSignal, EngineState } from "../../../types";

export interface AcceptedAgentSignalInput {
  readonly engineState: EngineState;
  readonly signal: AgentSignal;
  readonly latencyMs: number;
}

export interface AgentSignalTelemetry {
  readonly telemetryType: "AGENT_SIGNAL";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface AcceptedAgentSignalResult {
  readonly state: EngineState;
  readonly hawkesEvacuation: boolean;
  readonly telemetry: AgentSignalTelemetry;
}

export interface HawkesEvacuationDispatch {
  readonly telemetryType: "SUSPEND_QUOTES";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
  readonly cancelInstrumentCode: string;
  readonly cancelReason: "HAWKES_FLOW_CLUSTER";
}

export interface AgentSignalBufferInput {
  readonly signals: AgentSignal[];
  readonly latestAgentSignals: Map<AgentName, AgentSignal>;
  readonly signal: AgentSignal;
  readonly signalBufferLimit: number;
}

export interface AcceptedAgentSignalStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly signal: AgentSignal;
}

export interface AcceptedAgentSignalSideEffectsInput {
  readonly signals: AgentSignal[];
  readonly latestAgentSignals: Map<AgentName, AgentSignal>;
  readonly engineState: EngineState;
  readonly signal: AgentSignal;
  readonly latencyMs: number;
  readonly signalBufferLimit: number;
  readonly engineStateKey: string;
  readonly tradingEnabled: boolean;
}

export interface TradingAcceptedAgentSignalInput {
  readonly signals: AgentSignal[];
  readonly latestAgentSignals: Map<AgentName, AgentSignal>;
  readonly engineState: EngineState;
  readonly signal: AgentSignal;
  readonly latencyMs: number;
  readonly tradingEnabled: boolean;
}

export interface AcceptedAgentSignalSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly persistStorageEntries: (entries: Record<string, unknown>) => Promise<void>;
  readonly logAgentDecision: (signal: AgentSignal, latencyMs: number) => void;
  readonly publish: (
    telemetryType: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ) => void;
  readonly schedule: (work: Promise<void>) => void;
  readonly cancelAllQuotes: (
    instrumentCode: string,
    reason: HawkesEvacuationDispatch["cancelReason"]
  ) => Promise<void>;
}

export function recordAgentSignalInBuffers(input: AgentSignalBufferInput): void {
  input.signals.push(input.signal);

  if (input.signals.length > input.signalBufferLimit) {
    input.signals.splice(0, input.signals.length - input.signalBufferLimit);
  }

  input.latestAgentSignals.set(input.signal.sourceAgent, input.signal);
}

export function agentSignalStorageKey(signal: AgentSignal): string {
  return `signal:${signal.signalId}`;
}

export function acceptedAgentSignalStorageEntries(
  input: AcceptedAgentSignalStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [agentSignalStorageKey(input.signal)]: input.signal
  };
}

export function stateAfterAcceptedAgentSignal(
  input: AcceptedAgentSignalInput
): AcceptedAgentSignalResult {
  const { engineState, latencyMs, signal } = input;
  const hawkesEvacuation = hawkesEvacuationSignal(signal);
  const assetQuoteStates = hawkesEvacuation
    ? suspendAssetQuoteStates(
        engineState.assetQuoteStates,
        "HAWKES_FLOW_CLUSTER",
        signal.createdAt,
        {
          instrumentCode: signal.instrumentCode,
          suspendedUntil: new Date(
            Date.parse(signal.createdAt) + Math.max(1_000, signal.horizonMs)
          ).toISOString(),
          lastQuote: engineState.quoteState.lastQuote
        }
      )
    : engineState.assetQuoteStates;
  const quoteState = hawkesEvacuation
    ? aggregateQuoteState(assetQuoteStates, engineState.quoteState, signal.createdAt)
    : engineState.quoteState;
  const agentHealth = {
    ...engineState.agentHealth,
    [signal.sourceAgent]: {
      status: "GREEN",
      heartbeatAt: signal.createdAt,
      latencyMs,
      lastSignalId: signal.signalId,
      failures24h: engineState.agentHealth[signal.sourceAgent].failures24h
    }
  } satisfies Record<AgentName, AgentHealth>;

  return {
    state: {
      ...engineState,
      acceptedSignals: engineState.acceptedSignals + 1,
      agentHealth,
      quoteState,
      assetQuoteStates,
      heartbeatAt: signal.createdAt,
      updatedAt: signal.createdAt
    },
    hawkesEvacuation,
    telemetry: {
      telemetryType: "AGENT_SIGNAL",
      payload: {
        signalId: signal.signalId,
        traceId: signal.traceId,
        sourceAgent: signal.sourceAgent,
        targetAgent: signal.targetAgent,
        instrumentCode: signal.instrumentCode,
        action: signal.action,
        confidence: signal.confidence,
        bias: inferSignalBias(signal),
        expectedValue: signal.expectedValue,
        latencyMs,
        createdAt: signal.createdAt
      },
      correlationId: signal.signalId
    }
  };
}

export function buildHawkesEvacuationDispatch(
  signal: AgentSignal,
  quoteState: EngineState["quoteState"]
): HawkesEvacuationDispatch {
  return {
    telemetryType: "SUSPEND_QUOTES",
    payload: {
      status: quoteState.status,
      reason: quoteState.reason,
      suspendedUntil: quoteState.suspendedUntil,
      updatedAt: quoteState.updatedAt
    },
    correlationId: signal.signalId,
    cancelInstrumentCode: signal.instrumentCode || "ALL",
    cancelReason: "HAWKES_FLOW_CLUSTER"
  };
}

export async function applyAcceptedAgentSignalSideEffects(
  input: AcceptedAgentSignalSideEffectsInput,
  handlers: AcceptedAgentSignalSideEffectHandlers
): Promise<AcceptedAgentSignalResult> {
  recordAgentSignalInBuffers({
    signals: input.signals,
    latestAgentSignals: input.latestAgentSignals,
    signal: input.signal,
    signalBufferLimit: input.signalBufferLimit
  });

  const acceptedSignal = stateAfterAcceptedAgentSignal({
    engineState: input.engineState,
    signal: input.signal,
    latencyMs: input.latencyMs
  });
  handlers.applyState(acceptedSignal.state);

  await handlers.persistStorageEntries(
    acceptedAgentSignalStorageEntries({
      engineStateKey: input.engineStateKey,
      state: acceptedSignal.state,
      signal: input.signal
    })
  );

  handlers.logAgentDecision(input.signal, input.latencyMs);
  handlers.publish(
    acceptedSignal.telemetry.telemetryType,
    acceptedSignal.telemetry.payload,
    acceptedSignal.telemetry.correlationId
  );

  if (acceptedSignal.hawkesEvacuation) {
    const evacuation = buildHawkesEvacuationDispatch(input.signal, acceptedSignal.state.quoteState);
    handlers.publish(evacuation.telemetryType, evacuation.payload, evacuation.correlationId);

    if (input.tradingEnabled) {
      handlers.schedule(
        handlers.cancelAllQuotes(evacuation.cancelInstrumentCode, evacuation.cancelReason)
      );
    }
  }

  return acceptedSignal;
}

export function acceptTradingAgentSignal(
  input: TradingAcceptedAgentSignalInput,
  handlers: AcceptedAgentSignalSideEffectHandlers
): Promise<AcceptedAgentSignalResult> {
  return applyAcceptedAgentSignalSideEffects(
    {
      signals: input.signals,
      latestAgentSignals: input.latestAgentSignals,
      engineState: input.engineState,
      signal: input.signal,
      latencyMs: input.latencyMs,
      signalBufferLimit: SIGNAL_BUFFER_LIMIT,
      engineStateKey: ENGINE_STATE_KEY,
      tradingEnabled: input.tradingEnabled
    },
    handlers
  );
}

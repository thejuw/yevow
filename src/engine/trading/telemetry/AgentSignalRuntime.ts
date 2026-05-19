import {
  aggregateQuoteState,
  hawkesEvacuationSignal,
  inferSignalBias,
  suspendAssetQuoteStates
} from "../../../TradingEngineRuntimeHelpers";
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

export function recordAgentSignalInBuffers(input: AgentSignalBufferInput): void {
  input.signals.push(input.signal);

  if (input.signals.length > input.signalBufferLimit) {
    input.signals.splice(0, input.signals.length - input.signalBufferLimit);
  }

  input.latestAgentSignals.set(input.signal.sourceAgent, input.signal);
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

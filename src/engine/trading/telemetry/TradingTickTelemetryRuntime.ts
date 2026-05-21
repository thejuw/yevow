import type {
  AgentSignal,
  EngineState,
  LatencyMetrics,
  MacroBias,
  MarketTick,
  TemporaryGovernanceOverride
} from "../../../types";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import { emitTickTelemetry } from "./TickTelemetryRuntime";

export interface TradingTickTelemetryInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly status: LatencyMetrics["status"];
  readonly hotPathStartedAt: number;
  readonly engineState: EngineState;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly connectedAdminStreams: number;
  readonly signals: readonly AgentSignal[];
}

export interface TradingTickTelemetryHandlers {
  readonly publish: (
    type: "TICK_TELEMETRY",
    payload: Record<string, unknown>,
    correlationId: string
  ) => void;
}

export function publishTradingTickTelemetry(
  input: TradingTickTelemetryInput,
  handlers: TradingTickTelemetryHandlers
): void {
  const cpuTimeMs = roundLatency(Math.max(0, highResolutionNow() - input.hotPathStartedAt));

  emitTickTelemetry(
    {
      tick: input.tick,
      metrics: input.metrics,
      status: input.status,
      cpuTimeMs,
      engineState: input.engineState,
      macroBias: input.macroBias,
      temporaryOverride: input.temporaryOverride,
      connectedAdminStreams: input.connectedAdminStreams,
      signals: input.signals
    },
    handlers
  );
}

import type { AgentSignal, ProfilerState } from "../../../types";
import {
  emitAmVpinTelemetry,
  emitProfilerAlertTelemetry,
  type ProfilerTelemetryEvent
} from "./ProfilerTelemetryRuntime";

export interface TradingProfilerTelemetryHandlers {
  readonly publish: (
    type: ProfilerTelemetryEvent["telemetryType"],
    payload: ProfilerTelemetryEvent["payload"],
    correlationId: string
  ) => void;
}

export function publishTradingProfilerAlert(
  signal: AgentSignal,
  profilerState: ProfilerState,
  handlers: TradingProfilerTelemetryHandlers
): void {
  emitProfilerAlertTelemetry(signal, profilerState, handlers);
}

export function publishTradingAmVpinTelemetry(
  profilerState: ProfilerState,
  instrumentCode: string,
  observedAt: string,
  handlers: TradingProfilerTelemetryHandlers
): void {
  emitAmVpinTelemetry(profilerState, instrumentCode, observedAt, handlers);
}

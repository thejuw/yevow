import type { JsonRecord } from "../../../types";
import {
  emitAnomalyEmergencyPauseSideEffects,
  type AnomalyEmergencyPauseTelemetry
} from "./AnomalyRuntime";

export type { AnomalyEmergencyPauseTelemetry };

export interface TradingAnomalyEmergencyHandlers {
  readonly writeCriticalLog: (source: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: "EMERGENCY_PAUSE", payload: JsonRecord, correlationId: string) => void;
  readonly notify: (notification: AnomalyEmergencyPauseTelemetry["notification"]) => void;
}

export function emitTradingAnomalyEmergencyPause(
  event: AnomalyEmergencyPauseTelemetry,
  handlers: TradingAnomalyEmergencyHandlers
): void {
  emitAnomalyEmergencyPauseSideEffects(event, handlers);
}

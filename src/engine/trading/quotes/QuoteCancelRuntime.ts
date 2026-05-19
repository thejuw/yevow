import type { JsonRecord } from "../../../types";

export interface QuoteCancelDispatchPayload {
  readonly instrumentCode: string;
  readonly reason: string;
}

export interface QuoteCancelDispatchInput extends QuoteCancelDispatchPayload {
  readonly hasExecutioner: boolean;
  readonly nowMs: number;
  readonly lastDispatchAtMs?: number;
  readonly throttleMs: number;
}

export type QuoteCancelDispatchBlockReason = "NO_EXECUTIONER" | "THROTTLED";

export type QuoteCancelDispatchDecision =
  | {
      readonly shouldDispatch: true;
      readonly dispatchKey: string;
      readonly payload: QuoteCancelDispatchPayload;
      readonly blockReason: null;
    }
  | {
      readonly shouldDispatch: false;
      readonly dispatchKey: string;
      readonly payload: QuoteCancelDispatchPayload;
      readonly blockReason: QuoteCancelDispatchBlockReason;
    };

export interface QuoteCancelExecutionerFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface QuoteCancelLogger {
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface DispatchQuoteCancelAllInput {
  readonly executioner: QuoteCancelExecutionerFetcher;
  readonly logger: QuoteCancelLogger;
  readonly payload: QuoteCancelDispatchPayload;
}

export function evaluateQuoteCancelDispatch(
  input: QuoteCancelDispatchInput
): QuoteCancelDispatchDecision {
  const payload: QuoteCancelDispatchPayload = {
    instrumentCode: input.instrumentCode,
    reason: input.reason
  };
  const dispatchKey = `${input.instrumentCode}:${input.reason}`;

  if (!input.hasExecutioner) {
    return {
      shouldDispatch: false,
      dispatchKey,
      payload,
      blockReason: "NO_EXECUTIONER"
    };
  }

  const previousDispatchAt = input.lastDispatchAtMs ?? 0;
  if (input.nowMs - previousDispatchAt < input.throttleMs) {
    return {
      shouldDispatch: false,
      dispatchKey,
      payload,
      blockReason: "THROTTLED"
    };
  }

  return {
    shouldDispatch: true,
    dispatchKey,
    payload,
    blockReason: null
  };
}

export async function dispatchQuoteCancelAll(input: DispatchQuoteCancelAllInput): Promise<void> {
  try {
    await input.executioner.fetch(
      new Request("https://executioner.internal/cancel-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.payload)
      })
    );
    input.logger.warn("QUOTE_CANCEL_ALL_DISPATCHED", "Executioner cancel-all requested", {
      instrumentCode: input.payload.instrumentCode,
      reason: input.payload.reason
    });
  } catch (error) {
    input.logger.error("QUOTE_CANCEL_ALL_FAILED", "Failed to dispatch cancel-all", {
      instrumentCode: input.payload.instrumentCode,
      reason: input.payload.reason,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
  }
}

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

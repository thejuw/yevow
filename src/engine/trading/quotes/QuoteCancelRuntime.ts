import { HOT_PATH_LOG_THROTTLE_MS, RATE_LIMIT_STATE_KEY } from "../../../TradingEngineConstants";
import type { Env, JsonRecord } from "../../../types";
import { wait } from "../helpers/RuntimeMath";

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

export interface TradingQuoteCancelAllInput {
  readonly instrumentCode: string;
  readonly reason: string;
  readonly executioner: QuoteCancelExecutionerFetcher | undefined;
  readonly logger: QuoteCancelLogger;
  readonly nowMs: number;
  readonly lastDispatchAtMs?: number;
  readonly throttleMs?: number;
}

export interface QuoteCancelReservation {
  readonly allowed: boolean;
  readonly waitMs: number;
}

export interface QuoteCancelAllSideEffectHandlers {
  readonly markDispatch: (dispatchKey: string, dispatchedAtMs: number) => void;
  readonly reserveCancelCapacity: () => QuoteCancelReservation;
  readonly persistRateLimitState: () => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly dispatch: (payload: QuoteCancelDispatchPayload) => Promise<void>;
}

export interface TradingQuoteCancelAllHandlers {
  readonly markDispatch: (dispatchKey: string, dispatchedAtMs: number) => void;
  readonly reserveCancelCapacity: () => QuoteCancelReservation;
  readonly persistRateLimitState: () => void;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface TradingQuoteCancelAllTarget {
  readonly env: Pick<Env, "EXECUTIONER">;
  readonly logger: QuoteCancelLogger;
  cancelAllLogAt: Map<string, number>;
  readonly rateLimiter: {
    reserve(exchangeKey: string, priority: "CANCEL"): QuoteCancelReservation;
    exportState(): unknown;
  };
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
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

export async function applyQuoteCancelAllSideEffects(
  input: QuoteCancelDispatchInput,
  handlers: QuoteCancelAllSideEffectHandlers
): Promise<QuoteCancelDispatchDecision> {
  const decision = evaluateQuoteCancelDispatch(input);

  if (!decision.shouldDispatch) {
    return decision;
  }

  handlers.markDispatch(decision.dispatchKey, input.nowMs);

  const reservation = handlers.reserveCancelCapacity();
  handlers.persistRateLimitState();

  if (!reservation.allowed) {
    await handlers.wait(reservation.waitMs);
  }

  await handlers.dispatch(decision.payload);
  return decision;
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

export async function cancelAllTradingQuotes(
  input: TradingQuoteCancelAllInput,
  handlers: TradingQuoteCancelAllHandlers
): Promise<QuoteCancelDispatchDecision> {
  return applyQuoteCancelAllSideEffects(
    {
      instrumentCode: input.instrumentCode,
      reason: input.reason,
      hasExecutioner: Boolean(input.executioner),
      nowMs: input.nowMs,
      lastDispatchAtMs: input.lastDispatchAtMs,
      throttleMs: input.throttleMs ?? HOT_PATH_LOG_THROTTLE_MS
    },
    {
      markDispatch: handlers.markDispatch,
      reserveCancelCapacity: handlers.reserveCancelCapacity,
      persistRateLimitState: handlers.persistRateLimitState,
      wait: handlers.wait ?? wait,
      dispatch: (payload) => {
        if (!input.executioner) {
          return Promise.resolve();
        }
        return dispatchQuoteCancelAll({
          executioner: input.executioner,
          logger: input.logger,
          payload
        });
      }
    }
  );
}

export function cancelAllTradingQuotesForTarget(
  instrumentCode: string,
  reason: string,
  target: TradingQuoteCancelAllTarget
): Promise<QuoteCancelDispatchDecision> {
  const now = Date.now();

  return cancelAllTradingQuotes(
    {
      instrumentCode,
      reason,
      executioner: target.env.EXECUTIONER,
      logger: target.logger,
      nowMs: now,
      lastDispatchAtMs: target.cancelAllLogAt.get(`${instrumentCode}:${reason}`)
    },
    {
      markDispatch: (dispatchKey, dispatchedAtMs) => {
        target.cancelAllLogAt.set(dispatchKey, dispatchedAtMs);
      },
      reserveCancelCapacity: () => target.rateLimiter.reserve("default", "CANCEL"),
      persistRateLimitState: () => {
        target.state.waitUntil(
          target.safeStoragePut(
            RATE_LIMIT_STATE_KEY,
            target.rateLimiter.exportState(),
            "EXECUTION_RATE_LIMIT_DRAIN"
          )
        );
      }
    }
  );
}

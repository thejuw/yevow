import type { ExchangeOpenOrder, JsonRecord } from "../../../types";
import type { RateLimitPriority } from "../../../utils/RateLimiter";
import type {
  JanitorCancellationRequest,
  JanitorCancelReason
} from "./JanitorOrderReconciliationRuntime";

export interface DispatchJanitorCancellationRequestsInput {
  readonly requests: readonly JanitorCancellationRequest[];
  readonly cancelOrder: (
    orderId: string,
    reason: JanitorCancelReason,
    instrumentCode?: string
  ) => Promise<void>;
}

export interface JanitorExecutionerFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface JanitorExecutionLogger {
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface FetchJanitorExchangeOpenOrdersInput {
  readonly executioner: JanitorExecutionerFetcher | undefined;
  readonly logger: JanitorExecutionLogger;
}

export interface CancelJanitorOrderInput {
  readonly executioner: JanitorExecutionerFetcher | undefined;
  readonly logger: JanitorExecutionLogger;
  readonly orderId: string;
  readonly reason: string;
  readonly instrumentCode?: string;
}

export interface CancelJanitorOrderSideEffectsInput {
  readonly hasExecutioner: boolean;
  readonly orderId: string;
  readonly reason: string;
  readonly instrumentCode?: string;
}

export interface JanitorCancelReservation {
  readonly allowed: boolean;
  readonly waitMs: number;
}

export interface CancelJanitorOrderSideEffectHandlers {
  readonly reserveCancelCapacity: (priority: RateLimitPriority) => JanitorCancelReservation;
  readonly persistRateLimitState: () => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly cancelOrder: (orderId: string, reason: string, instrumentCode?: string) => Promise<void>;
}

export async function fetchJanitorExchangeOpenOrders(
  input: FetchJanitorExchangeOpenOrdersInput
): Promise<ExchangeOpenOrder[]> {
  if (!input.executioner) {
    return [];
  }

  try {
    const response = await input.executioner.fetch(
      new Request("https://executioner.internal/open-orders")
    );

    if (!response.ok) {
      return [];
    }

    const payload = await response.json<{ orders?: ExchangeOpenOrder[] }>();
    return Array.isArray(payload.orders) ? payload.orders : [];
  } catch (error) {
    input.logger.error("JANITOR_OPEN_ORDERS_FAILED", "Failed to fetch exchange open orders", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return [];
  }
}

export async function cancelJanitorOrder(input: CancelJanitorOrderInput): Promise<void> {
  if (!input.executioner) {
    return;
  }

  try {
    await input.executioner.fetch(
      new Request("https://executioner.internal/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: input.orderId,
          instrumentCode: input.instrumentCode,
          reason: input.reason
        })
      })
    );
  } catch (error) {
    input.logger.error("JANITOR_CANCEL_FAILED", "Failed to cancel order during janitor run", {
      orderId: input.orderId,
      instrumentCode: input.instrumentCode ?? null,
      reason: input.reason,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
  }
}

export async function applyCancelJanitorOrderSideEffects(
  input: CancelJanitorOrderSideEffectsInput,
  handlers: CancelJanitorOrderSideEffectHandlers
): Promise<void> {
  if (!input.hasExecutioner) {
    return;
  }

  const priority: RateLimitPriority = "CANCEL";
  const reservation = handlers.reserveCancelCapacity(priority);
  handlers.persistRateLimitState();

  if (!reservation.allowed) {
    await handlers.wait(reservation.waitMs);
  }

  await handlers.cancelOrder(input.orderId, input.reason, input.instrumentCode);
}

export async function dispatchJanitorCancellationRequests(
  input: DispatchJanitorCancellationRequestsInput
): Promise<void> {
  for (const request of input.requests) {
    await input.cancelOrder(request.orderId, request.reason, request.instrumentCode);
  }
}

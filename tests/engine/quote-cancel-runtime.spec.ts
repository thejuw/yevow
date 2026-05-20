import { describe, expect, it } from "vitest";
import {
  applyQuoteCancelAllSideEffects,
  dispatchQuoteCancelAll,
  evaluateQuoteCancelDispatch,
  type QuoteCancelAllSideEffectHandlers,
  type QuoteCancelLogger
} from "../../src/engine/trading/quotes/QuoteCancelRuntime";

describe("QuoteCancelRuntime", () => {
  it("blocks cancel-all requests when the executioner binding is absent", () => {
    expect(
      evaluateQuoteCancelDispatch({
        instrumentCode: "btc-usd",
        reason: "TEST",
        hasExecutioner: false,
        nowMs: 10_000,
        throttleMs: 5_000
      })
    ).toEqual({
      shouldDispatch: false,
      dispatchKey: "btc-usd:TEST",
      payload: { instrumentCode: "btc-usd", reason: "TEST" },
      blockReason: "NO_EXECUTIONER"
    });
  });

  it("throttles repeated cancel-all requests for the same instrument and reason", () => {
    expect(
      evaluateQuoteCancelDispatch({
        instrumentCode: "hype-usd",
        reason: "CASCADE_SHIELD",
        hasExecutioner: true,
        nowMs: 12_000,
        lastDispatchAtMs: 10_000,
        throttleMs: 5_000
      })
    ).toEqual({
      shouldDispatch: false,
      dispatchKey: "hype-usd:CASCADE_SHIELD",
      payload: { instrumentCode: "hype-usd", reason: "CASCADE_SHIELD" },
      blockReason: "THROTTLED"
    });
  });

  it("allows a cancel-all dispatch and returns the executioner payload", () => {
    expect(
      evaluateQuoteCancelDispatch({
        instrumentCode: "ALL",
        reason: "GRPC_FATAL_DROP",
        hasExecutioner: true,
        nowMs: 16_000,
        lastDispatchAtMs: 10_000,
        throttleMs: 5_000
      })
    ).toEqual({
      shouldDispatch: true,
      dispatchKey: "ALL:GRPC_FATAL_DROP",
      payload: { instrumentCode: "ALL", reason: "GRPC_FATAL_DROP" },
      blockReason: null
    });
  });

  it("does not run side effects when cancel-all dispatch is blocked", async () => {
    const sideEffects = sideEffectSpy();

    const decision = await applyQuoteCancelAllSideEffects(
      {
        instrumentCode: "ALL",
        reason: "GRPC_FATAL_DROP",
        hasExecutioner: false,
        nowMs: 20_000,
        throttleMs: 5_000
      },
      sideEffects.handlers
    );

    expect(decision).toMatchObject({ shouldDispatch: false, blockReason: "NO_EXECUTIONER" });
    expect(sideEffects.events).toEqual([]);
  });

  it("runs cancel-all side effects in dispatch order", async () => {
    const sideEffects = sideEffectSpy();

    const decision = await applyQuoteCancelAllSideEffects(
      {
        instrumentCode: "hype-usd",
        reason: "TOXICITY",
        hasExecutioner: true,
        nowMs: 25_000,
        lastDispatchAtMs: 1_000,
        throttleMs: 5_000
      },
      sideEffects.handlers
    );

    expect(decision).toMatchObject({ shouldDispatch: true, dispatchKey: "hype-usd:TOXICITY" });
    expect(sideEffects.events).toEqual([
      "mark:hype-usd:TOXICITY:25000",
      "reserve",
      "persist",
      "dispatch:hype-usd:TOXICITY"
    ]);
  });

  it("waits for cancel capacity before dispatching when rate limited", async () => {
    const sideEffects = sideEffectSpy({ allowed: false, waitMs: 275 });

    await applyQuoteCancelAllSideEffects(
      {
        instrumentCode: "btc-usd",
        reason: "JANITOR",
        hasExecutioner: true,
        nowMs: 30_000,
        lastDispatchAtMs: 1_000,
        throttleMs: 5_000
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "mark:btc-usd:JANITOR:30000",
      "reserve",
      "persist",
      "wait:275",
      "dispatch:btc-usd:JANITOR"
    ]);
  });

  it("dispatches cancel-all requests to the executioner and logs success", async () => {
    const requests: Request[] = [];
    const { logger, warnings } = loggerSpy();
    const executioner = {
      async fetch(request: Request) {
        requests.push(request);
        return Response.json({ ok: true });
      }
    };

    await dispatchQuoteCancelAll({
      executioner,
      logger,
      payload: { instrumentCode: "ALL", reason: "GRPC_FATAL_DROP" }
    });

    expect(requests[0].url).toBe("https://executioner.internal/cancel-all");
    expect(requests[0].method).toBe("POST");
    await expect(requests[0].json()).resolves.toEqual({
      instrumentCode: "ALL",
      reason: "GRPC_FATAL_DROP"
    });
    expect(warnings[0]).toMatchObject({
      eventType: "QUOTE_CANCEL_ALL_DISPATCHED",
      telemetry: { instrumentCode: "ALL", reason: "GRPC_FATAL_DROP" }
    });
  });

  it("logs cancel-all dispatch failures without throwing", async () => {
    const { logger, errors } = loggerSpy();
    const executioner = {
      async fetch() {
        throw new Error("executioner offline");
      }
    };

    await dispatchQuoteCancelAll({
      executioner,
      logger,
      payload: { instrumentCode: "hype-usd", reason: "TOXICITY" }
    });

    expect(errors[0]).toMatchObject({
      eventType: "QUOTE_CANCEL_ALL_FAILED",
      telemetry: {
        instrumentCode: "hype-usd",
        reason: "TOXICITY",
        error: "executioner offline"
      }
    });
  });
});

function sideEffectSpy(
  reservation: { allowed: boolean; waitMs: number } = { allowed: true, waitMs: 0 }
): {
  events: string[];
  handlers: QuoteCancelAllSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      markDispatch(dispatchKey, dispatchedAtMs) {
        events.push(`mark:${dispatchKey}:${dispatchedAtMs}`);
      },
      reserveCancelCapacity() {
        events.push("reserve");
        return reservation;
      },
      persistRateLimitState() {
        events.push("persist");
      },
      wait(ms) {
        events.push(`wait:${ms}`);
        return Promise.resolve();
      },
      dispatch(payload) {
        events.push(`dispatch:${payload.instrumentCode}:${payload.reason}`);
        return Promise.resolve();
      }
    }
  };
}

function loggerSpy(): {
  logger: QuoteCancelLogger;
  errors: { eventType: string; message: string; telemetry?: Record<string, unknown> }[];
  warnings: { eventType: string; message: string; telemetry?: Record<string, unknown> }[];
} {
  const errors: { eventType: string; message: string; telemetry?: Record<string, unknown> }[] = [];
  const warnings: { eventType: string; message: string; telemetry?: Record<string, unknown> }[] =
    [];

  return {
    logger: {
      error(eventType, message, telemetry) {
        errors.push({ eventType, message, telemetry });
      },
      warn(eventType, message, telemetry) {
        warnings.push({ eventType, message, telemetry });
      }
    },
    errors,
    warnings
  };
}

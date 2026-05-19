import { describe, expect, it } from "vitest";
import {
  dispatchQuoteCancelAll,
  evaluateQuoteCancelDispatch,
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

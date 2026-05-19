import { describe, expect, it } from "vitest";
import { evaluateQuoteCancelDispatch } from "../../src/engine/trading/quotes/QuoteCancelRuntime";

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
});

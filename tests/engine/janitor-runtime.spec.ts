import { describe, expect, it } from "vitest";
import { reconcileJanitorOrders } from "../../src/engine/trading/janitor/JanitorRuntime";
import type { ExchangeOpenOrder, ManagedOrder } from "../../src/types";

const OBSERVED_AT = "2026-05-18T16:00:00.000Z";

describe("JanitorRuntime", () => {
  it("reconciles known exchange orders into local managed orders", () => {
    const result = reconcileJanitorOrders({
      orderMap: {
        "client-1": order({ clientId: "client-1", exchangeOrderId: "old", status: "PENDING" })
      },
      exchangeOpenOrders: [
        exchangeOrder({
          clientId: "client-1",
          exchangeOrderId: "remote-1",
          status: "OPEN",
          filledSize: 0.25
        })
      ],
      zombieOrders: [],
      observedAt: OBSERVED_AT
    });

    expect(result.reconciledOrders).toEqual(["client-1"]);
    expect(result.cancellationRequests).toEqual([]);
    expect(result.orderMap["client-1"]).toMatchObject({
      exchangeOrderId: "remote-1",
      filledSize: 0.25,
      status: "OPEN",
      updatedAt: OBSERVED_AT
    });
  });

  it("marks vanished local exchange orders cancelled", () => {
    const result = reconcileJanitorOrders({
      orderMap: {
        "client-1": order({ clientId: "client-1", exchangeOrderId: "missing", status: "OPEN" }),
        "client-2": order({ clientId: "client-2", exchangeOrderId: null, status: "PENDING" })
      },
      exchangeOpenOrders: [],
      zombieOrders: [],
      observedAt: OBSERVED_AT
    });

    expect(result.cancelledOrders).toEqual(["client-1"]);
    expect(result.orderMap["client-1"]).toMatchObject({
      status: "CANCELLED",
      updatedAt: OBSERVED_AT
    });
    expect(result.orderMap["client-2"].status).toBe("PENDING");
  });

  it("emits cancel requests for orphan exchange and zombie local orders", () => {
    const result = reconcileJanitorOrders({
      orderMap: {
        "client-1": order({
          clientId: "client-1",
          exchangeOrderId: null,
          instrumentCode: "btc-usd",
          status: "OPEN"
        })
      },
      exchangeOpenOrders: [
        exchangeOrder({
          clientId: null,
          exchangeOrderId: "orphan-1",
          instrumentCode: "hype-usd"
        })
      ],
      zombieOrders: ["client-1", "client-missing"],
      observedAt: OBSERVED_AT
    });

    expect(result.orphanExchangeOrders).toEqual(["orphan-1"]);
    expect(result.cancelledOrders).toEqual(["orphan-1", "client-1", "client-missing"]);
    expect(result.cancellationRequests).toEqual([
      {
        orderId: "orphan-1",
        reason: "JANITOR_ORPHAN_EXCHANGE_ORDER",
        instrumentCode: "hype-usd"
      },
      {
        orderId: "client-1",
        reason: "JANITOR_ZOMBIE_LOCAL_ORDER",
        instrumentCode: "btc-usd"
      },
      {
        orderId: "client-missing",
        reason: "JANITOR_ZOMBIE_LOCAL_ORDER",
        instrumentCode: undefined
      }
    ]);
    expect(result.orderMap["client-1"].status).toBe("CANCELLED");
  });
});

function order(overrides: Partial<ManagedOrder> = {}): ManagedOrder {
  return {
    clientId: "client-1",
    exchangeOrderId: "exchange-1",
    intentId: "intent-1",
    instrumentCode: "btc-usd",
    side: "BUY",
    price: 100,
    size: 1,
    filledSize: 0,
    status: "PENDING",
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    ackDeadlineAt: OBSERVED_AT,
    ...overrides
  };
}

function exchangeOrder(overrides: Partial<ExchangeOpenOrder> = {}): ExchangeOpenOrder {
  return {
    exchangeOrderId: "remote-1",
    clientId: "client-1",
    instrumentCode: "btc-usd",
    side: "BUY",
    price: 100,
    size: 1,
    filledSize: 0,
    status: "OPEN",
    observedAt: OBSERVED_AT,
    ...overrides
  };
}

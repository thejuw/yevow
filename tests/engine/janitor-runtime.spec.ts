import { describe, expect, it } from "vitest";
import {
  buildJanitorReport,
  cancelJanitorOrder,
  fetchJanitorExchangeOpenOrders,
  janitorCleanupRequiredLogMetadata,
  type JanitorExecutionLogger,
  reconcileJanitorOrders,
  recordPostOnlyDustCloseSkip,
  stateAfterJanitorRun
} from "../../src/engine/trading/janitor/JanitorRuntime";
import type { LogPruneReport } from "../../src/engine/LogRetention";
import type { EngineState, ExchangeOpenOrder, JanitorState, ManagedOrder } from "../../src/types";

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

  it("builds the persisted janitor report and deduplicates cancellations", () => {
    const result = buildJanitorReport({
      baseReport: janitorState({
        zombieOrders: ["client-1"],
        dustPositions: ["hype-usd"]
      }),
      reconciliation: {
        orderMap: {},
        reconciledOrders: ["client-2"],
        orphanExchangeOrders: ["orphan-1"],
        cancelledOrders: ["client-1", "client-1", "orphan-1"],
        cancellationRequests: []
      },
      dustCloseIntents: ["dust-intent-1"],
      pruneReport: logPruneReport({ totalRows: 2 })
    });

    expect(result.shouldWarn).toBe(true);
    expect(result.report).toMatchObject({
      zombieOrders: ["client-1"],
      orphanExchangeOrders: ["orphan-1"],
      reconciledOrders: ["client-2"],
      cancelledOrders: ["client-1", "orphan-1"],
      dustPositions: ["hype-usd"],
      dustCloseIntents: ["dust-intent-1"],
      prunedTelemetryCount: 2
    });
  });

  it("suppresses cleanup warnings when only healthy reconciliation occurred", () => {
    const result = buildJanitorReport({
      baseReport: janitorState(),
      reconciliation: {
        orderMap: {},
        reconciledOrders: ["client-2"],
        orphanExchangeOrders: [],
        cancelledOrders: [],
        cancellationRequests: []
      },
      dustCloseIntents: [],
      pruneReport: logPruneReport({ totalRows: 0 })
    });

    expect(result.shouldWarn).toBe(false);
    expect(result.report.reconciledOrders).toEqual(["client-2"]);
  });

  it("builds janitor cleanup warning metadata with serialized prune context", () => {
    expect(
      janitorCleanupRequiredLogMetadata({
        source: "ADMIN",
        report: janitorState({
          zombieOrders: ["zombie-1"],
          orphanExchangeOrders: ["orphan-1"],
          cancelledOrders: ["cancelled-1"],
          dustPositions: ["dust-1"],
          dustCloseIntents: ["intent-1"],
          prunedTelemetryCount: 3
        }),
        pruneReport: logPruneReport({ totalRows: 3, telemetryRows: 2, marketTickRows: 1 })
      })
    ).toMatchObject({
      source: "ADMIN",
      zombieOrders: ["zombie-1"],
      orphanExchangeOrders: ["orphan-1"],
      cancelledOrders: ["cancelled-1"],
      dustPositions: ["dust-1"],
      dustCloseIntents: ["intent-1"],
      prunedTelemetryCount: 3,
      pruneReport: {
        telemetryRows: 2,
        marketTickRows: 1,
        totalRows: 3,
        policy: {
          generatedAt: OBSERVED_AT,
          maxTelemetryRows: 15_000
        }
      }
    });
  });

  it("fetches exchange open orders through the executioner binding", async () => {
    const { logger } = loggerSpy();
    const requests: Request[] = [];
    const executioner = {
      async fetch(request: Request) {
        requests.push(request);
        return Response.json({ orders: [exchangeOrder({ exchangeOrderId: "remote-live" })] });
      }
    };

    const orders = await fetchJanitorExchangeOpenOrders({ executioner, logger });

    expect(orders).toHaveLength(1);
    expect(orders[0].exchangeOrderId).toBe("remote-live");
    expect(requests[0].url).toBe("https://executioner.internal/open-orders");
  });

  it("logs executioner open-order failures without throwing", async () => {
    const { logger, errors } = loggerSpy();
    const executioner = {
      async fetch() {
        throw new Error("network offline");
      }
    };

    const orders = await fetchJanitorExchangeOpenOrders({ executioner, logger });

    expect(orders).toEqual([]);
    expect(errors[0]).toMatchObject({
      eventType: "JANITOR_OPEN_ORDERS_FAILED",
      telemetry: { error: "network offline" }
    });
  });

  it("sends janitor cancel requests to the executioner binding", async () => {
    const { logger } = loggerSpy();
    const requests: Request[] = [];
    const executioner = {
      async fetch(request: Request) {
        requests.push(request);
        return Response.json({ ok: true });
      }
    };

    await cancelJanitorOrder({
      executioner,
      logger,
      orderId: "orphan-1",
      reason: "JANITOR_ORPHAN_EXCHANGE_ORDER",
      instrumentCode: "hype-usd"
    });

    expect(requests[0].url).toBe("https://executioner.internal/cancel");
    expect(requests[0].method).toBe("POST");
    await expect(requests[0].json()).resolves.toEqual({
      orderId: "orphan-1",
      instrumentCode: "hype-usd",
      reason: "JANITOR_ORPHAN_EXCHANGE_ORDER"
    });
  });

  it("records post-only dust close skips with position context", () => {
    const { logger, warnings } = loggerSpy();

    const intentId = recordPostOnlyDustCloseSkip({
      openPositions: {
        "hype-usd": {
          instrumentCode: "hype-usd",
          side: "LONG",
          quantity: 0.0000004,
          averageEntryPrice: 30,
          markPrice: 31,
          unrealizedPnl: 0.1,
          realizedPnl: 0,
          updatedAt: OBSERVED_AT
        }
      },
      logger,
      instrumentCode: "hype-usd",
      observedAt: OBSERVED_AT
    });

    expect(intentId).toBeNull();
    expect(warnings[0]).toMatchObject({
      eventType: "JANITOR_DUST_CLOSE_SKIPPED",
      telemetry: {
        instrumentCode: "hype-usd",
        side: "LONG",
        quantity: 0.0000004,
        observedAt: OBSERVED_AT,
        inventoryProtocol: "POST_ONLY_SKEW"
      }
    });
  });

  it("merges janitor reports back into engine state", () => {
    const previous = {
      bankroll: 500,
      orderMap: {
        "old-order": order({ clientId: "old-order" })
      },
      janitor: janitorState({ zombieOrders: ["old-order"] }),
      updatedAt: "2026-05-18T15:00:00.000Z",
      heartbeatAt: "2026-05-18T15:00:00.000Z"
    } as EngineState;
    const nextOrderMap = {
      "new-order": order({ clientId: "new-order", status: "OPEN" })
    };
    const report = janitorState({ reconciledOrders: ["new-order"] });

    expect(
      stateAfterJanitorRun({
        state: previous,
        orderMap: nextOrderMap,
        report,
        observedAt: OBSERVED_AT
      })
    ).toMatchObject({
      bankroll: 500,
      orderMap: nextOrderMap,
      janitor: report,
      updatedAt: OBSERVED_AT,
      heartbeatAt: OBSERVED_AT
    });
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

function janitorState(overrides: Partial<JanitorState> = {}): JanitorState {
  return {
    lastRunAt: OBSERVED_AT,
    zombieOrders: [],
    orphanExchangeOrders: [],
    reconciledOrders: [],
    cancelledOrders: [],
    dustPositions: [],
    dustCloseIntents: [],
    prunedTelemetryCount: 0,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function logPruneReport(overrides: Partial<LogPruneReport> = {}): LogPruneReport {
  return {
    policy: {
      generatedAt: OBSERVED_AT,
      telemetryRetentionDays: 3,
      lowValueRetentionDays: 2,
      marketTickRetentionDays: 3,
      maxTelemetryRows: 15_000,
      maxOperationalInfoRows: 50_000,
      maxMarketTickRows: 25_000,
      telemetryCutoff: OBSERVED_AT,
      lowValueCutoff: OBSERVED_AT,
      marketTickCutoff: OBSERVED_AT
    },
    telemetryRows: 0,
    lowValueOperationalRows: 0,
    cappedOperationalInfoRows: 0,
    marketTickRows: 0,
    totalRows: 0,
    ...overrides
  };
}

function loggerSpy(): {
  logger: JanitorExecutionLogger;
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

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  assertOrderBookDelta,
  assertOrderBookSnapshot,
  handleBookAdminRoute
} from "../../src/engine/trading/routes/BookAdminRoutes";
import {
  buildCascadeBacktestConfig,
  buildCascadeBacktestSummary,
  handleCascadeAdminRoute
} from "../../src/engine/trading/routes/CascadeAdminRoutes";
import {
  buildReplayInvocation,
  handleReplayAdminRoute,
  sanitizeReplayScenario
} from "../../src/engine/trading/routes/ReplayAdminRoutes";
import type { Backtester } from "../../src/strategy/cascade/Backtester";
import type {
  BookSnapshotResponse,
  DomAnalysisSnapshot,
  EngineState,
  LiquidationHeatmapState,
  OrderBookDelta,
  OrderBookResetRequest,
  OrderBookSnapshot,
  ReplayResult
} from "../../src/types";

type JsonObject = Record<string, unknown>;

async function responseJson(response: Response | null): Promise<JsonObject> {
  if (response === null) {
    throw new Error("EXPECTED_ROUTE_RESPONSE");
  }

  return (await response.json()) as JsonObject;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://engine.test${path}`, init);
}

function url(path: string): URL {
  return new URL(`https://engine.test${path}`);
}

function jsonRequest(path: string, body: unknown): Request {
  return request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

const snapshot: OrderBookSnapshot = {
  schemaVersion: "order-book.snapshot.v1",
  instrumentCode: "btc-usd",
  exchangeCode: "hyperliquid",
  sequence: 1,
  exchangeTimestamp: "2026-05-18T00:00:00.000Z",
  receivedAt: "2026-05-18T00:00:00.001Z",
  source: "ADMIN",
  source_exchange: "hyperliquid",
  bids: [{ price: 100, size: 1 }],
  asks: [{ price: 101, size: 2 }]
};

const delta: OrderBookDelta = {
  schemaVersion: "order-book.delta.v1",
  instrumentCode: "btc-usd",
  exchangeCode: "hyperliquid",
  sequence: 2,
  exchangeTimestamp: "2026-05-18T00:00:01.000Z",
  receivedAt: "2026-05-18T00:00:01.001Z",
  source: "ADMIN",
  source_exchange: "hyperliquid",
  side: "bid",
  price: 100,
  size: 1
};

describe("book admin routes", () => {
  it("routes book snapshots, deltas, resets, connection registration, and read endpoints", async () => {
    const calls: string[] = [];
    const context = {
      maxSnapshotDepth: 50,
      getEngineState: () => ({ engineId: "engine-1" }) as unknown as EngineState,
      currentBookSnapshot: (instrumentCode: string | undefined, depth: number) =>
        ({ instrumentCode, topLevelCount: depth }) as unknown as BookSnapshotResponse,
      currentDomHeatmap: (instrumentCode: string | undefined) =>
        ({ instrumentCode, schemaVersion: "dom.analysis.v1" }) as unknown as DomAnalysisSnapshot,
      currentLiquidationHeatmap: () =>
        ({ schemaVersion: "liquidation.heatmap.v1" }) as unknown as LiquidationHeatmapState,
      applySnapshot: async (value: OrderBookSnapshot) => {
        calls.push(`snapshot:${value.sequence}`);
      },
      applyDelta: async (value: OrderBookDelta) => {
        calls.push(`delta:${value.sequence}`);
        return {
          accepted: true,
          timeToBookMs: 1,
          actualSequence: value.sequence,
          book: { sequence: value.sequence } as never
        };
      },
      enqueueOrderBookReset: async (payload: Partial<OrderBookResetRequest>) => {
        calls.push(`reset:${payload.reason ?? "none"}`);
      },
      registerIngestConnection: (payload: Partial<OrderBookResetRequest>) => ({
        reason: payload.reason ?? null
      })
    };

    expect(
      await responseJson(
        await handleBookAdminRoute(
          request("/book/snapshot?instrument=btc-usd&depth=10"),
          url("/book/snapshot?instrument=btc-usd&depth=10"),
          context
        )
      )
    ).toMatchObject({ instrumentCode: "btc-usd", topLevelCount: 10 });
    expect(
      await responseJson(
        await handleBookAdminRoute(
          request("/dom/heatmap?instrument=btc-usd"),
          url("/dom/heatmap?instrument=btc-usd"),
          context
        )
      )
    ).toMatchObject({ instrumentCode: "btc-usd" });
    expect(
      await responseJson(
        await handleBookAdminRoute(
          request("/liquidations/heatmap"),
          url("/liquidations/heatmap"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await responseJson(
        await handleBookAdminRoute(
          jsonRequest("/book/snapshot", snapshot),
          url("/book/snapshot"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await responseJson(
        await handleBookAdminRoute(jsonRequest("/book/delta", delta), url("/book/delta"), context)
      )
    ).toMatchObject({ ok: true, accepted: true, timeToBookMs: 1 });
    expect(
      await responseJson(
        await handleBookAdminRoute(
          jsonRequest("/reset-book", { reason: "operator" }),
          url("/reset-book"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await responseJson(
        await handleBookAdminRoute(
          jsonRequest("/ingest/connection", { reason: "stream-open" }),
          url("/ingest/connection"),
          context
        )
      )
    ).toMatchObject({ ok: true, registration: { reason: "stream-open" } });
    expect(await handleBookAdminRoute(request("/unknown"), url("/unknown"), context)).toBeNull();
    expect(calls).toEqual(["snapshot:1", "delta:2", "reset:operator"]);
  });

  it("rejects malformed book payloads", () => {
    expect(assertOrderBookSnapshot(snapshot)).toBe(snapshot);
    expect(assertOrderBookDelta(delta)).toBe(delta);
    expect(() => {
      assertOrderBookSnapshot({ ...snapshot, bids: [{ price: -1, size: 1 }] });
    }).toThrow("INVALID_ORDER_BOOK_SNAPSHOT");
    expect(() => {
      assertOrderBookDelta({ ...delta, side: "unknown" as never });
    }).toThrow("INVALID_ORDER_BOOK_DELTA");
  });
});

describe("replay admin routes", () => {
  it("normalizes replay payloads and routes start/status requests", async () => {
    const invocation = buildReplayInvocation(
      {
        limit: 999_999,
        shadowBankroll: 300,
        speedMultiplier: 2,
        from: "2026-05-18T00:00:00Z",
        to: "not-a-date",
        scenario: "LATENCY_SHOCK",
        latencyMs: 25,
        slippageBps: 3,
        feeBps: 0.5,
        exitAfterTicks: 999,
        walkForward: true,
        sentimentAblation: false,
        strategyVersionId: " strategy-v1 ",
        actor: " moltworker "
      },
      1
    );

    expect(invocation).toMatchObject({
      limit: 5_000,
      shadowBankroll: 300,
      speedMultiplier: 2,
      dateTo: null,
      options: {
        scenario: "LATENCY_SHOCK",
        exitAfterTicks: 500,
        walkForward: true,
        sentimentAblation: false,
        strategyVersionId: "strategy-v1",
        actor: "moltworker"
      }
    });
    expect(sanitizeReplayScenario("NOPE")).toBe("BASELINE");

    const context = {
      exchangeFeeBps: 1,
      getEngineState: () => ({ engineId: "engine-1" }) as unknown as EngineState,
      runHistoricalReplay: async (limit: number) =>
        ({
          replayId: `replay-${limit}`,
          shadowTrades: []
        }) as unknown as ReplayResult,
      currentReplayStatus: async () => ({
        replayId: null,
        status: "IDLE" as const,
        ticksTotal: 0,
        ticksProcessed: 0,
        progressPct: 0,
        speedMultiplier: 1,
        shadowBankroll: 0,
        dateFrom: null,
        dateTo: null,
        error: null,
        startedAt: null,
        updatedAt: "2026-05-18T00:00:00.000Z",
        completedAt: null
      })
    };

    expect(
      await responseJson(
        await handleReplayAdminRoute(
          jsonRequest("/admin/replay", { limit: 5 }),
          url("/admin/replay"),
          context
        )
      )
    ).toMatchObject({ ok: true, replay: { replayId: "replay-5" } });
    expect(
      await responseJson(
        await handleReplayAdminRoute(
          request("/admin/replay/status"),
          url("/admin/replay/status"),
          context
        )
      )
    ).toMatchObject({ ok: true, replay: { status: "IDLE" } });
    expect(await handleReplayAdminRoute(request("/none"), url("/none"), context)).toBeNull();
  });
});

describe("cascade admin routes", () => {
  const report = {
    fromDate: "2026-01-01",
    toDate: "2026-02-01",
    instruments: ["BTC"],
    trades: [{ status: "ENTRY" }, { status: "EXIT" }],
    totalPnl: 12,
    maxDrawdownPct: 0.02,
    validation: { ok: true },
    dataQuality: { ok: true },
    perAssetStats: { BTC: { pnl: 12 } }
  } as unknown as Awaited<ReturnType<Backtester["run"]>>;

  it("builds backtest config and summary", () => {
    expect(
      buildCascadeBacktestConfig(
        { ...defaultConfig, CASCADE_WINDOW_MS: 123, EXCHANGE_FEE_BPS: 4 },
        { CASCADE_MIN_BASELINE_WINDOWS: "5", CASCADE_MIN_SEPARATION_MS: "456" }
      )
    ).toMatchObject({
      feeBps: 4,
      cascadeWindowMs: 123,
      cascadeMinBaselineWindows: 5,
      cascadeMinSeparationMs: 456
    });
    expect(buildCascadeBacktestSummary(report)).toMatchObject({
      tradeCount: 1,
      totalPnl: 12,
      positiveExpectancy: true
    });
  });

  it("routes cascade backtests, snapshots, closes, heat, and blackout actions", async () => {
    const persisted: unknown[] = [];
    const context = {
      signalBufferLimit: 500,
      cachedConfig: defaultConfig,
      env: { CASCADE_MIN_BASELINE_WINDOWS: "3", CASCADE_MIN_SEPARATION_MS: "1000" },
      cascadeBacktester: {
        run: async () => report
      },
      persistBacktestSummary: (summary: unknown) => {
        persisted.push(summary);
      },
      currentCascadeActiveSnapshot: () => [{ id: "cascade-1" }],
      currentCascadeSignalSnapshot: (limit: number) => [{ limit }],
      currentCascadePositionSnapshot: () => [{ id: "pos-1" }],
      closeCascadePosition: async (positionId: string, actor: string, reason: string) => ({
        ok: positionId === "pos-1",
        positionId,
        actor,
        reason
      }),
      currentCascadeHeatSnapshot: () => ({ heat: 1 }),
      addNewsBlackout: async (payload: { title: string }) => ({ title: payload.title })
    };

    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          jsonRequest("/admin/backtest/cascade", {
            fromDate: "2026-01-01",
            toDate: "2026-02-01",
            instruments: ["BTC"],
            startingEquity: 1_000,
            candles: [],
            liquidations: []
          }),
          url("/admin/backtest/cascade"),
          context
        )
      )
    ).toMatchObject({ ok: true, report: { totalPnl: 12 } });
    expect(persisted).toHaveLength(1);
    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          request("/admin/cascade/active"),
          url("/admin/cascade/active"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          request("/admin/cascade/signals?limit=999"),
          url("/admin/cascade/signals?limit=999"),
          context
        )
      )
    ).toMatchObject({ signals: [{ limit: 500 }] });
    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          request("/admin/cascade/positions"),
          url("/admin/cascade/positions"),
          context
        )
      )
    ).toMatchObject({ positions: [{ id: "pos-1" }] });
    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          jsonRequest("/admin/cascade/positions/pos-1/close", {
            actor: "admin",
            reason: "test"
          }),
          url("/admin/cascade/positions/pos-1/close"),
          context
        )
      )
    ).toMatchObject({ ok: true, actor: "admin", reason: "test" });
    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          request("/admin/cascade/heat"),
          url("/admin/cascade/heat"),
          context
        )
      )
    ).toMatchObject({ ok: true, heat: { heat: 1 } });
    expect(
      await responseJson(
        await handleCascadeAdminRoute(
          jsonRequest("/news/blackout", {
            title: "FOMC",
            startsAt: "2026-05-18T00:00:00Z",
            endsAt: "2026-05-18T01:00:00Z"
          }),
          url("/news/blackout"),
          context
        )
      )
    ).toMatchObject({ ok: true, calendar: { title: "FOMC" } });
    expect(
      (
        await handleCascadeAdminRoute(
          jsonRequest("/admin/cascade/blackout", { title: "bad" }),
          url("/admin/cascade/blackout"),
          context
        )
      )?.status
    ).toBe(400);
    expect(await handleCascadeAdminRoute(request("/none"), url("/none"), context)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  loadReplayShadowTradesFromJournal,
  loadScenarioReplayTicksFromJournal
} from "../../src/engine/trading/replay/ReplayDataRuntime";
import type { ReplayTradeRow } from "../../src/engine/trading/replay/ReplayJournal";
import type { MarketTick } from "../../src/types";

describe("ReplayDataRuntime", () => {
  it("loads replay ticks and applies the selected scenario transform", async () => {
    const sourceTicks = [
      tick("2026-05-01T00:00:00.000Z", 100),
      tick("2026-05-01T00:00:01.000Z", 200)
    ];

    const loaded = await loadScenarioReplayTicksFromJournal({
      replayJournal: {
        loadTicks: async (limit, dateFrom, dateTo) => {
          expect({ limit, dateFrom, dateTo }).toEqual({
            limit: 2,
            dateFrom: "2026-05-01",
            dateTo: "2026-05-02"
          });
          return sourceTicks;
        }
      },
      limit: 2,
      dateFrom: "2026-05-01",
      dateTo: "2026-05-02",
      scenario: "DELEVERAGING_2022"
    });

    expect(loaded.sourceTicks).toBe(sourceTicks);
    expect(loaded.ticks[0]).toMatchObject({
      price: 100,
      size: 1.4,
      raw: { replayScenario: "DELEVERAGING_2022" }
    });
    expect(loaded.ticks[1]).toMatchObject({
      price: 164,
      size: 2.4,
      raw: { replayScenario: "DELEVERAGING_2022" }
    });
    expect(sourceTicks[1]).toMatchObject({ price: 200, size: 1, raw: {} });
  });

  it("loads historical shadow trades over the replay tick window", async () => {
    const ticks = [
      tick("2026-05-01T00:00:00.000Z", 100),
      tick("2026-05-01T00:00:01.000Z", 101),
      tick("2026-05-01T00:00:02.000Z", 104)
    ];
    const trades: ReplayTradeRow[] = [
      {
        trade_id: "trade-1",
        asset: "BTC-USD",
        side: "BUY",
        price: 100,
        size: 2,
        executed_at: "2026-05-01T00:00:01.500Z",
        status: "FILLED"
      }
    ];

    const loaded = await loadReplayShadowTradesFromJournal({
      replayJournal: {
        loadTrades: async (dateFrom, dateTo) => {
          expect({ dateFrom, dateTo }).toEqual({
            dateFrom: "2026-05-01T00:00:00.000Z",
            dateTo: "2026-05-01T00:00:02.000Z"
          });
          return trades;
        }
      },
      ticks
    });

    expect(loaded.historicalTrades).toBe(trades);
    expect(loaded.shadowTrades).toEqual([
      expect.objectContaining({
        tradeId: "shadow:trade-1",
        instrumentCode: "btc-usd",
        side: "BUY",
        entryPrice: 100,
        exitPrice: 104,
        size: 2,
        theoreticalPnl: 8,
        openedAt: "2026-05-01T00:00:01.500Z",
        closedAt: "2026-05-01T00:00:02.000Z"
      })
    ]);
  });

  it("does not query historical trades when the replay tick window is empty", async () => {
    let loadTradesCalls = 0;

    const loaded = await loadReplayShadowTradesFromJournal({
      replayJournal: {
        loadTrades: async () => {
          loadTradesCalls += 1;
          return [];
        }
      },
      ticks: []
    });

    expect(loadTradesCalls).toBe(0);
    expect(loaded).toEqual({ historicalTrades: [], shadowTrades: [] });
  });
});

function tick(receivedAt: string, price: number): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    streamId: "stream",
    connectionId: "connection",
    sourceChannel: "trades",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price,
    size: 1,
    side: "buy",
    sequence: price,
    providerTimestamp: receivedAt,
    exchangeTimestamp: receivedAt,
    synchronizedExchangeTimestamp: receivedAt,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight: 1,
    raw: {}
  };
}

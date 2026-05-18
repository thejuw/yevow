import { describe, expect, it } from "vitest";
import { buildPaperLedger, type PaperLedgerFillInput } from "../../src/PaperLedger";

describe("paper ledger", () => {
  it("pairs paper fills into FIFO entries and exits with realized PnL", () => {
    const ledger = buildPaperLedger([
      fill({
        tradeId: "fill-1",
        side: "SELL",
        price: 100,
        size: 2,
        fees: 0.2,
        executedAt: "2026-05-18T00:00:00.000Z"
      }),
      fill({
        tradeId: "fill-2",
        side: "BUY",
        price: 90,
        size: 1,
        fees: 0.1,
        executedAt: "2026-05-18T00:01:00.000Z"
      })
    ]);

    expect(ledger.summary.fillCount).toBe(2);
    expect(ledger.summary.entryCount).toBe(1);
    expect(ledger.summary.exitCount).toBe(1);
    expect(ledger.summary.realizedGrossPnl).toBe(10);
    expect(ledger.summary.realizedNetPnl).toBe(9.8);
    expect(ledger.positions).toHaveLength(1);
    expect(ledger.positions[0]).toMatchObject({
      asset: "hype-usd",
      side: "SHORT",
      quantity: 1,
      averageEntryPrice: 100
    });
    expect(ledger.positions[0].entryFeesRemaining).toBe(0.1);
  });

  it("records a flip when a closing fill exceeds the open position", () => {
    const ledger = buildPaperLedger([
      fill({
        tradeId: "long-entry",
        side: "BUY",
        price: 50,
        size: 1,
        fees: 0,
        executedAt: "2026-05-18T00:00:00.000Z"
      }),
      fill({
        tradeId: "sell-flip",
        side: "SELL",
        price: 55,
        size: 2,
        fees: 0,
        executedAt: "2026-05-18T00:02:00.000Z"
      })
    ]);

    expect(ledger.events.map((event) => event.type)).toEqual(["ENTRY", "EXIT", "FLIP"]);
    expect(ledger.summary.realizedNetPnl).toBe(5);
    expect(ledger.positions[0]).toMatchObject({
      side: "SHORT",
      quantity: 1,
      averageEntryPrice: 55
    });
  });
});

function fill(input: {
  tradeId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  fees: number;
  executedAt: string;
}): PaperLedgerFillInput {
  return {
    tradeId: input.tradeId,
    orderId: input.tradeId,
    asset: "hype-usd",
    side: input.side,
    price: input.price,
    size: input.size,
    notional: input.price * input.size,
    fees: input.fees,
    status: "GHOST_FILL",
    primaryDriver: "PROFILER",
    rawExecution: {},
    executedAt: input.executedAt,
    createdAt: input.executedAt
  };
}

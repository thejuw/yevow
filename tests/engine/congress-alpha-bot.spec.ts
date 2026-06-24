import { describe, expect, it } from "vitest";
import {
  buildCongressAlphaTargets,
  planCongressAlphaPaperOrders,
  scoreCongressAlphaCandidate
} from "../../src/gateway/CongressAlphaBotGateway";
import { buildSchedulerStatus } from "../../src/gateway/congressAlpha/Scheduler";
import { normalizeAlphaSettings } from "../../src/gateway/congressAlpha/Settings";

describe("congress alpha paper bot", () => {
  it("scores broad bipartisan purchase flow above sale-heavy disclosures", () => {
    const asOf = "2026-06-24T12:00:00.000Z";
    const strong = scoreCongressAlphaCandidate({
      transactionCount: 8,
      purchaseCount: 7,
      saleCount: 1,
      purchaseAmountMid: 1_000_000,
      saleAmountMid: 50_000,
      netAmountMid: 950_000,
      memberCount: 4,
      conflictCount: 2,
      democraticPurchaseCount: 3,
      republicanPurchaseCount: 2,
      latestTradeAt: "2026-06-20T12:00:00.000Z",
      asOf
    });
    const weak = scoreCongressAlphaCandidate({
      transactionCount: 5,
      purchaseCount: 1,
      saleCount: 4,
      purchaseAmountMid: 50_000,
      saleAmountMid: 700_000,
      netAmountMid: -650_000,
      memberCount: 1,
      conflictCount: 0,
      democraticPurchaseCount: 1,
      republicanPurchaseCount: 0,
      latestTradeAt: "2026-03-01T12:00:00.000Z",
      asOf
    });

    expect(strong.direction).toBe("LONG");
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(weak.direction).not.toBe("LONG");
  });

  it("caps target weights and skips unpriced signals", () => {
    const targets = buildCongressAlphaTargets(
      [
        signal("AAA", 95, 120),
        signal("BBB", 85, 50),
        signal("CCC", 70, null),
        signal("DDD", 25, 20)
      ],
      {
        bankroll: 10_000,
        maxPositions: 3,
        minScore: 35,
        maxWeightPct: 10
      }
    );

    expect(targets.map((target) => target.symbol)).toEqual(["AAA", "BBB"]);
    expect(targets.every((target) => target.targetWeightPct <= 10)).toBe(true);
    expect(targets[0].targetNotional).toBeLessThanOrEqual(1_000);
    expect(targets[0].referencePrice).toBe(120);
  });

  it("plans buy orders and position marks without mutating D1", () => {
    const [target] = buildCongressAlphaTargets([signal("AAA", 90, 100)], {
      bankroll: 10_000,
      maxPositions: 1,
      minScore: 35,
      maxWeightPct: 10
    });

    const plan = planCongressAlphaPaperOrders([], "run-1", [target]);

    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]).toMatchObject({
      symbol: "AAA",
      side: "BUY",
      limitPrice: 100,
      notional: 1000
    });
    expect(plan.upserts[0]).toMatchObject({
      symbol: "AAA",
      quantity: 10,
      marketValue: 1000,
      unrealizedPnl: 0
    });
    expect(plan.deletes).toEqual([]);
  });

  it("suppresses tiny rebalance orders while still refreshing marks", () => {
    const [target] = buildCongressAlphaTargets([signal("AAA", 90, 100)], {
      bankroll: 10_200,
      maxPositions: 1,
      minScore: 35,
      maxWeightPct: 10
    });
    const existing = [
      {
        symbol: "AAA",
        quantity: 10,
        avg_price: 99,
        market_price: 100,
        market_value: 1000,
        unrealized_pnl: 10,
        target_weight_pct: 10,
        updated_at: "2026-06-24T12:00:00.000Z"
      }
    ];

    const plan = planCongressAlphaPaperOrders(existing, "run-2", [target]);

    expect(plan.orders).toHaveLength(0);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0].marketValue).toBe(1020);
  });

  it("plans stale target exits", () => {
    const existing = [
      {
        symbol: "OLD",
        quantity: 4,
        avg_price: 25,
        market_price: 30,
        market_value: 120,
        unrealized_pnl: 20,
        target_weight_pct: 1.2,
        updated_at: "2026-06-24T12:00:00.000Z"
      }
    ];

    const plan = planCongressAlphaPaperOrders(existing, "run-3", []);

    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]).toMatchObject({
      symbol: "OLD",
      side: "SELL",
      quantity: 4,
      notional: 120
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes).toEqual(["OLD"]);
  });

  it("normalizes unsafe settings into bounded paper-bot limits", () => {
    const settings = normalizeAlphaSettings({
      bankroll: -1,
      maxPositions: 999,
      minScore: 0,
      maxWeightPct: 200,
      lookbackDays: 10_000,
      autoRunEnabled: false
    });

    expect(settings).toMatchObject({
      bankroll: 100,
      maxPositions: 50,
      minScore: 1,
      maxWeightPct: 50,
      lookbackDays: 730,
      autoRunEnabled: false
    });
  });

  it("reports the local midnight scheduler window", () => {
    const status = buildSchedulerStatus({
      autoRunEnabled: true,
      timezone: "America/Chicago",
      now: new Date("2026-06-24T18:15:00.000Z"),
      lastScheduledRunAt: "2026-06-24T05:00:00.000Z"
    });

    expect(status).toMatchObject({
      autoRunEnabled: true,
      timezone: "America/Chicago",
      expectedWindowLocal: "00:00",
      nextRunLocalTime: "00:00",
      lastScheduledRunAt: "2026-06-24T05:00:00.000Z"
    });
    expect(status.nextRunHint).toContain("Next eligible scheduler window");
  });
});

function signal(symbol: string, score: number, currentPrice: number | null) {
  return {
    signalId: `signal-${symbol}`,
    runId: "run-1",
    symbol,
    sector: "Technology",
    asOf: "2026-06-24T12:00:00.000Z",
    score,
    confidence: score / 100,
    direction: score >= 35 ? "LONG" : "FLAT",
    horizonDays: 90,
    latestTradeAt: "2026-06-20T12:00:00.000Z",
    currentPrice,
    netAmountMid: 100_000,
    purchaseAmountMid: 120_000,
    saleAmountMid: 20_000,
    transactionCount: 3,
    purchaseCount: 3,
    saleCount: 0,
    memberCount: 2,
    conflictCount: 0,
    bipartisanScore: 0,
    freshnessPenalty: 0,
    rationale: {}
  } as const;
}

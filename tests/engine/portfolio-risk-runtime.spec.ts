import { describe, expect, it } from "vitest";
import { calculatePortfolioRisk } from "../../src/engine/trading/risk/PortfolioRiskRuntime";
import type { Position } from "../../src/types";

const OBSERVED_AT = "2026-05-18T12:00:00.000Z";

describe("PortfolioRiskRuntime", () => {
  it("calculates drawdown, one-hour VaR, and trading eligibility", () => {
    const result = calculatePortfolioRisk({
      mode: "LIVE",
      equity: 900,
      priorHighWaterMark: 1_000,
      positions: {
        btc: position("btc-usd", "LONG", 0.1, 100_000),
        hype: position("hype-usd", "SHORT", 100, 5)
      },
      oracleVolatility: 0.02,
      varConfidenceZ: 2.33,
      maxDrawdownPct: 0.2,
      tradingEnabled: true,
      observedAt: OBSERVED_AT
    });

    expect(result.drawdownBreached).toBe(false);
    expect(result.metrics.highWaterMark).toBe(1_000);
    expect(result.metrics.rollingDrawdownPct).toBe(0.1);
    expect(result.metrics.var99OneHour).toBeCloseTo(3_790.1015026, 6);
    expect(result.metrics.isTradingEnabled).toBe(true);
  });

  it("resets implausible paper high-water marks and fails closed on drawdown breaches", () => {
    const paper = calculatePortfolioRisk({
      mode: "PAPER",
      equity: 1_000,
      priorHighWaterMark: 100_000,
      positions: {},
      oracleVolatility: 0.02,
      varConfidenceZ: 2.33,
      maxDrawdownPct: 0.2,
      tradingEnabled: true,
      observedAt: OBSERVED_AT
    });

    expect(paper.drawdownBreached).toBe(false);
    expect(paper.metrics.highWaterMark).toBe(1_000);

    const breached = calculatePortfolioRisk({
      mode: "LIVE",
      equity: 700,
      priorHighWaterMark: 1_000,
      positions: {},
      oracleVolatility: 0.02,
      varConfidenceZ: 2.33,
      maxDrawdownPct: 0.2,
      tradingEnabled: true,
      observedAt: OBSERVED_AT
    });

    expect(breached.drawdownBreached).toBe(true);
    expect(breached.metrics.isTradingEnabled).toBe(false);
    expect(breached.metrics.rollingDrawdownPct).toBe(0.3);
  });
});

function position(
  instrumentCode: string,
  side: "LONG" | "SHORT",
  quantity: number,
  markPrice: number
): Position {
  return {
    instrumentCode,
    side,
    quantity,
    averageEntryPrice: markPrice,
    markPrice,
    unrealizedPnl: 0,
    realizedPnl: 0,
    updatedAt: OBSERVED_AT
  };
}

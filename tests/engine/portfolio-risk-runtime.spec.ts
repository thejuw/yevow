import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  applyDrawdownKillSwitchSideEffects,
  buildDrawdownKillSwitchTransition,
  calculatePortfolioRisk,
  type DrawdownKillSwitchSideEffectHandlers
} from "../../src/engine/trading/risk/PortfolioRiskRuntime";
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

  it("builds drawdown kill-switch config and notification artifacts", () => {
    const transition = buildDrawdownKillSwitchTransition({
      cachedConfig: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MAX_DRAWDOWN_PCT: 0.2,
        version: "risk-v1"
      },
      metrics: {
        highWaterMark: 1_000,
        rollingDrawdownPct: 0.3,
        var99OneHour: 0,
        isTradingEnabled: false,
        updatedAt: OBSERVED_AT
      },
      equity: 700,
      observedAt: OBSERVED_AT
    });

    expect(transition.config).toMatchObject({
      TRADING_ENABLED: false,
      updatedAt: OBSERVED_AT,
      updatedBy: "risk:drawdown",
      version: "risk-v1:drawdown"
    });
    expect(transition.cancelReason).toBe("MAX_DRAWDOWN_BREACH");
    expect(transition.notification).toMatchObject({
      priority: "CRITICAL",
      title: "Sovereign-Sigma drawdown kill switch",
      dedupeKey: "risk:max-drawdown",
      metadata: {
        rollingDrawdownPct: 0.3,
        maxDrawdownPct: 0.2,
        highWaterMark: 1_000,
        equity: 700
      }
    });
    expect(transition.notification.message).toContain("30.00%");
    expect(transition.notification.message).toContain("20.00%");
  });

  it("applies drawdown kill-switch side effects in durable-object order", async () => {
    const transition = buildDrawdownKillSwitchTransition({
      cachedConfig: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MAX_DRAWDOWN_PCT: 0.2,
        version: "risk-v1"
      },
      metrics: {
        highWaterMark: 1_000,
        rollingDrawdownPct: 0.3,
        var99OneHour: 0,
        isTradingEnabled: false,
        updatedAt: OBSERVED_AT
      },
      equity: 700,
      observedAt: OBSERVED_AT
    });
    const sideEffects = drawdownKillSwitchSideEffectSpy();

    applyDrawdownKillSwitchSideEffects(transition, sideEffects.handlers);

    expect(sideEffects.events).toEqual([
      "config:false:risk-v1:drawdown",
      "write:false",
      "schedule",
      "cancel:ALL:MAX_DRAWDOWN_BREACH",
      "schedule",
      "notify:risk:max-drawdown"
    ]);

    await Promise.all(sideEffects.scheduled);
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

function drawdownKillSwitchSideEffectSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: DrawdownKillSwitchSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      applyConfig(config) {
        events.push(`config:${config.TRADING_ENABLED}:${config.version}`);
      },
      writeConfig(config) {
        events.push(`write:${config.TRADING_ENABLED}`);
        return Promise.resolve();
      },
      cancelAllQuotes(instrumentCode, reason) {
        events.push(`cancel:${instrumentCode}:${reason}`);
        return Promise.resolve();
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      notify(notification) {
        events.push(`notify:${notification.dedupeKey}`);
      }
    }
  };
}

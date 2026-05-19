import { describe, expect, it } from "vitest";
import {
  ceilToIncrement,
  floorToIncrement,
  formatDecimal,
  maskAddress,
  positive,
  positiveIntegerOrDefault,
  positiveNumberOrDefault,
  positiveOrNull,
  roundLatency,
  shortHash,
  snapPrice
} from "../../src/execution/ExecutionFormatters";
import {
  cappedExecutionPrice,
  evaluateCascadeTakerGate,
  isTakerExecutionStyle,
  resolveExecutionStyle,
  takerExpectedSlippageBps,
  takerSpreadDecision
} from "../../src/execution/ExecutionPricing";
import {
  finiteNumber,
  isRecord,
  numberField,
  requireEndpoint,
  requireString,
  safeJson,
  stringField
} from "../../src/execution/ResponseParsing";
import {
  hyperliquidCloid,
  hyperliquidOrderWire,
  hyperliquidPriceDecimals,
  isReduceOnlyIntent,
  normalizeHyperliquidCloid,
  normalizeOptionalAddress
} from "../../src/execution/HyperliquidWire";
import {
  buildShadowRestingQuoteReport,
  estimateShadowFees
} from "../../src/execution/ShadowExecutionReports";
import type { GlobalRiskConfig, TradeIntent } from "../../src/types";

const baseIntent: TradeIntent = {
  schemaVersion: "trade-intent.v1",
  intentId: "intent-1234567890",
  source: "CROUPIER",
  instrumentCode: "btc-usd",
  marketKey: "hyperliquid:btc-usd",
  action: "BUY",
  orderType: "LIMIT",
  timeInForce: "ALO",
  postOnly: true,
  expectedPrice: 100,
  requestedSize: 0.1,
  approvedSize: 0.1,
  maxSlippageBps: 5,
  confidence: 0.8,
  expectedValue: 0.01,
  rationale: "unit-test",
  riskSnapshot: {},
  createdAt: "2026-01-01T00:00:00.000Z"
};

const cascadeConfig = {
  STRATEGY_MODE: "CASCADE_RECOVERY",
  TRADING_ENABLED: true,
  CASCADE_TAKER_ENABLED: true,
  MAX_SINGLE_ORDER_NOTIONAL_USD: 1_000
} as GlobalRiskConfig;

describe("execution formatters", () => {
  it("snaps and formats exchange decimals deterministically", () => {
    expect(floorToIncrement(1.239, 0.01)).toBe(1.23);
    expect(ceilToIncrement(1.231, 0.01)).toBe(1.24);
    expect(snapPrice(100.019, 0.01, "BUY")).toBe(100.01);
    expect(snapPrice(100.011, 0.01, "SELL")).toBe(100.02);
    expect(Number.isNaN(snapPrice(100.011, 0, "SELL"))).toBe(true);
    expect(formatDecimal(1.23456, 2)).toBe("1.23");
    expect(roundLatency(1.23456)).toBe(1.235);
  });

  it("normalizes numeric and redacted helper values", () => {
    expect(positive(1, "VALUE")).toBe(1);
    expect(() => positive(0, "VALUE")).toThrow("INVALID_VALUE");
    expect(positiveOrNull("1.5")).toBe(1.5);
    expect(positiveOrNull("-1")).toBeNull();
    expect(positiveIntegerOrDefault("12", 1)).toBe(12);
    expect(positiveIntegerOrDefault("0", 7)).toBe(7);
    expect(positiveNumberOrDefault("2.5", 1)).toBe(2.5);
    expect(positiveNumberOrDefault("nope", 3)).toBe(3);
    expect(shortHash("abc")).toBe("7aigaz");
    expect(maskAddress("0x1234567890abcdef")).toBe("0x1234...cdef");
    expect(maskAddress("short")).toBe("configured");
  });
});

describe("execution pricing", () => {
  it("resolves execution styles and taker gating", () => {
    expect(resolveExecutionStyle(baseIntent)).toBe("POST_ONLY_QUOTE");
    expect(resolveExecutionStyle({ ...baseIntent, postOnly: false, orderType: "MARKET" })).toBe(
      "TAKER_MARKET"
    );
    expect(resolveExecutionStyle({ ...baseIntent, postOnly: false, orderType: "IOC" })).toBe(
      "TAKER_IOC"
    );
    expect(isTakerExecutionStyle("TAKER_IOC")).toBe(true);
    expect(isTakerExecutionStyle("POST_ONLY_QUOTE")).toBe(false);
    expect(evaluateCascadeTakerGate(baseIntent, cascadeConfig, true)).toEqual({ ok: true });
    expect(evaluateCascadeTakerGate(baseIntent, cascadeConfig, false)).toEqual({ ok: true });
    expect(
      evaluateCascadeTakerGate(
        { ...baseIntent, requestedSize: 20, approvedSize: 20 },
        cascadeConfig,
        false
      )
    ).toEqual({ ok: false, reason: "MAX_SINGLE_ORDER_NOTIONAL_EXCEEDED", status: 409 });
    expect(
      evaluateCascadeTakerGate(
        baseIntent,
        { ...cascadeConfig, TRADING_ENABLED: false } as GlobalRiskConfig,
        false
      )
    ).toEqual({ ok: false, reason: "TRADING_DISABLED", status: 423 });
  });

  it("guards taker spread, slippage, and market caps", () => {
    expect(takerSpreadDecision(null, 101, 10)).toEqual({
      ok: false,
      reason: "TAKER_BBO_INVALID",
      status: 503
    });
    expect(takerSpreadDecision(100, 110, 10)).toEqual({
      ok: false,
      reason: "TAKER_SPREAD_TOO_WIDE",
      status: 409
    });
    expect(takerSpreadDecision(100, 100.05, 10)).toEqual({ ok: true });
    expect(takerExpectedSlippageBps(baseIntent, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(takerExpectedSlippageBps(baseIntent, 99)).toBeGreaterThan(0);
    expect(takerExpectedSlippageBps({ ...baseIntent, action: "SELL" }, 101)).toBeGreaterThan(0);
    expect(cappedExecutionPrice(baseIntent, 100)).toBe(100);
    expect(
      cappedExecutionPrice({ ...baseIntent, postOnly: false, orderType: "MARKET" }, 100)
    ).toBeGreaterThan(100);
    expect(
      cappedExecutionPrice(
        { ...baseIntent, action: "SELL", postOnly: false, orderType: "MARKET" },
        100
      )
    ).toBeLessThan(100);
  });
});

describe("execution parsing and Hyperliquid wire helpers", () => {
  it("parses records and required fields safely", async () => {
    expect(await safeJson(new Response(JSON.stringify({ ok: true })))).toEqual({ ok: true });
    expect(await safeJson(new Response("not-json"))).toBeNull();
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(stringField({ a: "x", b: 2 }, ["missing", "a"])).toBe("x");
    expect(numberField({ a: "2.5" }, ["a"])).toBe(2.5);
    expect(finiteNumber("bad")).toBeNull();
    expect(requireString("x", "FIELD")).toBe("x");
    expect(() => requireString("", "FIELD")).toThrow("MISSING_FIELD");
    expect(requireEndpoint("https://example.com", "URL")).toBe("https://example.com");
    expect(() => requireEndpoint(undefined, "URL")).toThrow("MISSING_URL");
  });

  it("normalizes Hyperliquid order wire payloads", () => {
    const asset = { coin: "BTC", assetIndex: 0, szDecimals: 4, loadedAt: 1 };
    expect(hyperliquidPriceDecimals(100_000, 6)).toBeLessThanOrEqual(6);
    expect(hyperliquidOrderWire(100.123456, 0.123456, "BUY", asset)).toMatchObject({
      price: "100.12",
      size: "0.1234"
    });
    expect(hyperliquidOrderWire(100.123456, 0.123456, "SELL", asset).price).toBe("100.13");
    expect(hyperliquidCloid("abc")).toMatch(/^0x/);
    expect(normalizeHyperliquidCloid("abc")).toMatch(/^0x/);
    const address = `0x${"a".repeat(40)}`;
    expect(normalizeOptionalAddress(address)).toBe(address);
    expect(() => normalizeOptionalAddress("0xabc")).toThrow("INVALID_HYPERLIQUID_VAULT_ADDRESS");
    expect(normalizeOptionalAddress("")).toBeNull();
    expect(isReduceOnlyIntent({ ...baseIntent, rationale: "closeout reduce-only" })).toBe(true);
    expect(isReduceOnlyIntent(baseIntent)).toBe(false);
  });
});

describe("shadow execution reports", () => {
  it("estimates paper fees and resting quote reports", () => {
    expect(estimateShadowFees({ EXCHANGE_FEE_BPS: "2" } as never, baseIntent)).toBe(0.002);
    expect(estimateShadowFees({ EXCHANGE_FEE_BPS: "bad" } as never, baseIntent)).toBe(0);
    const report = buildShadowRestingQuoteReport(baseIntent, "2026-01-01T00:00:00.000Z");
    expect(report.status).toBe("OPEN");
    expect(report.exchangeOrderId).toBe("shadow-open-intent-1234567890");
    expect(report.filledSize).toBe(0);
  });
});

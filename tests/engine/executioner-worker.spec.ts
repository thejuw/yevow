import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/ExecutionerWorker";
import { defaultConfig } from "../../src/ConfigManager";
import type { Env, TradeIntent } from "../../src/types";

describe("ExecutionerWorker Hyperliquid serialization", () => {
  it("snaps large perp prices and sizes to Hyperliquid wire constraints", () => {
    const wire = __test__.hyperliquidOrderWire(100000.123456789, 0.00123456789, "BUY", {
      coin: "BTC",
      assetIndex: 0,
      szDecimals: 5,
      loadedAt: 1778888000000
    });

    expect(wire.price).toBe("100000");
    expect(wire.size).toBe("0.00123");
    expect(wire.priceRounded).toBe(true);
    expect(wire.sizeRounded).toBe(true);
  });

  it("preserves small prices within the perp decimal cap", () => {
    const wire = __test__.hyperliquidOrderWire(0.00123456, 12.3456, "SELL", {
      coin: "TEST",
      assetIndex: 999,
      szDecimals: 1,
      loadedAt: 1778888000000
    });

    expect(wire.price).toBe("0.00124");
    expect(wire.size).toBe("12.3");
  });

  it("formats taker IOC orders for Hyperliquid with Ioc time-in-force", async () => {
    const request = await __test__.prepareOrderRequest(
      hyperliquidEnv(),
      cascadeIntent({
        executionStyle: "TAKER_IOC",
        orderType: "IOC",
        postOnly: false,
        timeInForce: "IOC"
      }),
      "hyperliquid"
    );
    const body = JSON.parse(String(request.init.body)) as HyperliquidOrderPayload;

    expect(body.action.orders[0].t.limit.tif).toBe("Ioc");
    expect(body.signature).toBeTruthy();
    expect(request.redactedPayload).toMatchObject({ adapter: "hyperliquid", tif: "Ioc" });
  });

  it("converts stop-market intents to capped IOC prices", async () => {
    const request = await __test__.prepareOrderRequest(
      hyperliquidEnv(),
      cascadeIntent({
        executionStyle: "TAKER_MARKET",
        orderType: "MARKET",
        postOnly: false,
        timeInForce: "IOC",
        maxSlippageBps: 5,
        rationale: "cascade stop close stop_loss"
      }),
      "hyperliquid"
    );
    const body = JSON.parse(String(request.init.body)) as HyperliquidOrderPayload;

    expect(body.action.orders[0].t.limit.tif).toBe("Ioc");
    expect(request.redactedPayload).toMatchObject({ originalPrice: 100.15, tif: "Ioc" });
  });

  it("splits sliced TWAP intents into equal IOC child chunks", () => {
    const slices = __test__.buildTwapSlices(
      cascadeIntent({
        intentId: "twap-parent",
        executionStyle: "SLICED_TWAP",
        requestedSize: 10,
        approvedSize: 10,
        expectedPrice: 100
      }),
      { sliceNotionalPerChunk: 300, sliceIntervalMs: 250, sliceJitterMs: 0 }
    );

    expect(slices).toHaveLength(4);
    expect(slices.map((slice) => slice.intent.approvedSize)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(slices.every((slice) => slice.intent.executionStyle === "TAKER_IOC")).toBe(true);
    expect(slices[1].delayMs).toBe(250);
  });

  it("blocks cascade taker intents when the independent taker flag is disabled", () => {
    const decision = __test__.evaluateCascadeTakerGate(
      cascadeIntent({
        executionStyle: "TAKER_IOC",
        orderType: "IOC",
        postOnly: false,
        timeInForce: "IOC"
      }),
      {
        ...defaultConfig,
        TRADING_ENABLED: true,
        STRATEGY_MODE: "CASCADE_RECOVERY",
        CASCADE_TAKER_ENABLED: false
      },
      false
    );

    expect(decision).toEqual({ ok: false, reason: "CASCADE_TAKER_DISABLED", status: 423 });
  });

  it("blocks cascade taker intents outside cascade strategy mode", () => {
    const decision = __test__.evaluateCascadeTakerGate(
      cascadeIntent(),
      {
        ...defaultConfig,
        TRADING_ENABLED: true,
        STRATEGY_MODE: "MARKET_MAKING",
        CASCADE_TAKER_ENABLED: true
      },
      false
    );

    expect(decision).toEqual({
      ok: false,
      reason: "CASCADE_STRATEGY_MODE_DISABLED",
      status: 423
    });
  });

  it("blocks oversized single IOC cascade orders before signing", () => {
    const decision = __test__.evaluateCascadeTakerGate(
      cascadeIntent({ requestedSize: 20, approvedSize: 20, expectedPrice: 100 }),
      {
        ...defaultConfig,
        TRADING_ENABLED: true,
        STRATEGY_MODE: "CASCADE_RECOVERY",
        CASCADE_TAKER_ENABLED: true,
        MAX_SINGLE_ORDER_NOTIONAL_USD: 1_000
      },
      false
    );

    expect(decision).toEqual({
      ok: false,
      reason: "MAX_SINGLE_ORDER_NOTIONAL_EXCEEDED",
      status: 409
    });
  });

  it("allows inventory hedge IOC intents through the separate hedge path", () => {
    const decision = __test__.evaluateCascadeTakerGate(
      cascadeIntent({ rationale: "INVENTORY_HEDGE reduce-only IOC limit" }),
      {
        ...defaultConfig,
        TRADING_ENABLED: false,
        STRATEGY_MODE: "MARKET_MAKING",
        CASCADE_TAKER_ENABLED: false
      },
      true
    );

    expect(decision).toEqual({ ok: true });
  });
});

interface HyperliquidOrderPayload {
  action: {
    orders: {
      p: string;
      t: { limit: { tif: string } };
    }[];
  };
  signature: unknown;
}

function cascadeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "cascade-taker-1",
    traceId: "trace-cascade-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    executionStyle: "TAKER_IOC",
    action: "BUY",
    orderType: "IOC",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: 100,
    expectedPrice: 100,
    requestedSize: 0.2,
    approvedSize: 0.2,
    probabilityWin: 0.55,
    probabilityLoss: 0.45,
    profit: 1,
    loss: 1,
    executionCosts: 0.01,
    adverseSelectionCost: 0.01,
    expectedValue: 0.05,
    minEvThreshold: 0,
    maxSlippageBps: 5,
    confidence: 0.75,
    rationale: "cascade recovery taker entry",
    createdAt: "2026-05-17T00:00:00.000Z",
    ...overrides
  };
}

function hyperliquidEnv(): Env {
  return {
    HL_ASSET_INDEX: "0",
    HL_ASSET: "BTC",
    EXCHANGE_ADAPTER: "hyperliquid",
    EXCHANGE_BASE_URL: "https://api.hyperliquid.xyz",
    HL_AGENT_SECRET: "0x0000000000000000000000000000000000000000000000000000000000000001",
    HL_DEFAULT_TIF: "Alo",
    HL_IS_MAINNET: "true"
  } as unknown as Env;
}

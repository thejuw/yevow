import { beforeEach, describe, expect, it, vi } from "vitest";
import ExecutionerWorker, { __test__ as executionerTest } from "../../src/ExecutionerWorker";
import { defaultConfig, GLOBAL_RISK_SETTINGS_KEY } from "../../src/ConfigManager";
import { IntentIdempotencyLedger } from "../../src/execution/IntentIdempotency";
import { evaluateExecutionRisk, isInventoryHedgeIntent } from "../../src/execution/RiskGuards";
import { SignatureEngine } from "../../src/utils/SignatureEngine";
import type { Env, GlobalRiskConfig, TradeIntent } from "../../src/types";

describe("trade path lifecycle", () => {
  it("normalizes accepted, filled, partial, and rejected execution reports", () => {
    const intent = tradeIntent();

    const accepted = executionerTest.toExecutionReport(
      intent,
      new Response(JSON.stringify({ status: "NEW", orderId: "order-1" }), { status: 200 }),
      { status: "NEW", orderId: "order-1" },
      3
    );
    expect(accepted.status).toBe("OPEN");

    const filled = executionerTest.toExecutionReport(
      intent,
      new Response(
        JSON.stringify({ status: "FILLED", executedQty: "0.2", cummulativeQuoteQty: "20" }),
        {
          status: 200
        }
      ),
      { status: "FILLED", executedQty: "0.2", cummulativeQuoteQty: "20" },
      4
    );
    expect(filled.status).toBe("FILLED");
    expect(filled.filledSize).toBe(0.2);
    expect(filled.achievedPrice).toBe(100);

    const partial = executionerTest.toExecutionReport(
      intent,
      new Response(JSON.stringify({ status: "PARTIALLY_FILLED", executedQty: "0.1" }), {
        status: 200
      }),
      { status: "PARTIALLY_FILLED", executedQty: "0.1" },
      5
    );
    expect(partial.status).toBe("PARTIAL_FILL");
    expect(partial.filledSize).toBe(0.1);

    const rejected = executionerTest.toExecutionReport(
      intent,
      new Response(JSON.stringify({ status: "REJECTED", message: "post-only would cross" }), {
        status: 409
      }),
      { status: "REJECTED", message: "post-only would cross" },
      2
    );
    expect(rejected.status).toBe("REJECTED");
  });
});

describe("execution risk gates", () => {
  it("fails closed when the kill-switch is disabled", () => {
    const decision = evaluateExecutionRisk(tradeIntent(), {
      ...defaultConfig,
      TRADING_ENABLED: false
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("TRADING_DISABLED");
    expect(decision.status).toBe(423);
  });

  it("rejects intents that exceed configured risk limits", () => {
    const decision = evaluateExecutionRisk(tradeIntent({ requestedSize: 2, approvedSize: 2 }), {
      ...defaultConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 1,
      MAX_POSITION_PCT: 0,
      MAX_INVENTORY_UNITS: 0,
      MAX_INVENTORY_DELTA: 0
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("MAX_POSITION_SIZE_EXCEEDED");
    expect(decision.status).toBe(409);
  });

  it("allows only explicitly gated reduce-only IOC inventory hedges when trading is off", () => {
    const intent = hedgeIntent();
    const decision = evaluateExecutionRisk(intent, {
      ...defaultConfig,
      TRADING_ENABLED: false,
      HEDGE_ENABLED: true
    });

    expect(isInventoryHedgeIntent(intent)).toBe(true);
    expect(decision.ok).toBe(true);

    const disabled = evaluateExecutionRisk(intent, {
      ...defaultConfig,
      TRADING_ENABLED: false,
      HEDGE_ENABLED: false
    });
    expect(disabled.ok).toBe(false);
    expect(disabled.reason).toBe("TRADING_DISABLED");
  });

  it("covers hedge-specific and notional risk branches", () => {
    const hedge = hedgeIntent();
    expect(
      evaluateExecutionRisk(hedge, {
        ...defaultConfig,
        TRADING_ENABLED: true,
        HEDGE_ENABLED: false
      }).reason
    ).toBe("HEDGE_DISABLED");
    expect(
      evaluateExecutionRisk(tradeIntent({ requestedSize: 0, approvedSize: 0 }), {
        ...defaultConfig,
        TRADING_ENABLED: true
      }).reason
    ).toBe("INVALID_ORDER_NOTIONAL");
    expect(
      evaluateExecutionRisk(
        tradeIntent({ requestedSize: 2, approvedSize: 2, expectedPrice: 100 }),
        {
          ...defaultConfig,
          TRADING_ENABLED: true,
          MAX_POSITION_SIZE: 0,
          MAX_INVENTORY_UNITS: 1,
          MAX_INVENTORY_DELTA: 0,
          MAX_POSITION_PCT: 0
        }
      ).reason
    ).toBe("MAX_INVENTORY_UNITS_EXCEEDED");
    expect(
      evaluateExecutionRisk(
        tradeIntent({ requestedSize: 2, approvedSize: 2, expectedPrice: 100 }),
        {
          ...defaultConfig,
          TRADING_ENABLED: true,
          MAX_POSITION_SIZE: 0,
          MAX_INVENTORY_UNITS: 0,
          MAX_INVENTORY_DELTA: 1,
          MAX_POSITION_PCT: 0
        }
      ).reason
    ).toBe("MAX_INVENTORY_DELTA_EXCEEDED");
    expect(
      evaluateExecutionRisk(
        tradeIntent({ requestedSize: 2, approvedSize: 2, expectedPrice: 100 }),
        {
          ...defaultConfig,
          TRADING_ENABLED: true,
          MAX_POSITION_SIZE: 0,
          MAX_INVENTORY_UNITS: 0,
          MAX_INVENTORY_DELTA: 0,
          MAX_POSITION_PCT: 0.1
        },
        1_000
      ).reason
    ).toBe("MAX_POSITION_PCT_EXCEEDED");
    expect(
      evaluateExecutionRisk(
        tradeIntent({
          requestedSize: 2,
          approvedSize: 2,
          expectedPrice: 100,
          executionStyle: "SLICED_TWAP"
        }),
        {
          ...defaultConfig,
          TRADING_ENABLED: true,
          MAX_POSITION_SIZE: 0,
          MAX_INVENTORY_UNITS: 0,
          MAX_INVENTORY_DELTA: 0,
          MAX_POSITION_PCT: 0,
          MAX_SINGLE_ORDER_NOTIONAL_USD: 50
        }
      ).ok
    ).toBe(true);
    expect(
      evaluateExecutionRisk(
        tradeIntent({ requestedSize: 2, approvedSize: 2, expectedPrice: 100 }),
        {
          ...defaultConfig,
          TRADING_ENABLED: true,
          MAX_POSITION_SIZE: 0,
          MAX_INVENTORY_UNITS: 0,
          MAX_INVENTORY_DELTA: 0,
          MAX_POSITION_PCT: 0,
          MAX_SINGLE_ORDER_NOTIONAL_USD: 50
        }
      ).reason
    ).toBe("MAX_SINGLE_ORDER_NOTIONAL_EXCEEDED");
  });
});

describe("execution idempotency", () => {
  it("replays duplicate intents and rejects reused ids with different payloads", () => {
    const ledger = new IntentIdempotencyLedger(60_000);
    const intent = tradeIntent();
    const first = ledger.evaluate(intent, 1_000);

    expect(first.kind).toBe("NEW");
    if (first.kind !== "NEW") {
      throw new Error("unexpected ledger state");
    }

    ledger.remember(intent, first.fingerprint, { status: 200, body: { ok: true } }, 1_000);
    expect(ledger.evaluate(intent, 1_001).kind).toBe("REPLAY");
    expect(ledger.evaluate(tradeIntent({ expectedPrice: 101 }), 1_002).kind).toBe("CONFLICT");
  });
});

describe("signature determinism", () => {
  it("produces deterministic Hyperliquid L1 signatures for identical actions", async () => {
    const input = {
      secret: "0x0000000000000000000000000000000000000000000000000000000000000001",
      action: {
        type: "order",
        orders: [{ a: 0, b: true, p: "100", s: "0.1", r: false, t: { limit: { tif: "Alo" } } }],
        grouping: "na"
      },
      nonce: 1_778_888_000_000,
      vaultAddress: null,
      expiresAfter: 1_778_888_010_000,
      isMainnet: true
    };

    await expect(SignatureEngine.signHyperliquidL1Action(input)).resolves.toEqual(
      await SignatureEngine.signHyperliquidL1Action(input)
    );
  });
});

describe("ExecutionerWorker trade safety", () => {
  beforeEach(() => {
    executionerTest.clearIntentLedger();
    vi.restoreAllMocks();
  });

  it("returns a rejected execution report when the kill-switch is off", async () => {
    const env = makeEnv({ TRADING_ENABLED: false });
    const response = await ExecutionerWorker.fetch(
      executeRequest(tradeIntent()),
      env,
      waitUntilContext()
    );
    const body = await response.json<{ error: string; report: { status: string } }>();

    expect(response.status).toBe(423);
    expect(body.error).toBe("TRADING_DISABLED");
    expect(body.report.status).toBe("REJECTED");
  });

  it("keeps shadow-mode post-only intents off the exchange, then allows live-mode dispatch", async () => {
    const exchangeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "NEW", orderId: "live-order-1" }), { status: 200 })
    );
    vi.stubGlobal("fetch", exchangeFetch);

    const shadowEnv = makeEnv({ TRADING_ENABLED: true }, { SHADOW_MODE: "true" });
    const shadowResponse = await ExecutionerWorker.fetch(
      executeRequest(tradeIntent({ intentId: "shadow-live-1" })),
      shadowEnv,
      waitUntilContext()
    );
    const shadowBody = await shadowResponse.json<{ shadowMode: boolean; status: string }>();
    expect(shadowBody.shadowMode).toBe(true);
    expect(shadowBody.status).toBe("OPEN");
    expect(exchangeFetch).not.toHaveBeenCalled();

    executionerTest.clearIntentLedger();
    const liveEnv = makeEnv({ TRADING_ENABLED: true }, { SHADOW_MODE: "false" });
    const liveResponse = await ExecutionerWorker.fetch(
      executeRequest(tradeIntent({ intentId: "shadow-live-1" })),
      liveEnv,
      waitUntilContext()
    );
    const liveBody = await liveResponse.json<{
      shadowMode?: boolean;
      report: { status: string };
    }>();

    expect(liveResponse.status).toBe(200);
    expect(liveBody.shadowMode).toBeUndefined();
    expect(liveBody.report.status).toBe("OPEN");
    expect(exchangeFetch).toHaveBeenCalledTimes(1);
  });

  it("does not submit duplicate live intents twice", async () => {
    const exchangeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "NEW", orderId: "live-order-2" }), { status: 200 })
    );
    vi.stubGlobal("fetch", exchangeFetch);
    const env = makeEnv({ TRADING_ENABLED: true }, { SHADOW_MODE: "false" });
    const intent = tradeIntent({ intentId: "dupe-live-1" });

    const first = await ExecutionerWorker.fetch(executeRequest(intent), env, waitUntilContext());
    const second = await ExecutionerWorker.fetch(executeRequest(intent), env, waitUntilContext());
    const secondBody = await second.json<{ idempotentReplay: boolean }>();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.idempotentReplay).toBe(true);
    expect(exchangeFetch).toHaveBeenCalledTimes(1);
  });

  it("routes shadow-mode inventory hedge IOC intents to ghost fills instead of rejecting taker protocol", async () => {
    const exchangeFetch = vi.fn();
    vi.stubGlobal("fetch", exchangeFetch);
    const env = makeEnv(
      { TRADING_ENABLED: false, HEDGE_ENABLED: true, HEDGE_COOLDOWN_MS: 30_000 },
      { SHADOW_MODE: "true" }
    );
    const response = await ExecutionerWorker.fetch(
      executeRequest(hedgeIntent({ intentId: "hedge-shadow-1" })),
      env,
      waitUntilContext()
    );
    const body = await response.json<{ status: string; shadowMode: boolean }>();

    expect(response.status).toBe(200);
    expect(body.shadowMode).toBe(true);
    expect(body.status).toBe("GHOST_FILL");
    expect(exchangeFetch).not.toHaveBeenCalled();
  });

  it("returns a rejected execution report when cascade taker gates fail", async () => {
    const exchangeFetch = vi.fn();
    vi.stubGlobal("fetch", exchangeFetch);
    const env = makeEnv(
      {
        TRADING_ENABLED: true,
        STRATEGY_MODE: "CASCADE_RECOVERY",
        CASCADE_TAKER_ENABLED: false
      },
      { SHADOW_MODE: "true" }
    );
    const response = await ExecutionerWorker.fetch(
      executeRequest(
        tradeIntent({
          intentId: "cascade-gate-fail-1",
          executionStyle: "TAKER_IOC",
          orderType: "IOC",
          postOnly: false,
          timeInForce: "IOC",
          rationale: "cascade recovery taker entry"
        })
      ),
      env,
      waitUntilContext()
    );
    const body = await response.json<{ error: string; report: { status: string } }>();

    expect(response.status).toBe(423);
    expect(body.error).toBe("CASCADE_TAKER_DISABLED");
    expect(body.report.status).toBe("REJECTED");
    expect(exchangeFetch).not.toHaveBeenCalled();
  });
});

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-croupier-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    action: "BUY",
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "ALO",
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
    maxSlippageBps: 2,
    confidence: 0.75,
    rationale: "test croupier quote",
    createdAt: "2026-05-17T00:00:00.000Z",
    ...overrides
  };
}

function hedgeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return tradeIntent({
    intentId: "hedge-intent-1",
    direction: "SHORT",
    action: "SELL",
    orderType: "IOC",
    postOnly: false,
    timeInForce: "IOC",
    maxSlippageBps: 5,
    rationale: "INVENTORY_HEDGE reduce-only IOC limit",
    ...overrides
  });
}

function executeRequest(intent: TradeIntent): Request {
  return new Request("https://executioner.internal/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent)
  });
}

function makeEnv(config: Partial<GlobalRiskConfig>, overrides: Partial<Env> = {}): Env {
  const storedConfig = {
    ...defaultConfig,
    ...config,
    updatedAt: "2026-05-17T00:00:00.000Z",
    updatedBy: "test",
    version: "test"
  };

  return {
    CONFIG_STORE: mockKv({ [GLOBAL_RISK_SETTINGS_KEY]: storedConfig }),
    RISK_VAULT: mockKv({}),
    TRADING_DB: mockD1(),
    TRADING_ENGINE: mockDurableObjectNamespace(),
    EXCHANGE_ADAPTER: "generic-json",
    EXCHANGE_ORDER_ENDPOINT: "https://exchange.test/order",
    SIGNATURE_ALGORITHM: "HMAC-SHA256",
    EXCHANGE_HMAC_SECRET: "test-secret",
    PAPER_BANKROLL_USD: "1000",
    SHADOW_MODE: "true",
    ...overrides
  } as unknown as Env;
}

function mockKv(seed: Record<string, unknown>): KVNamespace {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    get: async (key: string, type?: "text" | "json") => {
      const value = store.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    }
  } as unknown as KVNamespace;
}

function mockD1(): D1Database {
  return {
    prepare: () =>
      ({
        bind() {
          return this;
        },
        first: async () => ({ ok: 1 }),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true })
      }) as unknown as D1PreparedStatement,
    batch: async () => []
  } as unknown as D1Database;
}

function mockDurableObjectNamespace(): DurableObjectNamespace {
  const stub = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/book/snapshot") {
        return new Response(
          JSON.stringify({
            bestBid: 99,
            bestAsk: 101,
            tickSize: 1,
            bids: [{ price: 99, size: 1 }],
            asks: [{ price: 101, size: 1 }]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  };

  return {
    idFromName: () => ({ toString: () => "test-id" }),
    get: () => stub
  } as unknown as DurableObjectNamespace;
}

function waitUntilContext(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promise.catch(() => undefined);
    },
    passThroughOnException: () => undefined,
    props: {}
  } as ExecutionContext;
}

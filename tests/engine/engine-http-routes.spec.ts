import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  createTradingEngineHttpRouteContext,
  handleTradingEngineHttpRoute,
  type EngineHttpRouteContext,
  type EngineHttpRouteContextTarget
} from "../../src/engine/trading/routes/EngineHttpRoutes";
import type { Backtester } from "../../src/strategy/cascade/Backtester";
import type { NewsCalendar } from "../../src/strategy/cascade/NewsCalendar";
import type {
  AgentSignal,
  EngineState,
  Env,
  ExecutionReport,
  GlobalRiskConfig,
  MarketTick
} from "../../src/types";

type JsonObject = Record<string, unknown>;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://engine.test${path}`, init);
}

function jsonRequest(path: string, body: unknown): Request {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function bodyOf(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function baseState(): EngineState {
  return {
    engineId: "engine-test",
    mode: "PAPER",
    bankroll: { currency: "USD", cash: 100, equity: 100, realizedPnl: 0, updatedAt: "now" },
    openPositions: {},
    agentHealth: {
      ORACLE: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      SENTIMENT: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      PROFILER: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      CROUPIER: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      PIT_BOSS: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      JANITOR: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      EXECUTIONER: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      MOLTWORKER: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      RISK: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 },
      SYSTEM: { status: "YELLOW", heartbeatAt: "now", latencyMs: 0, failures24h: 0 }
    },
    risk: {
      configVersion: "test",
      killSwitch: false,
      maxGrossExposure: 0,
      maxNetExposure: 0,
      maxOrderNotional: 0,
      maxDrawdownPct: 0,
      perAssetMaxPosition: {},
      updatedAt: "now"
    },
    processedTicks: 0,
    acceptedSignals: 0,
    internalOrderBookDepth: 0,
    averageLatency: 0,
    latencySampleCount: 0,
    staleTickCount: 1,
    toxicityScore: 0,
    current_inventory_delta: 0,
    liquidationHeatmap: { schemaVersion: "liquidation.heatmap.v1" } as never,
    maxLatencyMs: 250,
    cachedConfig: { ...defaultConfig, SENTIMENT_ENABLED: false },
    macroBias: { schemaVersion: "macro-bias.v1" } as never,
    temporaryOverride: null,
    assetMatrix: [],
    profilerStates: {},
    location: { colo: "TYO", placement: "smart", isGoldenRegion: true } as never,
    fundingRates: {},
    microstructure: { midPrice: 100 } as never,
    priceDiscovery: { weightedMidPrice: 100 } as never,
    oracle: {} as never,
    sentiment: {} as never,
    ensemble: {} as never,
    leadLag: {} as never,
    inventory: {} as never,
    riskMetrics: {} as never,
    quoteState: {
      status: "SUSPENDED",
      reason: "GRPC_FATAL_DROP",
      suspendedUntil: null,
      lastQuote: null,
      updatedAt: null
    },
    assetQuoteStates: {
      "btc-usd": {
        status: "SUSPENDED",
        reason: "GRPC_FATAL_DROP",
        suspendedUntil: null,
        lastQuote: null,
        updatedAt: null
      }
    },
    shadowQueue: {} as never,
    lastTradeIntent: null,
    inventoryGuard: {} as never,
    janitor: {} as never,
    slippage: { averageSlippageBps: 0 } as never,
    orderMap: {},
    executionProfile: {} as never,
    citadel: {} as never,
    dom: null,
    anomaly: {} as never,
    heartbeatAt: "now",
    updatedAt: "now"
  };
}

function tick(): MarketTick {
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
    baseAsset: "btc",
    quoteAsset: "usd",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 1,
    providerTimestamp: "2026-01-01T00:00:00.000Z",
    exchangeTimestamp: "2026-01-01T00:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-01-01T00:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-01-01T00:00:00.001Z",
    sourceWeight: 1,
    raw: {}
  };
}

function signal(): AgentSignal {
  return {
    schemaVersion: "agent-signal.v1",
    signalId: "sig-1",
    traceId: "trace-1",
    sourceAgent: "ORACLE",
    targetAgent: "CROUPIER",
    instrumentCode: "btc-usd",
    action: "HOLD",
    confidence: 0.5,
    expectedValue: 0,
    featureVector: {},
    rationale: "test",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function createContext(configOverrides: Partial<GlobalRiskConfig> = {}): EngineHttpRouteContext & {
  calls: string[];
} {
  let state = baseState();
  const calls: string[] = [];
  const config = { ...defaultConfig, SENTIMENT_ENABLED: false, ...configOverrides };

  return {
    calls,
    env: {
      CONFIG_STORE: { put: async () => undefined }
    } as unknown as Env,
    state: { waitUntil: () => undefined } as unknown as DurableObjectState,
    logger: {
      error: (eventType: string) => calls.push(`error:${eventType}`),
      info: (eventType: string) => calls.push(`info:${eventType}`),
      warn: (eventType: string) => calls.push(`warn:${eventType}`)
    } as never,
    wakeUpTimeMs: 1,
    getEngineState: () => state,
    setEngineState: (nextState) => {
      state = nextState;
    },
    getOrderBook: () => new Map(),
    getLatencyHistory: () => [{ totalLatencyMs: 1 } as never],
    getProcessingLatencySamples: () => [1, 2, 3],
    getCachedConfig: () => config,
    getCascadeBacktester: () => ({ run: async () => ({}) }) as unknown as Backtester,
    getCascadeNewsCalendar: () =>
      ({ addAdHocBlackout: async () => ({ ok: true }) }) as unknown as NewsCalendar,
    refreshConfigIfDue: async () => {
      calls.push("refresh");
    },
    healthCheck: () => ({ ok: true, uptimeMs: 1 }) as never,
    engineDiagnostics: () => ({ ok: true }),
    syncStateMicrostructureFromBook: () => calls.push("sync"),
    performanceMetricsResponse: () => new Response("metric 1"),
    resetLatencyBaseline: () => calls.push("resetLatency"),
    publish: (type) => calls.push(`publish:${type}`),
    safeStoragePutEntries: async () => {
      calls.push("putEntries");
    },
    safeStoragePutKey: async (_key, _value, reason) => {
      calls.push(`putKey:${reason}`);
    },
    recoverEngineState: async () => ({ ok: true, recovered: true }),
    pruneOperationalLogs: async () =>
      ({
        policy: { generatedAt: "now" },
        telemetryRows: 1,
        lowValueOperationalRows: 2,
        cappedOperationalInfoRows: 3,
        marketTickRows: 4,
        totalRows: 10
      }) as never,
    currentBookSnapshot: () => ({ instrumentCode: "btc-usd" }) as never,
    currentDomHeatmap: () => ({ schemaVersion: "dom.analysis.v1" }) as never,
    applySnapshot: async () => ({ ok: true }),
    applyDelta: async () => ({ accepted: true }) as never,
    enqueueOrderBookReset: async () => ({ ok: true }),
    registerIngestConnection: () => ({ ok: true }),
    runHistoricalReplay: async () => ({ ok: true }) as never,
    currentReplayStatus: async () => ({ status: "IDLE", progressPct: 0 }) as never,
    currentCascadeActiveSnapshot: () => [],
    currentCascadeSignalSnapshot: () => [],
    currentCascadePositionSnapshot: () => [],
    closeCascadePosition: async () => ({ ok: true }),
    currentCascadeHeatSnapshot: () => ({}),
    analyzeSentimentHeadline: async () =>
      ({ score: 0.1, bias: "NEUTRAL", model: "test", updatedAt: "now", latencyMs: 1 }) as never,
    applyExecutionReport: async () => calls.push("executionReport"),
    enqueueTick: async () =>
      ({
        accepted: true,
        status: "FRESH",
        processedCount: 1,
        metrics: { totalLatencyMs: 1 } as never
      }) as never,
    handleHyperliquidRaw: async () =>
      ({
        accepted: false,
        status: "DESYNC",
        processedCount: 0,
        reason: "gap"
      }) as never,
    handleGrpcFatalDrop: async () => ({ status: "CRITICAL" }),
    acceptAgentSignal: async () => calls.push("agentSignal"),
    applyConfigUpdate: async () => calls.push("config")
  };
}

describe("engine HTTP route matrix", () => {
  it("builds route context from engine runtime bindings", async () => {
    const state = baseState();
    const calls: string[] = [];
    const target = {
      env: { CONFIG_STORE: { put: async () => undefined } } as unknown as Env,
      state: { waitUntil: () => undefined } as unknown as DurableObjectState,
      logger: { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
      engineState: state,
      orderBook: new Map([["book", { midPrice: 100 }]]),
      latencyHistory: [{ totalLatencyMs: 7 }],
      processingLatencySamples: [1, 2],
      cachedConfig: state.cachedConfig,
      cascadeBacktester: { run: async () => ({}) } as unknown as Backtester,
      cascadeNewsCalendar: {
        addAdHocBlackout: async () => ({ ok: true })
      } as unknown as NewsCalendar,
      replayJournal: {
        currentStatus: async () => ({ status: "IDLE" })
      },
      sentimentAgent: {
        analyzeHeadline: async (headline: string) => {
          calls.push(`sentiment:${headline}`);
          return state.sentiment;
        }
      },
      refreshConfigIfDue: async (source: string) => calls.push(`refresh:${source}`),
      healthCheck: () => ({ ok: true, uptimeMs: 1 }) as never,
      engineDiagnostics: () => ({ ok: true }),
      syncStateMicrostructureFromBook: () => calls.push("sync"),
      performanceMetricsResponse: () => new Response("metric 1"),
      resetLatencyBaseline: () => calls.push("latency"),
      publish: (type: string) => calls.push(`publish:${type}`),
      safeStoragePut: async () => calls.push("storage"),
      recoverEngineState: async () => ({ ok: true }),
      pruneOperationalLogs: async () => ({ totalRows: 0 }) as never,
      currentBookSnapshot: () => ({ instrumentCode: "btc-usd" }) as never,
      currentDomHeatmap: () => ({ instrumentCode: "btc-usd" }) as never,
      applySnapshot: async () => ({ ok: true }),
      applyDelta: async () => ({ accepted: true }) as never,
      enqueueOrderBookReset: async () => ({ ok: true }),
      registerIngestConnection: () => ({ ok: true }),
      runHistoricalReplay: async () => ({ ok: true }) as never,
      currentCascadeActiveSnapshot: () => [],
      currentCascadeSignalSnapshot: () => [],
      currentCascadePositionSnapshot: () => [],
      closeCascadePosition: async () => ({ ok: true }),
      currentCascadeHeatSnapshot: () => ({}),
      applyExecutionReport: async () => calls.push("execution"),
      enqueueTick: async () => ({ accepted: true, status: "FRESH" }) as never,
      handleHyperliquidRaw: async () => ({ accepted: true, status: "FRESH" }) as never,
      handleGrpcFatalDrop: async () => ({ status: "CRITICAL" }),
      acceptAgentSignal: async () => calls.push("signal"),
      applyConfigUpdate: async () => calls.push("config")
    } as unknown as EngineHttpRouteContextTarget;

    const context = createTradingEngineHttpRouteContext(target, 12);
    const nextState = { ...state, engineId: "next-state" };

    context.setEngineState(nextState);
    await context.refreshConfigIfDue("ALARM");
    await context.analyzeSentimentHeadline("risk headline");
    context.publish("PING", {});

    expect(context.wakeUpTimeMs).toBe(12);
    expect(context.getEngineState().engineId).toBe("next-state");
    expect(context.getOrderBook().get("book")).toEqual({ midPrice: 100 });
    expect(context.getLatencyHistory()[0]?.totalLatencyMs).toBe(7);
    expect(await context.currentReplayStatus()).toEqual({ status: "IDLE" });
    expect(calls).toEqual(["refresh:ALARM", "sentiment:risk headline", "publish:PING"]);
  });

  it("handles health, state, metrics, and diagnostics routes", async () => {
    const context = createContext();

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          request("/health"),
          new URL("https://engine.test/health"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          request("/diagnostics"),
          new URL("https://engine.test/diagnostics"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          request("/state"),
          new URL("https://engine.test/state"),
          context
        )
      )
    ).toHaveProperty("state");
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          request("/performance"),
          new URL("https://engine.test/performance"),
          context
        )
      )
    ).toEqual([{ totalLatencyMs: 1 }]);
    expect(
      await handleTradingEngineHttpRoute(
        request("/metrics/performance"),
        new URL("https://engine.test/metrics/performance"),
        context
      ).then((response) => response.text())
    ).toBe("metric 1");
    expect(context.calls).toContain("sync");
  });

  it("handles maintenance recovery, latency reset, and pruning", async () => {
    const context = createContext();

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/maintenance/reset-latency", {}),
          new URL("https://engine.test/maintenance/reset-latency"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(context.calls).toContain("publish:RESUME_QUOTES");
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/maintenance/recover", { reason: "test" }),
          new URL("https://engine.test/maintenance/recover"),
          context
        )
      )
    ).toMatchObject({ recovered: true });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/maintenance/prune-logs", {}),
          new URL("https://engine.test/maintenance/prune-logs"),
          context
        )
      )
    ).toMatchObject({ ok: true });
  });

  it("handles sentiment, execution report, tick, raw, and batch routes", async () => {
    const context = createContext();

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/news/sentiment", { headline: "quiet market" }),
          new URL("https://engine.test/news/sentiment"),
          context
        )
      )
    ).toMatchObject({ skipped: true });

    const enabled = createContext({ SENTIMENT_ENABLED: true });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/news/sentiment", { headline: "quiet market" }),
          new URL("https://engine.test/news/sentiment"),
          enabled
        )
      )
    ).toMatchObject({ ok: true });

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/execution/report", { clientId: "c1" } satisfies Partial<ExecutionReport>),
          new URL("https://engine.test/execution/report"),
          context
        )
      )
    ).toMatchObject({ ok: true });

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/tick", tick()),
          new URL("https://engine.test/tick"),
          context
        )
      )
    ).toMatchObject({ accepted: true, status: "FRESH" });

    expect(
      await handleTradingEngineHttpRoute(
        jsonRequest("/hyperliquid/raw", { raw: {} }),
        new URL("https://engine.test/hyperliquid/raw"),
        context
      )
    ).toHaveProperty("status", 409);

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/ticks", { ticks: [tick()] }),
          new URL("https://engine.test/ticks"),
          context
        )
      )
    ).toMatchObject({ acceptedCount: 1, status: "FRESH" });
  });

  it("handles fatal drop, agent signal, config, and not-found routes", async () => {
    const context = createContext();

    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/ingest/grpc-fatal-drop", { reason: "watchdog" }),
          new URL("https://engine.test/ingest/grpc-fatal-drop"),
          context
        )
      )
    ).toMatchObject({ status: "CRITICAL" });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/agent/signal", signal()),
          new URL("https://engine.test/agent/signal"),
          context
        )
      )
    ).toMatchObject({ signalId: "sig-1" });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          jsonRequest("/admin/config", { signal: "REFRESH_CONFIG" }),
          new URL("https://engine.test/admin/config"),
          context
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      await bodyOf(
        await handleTradingEngineHttpRoute(
          request("/missing"),
          new URL("https://engine.test/missing"),
          context
        )
      )
    ).toMatchObject({ error: "Not found" });
    expect(context.calls).toEqual(expect.arrayContaining(["agentSignal", "config"]));
  });
});

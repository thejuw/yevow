import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardPulsePayload,
  acceptMarketStream,
  acceptTelemetryStream,
  type EngineStreamContext
} from "../../src/engine/trading/routes/EngineWebSocketStreams";
import {
  engineDiagnostics,
  syncStateMicrostructureFromBook
} from "../../src/engine/trading/state/EngineDiagnostics";
import { StorageWriteGuard } from "../../src/engine/trading/state/StorageWriteGuard";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type { BookSyncState } from "../../src/engine/trading/book/BookTypes";
import type { ProfilerAgent } from "../../src/agents/ProfilerAgent";
import type {
  AgentSignal,
  EngineState,
  InternalOrderBook,
  LatencyMetrics,
  MacroBias,
  MarketTick,
  TemporaryGovernanceOverride
} from "../../src/types";

describe("engine stream helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds compact dashboard pulse payloads from engine state", () => {
    const context = streamContext();

    expect(dashboardPulsePayload(context)).toMatchObject({
      schemaVersion: "admin.dashboard-pulse.v1",
      total_equity: 1_005,
      unrealized_pnl: 5,
      active_drawdown: 0.01,
      mode: "PAPER",
      quote_state: "QUOTING",
      exchange_to_receipt_ms: 2,
      location: "TYO"
    });
  });

  it("accepts telemetry streams and responds to admin pings", () => {
    vi.useFakeTimers();
    const response = withFakeWebSockets(() => acceptTelemetryStream(streamContext()));
    const server = latestSocketPair().server;

    expect(response.status).toBe(101);
    expect(server.accepted).toBe(true);
    expect(sentMessage(server, 0)).toMatchObject({ type: "TELEMETRY_SNAPSHOT" });

    server.dispatch("message", JSON.stringify({ type: "PING", sentAt: "t0" }));
    expect(sentMessage(server, 1)).toMatchObject({
      type: "PONG",
      payload: { sentAt: "t0" }
    });

    vi.runOnlyPendingTimers();
    expect(server.sent.some((message) => message.includes("DASHBOARD_PULSE"))).toBe(true);

    server.dispatch("close");
  });

  it("queues valid market stream ticks and rejects malformed payloads", async () => {
    const pending: Promise<unknown>[] = [];
    const context = streamContext({
      waitUntil: (promise) => pending.push(promise)
    });

    withFakeWebSockets(() => acceptMarketStream(context));
    const server = latestSocketPair().server;

    server.dispatch("message", "{");
    expect(sentMessage(server, 1)).toEqual({ type: "ERROR", reason: "INVALID_JSON" });

    server.dispatch("message", JSON.stringify({ schemaVersion: "wrong" }));
    expect(sentMessage(server, 2)).toEqual({ type: "ERROR", reason: "INVALID_MARKET_TICK" });

    server.dispatch("message", JSON.stringify(marketTick()));
    await pending.at(-1);

    expect(sentMessage(server, 3)).toMatchObject({
      type: "ACK",
      accepted: true,
      status: "FRESH",
      instrumentCode: "btc-usd",
      sequence: 42
    });
  });

  it("reports enqueue failures without crashing the WebSocket", async () => {
    const pending: Promise<unknown>[] = [];
    const context = streamContext({
      enqueueTick: async () => {
        throw new Error("queue_failed");
      },
      waitUntil: (promise) => pending.push(promise)
    });

    withFakeWebSockets(() => acceptMarketStream(context));
    const server = latestSocketPair().server;

    server.dispatch("message", JSON.stringify(marketTick()));
    await pending.at(-1);

    expect(sentMessage(server, 1)).toEqual({ type: "ERROR", reason: "queue_failed" });
  });
});

describe("engine diagnostics helpers", () => {
  it("returns null when no order book is available", () => {
    expect(
      syncStateMicrostructureFromBook({
        engineState: engineState(),
        orderBook: new Map(),
        bids: new Map(),
        asks: new Map(),
        calculatePriceDiscovery: () => ({ weightedMidPrice: 0 }) as never,
        calculateAssetMatrix: () => ({}),
        profilerStateSnapshot: () => ({})
      })
    ).toBeNull();
  });

  it("syncs engine state from the preferred internal order book", () => {
    const bids = new Map([["btc", bookSide("bid", 100, 2)]]);
    const asks = new Map([["btc", bookSide("ask", 101, 1)]]);
    const state = engineState({ microstructure: { marketKey: "missing" } as never });
    const next = syncStateMicrostructureFromBook({
      engineState: state,
      orderBook: new Map([
        ["weak", orderBook("weak", "eth-usd", false, null, null, 0.1)],
        ["btc", orderBook("btc", "btc-usd", true, 100, 101, 1)]
      ]),
      bids,
      asks,
      calculatePriceDiscovery: (instrumentCode, observedAt) =>
        ({ instrumentCode, observedAt, weightedMidPrice: 100.5 }) as never,
      calculateAssetMatrix: (_observedAt, instrumentCode) =>
        ({
          [instrumentCode ?? "unknown"]: { instrumentCode }
        }) as never,
      profilerStateSnapshot: () => ({ "btc-usd": { toxicityScore: 0.1 } }) as never
    });

    expect(next).toMatchObject({
      internalOrderBookDepth: 2,
      microstructure: {
        marketKey: "btc",
        instrumentCode: "btc-usd",
        midPrice: 100.5,
        weightedImbalance: 0.33333333
      },
      priceDiscovery: {
        instrumentCode: "btc-usd",
        weightedMidPrice: 100.5
      }
    });
  });

  it("summarizes L1 sync and profiler buffer health", () => {
    const report = engineDiagnostics({
      engineState: engineState({ shadowQueue: { active: 1 } as never }),
      bookSync: new Map([
        ["btc", bookSync("btc", true, null)],
        ["eth", bookSync("eth", false, "SEQUENCE_GAP")]
      ]),
      profilerAgents: new Map([
        ["btc-usd", profilerAgentDiagnostics(true)],
        ["eth-usd", profilerAgentDiagnostics(false)]
      ])
    });

    expect(report).toMatchObject({
      ok: false,
      l1Sync: {
        ok: false,
        desyncCount: 1
      },
      v8Memory: {
        ok: false
      },
      shadowQueue: { active: 1 }
    });
  });
});

describe("storage write guard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes keys, batches, deletes, and alarms through Durable Object storage", async () => {
    const storage = new FakeDurableObjectStorage();
    const guard = new StorageWriteGuard(storage as unknown as DurableObjectStorage, 10_000);

    await guard.put("one", 1, "single");
    await guard.put({ two: 2, three: 3 }, "batch");
    await guard.delete(["one"], "delete");
    await guard.setAlarm(12_345, "alarm");

    expect(storage.values).toEqual(
      new Map<string, unknown>([
        ["two", 2],
        ["three", 3]
      ])
    );
    expect(storage.deleted).toEqual([["one"]]);
    expect(storage.alarms).toEqual([12_345]);
  });

  it("backs off after storage failures and resumes after the window", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new FakeDurableObjectStorage();
    const guard = new StorageWriteGuard(storage as unknown as DurableObjectStorage, 10_000);

    storage.failNext = new Error("Exceeded allowed rows written");
    await guard.put("one", 1, "quota");
    await guard.put("two", 2, "skipped");
    expect(storage.values.size).toBe(0);

    vi.setSystemTime(11_001);
    await guard.put("two", 2, "resumed");

    expect(storage.values.get("two")).toBe(2);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("uses a shorter backoff for non-quota storage failures", async () => {
    vi.useFakeTimers({ now: 5_000 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new FakeDurableObjectStorage();
    const guard = new StorageWriteGuard(storage as unknown as DurableObjectStorage, 30_000);

    storage.failNext = new Error("temporary storage error");
    await guard.setAlarm(10, "alarm");
    await guard.delete(["skipped"], "disabled");
    expect(storage.deleted).toEqual([]);

    vi.setSystemTime(10_001);
    await guard.delete([], "empty");
    await guard.delete(["ready"], "delete");

    expect(storage.deleted).toEqual([["ready"]]);
  });
});

function streamContext(overrides: Partial<EngineStreamContext> = {}): EngineStreamContext {
  return {
    adminSockets: new Set<WebSocket>(),
    getEngineState: () => engineState(),
    getSignals: () => [agentSignal()],
    getLatencyHistory: () => [latencyMetric()],
    getMacroBias: () => ({ direction: "NEUTRAL" }) as MacroBias,
    getTemporaryOverride: () => null as TemporaryGovernanceOverride | null,
    enqueueTick: async () => ({
      accepted: true,
      status: "FRESH",
      metrics: {
        instrumentCode: "btc-usd",
        sequence: 42,
        totalLatencyMs: 3
      } as never
    }),
    waitUntil: () => undefined,
    publish: () => undefined,
    nextBusSequence: sequenceCounter(),
    ...overrides
  };
}

function sequenceCounter(): () => number {
  let sequence = 0;

  return () => {
    sequence += 1;
    return sequence;
  };
}

function engineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    engineId: "engine-test",
    mode: "PAPER",
    bankroll: {
      currency: "USD",
      cash: 1_000,
      equity: 1_005,
      realizedPnl: 0,
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    openPositions: {
      btc: { unrealizedPnl: 5 }
    } as never,
    agentHealth: {} as never,
    risk: {} as never,
    processedTicks: 12,
    acceptedSignals: 1,
    internalOrderBookDepth: 2,
    averageLatency: 4,
    latencySampleCount: 1,
    staleTickCount: 0,
    toxicityScore: 0.2,
    current_inventory_delta: 0,
    maxLatencyMs: 150,
    cachedConfig: {} as never,
    macroBias: {} as never,
    temporaryOverride: null,
    assetMatrix: [],
    profilerStates: {},
    location: { colo: "TYO", placement: "smart", isGoldenRegion: true } as never,
    fundingRates: {},
    microstructure: { marketKey: "btc", midPrice: 100.5, weightedImbalance: 0.25 } as never,
    priceDiscovery: {} as never,
    oracle: { regime: "NORMAL", skepticismMultiplier: 1 } as never,
    sentiment: {} as never,
    ensemble: {} as never,
    leadLag: {} as never,
    inventory: {} as never,
    riskMetrics: { rollingDrawdownPct: 0.01 } as never,
    quoteState: { status: "QUOTING" } as never,
    assetQuoteStates: {},
    shadowQueue: { fills: 1 } as never,
    lastTradeIntent: null,
    inventoryGuard: {} as never,
    janitor: {} as never,
    slippage: {} as never,
    orderMap: {},
    executionProfile: { jitterMs: 0.5 } as never,
    citadel: {} as never,
    dom: null,
    anomaly: {} as never,
    liquidationHeatmap: {
      totalEstimatedNotionalUsd: 50_000_000,
      clusters: [],
      nearestCascade: null,
      recentEvents: [],
      updatedAt: "2026-01-01T00:00:00.000Z"
    } as never,
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function marketTick(): MarketTick {
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
    sequence: 42,
    providerTimestamp: "2026-01-01T00:00:00.000Z",
    exchangeTimestamp: "2026-01-01T00:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-01-01T00:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-01-01T00:00:00.001Z",
    sourceWeight: 1,
    raw: {}
  };
}

function agentSignal(): AgentSignal {
  return {
    schemaVersion: "agent-signal.v1",
    signalId: "signal-1",
    traceId: "trace-1",
    sourceAgent: "ORACLE",
    targetAgent: "CROUPIER",
    instrumentCode: "btc-usd",
    action: "HOLD",
    confidence: 0.7,
    expectedValue: 0,
    featureVector: {},
    rationale: "test",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function latencyMetric(): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    sequence: 42,
    kaikoTimestamp: "2026-01-01T00:00:00.000Z",
    exchangeTimestamp: "2026-01-01T00:00:00.000Z",
    ingestTimestamp: "2026-01-01T00:00:00.001Z",
    brainTimestamp: "2026-01-01T00:00:00.003Z",
    networkLatencyMs: 2,
    processingLatencyMs: 1,
    totalLatencyMs: 3,
    maxLatencyMs: 150,
    status: "FRESH"
  };
}

function bookSide(side: "bid" | "ask", price: number, size: number): SortedBookSide {
  const book = new SortedBookSide(side);
  book.upsert(price, size, "2026-01-01T00:00:00.000Z", 0.5);
  return book;
}

function orderBook(
  marketKey: string,
  instrumentCode: string,
  isSynced: boolean,
  bestBid: number | null,
  bestAsk: number | null,
  sourceWeight: number
): InternalOrderBook {
  const bids = bestBid === null ? [] : [{ price: bestBid, size: 2, updatedAt: "now" }];
  const asks = bestAsk === null ? [] : [{ price: bestAsk, size: 1, updatedAt: "now" }];

  return {
    marketKey,
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight,
    instrumentCode,
    exchangeCode: "hyperliquid",
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    spreadBps: null,
    weightedImbalance: null,
    lastSequence: 10,
    tickSize: 0.5,
    ttbLatencyMs: 1,
    isSynced,
    desyncReason: isSynced ? null : "SEQUENCE_GAP",
    sequence: 10,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function bookSync(marketKey: string, isSynced: boolean, reason: string | null): BookSyncState {
  return {
    marketKey,
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: `${marketKey}-usd`,
    exchangeCode: "hyperliquid",
    lastSequence: 7,
    lastSnapshotAt: null,
    lastDeltaAt: null,
    lastDesyncAt: reason ? "2026-01-01T00:00:00.000Z" : null,
    desyncReason: reason,
    isSynced,
    tickSize: 0.5,
    ttbLatencyMs: 1,
    lastCrossCheckAt: 0
  };
}

function profilerAgentDiagnostics(flatMemory: boolean): ProfilerAgent {
  return {
    diagnostics: () => ({ flatMemory })
  } as unknown as ProfilerAgent;
}

let currentPair: CreatedSocketPair | null = null;

function withFakeWebSockets(operation: () => Response): FakeResponse {
  vi.stubGlobal("WebSocketPair", FakeSocketPair as unknown as typeof WebSocketPair);
  vi.stubGlobal("Response", FakeResponse as unknown as typeof Response);

  return operation() as unknown as FakeResponse;
}

function latestSocketPair(): CreatedSocketPair {
  if (!currentPair) {
    throw new Error("No socket pair was created");
  }

  return currentPair;
}

function sentMessage(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

class FakeSocketPair {
  readonly 0: FakeSocket;
  readonly 1: FakeSocket;

  constructor() {
    const client = new FakeSocket();
    const server = new FakeSocket();

    this[0] = client;
    this[1] = server;
    currentPair = { client, server };
  }
}

interface CreatedSocketPair {
  client: FakeSocket;
  server: FakeSocket;
}

class FakeSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  accepted = false;
  closed = false;

  accept(): void {
    this.accepted = true;
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

class FakeResponse {
  readonly status: number;
  readonly webSocket: unknown;

  constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}

class FakeDurableObjectStorage {
  readonly values = new Map<string, unknown>();
  readonly deleted: string[][] = [];
  readonly alarms: number[] = [];
  failNext: Error | null = null;

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    this.maybeFail();

    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, value);
      return;
    }

    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.values.set(key, entry);
    }
  }

  async delete(keys: string[]): Promise<void> {
    this.maybeFail();
    this.deleted.push(keys);

    for (const key of keys) {
      this.values.delete(key);
    }
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.maybeFail();
    this.alarms.push(timestamp);
  }

  private maybeFail(): void {
    if (!this.failNext) {
      return;
    }

    const error = this.failNext;
    this.failNext = null;
    throw error;
  }
}

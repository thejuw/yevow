import { describe, expect, it } from "vitest";
import {
  buildHyperliquidL2BookSnapshotBundle,
  buildHyperliquidL2BookLatencyMetrics,
  buildHyperliquidL2BookTick,
  buildHyperliquidL2BookTickFromBook,
  calculateHyperliquidBookTotalLatencyMs,
  evaluateHyperliquidBookSequence,
  handleHyperliquidRawBatch,
  hyperliquidIngestConnectionKey,
  hyperliquidRawMessages,
  isActiveHyperliquidIngestConnection,
  registerHyperliquidIngestConnection,
  resolveHyperliquidBookTimestamp,
  routeHyperliquidRawMessage
} from "../../src/engine/trading/ingest/HyperliquidRawIngest";
import type { BookSyncState } from "../../src/engine/trading/book/BookTypes";
import type { TickIngestResult } from "../../src/engine/trading/TradingEngineRouteTypes";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";

describe("hyperliquid raw ingest helpers", () => {
  it("normalizes connection keys and active connection checks", () => {
    const active = new Map<string, string>();
    active.set(hyperliquidIngestConnectionKey("HyperLiquid", "book"), "conn-1");
    active.set(hyperliquidIngestConnectionKey("hyperliquid", null), "fallback");

    expect(hyperliquidIngestConnectionKey("HyperLiquid", "book")).toBe("hyperliquid:book");
    expect(isActiveHyperliquidIngestConnection(active, {})).toBe(true);
    expect(
      isActiveHyperliquidIngestConnection(active, {
        source_exchange: "hyperliquid",
        streamId: "book",
        connectionId: "conn-1"
      })
    ).toBe(true);
    expect(
      isActiveHyperliquidIngestConnection(active, {
        source_exchange: "hyperliquid",
        streamId: "book",
        connectionId: "stale"
      })
    ).toBe(false);
    expect(
      isActiveHyperliquidIngestConnection(active, {
        source_exchange: "hyperliquid",
        connectionId: "fallback"
      })
    ).toBe(true);
  });

  it("extracts bounded raw message batches", () => {
    expect(hyperliquidRawMessages({ messages: [1, 2, 3] }, 2)).toEqual([1, 2]);
    expect(hyperliquidRawMessages({ raw: { channel: "trades" } }, 2)).toEqual([
      { channel: "trades" }
    ]);
    expect(hyperliquidRawMessages({ source: "HYPERLIQUID" }, 0)).toEqual([]);
  });

  it("routes raw Hyperliquid channels into engine dispatch categories", () => {
    expect(routeHyperliquidRawMessage({ channel: "pong" })).toMatchObject({
      kind: "CONTROL",
      channel: "pong"
    });
    expect(routeHyperliquidRawMessage({ channel: "l2Book" })).toMatchObject({
      kind: "L2_BOOK"
    });
    expect(routeHyperliquidRawMessage({ channel: "trades" })).toMatchObject({
      kind: "TRADES"
    });
    expect(routeHyperliquidRawMessage({ channel: "activeAssetCtx" })).toMatchObject({
      kind: "ASSET_CONTEXT"
    });
    expect(routeHyperliquidRawMessage({ channel: "userEvents" })).toMatchObject({
      kind: "LIQUIDATION_EVENTS"
    });
    expect(routeHyperliquidRawMessage({ channel: "unknownThing" })).toMatchObject({
      kind: "IGNORED",
      reason: "IGNORED_HYPERLIQUID_CHANNEL_unknownthing"
    });
    expect(() => routeHyperliquidRawMessage("bad")).toThrow("INVALID_HYPERLIQUID_RAW_MESSAGE");
  });

  it("resolves book timestamps with drift and invalid timestamp guards", () => {
    const receivedAt = "2026-01-01T00:00:01.000Z";

    expect(resolveHyperliquidBookTimestamp(null, receivedAt, 500)).toBe(receivedAt);
    expect(resolveHyperliquidBookTimestamp("bad", receivedAt, 500)).toBe(receivedAt);
    expect(resolveHyperliquidBookTimestamp("2026-01-01T00:00:00.800Z", receivedAt, 500)).toBe(
      "2026-01-01T00:00:00.800Z"
    );
    expect(resolveHyperliquidBookTimestamp("2026-01-01T00:00:00.000Z", receivedAt, 500)).toBe(
      receivedAt
    );
  });

  it("builds native L2 snapshot bundles from Hyperliquid payloads", () => {
    const bundle = buildHyperliquidL2BookSnapshotBundle(
      {
        data: {
          coin: "BTC",
          time: 1_767_000_000_000,
          sequence: 42,
          levels: [[{ px: "100", sz: "1.25" }], [{ px: "101", sz: "2.5" }]]
        }
      },
      {
        source_exchange: "HyperLiquid",
        exchangeCode: "HL",
        instrumentCode: "btc-usd",
        sourceWeight: 2,
        receivedAt: "2026-01-01T00:00:01.000Z"
      },
      5_000,
      "2026-01-01T00:00:02.000Z"
    );

    expect(bundle).toMatchObject({
      coin: "BTC",
      instrumentCode: "btc-usd",
      exchangeCode: "hl",
      sourceExchange: "hyperliquid",
      sourceWeight: 2,
      hasExplicitSequence: true,
      sequence: 42,
      marketKey: "hyperliquid:btc-usd"
    });
    expect(bundle.snapshot).toMatchObject({
      schemaVersion: "order-book.snapshot.v1",
      source: "HYPERLIQUID",
      marketKey: "hyperliquid:btc-usd",
      bids: [{ price: 100, size: 1.25 }],
      asks: [{ price: 101, size: 2.5 }]
    });
  });

  it("builds native L2 latency metrics and representative book ticks from snapshot bundles", () => {
    const bundle = buildHyperliquidL2BookSnapshotBundle(
      {
        data: {
          coin: "BTC",
          time: 1_767_000_000_000,
          sequence: 99,
          levels: [[{ px: "100", sz: "1" }], [{ px: "101", sz: "2" }]]
        }
      },
      {
        transport: "grpc",
        streamId: "dwellir-book",
        connectionId: "conn-1",
        source_exchange: "hyperliquid",
        receivedAt: "2026-01-01T00:00:00.050Z"
      },
      5_000,
      "2026-01-01T00:00:00.050Z"
    );
    const brainTimestamp = "2026-01-01T00:00:00.125Z";

    expect(calculateHyperliquidBookTotalLatencyMs(bundle.exchangeTimestamp, brainTimestamp)).toBe(
      75
    );
    expect(
      buildHyperliquidL2BookLatencyMetrics({
        bundle,
        brainTimestamp,
        totalLatencyMs: 75,
        maxLatencyMs: 150,
        averageLatencyMs: 40,
        sampleCount: 10,
        location: defaultEngineState("test").location
      })
    ).toMatchObject({
      instrumentCode: "btc-usd",
      sequence: 99,
      totalLatencyMs: 75,
      maxLatencyMs: 150,
      averageLatencyMs: 40,
      sampleCount: 10,
      status: "FRESH"
    });

    expect(
      buildHyperliquidL2BookTick({
        payload: { transport: "grpc", streamId: "dwellir-book", connectionId: "conn-1" },
        bundle,
        price: 0
      })
    ).toMatchObject({
      source: "HYPERLIQUID",
      transport: "grpc",
      streamId: "dwellir-book",
      connectionId: "conn-1",
      instrumentCode: "btc-usd",
      price: 0,
      sequence: 99
    });

    expect(
      buildHyperliquidL2BookTickFromBook({
        payload: { transport: "grpc" },
        bundle,
        book: {
          midPrice: 100.5,
          bestBid: 100,
          bestAsk: 101
        }
      })
    ).toMatchObject({
      price: 100.5,
      bestBid: 100,
      bestAsk: 101
    });
  });

  it("evaluates native L2 duplicate and sequence gap decisions", () => {
    expect(evaluateHyperliquidBookSequence(undefined, 1, true, 5, "now")).toEqual({
      status: "ACCEPTED"
    });
    expect(evaluateHyperliquidBookSequence(bookSync(10), 10, true, 5, "now")).toEqual({
      status: "DUPLICATE_OR_OUT_OF_ORDER"
    });
    expect(evaluateHyperliquidBookSequence(bookSync(10), 20, true, 5, "now")).toEqual({
      status: "DESYNC",
      reason: "HYPERLIQUID_SEQUENCE_GAP",
      previousSequence: 10,
      sequence: 20,
      gapMs: 10,
      maxGapMs: 5,
      lastDesyncAt: "now"
    });
    expect(evaluateHyperliquidBookSequence(bookSync(10), 20, false, 5, "now")).toEqual({
      status: "ACCEPTED"
    });
  });

  it("registers active ingest connections by stream and default fallback", () => {
    const active = new Map<string, string>();
    const observedAt = "2026-05-18T13:00:00.000Z";

    const missing = registerHyperliquidIngestConnection(
      active,
      { source_exchange: "HyperLiquid", streamId: "book" },
      observedAt
    );
    expect(missing).toEqual({
      registered: false,
      reason: "MISSING_CONNECTION_ID",
      source_exchange: "hyperliquid",
      streamId: "book",
      observedAt
    });
    expect(active.size).toBe(0);

    const streamRegistration = registerHyperliquidIngestConnection(
      active,
      {
        source_exchange: "HyperLiquid",
        streamId: "book",
        connectionId: "conn-book",
        reason: "STREAM_RECOVERED"
      },
      observedAt
    );
    expect(streamRegistration).toMatchObject({
      registered: true,
      source_exchange: "hyperliquid",
      streamId: "book",
      connectionId: "conn-book",
      reason: "STREAM_RECOVERED"
    });
    expect(active.get("hyperliquid:book")).toBe("conn-book");

    const defaultRegistration = registerHyperliquidIngestConnection(
      active,
      { source_exchange: "HyperLiquid", connectionId: "conn-default" },
      observedAt
    );
    expect(defaultRegistration).toMatchObject({
      registered: true,
      streamId: null,
      connectionId: "conn-default"
    });
    expect(active.get("hyperliquid:default")).toBe("conn-default");
  });

  it("drops stale batches and stops processing on terminal statuses", async () => {
    const active = new Map([[hyperliquidIngestConnectionKey("hyperliquid", "book"), "conn-1"]]);
    const stale = await handleHyperliquidRawBatch(
      { source_exchange: "hyperliquid", streamId: "book", connectionId: "old", raw: {} },
      null,
      {
        activeIngestConnections: active,
        enqueueRawMessage: async () => freshResult()
      }
    );

    expect(stale).toEqual({
      accepted: false,
      status: "IGNORED",
      reason: "STALE_INGEST_CONNECTION",
      processedCount: 0
    });

    const seen: unknown[] = [];
    const result = await handleHyperliquidRawBatch(
      {
        source_exchange: "hyperliquid",
        streamId: "book",
        connectionId: "conn-1",
        messages: ["a", "b", "c"]
      },
      2,
      {
        activeIngestConnections: active,
        enqueueRawMessage: async (raw) => {
          seen.push(raw);
          return seen.length === 2
            ? { accepted: false, status: "STALE", processedCount: 1 }
            : freshResult();
        }
      }
    );

    expect(seen).toEqual(["a", "b"]);
    expect(result).toMatchObject({ status: "STALE", processedCount: 2 });
  });

  it("returns a fresh zero-count result for empty active batches", async () => {
    await expect(
      handleHyperliquidRawBatch({ messages: [] }, null, {
        activeIngestConnections: new Map(),
        enqueueRawMessage: async () => {
          throw new Error("should_not_run");
        }
      })
    ).resolves.toEqual({ accepted: true, status: "FRESH", processedCount: 0 });
  });
});

function freshResult(): TickIngestResult {
  return {
    accepted: true,
    status: "FRESH",
    processedCount: 1
  };
}

function bookSync(lastSequence: number | null): BookSyncState {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hl",
    lastSequence,
    lastSnapshotAt: null,
    lastDeltaAt: null,
    lastDesyncAt: null,
    desyncReason: null,
    isSynced: true,
    tickSize: 0.01,
    ttbLatencyMs: null,
    lastCrossCheckAt: 0
  };
}

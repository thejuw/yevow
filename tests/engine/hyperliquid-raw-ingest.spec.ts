import { describe, expect, it } from "vitest";
import {
  handleHyperliquidRawBatch,
  hyperliquidIngestConnectionKey,
  hyperliquidRawMessages,
  isActiveHyperliquidIngestConnection,
  resolveHyperliquidBookTimestamp
} from "../../src/engine/trading/ingest/HyperliquidRawIngest";
import type { TickIngestResult } from "../../src/engine/trading/TradingEngineRouteTypes";

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

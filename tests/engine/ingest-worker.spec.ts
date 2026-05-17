import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/IngestWorker";

describe("IngestWorker poison payload isolation", () => {
  it("splits Dwellir reads into gRPC fills and a dedicated order-book socket when requested", () => {
    const configs = __test__.loadStreamConfigs({
      DWELLIR_GRPC_URL: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com/test-route-token",
      DWELLIR_ORDERBOOK_TRANSPORT: "websocket",
      INGEST_TRANSPORT: "grpc",
      HL_ASSETS: "BTC,ETH",
      MARKET_STREAMS: JSON.stringify([
        {
          id: "dwellir-hyperliquid-grpc-fills",
          source: "HYPERLIQUID",
          source_exchange: "hyperliquid",
          transport: "grpc",
          streamUrl: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com",
          grpcEndpoint: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com",
          grpcService: "hyperliquid_l1_gateway.v2.HyperliquidL1Gateway",
          grpcStreamTypes: ["ORDERBOOK_SNAPSHOT", "FILLS"],
          subscriptions: [
            { method: "subscribe", subscription: { type: "trades", coin: "BTC" } },
            { method: "subscribe", subscription: { type: "trades", coin: "ETH" } }
          ]
        }
      ])
    } as never);

    const grpc = configs.find((config) => config.transport === "grpc");
    const book = configs.find((config) => config.id === "dwellir-hyperliquid-orderbook-btc");
    const ethBook = configs.find((config) => config.id === "dwellir-hyperliquid-orderbook-eth");

    expect(grpc?.grpcStreamTypes).toEqual(["FILLS"]);
    expect(book?.transport).toBe("websocket");
    expect(ethBook?.transport).toBe("websocket");
    expect(book?.streamUrl).toBe(
      "wss://api-hyperliquid-mainnet-orderbook.n.dwellir.com/test-route-token/ws"
    );
    expect(book?.subscriptions).toHaveLength(1);
    expect(ethBook?.subscriptions).toHaveLength(1);
    expect(book?.subscriptionProfile?.tier).toBe("ENTERPRISE");
    expect(book?.subscriptionProfile?.optimization).toBe("MAXIMIZED");
    expect(book?.subscriptionProfile?.bookDepth).toBe(20);
    expect(
      (book?.subscriptions?.[0] as { subscription?: { nSigFigs?: number; strict?: boolean; nLevels?: number } } | undefined)
        ?.subscription
    ).toMatchObject({ nSigFigs: 5, strict: true });
    expect(
      (book?.subscriptions?.[0] as { subscription?: { nLevels?: number } } | undefined)
        ?.subscription?.nLevels
    ).toBeUndefined();
  });

  it("keeps the order book on Dwellir gRPC for non-public Dwellir routes", () => {
    const configs = __test__.loadStreamConfigs({
      DWELLIR_GRPC_URL: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com/test-route-token",
      DWELLIR_ORDERBOOK_TRANSPORT: "grpc",
      DWELLIR_SUBSCRIPTION_TIER: "ENTERPRISE",
      INGEST_TRANSPORT: "grpc",
      HL_ASSETS: "BTC,ETH",
      MARKET_STREAMS: JSON.stringify([
        {
          id: "dwellir-hyperliquid-grpc-fills",
          source: "HYPERLIQUID",
          source_exchange: "hyperliquid",
          transport: "grpc",
          streamUrl: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com",
          grpcEndpoint: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com",
          grpcService: "hyperliquid_l1_gateway.v2.HyperliquidL1Gateway",
          grpcStreamTypes: ["FILLS"],
          subscriptions: [
            { method: "subscribe", subscription: { type: "trades", coin: "BTC" } },
            { method: "subscribe", subscription: { type: "trades", coin: "ETH" } }
          ]
        }
      ])
    } as never);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.transport).toBe("grpc");
    expect(configs[0]?.grpcStreamTypes).toEqual(["FILLS", "ORDERBOOK_SNAPSHOT"]);
    expect(configs[0]?.subscriptionProfile?.readMode).toBe("DWELLIR_GRPC_FILLS_L2_BOOK_GRPC");
  });

  it("falls back to the Dwellir L2 book socket on public routes", () => {
    const configs = __test__.loadStreamConfigs({
      DWELLIR_GRPC_URL: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com/test-route-token",
      DWELLIR_GRPC_STREAMS: "ORDERBOOK_SNAPSHOT,FILLS",
      DWELLIR_ORDERBOOK_TRANSPORT: "grpc",
      DWELLIR_ENABLE_L4_BOOK: "true",
      DWELLIR_SUBSCRIPTION_TIER: "PUBLIC",
      INGEST_TRANSPORT: "grpc",
      HL_ASSETS: "BTC,ETH,HYPE,SOL",
      MARKET_STREAMS: JSON.stringify([
        {
          id: "dwellir-hyperliquid-grpc-mainnet",
          source: "HYPERLIQUID",
          source_exchange: "hyperliquid",
          transport: "grpc",
          streamUrl: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com",
          grpcEndpoint: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com",
          grpcService: "hyperliquid_l1_gateway.v2.HyperliquidL1Gateway",
          grpcStreamTypes: ["ORDERBOOK_SNAPSHOT", "FILLS"]
        }
      ])
    } as never);

    const grpc = configs.find((config) => config.transport === "grpc");
    const books = configs.filter((config) => config.transport === "websocket");

    expect(grpc?.grpcStreamTypes).toEqual(["FILLS"]);
    expect(grpc?.subscriptionProfile?.assetCount).toBe(4);
    expect(books).toHaveLength(4);
    expect(books.every((config) => !config.subscriptionProfile?.l4BookEnabled)).toBe(true);
    expect(books.every((config) => config.subscriptionProfile?.readMode === "DWELLIR_GRPC_FILLS_L2_BOOK_WS")).toBe(true);
  });

  it("aggregates Dwellir L4 order-level snapshots into engine L2 frames", () => {
    const cache = new Map();
    const normalized = __test__.normalizeDwellirL4BookForEngine(
      {
        channel: "l4Book",
        data: {
          Snapshot: {
            coin: "BTC",
            time: 1778888364000,
            height: 123,
            levels: [
              [
                { oid: "bid-1", limitPx: "100000.00", sz: "0.1", side: "B" },
                { oid: "bid-2", limitPx: "100000", sz: "0.2", side: "B" }
              ],
              [{ oid: "ask-1", limitPx: "100001", sz: "0.3", side: "A" }]
            ]
          }
        }
      },
      {
        id: "dwellir-l4-test",
        source: "HYPERLIQUID",
        source_exchange: "hyperliquid",
        transport: "websocket",
        streamUrl: "wss://dwellir.example/ws",
        authHeader: "x-token",
        weight: 1,
        heartbeatIntervalMs: 15000,
        watchdogTimeoutMs: 5000,
        maxBackoffMs: 30000,
        backoffBaseMs: 1000,
        grpcFatalDropMs: 200,
        instrumentCode: "btc-usd",
        exchangeCode: "hyperliquid",
        subscriptionProfile: {
          provider: "DWELLIR",
          tier: "ENTERPRISE",
          normalMode: true,
          assetCount: 4,
          bookDepth: 100,
          maxBookDepth: 100,
          l4BookEnabled: true,
          readMode: "DWELLIR_GRPC_FILLS_L4_BOOK_WS",
          optimization: "MAXIMIZED",
          reason: "test"
        }
      } as never,
      cache,
      "2026-05-16T00:00:00.000Z",
      10000
    );

    expect(normalized).toMatchObject({
      channel: "l2Book",
      data: {
        coin: "BTC",
        sequence: 123,
        levels: [
          [{ px: "100000", sz: "0.3", n: 2 }],
          [{ px: "100001", sz: "0.3", n: 1 }]
        ]
      }
    });
  });

  it("applies Dwellir L4 deletes without clearing the active book", () => {
    const cache = new Map();
    const config = {
      id: "dwellir-l4-test",
      source: "HYPERLIQUID",
      source_exchange: "hyperliquid",
      transport: "websocket",
      streamUrl: "wss://dwellir.example/ws",
      authHeader: "x-token",
      weight: 1,
      heartbeatIntervalMs: 15000,
      watchdogTimeoutMs: 5000,
      maxBackoffMs: 30000,
      backoffBaseMs: 1000,
      grpcFatalDropMs: 200,
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      subscriptionProfile: {
        provider: "DWELLIR",
        tier: "ENTERPRISE",
        normalMode: true,
        assetCount: 4,
        bookDepth: 100,
        maxBookDepth: 100,
        l4BookEnabled: true,
        readMode: "DWELLIR_GRPC_FILLS_L4_BOOK_WS",
        optimization: "MAXIMIZED",
        reason: "test"
      }
    } as never;

    __test__.normalizeDwellirL4BookForEngine(
      {
        channel: "l4Book",
        data: {
          coin: "BTC",
          levels: [
            [
              { oid: "bid-1", px: "100000", sz: "0.1" },
              { oid: "bid-2", px: "99999", sz: "0.2" }
            ],
            []
          ]
        }
      },
      config,
      cache,
      "2026-05-16T00:00:00.000Z",
      10000
    );

    const normalized = __test__.normalizeDwellirL4BookForEngine(
      {
        channel: "l4Book",
        data: {
          Updates: {
            time: 1778888364010,
            height: 124,
            book_diffs: [
              {
                oid: "bid-1",
                px: "100000",
                side: "B",
                coin: "BTC",
                raw_book_diff: { new: null }
              }
            ]
          }
        }
      },
      config,
      cache,
      "2026-05-16T00:00:00.010Z",
      10000
    );

    expect(normalized).toMatchObject({
      channel: "l2Book",
      data: {
        coin: "BTC",
        levels: [[{ px: "99999", sz: "0.2", n: 1 }], []]
      }
    });
  });

  it("sanitizes transient crossed Dwellir L4 top levels before forwarding", () => {
    const cache = new Map();
    const normalized = __test__.normalizeDwellirL4BookForEngine(
      {
        channel: "l4Book",
        data: {
          Snapshot: {
            coin: "HYPE",
            time: 1778888364000,
            height: 125,
            levels: [
              [
                { oid: "bid-crossed", limitPx: "41.500", sz: "1", side: "B" },
                { oid: "bid-valid", limitPx: "41.498", sz: "2", side: "B" }
              ],
              [
                { oid: "ask-crossed", limitPx: "41.499", sz: "1", side: "A" },
                { oid: "ask-valid", limitPx: "41.501", sz: "2", side: "A" }
              ]
            ]
          }
        }
      },
      {
        id: "dwellir-l4-hype-test",
        source: "HYPERLIQUID",
        source_exchange: "hyperliquid",
        transport: "websocket",
        streamUrl: "wss://dwellir.example/ws",
        authHeader: "x-token",
        weight: 1,
        heartbeatIntervalMs: 15000,
        watchdogTimeoutMs: 5000,
        maxBackoffMs: 30000,
        backoffBaseMs: 1000,
        grpcFatalDropMs: 200,
        instrumentCode: "hype-usd",
        exchangeCode: "hyperliquid",
        subscriptionProfile: {
          provider: "DWELLIR",
          tier: "ENTERPRISE",
          normalMode: true,
          assetCount: 4,
          bookDepth: 100,
          maxBookDepth: 100,
          l4BookEnabled: true,
          readMode: "DWELLIR_GRPC_FILLS_L4_BOOK_WS",
          optimization: "MAXIMIZED",
          reason: "test"
        }
      } as never,
      cache,
      "2026-05-16T00:00:00.000Z",
      10000
    );

    expect(normalized).toMatchObject({
      channel: "l2Book",
      data: {
        coin: "HYPE",
        crossedLevelsPruned: 2,
        levels: [
          [{ px: "41.498", sz: "2", n: 1 }],
          [{ px: "41.501", sz: "2", n: 1 }]
        ]
      }
    });
  });

  it("classifies malformed Dwellir protobuf payloads without throwing", () => {
    const update = {
      kind: "FILLS" as const,
      receivedAt: "2026-05-16T00:00:00.000Z",
      data: new Uint8Array([0xff, 0x00, 0x9f, 0x7b])
    };

    expect(() =>
      __test__.dwellirPayloadToHyperliquidRawMessages(
        update,
        {
          id: "dwellir-test",
          source: "HYPERLIQUID",
          source_exchange: "hyperliquid",
          transport: "grpc",
          streamUrl: "https://dwellir.example",
          authHeader: "x-token",
          weight: 1,
          heartbeatIntervalMs: 15000,
          watchdogTimeoutMs: 5000,
          maxBackoffMs: 30000,
          backoffBaseMs: 50,
          grpcFatalDropMs: 200
        },
        ["BTC"],
        5000
      )
    ).not.toThrow();
    expect(__test__.classifyDwellirMalformedPayload(update)).toBe("INVALID_DWELLIR_PROTO_JSON_PAYLOAD");
  });

  it("passes a valid fresh fill directly into the normalized raw-message path", () => {
    const receivedAt = "2026-05-16T00:00:00.100Z";
    const update = {
      kind: "FILLS" as const,
      receivedAt,
      data: new TextEncoder().encode(JSON.stringify({
        events: [
          [
            "0xabc",
            {
              coin: "BTC",
              px: "100000",
              sz: "0.01",
              side: "B",
              time: "2026-05-16T00:00:00.000Z",
              tid: "trade-001",
              crossed: true
            }
          ]
        ]
      }))
    };

    const messages = __test__.dwellirPayloadToHyperliquidRawMessages(
      update,
      {
        id: "dwellir-test",
        source: "HYPERLIQUID",
        source_exchange: "hyperliquid",
        transport: "grpc",
        streamUrl: "https://dwellir.example",
        authHeader: "x-token",
        weight: 1,
        heartbeatIntervalMs: 15000,
        watchdogTimeoutMs: 5000,
        maxBackoffMs: 30000,
        backoffBaseMs: 50,
        grpcFatalDropMs: 200
      },
      ["BTC"],
      5000
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ channel: "trades" });
    expect(__test__.classifyDwellirMalformedPayload(update)).toBeNull();
  });
});

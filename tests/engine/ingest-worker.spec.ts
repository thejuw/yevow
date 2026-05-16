import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/IngestWorker";

describe("IngestWorker poison payload isolation", () => {
  it("splits Dwellir reads into gRPC fills and a dedicated order-book socket", () => {
    const configs = __test__.loadStreamConfigs({
      DWELLIR_GRPC_URL: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com/test-route-token",
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
    expect(book?.subscriptionProfile?.bookDepth).toBe(100);
    expect(
      (book?.subscriptions?.[0] as { subscription?: { nLevels?: number } } | undefined)
        ?.subscription?.nLevels
    ).toBe(100);
  });

  it("keeps the order book on Dwellir gRPC when the transport is configured for gRPC", () => {
    const configs = __test__.loadStreamConfigs({
      DWELLIR_GRPC_URL: "https://api-hyperliquid-mainnet-grpc.n.dwellir.com/test-route-token",
      DWELLIR_ORDERBOOK_TRANSPORT: "grpc",
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

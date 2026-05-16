import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/IngestWorker";

describe("IngestWorker poison payload isolation", () => {
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

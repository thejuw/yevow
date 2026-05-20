import { describe, expect, it } from "vitest";
import {
  buildTradingEngineFetchRequestContext,
  classifyTradingEngineWebSocketRoute,
  isTradingEngineMarketDataRequest
} from "../../src/engine/trading/routes/EngineFetchRuntime";

describe("EngineFetchRuntime", () => {
  it("identifies hot market-data ingress routes", () => {
    expect(
      isTradingEngineMarketDataRequest({
        pathname: "/hyperliquid/raw",
        sourceHeader: ""
      })
    ).toBe(true);
    expect(
      isTradingEngineMarketDataRequest({
        pathname: "/admin/state",
        sourceHeader: "sovereign-ingest-worker"
      })
    ).toBe(true);
    expect(
      isTradingEngineMarketDataRequest({
        pathname: "/admin/state",
        sourceHeader: ""
      })
    ).toBe(false);
  });

  it("classifies telemetry and market websocket upgrades", () => {
    expect(
      classifyTradingEngineWebSocketRoute({
        pathname: "/stream",
        upgradeHeader: "websocket"
      })
    ).toBe("TELEMETRY_STREAM");
    expect(
      classifyTradingEngineWebSocketRoute({
        pathname: "/ws",
        upgradeHeader: "WebSocket"
      })
    ).toBe("MARKET_STREAM");
    expect(
      classifyTradingEngineWebSocketRoute({
        pathname: "/stream",
        upgradeHeader: null
      })
    ).toBeNull();
  });

  it("builds fetch request context with topology and route classification", () => {
    const request = new Request("https://engine.internal/hyperliquid/raw", {
      headers: {
        "cf-ray": "ray-1",
        "x-source": "sovereign-ingest-worker",
        upgrade: "websocket",
        "x-sovereign-topology-colo": "NRT",
        "x-sovereign-topology-placement": "remote-nrt"
      }
    });

    const context = buildTradingEngineFetchRequestContext(request);

    expect(context.url.pathname).toBe("/hyperliquid/raw");
    expect(context.requestId).toBe("ray-1");
    expect(context.isMarketDataRequest).toBe(true);
    expect(context.webSocketRoute).toBe("MARKET_STREAM");
    expect(context.topology).toMatchObject({
      colo: "NRT",
      placement: "remote-nrt",
      requestId: "ray-1"
    });
  });
});

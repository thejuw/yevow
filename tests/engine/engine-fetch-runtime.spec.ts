import { describe, expect, it } from "vitest";
import {
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
});

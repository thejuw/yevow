import { describe, expect, it } from "vitest";
import {
  buildTradingEngineFetchRequestContext,
  classifyTradingEngineWebSocketRoute,
  handleTradingEngineFetchRuntime,
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

  it("orchestrates market-data topology hooks before HTTP routing", async () => {
    const calls: string[] = [];
    const response = await handleTradingEngineFetchRuntime(
      {
        request: new Request("https://engine.internal/hyperliquid/raw", {
          headers: {
            "cf-ray": "ray-market",
            "x-source": "sovereign-ingest-worker",
            "x-sovereign-topology-colo": "NRT"
          }
        }),
        initialized: Promise.resolve()
      },
      {
        rememberWakeUpTime: (wakeUpTimeMs) => calls.push(`wake:${Number.isFinite(wakeUpTimeMs)}`),
        observeTopology: (topology) => calls.push(`observe:${topology.colo}`),
        warmUpForTopology: (topology) => calls.push(`warm:${topology.colo}`),
        acceptTelemetryStream: () => new Response("telemetry"),
        acceptMarketStream: () => new Response("market"),
        handleHttpRoute: async (_request, url, wakeUpTimeMs) => {
          calls.push(`http:${url.pathname}:${Number.isFinite(wakeUpTimeMs ?? Number.NaN)}`);
          return new Response("ok");
        },
        logRequestFailure: (failure) => calls.push(`error:${failure.requestId}`)
      }
    );

    await expect(response.text()).resolves.toBe("ok");
    expect(calls).toEqual(["wake:true", "observe:NRT", "warm:NRT", "http:/hyperliquid/raw:true"]);
  });

  it("routes websocket upgrades before the HTTP router", async () => {
    const calls: string[] = [];
    const response = await handleTradingEngineFetchRuntime(
      {
        request: new Request("https://engine.internal/stream", {
          headers: { upgrade: "websocket" }
        }),
        initialized: Promise.resolve()
      },
      {
        rememberWakeUpTime: () => calls.push("wake"),
        observeTopology: () => calls.push("observe"),
        warmUpForTopology: () => calls.push("warm"),
        acceptTelemetryStream: () => {
          calls.push("telemetry");
          return new Response("stream");
        },
        acceptMarketStream: () => new Response("market"),
        handleHttpRoute: async () => {
          calls.push("http");
          return new Response("unexpected");
        },
        logRequestFailure: () => calls.push("error")
      }
    );

    await expect(response.text()).resolves.toBe("stream");
    expect(calls).toEqual(["wake", "telemetry"]);
  });

  it("normalizes HTTP route failures into JSON responses and audit hooks", async () => {
    const calls: string[] = [];
    const response = await handleTradingEngineFetchRuntime(
      {
        request: new Request("https://engine.internal/admin/config", {
          headers: { "cf-ray": "ray-error" }
        }),
        initialized: Promise.resolve()
      },
      {
        rememberWakeUpTime: () => calls.push("wake"),
        observeTopology: () => calls.push("observe"),
        warmUpForTopology: () => calls.push("warm"),
        acceptTelemetryStream: () => new Response("telemetry"),
        acceptMarketStream: () => new Response("market"),
        handleHttpRoute: async () => {
          throw new Error("INVALID_CONFIG");
        },
        logRequestFailure: (failure) =>
          calls.push(`${failure.pathname}:${failure.requestId}:${failure.message}`)
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "INVALID_CONFIG",
      requestId: "ray-error"
    });
    expect(calls).toEqual(["wake", "/admin/config:ray-error:INVALID_CONFIG"]);
  });
});

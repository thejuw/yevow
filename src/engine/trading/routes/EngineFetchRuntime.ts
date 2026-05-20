import type { EdgeTopology } from "../../../types";
import { readTopologyHeaders } from "../helpers/PlacementResolver";

export type TradingEngineWebSocketRoute = "TELEMETRY_STREAM" | "MARKET_STREAM";

export interface MarketDataRequestInput {
  readonly pathname: string;
  readonly sourceHeader: string;
}

export interface WebSocketRouteInput {
  readonly pathname: string;
  readonly upgradeHeader: string | null;
}

export interface TradingEngineFetchRequestContext {
  readonly url: URL;
  readonly requestId: string;
  readonly topology: EdgeTopology;
  readonly isMarketDataRequest: boolean;
  readonly webSocketRoute: TradingEngineWebSocketRoute | null;
}

const MARKET_DATA_PATHS = new Set([
  "/tick",
  "/ticks",
  "/market/tick",
  "/hyperliquid/tick",
  "/hyperliquid/raw"
]);

export function isTradingEngineMarketDataRequest(input: MarketDataRequestInput): boolean {
  return (
    input.sourceHeader.toLowerCase().includes("ingest") || MARKET_DATA_PATHS.has(input.pathname)
  );
}

export function classifyTradingEngineWebSocketRoute(
  input: WebSocketRouteInput
): TradingEngineWebSocketRoute | null {
  if (input.upgradeHeader?.toLowerCase() !== "websocket") {
    return null;
  }

  return input.pathname === "/stream" ? "TELEMETRY_STREAM" : "MARKET_STREAM";
}

export function buildTradingEngineFetchRequestContext(
  request: Request
): TradingEngineFetchRequestContext {
  const url = new URL(request.url);

  return {
    url,
    requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    topology: readTopologyHeaders(request),
    isMarketDataRequest: isTradingEngineMarketDataRequest({
      pathname: url.pathname,
      sourceHeader: request.headers.get("x-source") ?? ""
    }),
    webSocketRoute: classifyTradingEngineWebSocketRoute({
      pathname: url.pathname,
      upgradeHeader: request.headers.get("Upgrade")
    })
  };
}

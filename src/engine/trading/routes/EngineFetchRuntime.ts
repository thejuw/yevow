export type TradingEngineWebSocketRoute = "TELEMETRY_STREAM" | "MARKET_STREAM";

export interface MarketDataRequestInput {
  readonly pathname: string;
  readonly sourceHeader: string;
}

export interface WebSocketRouteInput {
  readonly pathname: string;
  readonly upgradeHeader: string | null;
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

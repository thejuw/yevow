import type { EdgeTopology } from "../../../types";
import { json } from "../helpers/RuntimeParsing";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import { readTopologyHeaders } from "../helpers/PlacementResolver";
import {
  createTradingEngineHttpRouteContext,
  handleTradingEngineHttpRoute,
  type EngineHttpRouteContextTarget
} from "./EngineHttpRoutes";
import {
  acceptMarketStream,
  acceptTelemetryStream,
  createTradingEngineStreamContext,
  type EngineStreamContextTarget
} from "./EngineWebSocketStreams";

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

export interface TradingEngineFetchRuntimeInput {
  readonly request: Request;
  readonly initialized: Promise<void>;
}

export interface TradingEngineFetchRuntimeHandlers {
  readonly rememberWakeUpTime: (wakeUpTimeMs: number) => void;
  readonly observeTopology: (topology: EdgeTopology) => void;
  readonly warmUpForTopology: (topology: EdgeTopology) => void;
  readonly acceptTelemetryStream: () => Response;
  readonly acceptMarketStream: () => Response;
  readonly handleHttpRoute: (
    request: Request,
    url: URL,
    wakeUpTimeMs: number | null
  ) => Promise<Response>;
  readonly logRequestFailure: (error: {
    readonly pathname: string;
    readonly requestId: string;
    readonly message: string;
  }) => void;
}

export interface TradingEngineFetchTarget {
  readonly initialized: Promise<void>;
  latestWakeUpTimeMs: number | null;
  readonly logger: {
    error(
      eventType: string,
      message: string,
      telemetry?: Record<string, unknown>,
      correlationId?: string
    ): void;
  };
  observeTopology(topology: EdgeTopology): void;
  warmUpForTopology(topology: EdgeTopology): void;
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

export async function handleTradingEngineFetchRuntime(
  input: TradingEngineFetchRuntimeInput,
  handlers: TradingEngineFetchRuntimeHandlers
): Promise<Response> {
  const fetchStartedAt = highResolutionNow();
  await input.initialized;
  const wakeUpTimeMs = roundLatency(highResolutionNow() - fetchStartedAt);
  handlers.rememberWakeUpTime(wakeUpTimeMs);

  const routeContext = buildTradingEngineFetchRequestContext(input.request);
  if (routeContext.isMarketDataRequest) {
    handlers.observeTopology(routeContext.topology);
    handlers.warmUpForTopology(routeContext.topology);
  }

  if (routeContext.webSocketRoute === "TELEMETRY_STREAM") {
    return handlers.acceptTelemetryStream();
  }

  if (routeContext.webSocketRoute === "MARKET_STREAM") {
    return handlers.acceptMarketStream();
  }

  try {
    return await handlers.handleHttpRoute(input.request, routeContext.url, wakeUpTimeMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") ? 400 : 500;

    handlers.logRequestFailure({
      pathname: routeContext.url.pathname,
      requestId: routeContext.requestId,
      message
    });

    return json({ ok: false, error: message, requestId: routeContext.requestId }, status);
  }
}

export function handleTradingEngineFetchForTarget(
  request: Request,
  target: TradingEngineFetchTarget
): Promise<Response> {
  return handleTradingEngineFetchRuntime(
    {
      request,
      initialized: target.initialized
    },
    {
      rememberWakeUpTime: (wakeUpTimeMs) => {
        target.latestWakeUpTimeMs = wakeUpTimeMs;
      },
      observeTopology: (topology) => {
        target.observeTopology(topology);
      },
      warmUpForTopology: (topology) => {
        target.warmUpForTopology(topology);
      },
      acceptTelemetryStream: () =>
        acceptTelemetryStream(
          createTradingEngineStreamContext(target as unknown as EngineStreamContextTarget)
        ),
      acceptMarketStream: () =>
        acceptMarketStream(
          createTradingEngineStreamContext(target as unknown as EngineStreamContextTarget)
        ),
      handleHttpRoute: (currentRequest, url, wakeUpTimeMs) =>
        handleTradingEngineHttpRoute(
          currentRequest,
          url,
          createTradingEngineHttpRouteContext(
            target as unknown as EngineHttpRouteContextTarget,
            wakeUpTimeMs
          )
        ),
      logRequestFailure: (failure) => {
        target.logger.error(
          "ENGINE_REQUEST_FAILED",
          "Trading engine request failed",
          { path: failure.pathname, message: failure.message },
          failure.requestId
        );
      }
    }
  );
}

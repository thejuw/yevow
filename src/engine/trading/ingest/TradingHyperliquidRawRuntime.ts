import type { TickIngestResult } from "../TradingEngineRouteTypes";
import {
  dispatchHyperliquidRawMessageRoute,
  handleHyperliquidRawBatch,
  type HyperliquidRawIngestPayload
} from "./HyperliquidRawRouting";

export interface TradingHyperliquidRawBatchTarget {
  readonly activeIngestConnections: Map<string, string>;
  ingestQueue: Promise<void>;
  handleHyperliquidRawMessage(
    raw: unknown,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult>;
}

export interface TradingHyperliquidRawRouteTarget {
  handleHyperliquidL2Book(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult>;
  handleHyperliquidTrades(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult>;
  handleHyperliquidAssetContext(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult>;
  handleHyperliquidLiquidationEvents(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload
  ): Promise<TickIngestResult>;
}

export function handleTradingHyperliquidRaw(
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  target: TradingHyperliquidRawBatchTarget
): Promise<TickIngestResult> {
  return handleHyperliquidRawBatch(payload, wakeUpTimeMs, {
    activeIngestConnections: target.activeIngestConnections,
    enqueueRawMessage: (raw, rawPayload, wakeUp) =>
      enqueueTradingHyperliquidRawMessage(raw, rawPayload, wakeUp, target)
  });
}

export function enqueueTradingHyperliquidRawMessage(
  raw: unknown,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  target: TradingHyperliquidRawBatchTarget
): Promise<TickIngestResult> {
  const job = target.ingestQueue.then(() =>
    target.handleHyperliquidRawMessage(raw, payload, wakeUpTimeMs)
  );
  target.ingestQueue = job.then(
    () => undefined,
    () => undefined
  );

  return job;
}

export function handleTradingHyperliquidRawMessage(
  raw: unknown,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  target: TradingHyperliquidRawRouteTarget
): Promise<TickIngestResult> {
  return dispatchHyperliquidRawMessageRoute(raw, payload, wakeUpTimeMs, {
    handleL2Book: (routeRaw, routePayload, wakeUp) =>
      target.handleHyperliquidL2Book(routeRaw, routePayload, wakeUp),
    handleTrades: (routeRaw, routePayload, wakeUp) =>
      target.handleHyperliquidTrades(routeRaw, routePayload, wakeUp),
    handleAssetContext: (routeRaw, routePayload, wakeUp) =>
      target.handleHyperliquidAssetContext(routeRaw, routePayload, wakeUp),
    handleLiquidationEvents: (routeRaw, routePayload) =>
      target.handleHyperliquidLiquidationEvents(routeRaw, routePayload)
  });
}

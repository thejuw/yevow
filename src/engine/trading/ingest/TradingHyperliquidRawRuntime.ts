import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { MarketTick } from "../../../types";
import {
  handleTradingEngineLiquidationEvents,
  type TradingLiquidationIngestTarget
} from "../cascade/CascadeLiquidationRuntime";
import {
  dispatchHyperliquidRawMessageRoute,
  handleHyperliquidRawBatch,
  processHyperliquidAssetContext,
  processHyperliquidTradeBatch,
  type HyperliquidRawIngestPayload
} from "./HyperliquidRawRouting";
import {
  handleTradingEngineHyperliquidL2Book,
  type TradingHyperliquidL2BookTarget
} from "./TradingHyperliquidL2BookRuntime";
import {
  handleTickForTarget,
  type TradingTickHandlingTarget
} from "../pipelines/TickHandlingRuntime";

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

export interface TradingHyperliquidRawEngineTarget {
  readonly activeIngestConnections: Map<string, string>;
  ingestQueue: Promise<void>;
  handleTick?(tick: MarketTick, wakeUpTimeMs: number | null): Promise<TickIngestResult>;
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

export function handleTradingHyperliquidRawForTarget(
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  target: TradingHyperliquidRawEngineTarget
): Promise<TickIngestResult> {
  return handleHyperliquidRawBatch(payload, wakeUpTimeMs, {
    activeIngestConnections: target.activeIngestConnections,
    enqueueRawMessage: (raw, rawPayload, wakeUp) =>
      enqueueTradingHyperliquidRawMessageForTarget(raw, rawPayload, wakeUp, target)
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

export function enqueueTradingHyperliquidRawMessageForTarget(
  raw: unknown,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  target: TradingHyperliquidRawEngineTarget
): Promise<TickIngestResult> {
  const job = target.ingestQueue.then(() =>
    handleTradingHyperliquidRawMessageForTarget(raw, payload, wakeUpTimeMs, target)
  );
  target.ingestQueue = job.then(
    () => undefined,
    () => undefined
  );

  return job;
}

export function handleTradingHyperliquidRawMessageForTarget(
  raw: unknown,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  target: TradingHyperliquidRawEngineTarget
): Promise<TickIngestResult> {
  return dispatchHyperliquidRawMessageRoute(raw, payload, wakeUpTimeMs, {
    handleL2Book: (routeRaw, routePayload, wakeUp) =>
      handleTradingEngineHyperliquidL2Book(
        routeRaw,
        routePayload,
        wakeUp,
        target as unknown as TradingHyperliquidL2BookTarget
      ),
    handleTrades: (routeRaw, routePayload, wakeUp) =>
      processHyperliquidTradeBatch(routeRaw, routePayload, wakeUp, {
        processTick: (tick, tickWakeUp) => handleRawTickForTarget(target, tick, tickWakeUp)
      }),
    handleAssetContext: (routeRaw, routePayload, wakeUp) =>
      processHyperliquidAssetContext(routeRaw, routePayload, wakeUp, {
        processTick: (tick, tickWakeUp) => handleRawTickForTarget(target, tick, tickWakeUp)
      }),
    handleLiquidationEvents: (routeRaw, routePayload) =>
      Promise.resolve(
        handleTradingEngineLiquidationEvents(
          routeRaw,
          routePayload,
          target as unknown as TradingLiquidationIngestTarget
        )
      )
  });
}

function handleRawTickForTarget(
  target: TradingHyperliquidRawEngineTarget,
  tick: MarketTick,
  wakeUpTimeMs: number | null
): Promise<TickIngestResult> {
  return target.handleTick
    ? target.handleTick(tick, wakeUpTimeMs)
    : handleTickForTarget(tick, wakeUpTimeMs, {}, target as unknown as TradingTickHandlingTarget);
}

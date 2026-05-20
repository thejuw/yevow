import {
  createNativeHyperliquidFundingTick,
  createNativeHyperliquidTradeTick,
  normalizeSourceExchange
} from "../helpers/NativeHyperliquidRuntime";
import { isNativeRecord, nativeObject, nativeString } from "../helpers/NativeValueRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { EngineState, MarketTick } from "../../../types";

export interface HyperliquidRawIngestPayload {
  streamId?: string;
  source?: "HYPERLIQUID";
  source_exchange?: string;
  transport?: "websocket" | "grpc";
  exchangeCode?: string;
  instrumentCode?: string;
  sourceWeight?: number;
  connectionId?: string | null;
  receivedAt?: string;
  raw?: unknown;
  messages?: unknown[];
}

export interface HyperliquidRawBatchContext {
  activeIngestConnections: Map<string, string>;
  enqueueRawMessage(
    raw: unknown,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult>;
}

export interface HyperliquidTickProcessorContext {
  processTick(tick: MarketTick, wakeUpTimeMs: number | null): Promise<TickIngestResult>;
}

export type HyperliquidIngestConnectionRegistration =
  | {
      readonly registered: false;
      readonly reason: "MISSING_CONNECTION_ID";
      readonly source_exchange: string;
      readonly streamId: string | null;
      readonly observedAt: string;
    }
  | {
      readonly registered: true;
      readonly source_exchange: string;
      readonly streamId: string | null;
      readonly connectionId: string;
      readonly reason: unknown;
      readonly observedAt: string;
    };

export interface HyperliquidIngestConnectionSideEffectInput {
  readonly registration: HyperliquidIngestConnectionRegistration;
  readonly currentState: EngineState;
  readonly engineStateKey: string;
}

export interface HyperliquidIngestConnectionSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly persistState: (key: string, state: EngineState, reason: string) => void;
}

export type HyperliquidRawMessageRoute =
  | {
      readonly kind: "CONTROL";
      readonly raw: Record<string, unknown>;
      readonly channel: string | null;
    }
  | { readonly kind: "L2_BOOK"; readonly raw: Record<string, unknown> }
  | { readonly kind: "TRADES"; readonly raw: Record<string, unknown> }
  | { readonly kind: "ASSET_CONTEXT"; readonly raw: Record<string, unknown> }
  | { readonly kind: "LIQUIDATION_EVENTS"; readonly raw: Record<string, unknown> }
  | { readonly kind: "IGNORED"; readonly raw: Record<string, unknown>; readonly reason: string };

export interface HyperliquidRawMessageRouteHandlers {
  readonly handleL2Book: (
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ) => Promise<TickIngestResult>;
  readonly handleTrades: (
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ) => Promise<TickIngestResult>;
  readonly handleAssetContext: (
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ) => Promise<TickIngestResult>;
  readonly handleLiquidationEvents: (
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload
  ) => Promise<TickIngestResult>;
}

export async function handleHyperliquidRawBatch(
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  context: HyperliquidRawBatchContext
): Promise<TickIngestResult> {
  if (!isActiveHyperliquidIngestConnection(context.activeIngestConnections, payload)) {
    return {
      accepted: false,
      status: "IGNORED",
      reason: "STALE_INGEST_CONNECTION",
      processedCount: 0
    };
  }

  let processedCount = 0;
  let terminalResult: TickIngestResult | null = null;

  for (const raw of hyperliquidRawMessages(payload, 250)) {
    const result = await context.enqueueRawMessage(raw, payload, wakeUpTimeMs);
    processedCount += result.processedCount ?? (result.accepted ? 1 : 0);
    terminalResult = result;

    if (result.status === "DESYNC" || result.status === "STALE") {
      break;
    }
  }

  return {
    ...(terminalResult ?? { accepted: true, status: "FRESH" as const }),
    processedCount
  };
}

export async function dispatchHyperliquidRawMessageRoute(
  raw: unknown,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  handlers: HyperliquidRawMessageRouteHandlers
): Promise<TickIngestResult> {
  const route = routeHyperliquidRawMessage(raw);

  if (route.kind === "CONTROL") {
    return { accepted: true, status: "FRESH", processedCount: 0 };
  }

  if (route.kind === "L2_BOOK") {
    return handlers.handleL2Book(route.raw, payload, wakeUpTimeMs);
  }

  if (route.kind === "TRADES") {
    return handlers.handleTrades(route.raw, payload, wakeUpTimeMs);
  }

  if (route.kind === "ASSET_CONTEXT") {
    return handlers.handleAssetContext(route.raw, payload, wakeUpTimeMs);
  }

  if (route.kind === "LIQUIDATION_EVENTS") {
    return handlers.handleLiquidationEvents(route.raw, payload);
  }

  return {
    accepted: false,
    status: "BOOK_NOT_READY",
    reason: route.reason,
    processedCount: 0
  };
}

export function routeHyperliquidRawMessage(raw: unknown): HyperliquidRawMessageRoute {
  if (!isNativeRecord(raw)) {
    throw new Error("INVALID_HYPERLIQUID_RAW_MESSAGE");
  }

  const channel = nativeString(raw.channel)?.toLowerCase() ?? null;

  if (channel === "subscriptionresponse" || channel === "pong") {
    return { kind: "CONTROL", raw, channel };
  }

  if (channel === "l2book") {
    return { kind: "L2_BOOK", raw };
  }

  if (channel === "trades") {
    return { kind: "TRADES", raw };
  }

  if (channel === "activeassetctx" || channel === "alldexsassetctxs") {
    return { kind: "ASSET_CONTEXT", raw };
  }

  if (
    channel === "userevents" ||
    channel === "usernonfundingledgerupdates" ||
    channel === "events" ||
    channel === "liquidation"
  ) {
    return { kind: "LIQUIDATION_EVENTS", raw };
  }

  return {
    kind: "IGNORED",
    raw,
    reason: `IGNORED_HYPERLIQUID_CHANNEL_${channel ?? "UNKNOWN"}`
  };
}

export async function processHyperliquidTradeBatch(
  raw: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  context: HyperliquidTickProcessorContext
): Promise<TickIngestResult> {
  const rawData: unknown = raw.data;
  const data: readonly unknown[] = Array.isArray(rawData) ? rawData : [];
  const maxTrades = Math.min(data.length, 100);
  let processedCount = 0;
  let terminalResult: TickIngestResult = {
    accepted: true,
    status: "FRESH",
    processedCount: 0
  };

  for (let index = 0; index < maxTrades; index += 1) {
    const item = data[index];

    if (!isNativeRecord(item)) {
      continue;
    }

    terminalResult = await context.processTick(
      createNativeHyperliquidTradeTick(item, payload),
      wakeUpTimeMs
    );
    processedCount += 1;

    if (terminalResult.status === "STALE" || terminalResult.status === "DESYNC") {
      break;
    }
  }

  return { ...terminalResult, processedCount };
}

export async function processHyperliquidAssetContext(
  raw: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  context: HyperliquidTickProcessorContext
): Promise<TickIngestResult> {
  const data = nativeObject(raw.data) ?? raw;
  const result = await context.processTick(
    createNativeHyperliquidFundingTick(data, payload),
    wakeUpTimeMs
  );

  return {
    ...result,
    processedCount: 1
  };
}

export function hyperliquidIngestConnectionKey(
  sourceExchange: string | null | undefined,
  streamId?: string | null
): string {
  return `${normalizeSourceExchange(sourceExchange ?? "hyperliquid")}:${streamId ?? "default"}`;
}

export function isActiveHyperliquidIngestConnection(
  activeIngestConnections: Map<string, string>,
  payload: HyperliquidRawIngestPayload
): boolean {
  if (!payload.connectionId) {
    return true;
  }

  const key = hyperliquidIngestConnectionKey(payload.source_exchange, payload.streamId);
  const fallbackKey = hyperliquidIngestConnectionKey(payload.source_exchange, null);
  const activeConnection = payload.streamId
    ? activeIngestConnections.get(key)
    : activeIngestConnections.get(fallbackKey);

  return !activeConnection || activeConnection === payload.connectionId;
}

export function registerHyperliquidIngestConnection(
  activeIngestConnections: Map<string, string>,
  payload: {
    source_exchange?: string | null;
    streamId?: string | null;
    connectionId?: string | null;
    reason?: unknown;
  },
  observedAt = new Date().toISOString()
): HyperliquidIngestConnectionRegistration {
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const streamId =
    typeof payload.streamId === "string" && payload.streamId.length > 0 ? payload.streamId : null;
  const connectionId =
    typeof payload.connectionId === "string" && payload.connectionId.length > 0
      ? payload.connectionId
      : null;

  if (!connectionId) {
    return {
      registered: false,
      reason: "MISSING_CONNECTION_ID",
      source_exchange: sourceExchange,
      streamId,
      observedAt
    };
  }

  activeIngestConnections.set(
    hyperliquidIngestConnectionKey(sourceExchange, streamId),
    connectionId
  );

  if (!streamId) {
    activeIngestConnections.set(hyperliquidIngestConnectionKey(sourceExchange, null), connectionId);
  }

  return {
    registered: true,
    source_exchange: sourceExchange,
    streamId,
    connectionId,
    reason: payload.reason ?? "INGEST_CONNECTION_REGISTERED",
    observedAt
  };
}

export function applyHyperliquidIngestConnectionSideEffects(
  input: HyperliquidIngestConnectionSideEffectInput,
  handlers: HyperliquidIngestConnectionSideEffectHandlers
): Record<string, unknown> {
  if (!input.registration.registered) {
    return input.registration;
  }

  const nextState = {
    ...input.currentState,
    heartbeatAt: input.registration.observedAt,
    updatedAt: input.registration.observedAt
  };
  handlers.applyState(nextState);
  handlers.persistState(input.engineStateKey, nextState, "INGEST_CONNECTION_REGISTERED");

  return input.registration;
}

export function hyperliquidRawMessages(
  payload: HyperliquidRawIngestPayload,
  limit: number
): unknown[] {
  const messages = Array.isArray(payload.messages) ? payload.messages : [payload.raw ?? payload];
  return messages.slice(0, Math.max(0, limit));
}

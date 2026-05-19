/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-type-conversion, @typescript-eslint/no-unnecessary-boolean-literal-compare, @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unnecessary-type-assertion */
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { defaultConfig } from "./ConfigManager";
import { neutralMacroBias } from "./Governor";
import { defaultLiquidationHeatmapState } from "./agents/HeatmapAgent";
import { defaultOracleState } from "./agents/OracleAgent";
import { defaultSentimentState } from "./agents/SentimentAgent";
import type { CroupierDecision } from "./agents/CroupierAgent";
import { PROFILER_STATE_STORAGE_PREFIX, type ProfilerEvaluation } from "./agents/ProfilerAgent";
import { isShadowMode } from "./utils/CitadelProtocol";
import type { GhostBookConfig } from "./utils/GhostBook";
import { defaultEngineLocation } from "./engine/trading/helpers/PlacementResolver";
import { buildMicrostructureSnapshot } from "./engine/trading/book/BookReconstruction";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  priceKey,
  roundCrypto,
  roundMetric,
  SortedBookSide
} from "./engine/trading/book/SortedBookSide";
import type { BookDeltaWithTicker, BookSyncState } from "./engine/trading/book/BookTypes";
import type { LogPruneReport } from "./engine/LogRetention";
import type { ReplayOptions, ReplayScenario } from "./engine/trading/routes/ReplayAdminRoutes";
import type {
  AdminConfigUpdate,
  AgentHealth,
  AgentName,
  AgentSignal,
  AssetRuntimeState,
  DomAnalysisSnapshot,
  DomHeatmapCell,
  EngineLocation,
  EngineState,
  Env,
  ExecutionReport,
  ExecutionProfile,
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  JsonValue,
  LatencyMetrics,
  LiquidityWall,
  MacroBias,
  MarketTick,
  ManagedOrder,
  MicrostructureMetrics,
  OrderBookSide,
  OrderBookSnapshotLevel,
  PriceDiscoveryMetrics,
  PriceLevel,
  ProfilerState,
  ReplayResult,
  RiskLimits,
  SentimentState,
  ShadowQueueState,
  TradeExecution,
  TradeIntent
} from "./types";
import type {
  AbsorptionConfirmed,
  CascadeEvent,
  CascadeOpenPosition
} from "./strategy/cascade/types";
import {
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  CASCADE_POSITIONS_KEY,
  CASCADE_PAPER_ARMED_AT_KEY,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  REPLAY_STATUS_KEY,
  RISK_LIMITS_KEY,
  CONFIG_KEY,
  DEFAULT_MAX_LATENCY_MS,
  DEFAULT_NATIVE_HL_MAX_LATENCY_MS,
  DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS,
  DEFAULT_HARD_STALE_DROP_MS,
  DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
  DEFAULT_HL_SEQUENCE_GAP_MS,
  PERFORMANCE_HISTORY_LIMIT,
  CONFIG_ALARM_INTERVAL_MS,
  WARM_UP_INTERVAL_MS,
  SIGNAL_BUFFER_LIMIT,
  DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
  TELEMETRY_BUFFER_LIMIT,
  ADMIN_STREAM_PULSE_INTERVAL_MS,
  AGENT_SNAPSHOT_TICK_INTERVAL,
  DEFAULT_HOT_STORAGE_SNAPSHOT_INTERVAL_MS,
  DEFAULT_HOT_STORAGE_SNAPSHOT_TICK_INTERVAL,
  STORAGE_WRITE_BACKOFF_MS,
  BOOK_SNAPSHOT_TOP_LEVELS,
  TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS,
  DEFAULT_SOURCE_WEIGHT,
  DEFAULT_PROFILER_BUCKET_VOLUME,
  DEFAULT_PROFILER_ROLLING_WINDOW,
  DEFAULT_PROFILER_ALERT_THRESHOLD,
  PROCESSING_LATENCY_SAMPLES_KEY,
  DOM_WALL_HISTORY_KEY,
  RATE_LIMIT_STATE_KEY,
  EXECUTION_QUEUE_KEY,
  PAPER_SESSION_STARTED_AT_KEY,
  HOT_PATH_LOG_THROTTLE_MS,
  DEFAULT_JITTER_SAMPLE_WINDOW,
  DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
  DEFAULT_JITTER_THRESHOLD_MS,
  COLD_START_WAKEUP_THRESHOLD_MS,
  DEFAULT_DOM_PRICE_BIN_SIZE,
  DEFAULT_DOM_SCAN_RANGE_PCT,
  DEFAULT_DOM_WALL_HISTORY_LIMIT,
  DEFAULT_DOM_SPOOF_PROXIMITY_BPS,
  DOM_MAX_LEVELS_PER_SIDE,
  DEFAULT_ANOMALY_PRICE_Z_THRESHOLD,
  DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD,
  DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD,
  DEFAULT_ANOMALY_PRICE_WINDOW_MS,
  DEFAULT_ANOMALY_VOLUME_WINDOW_MS,
  DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS,
  DEFAULT_EXCHANGE_FEE_BPS,
  DEFAULT_MIN_EV_THRESHOLD,
  DEFAULT_MAX_POSITION_PCT,
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_MAX_INVENTORY_DELTA,
  DEFAULT_RISK_AVERSION_FACTOR,
  DEFAULT_FUNDING_BIAS_THRESHOLD,
  DEFAULT_FUNDING_INVENTORY_BIAS,
  DEFAULT_AMM_MIN_TICK_CHANGE,
  DEFAULT_HEATMAP_PRICE_BIN_SIZE,
  DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD,
  DEFAULT_CASCADE_DISTANCE_PCT,
  DEFAULT_PREDATORY_ORDER_OFFSET_BPS,
  DEFAULT_WHALE_PRINT_Z_THRESHOLD,
  DEFAULT_QUOTE_HIBERNATE_MS,
  DEFAULT_PAPER_BANKROLL_USD,
  DEFAULT_PAPER_MAX_GHOST_FILLS_PER_MINUTE,
  DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
  DEFAULT_PAPER_FILL_ADVERSE_BPS,
  DEFAULT_PAPER_MAKER_FEE_BPS,
  DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
  DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS,
  DEFAULT_CROSS_ASSET_CANCEL_LEAD_BPS,
  DEFAULT_CROSS_ASSET_CANCEL_COOLDOWN_MS,
  DEFAULT_MARKET_TICK_JOURNAL_INTERVAL,
  DEFAULT_MARKET_TICK_MAX_ROWS,
  DEFAULT_SHADOW_VLO_CAPACITY,
  DEFAULT_SHADOW_VLO_DRIFT_TRADES,
  DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
  DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
  DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
  DEFAULT_SHADOW_VLO_MIN_SIZE,
  DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
  DEFAULT_VAR_CONFIDENCE_Z,
  TARGET_ASSET_MATRIX,
  TARGET_INSTRUMENTS,
  DEFAULT_JANITOR_INTERVAL_MS,
  DEFAULT_ORDER_ACK_TIMEOUT_MS,
  AGGREGATED_BUS_TELEMETRY_TYPES
} from "./TradingEngineConstants";

interface HyperliquidRawIngestPayload {
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

interface QueuedExecutionIntent {
  intent: TradeIntent;
  priority: "CANCEL" | "NEW";
  runAfterMs: number;
  enqueuedAt: string;
}

interface DomBinAccumulator {
  side: OrderBookSide;
  priceStart: number;
  priceEnd: number;
  centerPrice: number;
  volume: number;
  levelCount: number;
}

export function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativeObject(value: unknown): Record<string, unknown> | null {
  return isNativeRecord(value) ? value : null;
}

export function nativeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function requireNativeString(value: unknown, field: string): string {
  const parsed = nativeString(value);

  if (!parsed) {
    throw new Error(`MISSING_HYPERLIQUID_${field.toUpperCase()}`);
  }

  return parsed;
}

export function nativeIso(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function nativeExchangeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(epochMillis(value)).toISOString();
  }

  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
      return new Date(epochMillis(numeric)).toISOString();
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  return null;
}

export function epochMillis(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

export function nativeSequence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return nativeHashSequence(String(value ?? Date.now()));
}

export function nativeHashSequence(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

export function hyperliquidNativeInstrumentCode(coin: string, fallback?: string | null): string {
  const fallbackCode =
    typeof fallback === "string" && fallback.trim() !== ""
      ? normalizeNativeInstrumentCode(fallback)
      : null;
  const normalizedCoin = normalizeNativeCoin(coin);

  if (fallbackCode) {
    const [fallbackBase] = splitNativeInstrument(fallbackCode).baseAsset.split("-");
    const coinBase = normalizedCoin.toLowerCase();

    if (fallbackCode.includes(coinBase) || fallbackBase === coinBase) {
      return fallbackCode;
    }
  }

  return `${normalizedCoin.toLowerCase()}-usd`;
}

export function normalizeNativeCoin(value: string): string {
  return value
    .trim()
    .replace(/-perp$/i, "")
    .replace(/-usd$/i, "")
    .replace(/-usdc$/i, "")
    .replace(/-usdt$/i, "")
    .toUpperCase();
}

export function normalizeNativeInstrumentCode(value: string): string {
  return value
    .trim()
    .replace(/_/g, "-")
    .replace(/\//g, "-")
    .replace(/-perp$/i, "")
    .toLowerCase();
}

export function normalizeInstrumentSelector(value: string): string {
  const rawInstrument = value.includes(":") ? value.split(":").slice(1).join(":") : value;
  const normalized = normalizeNativeInstrumentCode(rawInstrument);

  if (!normalized.includes("-")) {
    return `${normalizeNativeCoin(normalized).toLowerCase()}-usd`;
  }

  return normalized;
}

export function splitNativeInstrument(instrumentCode: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  const [baseAsset, ...quoteParts] = normalized.split("-");

  return {
    baseAsset: baseAsset || "unknown",
    quoteAsset: quoteParts.join("-") || "usd"
  };
}

export function baseAssetFromInstrument(instrumentCode: string): string {
  return splitNativeInstrument(instrumentCode).baseAsset.toUpperCase();
}

export function cascadeInstrumentSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((asset) => asset.trim().toUpperCase())
      .filter((asset) => /^[A-Z0-9]{2,12}$/.test(asset))
  );
}

export function latestAbsorptionForInstrument(
  absorptions: ReadonlyMap<string, AbsorptionConfirmed>,
  instrumentCode: string
): AbsorptionConfirmed | null {
  let selected: AbsorptionConfirmed | null = null;
  for (const absorption of absorptions.values()) {
    if (absorption.instrumentCode !== instrumentCode.toLowerCase()) {
      continue;
    }
    if (!selected || Date.parse(absorption.confirmedAt) > Date.parse(selected.confirmedAt)) {
      selected = absorption;
    }
  }
  return selected;
}

export function latestCascadeAtForInstrument(
  cascades: ReadonlyMap<string, CascadeEvent>,
  currentCascade: CascadeEvent
): string | null {
  let selected: string | null = null;
  for (const cascade of cascades.values()) {
    if (
      cascade.cascadeId === currentCascade.cascadeId ||
      cascade.instrumentCode !== currentCascade.instrumentCode
    ) {
      continue;
    }
    if (!selected || Date.parse(cascade.detectedAt) > Date.parse(selected)) {
      selected = cascade.detectedAt;
    }
  }
  return selected;
}

export function isOpenCascadePosition(position: CascadeOpenPosition): boolean {
  return (
    position.remainingSize > 0 &&
    position.status !== "CLOSED" &&
    position.status !== "STOPPED_OUT" &&
    position.status !== "TIME_STOPPED"
  );
}

export function recentSwingLow(candles: readonly { low: number }[]): number | null {
  if (candles.length === 0) {
    return null;
  }
  let low = Number.POSITIVE_INFINITY;
  for (const candle of candles.slice(-20)) {
    low = Math.min(low, candle.low);
  }
  return Number.isFinite(low) ? low : null;
}

export function recentSwingHigh(candles: readonly { high: number }[]): number | null {
  if (candles.length === 0) {
    return null;
  }
  let high = Number.NEGATIVE_INFINITY;
  for (const candle of candles.slice(-20)) {
    high = Math.max(high, candle.high);
  }
  return Number.isFinite(high) ? high : null;
}

export function parseHyperliquidNativeLevels(
  levels: unknown,
  receivedAt: string
): [OrderBookSnapshotLevel[], OrderBookSnapshotLevel[]] {
  if (Array.isArray(levels)) {
    return [
      nativeBookSideLevels(levels[0], receivedAt),
      nativeBookSideLevels(levels[1], receivedAt)
    ];
  }

  if (isNativeRecord(levels)) {
    return [
      nativeBookSideLevels(levels.bids ?? levels.bid, receivedAt),
      nativeBookSideLevels(levels.asks ?? levels.ask, receivedAt)
    ];
  }

  return [[], []];
}

export function nativeBookSideLevels(value: unknown, receivedAt: string): OrderBookSnapshotLevel[] {
  const rawLevels = Array.isArray(value)
    ? value
    : isNativeRecord(value) && Array.isArray(value.levels)
      ? value.levels
      : [];
  const levels: OrderBookSnapshotLevel[] = [];

  for (const rawLevel of rawLevels) {
    let price: number | null = null;
    let size: number | null = null;

    if (Array.isArray(rawLevel)) {
      price = nativeNumber(rawLevel[0]);
      size = nativeNumber(rawLevel[1]);
    } else if (isNativeRecord(rawLevel)) {
      price = nativeNumber(rawLevel.px ?? rawLevel.price ?? rawLevel.p);
      size = nativeNumber(rawLevel.sz ?? rawLevel.size ?? rawLevel.s);
    }

    if (
      price !== null &&
      size !== null &&
      Number.isFinite(price) &&
      Number.isFinite(size) &&
      price >= 0 &&
      size >= 0
    ) {
      levels.push({ price, size, updatedAt: receivedAt });
    }
  }

  return levels;
}

export function nativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nativeSide(value: unknown): MarketTick["side"] {
  const side = nativeString(value)?.toUpperCase();

  if (side === "B" || side === "BUY" || side === "BID") {
    return "buy";
  }

  if (side === "A" || side === "ASK" || side === "SELL") {
    return "sell";
  }

  return "unknown";
}

export function createNativeHyperliquidBookTick(input: {
  payload: HyperliquidRawIngestPayload;
  coin: string;
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  exchangeTimestamp: string;
  receivedAt: string;
  price: number;
  bestBid?: number;
  bestAsk?: number;
  rawEventType: string;
}): MarketTick {
  const instrument = splitNativeInstrument(input.instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: input.sourceExchange,
    transport: input.payload.transport ?? "websocket",
    streamId: input.payload.streamId ?? null,
    connectionId: input.payload.connectionId ?? null,
    sourceChannel: input.rawEventType,
    exchangeCode: input.exchangeCode,
    instrumentCode: input.instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price: input.price,
    size: 0,
    side: "unknown",
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    exchangeTimestamp: input.exchangeTimestamp,
    synchronizedExchangeTimestamp: input.exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt: input.receivedAt,
    sourceWeight: input.sourceWeight,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    raw: toJsonValue({
      eventType: "book-snapshot",
      nativeEventType: input.rawEventType,
      commodity: "ORDER_BOOK",
      coin: input.coin,
      streamId: input.payload.streamId ?? null,
      connectionId: input.payload.connectionId ?? null
    }) as JsonRecord
  };
}

export function createNativeHyperliquidTradeTick(
  item: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload
): MarketTick {
  const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
  const coin = requireNativeString(item.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const price = nativeNumber(item.px ?? item.price ?? item.p);
  const size = nativeNumber(item.sz ?? item.size ?? item.s);
  const isBuy = typeof item.isBuy === "boolean" ? item.isBuy : null;
  const side = isBuy === null ? nativeSide(item.side) : isBuy ? "buy" : "sell";

  if (price === null || price < 0) {
    throw new Error("INVALID_HYPERLIQUID_TRADE_PRICE");
  }

  if (size === null || size < 0) {
    throw new Error("INVALID_HYPERLIQUID_TRADE_SIZE");
  }

  const exchangeTimestamp =
    nativeExchangeTimestamp(item.time ?? item.timestamp ?? item.T) ?? receivedAt;
  const sequence = nativeSequence(
    item.tid ??
      item.id ??
      item.hash ??
      `${coin}:${exchangeTimestamp}:${price}:${size}:${item.side ?? ""}`
  );
  const instrument = splitNativeInstrument(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    transport: payload.transport ?? "websocket",
    streamId: payload.streamId ?? null,
    connectionId: payload.connectionId ?? null,
    sourceChannel: "trades",
    exchangeCode,
    instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price,
    size,
    side,
    sequence,
    providerTimestamp: exchangeTimestamp,
    exchangeTimestamp,
    synchronizedExchangeTimestamp: exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight,
    raw: toJsonValue({
      eventType: "trade",
      commodity: "TRADE",
      coin,
      tradeId: item.tid ?? item.id ?? null,
      tradeHash: item.hash ?? null,
      aggressorSide: item.side ?? null,
      isBuy: isBuy ?? (side === "unknown" ? null : side === "buy"),
      streamId: payload.streamId ?? null,
      connectionId: payload.connectionId ?? null
    }) as JsonRecord
  };
}

export function createNativeHyperliquidFundingTick(
  data: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload
): MarketTick {
  const ctx = nativeObject(data.ctx) ?? data;
  const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
  const coin = requireNativeString(data.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const markPrice = nativeNumber(ctx.markPx ?? ctx.markPrice);
  const oraclePrice = nativeNumber(ctx.oraclePx ?? ctx.oraclePrice);
  const midPrice = nativeNumber(ctx.midPx ?? ctx.midPrice);
  const price = midPrice ?? markPrice ?? oraclePrice ?? 0;
  const exchangeTimestamp =
    nativeExchangeTimestamp(data.time ?? data.timestamp ?? ctx.time) ?? receivedAt;
  const fundingRateHourly = nativeNumber(ctx.funding ?? ctx.fundingRate) ?? 0;
  const openInterest = nativeNumber(ctx.openInterest);
  const sequence = nativeSequence(`${coin}:${exchangeTimestamp}:funding`);
  const instrument = splitNativeInstrument(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    transport: payload.transport ?? "websocket",
    streamId: payload.streamId ?? null,
    connectionId: payload.connectionId ?? null,
    sourceChannel: "activeAssetCtx",
    exchangeCode,
    instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price,
    size: 0,
    side: "unknown",
    sequence,
    providerTimestamp: exchangeTimestamp,
    exchangeTimestamp,
    synchronizedExchangeTimestamp: exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight,
    fundingRateHourly,
    markPrice: markPrice ?? undefined,
    oraclePrice: oraclePrice ?? undefined,
    openInterest: openInterest ?? undefined,
    raw: toJsonValue({
      eventType: "funding",
      commodity: "FUNDING",
      coin,
      fundingRateHourly,
      markPrice,
      oraclePrice,
      openInterest,
      premium: ctx.premium ?? null,
      dayNtlVlm: ctx.dayNtlVlm ?? null,
      streamId: payload.streamId ?? null,
      connectionId: payload.connectionId ?? null
    }) as JsonRecord
  };
}

export function nativeHyperliquidLatencyMetrics(input: {
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  exchangeTimestamp: string;
  receivedAt: string;
  brainTimestamp: string;
  totalLatencyMs: number;
  maxLatencyMs: number;
  averageLatencyMs: number;
  sampleCount: number;
  location: EngineLocation;
}): LatencyMetrics {
  const rawIngestMs = parseTimestampMs(input.receivedAt, "ingest_timestamp");
  const sourceMs = parseTimestampMs(input.exchangeTimestamp, "provider_timestamp");
  const brainMs = parseTimestampMs(input.brainTimestamp, "brain_timestamp");
  const ingestClockSkewMs = Math.max(0, rawIngestMs - brainMs);
  const ingestMs = ingestClockSkewMs > 0 ? brainMs : rawIngestMs;
  const ingestTimestamp = ingestClockSkewMs > 0 ? input.brainTimestamp : input.receivedAt;
  const totalLatencyMs = roundLatency(Math.max(0, input.totalLatencyMs));

  return {
    instrumentCode: input.instrumentCode,
    exchangeCode: input.exchangeCode,
    source: "HYPERLIQUID",
    sourceExchange: input.sourceExchange,
    sourceWeight: input.sourceWeight,
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    sourceTimestamp: input.exchangeTimestamp,
    ingestTimestamp,
    brainTimestamp: input.brainTimestamp,
    clockOffsetMs: ingestClockSkewMs,
    networkLatencyMs: roundLatency(Math.max(0, ingestMs - sourceMs)),
    processingLatencyMs: roundLatency(Math.max(0, brainMs - ingestMs)),
    totalLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    status: totalLatencyMs > input.maxLatencyMs ? "STALE" : "FRESH",
    colo: input.location.colo,
    placement: input.location.placement,
    latencyRiskMultiplier: input.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.location.positionSizeMultiplier,
    timeToBookMs: null
  };
}

export function hasRuntimeConfigUpdate(update: AdminConfigUpdate): boolean {
  return Boolean(
    update.mode ||
    update.bankroll ||
    update.risk ||
    update.maxLatencyMs !== undefined ||
    update.MAX_LATENCY !== undefined ||
    update.performance
  );
}

export function defaultEngineState(engineId: string): EngineState {
  const now = new Date().toISOString();
  const agentHealth = Object.fromEntries(
    (
      [
        "ORACLE",
        "SENTIMENT",
        "PROFILER",
        "CROUPIER",
        "PIT_BOSS",
        "JANITOR",
        "EXECUTIONER",
        "MOLTWORKER",
        "RISK",
        "SYSTEM"
      ] as AgentName[]
    ).map((agent) => [
      agent,
      {
        status: "YELLOW",
        heartbeatAt: now,
        latencyMs: 0,
        failures24h: 0
      } satisfies AgentHealth
    ])
  ) as Record<AgentName, AgentHealth>;

  return {
    engineId,
    mode: "PAPER",
    bankroll: {
      currency: "USD",
      cash: 0,
      equity: 0,
      realizedPnl: 0,
      updatedAt: now
    },
    openPositions: {},
    agentHealth,
    risk: defaultRiskLimits(),
    processedTicks: 0,
    acceptedSignals: 0,
    internalOrderBookDepth: 0,
    averageLatency: 0,
    latencySampleCount: 0,
    staleTickCount: 0,
    toxicityScore: 0,
    current_inventory_delta: 0,
    liquidationHeatmap: defaultLiquidationHeatmapState(),
    maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
    cachedConfig: { ...defaultConfig },
    macroBias: neutralMacroBias(),
    temporaryOverride: null,
    assetMatrix: defaultAssetMatrix(defaultConfig, neutralMacroBias(), now),
    profilerStates: {},
    location: defaultEngineLocation(),
    fundingRates: {},
    microstructure: defaultMicrostructure(),
    priceDiscovery: defaultPriceDiscovery(),
    oracle: defaultOracleState(),
    sentiment: defaultSentimentState(),
    ensemble: defaultEnsembleState(now),
    leadLag: defaultLeadLagMetrics(),
    inventory: defaultInventoryState(DEFAULT_MAX_INVENTORY_UNITS),
    riskMetrics: defaultRiskMetrics(0, now),
    quoteState: defaultQuoteState(),
    assetQuoteStates: defaultAssetQuoteStates(defaultConfig, neutralMacroBias(), now),
    shadowQueue: defaultShadowQueueState(null),
    lastTradeIntent: null,
    inventoryGuard: defaultInventoryGuardState(),
    janitor: defaultJanitorState(),
    slippage: defaultSlippageAnalytics(),
    orderMap: {},
    executionProfile: defaultExecutionProfile(
      DEFAULT_JITTER_THRESHOLD_MS,
      DEFAULT_JITTER_SAMPLE_WINDOW,
      DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
      0
    ),
    citadel: defaultCitadelState(now),
    dom: null,
    anomaly: defaultAnomalyStatus(),
    heartbeatAt: now,
    updatedAt: now
  };
}

export function defaultEnsembleState(observedAt: string): EngineState["ensemble"] {
  return {
    schemaVersion: "ensemble.v1",
    confidence: 0,
    kellyMultiplier: 0,
    regimeMultiplier: 1,
    anomalyCircuitBreaker: false,
    votes: [],
    rationale: "ENSEMBLE_NOT_EVALUATED",
    updatedAt: observedAt
  };
}

export function normalizePaperBankroll(
  bankroll: EngineState["bankroll"],
  env: Env,
  observedAt: string
): EngineState["bankroll"] {
  const cash = Number(bankroll.cash);
  const equity = Number(bankroll.equity);

  if (
    !isShadowMode(env) ||
    (Number.isFinite(cash) && cash > 0) ||
    (Number.isFinite(equity) && equity > 0)
  ) {
    return bankroll;
  }

  const paperBankroll = readPositiveNumber(env.PAPER_BANKROLL_USD, DEFAULT_PAPER_BANKROLL_USD);

  return {
    ...bankroll,
    cash: paperBankroll,
    equity: paperBankroll,
    realizedPnl: bankroll.realizedPnl ?? 0,
    updatedAt: observedAt
  };
}

export function parseDeltaNormalizationWeights(value: string | undefined): Record<string, number> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, weight]) => [key.toLowerCase(), Number(weight)] as const)
        .filter(([, weight]) => Number.isFinite(weight) && weight >= 0)
    );
  } catch {
    return {};
  }
}

export function inferSignalBias(signal: AgentSignal): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (signal.action === "BUY" || signal.expectedValue > 0) {
    return "BULLISH";
  }

  if (signal.action === "SELL" || signal.action === "REDUCE" || signal.expectedValue < 0) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

export function hawkesEvacuationSignal(signal: AgentSignal): boolean {
  return signal.action === "PAUSE" && signal.featureVector?.signalType === "HAWKES_FLOW_CLUSTER";
}

export function touchAgentHealth(
  current: Record<AgentName, AgentHealth>,
  agentName: AgentName,
  status: AgentHealth["status"],
  heartbeatAt: string,
  latencyMs: number,
  lastSignalId?: string
): Record<AgentName, AgentHealth> {
  return {
    ...current,
    [agentName]: {
      status,
      heartbeatAt,
      latencyMs,
      lastSignalId: lastSignalId ?? current[agentName].lastSignalId,
      failures24h: current[agentName].failures24h
    }
  };
}

export function disabledProfilerEvaluation(
  state: ProfilerState,
  observedAt: string
): ProfilerEvaluation {
  return {
    processed: false,
    skippedReason: "PROFILER_AGENT_DISABLED",
    closedBuckets: 0,
    toxicityScore: 0,
    state: {
      ...state,
      toxicityScore: 0,
      amVpinScore: 0,
      toxicityState: "NORMAL",
      pressureSide: "NEUTRAL",
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      quoteHaltUntil: null,
      updatedAt: observedAt
    },
    signal: null
  };
}

export function disabledCroupierDecision(minEvThreshold: number): CroupierDecision {
  return {
    intent: null,
    quote: null,
    pullAllQuotes: false,
    adverseSelectionCost: 0,
    minEvThreshold: Number.isFinite(minEvThreshold) ? minEvThreshold : 0
  };
}

export function defaultExecutionProfile(
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number
): ExecutionProfile {
  return {
    status: "STABLE",
    jitterMs: 0,
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: null,
    maxProcessingLatencyMs: null,
    lastProcessingLatencyMs: null,
    wakeUpTimeMs: null,
    coldStartSuspected: false,
    orderBookUpdateMs: null,
    agentLogicMs: null,
    totalHotPathMs: null,
    lastComputedAt: null,
    updatedAt: null
  };
}

export function defaultAnomalyStatus() {
  return {
    status: "CLEAR" as const,
    priceZScore: null,
    volumeZScore: null,
    cancellationToExecutionRatio: 0,
    cancellationCount: 0,
    executionCount: 0,
    lastAnomaly: null,
    updatedAt: null
  };
}

export function normalizeExecutionProfile(
  profile: ExecutionProfile | undefined,
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number,
  observedAt: string
): ExecutionProfile {
  const fallback = defaultExecutionProfile(
    jitterThresholdMs,
    sampleWindow,
    computeIntervalTicks,
    sampleCount
  );

  if (!profile) {
    return {
      ...fallback,
      updatedAt: observedAt
    };
  }

  return {
    ...fallback,
    ...profile,
    status: profile.status === "UNSTABLE" ? "UNSTABLE" : "STABLE",
    jitterMs: finiteMetric(profile.jitterMs, 0),
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: nullableFiniteMetric(profile.averageProcessingLatencyMs),
    maxProcessingLatencyMs: nullableFiniteMetric(profile.maxProcessingLatencyMs),
    lastProcessingLatencyMs: nullableFiniteMetric(profile.lastProcessingLatencyMs),
    wakeUpTimeMs: nullableFiniteMetric(profile.wakeUpTimeMs),
    coldStartSuspected: Boolean(profile.coldStartSuspected),
    orderBookUpdateMs: nullableFiniteMetric(profile.orderBookUpdateMs),
    agentLogicMs: nullableFiniteMetric(profile.agentLogicMs),
    totalHotPathMs: nullableFiniteMetric(profile.totalHotPathMs),
    lastComputedAt: typeof profile.lastComputedAt === "string" ? profile.lastComputedAt : null,
    updatedAt: observedAt
  };
}

export function defaultMicrostructure(): MicrostructureMetrics {
  return {
    marketKey: null,
    instrumentCode: null,
    exchangeCode: null,
    source_exchange: null,
    sourceWeight: DEFAULT_SOURCE_WEIGHT,
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    bidVolume: 0,
    askVolume: 0,
    weightedImbalance: null,
    depthLevels: 0,
    lastSequence: null,
    timeToBookMs: null,
    isSynced: false,
    updatedAt: null
  };
}

export function defaultPriceDiscovery(): PriceDiscoveryMetrics {
  return {
    instrumentCode: null,
    weightedMidPrice: null,
    primaryExchange: null,
    primaryWeight: 0,
    sourceCount: 0,
    sources: [],
    updatedAt: null
  };
}

export function defaultLeadLagMetrics(): EngineState["leadLag"] {
  return {
    schemaVersion: "lead-lag.v1",
    leadInstrument: null,
    lagInstrument: null,
    correlation: null,
    lagMs: null,
    leadLagDelta: null,
    expectedValue: null,
    executable: false,
    sampleCount: 0,
    updatedAt: null
  };
}

export function defaultInventoryState(
  maxInventoryUnits: number,
  maxInventoryDelta = DEFAULT_MAX_INVENTORY_DELTA
): EngineState["inventory"] {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "BTC",
    normalization: {},
    maxInventoryUnits,
    maxInventoryDelta,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: null
  };
}

export function normalizeInventoryState(
  value: EngineState["inventory"] | undefined,
  maxInventoryUnits: number,
  maxInventoryDelta: number
): EngineState["inventory"] {
  const base = defaultInventoryState(maxInventoryUnits, maxInventoryDelta);

  if (!value) {
    return base;
  }

  return {
    ...base,
    ...value,
    current_inventory_delta:
      finiteNumber(value.current_inventory_delta) ?? finiteNumber(value.netDelta) ?? 0,
    baseAsset:
      typeof value.baseAsset === "string" && value.baseAsset.trim() !== ""
        ? value.baseAsset
        : "BTC",
    normalization:
      value.normalization && typeof value.normalization === "object" ? value.normalization : {},
    maxInventoryUnits,
    maxInventoryDelta
  };
}

export function defaultRiskMetrics(equity: number, observedAt: string): EngineState["riskMetrics"] {
  return {
    highWaterMark: Math.max(0, equity),
    rollingDrawdownPct: 0,
    var99OneHour: 0,
    isTradingEnabled: false,
    updatedAt: observedAt
  };
}

export function defaultQuoteState(): EngineState["quoteState"] {
  return {
    status: "ACTIVE",
    reason: null,
    suspendedUntil: null,
    lastQuote: null,
    updatedAt: null
  };
}

export function defaultAssetQuoteStates(
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const selected = selectedMoltworkerInstruments(macroBias);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);
      const active = config.TRADING_ENABLED && selectedByMoltworker;

      return [
        asset.instrumentCode,
        {
          ...defaultQuoteState(),
          status: active ? "ACTIVE" : "SUSPENDED",
          reason: active
            ? null
            : selectedByMoltworker
              ? "TRADING_DISABLED"
              : "MOLTWORKER_NOT_SELECTED",
          updatedAt: observedAt
        } satisfies EngineState["quoteState"]
      ];
    })
  );
}

export function defaultShadowQueueState(observedAt: string | null): ShadowQueueState {
  return {
    schemaVersion: "shadow-queue.v1",
    capacity: DEFAULT_SHADOW_VLO_CAPACITY,
    activeOrders: 0,
    pendingDrifts: 0,
    ghostFills: 0,
    greenLights: 0,
    redLights: 0,
    noEdgeSignals: 0,
    invertedSignals: 0,
    confirmedSignals: 0,
    driftTradeDelay: DEFAULT_SHADOW_VLO_DRIFT_TRADES,
    latencyBudgetMs: DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
    baseSpreadBps: DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
    queueDepthMultiplier: DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
    lastFill: null,
    lastDecision: null,
    updatedAt: observedAt
  };
}

export function defaultCitadelState(observedAt: string): EngineState["citadel"] {
  return {
    status: "NOMINAL",
    reason: null,
    shadowMode: false,
    lastEvacuationAt: null,
    updatedAt: observedAt
  };
}

export function maintenanceRecoveryInstruments(payload: {
  resetInstruments?: string[] | string;
  instrumentCode?: string;
}): string[] {
  const values = [
    ...(Array.isArray(payload.resetInstruments)
      ? payload.resetInstruments
      : typeof payload.resetInstruments === "string"
        ? payload.resetInstruments.split(",")
        : []),
    ...(typeof payload.instrumentCode === "string" ? [payload.instrumentCode] : [])
  ];
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.includes("-") ? value : `${value}-usd`));

  return [...new Set(normalized)];
}

export function defaultInventoryGuardState(): EngineState["inventoryGuard"] {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    maxInventoryDelta: DEFAULT_MAX_INVENTORY_DELTA,
    hardCapReached: false,
    quoteHaltRequired: false,
    skewRatio: 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: null
  };
}

export function passiveInventoryGuardStateFromInventory(
  inventory: InventoryState,
  observedAt: string
): EngineState["inventoryGuard"] {
  const hardCapBreached =
    inventory.maxInventoryDelta > 0 &&
    Math.abs(inventory.current_inventory_delta) >= inventory.maxInventoryDelta;

  return {
    netDelta: inventory.netDelta,
    current_inventory_delta: inventory.current_inventory_delta,
    maxInventoryDelta: inventory.maxInventoryDelta,
    hardCapReached: hardCapBreached,
    quoteHaltRequired: hardCapBreached,
    skewRatio:
      inventory.maxInventoryDelta > 0
        ? roundMetric(inventory.current_inventory_delta / inventory.maxInventoryDelta, 8)
        : 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: observedAt
  };
}

export function defaultJanitorState(): EngineState["janitor"] {
  return {
    lastRunAt: null,
    zombieOrders: [],
    orphanExchangeOrders: [],
    reconciledOrders: [],
    cancelledOrders: [],
    dustPositions: [],
    dustCloseIntents: [],
    prunedTelemetryCount: 0,
    updatedAt: null
  };
}

export function logPruneReportToJson(report: LogPruneReport): JsonRecord {
  return {
    policy: logRetentionPolicyToJson(report.policy),
    telemetryRows: report.telemetryRows,
    lowValueOperationalRows: report.lowValueOperationalRows,
    cappedOperationalInfoRows: report.cappedOperationalInfoRows,
    marketTickRows: report.marketTickRows,
    totalRows: report.totalRows
  };
}

export function logRetentionPolicyToJson(policy: LogPruneReport["policy"]): JsonRecord {
  return {
    generatedAt: policy.generatedAt,
    telemetryRetentionDays: policy.telemetryRetentionDays,
    lowValueRetentionDays: policy.lowValueRetentionDays,
    marketTickRetentionDays: policy.marketTickRetentionDays,
    maxTelemetryRows: policy.maxTelemetryRows,
    maxOperationalInfoRows: policy.maxOperationalInfoRows,
    maxMarketTickRows: policy.maxMarketTickRows,
    telemetryCutoff: policy.telemetryCutoff,
    lowValueCutoff: policy.lowValueCutoff,
    marketTickCutoff: policy.marketTickCutoff
  };
}

export function defaultSlippageAnalytics(): EngineState["slippage"] {
  return {
    schemaVersion: "slippage.v1",
    points: [],
    averageSlippageBps: 0,
    latencyCorrelation: null,
    executionCostBufferBps: 0,
    updatedAt: null
  };
}

export function defaultRiskLimits(): RiskLimits {
  return {
    configVersion: "bootstrap",
    killSwitch: true,
    maxGrossExposure: 0,
    maxNetExposure: 0,
    maxOrderNotional: 0,
    maxDrawdownPct: 0,
    perAssetMaxPosition: {},
    updatedAt: new Date().toISOString()
  };
}

export function mergeRiskLimits(
  current?: RiskLimits,
  update?: Partial<RiskLimits> | null
): RiskLimits {
  return {
    ...(current ?? defaultRiskLimits()),
    ...(update ?? {}),
    perAssetMaxPosition: {
      ...(current?.perAssetMaxPosition ?? {}),
      ...(update?.perAssetMaxPosition ?? {})
    }
  };
}

export function resolveMaxLatencyMs(
  config: AdminConfigUpdate | null | undefined,
  fallback: number | undefined
): number {
  const candidate =
    config?.performance?.maxLatencyMs ??
    config?.maxLatencyMs ??
    config?.MAX_LATENCY ??
    fallback ??
    DEFAULT_MAX_LATENCY_MS;

  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_MAX_LATENCY_MS;
}

export function processingLatencyStats(samples: number[]): {
  jitterMs: number;
  averageMs: number | null;
  maxMs: number | null;
} {
  if (samples.length === 0) {
    return {
      jitterMs: 0,
      averageMs: null,
      maxMs: null
    };
  }

  const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - average) ** 2, 0) / samples.length;
  const max = samples.reduce(
    (currentMax, sample) => Math.max(currentMax, sample),
    Number.NEGATIVE_INFINITY
  );

  return {
    jitterMs: roundLatency(Math.sqrt(variance)),
    averageMs: roundLatency(average),
    maxMs: roundLatency(max)
  };
}

export function prometheusMetric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  value: number | null,
  labels: Record<string, string | number | boolean | null>
): string {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : 0;

  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name}${prometheusLabels(labels)} ${safeValue}`
  ].join("\n");
}

export function prometheusLabels(labels: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== null);

  if (entries.length === 0) {
    return "";
  }

  return `{${entries
    .map(([key, value]) => `${key}="${escapePrometheusLabel(String(value))}"`)
    .join(",")}}`;
}

export function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function finiteMetric(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function nullableFiniteMetric(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function highResolutionNow(): number {
  return performance.now();
}

export function parseTimestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }

  return parsed;
}

export function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function resolveBookSide(tick: MarketTick): OrderBookSide | null {
  if (tick.bestBid !== undefined || tick.side === "buy") {
    return "bid";
  }

  if (tick.bestAsk !== undefined || tick.side === "sell") {
    return "ask";
  }

  return null;
}

export function resolveCurrentInstrument(
  requestedInstrument: string | undefined,
  stateInstrument: string | null,
  orderBook: Map<string, InternalOrderBook>
): string {
  return (
    requestedInstrument?.toLowerCase() ??
    stateInstrument ??
    orderBook.keys().next().value ??
    "unknown"
  );
}

export function buildMarketKey(sourceExchange: string, instrumentCode: string): string {
  return `${normalizeSourceExchange(sourceExchange)}:${instrumentCode.toLowerCase()}`;
}

export function profilerStorageKey(instrumentCode: string): string {
  return `${PROFILER_STATE_STORAGE_PREFIX}${normalizeNativeInstrumentCode(instrumentCode)}`;
}

export function profilerInstrumentFromStorageKey(storageKey: string): string {
  return normalizeNativeInstrumentCode(
    storageKey.startsWith(PROFILER_STATE_STORAGE_PREFIX)
      ? storageKey.slice(PROFILER_STATE_STORAGE_PREFIX.length)
      : storageKey
  );
}

export function selectedMoltworkerInstruments(macroBias: MacroBias): Set<string> {
  return new Set(
    (macroBias.instruments ?? [])
      .filter((instrument) => typeof instrument === "string" && instrument.trim().length > 0)
      .map((instrument) => normalizeNativeInstrumentCode(instrument))
  );
}

export function isTargetInstrument(instrumentCode: string): boolean {
  return TARGET_INSTRUMENTS.has(normalizeNativeInstrumentCode(instrumentCode));
}

export function isInstrumentSelectedByMoltworker(
  instrumentCode: string,
  macroBias: MacroBias
): boolean {
  const selected = selectedMoltworkerInstruments(macroBias);
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  const coin = normalized.split("-")[0];

  return (
    selected.size === 0 ||
    selected.has(normalized) ||
    selected.has(coin) ||
    selected.has(`${coin}-perp`)
  );
}

export function normalizeAssetMatrix(
  stored: Record<string, AssetRuntimeState> | undefined,
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): Record<string, AssetRuntimeState> {
  const defaults = defaultAssetMatrix(config, macroBias, observedAt);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = stored?.[asset.instrumentCode];
      return [
        asset.instrumentCode,
        existing
          ? {
              ...defaults[asset.instrumentCode],
              ...existing,
              instrumentCode: asset.instrumentCode,
              coin: asset.coin,
              updatedAt: existing.updatedAt ?? observedAt
            }
          : defaults[asset.instrumentCode]
      ];
    })
  );
}

export function filterTargetOrderBooks(
  books: Map<string, InternalOrderBook>
): Map<string, InternalOrderBook> {
  return new Map(
    [...books.entries()].filter(([, book]) => isTargetInstrument(book.instrumentCode))
  );
}

export function defaultAssetMatrix(
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): Record<string, AssetRuntimeState> {
  const selected = selectedMoltworkerInstruments(macroBias);
  const selectedCount =
    selected.size > 0
      ? TARGET_ASSET_MATRIX.filter(
          (asset) =>
            selected.has(asset.instrumentCode) ||
            selected.has(asset.coin.toLowerCase()) ||
            selected.has(`${asset.coin.toLowerCase()}-perp`)
        ).length
      : TARGET_ASSET_MATRIX.length;
  const allocation = selectedCount > 0 ? 1 / selectedCount : 0;

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);

      return [
        asset.instrumentCode,
        {
          instrumentCode: asset.instrumentCode,
          coin: asset.coin,
          selectedByMoltworker,
          active: false,
          isSynced: false,
          lastSequence: null,
          midPrice: null,
          volatility: 0.01,
          capitalAllocationPct: selectedByMoltworker ? roundMetric(allocation, 8) : 0,
          maxNotional: 0,
          toxicityState: "NORMAL",
          amVpin: 0,
          obi: null,
          quoteStatus: config.TRADING_ENABLED ? "ACTIVE" : "SUSPENDED",
          quoteReason: config.TRADING_ENABLED ? null : "TRADING_DISABLED",
          quoteSuspendedUntil: null,
          quoteEligible: config.TRADING_ENABLED && selectedByMoltworker,
          lastQuoteAt: null,
          updatedAt: observedAt
        } satisfies AssetRuntimeState
      ];
    })
  );
}

export function normalizeAssetQuoteStates(
  stored: EngineState["assetQuoteStates"] | undefined,
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const defaults = defaultAssetQuoteStates(config, macroBias, observedAt);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = stored?.[asset.instrumentCode];
      return [
        asset.instrumentCode,
        existing
          ? {
              ...defaults[asset.instrumentCode],
              ...existing,
              lastQuote: existing.lastQuote ?? defaults[asset.instrumentCode].lastQuote,
              updatedAt: existing.updatedAt ?? observedAt
            }
          : defaults[asset.instrumentCode]
      ];
    })
  );
}

export function reconcileAssetQuoteStatesForConfig(
  current: EngineState["assetQuoteStates"],
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const defaults = defaultAssetQuoteStates(config, macroBias, observedAt);
  const selected = selectedMoltworkerInstruments(macroBias);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = current[asset.instrumentCode] ?? defaults[asset.instrumentCode];
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);

      if (!config.TRADING_ENABLED || !selectedByMoltworker) {
        return [asset.instrumentCode, defaults[asset.instrumentCode]];
      }

      if (existing.reason === "TRADING_DISABLED" || existing.reason === "MOLTWORKER_NOT_SELECTED") {
        return [
          asset.instrumentCode,
          {
            ...existing,
            status: "ACTIVE" as const,
            reason: null,
            suspendedUntil: null,
            updatedAt: observedAt
          }
        ];
      }

      return [asset.instrumentCode, existing];
    })
  );
}

export function quoteStateForInstrumentState(
  states: EngineState["assetQuoteStates"] | undefined,
  instrumentCode: string,
  fallback: EngineState["quoteState"]
): EngineState["quoteState"] {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  return states?.[normalized] ?? fallback;
}

export function isQuoteSuspendedAt(
  quoteState: EngineState["quoteState"],
  observedAt: string
): boolean {
  if (quoteState.status !== "SUSPENDED") {
    return false;
  }

  return (
    !quoteState.suspendedUntil || Date.parse(quoteState.suspendedUntil) > Date.parse(observedAt)
  );
}

export function suspendAssetQuoteStates(
  states: EngineState["assetQuoteStates"],
  reason: string,
  observedAt: string,
  options: {
    instrumentCode?: string;
    suspendedUntil?: string | null;
    lastQuote?: EngineState["quoteState"]["lastQuote"];
  } = {}
): EngineState["assetQuoteStates"] {
  const targets = options.instrumentCode
    ? new Set([normalizeNativeInstrumentCode(options.instrumentCode)])
    : new Set(TARGET_ASSET_MATRIX.map((asset) => asset.instrumentCode));

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const current = states[asset.instrumentCode] ?? defaultQuoteState();
      if (!targets.has(asset.instrumentCode)) {
        return [asset.instrumentCode, current];
      }

      return [
        asset.instrumentCode,
        {
          status: "SUSPENDED" as const,
          reason,
          suspendedUntil: options.suspendedUntil ?? null,
          lastQuote: options.lastQuote ?? current.lastQuote,
          updatedAt: observedAt
        }
      ];
    })
  );
}

export function resumeExpiredAssetQuoteStates(
  states: EngineState["assetQuoteStates"],
  observedAt: string
): EngineState["assetQuoteStates"] {
  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const current = states[asset.instrumentCode] ?? defaultQuoteState();
      if (!isQuoteSuspendedAt(current, observedAt)) {
        return [
          asset.instrumentCode,
          current.status === "SUSPENDED"
            ? {
                ...current,
                status: "ACTIVE" as const,
                reason: null,
                suspendedUntil: null,
                updatedAt: observedAt
              }
            : current
        ];
      }

      return [asset.instrumentCode, current];
    })
  );
}

export function aggregateQuoteState(
  states: EngineState["assetQuoteStates"],
  previous: EngineState["quoteState"],
  observedAt: string
): EngineState["quoteState"] {
  const values = Object.values(states);
  const suspended = values.filter((state) => isQuoteSuspendedAt(state, observedAt));
  const active = values.filter((state) => !isQuoteSuspendedAt(state, observedAt));
  const previousLastQuote =
    previous.lastQuote && isTargetInstrument(previous.lastQuote.instrumentCode)
      ? previous.lastQuote
      : null;
  const lastQuote =
    values
      .map((state) => state.lastQuote)
      .filter((quote) => !quote || isTargetInstrument(quote.instrumentCode))
      .filter((quote): quote is NonNullable<EngineState["quoteState"]["lastQuote"]> =>
        Boolean(quote)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ??
    previousLastQuote;

  if (values.length > 0 && active.length === 0 && suspended.length > 0) {
    const indefinite = suspended.find((state) => !state.suspendedUntil);
    const longest = [...suspended].sort(
      (left, right) =>
        Date.parse(right.suspendedUntil ?? "9999-12-31T23:59:59.999Z") -
        Date.parse(left.suspendedUntil ?? "9999-12-31T23:59:59.999Z")
    )[0];

    return {
      status: "SUSPENDED",
      reason: indefinite?.reason ?? longest?.reason ?? "ALL_ASSET_QUOTES_SUSPENDED",
      suspendedUntil: indefinite ? null : (longest?.suspendedUntil ?? null),
      lastQuote,
      updatedAt: observedAt
    };
  }

  return {
    status: "ACTIVE",
    reason: suspended.length > 0 ? "PARTIAL_ASSET_SUSPENSION" : null,
    suspendedUntil: null,
    lastQuote,
    updatedAt: observedAt
  };
}

export function quotePriceMovedTicks(
  previous: number | null,
  next: number | null,
  tickSize: number
): number {
  if (previous === null || next === null) {
    return previous === next ? 0 : Number.POSITIVE_INFINITY;
  }

  const safeTick = Math.max(tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE);
  return Math.abs(next - previous) / safeTick;
}

export function adverseAdjustedPaperFillPrice(
  side: "BUY" | "SELL",
  price: number,
  adverseBps: number,
  tickSize: number
): number {
  const adjusted =
    side === "BUY" ? price * (1 + adverseBps / 10_000) : price * (1 - adverseBps / 10_000);

  return normalizePriceToTick(
    Math.max(tickSize, adjusted),
    Math.max(tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE),
    side === "BUY" ? "CEIL" : "FLOOR"
  );
}

export function normalizeMarketKey(value: string): string {
  return value.toLowerCase();
}

export function normalizeSourceExchange(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : "unknown";
}

export function normalizeSourceWeight(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SOURCE_WEIGHT;
}

export function aggregateDomBins(
  bidLevels: PriceLevel[],
  askLevels: PriceLevel[],
  binSize: number
): DomBinAccumulator[] {
  const bins = new Map<string, DomBinAccumulator>();

  const appendLevel = (level: PriceLevel, side: OrderBookSide) => {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.size <= 0) {
      return;
    }

    const priceStart = roundCrypto(Math.floor(level.price / binSize) * binSize);
    const priceEnd = roundCrypto(priceStart + binSize);
    const key = `${side}:${priceKey(priceStart)}`;
    const existing = bins.get(key);

    if (existing) {
      existing.volume = roundCrypto(existing.volume + level.size);
      existing.levelCount += 1;
      return;
    }

    bins.set(key, {
      side,
      priceStart,
      priceEnd,
      centerPrice: roundCrypto(priceStart + binSize / 2),
      volume: roundCrypto(level.size),
      levelCount: 1
    });
  };

  for (const level of bidLevels) {
    appendLevel(level, "bid");
  }

  for (const level of askLevels) {
    appendLevel(level, "ask");
  }

  return [...bins.values()].sort((left, right) => {
    if (left.side !== right.side) {
      return left.side === "bid" ? -1 : 1;
    }

    return left.side === "bid"
      ? right.priceStart - left.priceStart
      : left.priceStart - right.priceStart;
  });
}

export function volumeStats(volumes: number[]): { mean: number; sigma: number } {
  if (volumes.length === 0) {
    return { mean: 0, sigma: 0 };
  }

  const mean = volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length;
  const variance = volumes.reduce((sum, volume) => sum + (volume - mean) ** 2, 0) / volumes.length;

  return {
    mean: roundCrypto(mean),
    sigma: roundCrypto(Math.sqrt(variance))
  };
}

export function isLiquidityWall(volume: number, mean: number, sigma: number): boolean {
  return sigma > 0 && volume > mean + 3 * sigma;
}

export function toLiquidityWall(
  bin: DomBinAccumulator,
  instrumentCode: string,
  exchangeCode: string,
  sequence: number,
  midPrice: number,
  meanVolume: number,
  sigmaVolume: number,
  previous: LiquidityWall | undefined,
  observedAt: string
): LiquidityWall {
  const zScore = sigmaVolume > 0 ? (bin.volume - meanVolume) / sigmaVolume : 0;

  return {
    wallId: wallIdForBin(instrumentCode, bin),
    instrumentCode,
    exchangeCode,
    side: bin.side,
    priceStart: bin.priceStart,
    priceEnd: bin.priceEnd,
    centerPrice: bin.centerPrice,
    volume: bin.volume,
    meanVolume,
    sigmaVolume,
    zScore: roundMetric(zScore, 4),
    levelCount: bin.levelCount,
    status: "ACTIVE",
    firstSeenAt: previous?.firstSeenAt ?? observedAt,
    lastSeenAt: observedAt,
    lastSequence: sequence,
    distanceFromMidBps: distanceBps(bin.centerPrice, midPrice),
    spoofingSuspected: false
  };
}

export function wallIdForBin(instrumentCode: string, bin: DomBinAccumulator): string {
  return `dom:${instrumentCode}:${bin.side}:${priceKey(bin.priceStart)}`;
}

export function latestActiveWalls(
  history: LiquidityWall[],
  instrumentCode: string
): Map<string, LiquidityWall> {
  const latest = new Map<string, LiquidityWall>();

  for (const wall of history) {
    if (wall.instrumentCode === instrumentCode) {
      latest.set(wall.wallId, wall);
    }
  }

  return new Map([...latest.entries()].filter(([, wall]) => wall.status === "ACTIVE"));
}

export function classifyMissingWalls(
  previousActiveWalls: Map<string, LiquidityWall>,
  currentWallIds: Set<string>,
  tick: MarketTick | undefined,
  observedAt: string,
  binSize: number,
  spoofProximityBps: number,
  midPrice: number
): LiquidityWall[] {
  const transitions: LiquidityWall[] = [];

  for (const wall of previousActiveWalls.values()) {
    if (currentWallIds.has(wall.wallId)) {
      continue;
    }

    const filled = tick ? wasWallFilled(wall, tick) : false;
    const closeToTouch = tick
      ? Math.abs(tick.price - wall.centerPrice) <=
        Math.max(binSize * 2, tick.price * (spoofProximityBps / 10_000))
      : false;

    transitions.push({
      ...wall,
      status: filled ? "FILLED" : "PULLED",
      lastSeenAt: observedAt,
      lastSequence: tick?.sequence ?? wall.lastSequence,
      distanceFromMidBps: distanceBps(wall.centerPrice, midPrice),
      spoofingSuspected: !filled && closeToTouch
    });
  }

  return transitions;
}

export function wasWallFilled(wall: LiquidityWall, tick: MarketTick): boolean {
  return (
    (wall.side === "ask" && tick.side === "buy" && tick.price >= wall.priceStart) ||
    (wall.side === "bid" && tick.side === "sell" && tick.price <= wall.priceEnd)
  );
}

export function domHeatmapCell(
  bin: DomBinAccumulator,
  meanVolume: number,
  sigmaVolume: number
): DomHeatmapCell {
  const zScore = sigmaVolume > 0 ? (bin.volume - meanVolume) / sigmaVolume : 0;

  return [
    bin.side === "bid" ? 0 : 1,
    bin.priceStart,
    bin.priceEnd,
    bin.volume,
    bin.levelCount,
    roundMetric(zScore, 4)
  ];
}

export function emptyDomSnapshot(
  instrumentCode: string,
  exchangeCode: string | null,
  sequence: number | null,
  midPrice: number | null,
  scanRangePct: number,
  binSize: number,
  history: LiquidityWall[],
  observedAt: string
): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode,
    exchangeCode,
    sequence,
    midPrice,
    scanRangePct,
    lowerBound: null,
    upperBound: null,
    binSize,
    meanVolume: 0,
    sigmaVolume: 0,
    walls: [],
    pulledWalls: [],
    filledWalls: [],
    heatmap: {
      schemaVersion: "dom.heatmap.v1",
      columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"],
      sideEncoding: { bid: 0, ask: 1 },
      cells: []
    },
    history,
    updatedAt: observedAt
  };
}

export function distanceBps(price: number, referencePrice: number): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  return roundMetric(Math.abs((price - referencePrice) / referencePrice) * 10_000, 4);
}

export function sanitizeWallHistory(value: LiquidityWall[] | undefined): LiquidityWall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isLiquidityWallRecord);
}

export function isLiquidityWallRecord(value: LiquidityWall): boolean {
  return (
    typeof value?.wallId === "string" &&
    typeof value.instrumentCode === "string" &&
    typeof value.exchangeCode === "string" &&
    (value.side === "bid" || value.side === "ask") &&
    (value.status === "ACTIVE" || value.status === "PULLED" || value.status === "FILLED") &&
    Number.isFinite(value.priceStart) &&
    Number.isFinite(value.priceEnd) &&
    Number.isFinite(value.centerPrice) &&
    Number.isFinite(value.volume)
  );
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonValue(item)
      ])
    );
  }

  return String(value);
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function hydrateOrderBooks(records: Map<string, InternalOrderBook>): {
  snapshots: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  sync: Map<string, BookSyncState>;
} {
  const snapshots = new Map<string, InternalOrderBook>();
  const bids = new Map<string, SortedBookSide>();
  const asks = new Map<string, SortedBookSide>();
  const sync = new Map<string, BookSyncState>();

  for (const [, value] of records) {
    const bidLevels = Array.isArray(value.bids) ? value.bids : hydrateLegacyLevel(value, "bid");
    const askLevels = Array.isArray(value.asks) ? value.asks : hydrateLegacyLevel(value, "ask");
    const tickSize = value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
    const bidBook = levelsToBookSide(bidLevels, "bid", tickSize);
    const askBook = levelsToBookSide(askLevels, "ask", tickSize);
    const normalizedBids = bidBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const normalizedAsks = askBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const sourceExchange = normalizeSourceExchange(value.source_exchange ?? value.exchangeCode);
    const marketKey = normalizeMarketKey(
      value.marketKey ?? buildMarketKey(sourceExchange, value.instrumentCode)
    );
    const source = value.source ?? "SYSTEM";
    const sourceWeight = normalizeSourceWeight(value.sourceWeight);
    const microstructure = buildMicrostructureSnapshot(
      marketKey,
      value.instrumentCode,
      value.exchangeCode,
      sourceExchange,
      sourceWeight,
      normalizedBids,
      normalizedAsks,
      value.updatedAt,
      value.lastSequence ?? value.sequence,
      value.ttbLatencyMs ?? null,
      value.isSynced ?? true
    );

    bids.set(marketKey, bidBook);
    asks.set(marketKey, askBook);
    sync.set(marketKey, {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode: value.instrumentCode,
      exchangeCode: value.exchangeCode,
      lastSequence: value.lastSequence ?? value.sequence,
      lastSnapshotAt: value.updatedAt,
      lastDeltaAt: value.updatedAt,
      lastDesyncAt: value.isSynced === false ? value.updatedAt : null,
      desyncReason: value.desyncReason ?? null,
      isSynced: value.isSynced ?? true,
      tickSize,
      ttbLatencyMs: value.ttbLatencyMs ?? null,
      lastCrossCheckAt: 0
    });
    snapshots.set(marketKey, {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode: value.instrumentCode,
      exchangeCode: value.exchangeCode,
      bids: normalizedBids,
      asks: normalizedAsks,
      bestBid: microstructure.bestBid,
      bestAsk: microstructure.bestAsk,
      midPrice: microstructure.midPrice,
      spread: microstructure.spread,
      spreadBps: microstructure.spreadBps,
      weightedImbalance: microstructure.weightedImbalance,
      lastSequence: microstructure.lastSequence,
      tickSize: value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE,
      ttbLatencyMs: microstructure.timeToBookMs,
      isSynced: microstructure.isSynced,
      desyncReason: value.desyncReason ?? null,
      sequence: value.sequence,
      updatedAt: value.updatedAt
    });
  }

  return { snapshots, bids, asks, sync };
}

export function hydrateLegacyLevel(value: InternalOrderBook, side: OrderBookSide): PriceLevel[] {
  const legacy = value as unknown as {
    bid?: number | null;
    ask?: number | null;
    lastSize?: number;
    updatedAt: string;
  };
  const price = side === "bid" ? legacy.bid : legacy.ask;

  if (typeof price !== "number") {
    return [];
  }

  return [
    {
      price: roundCrypto(price),
      size: roundCrypto(legacy.lastSize ?? 0),
      updatedAt: legacy.updatedAt
    }
  ];
}

export function levelsToBookSide(
  levels: PriceLevel[],
  side: OrderBookSide,
  tickSize: number
): SortedBookSide {
  const book = new SortedBookSide(side);

  for (const level of levels) {
    book.upsert(level.price, level.size, level.updatedAt, tickSize);
  }

  return book;
}

export function tickToDelta(tick: MarketTick): BookDeltaWithTicker {
  const side = resolveBookSide(tick);

  if (!side) {
    throw new Error("UNKNOWN_ORDER_BOOK_SIDE");
  }

  return {
    schemaVersion: "order-book.delta.v1",
    source: tick.source,
    source_exchange: tick.source_exchange,
    exchangeCode: tick.exchangeCode,
    instrumentCode: tick.instrumentCode,
    marketKey: buildMarketKey(tick.source_exchange, tick.instrumentCode),
    sourceWeight: tick.sourceWeight,
    sequence: tick.sequence,
    exchangeTimestamp: tick.exchangeTimestamp,
    receivedAt: tick.receivedAt,
    tickSize: tick.tickSize,
    side,
    price: tick.price,
    size: tick.size,
    bestBid: tick.bestBid,
    bestAsk: tick.bestAsk
  };
}

export function calculateTimeToBookMs(exchangeTimestamp: string, bookTimestamp: string): number {
  return Math.max(
    0,
    parseTimestampMs(bookTimestamp, "book_timestamp") -
      parseTimestampMs(exchangeTimestamp, "exchange_timestamp")
  );
}

export function mapManagedStatusToTradeStatus(
  status: ManagedOrder["status"]
): TradeExecution["status"] {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIAL_FILL":
      return "PARTIAL";
    case "GHOST_FILL":
      return "GHOST_FILL";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    case "PENDING":
    case "OPEN":
    default:
      return "ACCEPTED";
  }
}

export function isPortfolioFillStatus(status: ManagedOrder["status"]): boolean {
  return status === "FILLED" || status === "PARTIAL_FILL" || status === "GHOST_FILL";
}

export function executionReportSize(
  report: ExecutionReport,
  order: ManagedOrder,
  status: TradeExecution["status"]
): number {
  if (status === "FILLED" || status === "PARTIAL" || status === "GHOST_FILL") {
    return report.fillIncrementSize ?? report.filledSize ?? order.filledSize ?? order.size;
  }

  return report.orderSize ?? order.size;
}

export function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isFinite(parsed) && parsed > 0) {
    return roundCrypto(parsed);
  }

  return Number.isFinite(fallback) && fallback > 0 ? roundCrypto(fallback) : 0.00000001;
}

export function executionTradeId(
  report: ExecutionReport,
  status: TradeExecution["status"],
  observedAt: string
): string {
  const exchangeId = report.exchangeOrderId ?? "local";
  return `execution:${report.clientId}:${exchangeId}:${status}:${Date.parse(observedAt) || observedAt}`;
}

export function inferExecutionPrimaryDriver(
  intent: TradeIntent | null,
  order: ManagedOrder
): AgentName {
  const rationale = intent?.rationale.toLowerCase() ?? "";

  if (rationale.includes("hedge") || order.clientId.includes(":hedge")) {
    return "RISK";
  }

  if (intent?.traceId.includes("profiler")) {
    return "PROFILER";
  }

  return intent ? "CROUPIER" : "EXECUTIONER";
}

export function resolveTickSize(env: Env, instrumentCode: string, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }

  const configured = parseTickSizeMap(env.ORDER_BOOK_TICK_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.ORDER_BOOK_TICK_SIZE_DEFAULT, DEFAULT_ORDER_BOOK_TICK_SIZE);
}

export function resolveDomBinSize(env: Env, instrumentCode: string, fallback: number): number {
  const configured = parsePositiveNumberMap(env.DOM_PRICE_BIN_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.DOM_PRICE_BIN_SIZE_DEFAULT, fallback);
}

export function parseTickSizeMap(value: string | undefined): Record<string, number> {
  return parsePositiveNumberMap(value);
}

export function parsePositiveNumberMap(value: string | undefined): Record<string, number> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .map(
        ([instrumentCode, rawValue]) => [instrumentCode.toLowerCase(), Number(rawValue)] as const
      )
      .filter(([, numericValue]) => Number.isFinite(numericValue) && numericValue > 0);

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function appendSlippagePoint(
  current: EngineState["slippage"],
  point: EngineState["slippage"]["points"][number]
): EngineState["slippage"] {
  const points = [...current.points, point].slice(-500);
  const averageSlippageBps =
    points.reduce((sum, item) => sum + item.slippageBps, 0) / Math.max(1, points.length);
  const latencyCorrelation = pearson(
    points.map((item) => item.latencyMs),
    points.map((item) => Math.abs(item.slippageBps))
  );
  const executionCostBufferBps =
    averageSlippageBps > current.executionCostBufferBps
      ? averageSlippageBps
      : current.executionCostBufferBps;

  return {
    schemaVersion: "slippage.v1",
    points,
    averageSlippageBps,
    latencyCorrelation,
    executionCostBufferBps,
    updatedAt: point.observedAt
  };
}

export function quoteToTelemetry(
  quote: EngineState["quoteState"]["lastQuote"]
): Record<string, unknown> {
  return quote
    ? {
        schemaVersion: quote.schemaVersion,
        signalId: quote.signalId,
        instrumentCode: quote.instrumentCode,
        marketKey: quote.marketKey,
        reservationPrice: quote.reservationPrice,
        optimalSpread: quote.optimalSpread,
        orderCount: quote.orders.length,
        orders: quote.orders.map((order) => ({
          clientOrderId: order.clientOrderId,
          side: order.side,
          price: order.price,
          size: order.size,
          postOnly: order.postOnly,
          strategy: order.strategy ?? "AMM",
          clusterId: order.clusterId ?? null
        })),
        createdAt: quote.createdAt
      }
    : {};
}

export function quoteStateTelemetry(state: EngineState["quoteState"]): Record<string, unknown> {
  return {
    status: state.status,
    reason: state.reason,
    suspendedUntil: state.suspendedUntil,
    updatedAt: state.updatedAt
  };
}

export function compareQueuedExecutionIntent(
  left: QueuedExecutionIntent,
  right: QueuedExecutionIntent
): number {
  const priorityWeight = { CANCEL: 0, NEW: 1 } as const;
  const priorityDelta = priorityWeight[left.priority] - priorityWeight[right.priority];

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.runAfterMs - right.runAfterMs;
}

export function returns(values: number[]): number[] {
  const output: number[] = [];

  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] - values[index - 1]);
  }

  return output;
}

export function pearson(left: number[], right: number[]): number | null {
  const count = Math.min(left.length, right.length);

  if (count < 2) {
    return null;
  }

  const x = left.slice(-count);
  const y = right.slice(-count);
  const meanX = x.reduce((sum, value) => sum + value, 0) / count;
  const meanY = y.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let index = 0; index < count; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? roundMetric(numerator / denominator, 8) : null;
}

export function safeParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function applyReplayScenarioToTick(
  tick: MarketTick,
  scenario: ReplayScenario,
  index: number,
  total: number
): MarketTick {
  if (scenario === "BASELINE" || tick.price <= 0 || total <= 0) {
    return tick;
  }

  const progress = index / Math.max(1, total - 1);
  let priceMultiplier = 1;
  let sizeMultiplier = 1;

  if (scenario === "FLASH_CRASH" && progress > 0.35 && progress < 0.55) {
    const crashProgress = (progress - 0.35) / 0.2;
    priceMultiplier = 1 - 0.08 * Math.sin(Math.PI * crashProgress);
    sizeMultiplier = 3;
  } else if (scenario === "DELEVERAGING_2022") {
    priceMultiplier = 1 - 0.18 * progress;
    sizeMultiplier = 1.4 + progress;
  } else if (scenario === "LATENCY_SHOCK") {
    priceMultiplier = 1 + Math.sin(progress * Math.PI * 12) * 0.0025;
    sizeMultiplier = 1.15;
  }

  return {
    ...tick,
    price: roundCrypto(tick.price * priceMultiplier),
    size: roundCrypto(tick.size * sizeMultiplier),
    raw: {
      ...(tick.raw ?? {}),
      replayScenario: scenario
    }
  };
}

export function modelReplayIntentTrade(
  intent: TradeIntent | null,
  tick: MarketTick,
  ticks: MarketTick[],
  index: number,
  options: ReplayOptions,
  regime: ReplayResult["shadowTrades"][number]["regime"]
): ReplayResult["shadowTrades"][number] | null {
  if (!intent) {
    return null;
  }

  const size = intent.approvedSize ?? intent.requestedSize;
  const referencePrice = intent.expectedPrice > 0 ? intent.expectedPrice : tick.price;
  if (size <= 0 || referencePrice <= 0) {
    return null;
  }

  const exitTick = findReplayExitTick(ticks, intent.instrumentCode, index, options.exitAfterTicks);
  if (!exitTick || exitTick.price <= 0) {
    return null;
  }

  const latencyPenaltyBps =
    options.scenario === "LATENCY_SHOCK"
      ? Math.max(options.latencyMs * 0.02, 2)
      : options.latencyMs * 0.005;
  const effectiveSlippageBps = options.slippageBps + latencyPenaltyBps;
  const entrySlippage = effectiveSlippageBps / 10_000;
  const entryPrice =
    intent.action === "BUY"
      ? referencePrice * (1 + entrySlippage)
      : referencePrice * (1 - entrySlippage);
  const exitPrice = exitTick.price;
  const grossPnl =
    intent.action === "BUY" ? (exitPrice - entryPrice) * size : (entryPrice - exitPrice) * size;
  const fees = ((entryPrice + exitPrice) * size * options.feeBps) / 10_000;

  return {
    tradeId: `replay:${intent.intentId}`,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    entryPrice: roundCrypto(entryPrice),
    exitPrice: roundCrypto(exitPrice),
    size: roundCrypto(size),
    theoreticalPnl: roundMetric(grossPnl - fees, 8),
    fees: roundMetric(fees, 8),
    slippageBps: roundMetric(effectiveSlippageBps, 4),
    driver: inferIntentDriver(intent),
    regime: regime ?? "UNKNOWN",
    openedAt: tick.receivedAt,
    closedAt: exitTick.receivedAt
  };
}

export function findReplayExitTick(
  ticks: MarketTick[],
  instrumentCode: string,
  index: number,
  exitAfterTicks: number
): MarketTick | null {
  let seen = 0;
  for (let cursor = index + 1; cursor < ticks.length; cursor += 1) {
    const candidate = ticks[cursor];
    if (candidate.instrumentCode !== instrumentCode) {
      continue;
    }
    seen += 1;
    if (seen >= exitAfterTicks) {
      return candidate;
    }
  }

  for (let cursor = ticks.length - 1; cursor > index; cursor -= 1) {
    if (ticks[cursor].instrumentCode === instrumentCode) {
      return ticks[cursor];
    }
  }

  return null;
}

export function inferIntentDriver(intent: TradeIntent): AgentName | "UNATTRIBUTED" {
  const text = intent.rationale.toUpperCase();
  if (text.includes("PROFILER") || text.includes("VPIN")) {
    return "PROFILER";
  }
  if (text.includes("ORACLE") || text.includes("REGIME")) {
    return "ORACLE";
  }
  if (text.includes("SENTIMENT")) {
    return "SENTIMENT";
  }
  if (text.includes("MOLTWORKER")) {
    return "MOLTWORKER";
  }
  return "CROUPIER";
}

export function buildReplayAttribution(
  trades: ReplayResult["shadowTrades"]
): NonNullable<ReplayResult["attribution"]> {
  return {
    byAgent: bucketReplayTrades(trades, (trade) => trade.driver ?? "UNATTRIBUTED"),
    byAsset: bucketReplayTrades(trades, (trade) => trade.instrumentCode),
    byRegime: bucketReplayTrades(trades, (trade) => trade.regime ?? "UNKNOWN")
  };
}

export function bucketReplayTrades(
  trades: ReplayResult["shadowTrades"],
  keyFn: (trade: ReplayResult["shadowTrades"][number]) => string
): NonNullable<ReplayResult["attribution"]>["byAgent"] {
  const buckets = new Map<string, ReplayResult["shadowTrades"]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    const bucket = buckets.get(key) ?? [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const pnl = bucket.map((trade) => trade.theoreticalPnl);
    const grossProfit = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(
      pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0)
    );
    return {
      key,
      tradeCount: bucket.length,
      pnl: roundMetric(
        pnl.reduce((sum, value) => sum + value, 0),
        8
      ),
      grossProfit: roundMetric(grossProfit, 8),
      grossLoss: roundMetric(grossLoss, 8),
      winRate: calculateWinRate(bucket),
      sharpe: calculateReplaySharpe(pnl)
    };
  });
}

export function buildReplayEquityCurve(
  initialBankroll: number,
  trades: ReplayResult["shadowTrades"]
): number[] {
  const curve = [initialBankroll];
  let equity = initialBankroll;
  for (const trade of trades) {
    equity += trade.theoreticalPnl;
    curve.push(equity);
  }
  return curve;
}

export function calculateMaxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }
  return roundMetric(maxDrawdown, 8);
}

export function calculateReplaySharpe(pnls: number[]): number | null {
  if (pnls.length < 2) {
    return null;
  }
  const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  const variance = pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1);
  const sigma = Math.sqrt(variance);
  return sigma > 0 ? roundMetric((mean / sigma) * Math.sqrt(pnls.length), 6) : null;
}

export function calculateWinRate(trades: ReplayResult["shadowTrades"]): number | null {
  return trades.length > 0
    ? roundMetric(trades.filter((trade) => trade.theoreticalPnl > 0).length / trades.length, 6)
    : null;
}

export function buildStressSummary(
  trades: ReplayResult["shadowTrades"],
  generatedIntentCount: number
): ReplayResult["stressResults"] {
  const equity = buildReplayEquityCurve(0, trades);
  return [
    {
      scenario: "BASELINE",
      pnl: roundMetric(
        trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0),
        8
      ),
      maxDrawdown: calculateMaxDrawdown(equity),
      generatedIntentCount,
      simulatedTradeCount: trades.length
    }
  ];
}

export function buildReplayWalkForward(
  trades: ReplayResult["shadowTrades"],
  segments: number
): NonNullable<ReplayResult["walkForward"]> {
  if (trades.length === 0) {
    return [];
  }

  const safeSegments = Math.min(segments, trades.length);
  const chunkSize = Math.ceil(trades.length / safeSegments);
  const rows: NonNullable<ReplayResult["walkForward"]> = [];
  for (let segment = 0; segment < safeSegments; segment += 1) {
    const bucket = trades.slice(segment * chunkSize, (segment + 1) * chunkSize);
    if (bucket.length === 0) {
      continue;
    }
    const pnl = bucket.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
    rows.push({
      segment: segment + 1,
      dateFrom: bucket[0].openedAt,
      dateTo: bucket.at(-1)?.closedAt ?? bucket.at(-1)?.openedAt ?? null,
      pnl: roundMetric(pnl, 8),
      sharpe: calculateReplaySharpe(bucket.map((trade) => trade.theoreticalPnl)),
      maxDrawdown: calculateMaxDrawdown(buildReplayEquityCurve(0, bucket)),
      tradeCount: bucket.length
    });
  }
  return rows;
}

export function buildReplayAblation(
  trades: ReplayResult["shadowTrades"],
  sentiment: SentimentState
): ReplayResult["ablation"] {
  const sentimentTrades = trades.filter((trade) => trade.driver === "SENTIMENT");
  const sentimentEnabledPnl = trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const sentimentContribution = sentimentTrades.reduce(
    (sum, trade) => sum + trade.theoreticalPnl,
    0
  );
  const estimatedAiCostUsd = Number(sentiment.estimatedCostUsd ?? 0);
  const sentimentDisabledPnl = sentimentEnabledPnl - sentimentContribution;
  return {
    sentimentEnabledPnl: roundMetric(sentimentEnabledPnl, 8),
    sentimentDisabledPnl: roundMetric(sentimentDisabledPnl, 8),
    deltaPnl: roundMetric(sentimentContribution, 8),
    estimatedAiCostUsd,
    netEdgeAfterCosts: roundMetric(sentimentContribution - estimatedAiCostUsd, 8)
  };
}

export function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function resolveGhostBookConfig(env: Env): GhostBookConfig {
  return {
    capacity: readPositiveInteger(
      env.SHADOW_VLO_CAPACITY,
      DEFAULT_SHADOW_VLO_CAPACITY,
      128,
      16_384
    ),
    driftTradeDelay: readPositiveInteger(
      env.SHADOW_VLO_DRIFT_TRADES,
      DEFAULT_SHADOW_VLO_DRIFT_TRADES,
      1,
      100
    ),
    queueDepthMultiplier: readBoundedNumber(
      env.SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
      DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
      0,
      10
    ),
    baseSpreadBps: readPositiveNumber(
      env.SHADOW_VLO_BASE_SPREAD_BPS,
      DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS
    ),
    latencyBudgetMs: readPositiveNumber(
      env.SHADOW_VLO_LATENCY_BUDGET_MS,
      DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS
    ),
    minSize: readPositiveNumber(env.SHADOW_VLO_MIN_SIZE, DEFAULT_SHADOW_VLO_MIN_SIZE)
  };
}

export function clampInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function assertMarketTick(value: MarketTick): MarketTick {
  if (
    value?.schemaVersion !== "universal-tick.v1" ||
    typeof value.source !== "string" ||
    typeof value.source_exchange !== "string" ||
    typeof value.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.price !== "number" ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.sequence !== "number" ||
    typeof value.exchangeTimestamp !== "string" ||
    typeof value.synchronizedExchangeTimestamp !== "string" ||
    typeof value.clockOffsetMs !== "number" ||
    typeof value.receivedAt !== "string"
  ) {
    throw new Error("INVALID_MARKET_TICK");
  }

  return value;
}

export function assertAgentSignal(value: AgentSignal): AgentSignal {
  const agentNames: AgentName[] = [
    "ORACLE",
    "SENTIMENT",
    "PROFILER",
    "CROUPIER",
    "PIT_BOSS",
    "JANITOR",
    "EXECUTIONER",
    "MOLTWORKER",
    "RISK",
    "SYSTEM"
  ];
  const actions = [
    "BUY",
    "SELL",
    "HOLD",
    "CANCEL",
    "REDUCE",
    "QUOTE",
    "EXECUTE",
    "PAUSE",
    "RESUME",
    "SUPERVISOR_ACTION"
  ];

  if (
    typeof value?.signalId !== "string" ||
    typeof value.traceId !== "string" ||
    !agentNames.includes(value.sourceAgent) ||
    !agentNames.includes(value.targetAgent) ||
    !actions.includes(value.action) ||
    typeof value.instrumentCode !== "string" ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error("INVALID_AGENT_SIGNAL");
  }

  return value;
}

export function readTelemetryNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isInformationalTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity = typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return (
    eventType === "trade" ||
    eventType === "funding" ||
    eventType === "book-snapshot" ||
    commodity === "TRADE" ||
    commodity === "FUNDING"
  );
}

export function isTradeTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity = typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return eventType === "trade" || commodity === "TRADE";
}

export function extractTickStreamId(tick: MarketTick): string | null {
  const direct = tick.streamId?.trim();
  if (direct) {
    return direct;
  }

  const rawStreamId = tick.raw?.streamId;
  return typeof rawStreamId === "string" && rawStreamId.trim() ? rawStreamId.trim() : null;
}

export async function readHyperliquidRawIngestPayload(
  request: Request
): Promise<HyperliquidRawIngestPayload> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/x-msgpack")) {
    const decoded = msgpackDecode(new Uint8Array(await request.arrayBuffer()));

    if (!isPlainObject(decoded)) {
      throw new Error("INVALID_HYPERLIQUID_MSGPACK_PAYLOAD");
    }

    return decoded as unknown as HyperliquidRawIngestPayload;
  }

  return request.json<HyperliquidRawIngestPayload>();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function shouldAggregateBusTelemetry(type: string): boolean {
  return AGGREGATED_BUS_TELEMETRY_TYPES.has(type);
}

export function decodeWebSocketMessage(data: string | ArrayBuffer): string | null {
  if (typeof data === "string") {
    return data;
  }

  return new TextDecoder().decode(data);
}

export function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function readJsonOrNull<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8"
    }
  });
}

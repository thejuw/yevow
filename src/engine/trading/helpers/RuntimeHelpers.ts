/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-type-conversion, @typescript-eslint/no-unnecessary-boolean-literal-compare, @typescript-eslint/no-unnecessary-type-parameters */
import { defaultConfig } from "../../../ConfigManager";
import { neutralMacroBias } from "../../../Governor";
import { defaultLiquidationHeatmapState } from "../../../agents/HeatmapAgent";
import { defaultOracleState } from "../../../agents/OracleAgent";
import { defaultSentimentState } from "../../../agents/SentimentAgent";
import type { CroupierDecision } from "../../../agents/CroupierAgent";
import { PROFILER_STATE_STORAGE_PREFIX, type ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import type { GhostBookConfig } from "../../../utils/GhostBook";
import { defaultEngineLocation } from "./PlacementResolver";
import { buildMicrostructureSnapshot } from "../book/BookReconstruction";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  priceKey,
  roundCrypto,
  roundMetric,
  SortedBookSide
} from "../book/SortedBookSide";
import type { BookDeltaWithTicker, BookSyncState } from "../book/BookTypes";
import type { ReplayOptions, ReplayScenario } from "../routes/ReplayAdminRoutes";
import type {
  AdminConfigUpdate,
  AgentHealth,
  AgentName,
  AgentSignal,
  AssetRuntimeState,
  DomAnalysisSnapshot,
  DomHeatmapCell,
  EngineState,
  Env,
  ExecutionReport,
  ExecutionProfile,
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  LiquidityWall,
  MacroBias,
  MarketTick,
  ManagedOrder,
  MicrostructureMetrics,
  OrderBookSide,
  PriceDiscoveryMetrics,
  PriceLevel,
  ProfilerState,
  ReplayResult,
  RiskLimits,
  SentimentState,
  ShadowQueueState,
  TradeExecution,
  TradeIntent
} from "../../../types";
import type {
  AbsorptionConfirmed,
  CascadeEvent,
  CascadeOpenPosition
} from "../../../strategy/cascade/types";
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
  DEFAULT_ORDER_ACK_TIMEOUT_MS
} from "../../../TradingEngineConstants";
import {
  finiteNumber,
  readBoundedNumber,
  readPositiveInteger,
  readPositiveNumber
} from "./RuntimeParsing";
import { parseTimestampMs, roundLatency } from "./RuntimeClock";
import {
  normalizeNativeInstrumentCode,
  normalizeSourceExchange,
  normalizeSourceWeight
} from "./NativeHyperliquidRuntime";
import {
  defaultAssetMatrix,
  defaultAssetQuoteStates,
  defaultQuoteState,
  normalizeMarketKey
} from "../state/AssetStateRuntime";
import { finiteMetric, nullableFiniteMetric } from "./RuntimeMetrics";
export { highResolutionNow, parseTimestampMs, roundLatency } from "./RuntimeClock";
export {
  escapePrometheusLabel,
  finiteMetric,
  nullableFiniteMetric,
  processingLatencyStats,
  prometheusLabels,
  prometheusMetric
} from "./RuntimeMetrics";
export {
  assertAgentSignal,
  assertMarketTick,
  clampInteger,
  decodeWebSocketMessage,
  finiteNumber,
  isPlainObject,
  json,
  parseJson,
  readBoundedNumber,
  readHyperliquidRawIngestPayload,
  readJsonOrNull,
  readNumber,
  readPositiveInteger,
  readPositiveNumber,
  readTelemetryNumber,
  shouldAggregateBusTelemetry
} from "./RuntimeParsing";
export {
  baseAssetFromInstrument,
  createNativeHyperliquidBookTick,
  createNativeHyperliquidFundingTick,
  createNativeHyperliquidTradeTick,
  epochMillis,
  hyperliquidNativeInstrumentCode,
  isNativeRecord,
  nativeBookSideLevels,
  nativeExchangeTimestamp,
  nativeHashSequence,
  nativeHyperliquidLatencyMetrics,
  nativeIso,
  nativeNumber,
  nativeObject,
  nativeSequence,
  nativeSide,
  nativeString,
  normalizeInstrumentSelector,
  normalizeNativeCoin,
  normalizeNativeInstrumentCode,
  normalizeSourceExchange,
  normalizeSourceWeight,
  parseHyperliquidNativeLevels,
  requireNativeString,
  splitNativeInstrument
} from "./NativeHyperliquidRuntime";
export {
  adverseAdjustedPaperFillPrice,
  aggregateQuoteState,
  defaultAssetMatrix,
  defaultAssetQuoteStates,
  defaultQuoteState,
  filterTargetOrderBooks,
  isInstrumentSelectedByMoltworker,
  isQuoteSuspendedAt,
  isTargetInstrument,
  normalizeAssetMatrix,
  normalizeAssetQuoteStates,
  normalizeMarketKey,
  quotePriceMovedTicks,
  quoteStateForInstrumentState,
  reconcileAssetQuoteStatesForConfig,
  resumeExpiredAssetQuoteStates,
  selectedMoltworkerInstruments,
  suspendAssetQuoteStates
} from "../state/AssetStateRuntime";
export {
  defaultAnomalyStatus,
  defaultCitadelState,
  defaultEngineState,
  defaultEnsembleState,
  defaultExecutionProfile,
  defaultInventoryGuardState,
  defaultInventoryState,
  defaultJanitorState,
  defaultLeadLagMetrics,
  defaultMicrostructure,
  defaultPriceDiscovery,
  defaultRiskLimits,
  defaultRiskMetrics,
  defaultShadowQueueState,
  defaultSlippageAnalytics,
  disabledCroupierDecision,
  disabledProfilerEvaluation,
  hawkesEvacuationSignal,
  inferSignalBias,
  maintenanceRecoveryInstruments,
  mergeRiskLimits,
  normalizeExecutionProfile,
  normalizeInventoryState,
  normalizePaperBankroll,
  parseDeltaNormalizationWeights,
  passiveInventoryGuardStateFromInventory,
  resolveMaxLatencyMs,
  touchAgentHealth
} from "../state/EngineStateDefaults";
export {
  cascadeInstrumentSet,
  isOpenCascadePosition,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  recentSwingHigh,
  recentSwingLow
} from "../cascade/CascadeSelectionRuntime";
export { deepClone, toJsonValue } from "./RuntimeSerialization";


interface DomBinAccumulator {
  side: OrderBookSide;
  priceStart: number;
  priceEnd: number;
  centerPrice: number;
  volume: number;
  levelCount: number;
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

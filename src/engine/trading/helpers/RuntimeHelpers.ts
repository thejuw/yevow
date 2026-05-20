/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/prefer-nullish-coalescing */
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
  aggregateDomBins,
  classifyMissingWalls,
  distanceBps,
  domHeatmapCell,
  emptyDomSnapshot,
  isLiquidityWall,
  isLiquidityWallRecord,
  latestActiveWalls,
  sanitizeWallHistory,
  toLiquidityWall,
  volumeStats,
  wallIdForBin,
  wasWallFilled
} from "../book/DomRuntimeHelpers";
export {
  buildMarketKey,
  calculateTimeToBookMs,
  hydrateLegacyLevel,
  hydrateOrderBooks,
  levelsToBookSide,
  parsePositiveNumberMap,
  parseTickSizeMap,
  profilerInstrumentFromStorageKey,
  profilerStorageKey,
  resolveBookSide,
  resolveCurrentInstrument,
  resolveDomBinSize,
  resolveTickSize,
  tickToDelta
} from "../book/BookRuntimeHelpers";
export {
  appendSlippagePoint,
  executionReportSize,
  executionTradeId,
  inferExecutionPrimaryDriver,
  isPortfolioFillStatus,
  mapManagedStatusToTradeStatus,
  positiveNumber,
  quoteStateTelemetry,
  quoteToTelemetry
} from "../execution/ExecutionRuntimeHelpers";
export { pearson, returns, safeParseJson, wait } from "./RuntimeMath";
export {
  applyReplayScenarioToTick,
  bucketReplayTrades,
  buildReplayAblation,
  buildReplayAttribution,
  buildReplayEquityCurve,
  buildReplayWalkForward,
  buildStressSummary,
  calculateMaxDrawdown,
  calculateReplaySharpe,
  calculateWinRate,
  findReplayExitTick,
  inferIntentDriver,
  modelReplayIntentTrade
} from "../replay/ReplayModelRuntime";
export {
  cascadeInstrumentSet,
  isOpenCascadePosition,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  recentSwingHigh,
  recentSwingLow
} from "../cascade/CascadeSelectionRuntime";
export { deepClone, toJsonValue } from "./RuntimeSerialization";



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

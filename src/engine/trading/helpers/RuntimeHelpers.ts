/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-type-conversion */
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

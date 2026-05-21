import type { Logger } from "../../../Logger";
import type { Backtester } from "../../../strategy/cascade/Backtester";
import type { NewsCalendar } from "../../../strategy/cascade/NewsCalendar";
import type { AppliedBookUpdate } from "../book/BookTypes";
import {
  applyTradingBookDeltaForTarget,
  applyTradingBookSnapshotForTarget,
  type TradingBookApplicationTarget
} from "../book/TradingBookApplicationRuntime";
import {
  resetTradingOrderBookForTarget,
  type TradingOrderBookResetTarget
} from "../book/OrderBookResetRuntime";
import {
  currentTradingBookSnapshotForTarget,
  currentTradingDomHeatmapForTarget,
  type TradingBookViewTarget
} from "../book/TradingBookViewRuntime";
import {
  registerHyperliquidIngestConnectionForTarget,
  type HyperliquidIngestConnectionTarget,
  type HyperliquidRawIngestPayload
} from "../ingest/HyperliquidRawRouting";
import {
  applyTradingEngineConfigUpdateForTarget,
  refreshTradingConfigIfDueForTarget,
  type TradingConfigRefreshCadenceTarget,
  type TradingEngineConfigControlTarget
} from "../config/TradingConfigControlRuntime";
import {
  handleTradingHyperliquidRawForTarget,
  type TradingHyperliquidRawEngineTarget
} from "../ingest/TradingHyperliquidRawRuntime";
import { handleGrpcFatalDropForTarget, type GrpcFatalDropTarget } from "../ingest/GrpcDropRuntime";
import {
  enqueueTradingIngestJob,
  type TradingIngestQueueTarget
} from "../ingest/IngestQueueRuntime";
import {
  handleTickForTarget,
  type TradingTickHandlingTarget
} from "../pipelines/TickHandlingRuntime";
import { buildTradingPerformanceMetricsResponseForTarget } from "../telemetry/TradingHotPathTelemetryRuntime";
import { resetTradingLatencyBaselineForTarget } from "../performance/TradingLatencyStateRuntime";
import {
  applyTradingExecutionReportForTarget,
  type TradingExecutionReportTarget
} from "../execution/TradingExecutionReportRuntime";
import {
  acceptTradingAgentSignalForTarget,
  type TradingSignalBusTarget
} from "../telemetry/TradingSignalBusRuntime";
import { pruneTradingOperationalLogs } from "../janitor/TradingJanitorRuntime";
import {
  runTradingHistoricalReplayForStatefulTarget,
  type TradingHistoricalReplayStatefulTarget
} from "../replay/TradingReplayRunRuntime";
import {
  buildTradingEngineDiagnosticsForTarget,
  buildTradingHealthReportForTarget,
  syncTradingStateMicrostructureForTarget,
  type TradingEngineDiagnosticsTarget
} from "../state/EngineDiagnostics";
import {
  recoverTradingEngineStateForTarget,
  type TradingAdminRecoveryTarget
} from "../state/RecoveryRuntime";
import {
  currentCascadeSignalSnapshot as buildCurrentCascadeSignalSnapshot,
  currentTradingCascadeActiveSnapshotForTarget,
  currentTradingCascadeHeatSnapshotForTarget,
  currentTradingCascadePositionSnapshotForTarget,
  type TradingCascadeSnapshotTarget
} from "../cascade/CascadeSnapshots";
import {
  closeTradingEngineCascadePosition,
  type TradingCascadeManualCloseTarget
} from "../cascade/TradingCascadeManualCloseRuntime";
import type { ReplayOptions, ReplayStatus } from "./ReplayAdminRoutes";
import { handleBookAdminRoute } from "./BookAdminRoutes";
import { handleCascadeAdminRoute } from "./CascadeAdminRoutes";
import { handleMaintenanceRoute } from "./MaintenanceRoutes";
import { handleReplayAdminRoute } from "./ReplayAdminRoutes";
import { handleSentimentRoute } from "./SentimentRoutes";
import type {
  AdminConfigUpdate,
  AgentSignal,
  BookSnapshotResponse,
  DomAnalysisSnapshot,
  EngineState,
  Env,
  ExecutionReport,
  HealthReport,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MarketTick,
  OrderBookDelta,
  OrderBookResetRequest,
  OrderBookSnapshot,
  ReplayResult
} from "../../../types";
import type { LogPruneReport } from "../../LogRetention";
import {
  assertAgentSignal,
  assertMarketTick,
  json,
  readHyperliquidRawIngestPayload
} from "../helpers/RuntimeParsing";
import {
  BOOK_SNAPSHOT_TOP_LEVELS,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  PERFORMANCE_HISTORY_LIMIT,
  SIGNAL_BUFFER_LIMIT
} from "../../../TradingEngineConstants";
import { putTradingStorageForTargetOrHandler } from "../state/StorageWriteGuard";
import { publishTradingTelemetryForTarget } from "../telemetry/TelemetryBus";
import type { TickIngestResult, GrpcFatalDropPayload } from "../TradingEngineRouteTypes";

export interface EngineHttpRouteContext {
  env: Env;
  state: DurableObjectState;
  logger: Logger;
  wakeUpTimeMs: number | null;
  getEngineState(): EngineState;
  setEngineState(state: EngineState): void;
  getOrderBook(): Map<string, InternalOrderBook>;
  getLatencyHistory(): LatencyMetrics[];
  getProcessingLatencySamples(): number[];
  getCachedConfig(): EngineState["cachedConfig"];
  getCascadeBacktester(): Backtester;
  getCascadeNewsCalendar(): NewsCalendar;
  refreshConfigIfDue(source: "ALARM" | "ADMIN_SIGNAL"): Promise<void>;
  healthCheck(): HealthReport;
  engineDiagnostics(): JsonRecord;
  syncStateMicrostructureFromBook(): void;
  performanceMetricsResponse(): Response;
  resetLatencyBaseline(observedAt: string, reason: string): void;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  safeStoragePutEntries(value: Record<string, unknown>, reason: string): Promise<void>;
  safeStoragePutKey(key: string, value: unknown, reason: string): Promise<void>;
  recoverEngineState(payload: {
    reason?: string;
    resetInstruments?: string[] | string;
    instrumentCode?: string;
    source_exchange?: string;
    clearCitadel?: boolean;
    clearQuoteState?: boolean;
    clearLatency?: boolean;
    resetPaperPortfolio?: boolean;
    clearShadowQueue?: boolean;
  }): Promise<unknown>;
  pruneOperationalLogs(): Promise<LogPruneReport>;
  currentBookSnapshot(instrumentCode: string | undefined, depth: number): BookSnapshotResponse;
  currentDomHeatmap(instrumentCode: string | undefined): DomAnalysisSnapshot;
  applySnapshot(snapshot: OrderBookSnapshot): Promise<unknown>;
  applyDelta(delta: OrderBookDelta, observedAt: string): Promise<AppliedBookUpdate>;
  enqueueOrderBookReset(payload: Partial<OrderBookResetRequest>): Promise<unknown>;
  registerIngestConnection(payload: Partial<OrderBookResetRequest>): unknown;
  runHistoricalReplay(
    limit: number,
    shadowBankroll: number,
    speedMultiplier: number,
    dateFrom: string | null,
    dateTo: string | null,
    replayOptions: ReplayOptions
  ): Promise<ReplayResult>;
  currentReplayStatus(): Promise<ReplayStatus>;
  currentCascadeActiveSnapshot(): unknown;
  currentCascadeSignalSnapshot(limit: number): unknown;
  currentCascadePositionSnapshot(): unknown;
  closeCascadePosition(
    positionId: string,
    actor: string,
    reason: string
  ): Promise<{ ok: boolean; [key: string]: unknown }>;
  currentCascadeHeatSnapshot(): unknown;
  analyzeSentimentHeadline(headline: string): Promise<EngineState["sentiment"]>;
  applyExecutionReport(report: ExecutionReport): Promise<void>;
  enqueueTick(tick: MarketTick, wakeUpTimeMs: number | null): Promise<TickIngestResult>;
  handleHyperliquidRaw(payload: unknown, wakeUpTimeMs: number | null): Promise<TickIngestResult>;
  handleGrpcFatalDrop(payload: GrpcFatalDropPayload): Promise<{ status: string }>;
  acceptAgentSignal(signal: AgentSignal, latencyMs: number): Promise<void>;
  applyConfigUpdate(update: AdminConfigUpdate): Promise<void>;
}

export interface EngineHttpRouteContextTarget extends TradingBookApplicationTarget {
  readonly env: Env;
  readonly state: DurableObjectState;
  readonly logger: Logger;
  engineState: EngineState;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: number[];
  readonly cachedConfig: EngineState["cachedConfig"];
  readonly signals: readonly AgentSignal[];
  readonly cascadeBacktester: Backtester;
  readonly cascadeNewsCalendar: NewsCalendar;
  readonly replayJournal: { currentStatus(): Promise<ReplayStatus> };
  readonly sentimentAgent: {
    analyzeHeadline(headline: string, env: Env): Promise<EngineState["sentiment"]>;
  };
  refreshConfigIfDue?(source: "ALARM" | "ADMIN_SIGNAL"): Promise<void>;
  resetLatencyBaseline?(observedAt: string, reason: string): void;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  safeStoragePut?(entries: Record<string, unknown>, reason: string): Promise<void>;
  safeStoragePut?(key: string, value: unknown, reason: string): Promise<void>;
  recoverEngineState?(
    payload: Parameters<EngineHttpRouteContext["recoverEngineState"]>[0]
  ): Promise<unknown>;
  enqueueTick?(tick: MarketTick, wakeUpTimeMs: number | null): Promise<TickIngestResult>;
  acceptAgentSignal?(signal: AgentSignal, latencyMs: number): Promise<void>;
  applyConfigUpdate?(update: AdminConfigUpdate): Promise<void>;
}

export function createTradingEngineHttpRouteContext(
  target: EngineHttpRouteContextTarget,
  wakeUpTimeMs: number | null
): EngineHttpRouteContext {
  return {
    env: target.env,
    state: target.state,
    logger: target.logger,
    wakeUpTimeMs,
    getEngineState: () => target.engineState,
    setEngineState: (state) => {
      target.engineState = state;
    },
    getOrderBook: () => target.orderBook,
    getLatencyHistory: () => target.latencyHistory,
    getProcessingLatencySamples: () => target.processingLatencySamples,
    getCachedConfig: () => target.cachedConfig,
    getCascadeBacktester: () => target.cascadeBacktester,
    getCascadeNewsCalendar: () => target.cascadeNewsCalendar,
    refreshConfigIfDue: (source) =>
      target.refreshConfigIfDue
        ? target.refreshConfigIfDue(source)
        : refreshTradingConfigIfDueForTarget(
            source,
            target as unknown as TradingConfigRefreshCadenceTarget
          ).then(() => undefined),
    healthCheck: () =>
      buildTradingHealthReportForTarget(target as unknown as TradingEngineDiagnosticsTarget),
    engineDiagnostics: () =>
      buildTradingEngineDiagnosticsForTarget(target as unknown as TradingEngineDiagnosticsTarget),
    syncStateMicrostructureFromBook: () => {
      syncTradingStateMicrostructureForTarget(target as unknown as TradingEngineDiagnosticsTarget);
    },
    performanceMetricsResponse: () => buildTradingPerformanceMetricsResponseForTarget(target),
    resetLatencyBaseline: (observedAt, reason) => {
      if (target.resetLatencyBaseline) {
        target.resetLatencyBaseline(observedAt, reason);
        return;
      }
      resetTradingLatencyBaselineForTarget(observedAt, reason, target);
    },
    publish: (type, payload, correlationId) => {
      publishTradingTelemetryForTarget(target, type, payload, correlationId);
    },
    safeStoragePutEntries: (entries, reason) =>
      putTradingStorageForTargetOrHandler(target, entries, reason),
    safeStoragePutKey: (key, value, reason) =>
      putTradingStorageForTargetOrHandler(target, key, value, reason),
    recoverEngineState: (payload) =>
      target.recoverEngineState
        ? target.recoverEngineState(payload)
        : recoverTradingEngineStateForTarget(
            payload,
            target as unknown as TradingAdminRecoveryTarget
          ),
    pruneOperationalLogs: () =>
      pruneTradingOperationalLogs({
        db: target.env.TRADING_DB,
        env: target.env,
        logger: target.logger
      }),
    currentBookSnapshot: (instrumentCode, depth) =>
      currentTradingBookSnapshotForTarget(
        target as unknown as TradingBookViewTarget,
        instrumentCode,
        depth
      ),
    currentDomHeatmap: (instrumentCode) =>
      currentTradingDomHeatmapForTarget(target as unknown as TradingBookViewTarget, instrumentCode),
    applySnapshot: (snapshot) => applyTradingBookSnapshotForTarget(snapshot, {}, target),
    applyDelta: (delta, observedAt) => applyTradingBookDeltaForTarget(delta, observedAt, target),
    enqueueOrderBookReset: (payload) =>
      enqueueTradingIngestJob(target as unknown as TradingIngestQueueTarget, () =>
        resetTradingOrderBookForTarget(payload, target as unknown as TradingOrderBookResetTarget)
      ),
    registerIngestConnection: (payload) =>
      registerHyperliquidIngestConnectionForTarget(
        payload,
        target as unknown as HyperliquidIngestConnectionTarget
      ),
    runHistoricalReplay: (
      limit,
      shadowBankroll,
      speedMultiplier,
      dateFrom,
      dateTo,
      replayOptions
    ) =>
      runTradingHistoricalReplayForStatefulTarget(
        {
          limit,
          shadowBankroll,
          speedMultiplier,
          dateFrom,
          dateTo,
          replayOptions
        },
        target as unknown as TradingHistoricalReplayStatefulTarget
      ),
    currentReplayStatus: () => target.replayJournal.currentStatus(),
    currentCascadeActiveSnapshot: () =>
      currentTradingCascadeActiveSnapshotForTarget(
        target as unknown as TradingCascadeSnapshotTarget
      ),
    currentCascadeSignalSnapshot: (limit) =>
      buildCurrentCascadeSignalSnapshot(target.signals, limit),
    currentCascadePositionSnapshot: () =>
      currentTradingCascadePositionSnapshotForTarget(
        target as unknown as TradingCascadeSnapshotTarget
      ),
    closeCascadePosition: (positionId, actor, reason) =>
      Promise.resolve(
        closeTradingEngineCascadePosition(
          { positionId, actor, reason },
          target as unknown as TradingCascadeManualCloseTarget
        ) as unknown as { ok: boolean; [key: string]: unknown }
      ),
    currentCascadeHeatSnapshot: () =>
      currentTradingCascadeHeatSnapshotForTarget(target as unknown as TradingCascadeSnapshotTarget),
    analyzeSentimentHeadline: (headline) =>
      target.sentimentAgent.analyzeHeadline(headline, target.env),
    applyExecutionReport: async (report) => {
      await applyTradingExecutionReportForTarget(
        report,
        target as unknown as TradingExecutionReportTarget
      );
    },
    enqueueTick: (tick, wakeUp) =>
      target.enqueueTick
        ? target.enqueueTick(tick, wakeUp)
        : enqueueTradingIngestJob(target as unknown as TradingIngestQueueTarget, () =>
            handleTickForTarget(tick, wakeUp, {}, target as unknown as TradingTickHandlingTarget)
          ),
    handleHyperliquidRaw: (payload, wakeUp) =>
      handleTradingHyperliquidRawForTarget(
        payload as HyperliquidRawIngestPayload,
        wakeUp,
        target as unknown as TradingHyperliquidRawEngineTarget
      ),
    handleGrpcFatalDrop: (payload) =>
      Promise.resolve(
        handleGrpcFatalDropForTarget(payload, target as unknown as GrpcFatalDropTarget)
      ),
    acceptAgentSignal: (signal, latencyMs) =>
      target.acceptAgentSignal
        ? target.acceptAgentSignal(signal, latencyMs)
        : acceptTradingAgentSignalForTarget(
            signal,
            latencyMs,
            target as unknown as TradingSignalBusTarget
          ),
    applyConfigUpdate: (update) =>
      target.applyConfigUpdate
        ? target.applyConfigUpdate(update)
        : applyTradingEngineConfigUpdateForTarget(
            update,
            target as unknown as TradingEngineConfigControlTarget
          )
  };
}

export async function handleTradingEngineHttpRoute(
  request: Request,
  url: URL,
  context: EngineHttpRouteContext
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/health") {
    context.state.waitUntil(
      context.refreshConfigIfDue("ALARM").catch((error: unknown) => {
        context.logger.error("CONFIG_REFRESH_FAILED", "Health-triggered config refresh failed", {
          source: "HEALTH",
          message: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        });
      })
    );
    return json(context.healthCheck());
  }

  if (request.method === "GET" && url.pathname === "/diagnostics") {
    return json(context.engineDiagnostics());
  }

  if (request.method === "GET" && url.pathname === "/state") {
    context.syncStateMicrostructureFromBook();
    return json({
      state: context.getEngineState(),
      orderBook: Object.fromEntries(context.getOrderBook())
    });
  }

  if (request.method === "GET" && url.pathname === "/performance") {
    return json(context.getLatencyHistory().slice(-PERFORMANCE_HISTORY_LIMIT));
  }

  if (request.method === "GET" && url.pathname === "/slippage") {
    return json(context.getEngineState().slippage);
  }

  if (request.method === "GET" && url.pathname === "/metrics/performance") {
    return context.performanceMetricsResponse();
  }

  const maintenanceRoute = await handleMaintenanceRoute(request, url, context);
  if (maintenanceRoute) {
    return maintenanceRoute;
  }

  const bookRoute = await handleBookAdminRoute(request, url, {
    maxSnapshotDepth: BOOK_SNAPSHOT_TOP_LEVELS,
    getEngineState: () => context.getEngineState(),
    currentBookSnapshot: (instrumentCode, depth) =>
      context.currentBookSnapshot(instrumentCode, depth),
    currentDomHeatmap: (instrumentCode) => context.currentDomHeatmap(instrumentCode),
    currentLiquidationHeatmap: () => context.getEngineState().liquidationHeatmap,
    applySnapshot: (snapshot) => context.applySnapshot(snapshot),
    applyDelta: (delta, observedAt) => context.applyDelta(delta, observedAt),
    enqueueOrderBookReset: (payload) => context.enqueueOrderBookReset(payload),
    registerIngestConnection: (payload) => context.registerIngestConnection(payload)
  });
  if (bookRoute) {
    return bookRoute;
  }

  const replayRoute = await handleReplayAdminRoute(request, url, {
    exchangeFeeBps: context.getCachedConfig().EXCHANGE_FEE_BPS,
    getEngineState: () => context.getEngineState(),
    runHistoricalReplay: (limit, shadowBankroll, speedMultiplier, dateFrom, dateTo, options) =>
      context.runHistoricalReplay(
        limit,
        shadowBankroll,
        speedMultiplier,
        dateFrom,
        dateTo,
        options
      ),
    currentReplayStatus: () => context.currentReplayStatus()
  });
  if (replayRoute) {
    return replayRoute;
  }

  const cascadeRoute = await handleCascadeAdminRoute(request, url, {
    signalBufferLimit: SIGNAL_BUFFER_LIMIT,
    cachedConfig: context.getCachedConfig(),
    env: context.env,
    cascadeBacktester: context.getCascadeBacktester(),
    persistBacktestSummary: (summary) => {
      context.state.waitUntil(
        context.env.CONFIG_STORE.put(CASCADE_LAST_BACKTEST_REPORT_KEY, JSON.stringify(summary))
      );
    },
    currentCascadeActiveSnapshot: () => context.currentCascadeActiveSnapshot(),
    currentCascadeSignalSnapshot: (limit) => context.currentCascadeSignalSnapshot(limit),
    currentCascadePositionSnapshot: () => context.currentCascadePositionSnapshot(),
    closeCascadePosition: (positionId, actor, reason) =>
      context.closeCascadePosition(positionId, actor, reason),
    currentCascadeHeatSnapshot: () => context.currentCascadeHeatSnapshot(),
    addNewsBlackout: (payload) => context.getCascadeNewsCalendar().addAdHocBlackout(payload)
  });
  if (cascadeRoute) {
    return cascadeRoute;
  }

  if (request.method === "POST" && url.pathname === "/news/sentiment") {
    return handleSentimentRoute(request, context);
  }

  if (request.method === "POST" && url.pathname === "/execution/report") {
    const report = await request.json<ExecutionReport>();
    await context.applyExecutionReport(report);
    return json({ ok: true, state: context.getEngineState() });
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/tick" ||
      url.pathname === "/market/tick" ||
      url.pathname === "/hyperliquid/tick")
  ) {
    const payload = await request.json<MarketTick>();
    const tick = assertMarketTick(payload);
    const result = await context.enqueueTick(tick, context.wakeUpTimeMs);
    return tickResponse(result, context.getEngineState());
  }

  if (request.method === "POST" && url.pathname === "/hyperliquid/raw") {
    const payload = await readHyperliquidRawIngestPayload(request);
    const result = await context.handleHyperliquidRaw(payload, context.wakeUpTimeMs);
    return rawTickResponse(result, context.getEngineState(), true);
  }

  if (request.method === "POST" && url.pathname === "/liquidation") {
    const payload = await readHyperliquidRawIngestPayload(request);
    const result = await context.handleHyperliquidRaw(payload, context.wakeUpTimeMs);
    return rawTickResponse(result, context.getEngineState(), false);
  }

  if (request.method === "POST" && url.pathname === "/ingest/grpc-fatal-drop") {
    const payload = await request.json<GrpcFatalDropPayload>();
    const result = await context.handleGrpcFatalDrop(payload);
    return json({
      ok: true,
      accepted: true,
      status: result.status,
      state: context.getEngineState()
    });
  }

  if (request.method === "POST" && url.pathname === "/ticks") {
    return handleTickBatchRoute(request, context);
  }

  if (request.method === "POST" && url.pathname === "/agent/signal") {
    const started = Date.now();
    const signal = assertAgentSignal(await request.json<AgentSignal>());
    await context.acceptAgentSignal(signal, Date.now() - started);
    return json({ ok: true, signalId: signal.signalId, state: context.getEngineState() });
  }

  if (request.method === "POST" && url.pathname === "/admin/config") {
    const update = await request.json<AdminConfigUpdate>();
    await context.applyConfigUpdate(update);
    return json({ ok: true, state: context.getEngineState() });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function handleTickBatchRoute(
  request: Request,
  context: EngineHttpRouteContext
): Promise<Response> {
  const payload = await request.json<MarketTick[] | { ticks?: MarketTick[] }>();
  const ticks = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.ticks)
      ? payload.ticks
      : null;

  if (!ticks) {
    throw new Error("INVALID_MARKET_TICK_BATCH");
  }

  const results: TickIngestResult[] = [];
  const cappedTicks = ticks.slice(0, 250);

  for (const tickPayload of cappedTicks) {
    const result = await context.enqueueTick(assertMarketTick(tickPayload), context.wakeUpTimeMs);
    results.push(result);

    if (result.status === "DESYNC") {
      break;
    }
  }

  const acceptedCount = results.filter((result) => result.accepted).length;
  const terminalResult = results.find((result) => result.status === "DESYNC") ?? results.at(-1);

  return json(
    {
      ok: terminalResult?.status !== "DESYNC",
      accepted: acceptedCount > 0,
      acceptedCount,
      receivedCount: ticks.length,
      processedCount: results.length,
      droppedCount: Math.max(0, ticks.length - results.length),
      status: terminalResult?.status ?? "EMPTY_BATCH",
      reason: terminalResult?.reason,
      metrics: terminalResult?.metrics ?? null,
      book: terminalResult?.book,
      state: context.getEngineState()
    },
    terminalResult?.status === "DESYNC" ? 409 : 200
  );
}

function tickResponse(result: TickIngestResult, state: EngineState): Response {
  return json(
    {
      ok: result.accepted,
      accepted: result.accepted,
      status: result.status,
      reason: result.reason,
      metrics: result.metrics ?? null,
      book: result.book,
      state
    },
    result.accepted ? 200 : 202
  );
}

function rawTickResponse(
  result: TickIngestResult,
  state: EngineState,
  conflictOnDesync: boolean
): Response {
  return json(
    {
      ok: result.accepted,
      accepted: result.accepted,
      processedCount: result.processedCount,
      status: result.status,
      reason: result.reason,
      metrics: result.metrics ?? null,
      book: result.book,
      state
    },
    conflictOnDesync && result.status === "DESYNC" ? 409 : result.accepted ? 200 : 202
  );
}

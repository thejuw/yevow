import { defaultSentimentState } from "../../../agents/SentimentAgent";
import type { Logger } from "../../../Logger";
import type { Backtester } from "../../../strategy/cascade/Backtester";
import type { NewsCalendar } from "../../../strategy/cascade/NewsCalendar";
import type { AppliedBookUpdate } from "../book/BookTypes";
import type { ReplayOptions, ReplayStatus } from "./ReplayAdminRoutes";
import { handleBookAdminRoute } from "./BookAdminRoutes";
import { handleCascadeAdminRoute } from "./CascadeAdminRoutes";
import { handleReplayAdminRoute } from "./ReplayAdminRoutes";
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
  aggregateQuoteState,
  assertAgentSignal,
  assertMarketTick,
  json,
  logPruneReportToJson,
  readHyperliquidRawIngestPayload,
  readJsonOrNull,
  resumeExpiredAssetQuoteStates,
  suspendAssetQuoteStates,
  touchAgentHealth
} from "../../../TradingEngineRuntimeHelpers";
import {
  BOOK_SNAPSHOT_TOP_LEVELS,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  ENGINE_STATE_KEY,
  PERFORMANCE_HISTORY_KEY,
  PERFORMANCE_HISTORY_LIMIT,
  PROCESSING_LATENCY_SAMPLES_KEY,
  SIGNAL_BUFFER_LIMIT
} from "../../../TradingEngineConstants";
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

async function handleMaintenanceRoute(
  request: Request,
  url: URL,
  context: EngineHttpRouteContext
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/maintenance/reset-latency") {
    const observedAt = new Date().toISOString();
    const engineState = context.getEngineState();
    const shouldClearQuoteSuspension =
      engineState.quoteState.status === "SUSPENDED" &&
      (engineState.quoteState.reason === "HARD_STALE_DROP" ||
        engineState.quoteState.reason === "NATIVE_HL_LATENCY" ||
        engineState.quoteState.reason === "GRPC_FATAL_DROP" ||
        engineState.quoteState.reason === "STALE_DATA_KILL_SWITCH");
    context.resetLatencyBaseline(observedAt, "ADMIN_MAINTENANCE");
    const recoveredAssetQuoteStates = shouldClearQuoteSuspension
      ? resumeExpiredAssetQuoteStates(
          suspendAssetQuoteStates(engineState.assetQuoteStates, "ADMIN_RESET_LATENCY", observedAt, {
            suspendedUntil: observedAt
          }),
          observedAt
        )
      : engineState.assetQuoteStates;
    const recoveredQuoteState = shouldClearQuoteSuspension
      ? aggregateQuoteState(recoveredAssetQuoteStates, engineState.quoteState, observedAt)
      : engineState.quoteState;
    const nextState = {
      ...engineState,
      staleTickCount: 0,
      quoteState: recoveredQuoteState,
      assetQuoteStates: recoveredAssetQuoteStates,
      updatedAt: observedAt
    };
    context.setEngineState(nextState);
    if (shouldClearQuoteSuspension) {
      context.publish("RESUME_QUOTES", {
        reason: "ADMIN_RESET_LATENCY",
        observedAt
      });
    }
    await context.safeStoragePutEntries(
      {
        [ENGINE_STATE_KEY]: nextState,
        [PERFORMANCE_HISTORY_KEY]: context.getLatencyHistory(),
        [PROCESSING_LATENCY_SAMPLES_KEY]: context.getProcessingLatencySamples()
      },
      "ADMIN_RESET_LATENCY"
    );
    return json({ ok: true, state: nextState });
  }

  if (request.method === "POST" && url.pathname === "/maintenance/recover") {
    const payload =
      (await readJsonOrNull<{
        reason?: string;
        resetInstruments?: string[] | string;
        instrumentCode?: string;
        source_exchange?: string;
        clearCitadel?: boolean;
        clearQuoteState?: boolean;
        clearLatency?: boolean;
        resetPaperPortfolio?: boolean;
        clearShadowQueue?: boolean;
      }>(request)) ?? {};
    const recovery = await context.recoverEngineState(payload);

    return json(recovery);
  }

  if (request.method === "POST" && url.pathname === "/maintenance/prune-logs") {
    const report = await context.pruneOperationalLogs();
    context.logger.warn("ADMIN_LOG_PRUNE_APPLIED", "Admin-triggered stale log cleanup completed", {
      report: logPruneReportToJson(report)
    });

    return json({ ok: true, report });
  }

  return null;
}

async function handleSentimentRoute(
  request: Request,
  context: EngineHttpRouteContext
): Promise<Response> {
  const payload = await request.json<{
    headline?: string;
    source?: string;
    url?: string | null;
    publishedAt?: string | null;
    id?: string;
  }>();
  const engineState = context.getEngineState();
  if (!context.getCachedConfig().SENTIMENT_ENABLED) {
    const observedAt = new Date().toISOString();
    const sentiment = {
      ...defaultSentimentState(),
      updatedAt: observedAt
    };
    const nextState = {
      ...engineState,
      sentiment,
      agentHealth: touchAgentHealth(
        engineState.agentHealth,
        "SENTIMENT",
        "DISABLED",
        observedAt,
        0
      ),
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };
    context.setEngineState(nextState);
    await context.safeStoragePutKey(ENGINE_STATE_KEY, nextState, "SENTIMENT_DISABLED");
    return json({ ok: true, skipped: true, reason: "SENTIMENT_AGENT_DISABLED", sentiment });
  }

  const sentiment = await context.analyzeSentimentHeadline(payload.headline ?? "");
  const observedAt = sentiment.updatedAt ?? new Date().toISOString();
  const nextState = {
    ...engineState,
    sentiment,
    agentHealth: touchAgentHealth(
      engineState.agentHealth,
      "SENTIMENT",
      "GREEN",
      observedAt,
      sentiment.latencyMs ?? 0
    ),
    heartbeatAt: observedAt,
    updatedAt: observedAt
  };
  context.setEngineState(nextState);
  await context.safeStoragePutKey(ENGINE_STATE_KEY, nextState, "SENTIMENT_UPDATED");
  context.logger.info("SENTIMENT_ANALYZED", "Sentiment agent updated headline bias", {
    score: sentiment.score,
    bias: sentiment.bias,
    model: sentiment.model,
    provider: sentiment.provider ?? null,
    fallbackUsed: sentiment.fallbackUsed ?? null,
    latencyMs: sentiment.latencyMs ?? null,
    estimatedCostUsd: sentiment.estimatedCostUsd ?? 0,
    ablation: sentiment.ablation ?? null,
    source: payload.source ?? "manual",
    url: payload.url ?? null,
    publishedAt: payload.publishedAt ?? null,
    newsId: payload.id ?? null
  });
  return json({ ok: true, sentiment });
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

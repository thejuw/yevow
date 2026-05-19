import type { Env, GlobalRiskConfig, JsonRecord } from "../../../types";
import { cascadeAssetProfilesToJsonRecord } from "../../../strategy/cascade/AssetProfiles";
import type { Backtester, BacktestInput } from "../../../strategy/cascade/Backtester";
import { clampInteger, json, readJsonOrNull, readPositiveInteger } from "./RouteUtils";

export interface CascadeAdminRouteContext {
  signalBufferLimit: number;
  cachedConfig: GlobalRiskConfig;
  env: Pick<Env, "CASCADE_MIN_BASELINE_WINDOWS" | "CASCADE_MIN_SEPARATION_MS">;
  cascadeBacktester: Pick<Backtester, "run">;
  persistBacktestSummary(summary: CascadeBacktestSummary): void;
  currentCascadeActiveSnapshot(): unknown;
  currentCascadeSignalSnapshot(limit: number): unknown;
  currentCascadePositionSnapshot(): unknown;
  closeCascadePosition(
    positionId: string,
    actor: string,
    reason: string
  ): Promise<{ ok: boolean; [key: string]: unknown }>;
  currentCascadeHeatSnapshot(): unknown;
  addNewsBlackout(payload: ValidNewsBlackoutPayload): Promise<unknown>;
}

export interface CascadeBacktestSummary {
  schemaVersion: "cascade.backtest-readiness.v1";
  reportId: string;
  generatedAt: string;
  fromDate: string;
  toDate: string;
  instruments: string[];
  tradeCount: number;
  totalPnl: number;
  maxDrawdownPct: number;
  validationOk: boolean;
  positiveExpectancy: boolean;
  dataQuality: JsonRecord;
  perAssetStats: JsonRecord;
}

export interface NewsBlackoutPayload {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  assets?: string[];
  createdBy?: string;
}

export interface ValidNewsBlackoutPayload {
  title: string;
  startsAt: string;
  endsAt: string;
  assets: string[];
  createdBy: string;
}

export async function handleCascadeAdminRoute(
  request: Request,
  url: URL,
  context: CascadeAdminRouteContext
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/admin/backtest/cascade") {
    const payload = await readJsonOrNull<BacktestInput>(request);
    if (!payload) {
      return json({ ok: false, error: "INVALID_BACKTEST_REQUEST" }, 400);
    }

    const report = await context.cascadeBacktester.run({
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      instruments: payload.instruments,
      startingEquity: payload.startingEquity,
      candles: payload.candles,
      liquidations: payload.liquidations,
      openInterest: payload.openInterest,
      config: {
        ...buildCascadeBacktestConfig(context.cachedConfig, context.env),
        ...payload.config
      }
    });

    context.persistBacktestSummary(buildCascadeBacktestSummary(report));
    return json({ ok: true, report });
  }

  if (request.method === "GET" && url.pathname === "/admin/cascade/active") {
    return json({
      ok: true,
      cascades: context.currentCascadeActiveSnapshot(),
      assetProfiles: cascadeAssetProfilesToJsonRecord(context.cachedConfig.CASCADE_ASSET_PROFILES)
    });
  }

  if (request.method === "GET" && url.pathname === "/admin/cascade/signals") {
    const limit = clampInteger(url.searchParams.get("limit"), 50, 1, context.signalBufferLimit);
    return json({ ok: true, signals: context.currentCascadeSignalSnapshot(limit) });
  }

  if (request.method === "GET" && url.pathname === "/admin/cascade/positions") {
    return json({ ok: true, positions: context.currentCascadePositionSnapshot() });
  }

  if (
    request.method === "POST" &&
    /^\/admin\/cascade\/positions\/[^/]+\/close$/.test(url.pathname)
  ) {
    const [, , , , positionId] = url.pathname.split("/");
    const payload = (await readJsonOrNull<{ reason?: string; actor?: string }>(request)) ?? {};
    const result = await context.closeCascadePosition(
      decodeURIComponent(positionId),
      normalizeAdminText(payload.actor, "admin"),
      normalizeAdminText(payload.reason, "operator-request")
    );
    return json(result, result.ok ? 200 : 404);
  }

  if (request.method === "GET" && url.pathname === "/admin/cascade/heat") {
    return json({ ok: true, heat: context.currentCascadeHeatSnapshot() });
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/admin/cascade/blackout" || url.pathname === "/news/blackout")
  ) {
    const payload = await request.json<NewsBlackoutPayload>();
    if (!payload.title || !payload.startsAt || !payload.endsAt) {
      return json({ ok: false, error: "INVALID_NEWS_BLACKOUT" }, 400);
    }

    const blackout: ValidNewsBlackoutPayload = {
      title: payload.title,
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      assets: payload.assets ?? ["*"],
      createdBy: payload.createdBy ?? "admin"
    };
    const calendar = await context.addNewsBlackout(blackout);
    return json({ ok: true, calendar });
  }

  return null;
}

export function buildCascadeBacktestConfig(
  config: GlobalRiskConfig,
  env: Pick<Env, "CASCADE_MIN_BASELINE_WINDOWS" | "CASCADE_MIN_SEPARATION_MS">
): NonNullable<BacktestInput["config"]> {
  return {
    strategyMode: config.STRATEGY_MODE,
    feeBps: config.EXCHANGE_FEE_BPS,
    riskPerTradePct: config.RISK_PER_TRADE_PCT,
    cascadeWindowMs: config.CASCADE_WINDOW_MS,
    cascadeNotionalThresholdUsd: config.CASCADE_NOTIONAL_THRESHOLD_USD,
    cascadeZScoreThreshold: config.CASCADE_ZSCORE_THRESHOLD,
    cascadeAssetProfiles: config.CASCADE_ASSET_PROFILES,
    cascadeLookbackHours: config.CASCADE_LOOKBACK_HOURS,
    cascadeDirectionalPct: config.CASCADE_DIRECTIONAL_PCT,
    cascadeMinPriceMoveAtr: config.CASCADE_MIN_PRICE_MOVE_ATR,
    cascadeMinBaselineWindows: readPositiveInteger(env.CASCADE_MIN_BASELINE_WINDOWS, 12, 0, 10_000),
    cascadeMinSeparationMs: readPositiveInteger(
      env.CASCADE_MIN_SEPARATION_MS,
      config.CASCADE_WINDOW_MS,
      0,
      6 * 3_600_000
    ),
    absorptionWindowMs: config.ABSORPTION_WINDOW_MS,
    absorptionPriceBandBps: config.ABSORPTION_PRICE_BAND_BPS,
    absorptionMinHoldSeconds: config.ABSORPTION_MIN_HOLD_SECONDS,
    entryWindowSeconds: config.ENTRY_WINDOW_SECONDS,
    impulsiveBarBodyAtr: config.IMPULSIVE_BAR_BODY_ATR,
    impulsiveBarVolumeMult: config.IMPULSIVE_BAR_VOLUME_MULT,
    stopBufferAtr: config.STOP_BUFFER_ATR,
    minStopDistanceBps: config.MIN_STOP_DISTANCE_BPS,
    maxStopDistanceBps: config.MAX_STOP_DISTANCE_BPS,
    minTimeSinceLastCascadeSeconds: config.MIN_TIME_SINCE_LAST_CASCADE_SECONDS,
    newsBlackoutMinutes: config.NEWS_BLACKOUT_MINUTES,
    maxRealizedVolPercentile: config.MAX_REALIZED_VOL_PERCENTILE,
    timeStopHours: config.CASCADE_TIME_STOP_HOURS,
    partial1R: config.PARTIAL_1_R,
    partial1SizePct: config.PARTIAL_1_SIZE_PCT,
    partial2R: config.PARTIAL_2_R,
    partial2SizePct: config.PARTIAL_2_SIZE_PCT,
    runnerTrailingType: config.TRAILING_STOP_TYPE,
    runnerTrailingParam: config.TRAILING_STOP_PARAM,
    maxPositionNotionalPct: config.MAX_POSITION_NOTIONAL_PCT,
    assetLiquidityCapUsd: config.ASSET_LIQUIDITY_CAP_USD,
    heatCapPct: config.HEAT_CAP_PCT
  };
}

export function buildCascadeBacktestSummary(
  report: Awaited<ReturnType<Backtester["run"]>>
): CascadeBacktestSummary {
  const entryTradeCount = report.trades.filter((trade) => trade.status === "ENTRY").length;

  return {
    schemaVersion: "cascade.backtest-readiness.v1",
    reportId: `backtest:${Date.now()}`,
    generatedAt: new Date().toISOString(),
    fromDate: report.fromDate,
    toDate: report.toDate,
    instruments: report.instruments,
    tradeCount: entryTradeCount,
    totalPnl: report.totalPnl,
    maxDrawdownPct: report.maxDrawdownPct,
    validationOk: report.validation.ok,
    positiveExpectancy: report.validation.ok && report.totalPnl > 0 && entryTradeCount > 0,
    dataQuality: report.dataQuality,
    perAssetStats: report.perAssetStats
  };
}

function normalizeAdminText(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

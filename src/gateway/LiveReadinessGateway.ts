import type { Logger } from "../Logger";
import {
  evaluateCascadeLiveReadiness,
  type TwoPersonApproval
} from "../strategy/cascade/OperationalSafeguards";
import type { EdgeTopology, Env, GlobalRiskConfig, JsonRecord } from "../types";
import type { AuthenticatedAdmin, LiveReadinessCheck, LiveReadinessReport } from "./AdminModels";
import { safeResponseJson } from "./AdminValidation";
import {
  CASCADE_CONFIG_FREEZE_HOURS,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  CASCADE_LAST_CONFIG_CHANGE_AT_KEY,
  CASCADE_PAPER_ARMED_AT_KEY,
  CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS,
  CASCADE_TWO_PERSON_READ_APPROVAL_KEY,
  PAPER_SESSION_STARTED_AT_KEY
} from "./GatewayConstants";
import { paperTradeWhereSql, readPaperPnlSummary } from "./AdminHistoryQueries";
import { evaluateHyperliquidSecrets } from "./HyperliquidSecretDiagnostics";
import { json } from "./ResponseHelpers";
import { maskTokenId } from "./SecurityAudit";
import { isJsonRecord, positiveNumber, round } from "./ValueCodecs";

export type LiveReadinessEngineRouter = (
  request: Request,
  env: Env,
  topology: EdgeTopology
) => Promise<Response>;

export async function approveCascadeLiveReadiness(
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const approval: TwoPersonApproval = {
    jti: admin.claims.jti,
    subject: admin.subject,
    scopes: admin.claims.scopes,
    observedAt: new Date().toISOString()
  };

  await env.CONFIG_STORE.put(CASCADE_TWO_PERSON_READ_APPROVAL_KEY, JSON.stringify(approval), {
    expirationTtl: Math.ceil(CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS / 1_000)
  });
  logger.warn("CASCADE_LIVE_READ_APPROVAL_RECORDED", "Read-side cascade live approval recorded", {
    subject: admin.subject,
    jti: maskTokenId(admin.claims.jti),
    expiresInMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS,
    colo: topology.colo,
    placement: topology.placement
  });

  return json({
    ok: true,
    approval: {
      subject: approval.subject,
      scopes: approval.scopes,
      observedAt: approval.observedAt,
      expiresInMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS
    }
  });
}

export async function evaluateCascadeLiveReadinessFromState(
  env: Env,
  topology: EdgeTopology,
  config: GlobalRiskConfig,
  admin?: AuthenticatedAdmin
): Promise<LiveReadinessReport> {
  const [paperArmedAt, lastCascadeConfigChangeAt, readApproval, paperEvidence, backtestEvidence] =
    await Promise.all([
      env.CONFIG_STORE.get(CASCADE_PAPER_ARMED_AT_KEY),
      env.CONFIG_STORE.get(CASCADE_LAST_CONFIG_CHANGE_AT_KEY),
      readCascadeTwoPersonApproval(env),
      readCascadePaperEvidence(env, config),
      readCascadeBacktestEvidence(env)
    ]);
  const minPaperTrades = Math.max(
    1,
    Math.floor(positiveNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_TRADES, 30))
  );
  const minPaperPnlR = positiveNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_PNL_R, 10);
  const minPaperDays = positiveNumber(env.CASCADE_LIVE_READINESS_MIN_DAYS_PAPER, 30);
  const report = evaluateCascadeLiveReadiness({
    nowMs: Date.now(),
    paperArmedAt,
    minPaperDays,
    paperTradeCount: paperEvidence.tradeCount,
    minPaperTrades,
    paperPnlR: paperEvidence.pnlR,
    minPaperPnlR,
    backtestPositiveExpectancy: backtestEvidence.positiveExpectancy,
    backtestTradeCount: backtestEvidence.tradeCount,
    backtestTotalPnl: backtestEvidence.totalPnl,
    backtestReportId: backtestEvidence.reportId,
    lastCascadeConfigChangeAt,
    configFreezeHours: CASCADE_CONFIG_FREEZE_HOURS,
    readApproval,
    writeToken: admin
      ? {
          jti: admin.claims.jti,
          subject: admin.subject,
          scopes: admin.claims.scopes,
          observedAt: new Date().toISOString()
        }
      : {
          jti: "readiness-preview",
          subject: "readiness-preview",
          scopes: [],
          observedAt: new Date().toISOString()
        },
    approvalWindowMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS
  });

  return {
    ok: report.ok,
    generatedAt: new Date().toISOString(),
    checks: report.checks.map((check) => ({
      ...check,
      metadata: {
        ...check.metadata,
        topologyColo: topology.colo,
        paperPnlUsd: paperEvidence.pnlUsd,
        paperRiskUnitUsd: paperEvidence.riskUnitUsd,
        backtestGeneratedAt: backtestEvidence.generatedAt
      }
    }))
  };
}

export async function evaluateLiveReadiness(
  env: Env,
  topology: EdgeTopology,
  routeToEngine: LiveReadinessEngineRouter
): Promise<LiveReadinessReport> {
  const generatedAt = new Date().toISOString();
  const [stateResponse, paperPnl, secretDiagnostic, d1Check] = await Promise.all([
    routeToEngine(new Request("https://trading-engine.internal/state"), env, topology),
    readPaperPnlSummary(env),
    evaluateHyperliquidSecrets(env),
    measureD1Readiness(env)
  ]);
  const statePayload = await safeResponseJson(stateResponse);
  const state = isJsonRecord(statePayload?.state) ? statePayload.state : null;
  const quoteState = isJsonRecord(state?.quoteState) ? state.quoteState : null;
  const cachedConfig = isJsonRecord(state?.cachedConfig) ? state.cachedConfig : null;
  const assetMatrix = isJsonRecord(state?.assetMatrix)
    ? Object.values(state.assetMatrix).filter(isJsonRecord)
    : [];
  const selectedAssets = assetMatrix.filter((asset) => asset.selectedByMoltworker !== false);
  const quoteEligibleAssets = selectedAssets.filter(
    (asset) =>
      asset.quoteEligible === true || (asset.active === true && asset.quoteStatus !== "SUSPENDED")
  );
  const activeAssetSymbols = quoteEligibleAssets
    .map((asset) => String(asset.coin ?? asset.instrumentCode ?? "").toUpperCase())
    .filter(Boolean);
  const minPaperTrades = Math.max(
    1,
    Math.floor(positiveNumber(env.LIVE_READINESS_MIN_PAPER_TRADES, 500))
  );
  const minPaperPnlUsd = Number(env.LIVE_READINESS_MIN_PAPER_PNL_USD ?? 0);
  const paperTotals = isJsonRecord(paperPnl.totals) ? paperPnl.totals : {};
  const paperTradeCount = Number(paperTotals.tradeCount ?? 0);
  const paperNet = Number(paperTotals.cashPnl ?? 0) - Number(paperTotals.totalFees ?? 0);
  const requireSingleAsset = env.LIVE_READINESS_REQUIRE_SINGLE_ASSET !== "false";
  const allowHype = env.LIVE_READINESS_ALLOW_HYPE === "true";
  const averageLatency = Number(state?.averageLatency ?? 0);
  const latencyThreshold = Number(cachedConfig?.LATENCY_THRESHOLD_MS ?? 150);
  const checks = [
    readinessCheck(
      "shadow_mode_disabled",
      "Shadow Mode Disabled",
      env.SHADOW_MODE !== "true",
      env.SHADOW_MODE === "true"
        ? "Worker is still in SHADOW_MODE; live exchange POSTs remain disabled."
        : "Worker is allowed to submit real exchange POSTs when config permits.",
      { shadowMode: env.SHADOW_MODE ?? "false" }
    ),
    readinessCheck(
      "exchange_test_mode_disabled",
      "Exchange Test Mode Disabled",
      env.EXCHANGE_ORDER_TEST_MODE === "false",
      env.EXCHANGE_ORDER_TEST_MODE === "false"
        ? "Executioner is configured for live Hyperliquid exchange writes."
        : "EXCHANGE_ORDER_TEST_MODE is still enabled.",
      { exchangeOrderTestMode: env.EXCHANGE_ORDER_TEST_MODE ?? "true" }
    ),
    readinessCheck(
      "api_agent_secret",
      "Hyperliquid API Agent",
      secretDiagnostic.ok,
      secretDiagnostic.detail,
      secretDiagnostic.metadata
    ),
    readinessCheck(
      "paper_sample",
      "Paper Evidence",
      paperTradeCount >= minPaperTrades && paperNet >= minPaperPnlUsd,
      `${paperTradeCount} risk-capped paper fills, net ${round(paperNet, 4)} USD after modeled fees.`,
      {
        minPaperTrades,
        minPaperPnlUsd,
        tradeCount: paperTradeCount,
        paperNetUsd: round(paperNet, 8)
      }
    ),
    readinessCheck(
      "quote_health",
      "Quote Health",
      quoteState?.status === "ACTIVE" && quoteEligibleAssets.length > 0,
      quoteState?.status === "ACTIVE"
        ? `${quoteEligibleAssets.length} quote-eligible asset(s): ${activeAssetSymbols.join(", ") || "none"}.`
        : `Quotes are ${String(quoteState?.status ?? "UNKNOWN")}: ${String(quoteState?.reason ?? "no reason")}.`,
      {
        quoteState: quoteState?.status ?? null,
        quoteReason: quoteState?.reason ?? null,
        quoteEligibleAssets: activeAssetSymbols
      }
    ),
    readinessCheck(
      "single_asset_ramp",
      "Single Asset Ramp",
      !requireSingleAsset ||
        (quoteEligibleAssets.length === 1 && (allowHype || !activeAssetSymbols.includes("HYPE"))),
      requireSingleAsset
        ? "Live ramp must start with exactly one non-HYPE asset unless explicitly overridden by env."
        : "Single-asset live ramp requirement is disabled by env.",
      {
        requireSingleAsset,
        allowHype,
        activeAssetSymbols
      }
    ),
    readinessCheck(
      "latency_budget",
      "Latency Budget",
      Number.isFinite(averageLatency) && averageLatency > 0 && averageLatency <= latencyThreshold,
      `Engine average latency is ${round(averageLatency, 3)}ms against ${round(latencyThreshold, 3)}ms budget.`,
      { averageLatencyMs: averageLatency, latencyThresholdMs: latencyThreshold }
    ),
    readinessCheck("d1_latency", "D1 Audit Path", d1Check.ok, d1Check.detail, d1Check.metadata)
  ];
  if (cachedConfig?.STRATEGY_MODE === "BOTH_LIVE" || cachedConfig?.CASCADE_TAKER_ENABLED === true) {
    const cascadeChecks = await evaluateCascadeLiveReadinessFromState(env, topology, {
      ...(cachedConfig as Partial<GlobalRiskConfig>),
      updatedAt: String(cachedConfig?.updatedAt ?? new Date().toISOString()),
      updatedBy: String(cachedConfig?.updatedBy ?? "engine"),
      version: String(cachedConfig?.version ?? "unknown")
    } as GlobalRiskConfig);
    checks.push(...cascadeChecks.checks);
  }

  return {
    ok: checks.every((check) => check.ok),
    generatedAt,
    checks
  };
}

export async function readLiveReadiness(
  env: Env,
  topology: EdgeTopology,
  routeToEngine: LiveReadinessEngineRouter
): Promise<Response> {
  const report = await evaluateLiveReadiness(env, topology, routeToEngine);
  return json({ ok: report.ok, readiness: report }, report.ok ? 200 : 409);
}

async function measureD1Readiness(env: Env): Promise<LiveReadinessCheck> {
  const startedAt = performance.now();
  try {
    await env.TRADING_DB.prepare("SELECT 1 AS ok").first();
    const latencyMs = round(performance.now() - startedAt, 3);
    return readinessCheck(
      "d1_latency",
      "D1 Audit Path",
      latencyMs <= positiveNumber(env.D1_DIAGNOSTIC_MAX_LATENCY_MS, 250),
      `D1 read round-trip completed in ${latencyMs}ms.`,
      { latencyMs }
    );
  } catch (error) {
    return readinessCheck(
      "d1_latency",
      "D1 Audit Path",
      false,
      error instanceof Error ? error.message : "D1_READINESS_FAILED",
      {}
    );
  }
}

async function readCascadeBacktestEvidence(env: Env): Promise<{
  reportId: string | null;
  generatedAt: string | null;
  tradeCount: number;
  totalPnl: number;
  positiveExpectancy: boolean;
}> {
  const stored = await env.CONFIG_STORE.get<JsonRecord>(CASCADE_LAST_BACKTEST_REPORT_KEY, "json");
  if (!stored) {
    return {
      reportId: null,
      generatedAt: null,
      tradeCount: 0,
      totalPnl: 0,
      positiveExpectancy: false
    };
  }

  const tradeCount = Number(stored.tradeCount ?? 0);
  const totalPnl = Number(stored.totalPnl ?? 0);
  const validationOk = stored.validationOk === true;
  const positiveExpectancy =
    stored.positiveExpectancy === true && validationOk && tradeCount > 0 && totalPnl > 0;

  return {
    reportId: typeof stored.reportId === "string" ? stored.reportId : null,
    generatedAt: typeof stored.generatedAt === "string" ? stored.generatedAt : null,
    tradeCount: Number.isFinite(tradeCount) ? tradeCount : 0,
    totalPnl: Number.isFinite(totalPnl) ? round(totalPnl, 8) : 0,
    positiveExpectancy
  };
}

async function readCascadePaperEvidence(
  env: Env,
  config: GlobalRiskConfig
): Promise<{ tradeCount: number; pnlUsd: number; pnlR: number; riskUnitUsd: number }> {
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const timeFilterSql =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt)) ? "AND executed_at >= ?" : "";
  const row = await env.TRADING_DB.prepare(
    `SELECT
       COUNT(*) AS trade_count,
       SUM(resulting_pnl - fees) AS pnl_usd
     FROM trades
     WHERE status = 'GHOST_FILL'
       AND ${paperTradeWhereSql()}
       AND (
         primary_driver = 'PIT_BOSS'
         OR LOWER(COALESCE(raw_execution_json, '')) LIKE '%cascade%'
       )
       ${timeFilterSql}`
  )
    .bind(...(timeFilterSql ? [sessionStartedAt] : []))
    .first<{ trade_count: number | null; pnl_usd: number | null }>();
  const tradeCount = Number(row?.trade_count ?? 0);
  const pnlUsd = Number(row?.pnl_usd ?? 0);
  const bankroll = positiveNumber(env.PAPER_BANKROLL_USD, 5_000);
  const riskPerTradePct = Number.isFinite(Number(config.RISK_PER_TRADE_PCT))
    ? Number(config.RISK_PER_TRADE_PCT)
    : 0.005;
  const riskUnitUsd = Math.max(1, bankroll * Math.max(0.0001, riskPerTradePct));

  return {
    tradeCount,
    pnlUsd: round(pnlUsd, 8),
    pnlR: round(pnlUsd / riskUnitUsd, 8),
    riskUnitUsd: round(riskUnitUsd, 8)
  };
}

async function readCascadeTwoPersonApproval(env: Env): Promise<TwoPersonApproval | null> {
  const stored = await env.CONFIG_STORE.get<TwoPersonApproval>(
    CASCADE_TWO_PERSON_READ_APPROVAL_KEY,
    "json"
  );

  if (
    !stored ||
    typeof stored.jti !== "string" ||
    typeof stored.subject !== "string" ||
    !Array.isArray(stored.scopes) ||
    typeof stored.observedAt !== "string"
  ) {
    return null;
  }

  return stored;
}

function readinessCheck(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  metadata: JsonRecord = {}
): LiveReadinessCheck {
  return { id, label, ok, detail, metadata };
}

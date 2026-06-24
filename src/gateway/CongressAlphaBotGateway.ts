import { Logger } from "../Logger";
import type { AuthenticatedAdmin } from "./AdminModels";
import { json, readJsonBody } from "./ResponseHelpers";
import { sourceIp } from "./SecurityAudit";
import type { EdgeTopology, Env, JsonRecord } from "../types";
import {
  DEFAULT_BANKROLL_USD,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MAX_POSITIONS,
  DEFAULT_MAX_WEIGHT_PCT,
  DEFAULT_MIN_SCORE,
  DEFAULT_SCHEDULER_TIMEZONE,
  PAPER_MODE,
  SETTINGS_KEY,
  STORED_SIGNAL_LIMIT,
  clampPositive,
  emptyD1Result,
  envNumber,
  errorMessage,
  nonNegative,
  parseJsonRecord,
  round
} from "./congressAlpha/Common";
import {
  type AlphaDirection,
  type CongressAlphaSignal,
  type CongressAlphaTarget,
  buildCongressAlphaTargets,
  scoreCongressAlphaCandidate
} from "./congressAlpha/Scoring";
import {
  type CongressAlphaPaperOrder,
  type CongressAlphaPaperPlan,
  type CongressAlphaPositionPlan,
  type CongressAlphaPositionRow,
  planCongressAlphaPaperOrders
} from "./congressAlpha/Planning";
import {
  type CongressAlphaRunOptions,
  type CongressAlphaSettings,
  normalizeAlphaSettings
} from "./congressAlpha/Settings";
import { buildSchedulerStatus, localTimeParts } from "./congressAlpha/Scheduler";

export { buildCongressAlphaTargets, scoreCongressAlphaCandidate } from "./congressAlpha/Scoring";
export { planCongressAlphaPaperOrders } from "./congressAlpha/Planning";
export { buildSchedulerStatus } from "./congressAlpha/Scheduler";

interface CongressAlphaCandidateRow {
  symbol: string;
  sector: string | null;
  transaction_count: number;
  purchase_count: number;
  sale_count: number;
  purchase_amount_mid: number | null;
  sale_amount_mid: number | null;
  net_amount_mid: number | null;
  member_count: number;
  latest_trade_at: string | null;
  current_price: number | null;
  average_return_pct: number | null;
  democratic_purchase_count: number;
  republican_purchase_count: number;
}

interface CongressAlphaConflictRow {
  symbol: string;
  conflict_count: number;
}

interface CongressAlphaCommitteeExposureRow {
  committee_code: string;
  committee_name: string;
  sector: string;
  conflict_count: number;
  member_count: number;
}

interface CongressAlphaRunRequest {
  bankroll?: number;
  maxPositions?: number;
  minScore?: number;
  maxWeightPct?: number;
  lookbackDays?: number;
  reason?: string;
}

interface CongressAlphaSettingsRequest extends CongressAlphaRunRequest {
  autoRunEnabled?: boolean;
}

interface CongressAlphaRunRow {
  run_id: string;
  status: string;
  mode: string;
  bankroll: number;
  max_positions: number;
  min_score: number;
  generated_signals: number;
  target_count: number;
  order_count: number;
  created_by: string | null;
  error_message: string | null;
  max_weight_pct?: number | null;
  lookback_days?: number | null;
  config_json?: string | null;
  enrichment_json?: string | null;
  backtest_json?: string | null;
  created_at: string;
  completed_at: string | null;
}

interface CongressAlphaSettingsRow {
  config_json: string;
  updated_by: string | null;
  updated_at: string;
}

interface CongressAlphaEnrichmentRow {
  symbol: string;
  company_name: string | null;
  cik: string | null;
  sic: string | null;
  sic_description: string | null;
  sector: string | null;
  latest_news_json: string | null;
  fundamentals_json: string | null;
  source_json: string;
  enriched_at: string;
}

interface CongressAlphaBacktestRow {
  backtest_id: string;
  config_json: string;
  result_json: string;
  created_by: string | null;
  created_at: string;
}

export interface CongressAlphaLatestRun {
  runId: string;
  status: string;
  mode: string;
  bankroll: number;
  maxPositions: number;
  minScore: number;
  generatedSignals: number;
  targetCount: number;
  orderCount: number;
  createdBy: string | null;
  errorMessage: string | null;
  maxWeightPct?: number | null;
  lookbackDays?: number | null;
  config?: JsonRecord;
  enrichment?: JsonRecord;
  backtest?: JsonRecord;
  createdAt: string;
  completedAt: string | null;
}

interface CongressAlphaSignalRow {
  signal_id: string;
  run_id: string;
  symbol: string;
  sector: string | null;
  as_of: string;
  score: number;
  confidence: number;
  direction: AlphaDirection;
  horizon_days: number;
  latest_trade_at: string | null;
  current_price: number | null;
  net_amount_mid: number;
  purchase_amount_mid: number;
  sale_amount_mid: number;
  transaction_count: number;
  purchase_count: number;
  sale_count: number;
  member_count: number;
  conflict_count: number;
  bipartisan_score: number;
  freshness_penalty: number;
  rationale_json: string;
  created_at: string;
}

interface CongressAlphaTargetRow {
  target_id: string;
  run_id: string;
  signal_id: string;
  symbol: string;
  sector: string | null;
  reference_price: number | null;
  target_weight_pct: number;
  target_notional: number;
  score: number;
  confidence: number;
  reason: string;
  created_at: string;
}

interface CongressAlphaOrderRow {
  order_id: string;
  run_id: string;
  signal_id: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  limit_price: number;
  notional: number;
  status: "PAPER_FILLED";
  reason: string;
  created_at: string;
}

export async function readCongressAlphaBot(env: Env): Promise<Response> {
  if (!isCongressAlphaEnabled(env)) {
    return json({
      ok: false,
      mode: PAPER_MODE,
      error: "Congress Alpha paper bot is disabled by CONGRESS_ALPHA_ENABLED.",
      guardrails: ["Set CONGRESS_ALPHA_ENABLED=true to allow paper-bot reads and runs."]
    });
  }

  const db = congressDb(env);

  try {
    const settings = await loadAlphaSettings(env, db);
    const latestRun = await db
      .prepare(`SELECT * FROM congress_alpha_runs ORDER BY created_at DESC LIMIT 1`)
      .first<CongressAlphaRunRow>();
    const runId = latestRun?.run_id ?? null;
    const [signals, targets, orders, positions] = await Promise.all([
      runId
        ? db
            .prepare(
              `SELECT * FROM congress_alpha_signals
                WHERE run_id = ?
                ORDER BY score DESC, created_at DESC
                LIMIT 50`
            )
            .bind(runId)
            .all<CongressAlphaSignalRow>()
        : emptyD1Result<CongressAlphaSignalRow>(),
      runId
        ? db
            .prepare(
              `SELECT * FROM congress_alpha_targets
                WHERE run_id = ?
                ORDER BY target_weight_pct DESC, created_at DESC
                LIMIT 30`
            )
            .bind(runId)
            .all<CongressAlphaTargetRow>()
        : emptyD1Result<CongressAlphaTargetRow>(),
      runId
        ? db
            .prepare(
              `SELECT * FROM congress_alpha_paper_orders
                WHERE run_id = ?
                ORDER BY created_at DESC
                LIMIT 50`
            )
            .bind(runId)
            .all<CongressAlphaOrderRow>()
        : emptyD1Result<CongressAlphaOrderRow>(),
      db
        .prepare(`SELECT * FROM congress_alpha_paper_positions ORDER BY market_value DESC`)
        .all<CongressAlphaPositionRow>()
    ]);
    const [enrichments, latestBacktest, latestScheduledRun] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM congress_alpha_company_enrichment
             ORDER BY enriched_at DESC
             LIMIT 25`
        )
        .all<CongressAlphaEnrichmentRow>()
        .catch(() => emptyD1Result<CongressAlphaEnrichmentRow>()),
      db
        .prepare(`SELECT * FROM congress_alpha_backtests ORDER BY created_at DESC LIMIT 1`)
        .first<CongressAlphaBacktestRow>()
        .catch(() => null),
      db
        .prepare(
          `SELECT created_at FROM congress_alpha_runs
            WHERE created_by = 'system:cron'
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .first<{ created_at: string }>()
        .catch(() => null)
    ]);
    const positionRows = positions.results ?? [];
    const invested = positionRows.reduce((sum, row) => sum + nonNegative(row.market_value), 0);
    const unrealizedPnl = positionRows.reduce(
      (sum, row) => sum + Number(row.unrealized_pnl ?? 0),
      0
    );
    const bankroll =
      latestRun?.bankroll ?? envNumber(env.CONGRESS_ALPHA_BANKROLL_USD, DEFAULT_BANKROLL_USD);
    const cash = round(Math.max(0, bankroll - invested), 2);
    const latestRunFailed = latestRun?.status === "FAILED";

    return json({
      ok: !latestRunFailed,
      mode: PAPER_MODE,
      generatedAt: new Date().toISOString(),
      error: latestRunFailed
        ? (latestRun?.error_message ?? "Latest Congress Alpha run failed.")
        : undefined,
      summary: {
        latestRunId: latestRun?.run_id ?? null,
        latestRunStatus: latestRun?.status ?? "PENDING",
        bankroll,
        invested: round(invested, 2),
        cash,
        equity: round(cash + invested, 2),
        unrealizedPnl: round(unrealizedPnl, 2),
        signalCount: signals.results?.length ?? 0,
        targetCount: targets.results?.length ?? 0,
        orderCount: orders.results?.length ?? 0,
        positionCount: positionRows.length
      },
      settings,
      scheduler: buildSchedulerStatus({
        autoRunEnabled: settings.autoRunEnabled,
        timezone: env.CONGRESS_SCHEDULER_TIMEZONE ?? DEFAULT_SCHEDULER_TIMEZONE,
        lastScheduledRunAt: latestScheduledRun?.created_at ?? null
      }),
      enrichment: {
        count: enrichments.results?.length ?? 0,
        latest: (enrichments.results ?? []).map(formatEnrichmentRow)
      },
      backtest: latestBacktest ? formatBacktestRow(latestBacktest) : null,
      latestRun: latestRun ? formatRunRow(latestRun) : null,
      signals: (signals.results ?? []).map(formatSignalRow),
      targets: (targets.results ?? []).map(formatTargetRow),
      orders: (orders.results ?? []).map(formatOrderRow),
      positions: positionRows.map(formatPositionRow),
      guardrails: [
        "Paper-only: no broker or crypto ExecutionerWorker route is called.",
        "Signals exclude unresolved/N/A symbols and stale malformed future dates.",
        "Disclosed amount bands use midpoint approximations."
      ]
    });
  } catch (caught: unknown) {
    return json(
      {
        ok: false,
        mode: PAPER_MODE,
        error: errorMessage(caught),
        hint: "Apply migrations/011_congress_alpha_bot.sql to enable the Congress Alpha paper bot."
      },
      503
    );
  }
}

export async function runCongressAlphaBot(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  auth: AuthenticatedAdmin
): Promise<Response> {
  if (!isCongressAlphaEnabled(env)) {
    return json(
      {
        ok: false,
        mode: PAPER_MODE,
        error: "Congress Alpha paper bot is disabled by CONGRESS_ALPHA_ENABLED."
      },
      403
    );
  }

  const db = congressDb(env);
  const payload = (await readJsonBody<CongressAlphaRunRequest>(request)) ?? {};
  const savedSettings = await loadAlphaSettings(env, db);
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const options: CongressAlphaRunOptions = {
    bankroll: clampPositive(payload.bankroll, savedSettings.bankroll, 100, 10_000_000),
    maxPositions: Math.floor(
      clampPositive(payload.maxPositions, savedSettings.maxPositions, 1, 50)
    ),
    minScore: clampPositive(payload.minScore, savedSettings.minScore, 1, 100),
    maxWeightPct: clampPositive(payload.maxWeightPct, savedSettings.maxWeightPct, 1, 50),
    lookbackDays: Math.floor(
      clampPositive(payload.lookbackDays, savedSettings.lookbackDays, 1, 730)
    )
  };

  try {
    const candidates = await loadSignalCandidates(db, options.lookbackDays);
    const conflicts = await loadConflictCounts(db);
    const signals = candidates
      .map((candidate) =>
        buildSignalFromCandidate(candidate, conflicts.get(candidate.symbol) ?? 0, runId, now)
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, STORED_SIGNAL_LIMIT);
    const targets = buildCongressAlphaTargets(signals, options);
    const existingRows = await db
      .prepare(`SELECT * FROM congress_alpha_paper_positions`)
      .all<CongressAlphaPositionRow>();
    const plan = planCongressAlphaPaperOrders(existingRows.results ?? [], runId, targets);

    await db.batch(
      runCommitStatements(db, {
        runId,
        now,
        auth,
        options,
        signals,
        targets,
        orders: plan.orders,
        upserts: plan.upserts,
        deletes: plan.deletes
      })
    );

    logger.info("CONGRESS_ALPHA_PAPER_RUN", "Congress Alpha paper rebalance completed", {
      eventType: "CONGRESS_ALPHA_PAPER_RUN",
      runId,
      actor: auth.subject,
      sourceIp: sourceIp(request),
      colo: topology.colo,
      generatedSignals: signals.length,
      targets: targets.length,
      paperOrders: plan.orders.length,
      reason: payload.reason ?? "manual"
    });

    return json({
      ok: true,
      mode: PAPER_MODE,
      runId,
      generatedAt: new Date().toISOString(),
      summary: {
        bankroll: options.bankroll,
        maxPositions: options.maxPositions,
        minScore: options.minScore,
        signalCount: signals.length,
        targetCount: targets.length,
        orderCount: plan.orders.length
      },
      signals: signals.slice(0, 25),
      targets,
      orders: plan.orders,
      guardrails: [
        "Paper-only run completed. No live brokerage or exchange route was called.",
        "Review disclosures, conflicts, and price marks before considering any future execution adapter."
      ]
    });
  } catch (caught: unknown) {
    const message = errorMessage(caught);
    await failedRunStatement(db, {
      runId,
      now,
      completedAt: new Date().toISOString(),
      auth,
      options,
      errorMessage: message
    })
      .run()
      .catch(() => undefined);
    logger.error("CONGRESS_ALPHA_PAPER_RUN_FAILED", "Congress Alpha paper rebalance failed", {
      eventType: "CONGRESS_ALPHA_PAPER_RUN_FAILED",
      runId,
      actor: auth.subject,
      sourceIp: sourceIp(request),
      error: message
    });
    return json({ ok: false, mode: PAPER_MODE, error: message }, 500);
  }
}

export async function updateCongressAlphaSettings(
  request: Request,
  env: Env,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const db = congressDb(env);
  const payload = (await readJsonBody<CongressAlphaSettingsRequest>(request)) ?? {};
  const current = await loadAlphaSettings(env, db);
  const settings = normalizeAlphaSettings({
    bankroll: payload.bankroll ?? current.bankroll,
    maxPositions: payload.maxPositions ?? current.maxPositions,
    minScore: payload.minScore ?? current.minScore,
    maxWeightPct: payload.maxWeightPct ?? current.maxWeightPct,
    lookbackDays: payload.lookbackDays ?? current.lookbackDays,
    autoRunEnabled: payload.autoRunEnabled ?? current.autoRunEnabled
  });

  await db
    .prepare(
      `INSERT INTO congress_alpha_settings (key, config_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         config_json = excluded.config_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind(SETTINGS_KEY, JSON.stringify(settings), auth.subject, new Date().toISOString())
    .run();

  return json({ ok: true, settings });
}

export async function enrichCongressAlphaUniverse(
  env: Env,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const db = congressDb(env);
  const symbols = await db
    .prepare(
      `SELECT DISTINCT UPPER(symbol) AS symbol
         FROM congress_alpha_targets
        WHERE symbol IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 25`
    )
    .all<{ symbol: string }>();
  const universe = (symbols.results ?? []).map((row) => row.symbol).filter(Boolean);
  const secMap = await loadSecTickerMap();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  for (const symbol of universe) {
    const sec = secMap.get(symbol);
    const news = await loadFinnhubNews(env, symbol);
    const fundamentals = await loadFinnhubFundamentals(env, symbol);
    const committeeExposure = await loadCommitteeExposure(db, symbol);
    statements.push(
      db
        .prepare(
          `INSERT INTO congress_alpha_company_enrichment
            (symbol, company_name, cik, sic, sic_description, sector, latest_news_json, fundamentals_json, source_json, enriched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             company_name = excluded.company_name,
             cik = excluded.cik,
             sic = excluded.sic,
             sic_description = excluded.sic_description,
             sector = excluded.sector,
             latest_news_json = excluded.latest_news_json,
             fundamentals_json = excluded.fundamentals_json,
             source_json = excluded.source_json,
             enriched_at = excluded.enriched_at`
        )
        .bind(
          symbol,
          sec?.title ?? null,
          sec?.cik_str ? String(sec.cik_str).padStart(10, "0") : null,
          null,
          null,
          null,
          JSON.stringify(news),
          JSON.stringify(fundamentals),
          JSON.stringify({
            sec: Boolean(sec),
            finnhubNews: news.status,
            finnhubFundamentals: fundamentals.status,
            congressCommitteeExposure: committeeExposure,
            congressGovConfigured: Boolean(env.CONGRESS_GOV_API_KEY),
            actor: auth.subject
          }),
          now
        )
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return json({
    ok: true,
    enriched: statements.length,
    sources: {
      sec: "company_tickers.json",
      finnhub: Boolean(env.FINNHUB_API_KEY),
      congressGov: Boolean(env.CONGRESS_GOV_API_KEY)
    }
  });
}

export async function runCongressAlphaBacktest(
  env: Env,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const db = congressDb(env);
  const settings = await loadAlphaSettings(env, db);
  const candidates = await loadSignalCandidates(db, settings.lookbackDays);
  const conflicts = await loadConflictCounts(db);
  const asOf = new Date().toISOString();
  const signals = candidates
    .map((candidate) =>
      buildSignalFromCandidate(candidate, conflicts.get(candidate.symbol) ?? 0, "backtest", asOf)
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, settings.maxPositions);
  const realizedReturnBySymbol = new Map(
    candidates.map((candidate) => [
      candidate.symbol,
      typeof candidate.average_return_pct === "number" ? candidate.average_return_pct : null
    ])
  );
  const realizedSignals = signals
    .map((signal) => ({
      signal,
      realizedReturnPct: realizedReturnBySymbol.get(signal.symbol) ?? null
    }))
    .filter(
      (item): item is { signal: CongressAlphaSignal; realizedReturnPct: number } =>
        typeof item.realizedReturnPct === "number" && Number.isFinite(item.realizedReturnPct)
    );
  const wins = realizedSignals.filter((item) => item.realizedReturnPct > 0).length;
  const averageScore =
    signals.length > 0
      ? round(signals.reduce((sum, signal) => sum + signal.score, 0) / signals.length, 2)
      : 0;
  const weightSum = realizedSignals.reduce((sum, item) => sum + Math.max(1, item.signal.score), 0);
  const weightedReturnPct =
    weightSum > 0
      ? round(
          realizedSignals.reduce(
            (sum, item) => sum + item.realizedReturnPct * Math.max(1, item.signal.score),
            0
          ) / weightSum,
          4
        )
      : null;
  const unweightedReturnPct =
    realizedSignals.length > 0
      ? round(
          realizedSignals.reduce((sum, item) => sum + item.realizedReturnPct, 0) /
            realizedSignals.length,
          4
        )
      : null;
  const benchmark = await loadCongressAlphaBacktestBenchmark(db, settings.lookbackDays);
  const benchmarkAverage =
    typeof benchmark.averageMarkedPurchaseReturnPct === "number"
      ? benchmark.averageMarkedPurchaseReturnPct
      : null;
  const result = {
    windowDays: settings.lookbackDays,
    testedSignals: signals.length,
    markedSignals: realizedSignals.length,
    averageScore,
    realizedHitRate: realizedSignals.length > 0 ? round(wins / realizedSignals.length, 4) : null,
    unweightedReturnPct,
    weightedReturnPct,
    benchmark,
    alphaVsMarkedCongressPct:
      weightedReturnPct !== null && benchmarkAverage !== null
        ? round(weightedReturnPct - benchmarkAverage, 4)
        : null,
    topSymbols: signals.slice(0, 10).map((signal) => ({
      symbol: signal.symbol,
      score: signal.score,
      confidence: signal.confidence,
      realizedReturnPct: realizedReturnBySymbol.get(signal.symbol) ?? null,
      purchases: signal.purchaseCount,
      conflicts: signal.conflictCount
    })),
    caveat:
      "Disclosure backtest uses available marked PTR rows and current price marks. Unmarked rows are excluded from realized-return metrics, and this is not a broker-grade execution simulation."
  };
  const backtestId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO congress_alpha_backtests
        (backtest_id, config_json, result_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(backtestId, JSON.stringify(settings), JSON.stringify(result), auth.subject, asOf)
    .run();

  return json({ ok: true, backtestId, settings, result });
}

export async function handleCongressAlphaScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  topology: EdgeTopology
): Promise<void> {
  const db = congressDb(env);
  const settings = await loadAlphaSettings(env, db);

  if (!settings.autoRunEnabled) {
    return;
  }

  const scheduledAt = new Date(controller.scheduledTime);
  const timezone = env.CONGRESS_SCHEDULER_TIMEZONE ?? "America/Chicago";
  const local = localTimeParts(scheduledAt, timezone);

  if (local.hour !== "00" || local.minute !== "00") {
    return;
  }

  const key = `congress-alpha:daily-run:${timezone}:${local.date}`;
  const existing = await env.CONFIG_STORE.get(key);

  if (existing) {
    return;
  }

  await env.CONFIG_STORE.put(key, new Date().toISOString(), { expirationTtl: 3 * 24 * 60 * 60 });
  const request = new Request("https://api.yevow.co/admin/congress/alpha/run", {
    method: "POST",
    body: JSON.stringify({ reason: "scheduled-alpha-rebalance" })
  });
  const auth: AuthenticatedAdmin = {
    subject: "system:cron",
    claims: {
      sub: "system:cron",
      scopes: ["READ", "WRITE"],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `cron:${controller.scheduledTime}`
    }
  };

  ctx.waitUntil(runCongressAlphaBot(request, env, logger, topology, auth).then(() => undefined));
}

function isCongressAlphaEnabled(env: Env): boolean {
  return String(env.CONGRESS_ALPHA_ENABLED ?? "true").toLowerCase() !== "false";
}

async function loadAlphaSettings(
  env: Env,
  db: D1Database
): Promise<CongressAlphaSettings> {
  const fallback = normalizeAlphaSettings({
    bankroll: envNumber(env.CONGRESS_ALPHA_BANKROLL_USD, DEFAULT_BANKROLL_USD),
    maxPositions: envNumber(env.CONGRESS_ALPHA_MAX_POSITIONS, DEFAULT_MAX_POSITIONS),
    minScore: envNumber(env.CONGRESS_ALPHA_MIN_SCORE, DEFAULT_MIN_SCORE),
    maxWeightPct: envNumber(env.CONGRESS_ALPHA_MAX_WEIGHT_PCT, DEFAULT_MAX_WEIGHT_PCT),
    lookbackDays: envNumber(env.CONGRESS_ALPHA_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS),
    autoRunEnabled: String(env.CONGRESS_ALPHA_AUTO_RUN_ENABLED ?? "true").toLowerCase() !== "false"
  });
  const row = await db
    .prepare(`SELECT config_json FROM congress_alpha_settings WHERE key = ?`)
    .bind(SETTINGS_KEY)
    .first<CongressAlphaSettingsRow>()
    .catch(() => null);

  if (!row?.config_json) {
    return fallback;
  }

  return normalizeAlphaSettings({ ...fallback, ...parseJsonRecord(row.config_json) });
}
function formatRunRow(row: CongressAlphaRunRow): CongressAlphaLatestRun {
  return {
    runId: row.run_id,
    status: row.status,
    mode: row.mode,
    bankroll: row.bankroll,
    maxPositions: row.max_positions,
    minScore: row.min_score,
    generatedSignals: row.generated_signals,
    targetCount: row.target_count,
    orderCount: row.order_count,
    createdBy: row.created_by,
    errorMessage: row.error_message,
    maxWeightPct: row.max_weight_pct ?? null,
    lookbackDays: row.lookback_days ?? null,
    config: parseJsonRecord(row.config_json ?? null),
    enrichment: parseJsonRecord(row.enrichment_json ?? null),
    backtest: parseJsonRecord(row.backtest_json ?? null),
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function formatEnrichmentRow(row: CongressAlphaEnrichmentRow): JsonRecord {
  return {
    symbol: row.symbol,
    companyName: row.company_name,
    cik: row.cik,
    sic: row.sic,
    sicDescription: row.sic_description,
    sector: row.sector,
    latestNews: parseJsonRecord(row.latest_news_json),
    fundamentals: parseJsonRecord(row.fundamentals_json),
    sources: parseJsonRecord(row.source_json),
    enrichedAt: row.enriched_at
  };
}

function formatBacktestRow(row: CongressAlphaBacktestRow): JsonRecord {
  return {
    backtestId: row.backtest_id,
    config: parseJsonRecord(row.config_json),
    result: parseJsonRecord(row.result_json),
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

async function loadSecTickerMap(): Promise<
  Map<string, { cik_str: number; ticker: string; title: string }>
> {
  try {
    const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: {
        "user-agent": "Sovereign-Sigma/1.0 admin@yevow.co",
        accept: "application/json"
      }
    });

    if (!response.ok) {
      return new Map();
    }

    const payload = (await response.json()) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    return new Map(Object.values(payload).map((entry) => [entry.ticker.toUpperCase(), entry]));
  } catch {
    return new Map();
  }
}

async function loadFinnhubNews(env: Env, symbol: string): Promise<JsonRecord> {
  if (!env.FINNHUB_API_KEY) {
    return { status: "not_configured" };
  }

  const to = new Date();
  const from = new Date(Date.now() - 14 * 86_400_000);
  const url = new URL("https://finnhub.io/api/v1/company-news");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("from", from.toISOString().slice(0, 10));
  url.searchParams.set("to", to.toISOString().slice(0, 10));
  url.searchParams.set("token", env.FINNHUB_API_KEY);

  try {
    const response = await fetch(url);
    const payload = response.ok ? ((await response.json()) as unknown[]) : [];
    return {
      status: response.ok ? "ok" : `http_${response.status}`,
      count: Array.isArray(payload) ? payload.length : 0,
      sample: Array.isArray(payload)
        ? payload.slice(0, 3).map((item) => sanitizeNewsItem(item))
        : []
    };
  } catch (caught: unknown) {
    return { status: "error", error: errorMessage(caught) };
  }
}

function sanitizeNewsItem(item: unknown): JsonRecord {
  if (!item || typeof item !== "object") {
    return {};
  }

  const record = item as Record<string, unknown>;
  return {
    headline: String(record.headline ?? ""),
    datetime: typeof record.datetime === "number" ? record.datetime : null,
    url: String(record.url ?? ""),
    source: String(record.source ?? "")
  };
}

async function loadFinnhubFundamentals(env: Env, symbol: string): Promise<JsonRecord> {
  if (!env.FINNHUB_API_KEY) {
    return { status: "not_configured" };
  }

  const url = new URL("https://finnhub.io/api/v1/stock/metric");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("metric", "all");
  url.searchParams.set("token", env.FINNHUB_API_KEY);

  try {
    const response = await fetch(url);
    const payload = response.ok ? ((await response.json()) as JsonRecord) : {};
    return {
      status: response.ok ? "ok" : `http_${response.status}`,
      metric: payload.metric ?? null
    };
  } catch (caught: unknown) {
    return { status: "error", error: errorMessage(caught) };
  }
}

async function loadCommitteeExposure(db: D1Database, symbol: string): Promise<JsonRecord> {
  const rows = await db
    .prepare(
      `SELECT
         f.committee_code,
         f.committee_name,
         f.sector,
         COUNT(*) AS conflict_count,
         COUNT(DISTINCT COALESCE(t.member_key, t.member_name)) AS member_count
       FROM congress_conflict_flags f
       JOIN congress_transactions t ON t.transaction_id = f.transaction_id
       WHERE UPPER(t.symbol) = UPPER(?)
       GROUP BY f.committee_code, f.committee_name, f.sector
       ORDER BY conflict_count DESC, member_count DESC
       LIMIT 8`
    )
    .bind(symbol)
    .all<CongressAlphaCommitteeExposureRow>()
    .catch(() => emptyD1Result<CongressAlphaCommitteeExposureRow>());

  return {
    status: "ok",
    symbol,
    topCommittees: (rows.results ?? []).map((row) => ({
      committeeCode: row.committee_code,
      committeeName: row.committee_name,
      sector: row.sector,
      conflictCount: Number(row.conflict_count ?? 0),
      memberCount: Number(row.member_count ?? 0)
    }))
  };
}

async function loadSignalCandidates(
  db: D1Database,
  lookbackDays: number
): Promise<CongressAlphaCandidateRow[]> {
  const start = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const rows = await db
    .prepare(
      `SELECT
         UPPER(symbol) AS symbol,
         COALESCE(security_sector, 'UNRESOLVED') AS sector,
         COUNT(*) AS transaction_count,
         SUM(CASE WHEN transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED') THEN 1 ELSE 0 END) AS purchase_count,
         SUM(CASE WHEN transaction_type IN ('S', 'SELL', 'SALE', 'SOLD') THEN 1 ELSE 0 END) AS sale_count,
         SUM(CASE WHEN transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED') THEN COALESCE(amount_mid, 0) ELSE 0 END) AS purchase_amount_mid,
         SUM(CASE WHEN transaction_type IN ('S', 'SELL', 'SALE', 'SOLD') THEN COALESCE(amount_mid, 0) ELSE 0 END) AS sale_amount_mid,
         SUM(CASE
               WHEN transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED') THEN COALESCE(amount_mid, 0)
               WHEN transaction_type IN ('S', 'SELL', 'SALE', 'SOLD') THEN -COALESCE(amount_mid, 0)
               ELSE 0
             END) AS net_amount_mid,
         COUNT(DISTINCT COALESCE(member_key, member_name)) AS member_count,
         MAX(datetime(COALESCE(transaction_date, created_at))) AS latest_trade_at,
         MAX(current_price) AS current_price,
         AVG(return_pct) AS average_return_pct,
         SUM(CASE WHEN member_party = 'D' AND transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED') THEN 1 ELSE 0 END) AS democratic_purchase_count,
         SUM(CASE WHEN member_party = 'R' AND transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED') THEN 1 ELSE 0 END) AS republican_purchase_count
       FROM congress_transactions
       WHERE symbol IS NOT NULL
         AND TRIM(symbol) != ''
         AND UPPER(symbol) NOT IN ('N/A', 'NA', 'UNRESOLVED', 'NONE')
         AND transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED', 'S', 'SELL', 'SALE', 'SOLD', 'EXCHANGE')
         AND datetime(COALESCE(transaction_date, created_at)) BETWEEN datetime(?) AND datetime(?)
       GROUP BY UPPER(symbol), COALESCE(security_sector, 'UNRESOLVED')
       HAVING purchase_count > 0
       ORDER BY purchase_amount_mid DESC
       LIMIT 250`
    )
    .bind(start, new Date().toISOString())
    .all<CongressAlphaCandidateRow>();

  return rows.results ?? [];
}

async function loadConflictCounts(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT UPPER(t.symbol) AS symbol, COUNT(*) AS conflict_count
         FROM congress_conflict_flags f
         JOIN congress_transactions t ON t.transaction_id = f.transaction_id
        WHERE t.symbol IS NOT NULL
        GROUP BY UPPER(t.symbol)`
    )
    .all<CongressAlphaConflictRow>();
  return new Map((rows.results ?? []).map((row) => [row.symbol, row.conflict_count]));
}

async function loadCongressAlphaBacktestBenchmark(
  db: D1Database,
  lookbackDays: number
): Promise<JsonRecord> {
  const start = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS marked_rows,
         AVG(return_pct) AS average_marked_purchase_return_pct,
         SUM(CASE WHEN return_pct > 0 THEN 1 ELSE 0 END) AS positive_rows
       FROM congress_transactions
       WHERE symbol IS NOT NULL
         AND UPPER(symbol) NOT IN ('N/A', 'NA', 'UNRESOLVED', 'NONE')
         AND transaction_type IN ('P', 'BUY', 'PURCHASE', 'PURCHASED')
         AND return_pct IS NOT NULL
         AND datetime(COALESCE(transaction_date, created_at)) BETWEEN datetime(?) AND datetime(?)`
    )
    .bind(start, new Date().toISOString())
    .first<{
      marked_rows: number;
      average_marked_purchase_return_pct: number | null;
      positive_rows: number;
    }>()
    .catch(() => null);
  const markedRows = Number(row?.marked_rows ?? 0);
  const positiveRows = Number(row?.positive_rows ?? 0);

  return {
    markedPurchaseRows: markedRows,
    averageMarkedPurchaseReturnPct:
      typeof row?.average_marked_purchase_return_pct === "number"
        ? round(row.average_marked_purchase_return_pct, 4)
        : null,
    markedPurchaseHitRate: markedRows > 0 ? round(positiveRows / markedRows, 4) : null
  };
}

function buildSignalFromCandidate(
  candidate: CongressAlphaCandidateRow,
  conflictCount: number,
  runId: string,
  asOf: string
): CongressAlphaSignal {
  const purchaseAmountMid = nonNegative(candidate.purchase_amount_mid);
  const saleAmountMid = nonNegative(candidate.sale_amount_mid);
  const netAmountMid = Number(candidate.net_amount_mid ?? purchaseAmountMid - saleAmountMid);
  const score = scoreCongressAlphaCandidate({
    transactionCount: Number(candidate.transaction_count ?? 0),
    purchaseCount: Number(candidate.purchase_count ?? 0),
    saleCount: Number(candidate.sale_count ?? 0),
    purchaseAmountMid,
    saleAmountMid,
    netAmountMid,
    memberCount: Number(candidate.member_count ?? 0),
    conflictCount,
    democraticPurchaseCount: Number(candidate.democratic_purchase_count ?? 0),
    republicanPurchaseCount: Number(candidate.republican_purchase_count ?? 0),
    latestTradeAt: candidate.latest_trade_at,
    asOf
  });

  return {
    signalId: crypto.randomUUID(),
    runId,
    symbol: candidate.symbol,
    sector: candidate.sector ?? "UNRESOLVED",
    asOf,
    score: score.score,
    confidence: score.confidence,
    direction: score.direction,
    horizonDays: 90,
    latestTradeAt: candidate.latest_trade_at,
    currentPrice:
      typeof candidate.current_price === "number" && candidate.current_price > 0
        ? candidate.current_price
        : null,
    netAmountMid,
    purchaseAmountMid,
    saleAmountMid,
    transactionCount: Number(candidate.transaction_count ?? 0),
    purchaseCount: Number(candidate.purchase_count ?? 0),
    saleCount: Number(candidate.sale_count ?? 0),
    memberCount: Number(candidate.member_count ?? 0),
    conflictCount,
    bipartisanScore: score.bipartisanScore,
    freshnessPenalty: score.freshnessPenalty,
    rationale: score.rationale
  };
}

function runCommitStatements(
  db: D1Database,
  input: {
    runId: string;
    now: string;
    auth: AuthenticatedAdmin;
    options: CongressAlphaRunOptions;
    signals: CongressAlphaSignal[];
    targets: CongressAlphaTarget[];
    orders: CongressAlphaPaperOrder[];
    upserts: CongressAlphaPositionPlan[];
    deletes: string[];
  }
): D1PreparedStatement[] {
  return [
    insertRunStatement(db, input),
    ...input.signals.map((signal) => insertSignalStatement(db, signal)),
    ...input.targets.map((target) => insertTargetStatement(db, target)),
    ...input.orders.map((order) => insertOrderStatement(db, order)),
    ...input.upserts.map((position) => upsertPositionStatement(db, position, input.now)),
    ...input.deletes.map((symbol) => deletePositionStatement(db, symbol)),
    completeRunStatement(db, input)
  ];
}

function insertRunStatement(
  db: D1Database,
  input: {
    runId: string;
    now: string;
    auth: AuthenticatedAdmin;
    options: CongressAlphaRunOptions;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO congress_alpha_runs
        (run_id, status, mode, bankroll, max_positions, min_score, max_weight_pct, lookback_days, config_json, created_by, created_at)
       VALUES (?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.runId,
      PAPER_MODE,
      input.options.bankroll,
      input.options.maxPositions,
      input.options.minScore,
      input.options.maxWeightPct,
      input.options.lookbackDays,
      JSON.stringify(input.options),
      input.auth.subject,
      input.now
    );
}

function completeRunStatement(
  db: D1Database,
  input: {
    runId: string;
    signals: CongressAlphaSignal[];
    targets: CongressAlphaTarget[];
    orders: CongressAlphaPaperOrder[];
  }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE congress_alpha_runs
          SET status = 'COMPLETED',
              generated_signals = ?,
              target_count = ?,
              order_count = ?,
              completed_at = ?
        WHERE run_id = ?`
    )
    .bind(
      input.signals.length,
      input.targets.length,
      input.orders.length,
      new Date().toISOString(),
      input.runId
    );
}

function failedRunStatement(
  db: D1Database,
  input: {
    runId: string;
    now: string;
    completedAt: string;
    auth: AuthenticatedAdmin;
    options: CongressAlphaRunOptions;
    errorMessage: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO congress_alpha_runs
        (run_id, status, mode, bankroll, max_positions, min_score, max_weight_pct, lookback_days, config_json, created_by, error_message, created_at, completed_at)
       VALUES (?, 'FAILED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = 'FAILED',
         error_message = excluded.error_message,
         completed_at = excluded.completed_at`
    )
    .bind(
      input.runId,
      PAPER_MODE,
      input.options.bankroll,
      input.options.maxPositions,
      input.options.minScore,
      input.options.maxWeightPct,
      input.options.lookbackDays,
      JSON.stringify(input.options),
      input.auth.subject,
      input.errorMessage,
      input.now,
      input.completedAt
    );
}

function insertSignalStatement(db: D1Database, signal: CongressAlphaSignal): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO congress_alpha_signals
        (
          signal_id, run_id, symbol, sector, as_of, score, confidence, direction,
          horizon_days, latest_trade_at, current_price, net_amount_mid,
          purchase_amount_mid, sale_amount_mid, transaction_count, purchase_count,
          sale_count, member_count, conflict_count, bipartisan_score,
          freshness_penalty, rationale_json
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      signal.signalId,
      signal.runId,
      signal.symbol,
      signal.sector,
      signal.asOf,
      signal.score,
      signal.confidence,
      signal.direction,
      signal.horizonDays,
      signal.latestTradeAt,
      signal.currentPrice,
      signal.netAmountMid,
      signal.purchaseAmountMid,
      signal.saleAmountMid,
      signal.transactionCount,
      signal.purchaseCount,
      signal.saleCount,
      signal.memberCount,
      signal.conflictCount,
      signal.bipartisanScore,
      signal.freshnessPenalty,
      JSON.stringify(signal.rationale)
    );
}

function insertTargetStatement(db: D1Database, target: CongressAlphaTarget): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO congress_alpha_targets
        (target_id, run_id, signal_id, symbol, sector, reference_price, target_weight_pct, target_notional, score, confidence, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      target.targetId,
      target.runId,
      target.signalId,
      target.symbol,
      target.sector,
      target.referencePrice,
      target.targetWeightPct,
      target.targetNotional,
      target.score,
      target.confidence,
      target.reason
    );
}

function insertOrderStatement(db: D1Database, order: CongressAlphaPaperOrder): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO congress_alpha_paper_orders
        (order_id, run_id, signal_id, symbol, side, quantity, limit_price, notional, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      order.orderId,
      order.runId,
      order.signalId,
      order.symbol,
      order.side,
      order.quantity,
      order.limitPrice,
      order.notional,
      order.status,
      order.reason
    );
}

function upsertPositionStatement(
  db: D1Database,
  position: CongressAlphaPositionPlan,
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO congress_alpha_paper_positions
        (symbol, quantity, avg_price, market_price, market_value, unrealized_pnl, target_weight_pct, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         quantity = excluded.quantity,
         avg_price = excluded.avg_price,
         market_price = excluded.market_price,
         market_value = excluded.market_value,
         unrealized_pnl = excluded.unrealized_pnl,
         target_weight_pct = excluded.target_weight_pct,
         updated_at = excluded.updated_at`
    )
    .bind(
      position.symbol,
      position.quantity,
      position.avgPrice,
      position.marketPrice,
      position.marketValue,
      position.unrealizedPnl,
      position.targetWeightPct,
      now
    );
}

function deletePositionStatement(db: D1Database, symbol: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM congress_alpha_paper_positions WHERE symbol = ?`).bind(symbol);
}

function formatSignalRow(row: CongressAlphaSignalRow): JsonRecord {
  return {
    signalId: row.signal_id,
    runId: row.run_id,
    symbol: row.symbol,
    sector: row.sector ?? "UNRESOLVED",
    asOf: row.as_of,
    score: row.score,
    confidence: row.confidence,
    direction: row.direction,
    horizonDays: row.horizon_days,
    latestTradeAt: row.latest_trade_at,
    currentPrice: row.current_price,
    netAmountMid: row.net_amount_mid,
    purchaseAmountMid: row.purchase_amount_mid,
    saleAmountMid: row.sale_amount_mid,
    transactionCount: row.transaction_count,
    purchaseCount: row.purchase_count,
    saleCount: row.sale_count,
    memberCount: row.member_count,
    conflictCount: row.conflict_count,
    bipartisanScore: row.bipartisan_score,
    freshnessPenalty: row.freshness_penalty,
    rationale: parseJsonRecord(row.rationale_json),
    createdAt: row.created_at
  };
}

function formatTargetRow(row: CongressAlphaTargetRow): JsonRecord {
  return {
    targetId: row.target_id,
    runId: row.run_id,
    signalId: row.signal_id,
    symbol: row.symbol,
    sector: row.sector ?? "UNRESOLVED",
    referencePrice: row.reference_price,
    targetWeightPct: row.target_weight_pct,
    targetNotional: row.target_notional,
    score: row.score,
    confidence: row.confidence,
    reason: row.reason,
    createdAt: row.created_at
  };
}

function formatOrderRow(row: CongressAlphaOrderRow): JsonRecord {
  return {
    orderId: row.order_id,
    runId: row.run_id,
    signalId: row.signal_id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    limitPrice: row.limit_price,
    notional: row.notional,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at
  };
}

function formatPositionRow(row: CongressAlphaPositionRow): JsonRecord {
  return {
    symbol: row.symbol,
    quantity: row.quantity,
    avgPrice: row.avg_price,
    marketPrice: row.market_price,
    marketValue: row.market_value,
    unrealizedPnl: row.unrealized_pnl,
    targetWeightPct: row.target_weight_pct,
    updatedAt: row.updated_at
  };
}

function congressDb(env: Env): D1Database {
  return env.CONGRESS_DB ?? env.TRADING_DB;
}

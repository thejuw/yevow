import { Logger } from "../Logger";
import { exchangeSecret } from "../execution/SecretResolver";
import type { AuthenticatedAdmin } from "./AdminModels";
import {
  evaluateCongressConflicts,
  normalizeCommitteeAssignment,
  normalizeCongressMemberKey,
  normalizeMemberProfile,
  resolveSecuritySector,
  summarizeConflictFlags,
  type CongressCommitteeAssignmentInput,
  type CongressConflictFlagRow,
  type CongressMemberProfileInput,
  type NormalizedMemberProfile,
  type NormalizedCommitteeAssignment
} from "./CongressConflictEngine";
import { fetchCongressPriceMark, normalizeTickerSymbol } from "./CongressPriceProvider";
import { json, readJsonBody } from "./ResponseHelpers";
import { sourceIp } from "./SecurityAudit";
import type { EdgeTopology, Env, JsonRecord } from "../types";

const MAX_PAGE_LIMIT = 250;
const DEFAULT_PAGE_LIMIT = 75;
const PRICE_REFRESH_LIMIT = 100;
const DEFAULT_GITHUB_RUNNER_REF = "main";
const TICKER_HIERARCHY_LIMIT = 40;
const TICKER_DETAIL_LIMIT = 240;
const CONFLICT_FLAG_LOOKUP_BATCH_SIZE = 75;
const MACRO_HEATMAP_WINDOWS = [30, 60, 90] as const;
const MACRO_HEATMAP_LIMIT = 14;

type CongressRunnerKind = "generic_webhook" | "github_actions";
type CongressPeriod = "24h" | "7d" | "30d" | "90d" | "ytd" | "all";
type CongressPeriodBasis = "created_at" | "transaction_date";

interface CountRow {
  count: number;
}

interface CongressRunRow {
  run_id: string;
  status: string;
  trigger_source: string;
  source: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  stats_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface CongressTransactionRow {
  transaction_id: string;
  filing_id: string | null;
  chamber: string;
  member_name: string | null;
  owner: string | null;
  symbol: string | null;
  asset_name: string | null;
  transaction_type: string;
  transaction_date: string | null;
  notification_date: string | null;
  amount_min: number | null;
  amount_max: number | null;
  amount_mid: number | null;
  transaction_price: number | null;
  transaction_price_as_of: string | null;
  current_price: number | null;
  current_price_as_of: string | null;
  pnl_estimate: number | null;
  return_pct: number | null;
  price_provider: string | null;
  confidence: number | null;
  raw_text: string | null;
  source_url: string | null;
  member_key: string | null;
  member_party: string | null;
  security_sector: string | null;
  created_at: string;
  updated_at: string;
  conflict_flag_count?: number;
  conflict_highest_severity?: string | null;
  conflict_flags?: JsonRecord[];
}

interface CongressTickerAggregateRow {
  ticker: string;
  display_name: string;
  transaction_count: number;
  purchase_count: number;
  sale_count: number;
  exchange_count: number;
  total_amount_mid: number | null;
  purchase_amount_mid: number | null;
  sale_amount_mid: number | null;
  marked_count: number;
  pnl_estimate: number | null;
  last_seen_at: string | null;
}

interface CongressFilingInput {
  filingId?: string;
  chamber?: string;
  source?: string;
  sourceFilingId?: string;
  reportType?: string;
  filerName?: string;
  filingDate?: string;
  sourceUrl?: string;
  rawR2Key?: string;
  rawSha256?: string;
  parserStatus?: string;
  parserConfidence?: number;
  metadata?: JsonRecord;
}

interface CongressTransactionInput {
  transactionId?: string;
  filingId?: string;
  chamber?: string;
  memberName?: string;
  owner?: string;
  symbol?: string;
  assetName?: string;
  transactionType?: string;
  transactionDate?: string;
  notificationDate?: string;
  amountMin?: number;
  amountMax?: number;
  amountMid?: number;
  transactionPrice?: number;
  transactionPriceAsOf?: string;
  confidence?: number;
  rawText?: string;
  sourceUrl?: string;
}

interface CongressCleaningIssueInput {
  issueId?: string;
  filingId?: string;
  transactionId?: string;
  severity?: string;
  issueType?: string;
  message?: string;
  rawContext?: JsonRecord;
}

interface CongressIngestPayload {
  runId?: string;
  source?: string;
  filings?: CongressFilingInput[];
  transactions?: CongressTransactionInput[];
  cleaningIssues?: CongressCleaningIssueInput[];
  committeeAssignments?: CongressCommitteeAssignmentInput[];
  memberProfiles?: CongressMemberProfileInput[];
  completed?: boolean;
  errorMessage?: string;
  stats?: JsonRecord;
}

interface CongressSectorFlowRow {
  sector: string | null;
  transaction_count: number;
  purchase_count: number;
  sale_count: number;
  total_amount_mid: number | null;
  purchase_amount_mid: number | null;
  sale_amount_mid: number | null;
  net_amount_mid: number | null;
  democratic_purchase_amount_mid: number | null;
  republican_purchase_amount_mid: number | null;
}

interface CongressTickerFlowRow extends CongressSectorFlowRow {
  ticker: string;
  democratic_purchase_count: number;
  republican_purchase_count: number;
  democratic_member_count: number;
  republican_member_count: number;
  bipartisan_buy_amount_mid: number | null;
}

interface CongressRunRequest {
  source?: string;
  reason?: string;
}

interface RunnerNotificationResult {
  ok: boolean;
  error?: string;
}

export async function readCongressStatus(env: Env): Promise<Response> {
  try {
    const [latestRun, runs, filings, transactions, openIssues, conflictStats, pnl] =
      await Promise.all([
        congressDb(env)
          .prepare(`SELECT * FROM congress_scrape_runs ORDER BY created_at DESC LIMIT 1`)
          .first<CongressRunRow>(),
        count(env, "congress_scrape_runs"),
        count(env, "congress_filings"),
        count(env, "congress_transactions"),
        congressDb(env)
          .prepare(
            `SELECT COUNT(*) AS count
           FROM congress_cleaning_issues
          WHERE severity IN ('ERROR', 'CRITICAL')`
          )
          .first<CountRow>(),
        congressDb(env)
          .prepare(
            `SELECT
             COUNT(*) AS flags,
             COUNT(DISTINCT transaction_id) AS flagged_transactions,
             SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) AS high_flags
           FROM congress_conflict_flags`
          )
          .first<{ flags: number; flagged_transactions: number; high_flags: number }>(),
        congressDb(env)
          .prepare(
            `SELECT
           COALESCE(SUM(pnl_estimate), 0) AS total_pnl,
           AVG(return_pct) AS average_return_pct,
           COUNT(CASE WHEN pnl_estimate IS NOT NULL THEN 1 END) AS marked_transactions
         FROM congress_transactions`
          )
          .first<{
            total_pnl: number;
            average_return_pct: number | null;
            marked_transactions: number;
          }>()
      ]);

    return json({
      ok: true,
      tracker: {
        enabled: env.CONGRESS_TRACKER_ENABLED !== "false",
        schedulerTimezone: env.CONGRESS_SCHEDULER_TIMEZONE ?? "America/Chicago",
        runnerConfigured: await isCongressRunnerConfigured(env),
        runnerKind: normalizeRunnerKind(
          env.CONGRESS_RUNNER_KIND,
          await exchangeSecret(env, "CONGRESS_RUNNER_URL")
        ),
        priceProvider: env.CONGRESS_PRICE_PROVIDER ?? "yahoo-chart",
        rawArchiveConfigured: Boolean(env.CONGRESS_RAW)
      },
      latestRun,
      counts: {
        runs: runs.count,
        filings: filings.count,
        transactions: transactions.count,
        openIssues: openIssues?.count ?? 0,
        markedTransactions: pnl?.marked_transactions ?? 0,
        conflictFlags: conflictStats?.flags ?? 0,
        flaggedTransactions: conflictStats?.flagged_transactions ?? 0,
        highConflictFlags: conflictStats?.high_flags ?? 0
      },
      pnl: {
        totalEstimate: pnl?.total_pnl ?? 0,
        averageReturnPct: pnl?.average_return_pct ?? null
      }
    });
  } catch (error) {
    return schemaUnavailable(error);
  }
}

export async function readCongressRuns(env: Env, url: URL): Promise<Response> {
  try {
    const limit = limitParam(url);
    const offset = offsetParam(url);
    const rows = await congressDb(env)
      .prepare(
        `SELECT *
         FROM congress_scrape_runs
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
      )
      .bind(limit, offset)
      .all<CongressRunRow>();

    return json({ ok: true, runs: rows.results ?? [], limit, offset });
  } catch (error) {
    return schemaUnavailable(error);
  }
}

export async function readCongressFilings(env: Env, url: URL): Promise<Response> {
  try {
    const limit = limitParam(url);
    const offset = offsetParam(url);
    const clauses: string[] = ["1 = 1"];
    const params: unknown[] = [];
    addStringFilter(clauses, params, "chamber", url.searchParams.get("chamber"));
    addLikeFilter(clauses, params, "filer_name", url.searchParams.get("member"));
    addDateRangeFilter(clauses, params, "filing_date", url);

    const rows = await congressDb(env)
      .prepare(
        `SELECT *
         FROM congress_filings
        WHERE ${clauses.join(" AND ")}
        ORDER BY filing_date DESC, created_at DESC
        LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all();

    return json({ ok: true, filings: rows.results ?? [], limit, offset });
  } catch (error) {
    return schemaUnavailable(error);
  }
}

export async function readCongressTransactions(env: Env, url: URL): Promise<Response> {
  try {
    const limit = limitParam(url);
    const offset = offsetParam(url);
    const clauses: string[] = ["1 = 1"];
    const params: unknown[] = [];
    const symbol = normalizeTickerSymbol(url.searchParams.get("symbol"));

    if (symbol) {
      clauses.push("UPPER(symbol) = ?");
      params.push(symbol);
    }

    addStringFilter(clauses, params, "chamber", url.searchParams.get("chamber"));
    addLikeFilter(clauses, params, "member_name", url.searchParams.get("member"));
    addStringFilter(clauses, params, "transaction_type", url.searchParams.get("type"));
    addDateRangeFilter(clauses, params, "transaction_date", url);

    const rows = await congressDb(env)
      .prepare(
        `SELECT *
         FROM congress_transactions
        WHERE ${clauses.join(" AND ")}
        ORDER BY transaction_date DESC, created_at DESC
        LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<CongressTransactionRow>();
    const transactions = await attachConflictFlags(env, rows.results ?? []);

    return json({
      ok: true,
      transactions,
      limit,
      offset,
      pnlMethod:
        "Estimated mark-to-market using reported amount midpoints and Yahoo Chart primary / Stooq daily fallback prices."
    });
  } catch (error) {
    return schemaUnavailable(error);
  }
}

export async function readCongressTickerHierarchy(env: Env, url: URL): Promise<Response> {
  try {
    const period = normalizePeriod(url.searchParams.get("period"));
    const basis = normalizePeriodBasis(url.searchParams.get("basis"));
    const limit = clampLimit(url.searchParams.get("limit"), TICKER_HIERARCHY_LIMIT);
    const window = congressWindow(period, basis);
    const whereSql = window.whereSql;
    const bindParams = window.params;

    const [aggregateResult, detailResult] = await Promise.all([
      congressDb(env)
        .prepare(
          `SELECT
             COALESCE(NULLIF(UPPER(symbol), ''), 'UNRESOLVED') AS ticker,
             CASE
               WHEN symbol IS NULL OR TRIM(symbol) = ''
                 THEN 'Unresolved / fixed income and funds'
               ELSE UPPER(symbol)
             END AS display_name,
             COUNT(*) AS transaction_count,
             SUM(CASE WHEN transaction_type = 'PURCHASE' THEN 1 ELSE 0 END) AS purchase_count,
             SUM(CASE WHEN transaction_type = 'SALE' THEN 1 ELSE 0 END) AS sale_count,
             SUM(CASE WHEN transaction_type = 'EXCHANGE' THEN 1 ELSE 0 END) AS exchange_count,
             SUM(COALESCE(amount_mid, 0)) AS total_amount_mid,
             SUM(CASE WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
               AS purchase_amount_mid,
             SUM(CASE WHEN transaction_type = 'SALE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
               AS sale_amount_mid,
             SUM(CASE WHEN pnl_estimate IS NOT NULL THEN 1 ELSE 0 END) AS marked_count,
             SUM(COALESCE(pnl_estimate, 0)) AS pnl_estimate,
             MAX(created_at) AS last_seen_at
           FROM congress_transactions
           WHERE ${whereSql}
           GROUP BY ticker, display_name
           ORDER BY total_amount_mid DESC, transaction_count DESC, ticker ASC
           LIMIT ?`
        )
        .bind(...bindParams, limit)
        .all<CongressTickerAggregateRow>(),
      congressDb(env)
        .prepare(
          `SELECT *
           FROM congress_transactions
           WHERE ${whereSql}
           ORDER BY COALESCE(amount_mid, 0) DESC, created_at DESC
           LIMIT ?`
        )
        .bind(...bindParams, TICKER_DETAIL_LIMIT)
        .all<CongressTransactionRow>()
    ]);

    const aggregates = aggregateResult.results ?? [];
    const details = await attachConflictFlags(env, detailResult.results ?? []);
    const totalAmount = aggregates.reduce(
      (sum, row) => sum + nonNegativeNumber(row.total_amount_mid),
      0
    );
    const detailMap = groupTransactionsByTicker(details);

    const tickers = aggregates.map((row, index) => {
      const totalAmountMid = nonNegativeNumber(row.total_amount_mid);
      const purchaseAmountMid = nonNegativeNumber(row.purchase_amount_mid);
      const saleAmountMid = nonNegativeNumber(row.sale_amount_mid);
      const transactions = detailMap.get(row.ticker) ?? [];

      return {
        rank: index + 1,
        ticker: row.ticker,
        displayName: row.display_name,
        weightPct: totalAmount > 0 ? (totalAmountMid / totalAmount) * 100 : 0,
        transactionCount: Number(row.transaction_count ?? 0),
        purchaseCount: Number(row.purchase_count ?? 0),
        saleCount: Number(row.sale_count ?? 0),
        exchangeCount: Number(row.exchange_count ?? 0),
        totalAmountMid,
        purchaseAmountMid,
        saleAmountMid,
        netDirectionalAmountMid: purchaseAmountMid - saleAmountMid,
        markedCount: Number(row.marked_count ?? 0),
        pnlEstimate: Number(row.pnl_estimate ?? 0),
        lastSeenAt: row.last_seen_at,
        topAssets: topAssetBreakdown(transactions),
        transactions: transactions.slice(0, 8)
      };
    });

    return json({
      ok: true,
      period,
      basis,
      windowStart: window.windowStart,
      windowEnd: new Date().toISOString(),
      totalAmountMid: totalAmount,
      totalTransactions: tickers.reduce((sum, row) => sum + row.transactionCount, 0),
      tickers,
      note: "Hierarchy is ranked by disclosed amount midpoint within the selected ingestion/transaction window. Rows without a confident public ticker are grouped as UNRESOLVED instead of being price-marked."
    });
  } catch (error) {
    return schemaUnavailable(error);
  }
}

export async function readCongressMacroHeatmap(env: Env, url: URL): Promise<Response> {
  try {
    const limit = clampLimit(url.searchParams.get("limit"), MACRO_HEATMAP_LIMIT);
    const windows = [];

    for (const days of MACRO_HEATMAP_WINDOWS) {
      const windowStart = rollingWindowStart(days);
      const [sectorResult, tickerResult] = await Promise.all([
        congressDb(env)
          .prepare(
            `SELECT
               COALESCE(security_sector, 'UNRESOLVED') AS sector,
               COUNT(*) AS transaction_count,
               SUM(CASE WHEN transaction_type = 'PURCHASE' THEN 1 ELSE 0 END) AS purchase_count,
               SUM(CASE WHEN transaction_type = 'SALE' THEN 1 ELSE 0 END) AS sale_count,
               SUM(COALESCE(amount_mid, 0)) AS total_amount_mid,
               SUM(CASE WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
                 AS purchase_amount_mid,
               SUM(CASE WHEN transaction_type = 'SALE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
                 AS sale_amount_mid,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0)
                    WHEN transaction_type = 'SALE' THEN -COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS net_amount_mid,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' AND member_party = 'D'
                      THEN COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS democratic_purchase_amount_mid,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' AND member_party = 'R'
                      THEN COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS republican_purchase_amount_mid
             FROM congress_transactions
             WHERE datetime(COALESCE(transaction_date, created_at)) >= datetime(?)
             GROUP BY sector
             ORDER BY ABS(net_amount_mid) DESC, total_amount_mid DESC
             LIMIT ?`
          )
          .bind(windowStart, limit)
          .all<CongressSectorFlowRow>(),
        congressDb(env)
          .prepare(
            `SELECT
               COALESCE(NULLIF(UPPER(symbol), ''), 'UNRESOLVED') AS ticker,
               COALESCE(security_sector, 'UNRESOLVED') AS sector,
               COUNT(*) AS transaction_count,
               SUM(CASE WHEN transaction_type = 'PURCHASE' THEN 1 ELSE 0 END) AS purchase_count,
               SUM(CASE WHEN transaction_type = 'SALE' THEN 1 ELSE 0 END) AS sale_count,
               SUM(COALESCE(amount_mid, 0)) AS total_amount_mid,
               SUM(CASE WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
                 AS purchase_amount_mid,
               SUM(CASE WHEN transaction_type = 'SALE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
                 AS sale_amount_mid,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0)
                    WHEN transaction_type = 'SALE' THEN -COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS net_amount_mid,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' AND member_party = 'D'
                      THEN COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS democratic_purchase_amount_mid,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' AND member_party = 'R'
                      THEN COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS republican_purchase_amount_mid,
               SUM(CASE WHEN transaction_type = 'PURCHASE' AND member_party = 'D' THEN 1 ELSE 0 END)
                 AS democratic_purchase_count,
               SUM(CASE WHEN transaction_type = 'PURCHASE' AND member_party = 'R' THEN 1 ELSE 0 END)
                 AS republican_purchase_count,
               COUNT(DISTINCT CASE WHEN member_party = 'D' THEN member_key END)
                 AS democratic_member_count,
               COUNT(DISTINCT CASE WHEN member_party = 'R' THEN member_key END)
                 AS republican_member_count,
               SUM(CASE
                    WHEN transaction_type = 'PURCHASE' AND member_party IN ('D', 'R')
                      THEN COALESCE(amount_mid, 0)
                    ELSE 0
                   END) AS bipartisan_buy_amount_mid
             FROM congress_transactions
             WHERE datetime(COALESCE(transaction_date, created_at)) >= datetime(?)
             GROUP BY ticker, sector
             ORDER BY ABS(net_amount_mid) DESC, total_amount_mid DESC
             LIMIT ?`
          )
          .bind(windowStart, limit)
          .all<CongressTickerFlowRow>()
      ]);

      windows.push({
        days,
        windowStart,
        sectors: (sectorResult.results ?? []).map(formatSectorFlow),
        tickers: (tickerResult.results ?? []).map(formatTickerFlow)
      });
    }

    const bipartisanWindowStart = rollingWindowStart(90);
    const bipartisan = await congressDb(env)
      .prepare(
        `SELECT
           COALESCE(NULLIF(UPPER(symbol), ''), 'UNRESOLVED') AS ticker,
           COALESCE(security_sector, 'UNRESOLVED') AS sector,
           COUNT(*) AS transaction_count,
           SUM(CASE WHEN transaction_type = 'PURCHASE' THEN 1 ELSE 0 END) AS purchase_count,
           SUM(CASE WHEN transaction_type = 'SALE' THEN 1 ELSE 0 END) AS sale_count,
           SUM(COALESCE(amount_mid, 0)) AS total_amount_mid,
           SUM(CASE WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
             AS purchase_amount_mid,
           SUM(CASE WHEN transaction_type = 'SALE' THEN COALESCE(amount_mid, 0) ELSE 0 END)
             AS sale_amount_mid,
           SUM(CASE
                WHEN transaction_type = 'PURCHASE' THEN COALESCE(amount_mid, 0)
                WHEN transaction_type = 'SALE' THEN -COALESCE(amount_mid, 0)
                ELSE 0
               END) AS net_amount_mid,
           SUM(CASE
                WHEN transaction_type = 'PURCHASE' AND member_party = 'D'
                  THEN COALESCE(amount_mid, 0)
                ELSE 0
               END) AS democratic_purchase_amount_mid,
           SUM(CASE
                WHEN transaction_type = 'PURCHASE' AND member_party = 'R'
                  THEN COALESCE(amount_mid, 0)
                ELSE 0
               END) AS republican_purchase_amount_mid,
           SUM(CASE WHEN transaction_type = 'PURCHASE' AND member_party = 'D' THEN 1 ELSE 0 END)
             AS democratic_purchase_count,
           SUM(CASE WHEN transaction_type = 'PURCHASE' AND member_party = 'R' THEN 1 ELSE 0 END)
             AS republican_purchase_count,
           COUNT(DISTINCT CASE WHEN member_party = 'D' THEN member_key END)
             AS democratic_member_count,
           COUNT(DISTINCT CASE WHEN member_party = 'R' THEN member_key END)
             AS republican_member_count,
           SUM(CASE
                WHEN transaction_type = 'PURCHASE' AND member_party IN ('D', 'R')
                  THEN COALESCE(amount_mid, 0)
                ELSE 0
               END) AS bipartisan_buy_amount_mid
         FROM congress_transactions
         WHERE datetime(COALESCE(transaction_date, created_at)) >= datetime(?)
           AND symbol IS NOT NULL
         GROUP BY ticker, sector
         HAVING democratic_purchase_amount_mid > 0
            AND republican_purchase_amount_mid > 0
         ORDER BY bipartisan_buy_amount_mid DESC, purchase_count DESC
         LIMIT ?`
      )
      .bind(bipartisanWindowStart, limit)
      .all<CongressTickerFlowRow>();

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      windows,
      bipartisanConsensus: {
        days: 90,
        windowStart: bipartisanWindowStart,
        tickers: (bipartisan.results ?? []).map(formatTickerFlow)
      },
      note: "Macro heatmaps aggregate public PTR rows by transaction date over rolling 30/60/90-day windows. Party labels come from current public congressional metadata and are unavailable until runner enrichment has ingested member profiles."
    });
  } catch (error) {
    return schemaUnavailable(error);
  }
}

export async function triggerCongressRun(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const body = await readJsonBody<CongressRunRequest>(request);
  const source = normalizeSource(body?.source);
  const run = await createCongressRun(
    env,
    logger,
    topology,
    "manual",
    source,
    auth.subject,
    new Date().toISOString()
  );

  logger.info("CONGRESS_RUN_REQUESTED", "Congress tracker run requested", {
    runId: run.runId,
    source,
    actor: auth.subject,
    reason: body?.reason ?? null,
    sourceIp: sourceIp(request),
    colo: topology.colo,
    placement: topology.placement
  });

  return json(run, 202);
}

export async function ingestCongressPayload(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const payload = await readJsonBody<CongressIngestPayload>(request);

  if (!payload) {
    return json({ ok: false, error: "Invalid JSON payload" }, 400);
  }

  const now = new Date().toISOString();
  const runId = payload.runId ?? crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  const filings = Array.isArray(payload.filings) ? payload.filings : [];
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const issues = Array.isArray(payload.cleaningIssues) ? payload.cleaningIssues : [];
  const committeeAssignments = normalizeCommitteeAssignments(payload.committeeAssignments);
  const assignmentsByMember = committeeAssignmentsByMember(committeeAssignments);
  const memberProfiles = normalizeMemberProfiles(payload.memberProfiles);
  const profilesByMember = memberProfilesByMember(memberProfiles);

  statements.push(
    congressDb(env)
      .prepare(
        `INSERT INTO congress_scrape_runs
        (run_id, status, trigger_source, source, started_at, stats_json, created_by, created_at, updated_at)
       VALUES (?, 'INGESTING', 'external', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = 'INGESTING',
         started_at = COALESCE(congress_scrape_runs.started_at, excluded.started_at),
         stats_json = excluded.stats_json,
         updated_at = excluded.updated_at`
      )
      .bind(
        runId,
        normalizeSource(payload.source),
        now,
        stringifyJson(payload.stats ?? {}),
        auth.subject,
        now,
        now
      )
  );

  for (const filing of filings) {
    const filingId = filing.filingId ?? (await stableId("filing", filing));
    statements.push(
      congressDb(env)
        .prepare(
          `INSERT INTO congress_filings
          (
            filing_id, chamber, source, source_filing_id, report_type, filer_name, filing_date,
            source_url, raw_r2_key, raw_sha256, parser_status, parser_confidence, metadata_json,
            created_at, updated_at
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(filing_id) DO UPDATE SET
           chamber = excluded.chamber,
           source = excluded.source,
           source_filing_id = excluded.source_filing_id,
           report_type = excluded.report_type,
           filer_name = excluded.filer_name,
           filing_date = excluded.filing_date,
           source_url = excluded.source_url,
           raw_r2_key = excluded.raw_r2_key,
           raw_sha256 = excluded.raw_sha256,
           parser_status = excluded.parser_status,
           parser_confidence = excluded.parser_confidence,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
        )
        .bind(
          filingId,
          normalizeChamber(filing.chamber),
          safeString(filing.source, "official"),
          nullableString(filing.sourceFilingId),
          safeString(filing.reportType, "PTR"),
          nullableString(filing.filerName),
          nullableDate(filing.filingDate),
          nullableString(filing.sourceUrl),
          nullableString(filing.rawR2Key),
          nullableString(filing.rawSha256),
          safeString(filing.parserStatus, "PARSED"),
          nullableNumber(filing.parserConfidence),
          stringifyJson(filing.metadata ?? {}),
          now,
          now
        )
    );
  }

  for (const assignment of committeeAssignments) {
    statements.push(
      congressDb(env)
        .prepare(
          `INSERT INTO congress_committee_assignments
          (
            member_key, member_name, chamber, committee_code, committee_name, committee_role,
            source, source_updated_at, created_at, updated_at
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_key, chamber, committee_code) DO UPDATE SET
           member_name = excluded.member_name,
           committee_name = excluded.committee_name,
           committee_role = excluded.committee_role,
           source = excluded.source,
           source_updated_at = excluded.source_updated_at,
           updated_at = excluded.updated_at`
        )
        .bind(
          assignment.memberKey,
          assignment.memberName,
          assignment.chamber,
          assignment.committeeCode,
          assignment.committeeName,
          assignment.committeeRole,
          assignment.source,
          assignment.sourceUpdatedAt,
          now,
          now
        )
    );
  }

  for (const profile of memberProfiles) {
    statements.push(
      congressDb(env)
        .prepare(
          `INSERT INTO congress_member_profiles
          (
            member_key, member_name, chamber, party, state, district, bioguide_id,
            source, source_updated_at, created_at, updated_at
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_key) DO UPDATE SET
           member_name = excluded.member_name,
           chamber = excluded.chamber,
           party = excluded.party,
           state = excluded.state,
           district = excluded.district,
           bioguide_id = excluded.bioguide_id,
           source = excluded.source,
           source_updated_at = excluded.source_updated_at,
           updated_at = excluded.updated_at`
        )
        .bind(
          profile.memberKey,
          profile.memberName,
          profile.chamber,
          profile.party,
          profile.state,
          profile.district,
          profile.bioguideId,
          profile.source,
          profile.sourceUpdatedAt,
          now,
          now
        )
    );
  }

  for (const transaction of transactions) {
    const normalizedSymbol = normalizeTickerSymbol(transaction.symbol ?? "") ?? null;
    const transactionId = transaction.transactionId ?? (await stableId("transaction", transaction));
    const memberName = nullableString(transaction.memberName);
    const memberKey = normalizeCongressMemberKey(memberName) || null;
    const memberProfile = memberKey ? profilesByMember.get(memberKey) : undefined;
    const securitySector = resolveSecuritySector(
      normalizedSymbol,
      nullableString(transaction.assetName)
    );
    statements.push(
      congressDb(env)
        .prepare(
          `INSERT INTO congress_transactions
          (
            transaction_id, filing_id, chamber, member_name, owner, symbol, asset_name,
            transaction_type, transaction_date, notification_date, amount_min, amount_max,
            amount_mid, transaction_price, transaction_price_as_of, confidence, raw_text,
            source_url, member_key, member_party, security_sector, created_at, updated_at
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(transaction_id) DO UPDATE SET
           filing_id = excluded.filing_id,
           chamber = excluded.chamber,
           member_name = excluded.member_name,
           owner = excluded.owner,
           symbol = excluded.symbol,
           asset_name = excluded.asset_name,
           transaction_type = excluded.transaction_type,
           transaction_date = excluded.transaction_date,
           notification_date = excluded.notification_date,
           amount_min = excluded.amount_min,
           amount_max = excluded.amount_max,
           amount_mid = excluded.amount_mid,
           transaction_price = COALESCE(excluded.transaction_price, congress_transactions.transaction_price),
           transaction_price_as_of = COALESCE(excluded.transaction_price_as_of, congress_transactions.transaction_price_as_of),
           confidence = excluded.confidence,
           raw_text = excluded.raw_text,
           source_url = excluded.source_url,
           member_key = excluded.member_key,
           member_party = excluded.member_party,
           security_sector = excluded.security_sector,
           updated_at = excluded.updated_at`
        )
        .bind(
          transactionId,
          nullableString(transaction.filingId),
          normalizeChamber(transaction.chamber),
          memberName,
          nullableString(transaction.owner),
          normalizedSymbol,
          nullableString(transaction.assetName),
          normalizeTransactionType(transaction.transactionType),
          nullableDate(transaction.transactionDate),
          nullableDate(transaction.notificationDate),
          nullableNumber(transaction.amountMin),
          nullableNumber(transaction.amountMax),
          nullableNumber(transaction.amountMid),
          nullableNumber(transaction.transactionPrice),
          nullableDate(transaction.transactionPriceAsOf),
          nullableNumber(transaction.confidence),
          nullableString(transaction.rawText),
          nullableString(transaction.sourceUrl),
          memberKey,
          memberProfile?.party ?? null,
          securitySector,
          now,
          now
        )
    );

    statements.push(
      congressDb(env)
        .prepare(`DELETE FROM congress_conflict_flags WHERE transaction_id = ?`)
        .bind(transactionId)
    );

    const conflictFlags = evaluateCongressConflicts(assignmentsByMember, {
      transactionId,
      chamber: normalizeChamber(transaction.chamber),
      memberName,
      symbol: normalizedSymbol,
      assetName: nullableString(transaction.assetName),
      transactionType: normalizeTransactionType(transaction.transactionType)
    });

    for (const flag of conflictFlags) {
      statements.push(
        congressDb(env)
          .prepare(
            `INSERT INTO congress_conflict_flags
            (
              flag_id, transaction_id, member_name, chamber, symbol, asset_name,
              transaction_type, sector, committee_code, committee_name, committee_role,
              severity, reason, source, created_at, updated_at
            )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(flag_id) DO UPDATE SET
             severity = excluded.severity,
             reason = excluded.reason,
             source = excluded.source,
             updated_at = excluded.updated_at`
          )
          .bind(
            flag.flagId,
            flag.transactionId,
            flag.memberName,
            flag.chamber,
            flag.symbol,
            flag.assetName,
            flag.transactionType,
            flag.sector,
            flag.committeeCode,
            flag.committeeName,
            flag.committeeRole,
            flag.severity,
            flag.reason,
            flag.source,
            now,
            now
          )
      );
    }
  }

  for (const issue of issues) {
    statements.push(
      congressDb(env)
        .prepare(
          `INSERT INTO congress_cleaning_issues
          (issue_id, filing_id, transaction_id, severity, issue_type, message, raw_context_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           severity = excluded.severity,
           issue_type = excluded.issue_type,
           message = excluded.message,
           raw_context_json = excluded.raw_context_json`
        )
        .bind(
          issue.issueId ?? crypto.randomUUID(),
          nullableString(issue.filingId),
          nullableString(issue.transactionId),
          normalizeSeverity(issue.severity),
          safeString(issue.issueType, "PARSER_WARNING"),
          safeString(issue.message, "Cleaning issue"),
          stringifyJson(issue.rawContext ?? {}),
          now
        )
    );
  }

  if (payload.completed || payload.errorMessage) {
    statements.push(
      congressDb(env)
        .prepare(
          `UPDATE congress_scrape_runs
            SET status = ?,
                completed_at = ?,
                error_message = ?,
                stats_json = ?,
                updated_at = ?
          WHERE run_id = ?`
        )
        .bind(
          payload.errorMessage ? "FAILED" : "COMPLETED",
          now,
          payload.errorMessage ?? null,
          stringifyJson(payload.stats ?? {}),
          now,
          runId
        )
    );
  }

  if (statements.length > 0) {
    await congressDb(env).batch(statements);
  }

  logger.info("CONGRESS_INGEST_ACCEPTED", "Congress tracker ingest payload accepted", {
    runId,
    filings: filings.length,
    transactions: transactions.length,
    committeeAssignments: committeeAssignments.length,
    memberProfiles: memberProfiles.length,
    issues: issues.length,
    completed: payload.completed === true,
    actor: auth.subject,
    colo: topology.colo,
    placement: topology.placement
  });

  return json({
    ok: true,
    runId,
    counts: {
      filings: filings.length,
      transactions: transactions.length,
      cleaningIssues: issues.length
    }
  });
}

export async function refreshCongressPnl(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const body = await readJsonBody<{ limit?: number; symbol?: string }>(request);
  const result = await refreshCongressPnlBatch(env, logger, {
    limit: clampLimit(body?.limit, PRICE_REFRESH_LIMIT),
    symbol: normalizeTickerSymbol(body?.symbol ?? "")
  });

  logger.info("CONGRESS_PNL_REFRESH_REQUESTED", "Congress transaction PnL refresh completed", {
    actor: auth.subject,
    refreshed: result.refreshed,
    failed: result.failed,
    sourceIp: sourceIp(request),
    colo: topology.colo,
    placement: topology.placement
  });

  return json({ ok: true, ...result });
}

export async function handleCongressScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  topology: EdgeTopology
): Promise<void> {
  if (env.CONGRESS_TRACKER_ENABLED === "false") {
    logger.info("CONGRESS_SCHEDULE_DISABLED", "Congress tracker cron skipped because disabled", {
      cron: controller.cron
    });
    return;
  }

  const scheduledAt = new Date(controller.scheduledTime);
  const timezone = env.CONGRESS_SCHEDULER_TIMEZONE ?? "America/Chicago";
  const local = localTimeParts(scheduledAt, timezone);

  if (local.hour !== "00" || local.minute !== "00") {
    logger.info(
      "CONGRESS_SCHEDULE_SKIPPED",
      "Congress tracker cron skipped outside local midnight",
      {
        cron: controller.cron,
        timezone,
        localDate: local.date,
        localTime: `${local.hour}:${local.minute}`
      }
    );
    return;
  }

  const idempotencyKey = `congress:daily-run:${timezone}:${local.date}`;
  const existing = await env.CONFIG_STORE.get(idempotencyKey);

  if (existing) {
    logger.info("CONGRESS_SCHEDULE_DEDUPED", "Congress tracker midnight run already queued", {
      idempotencyKey,
      existing
    });
    return;
  }

  await env.CONFIG_STORE.put(idempotencyKey, new Date().toISOString(), {
    expirationTtl: 3 * 24 * 60 * 60
  });

  const run = await createCongressRun(
    env,
    logger,
    topology,
    "scheduled",
    "all",
    "system:cron",
    scheduledAt.toISOString()
  );

  ctx.waitUntil(refreshCongressPnlBatch(env, logger, { limit: PRICE_REFRESH_LIMIT }));

  logger.info("CONGRESS_SCHEDULE_QUEUED", "Congress tracker midnight run queued", {
    runId: run.runId,
    status: run.status,
    timezone,
    localDate: local.date,
    cron: controller.cron
  });
}

async function refreshCongressPnlBatch(
  env: Env,
  logger: Logger,
  options: { limit?: number; symbol?: string | null } = {}
): Promise<{
  refreshed: number;
  failed: number;
  marks: JsonRecord[];
  failures: JsonRecord[];
}> {
  const limit = clampLimit(options.limit, PRICE_REFRESH_LIMIT);
  const clauses = ["symbol IS NOT NULL", "symbol != ''"];
  const params: unknown[] = [];

  if (options.symbol) {
    clauses.push("UPPER(symbol) = ?");
    params.push(options.symbol);
  }

  const rows = await congressDb(env)
    .prepare(
      `SELECT *
       FROM congress_transactions
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(current_price_as_of, '1970-01-01') ASC, updated_at ASC
      LIMIT ?`
    )
    .bind(...params, limit)
    .all<CongressTransactionRow>();

  const statements: D1PreparedStatement[] = [];
  const marks: JsonRecord[] = [];
  const failures: JsonRecord[] = [];

  for (const row of rows.results ?? []) {
    if (!row.symbol) {
      continue;
    }

    try {
      const mark = await fetchCongressPriceMark(row.symbol, row.transaction_date);
      const basisPrice = row.transaction_price ?? mark.transactionPrice;
      const basisAsOf = row.transaction_price_as_of ?? mark.transactionPriceAsOf;
      const pnl = calculatePnl(row, mark.currentPrice, basisPrice);
      const returnPct = calculateReturnPct(row.transaction_type, mark.currentPrice, basisPrice);
      const now = new Date().toISOString();

      statements.push(
        congressDb(env)
          .prepare(
            `UPDATE congress_transactions
              SET transaction_price = COALESCE(transaction_price, ?),
                  transaction_price_as_of = COALESCE(transaction_price_as_of, ?),
                  current_price = ?,
                  current_price_as_of = ?,
                  pnl_estimate = ?,
                  return_pct = ?,
                  price_provider = ?,
                  updated_at = ?
            WHERE transaction_id = ?`
          )
          .bind(
            mark.transactionPrice,
            basisAsOf,
            mark.currentPrice,
            mark.currentPriceAsOf,
            pnl,
            returnPct,
            mark.provider,
            now,
            row.transaction_id
          )
      );

      statements.push(
        congressDb(env)
          .prepare(
            `INSERT INTO congress_price_cache
            (symbol, provider, as_of_date, price, fetched_at, raw_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol, provider, as_of_date) DO UPDATE SET
             price = excluded.price,
             fetched_at = excluded.fetched_at,
             raw_json = excluded.raw_json`
          )
          .bind(
            mark.symbol,
            mark.provider,
            mark.currentPriceAsOf.slice(0, 10),
            mark.currentPrice,
            now,
            stringifyJson(mark.raw)
          )
      );

      marks.push({
        transactionId: row.transaction_id,
        symbol: row.symbol,
        provider: mark.provider,
        currentPrice: mark.currentPrice,
        currentPriceAsOf: mark.currentPriceAsOf,
        transactionPrice: basisPrice,
        transactionPriceAsOf: basisAsOf,
        pnlEstimate: pnl,
        returnPct
      });
    } catch (error) {
      failures.push({
        transactionId: row.transaction_id,
        symbol: row.symbol,
        error: errorMessage(error)
      });
    }
  }

  if (statements.length > 0) {
    await congressDb(env).batch(statements);
  }

  if (failures.length > 0) {
    logger.warn("CONGRESS_PNL_REFRESH_PARTIAL", "Some Congress transaction price marks failed", {
      failed: failures.length,
      refreshed: marks.length,
      sample: failures.slice(0, 5)
    });
  }

  return {
    refreshed: marks.length,
    failed: failures.length,
    marks,
    failures
  };
}

async function createCongressRun(
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  triggerSource: "manual" | "scheduled",
  source: string,
  actor: string,
  scheduledFor: string
): Promise<{
  ok: true;
  runId: string;
  status: string;
  runnerConfigured: boolean;
  message: string;
  error?: string;
}> {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const runnerUrl = await exchangeSecret(env, "CONGRESS_RUNNER_URL");
  const runnerToken = await exchangeSecret(env, "CONGRESS_RUNNER_TOKEN");
  const runnerKind = normalizeRunnerKind(env.CONGRESS_RUNNER_KIND, runnerUrl);
  const runnerConfigured = Boolean(runnerUrl);
  const runnable = runnerConfigured && (runnerKind !== "github_actions" || Boolean(runnerToken));
  const status = runnable ? "QUEUED" : "PENDING_EXTERNAL_RUN";

  await congressDb(env)
    .prepare(
      `INSERT INTO congress_scrape_runs
      (run_id, status, trigger_source, source, scheduled_for, stats_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      runId,
      status,
      triggerSource,
      source,
      scheduledFor,
      stringifyJson({
        runnerConfigured: runnable,
        runnerKind,
        missingRunnerToken: runnerKind === "github_actions" && !runnerToken
      }),
      actor,
      now,
      now
    )
    .run();

  let finalStatus = status;
  let runnerError: string | undefined;

  if (runnerUrl && runnable) {
    const notification = await notifyExternalRunner(
      env,
      runnerUrl,
      runnerToken,
      runnerKind,
      runId,
      source,
      triggerSource,
      scheduledFor,
      logger,
      topology
    );

    if (!notification.ok) {
      finalStatus = "RUNNER_NOTIFY_FAILED";
      runnerError = notification.error;
    }
  } else {
    logger.warn(
      "CONGRESS_RUNNER_NOT_CONFIGURED",
      runnerUrl
        ? "Congress run recorded but the configured runner is missing required credentials"
        : "Congress run recorded but no runner URL is set",
      {
        runId,
        source,
        triggerSource,
        runnerKind,
        missingRunnerToken: runnerKind === "github_actions" && !runnerToken,
        colo: topology.colo,
        placement: topology.placement
      }
    );
  }

  return {
    ok: true,
    runId,
    status: finalStatus,
    runnerConfigured: runnable,
    message: runnerError
      ? `Run recorded, but external runner dispatch failed: ${runnerError}`
      : runnable
        ? "Run queued with configured external scraper/OCR runner."
        : runnerKind === "github_actions" && runnerUrl
          ? "Run recorded. Configure CONGRESS_RUNNER_TOKEN before GitHub Actions dispatch can start automatically."
          : "Run recorded. Configure CONGRESS_RUNNER_URL to start the Playwright/OCR worker automatically.",
    ...(runnerError ? { error: runnerError } : {})
  };
}

async function notifyExternalRunner(
  env: Env,
  runnerUrl: string,
  runnerToken: string | undefined,
  runnerKind: CongressRunnerKind,
  runId: string,
  source: string,
  triggerSource: string,
  scheduledFor: string,
  logger: Logger,
  topology: EdgeTopology
): Promise<RunnerNotificationResult> {
  try {
    const requestInit =
      runnerKind === "github_actions"
        ? githubActionsDispatchRequest(env, runnerToken, runId, source, triggerSource, scheduledFor)
        : genericRunnerRequest(runnerToken, runId, source, triggerSource, scheduledFor);

    const response = await fetch(runnerUrl, {
      method: "POST",
      ...requestInit
    });

    if (!response.ok) {
      throw new Error(await runnerHttpError(response));
    }

    logger.info("CONGRESS_RUNNER_NOTIFIED", "Congress external runner accepted run", {
      runId,
      source,
      runnerKind,
      colo: topology.colo,
      placement: topology.placement
    });

    return { ok: true };
  } catch (error) {
    const now = new Date().toISOString();
    const errorText = errorMessage(error);
    await congressDb(env)
      .prepare(
        `UPDATE congress_scrape_runs
          SET status = 'RUNNER_NOTIFY_FAILED',
              error_message = ?,
              updated_at = ?
        WHERE run_id = ?`
      )
      .bind(errorText, now, runId)
      .run();

    logger.error("CONGRESS_RUNNER_NOTIFY_FAILED", "Congress external runner notification failed", {
      runId,
      runnerKind,
      error: errorText,
      colo: topology.colo,
      placement: topology.placement
    });

    return { ok: false, error: errorText };
  }
}

async function runnerHttpError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const clipped = body.trim().slice(0, 500);
  return clipped
    ? `runner returned HTTP ${response.status}: ${clipped}`
    : `runner returned HTTP ${response.status}`;
}

async function isCongressRunnerConfigured(env: Env): Promise<boolean> {
  const runnerUrl = await exchangeSecret(env, "CONGRESS_RUNNER_URL");
  const runnerToken = await exchangeSecret(env, "CONGRESS_RUNNER_TOKEN");
  const runnerKind = normalizeRunnerKind(env.CONGRESS_RUNNER_KIND, runnerUrl);
  return Boolean(runnerUrl) && (runnerKind !== "github_actions" || Boolean(runnerToken));
}

function normalizeRunnerKind(value: string | undefined, runnerUrl?: string): CongressRunnerKind {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "github_actions" || normalized === "github-actions") {
    return "github_actions";
  }

  if (runnerUrl) {
    try {
      const url = new URL(runnerUrl);
      if (url.hostname === "api.github.com" && url.pathname.includes("/actions/workflows/")) {
        return "github_actions";
      }
    } catch {
      return "generic_webhook";
    }
  }

  return "generic_webhook";
}

function genericRunnerRequest(
  runnerToken: string | undefined,
  runId: string,
  source: string,
  triggerSource: string,
  scheduledFor: string
): RequestInit {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (runnerToken) {
    headers.set("authorization", `Bearer ${runnerToken}`);
  }

  return {
    headers,
    body: JSON.stringify({
      runId,
      source,
      triggerSource,
      scheduledFor
    })
  };
}

function githubActionsDispatchRequest(
  env: Env,
  runnerToken: string | undefined,
  runId: string,
  source: string,
  triggerSource: string,
  scheduledFor: string
): RequestInit {
  if (!runnerToken) {
    throw new Error("CONGRESS_RUNNER_TOKEN is required for GitHub Actions runner dispatch");
  }

  const headers = new Headers({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${runnerToken}`,
    "content-type": "application/json",
    "user-agent": "Sovereign-Sigma-Congress-Tracker/1.0",
    "x-github-api-version": "2022-11-28"
  });

  return {
    headers,
    body: JSON.stringify({
      ref: env.CONGRESS_RUNNER_GITHUB_REF ?? DEFAULT_GITHUB_RUNNER_REF,
      inputs: {
        run_id: runId,
        source,
        trigger_source: triggerSource,
        scheduled_for: scheduledFor
      }
    })
  };
}

function groupTransactionsByTicker(
  rows: CongressTransactionRow[]
): Map<string, CongressTransactionRow[]> {
  const grouped = new Map<string, CongressTransactionRow[]>();

  for (const row of rows) {
    const ticker = row.symbol?.trim().toUpperCase() || "UNRESOLVED";
    const bucket = grouped.get(ticker) ?? [];
    bucket.push(row);
    grouped.set(ticker, bucket);
  }

  return grouped;
}

function normalizeCommitteeAssignments(
  assignments: CongressCommitteeAssignmentInput[] | undefined
): NormalizedCommitteeAssignment[] {
  if (!Array.isArray(assignments)) {
    return [];
  }

  const normalized: NormalizedCommitteeAssignment[] = [];
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const candidate = normalizeCommitteeAssignment(assignment);
    if (!candidate) {
      continue;
    }

    const key = `${candidate.memberKey}:${candidate.chamber}:${candidate.committeeCode}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(candidate);
  }

  return normalized;
}

function committeeAssignmentsByMember(
  assignments: NormalizedCommitteeAssignment[]
): Map<string, NormalizedCommitteeAssignment[]> {
  const grouped = new Map<string, NormalizedCommitteeAssignment[]>();

  for (const assignment of assignments) {
    const existing = grouped.get(assignment.memberKey) ?? [];
    existing.push(assignment);
    grouped.set(assignment.memberKey, existing);
  }

  return grouped;
}

function normalizeMemberProfiles(
  profiles: CongressMemberProfileInput[] | undefined
): NormalizedMemberProfile[] {
  if (!Array.isArray(profiles)) {
    return [];
  }

  const normalized: NormalizedMemberProfile[] = [];
  const seen = new Set<string>();

  for (const profile of profiles) {
    const candidate = normalizeMemberProfile(profile);
    if (!candidate || seen.has(candidate.memberKey)) {
      continue;
    }

    seen.add(candidate.memberKey);
    normalized.push(candidate);
  }

  return normalized;
}

function memberProfilesByMember(
  profiles: NormalizedMemberProfile[]
): Map<string, NormalizedMemberProfile> {
  const grouped = new Map<string, NormalizedMemberProfile>();

  for (const profile of profiles) {
    grouped.set(profile.memberKey, profile);
  }

  return grouped;
}

async function attachConflictFlags(
  env: Env,
  rows: CongressTransactionRow[]
): Promise<CongressTransactionRow[]> {
  if (rows.length === 0) {
    return rows;
  }

  const ids = Array.from(new Set(rows.map((row) => row.transaction_id).filter(Boolean)));
  const flagsByTransaction = new Map<string, CongressConflictFlagRow[]>();

  for (let offset = 0; offset < ids.length; offset += CONFLICT_FLAG_LOOKUP_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + CONFLICT_FLAG_LOOKUP_BATCH_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const flagResult = await congressDb(env)
      .prepare(
        `SELECT *
         FROM congress_conflict_flags
         WHERE transaction_id IN (${placeholders})
         ORDER BY
           CASE severity
             WHEN 'HIGH' THEN 3
             WHEN 'MEDIUM' THEN 2
             WHEN 'LOW' THEN 1
             ELSE 0
           END DESC,
           created_at DESC`
      )
      .bind(...chunk)
      .all<CongressConflictFlagRow>();

    for (const flag of flagResult.results ?? []) {
      const existing = flagsByTransaction.get(flag.transaction_id) ?? [];
      existing.push(flag);
      flagsByTransaction.set(flag.transaction_id, existing);
    }
  }

  return rows.map((row) => {
    const flags = flagsByTransaction.get(row.transaction_id) ?? [];
    return {
      ...row,
      conflict_flag_count: flags.length,
      conflict_highest_severity: flags[0]?.severity ?? null,
      conflict_flags: summarizeConflictFlags(flags)
    };
  });
}

function topAssetBreakdown(rows: CongressTransactionRow[]): JsonRecord[] {
  const grouped = new Map<string, { count: number; amount: number; members: Set<string> }>();

  for (const row of rows) {
    const assetName = row.asset_name?.trim() || "Unlabeled asset";
    const existing = grouped.get(assetName) ?? { count: 0, amount: 0, members: new Set<string>() };
    existing.count += 1;
    existing.amount += nonNegativeNumber(row.amount_mid);

    if (row.member_name) {
      existing.members.add(row.member_name);
    }

    grouped.set(assetName, existing);
  }

  return [...grouped.entries()]
    .sort((left, right) => right[1].amount - left[1].amount || right[1].count - left[1].count)
    .slice(0, 5)
    .map(([assetName, summary]) => ({
      assetName,
      transactionCount: summary.count,
      totalAmountMid: roundNumber(summary.amount, 2),
      memberCount: summary.members.size
    }));
}

function formatSectorFlow(row: CongressSectorFlowRow): JsonRecord {
  return {
    sector: row.sector ?? "UNRESOLVED",
    transactionCount: Number(row.transaction_count ?? 0),
    purchaseCount: Number(row.purchase_count ?? 0),
    saleCount: Number(row.sale_count ?? 0),
    totalAmountMid: roundNumber(nonNegativeNumber(row.total_amount_mid), 2),
    purchaseAmountMid: roundNumber(nonNegativeNumber(row.purchase_amount_mid), 2),
    saleAmountMid: roundNumber(nonNegativeNumber(row.sale_amount_mid), 2),
    netAmountMid: roundNumber(Number(row.net_amount_mid ?? 0), 2),
    democraticPurchaseAmountMid: roundNumber(
      nonNegativeNumber(row.democratic_purchase_amount_mid),
      2
    ),
    republicanPurchaseAmountMid: roundNumber(
      nonNegativeNumber(row.republican_purchase_amount_mid),
      2
    )
  };
}

function formatTickerFlow(row: CongressTickerFlowRow): JsonRecord {
  return {
    ...formatSectorFlow(row),
    ticker: row.ticker,
    democraticPurchaseCount: Number(row.democratic_purchase_count ?? 0),
    republicanPurchaseCount: Number(row.republican_purchase_count ?? 0),
    democraticMemberCount: Number(row.democratic_member_count ?? 0),
    republicanMemberCount: Number(row.republican_member_count ?? 0),
    bipartisanBuyAmountMid: roundNumber(nonNegativeNumber(row.bipartisan_buy_amount_mid), 2)
  };
}

function rollingWindowStart(days: number): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  return start.toISOString();
}

function normalizePeriod(value: string | null): CongressPeriod {
  const normalized = value?.trim().toLowerCase();

  if (
    normalized === "24h" ||
    normalized === "7d" ||
    normalized === "30d" ||
    normalized === "90d" ||
    normalized === "ytd" ||
    normalized === "all"
  ) {
    return normalized;
  }

  return "24h";
}

function normalizePeriodBasis(value: string | null): CongressPeriodBasis {
  return value === "transaction_date" ? "transaction_date" : "created_at";
}

function congressWindow(
  period: CongressPeriod,
  basis: CongressPeriodBasis
): { whereSql: string; params: string[]; windowStart: string | null } {
  if (period === "all") {
    return { whereSql: "1 = 1", params: [], windowStart: null };
  }

  const now = new Date();
  const start = new Date(now);

  if (period === "24h") {
    start.setUTCDate(start.getUTCDate() - 1);
  } else if (period === "7d") {
    start.setUTCDate(start.getUTCDate() - 7);
  } else if (period === "30d") {
    start.setUTCDate(start.getUTCDate() - 30);
  } else if (period === "90d") {
    start.setUTCDate(start.getUTCDate() - 90);
  } else {
    start.setUTCMonth(0, 1);
    start.setUTCHours(0, 0, 0, 0);
  }

  return {
    whereSql: `${basis} IS NOT NULL AND datetime(${basis}) >= datetime(?)`,
    params: [start.toISOString()],
    windowStart: start.toISOString()
  };
}

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function count(env: Env, tableName: string): Promise<CountRow> {
  const row = await congressDb(env)
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .first<CountRow>();
  return { count: row?.count ?? 0 };
}

function addStringFilter(
  clauses: string[],
  params: unknown[],
  column: string,
  value: string | null
): void {
  const cleaned = value?.trim();

  if (cleaned) {
    clauses.push(`${column} = ?`);
    params.push(column === "chamber" ? cleaned.toLowerCase() : cleaned.toUpperCase());
  }
}

function addLikeFilter(
  clauses: string[],
  params: unknown[],
  column: string,
  value: string | null
): void {
  const cleaned = value?.trim();

  if (cleaned) {
    clauses.push(`${column} LIKE ?`);
    params.push(`%${cleaned}%`);
  }
}

function addDateRangeFilter(clauses: string[], params: unknown[], column: string, url: URL): void {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (from) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }

  if (to) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
}

function limitParam(url: URL): number {
  return clampLimit(Number(url.searchParams.get("limit")), DEFAULT_PAGE_LIMIT);
}

function offsetParam(url: URL): number {
  const parsed = Number(url.searchParams.get("offset"));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function clampLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_PAGE_LIMIT);
}

function calculatePnl(
  transaction: CongressTransactionRow,
  currentPrice: number,
  transactionPrice: number | null
): number | null {
  if (!transactionPrice || !transaction.amount_mid) {
    return null;
  }

  const direction = transactionDirection(transaction.transaction_type);

  if (direction === 0) {
    return null;
  }

  return roundNumber(
    transaction.amount_mid * direction * ((currentPrice - transactionPrice) / transactionPrice),
    2
  );
}

function calculateReturnPct(
  transactionType: string,
  currentPrice: number,
  transactionPrice: number | null
): number | null {
  if (!transactionPrice) {
    return null;
  }

  const direction = transactionDirection(transactionType);

  if (direction === 0) {
    return null;
  }

  return roundNumber(direction * ((currentPrice - transactionPrice) / transactionPrice) * 100, 4);
}

function transactionDirection(transactionType: string): 1 | -1 | 0 {
  const normalized = transactionType.trim().toUpperCase();

  if (["P", "BUY", "PURCHASE", "PURCHASED"].includes(normalized)) {
    return 1;
  }

  if (["S", "SELL", "SALE", "SOLD"].includes(normalized)) {
    return -1;
  }

  return 0;
}

function normalizeSource(value: unknown): string {
  if (typeof value !== "string") {
    return "all";
  }

  const normalized = value.trim().toLowerCase();
  return ["house", "senate", "all"].includes(normalized) ? normalized : "all";
}

function normalizeChamber(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  return ["house", "senate"].includes(normalized) ? normalized : "unknown";
}

function normalizeSeverity(value: unknown): string {
  if (typeof value !== "string") {
    return "WARN";
  }

  const normalized = value.trim().toUpperCase();
  return ["INFO", "WARN", "ERROR", "CRITICAL"].includes(normalized) ? normalized : "WARN";
}

function normalizeTransactionType(value: unknown): string {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized.slice(0, 48) : "UNKNOWN";
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nullableDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

async function stableId(prefix: string, payload: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(`${prefix}:${stringifyJson(payload)}`);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = Array.from(new Uint8Array(hash));
  return `${prefix}_${bytes
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)}`;
}

function schemaUnavailable(error: unknown): Response {
  return json(
    {
      ok: false,
      error: "Congress tracker schema is unavailable. Apply migrations before using this endpoint.",
      detail: errorMessage(error)
    },
    503
  );
}

function localTimeParts(
  date: Date,
  timeZone: string
): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    date: `${lookup.get("year")}-${lookup.get("month")}-${lookup.get("day")}`,
    hour: lookup.get("hour") ?? "00",
    minute: lookup.get("minute") ?? "00"
  };
}

function roundNumber(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function congressDb(env: Env): D1Database {
  return env.CONGRESS_DB ?? env.TRADING_DB;
}

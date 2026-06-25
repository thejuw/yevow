"use client";

import {
  DatabaseZap,
  Flame,
  KeyRound,
  Landmark,
  Lock,
  RadioTower,
  RefreshCcw,
  Search,
  ShieldAlert,
  TrendingUp
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_API_BASE,
  SovereignApiError,
  backfillCongressOptions,
  login,
  readCongressMacroHeatmap,
  readCongressRuns,
  readCongressStatus,
  readCongressTickerHierarchy,
  readCongressTransactions,
  refreshCongressPnl,
  triggerCongressRun
} from "@/lib/api";
import type {
  CongressPeriod,
  CongressMacroFlow,
  CongressMacroHeatmapResponse,
  CongressRun,
  CongressStatusResponse,
  CongressTickerHierarchyItem,
  CongressTickerHierarchyResponse,
  CongressTransaction,
  CongressTransactionsResponse
} from "@/lib/types";

type ConnectionStatus = "LOCKED" | "AUTHENTICATED" | "LOADING" | "ERROR";

interface MemberTransactionBatch {
  key: string;
  memberName: string;
  chamber: string;
  transactionCount: number;
  purchaseCount: number;
  saleCount: number;
  exchangeCount: number;
  totalAmountMid: number;
  pnlEstimate: number;
  conflictFlagCount: number;
  latestTransactionDate: string | null;
  sourceUrls: string[];
  transactions: CongressTransaction[];
}

type CopyPortfolioPeriod = "30d" | "90d" | "180d" | "12m" | "all";

interface CopyPortfolioHolding {
  symbol: string;
  displayName: string;
  sector: string;
  transactionCount: number;
  latestBuyDate: string | null;
  disclosedMidpoint: number;
  weightPct: number;
  allocation: number;
  markedAllocation: number;
  estimatedValue: number | null;
  estimatedPnl: number | null;
  returnPct: number | null;
}

interface CopyPortfolioModel {
  memberName: string;
  chamber: string;
  periodLabel: string;
  capital: number;
  buyCount: number;
  skippedCount: number;
  disclosedMidpoint: number;
  markedAllocation: number;
  estimatedValue: number | null;
  estimatedPnl: number | null;
  returnPct: number | null;
  holdings: CopyPortfolioHolding[];
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

const PERIOD_OPTIONS: CongressPeriod[] = ["24h", "7d", "30d", "90d", "ytd", "all"];
const TRANSACTION_PAGE_SIZE = 250;
const TRANSACTION_LOAD_LIMIT = 2_000;
const COPY_PORTFOLIO_PERIODS: Array<{ label: string; value: CopyPortfolioPeriod }> = [
  { label: "30D", value: "30d" },
  { label: "90D", value: "90d" },
  { label: "6M", value: "180d" },
  { label: "12M", value: "12m" },
  { label: "ALL", value: "all" }
];

export default function CongressTrackerPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("LOCKED");
  const [error, setError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [tracker, setTracker] = useState<CongressStatusResponse | null>(null);
  const [runs, setRuns] = useState<CongressRun[]>([]);
  const [transactions, setTransactions] = useState<CongressTransaction[]>([]);
  const [macroHeatmap, setMacroHeatmap] = useState<CongressMacroHeatmapResponse | null>(null);
  const [tickerHierarchy, setTickerHierarchy] = useState<CongressTickerHierarchyResponse | null>(
    null
  );
  const [tickerPeriod, setTickerPeriod] = useState<CongressPeriod>("all");
  const [copyMemberKey, setCopyMemberKey] = useState("");
  const [copyPeriod, setCopyPeriod] = useState<CopyPortfolioPeriod>("12m");
  const [copyCapital, setCopyCapital] = useState("10000");
  const [query, setQuery] = useState("");
  const isUnlocked = Boolean(token);

  const filteredTransactions = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return transactions;
    }

    return transactions.filter((row) =>
      [
        row.member_name,
        row.symbol,
        displayInstrument(row),
        row.asset_name,
        row.transaction_type,
        row.instrument_type,
        row.option_underlying,
        row.option_exposure,
        row.chamber,
        row.member_party,
        row.security_sector,
        ...(row.conflict_flags ?? []).map((flag) => `${flag.sector} ${flag.committeeName}`)
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [query, transactions]);
  const memberBatches = useMemo(
    () => buildMemberBatches(filteredTransactions),
    [filteredTransactions]
  );
  const allMemberBatches = useMemo(() => buildMemberBatches(transactions), [transactions]);
  const normalizedCopyCapital = useMemo(() => normalizeCapital(copyCapital), [copyCapital]);
  const copyPortfolio = useMemo(
    () =>
      buildCopyPortfolio({
        batches: allMemberBatches,
        capital: normalizedCopyCapital,
        memberKey: copyMemberKey,
        period: copyPeriod
      }),
    [allMemberBatches, copyMemberKey, copyPeriod, normalizedCopyCapital]
  );

  useEffect(() => {
    if (allMemberBatches.length === 0) {
      if (copyMemberKey) {
        setCopyMemberKey("");
      }
      return;
    }

    if (!copyMemberKey || !allMemberBatches.some((batch) => batch.key === copyMemberKey)) {
      setCopyMemberKey(allMemberBatches[0].key);
    }
  }, [allMemberBatches, copyMemberKey]);

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    setStatus("LOADING");
    setError(null);

    try {
      const [statusResult, runsResult, transactionsResult, tickerResult, macroResult] =
        await Promise.all([
          readCongressStatus(apiBase, token),
          readCongressRuns(apiBase, token, 8),
          readCongressTransactions(apiBase, token, TRANSACTION_PAGE_SIZE),
          readCongressTickerHierarchy(apiBase, token, tickerPeriod),
          readCongressMacroHeatmap(apiBase, token, 14)
        ]);

      if (!statusResult.ok) {
        throw new Error(
          readApiError(statusResult) ?? "Congress tracker schema is not available yet."
        );
      }

      setTracker(statusResult);
      setRuns(runsResult.ok ? runsResult.runs : []);
      const loadedTransactions = (transactionsResult as CongressTransactionsResponse).ok
        ? await loadCongressTransactionPages(apiBase, token, transactionsResult)
        : [];
      setTransactions(loadedTransactions);
      setTickerHierarchy(tickerResult.ok ? tickerResult : null);
      setMacroHeatmap(macroResult.ok ? macroResult : null);
      setStatus("AUTHENTICATED");
    } catch (caught: unknown) {
      if (caught instanceof SovereignApiError && [401, 403].includes(caught.status)) {
        expireSession("Session expired. Unlock the tracker again.");
        return;
      }

      setError(errorMessage(caught));
      setStatus("ERROR");
    }
  }, [apiBase, tickerPeriod, token]);

  useEffect(() => {
    const savedToken = localStorage.getItem("sovereign.jwt");
    const savedBase = localStorage.getItem("sovereign.apiBase");

    if (savedBase) {
      setApiBase(savedBase);
    }

    if (savedToken) {
      setToken(savedToken);
      setStatus("AUTHENTICATED");
    }
  }, []);

  useEffect(() => {
    if (token) {
      void refresh();
    }
  }, [refresh, token]);

  async function handleLogin() {
    setError(null);
    setStatus("LOADING");

    try {
      const response = await login(apiBase, password);
      localStorage.setItem("sovereign.jwt", response.token);
      localStorage.setItem("sovereign.apiBase", apiBase);
      setToken(response.token);
      setStatus("AUTHENTICATED");
      setCommandStatus("Congress Tracker unlocked.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setStatus("ERROR");
    }
  }

  function handleLogout() {
    expireSession(null);
  }

  function expireSession(message: string | null) {
    localStorage.removeItem("sovereign.jwt");
    setToken("");
    setStatus("LOCKED");
    setTracker(null);
    setTransactions([]);
    setRuns([]);
    setTickerHierarchy(null);
    setMacroHeatmap(null);
    setError(message);
  }

  async function submitRun(source: "all" | "house" | "senate") {
    setError(null);
    setCommandStatus(`Requesting ${source} disclosure run...`);

    try {
      const response = await triggerCongressRun(apiBase, token, source);
      await refresh();
      setCommandStatus(response.message);
      if (response.status === "RUNNER_NOTIFY_FAILED") {
        setError(response.error ?? response.message);
      }
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Run request failed.");
    }
  }

  async function submitYearToDateBackfill() {
    const filingYear = new Date().getUTCFullYear();
    setError(null);
    setCommandStatus(`Requesting ${filingYear} year-to-date disclosure backfill...`);

    try {
      const response = await triggerCongressRun(apiBase, token, "all", {
        filingYear,
        maxDownloadsPerSource: 1000,
        reason: "command-center-ytd-backfill"
      });
      await refresh();
      setCommandStatus(response.message);
      if (response.status === "RUNNER_NOTIFY_FAILED") {
        setError(response.error ?? response.message);
      }
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("YTD backfill request failed.");
    }
  }

  async function submitPnlRefresh() {
    setError(null);
    setCommandStatus("Refreshing Congressional transaction price marks...");

    try {
      const response = await refreshCongressPnl(apiBase, token, 100);
      await refresh();
      setCommandStatus(
        `Price mark refresh complete: ${response.refreshed} updated, ${response.failed} failed.`
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Price mark refresh failed.");
    }
  }

  async function submitOptionBackfill() {
    setError(null);
    setCommandStatus("Decoding stored option disclosures...");

    try {
      const response = await backfillCongressOptions(apiBase, token, 500);
      await refresh();
      setCommandStatus(
        `Option decoder backfill complete: ${String(response.decoded ?? 0)} decoded from ${String(
          response.scanned ?? 0
        )} scanned rows.`
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Option decoder backfill failed.");
    }
  }

  if (!isUnlocked) {
    return (
      <main className="login-shell">
        <section className="login-panel glass">
          <div className="brand-lockup">
            <div className="sigil">
              <Landmark size={22} />
            </div>
            <div>
              <h1>Sovereign-Sigma</h1>
              <p>Congressional Stock Tracker</p>
            </div>
          </div>

          <div className="login-copy">
            <strong>Research data gate</strong>
            <span>Authenticate to review official PTR filings and estimated disclosure PnL.</span>
          </div>

          <form
            className="auth-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLogin();
            }}
          >
            <label>
              API
              <input value={apiBase} onChange={(event) => setApiBase(event.target.value)} />
            </label>
            <label>
              Admin Password
              <input
                value={password}
                type="password"
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="primary-action" disabled={!password.trim()} type="submit">
              <KeyRound size={16} />
              Unlock Tracker
            </button>
          </form>

          <StatusPill status={status} />
          {error ? <Fault message={error} /> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="settings-shell congress-shell">
      <section className="settings-hero glass">
        <div className="brand-lockup">
          <div className="sigil">
            <Landmark size={22} />
          </div>
          <div>
            <h1>Sovereign-Sigma</h1>
            <p>Congressional Stock Tracker</p>
          </div>
        </div>
        <div className="settings-nav">
          <a href="/">Command Center</a>
          <a href="/congress-alpha">
            <TrendingUp size={16} />
            Alpha Bot
          </a>
          <a href="/settings">Settings</a>
          <a href="/equity">
            <Landmark size={16} />
            Equity
          </a>
          <button onClick={() => void refresh()}>
            <RefreshCcw size={16} />
            Refresh
          </button>
          <button onClick={handleLogout}>
            <Lock size={16} />
            Lock
          </button>
        </div>
      </section>

      <section className="congress-warning glass">
        <strong>Research-only disclosure intelligence.</strong>
        <span>
          PnL is estimated from public transaction amount bands and free end-of-day market data. It
          is useful for directional monitoring, not tax, compliance, or execution accounting.
        </span>
      </section>

      <section className="congress-grid">
        <MetricCard
          icon={<RadioTower size={18} />}
          label="Runner"
          value={tracker?.tracker.runnerConfigured ? "CONFIGURED" : "PENDING"}
          hint={`Midnight scheduler: ${tracker?.tracker.schedulerTimezone ?? "America/Chicago"}`}
        />
        <MetricCard
          icon={<DatabaseZap size={18} />}
          label="Transactions"
          value={compact.format(tracker?.counts.transactions ?? 0)}
          hint={`${compact.format(tracker?.counts.markedTransactions ?? 0)} price-marked`}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          label="Estimated PnL"
          value={currency.format(tracker?.pnl.totalEstimate ?? 0)}
          hint={`${compact.format(tracker?.pnl.averageReturnPct ?? 0)}% average marked return`}
        />
        <MetricCard
          icon={<Search size={18} />}
          label="Conflict Flags"
          value={compact.format(tracker?.counts.flaggedTransactions ?? 0)}
          hint={`${compact.format(tracker?.counts.highConflictFlags ?? 0)} high severity · ${compact.format(
            tracker?.counts.conflictFlags ?? 0
          )} total flags`}
        />
      </section>

      <MacroHeatmapPanel heatmap={macroHeatmap} />

      <CopyPortfolioPanel
        batches={allMemberBatches}
        capital={copyCapital}
        model={copyPortfolio}
        period={copyPeriod}
        selectedMemberKey={copyMemberKey}
        onCapitalChange={setCopyCapital}
        onMemberChange={setCopyMemberKey}
        onPeriodChange={setCopyPeriod}
      />

      <section className="settings-panel settings-panel-wide glass congress-ledger-panel">
        <div className="congress-table-header">
          <div className="panel-title">
            <Landmark size={17} />
            <span>Transaction Ledger</span>
            <strong className="panel-pill">
              {compact.format(memberBatches.length)} members ·{" "}
              {compact.format(filteredTransactions.length)} rows
            </strong>
          </div>
          <label className="congress-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="Filter member, ticker, chamber..."
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        <MemberLedger batches={memberBatches} />
      </section>

      <section className="settings-panel settings-panel-wide glass congress-hierarchy-panel">
        <div className="congress-table-header">
          <div className="panel-title">
            <TrendingUp size={17} />
            <span>Stock Interface</span>
          </div>
          <label className="congress-period-select">
            Window
            <select
              value={tickerPeriod}
              onChange={(event) => setTickerPeriod(event.target.value as CongressPeriod)}
            >
              {PERIOD_OPTIONS.map((period) => (
                <option key={period} value={period}>
                  {period.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
        <TickerHierarchy hierarchy={tickerHierarchy} />
      </section>

      <section className="settings-grid">
        <section className="settings-panel glass">
          <div className="panel-title">
            <RadioTower size={17} />
            <span>Run Control</span>
          </div>
          <div className="congress-actions">
            <button onClick={() => void submitRun("all")}>Run All</button>
            <button onClick={() => void submitRun("house")}>House</button>
            <button onClick={() => void submitRun("senate")}>Senate</button>
            <button onClick={() => void submitYearToDateBackfill()}>Backfill YTD</button>
            <button onClick={() => void submitOptionBackfill()}>Decode Options</button>
            <button className="primary-action" onClick={() => void submitPnlRefresh()}>
              Refresh PnL
            </button>
          </div>
          <div className="settings-metrics">
            <SmallMetric label="Enabled" value={tracker?.tracker.enabled ? "YES" : "NO"} />
            <SmallMetric
              label="Raw Archive"
              value={tracker?.tracker.rawArchiveConfigured ? "R2" : "NOT SET"}
            />
            <SmallMetric label="Price Source" value={tracker?.tracker.priceProvider ?? "n/a"} />
          </div>
          <StatusPill status={status} />
          {commandStatus ? <CommandMessage message={commandStatus} /> : null}
          {error ? <Fault message={error} /> : null}
        </section>

        <section className="settings-panel glass">
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Latest Runs</span>
          </div>
          <div className="congress-run-list">
            {runs.length === 0 ? <span className="muted">No runs recorded yet.</span> : null}
            {runs.map((run) => (
              <div className="congress-run-row" key={run.run_id}>
                <strong>{run.status}</strong>
                <span>{run.source.toUpperCase()}</span>
                <span>{formatDateTime(run.created_at)}</span>
                {run.error_message ? <small>{run.error_message}</small> : null}
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

async function loadCongressTransactionPages(
  apiBase: string,
  token: string,
  firstPage: CongressTransactionsResponse
): Promise<CongressTransaction[]> {
  const transactions = [...firstPage.transactions];
  let offset = firstPage.offset + firstPage.transactions.length;

  while (
    firstPage.ok &&
    firstPage.transactions.length === firstPage.limit &&
    transactions.length < TRANSACTION_LOAD_LIMIT
  ) {
    const nextPage = await readCongressTransactions(apiBase, token, TRANSACTION_PAGE_SIZE, offset);

    if (!nextPage.ok || nextPage.transactions.length === 0) {
      break;
    }

    transactions.push(...nextPage.transactions);
    offset += nextPage.transactions.length;

    if (nextPage.transactions.length < nextPage.limit) {
      break;
    }
  }

  return transactions.slice(0, TRANSACTION_LOAD_LIMIT);
}

function MemberLedger({ batches }: { batches: MemberTransactionBatch[] }) {
  if (batches.length === 0) {
    return <div className="ticker-hierarchy-empty">No Congressional transactions loaded yet.</div>;
  }

  return (
    <div className="congress-member-stack">
      {batches.map((batch) => (
        <MemberBatchRow batch={batch} defaultOpen={false} key={batch.key} />
      ))}
    </div>
  );
}

function MemberBatchRow({
  batch,
  defaultOpen
}: {
  batch: MemberTransactionBatch;
  defaultOpen: boolean;
}) {
  const positive = batch.pnlEstimate >= 0;

  return (
    <details className="congress-member-batch" open={defaultOpen}>
      <summary className="congress-member-summary">
        <strong>{batch.memberName}</strong>
        <span>{batch.chamber.toUpperCase()}</span>
        <code>{compact.format(batch.transactionCount)} txns</code>
        <code>{currency.format(batch.totalAmountMid)}</code>
        {batch.conflictFlagCount > 0 ? (
          <span className="conflict-summary-pill">
            <ShieldAlert size={13} />
            {compact.format(batch.conflictFlagCount)}
          </span>
        ) : null}
        <span>
          {compact.format(batch.purchaseCount)} buys · {compact.format(batch.saleCount)} sells
        </span>
        <span>{formatDate(batch.latestTransactionDate)}</span>
      </summary>

      <div className="member-detail-grid">
        <SmallMetric label="Purchases" value={compact.format(batch.purchaseCount)} />
        <SmallMetric label="Sales" value={compact.format(batch.saleCount)} />
        <SmallMetric label="Exchanges" value={compact.format(batch.exchangeCount)} />
        <SmallMetric label="Disclosed Midpoint" value={currency.format(batch.totalAmountMid)} />
        <SmallMetric
          label="Estimated PnL"
          value={
            positive
              ? currency.format(batch.pnlEstimate)
              : `-${currency.format(Math.abs(batch.pnlEstimate))}`
          }
        />
        <SmallMetric label="Conflict Flags" value={compact.format(batch.conflictFlagCount)} />
        <SmallMetric label="Latest Txn" value={formatDate(batch.latestTransactionDate)} />
      </div>

      <div className="member-filing-links">
        {batch.sourceUrls.slice(0, 4).map((url, index) => (
          <a href={url} key={url} target="_blank" rel="noreferrer">
            Filing {index + 1}
          </a>
        ))}
      </div>

      <div className="member-transaction-list">
        {batch.transactions.map((row) => (
          <TransactionCard key={row.transaction_id} row={row} />
        ))}
      </div>
    </details>
  );
}

function TransactionCard({ row }: { row: CongressTransaction }) {
  const pnl = row.pnl_estimate ?? 0;
  const positive = pnl >= 0;
  const conflictFlags = row.conflict_flags ?? [];
  const hasConflict = conflictFlags.length > 0;
  const optionDecoder = row.option_decoder ?? null;
  const isOption = row.instrument_type === "OPTION" || Boolean(optionDecoder);

  return (
    <article
      className={
        hasConflict ? "congress-transaction-card conflict-flagged" : "congress-transaction-card"
      }
    >
      <div>
        <strong>
          {hasConflict ? (
            <span
              className={`conflict-icon ${String(row.conflict_highest_severity ?? "LOW").toLowerCase()}`}
              title={conflictFlags.map((flag) => flag.reason).join("\n")}
            >
              <ShieldAlert size={14} />
            </span>
          ) : null}
          {row.member_name ?? "Unknown"}
        </strong>
        <span>{row.asset_name ?? "Unlabeled asset"}</span>
      </div>
      <code>{optionDecoder?.shortLabel ?? displayInstrument(row)}</code>
      <span className={isOption ? "instrument-pill option" : "instrument-pill"}>
        {isOption ? "OPTION" : "EQUITY"}
      </span>
      <span>{row.transaction_type}</span>
      <span>{formatDate(row.transaction_date)}</span>
      <span>{formatAmountBand(row)}</span>
      <strong className={positive ? "positive" : "negative"}>
        {isOption
          ? `Underlying ${percentOrDash(row.return_pct)}`
          : moneyOrDash(row.pnl_estimate)}
      </strong>
      {optionDecoder ? (
        <div className={`option-decoder-strip ${optionDecoder.exposure.toLowerCase()}`}>
          <span>Option Decoder</span>
          <strong>
            {optionDecoder.isLeap ? "LEAPS · " : ""}
            {optionDecoder.optionType} · {optionDecoder.exposure.replaceAll("_", " ")}
          </strong>
          <small>{optionDecoder.plainEnglish}</small>
          <em>{optionDecoder.caveat}</em>
        </div>
      ) : null}
      {hasConflict ? (
        <div className="conflict-detail-strip">
          {conflictFlags.slice(0, 2).map((flag) => (
            <span key={flag.flagId}>
              {flag.severity} · {flag.sector} · {flag.committeeName}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function CopyPortfolioPanel({
  batches,
  capital,
  model,
  period,
  selectedMemberKey,
  onCapitalChange,
  onMemberChange,
  onPeriodChange
}: {
  batches: MemberTransactionBatch[];
  capital: string;
  model: CopyPortfolioModel | null;
  period: CopyPortfolioPeriod;
  selectedMemberKey: string;
  onCapitalChange: (value: string) => void;
  onMemberChange: (value: string) => void;
  onPeriodChange: (value: CopyPortfolioPeriod) => void;
}) {
  const coveragePct =
    model && model.capital > 0 ? Math.min(100, (model.markedAllocation / model.capital) * 100) : 0;
  const pnlPositive = (model?.estimatedPnl ?? 0) >= 0;

  return (
    <section className="settings-panel settings-panel-wide glass copy-portfolio-panel">
      <div className="congress-table-header">
        <div className="panel-title">
          <TrendingUp size={17} />
          <span>Copy Portfolio Generator</span>
          <strong className="panel-pill">Fintech Mock Allocation</strong>
        </div>
        <span className="macro-generated">
          Stock buys only · midpoint weighted · research simulation
        </span>
      </div>

      <div className="copy-portfolio-controls">
        <label>
          Politician
          <select
            value={selectedMemberKey}
            onChange={(event) => onMemberChange(event.target.value)}
          >
            {batches.length === 0 ? <option value="">No members loaded</option> : null}
            {batches.map((batch) => (
              <option key={batch.key} value={batch.key}>
                {batch.memberName} · {batch.chamber.toUpperCase()} ·{" "}
                {compact.format(batch.purchaseCount)} buys
              </option>
            ))}
          </select>
        </label>
        <label>
          Lookback
          <select
            value={period}
            onChange={(event) => onPeriodChange(event.target.value as CopyPortfolioPeriod)}
          >
            {COPY_PORTFOLIO_PERIODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mock Capital
          <input
            min="100"
            max="10000000"
            step="100"
            inputMode="decimal"
            value={capital}
            onChange={(event) => onCapitalChange(event.target.value)}
          />
        </label>
      </div>

      {!model ? (
        <div className="ticker-hierarchy-empty">
          Select a member with resolved stock purchase disclosures to generate a mock portfolio.
        </div>
      ) : (
        <>
          <div className="copy-portfolio-summary">
            <SmallMetric label="Member" value={model.memberName} />
            <SmallMetric label="Window" value={model.periodLabel} />
            <SmallMetric label="Mock Capital" value={currency.format(model.capital)} />
            <SmallMetric
              label="Disclosed Buy Basis"
              value={currency.format(model.disclosedMidpoint)}
            />
            <SmallMetric label="Eligible Buys" value={compact.format(model.buyCount)} />
            <SmallMetric label="Skipped Rows" value={compact.format(model.skippedCount)} />
            <SmallMetric
              label="Estimated Value"
              value={
                model.estimatedValue === null ? "unmarked" : currency.format(model.estimatedValue)
              }
            />
            <SmallMetric
              label="Estimated PnL"
              value={
                model.estimatedPnl === null
                  ? "unmarked"
                  : pnlPositive
                    ? currency.format(model.estimatedPnl)
                    : `-${currency.format(Math.abs(model.estimatedPnl))}`
              }
            />
          </div>

          <div className="copy-portfolio-coverage">
            <span>Price mark coverage</span>
            <i>
              <b style={{ width: `${Math.max(2, coveragePct)}%` }} />
            </i>
            <code>
              {compact.format(coveragePct)}% · {currency.format(model.markedAllocation)} marked
            </code>
          </div>

          <div className="copy-portfolio-table">
            <div className="copy-portfolio-row header">
              <span>Ticker</span>
              <span>Allocation</span>
              <span>Weight</span>
              <span>Marked Return</span>
              <span>Est. PnL</span>
              <span>Latest Buy</span>
            </div>
            {model.holdings.map((holding) => (
              <CopyPortfolioHoldingRow holding={holding} key={holding.symbol} />
            ))}
          </div>
        </>
      )}

      <p className="copy-portfolio-note">
        This is a hypothetical basket built from public PTR purchase rows. It excludes options,
        unresolved tickers, sales, exchanges, fixed income, and private funds. Disclosed amount
        bands are approximated with midpoint values.
      </p>
    </section>
  );
}

function CopyPortfolioHoldingRow({ holding }: { holding: CopyPortfolioHolding }) {
  const pnlPositive = (holding.estimatedPnl ?? 0) >= 0;

  return (
    <div className="copy-portfolio-row">
      <div>
        <a
          className="ticker-news-link"
          href={yahooNewsUrl(holding.symbol)}
          target="_blank"
          rel="noreferrer"
          title={`Open ${holding.symbol} news on Yahoo Finance`}
        >
          {holding.symbol}
        </a>
        <span>{holding.displayName}</span>
        <small>{holding.sector}</small>
      </div>
      <code>{currency.format(holding.allocation)}</code>
      <span className="ticker-weight">
        <i style={{ width: `${Math.min(100, Math.max(2, holding.weightPct))}%` }} />
      </span>
      <code>{holding.returnPct === null ? "unmarked" : percentOrDash(holding.returnPct)}</code>
      <strong className={pnlPositive ? "positive" : "negative"}>
        {holding.estimatedPnl === null
          ? "unmarked"
          : pnlPositive
            ? currency.format(holding.estimatedPnl)
            : `-${currency.format(Math.abs(holding.estimatedPnl))}`}
      </strong>
      <span>
        {formatDate(holding.latestBuyDate)} · {compact.format(holding.transactionCount)} buys
      </span>
    </div>
  );
}

function MacroHeatmapPanel({ heatmap }: { heatmap: CongressMacroHeatmapResponse | null }) {
  const selectedWindow =
    heatmap?.windows.find((window) => window.days === 30) ?? heatmap?.windows[0];
  const sectors = selectedWindow?.sectors ?? [];
  const consensus = heatmap?.bipartisanConsensus.tickers ?? [];

  return (
    <section className="settings-panel settings-panel-wide glass macro-heatmap-panel">
      <div className="congress-table-header">
        <div className="panel-title">
          <Flame size={17} />
          <span>Macro Heatmaps</span>
          <strong className="panel-pill">Follow the Money</strong>
        </div>
        <span className="macro-generated">
          {heatmap ? `Updated ${formatDateTime(heatmap.generatedAt)}` : "Waiting for macro data"}
        </span>
      </div>

      <div className="macro-heatmap-grid">
        <section className="macro-card consensus-card">
          <div className="macro-card-header">
            <span>Bipartisan Consensus Picks</span>
            <code>90D</code>
          </div>
          {consensus.length === 0 ? (
            <div className="ticker-hierarchy-empty">
              No bipartisan purchase consensus yet. Run the Congress tracker again to ingest party
              metadata.
            </div>
          ) : (
            <div className="consensus-stack">
              {consensus.slice(0, 8).map((item) => (
                <MacroTickerRow item={item} key={`${item.ticker}-${item.sector}`} />
              ))}
            </div>
          )}
        </section>

        <section className="macro-card">
          <div className="macro-card-header">
            <span>Sector Rotation</span>
            <code>{selectedWindow ? `${selectedWindow.days}D` : "30D"}</code>
          </div>
          {sectors.length === 0 ? (
            <div className="ticker-hierarchy-empty">No sector flow loaded for this window.</div>
          ) : (
            <div className="sector-heatmap-stack">
              {sectors.slice(0, 10).map((sector) => (
                <SectorHeatRow sector={sector} key={sector.sector} />
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="macro-window-strip">
        {(heatmap?.windows ?? []).map((window) => {
          const topSector = window.sectors[0];
          return (
            <div className="macro-window-card" key={window.days}>
              <span>{window.days}D</span>
              <strong>{topSector?.sector ?? "NO DATA"}</strong>
              <code>{moneyOrDash(topSector?.netAmountMid ?? null)} net</code>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MacroTickerRow({ item }: { item: CongressMacroFlow }) {
  const total = Math.max(
    1,
    (item.democraticPurchaseAmountMid ?? 0) + (item.republicanPurchaseAmountMid ?? 0)
  );
  const democraticPct = ((item.democraticPurchaseAmountMid ?? 0) / total) * 100;
  const republicanPct = ((item.republicanPurchaseAmountMid ?? 0) / total) * 100;

  return (
    <div className="macro-ticker-row">
      <strong>{item.ticker ?? "UNRESOLVED"}</strong>
      <span>{item.sector}</span>
      <div className="party-flow-bar" aria-label="Party purchase split">
        <i className="democratic" style={{ width: `${Math.max(2, democraticPct)}%` }} />
        <i className="republican" style={{ width: `${Math.max(2, republicanPct)}%` }} />
      </div>
      <code>{currency.format(item.bipartisanBuyAmountMid ?? item.purchaseAmountMid)}</code>
      <small>
        D {currency.format(item.democraticPurchaseAmountMid)} · R{" "}
        {currency.format(item.republicanPurchaseAmountMid)}
      </small>
    </div>
  );
}

function SectorHeatRow({ sector }: { sector: CongressMacroFlow }) {
  const net = sector.netAmountMid;
  const positive = net >= 0;
  const maxSide = Math.max(1, sector.purchaseAmountMid, sector.saleAmountMid);

  return (
    <div className={positive ? "sector-heat-row buying" : "sector-heat-row selling"}>
      <div>
        <strong>{sector.sector}</strong>
        <span>
          {compact.format(sector.purchaseCount)} buys · {compact.format(sector.saleCount)} sells
        </span>
      </div>
      <div className="sector-flow-bars">
        <i
          className="buy"
          style={{ width: `${Math.max(2, (sector.purchaseAmountMid / maxSide) * 100)}%` }}
        />
        <i
          className="sell"
          style={{ width: `${Math.max(2, (sector.saleAmountMid / maxSide) * 100)}%` }}
        />
      </div>
      <code>{positive ? currency.format(net) : `-${currency.format(Math.abs(net))}`}</code>
    </div>
  );
}

function TickerHierarchy({ hierarchy }: { hierarchy: CongressTickerHierarchyResponse | null }) {
  if (!hierarchy || hierarchy.tickers.length === 0) {
    return (
      <div className="ticker-hierarchy-empty">
        No Congressional ticker hierarchy for this window yet.
      </div>
    );
  }

  return (
    <div className="ticker-hierarchy-stack">
      <div className="ticker-hierarchy-note">
        <span>
          Ranked by disclosed midpoint over {hierarchy.period.toUpperCase()} ·{" "}
          {currency.format(hierarchy.totalAmountMid)} notional ·{" "}
          {compact.format(hierarchy.totalTransactions)} transactions
        </span>
      </div>
      {hierarchy.tickers.map((item) => (
        <TickerHierarchyRow item={item} key={`${item.rank}-${item.ticker}`} />
      ))}
    </div>
  );
}

function TickerHierarchyRow({ item }: { item: CongressTickerHierarchyItem }) {
  const isUnresolved = item.ticker === "UNRESOLVED";
  const positive = item.pnlEstimate >= 0;
  const profile = buildStockProfile(item);

  return (
    <details className={isUnresolved ? "ticker-hierarchy-row unresolved" : "ticker-hierarchy-row"}>
      <summary className="ticker-hierarchy-summary">
        <span className="ticker-rank">#{item.rank}</span>
        {isUnresolved ? (
          <strong>UNRESOLVED</strong>
        ) : (
          <a
            className="ticker-news-link"
            href={yahooNewsUrl(item.ticker)}
            target="_blank"
            rel="noreferrer"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            title={`Open ${item.ticker} news on Yahoo Finance`}
          >
            {item.ticker}
          </a>
        )}
        <span className="ticker-display-name">{item.displayName}</span>
        <span className="ticker-weight">
          <i style={{ width: `${Math.min(100, Math.max(2, item.weightPct))}%` }} />
        </span>
        <span>{compact.format(item.weightPct)}%</span>
        <code>{currency.format(item.totalAmountMid)}</code>
        <span className="ticker-open-hint">Open profile</span>
      </summary>

      <div className="stock-interface">
        <div className="stock-profile-header">
          <div>
            <span className="section-eyebrow">Congress Stock Profile</span>
            <h3>{isUnresolved ? "Unresolved Instruments" : item.ticker}</h3>
            <p>{stockSubtitle(item, profile)}</p>
          </div>
          <div className="stock-price-card">
            <span>Latest Mark</span>
            <strong>{profile.latestPrice === null ? "unmarked" : currency.format(profile.latestPrice)}</strong>
            <small>
              {profile.latestPriceDate ? `as of ${formatDate(profile.latestPriceDate)}` : "price feed pending"}
            </small>
          </div>
        </div>

        <div className="ticker-detail-grid">
          <div className="ticker-detail-card">
            <span>Flow</span>
            <strong>{compact.format(item.transactionCount)} txns</strong>
            <small>
              {compact.format(item.purchaseCount)} buys · {compact.format(item.saleCount)} sells ·{" "}
              {compact.format(item.exchangeCount)} exchanges
            </small>
          </div>
          <div className="ticker-detail-card">
            <span>Directional Midpoint</span>
            <strong>{currency.format(item.netDirectionalAmountMid)}</strong>
            <small>
              Buys {currency.format(item.purchaseAmountMid)} · Sells{" "}
              {currency.format(item.saleAmountMid)}
            </small>
          </div>
          <div className="ticker-detail-card">
            <span>Estimated Mark</span>
            <strong className={positive ? "positive" : "negative"}>
              {currency.format(item.pnlEstimate)}
            </strong>
            <small>{compact.format(item.markedCount)} equity rows with price marks</small>
          </div>
          <div className="ticker-detail-card">
            <span>Options</span>
            <strong>{compact.format(profile.optionCount)}</strong>
            <small>
              {compact.format(profile.bullishOptionCount)} bullish ·{" "}
              {compact.format(profile.bearishOptionCount)} bearish/protective
            </small>
          </div>
        </div>

        <StockFlowChart profile={profile} />

        <div className="stock-detail-columns">
          <div className="ticker-asset-stack">
            {item.topAssets.length === 0 ? (
              <span className="muted">No asset detail attached to this ticker bucket.</span>
            ) : (
              item.topAssets.map((asset) => (
                <div className="ticker-asset-row" key={asset.assetName}>
                  <strong>{asset.assetName}</strong>
                  <span>{currency.format(asset.totalAmountMid)}</span>
                  <code>
                    {compact.format(asset.transactionCount)} txns ·{" "}
                    {compact.format(asset.memberCount)} members
                  </code>
                </div>
              ))
            )}
          </div>

          <div className="ticker-transaction-list">
            {item.transactions.map((row) => (
              <div className="ticker-transaction-row" key={row.transaction_id}>
                <strong>{row.member_name ?? "Unknown"}</strong>
                {(row.conflict_flag_count ?? 0) > 0 ? (
                  <span className="ticker-conflict-pill">
                    <ShieldAlert size={12} />
                    {compact.format(row.conflict_flag_count ?? 0)}
                  </span>
                ) : null}
                <span>{row.instrument_type === "OPTION" ? "OPTION" : row.transaction_type}</span>
                <span>{formatDate(row.transaction_date)}</span>
                <code>{formatAmountBand(row)}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

interface StockFlowPoint {
  date: string;
  buyAmount: number;
  sellAmount: number;
  optionAmount: number;
  netAmount: number;
}

interface StockProfile {
  points: StockFlowPoint[];
  latestPrice: number | null;
  latestPriceDate: string | null;
  latestReturnPct: number | null;
  optionCount: number;
  bullishOptionCount: number;
  bearishOptionCount: number;
  uniqueMembers: number;
  latestTransactionDate: string | null;
}

function StockFlowChart({ profile }: { profile: StockProfile }) {
  if (profile.points.length === 0) {
    return <div className="stock-chart-empty">No dated flow available for this ticker.</div>;
  }

  const maxAmount = Math.max(
    1,
    ...profile.points.map((point) =>
      Math.max(point.buyAmount, point.sellAmount, point.optionAmount, Math.abs(point.netAmount))
    )
  );

  return (
    <div className="stock-chart-card">
      <div className="stock-chart-header">
        <span>Disclosure Flow Chart</span>
        <code>{compact.format(profile.points.length)} sessions</code>
      </div>
      <div className="stock-chart-bars">
        {profile.points.map((point) => (
          <div className="stock-chart-day" key={point.date} title={`${point.date} · net ${currency.format(point.netAmount)}`}>
            <i className="buy" style={{ height: `${Math.max(3, (point.buyAmount / maxAmount) * 100)}%` }} />
            <i className="sell" style={{ height: `${Math.max(3, (point.sellAmount / maxAmount) * 100)}%` }} />
            {point.optionAmount > 0 ? (
              <i className="option" style={{ height: `${Math.max(3, (point.optionAmount / maxAmount) * 100)}%` }} />
            ) : null}
          </div>
        ))}
      </div>
      <div className="stock-chart-legend">
        <span><i className="buy" /> buys</span>
        <span><i className="sell" /> sells</span>
        <span><i className="option" /> options</span>
      </div>
    </div>
  );
}

function buildStockProfile(item: CongressTickerHierarchyItem): StockProfile {
  const points = new Map<string, StockFlowPoint>();
  const members = new Set<string>();
  let latestPrice: number | null = null;
  let latestPriceDate: string | null = null;
  let latestReturnPct: number | null = null;
  let latestTransactionDate: string | null = null;
  let optionCount = 0;
  let bullishOptionCount = 0;
  let bearishOptionCount = 0;

  for (const row of item.transactions) {
    if (row.member_name) {
      members.add(row.member_name);
    }

    if (row.transaction_date && (!latestTransactionDate || row.transaction_date > latestTransactionDate)) {
      latestTransactionDate = row.transaction_date;
    }

    if (typeof row.current_price === "number" && row.current_price_as_of) {
      if (!latestPriceDate || row.current_price_as_of > latestPriceDate) {
        latestPrice = row.current_price;
        latestPriceDate = row.current_price_as_of;
        latestReturnPct = row.return_pct;
      }
    }

    const day = (row.transaction_date ?? row.created_at ?? "").slice(0, 10);
    if (!day) {
      continue;
    }

    const point = points.get(day) ?? {
      date: day,
      buyAmount: 0,
      sellAmount: 0,
      optionAmount: 0,
      netAmount: 0
    };
    const amount = row.amount_mid ?? 0;
    const type = row.transaction_type.trim().toUpperCase();

    if (row.instrument_type === "OPTION" || row.option_decoder) {
      optionCount += 1;
      point.optionAmount += amount;
      if (row.option_exposure === "BULLISH" || row.option_decoder?.exposure === "BULLISH") {
        bullishOptionCount += 1;
        point.buyAmount += amount;
        point.netAmount += amount;
      } else if (
        row.option_exposure === "BEARISH" ||
        row.option_exposure === "HEDGE_OR_PROTECTION" ||
        row.option_decoder?.exposure === "BEARISH" ||
        row.option_decoder?.exposure === "HEDGE_OR_PROTECTION"
      ) {
        bearishOptionCount += 1;
        point.sellAmount += amount;
        point.netAmount -= amount;
      }
    } else if (type === "PURCHASE" || type === "P" || type === "BUY") {
      point.buyAmount += amount;
      point.netAmount += amount;
    } else if (type === "SALE" || type === "S" || type === "SELL") {
      point.sellAmount += amount;
      point.netAmount -= amount;
    }

    points.set(day, point);
  }

  return {
    points: [...points.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-30),
    latestPrice,
    latestPriceDate,
    latestReturnPct,
    optionCount,
    bullishOptionCount,
    bearishOptionCount,
    uniqueMembers: members.size,
    latestTransactionDate
  };
}

function stockSubtitle(item: CongressTickerHierarchyItem, profile: StockProfile): string {
  const marked = profile.latestReturnPct === null ? "unmarked" : `${percentOrDash(profile.latestReturnPct)} marked`;
  return `${compact.format(profile.uniqueMembers)} members · ${compact.format(item.transactionCount)} disclosures · ${marked} · latest ${formatDate(profile.latestTransactionDate)}`;
}

function yahooNewsUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/news/`;
}

function buildMemberBatches(rows: CongressTransaction[]): MemberTransactionBatch[] {
  const batches = new Map<string, MemberTransactionBatch>();

  for (const row of rows) {
    const memberName = row.member_name?.trim() || "Unknown Member";
    const chamber = row.chamber || "unknown";
    const key = `${memberName.toLowerCase()}::${chamber.toLowerCase()}`;
    const existing =
      batches.get(key) ??
      ({
        key,
        memberName,
        chamber,
        transactionCount: 0,
        purchaseCount: 0,
        saleCount: 0,
        exchangeCount: 0,
        totalAmountMid: 0,
        pnlEstimate: 0,
        conflictFlagCount: 0,
        latestTransactionDate: null,
        sourceUrls: [],
        transactions: []
      } satisfies MemberTransactionBatch);

    existing.transactionCount += 1;
    existing.totalAmountMid += row.amount_mid ?? 0;
    existing.pnlEstimate += row.pnl_estimate ?? 0;
    existing.conflictFlagCount += row.conflict_flag_count ?? 0;
    existing.transactions.push(row);

    if (row.transaction_type === "PURCHASE") {
      existing.purchaseCount += 1;
    } else if (row.transaction_type === "SALE") {
      existing.saleCount += 1;
    } else if (row.transaction_type === "EXCHANGE") {
      existing.exchangeCount += 1;
    }

    if (row.source_url && !existing.sourceUrls.includes(row.source_url)) {
      existing.sourceUrls.push(row.source_url);
    }

    if (isAfter(row.transaction_date, existing.latestTransactionDate)) {
      existing.latestTransactionDate = row.transaction_date;
    }

    batches.set(key, existing);
  }

  return [...batches.values()]
    .map((batch) => ({
      ...batch,
      transactions: [...batch.transactions].sort(compareTransactions)
    }))
    .sort(
      (left, right) =>
        right.totalAmountMid - left.totalAmountMid ||
        right.transactionCount - left.transactionCount ||
        left.memberName.localeCompare(right.memberName)
    );
}

function buildCopyPortfolio({
  batches,
  capital,
  memberKey,
  period
}: {
  batches: MemberTransactionBatch[];
  capital: number;
  memberKey: string;
  period: CopyPortfolioPeriod;
}): CopyPortfolioModel | null {
  const batch = batches.find((candidate) => candidate.key === memberKey) ?? batches[0];

  if (!batch) {
    return null;
  }

  const now = Date.now();
  const cutoff = copyPortfolioCutoff(period, now);
  const aggregates = new Map<
    string,
    {
      symbol: string;
      displayName: string;
      sector: string;
      transactionCount: number;
      latestBuyDate: string | null;
      disclosedMidpoint: number;
      markedDisclosedMidpoint: number;
      weightedReturnPct: number;
    }
  >();
  let buyCount = 0;
  let skippedCount = 0;

  for (const row of batch.transactions) {
    if (!isPurchase(row)) {
      continue;
    }

    if (!isCopyPortfolioDateEligible(row, cutoff, now)) {
      continue;
    }

    const symbol = normalizeCopySymbol(row.symbol);
    const disclosedMidpoint = row.amount_mid ?? 0;

    if (!symbol || disclosedMidpoint <= 0 || row.option_decoder) {
      skippedCount += 1;
      continue;
    }

    buyCount += 1;

    const existing =
      aggregates.get(symbol) ??
      ({
        symbol,
        displayName: row.asset_name?.trim() || symbol,
        sector: row.security_sector?.trim() || "Unclassified",
        transactionCount: 0,
        latestBuyDate: null,
        disclosedMidpoint: 0,
        markedDisclosedMidpoint: 0,
        weightedReturnPct: 0
      } satisfies {
        symbol: string;
        displayName: string;
        sector: string;
        transactionCount: number;
        latestBuyDate: string | null;
        disclosedMidpoint: number;
        markedDisclosedMidpoint: number;
        weightedReturnPct: number;
      });

    existing.transactionCount += 1;
    existing.disclosedMidpoint += disclosedMidpoint;

    if (typeof row.return_pct === "number") {
      existing.markedDisclosedMidpoint += disclosedMidpoint;
      existing.weightedReturnPct += disclosedMidpoint * row.return_pct;
    }

    if (isAfter(row.transaction_date, existing.latestBuyDate)) {
      existing.latestBuyDate = row.transaction_date;
    }

    aggregates.set(symbol, existing);
  }

  const disclosedMidpoint = [...aggregates.values()].reduce(
    (total, holding) => total + holding.disclosedMidpoint,
    0
  );

  if (disclosedMidpoint <= 0 || aggregates.size === 0) {
    return null;
  }

  const holdings = [...aggregates.values()]
    .map((holding) => {
      const weightPct = (holding.disclosedMidpoint / disclosedMidpoint) * 100;
      const allocation = capital * (weightPct / 100);
      const markedCoverage =
        holding.disclosedMidpoint > 0
          ? holding.markedDisclosedMidpoint / holding.disclosedMidpoint
          : 0;
      const markedAllocation = allocation * markedCoverage;
      const returnPct =
        holding.markedDisclosedMidpoint > 0
          ? holding.weightedReturnPct / holding.markedDisclosedMidpoint
          : null;
      const estimatedPnl =
        returnPct === null || markedAllocation <= 0 ? null : markedAllocation * (returnPct / 100);

      return {
        symbol: holding.symbol,
        displayName: holding.displayName,
        sector: holding.sector,
        transactionCount: holding.transactionCount,
        latestBuyDate: holding.latestBuyDate,
        disclosedMidpoint: holding.disclosedMidpoint,
        weightPct,
        allocation,
        markedAllocation,
        estimatedValue: estimatedPnl === null ? null : allocation + estimatedPnl,
        estimatedPnl,
        returnPct
      } satisfies CopyPortfolioHolding;
    })
    .sort(
      (left, right) =>
        right.allocation - left.allocation ||
        right.transactionCount - left.transactionCount ||
        left.symbol.localeCompare(right.symbol)
    );

  const markedAllocation = holdings.reduce((total, holding) => total + holding.markedAllocation, 0);
  const estimatedPnl = holdings.reduce((total, holding) => total + (holding.estimatedPnl ?? 0), 0);
  const hasMarkedRows = markedAllocation > 0;

  return {
    memberName: batch.memberName,
    chamber: batch.chamber,
    periodLabel: copyPortfolioPeriodLabel(period),
    capital,
    buyCount,
    skippedCount,
    disclosedMidpoint,
    markedAllocation,
    estimatedValue: hasMarkedRows ? capital + estimatedPnl : null,
    estimatedPnl: hasMarkedRows ? estimatedPnl : null,
    returnPct: hasMarkedRows ? (estimatedPnl / markedAllocation) * 100 : null,
    holdings
  };
}

function compareTransactions(left: CongressTransaction, right: CongressTransaction): number {
  const leftTime = dateTime(left.transaction_date) ?? dateTime(left.created_at) ?? 0;
  const rightTime = dateTime(right.transaction_date) ?? dateTime(right.created_at) ?? 0;
  return rightTime - leftTime || (right.amount_mid ?? 0) - (left.amount_mid ?? 0);
}

function isAfter(candidate: string | null, current: string | null): boolean {
  const candidateTime = dateTime(candidate);
  const currentTime = dateTime(current);

  if (candidateTime === null) {
    return false;
  }

  return currentTime === null || candidateTime > currentTime;
}

function dateTime(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function copyPortfolioCutoff(period: CopyPortfolioPeriod, now: number): number | null {
  if (period === "all") {
    return null;
  }

  const start = new Date(now);

  if (period === "30d") {
    start.setUTCDate(start.getUTCDate() - 30);
  } else if (period === "90d") {
    start.setUTCDate(start.getUTCDate() - 90);
  } else if (period === "180d") {
    start.setUTCDate(start.getUTCDate() - 180);
  } else {
    start.setUTCFullYear(start.getUTCFullYear() - 1);
  }

  return start.getTime();
}

function copyPortfolioPeriodLabel(period: CopyPortfolioPeriod): string {
  if (period === "30d") {
    return "Last 30 days";
  }
  if (period === "90d") {
    return "Last 90 days";
  }
  if (period === "180d") {
    return "Last 6 months";
  }
  if (period === "12m") {
    return "Last 12 months";
  }
  return "All loaded";
}

function isCopyPortfolioDateEligible(
  row: CongressTransaction,
  cutoff: number | null,
  now: number
): boolean {
  const observedAt = dateTime(row.transaction_date) ?? dateTime(row.created_at);

  if (observedAt === null) {
    return false;
  }

  if (observedAt > now + 86_400_000) {
    return false;
  }

  return cutoff === null || observedAt >= cutoff;
}

function isPurchase(row: CongressTransaction): boolean {
  return row.transaction_type.trim().toUpperCase() === "PURCHASE";
}

function normalizeCopySymbol(symbol: string | null): string | null {
  const normalized = symbol?.trim().toUpperCase() ?? "";

  if (!normalized || normalized === "N/A" || normalized === "NA" || normalized === "UNRESOLVED") {
    return null;
  }

  return /^[A-Z][A-Z0-9.-]{0,10}$/.test(normalized) ? normalized : null;
}

function normalizeCapital(value: string): number {
  const parsed = Number(value.replace(/[$,\s]/g, ""));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10_000;
  }

  return Math.min(10_000_000, Math.max(100, parsed));
}

function displayInstrument(row: CongressTransaction): string {
  if (row.instrument_type === "OPTION" && row.option_underlying) {
    return row.option_underlying;
  }

  if (row.symbol) {
    return row.symbol;
  }

  const text = `${row.asset_name ?? ""} ${row.raw_text ?? ""}`;

  if (/US\s+TSY|TREASUR(?:Y|IES)|T-?BILL|T-?NOTE|T-?BOND/i.test(text)) {
    return "US TREASURY";
  }

  if (/FANNIE\s+MAE|FNMA/i.test(text)) {
    return "FANNIE MAE";
  }

  if (/FREDDIE\s+MAC|FHLMC/i.test(text)) {
    return "FREDDIE MAC";
  }

  if (/GINNIE\s+MAE|GNMA/i.test(text)) {
    return "GINNIE MAE";
  }

  if (/MUNICIPAL|MUNI/i.test(text)) {
    return "MUNICIPAL BOND";
  }

  if (/NOTE|BOND|DUE\s+\d/i.test(text)) {
    return "FIXED INCOME";
  }

  return "UNRESOLVED";
}

function MetricCard({
  icon,
  label,
  value,
  hint
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className="congress-metric glass">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  return <span className={`status-pill ${status.toLowerCase()}`}>{status}</span>;
}

function Fault({ message }: { message: string }) {
  return <div className="fault">{message}</div>;
}

function CommandMessage({ message }: { message: string }) {
  return <div className="command-message">{message}</div>;
}

function formatAmountBand(row: CongressTransaction): string {
  if (row.amount_min === null || row.amount_max === null) {
    return "n/a";
  }
  return `${currency.format(row.amount_min)} - ${currency.format(row.amount_max)}`;
}

function moneyOrDash(value: number | null): string {
  return typeof value === "number" ? currency.format(value) : "n/a";
}

function percentOrDash(value: number | null): string {
  return typeof value === "number" ? `${compact.format(value)}%` : "n/a";
}

function formatDate(value: string | null): string {
  if (!value) {
    return "n/a";
  }
  return value.slice(0, 10);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readApiError(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const candidate = response as { detail?: unknown; error?: unknown };
  if (typeof candidate.error !== "string") {
    return null;
  }

  return typeof candidate.detail === "string"
    ? `${candidate.error}: ${candidate.detail}`
    : candidate.error;
}

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

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

const PERIOD_OPTIONS: CongressPeriod[] = ["24h", "7d", "30d", "90d", "ytd", "all"];

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
  const [tickerPeriod, setTickerPeriod] = useState<CongressPeriod>("24h");
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
          readCongressTransactions(apiBase, token, 150),
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
      setTransactions(
        (transactionsResult as CongressTransactionsResponse).ok
          ? transactionsResult.transactions
          : []
      );
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
          <a href="/settings">Settings</a>
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
            <span>Ticker Hierarchy</span>
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

function MemberLedger({ batches }: { batches: MemberTransactionBatch[] }) {
  if (batches.length === 0) {
    return <div className="ticker-hierarchy-empty">No Congressional transactions loaded yet.</div>;
  }

  return (
    <div className="congress-member-stack">
      {batches.map((batch, index) => (
        <MemberBatchRow batch={batch} defaultOpen={index === 0} key={batch.key} />
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
      <span>{row.transaction_type}</span>
      <span>{formatDate(row.transaction_date)}</span>
      <span>{formatAmountBand(row)}</span>
      <strong className={positive ? "positive" : "negative"}>
        {moneyOrDash(row.pnl_estimate)}
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

  return (
    <details className={isUnresolved ? "ticker-hierarchy-row unresolved" : "ticker-hierarchy-row"}>
      <summary className="ticker-hierarchy-summary">
        <span className="ticker-rank">#{item.rank}</span>
        <strong>{isUnresolved ? "UNRESOLVED" : item.ticker}</strong>
        <span className="ticker-display-name">{item.displayName}</span>
        <span className="ticker-weight">
          <i style={{ width: `${Math.min(100, Math.max(2, item.weightPct))}%` }} />
        </span>
        <span>{compact.format(item.weightPct)}%</span>
        <code>{currency.format(item.totalAmountMid)}</code>
      </summary>

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
          <small>{compact.format(item.markedCount)} rows with price marks</small>
        </div>
      </div>

      <div className="ticker-asset-stack">
        {item.topAssets.length === 0 ? (
          <span className="muted">No asset detail attached to this ticker bucket.</span>
        ) : (
          item.topAssets.map((asset) => (
            <div className="ticker-asset-row" key={asset.assetName}>
              <strong>{asset.assetName}</strong>
              <span>{currency.format(asset.totalAmountMid)}</span>
              <code>
                {compact.format(asset.transactionCount)} txns · {compact.format(asset.memberCount)}{" "}
                members
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
            <span>{row.transaction_type}</span>
            <span>{formatDate(row.transaction_date)}</span>
            <code>{formatAmountBand(row)}</code>
          </div>
        ))}
      </div>
    </details>
  );
}

function TransactionRow({ row }: { row: CongressTransaction }) {
  const pnl = row.pnl_estimate ?? 0;
  const positive = pnl >= 0;

  return (
    <tr>
      <td>
        <a href={row.source_url ?? "#"} target="_blank" rel="noreferrer">
          {row.member_name ?? "Unknown"}
        </a>
        <small>{row.asset_name ?? "Unlabeled asset"}</small>
      </td>
      <td>{row.chamber.toUpperCase()}</td>
      <td>{displayInstrument(row)}</td>
      <td>{row.transaction_type}</td>
      <td>{formatDate(row.transaction_date)}</td>
      <td>{formatAmountBand(row)}</td>
      <td>{moneyOrDash(row.transaction_price)}</td>
      <td>
        {moneyOrDash(row.current_price)}
        <small>{row.price_provider ?? "unmarked"}</small>
      </td>
      <td className={positive ? "positive" : "negative"}>{percentOrDash(row.return_pct)}</td>
      <td className={positive ? "positive" : "negative"}>{moneyOrDash(row.pnl_estimate)}</td>
    </tr>
  );
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

function displayInstrument(row: CongressTransaction): string {
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

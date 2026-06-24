"use client";

import { Bot, DatabaseZap, KeyRound, Landmark, Lock, RefreshCcw, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_API_BASE,
  SovereignApiError,
  enrichCongressAlphaUniverse,
  login,
  readCongressAlphaBot,
  runCongressAlphaBacktest,
  runCongressAlphaBot,
  updateCongressAlphaSettings
} from "@/lib/api";
import type { CongressAlphaBotResponse, CongressAlphaSettings } from "@/lib/types";

type ConnectionStatus = "LOCKED" | "AUTHENTICATED" | "LOADING" | "ERROR";

interface CongressAlphaSettingsForm {
  bankroll: string;
  maxPositions: string;
  minScore: string;
  maxWeightPct: string;
  lookbackDays: string;
  autoRunEnabled: boolean;
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

export default function CongressAlphaBotPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("LOCKED");
  const [error, setError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [alpha, setAlpha] = useState<CongressAlphaBotResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [settings, setSettings] = useState<CongressAlphaSettingsForm>(
    settingsToForm(defaultAlphaSettings())
  );

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    setError(null);
    setStatus("LOADING");

    try {
      const response = await readCongressAlphaBot(apiBase, token);
      setAlpha(response);
      if (response.settings) {
        setSettings(settingsToForm(response.settings));
      }
      setStatus("AUTHENTICATED");
    } catch (caught: unknown) {
      setStatus("ERROR");
      setError(errorMessage(caught));
    }
  }, [apiBase, token]);

  useEffect(() => {
    if (token) {
      void refresh();
    }
  }, [refresh, token]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus("LOADING");

    try {
      const response = await login(apiBase, password.trim());
      setToken(response.token);
      setCommandStatus("Congress Alpha console unlocked.");
      setStatus("AUTHENTICATED");
    } catch (caught: unknown) {
      setStatus("ERROR");
      setError(errorMessage(caught));
    }
  }

  function handleLogout() {
    setToken("");
    setPassword("");
    setAlpha(null);
    setCommandStatus(null);
    setStatus("LOCKED");
  }

  async function submitAlphaRun() {
    setError(null);
    setIsRunning(true);
    setCommandStatus("Running Congress Alpha paper rebalance...");

    try {
      const response = await runCongressAlphaBot(apiBase, token, {
        ...settingsPayload(settings),
        reason: "congress-alpha-page-paper-rebalance"
      });

      if (response.ok) {
        await refresh();
      } else {
        setAlpha(response);
      }

      setCommandStatus(
        response.ok
          ? `Paper rebalance complete: ${response.summary?.targetCount ?? 0} targets, ${response.summary?.orderCount ?? 0} orders.`
          : (response.error ?? "Congress Alpha run failed.")
      );

      if (!response.ok) {
        setError(response.error ?? response.hint ?? "Congress Alpha run failed.");
      }
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Congress Alpha run failed.");
    } finally {
      setIsRunning(false);
    }
  }

  async function saveSettings() {
    setError(null);
    setCommandStatus("Saving Congress Alpha settings...");

    try {
      await updateCongressAlphaSettings(apiBase, token, settingsPayload(settings));
      await refresh();
      setCommandStatus("Congress Alpha settings saved.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Settings save failed.");
    }
  }

  async function runEnrichment() {
    setError(null);
    setCommandStatus("Enriching Congress Alpha universe...");

    try {
      const response = await enrichCongressAlphaUniverse(apiBase, token);
      await refresh();
      setCommandStatus(`Universe enrichment complete: ${response.enriched ?? 0} symbols updated.`);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Universe enrichment failed.");
    }
  }

  async function runBacktest() {
    setError(null);
    setCommandStatus("Running Congress Alpha research backtest...");

    try {
      const response = await runCongressAlphaBacktest(apiBase, token);
      await refresh();
      setCommandStatus(
        response.ok
          ? `Backtest complete: ${String(response.result.testedSignals ?? 0)} signals tested.`
          : (response.error ?? "Backtest failed.")
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Backtest failed.");
    }
  }

  if (!token) {
    return (
      <main className="login-shell">
        <section className="login-panel glass">
          <div className="brand-lockup">
            <div className="sigil">
              <Bot size={22} />
            </div>
            <div>
              <h1>Sovereign-Sigma</h1>
              <p>Congress Alpha Paper Bot</p>
            </div>
          </div>
          <form className="login-form" onSubmit={(event) => void handleLogin(event)}>
            <label>
              API Base
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
              Unlock Alpha Bot
            </button>
          </form>
          <StatusPill status={status} />
          {error ? <Fault message={error} /> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="settings-shell congress-shell alpha-page-shell">
      <section className="settings-hero glass">
        <div className="brand-lockup">
          <div className="sigil">
            <Bot size={22} />
          </div>
          <div>
            <h1>Sovereign-Sigma</h1>
            <p>Congress Alpha Paper Bot</p>
          </div>
        </div>
        <div className="settings-nav">
          <a href="/">Command Center</a>
          <a href="/congress">
            <DatabaseZap size={16} />
            Congress
          </a>
          <a href="/settings">
            <Settings size={16} />
            Settings
          </a>
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

      {commandStatus ? (
        <section className="congress-warning glass">
          <strong>Alpha Bot</strong>
          <span>{commandStatus}</span>
        </section>
      ) : null}

      <CongressAlphaPanel
        alpha={alpha}
        settings={settings}
        isRunning={isRunning}
        onSettingsChange={setSettings}
        onRun={() => void submitAlphaRun()}
        onSave={() => void saveSettings()}
        onEnrich={() => void runEnrichment()}
        onBacktest={() => void runBacktest()}
      />
    </main>
  );
}

function CongressAlphaPanel({
  alpha,
  settings,
  isRunning,
  onSettingsChange,
  onRun,
  onSave,
  onEnrich,
  onBacktest
}: {
  alpha: CongressAlphaBotResponse | null;
  settings: CongressAlphaSettingsForm;
  isRunning: boolean;
  onSettingsChange: (settings: CongressAlphaSettingsForm) => void;
  onRun: () => void;
  onSave: () => void;
  onEnrich: () => void;
  onBacktest: () => void;
}) {
  const summary = alpha?.summary;
  const targets = alpha?.targets ?? [];
  const positions = alpha?.positions ?? [];
  const orders = alpha?.orders ?? [];
  const topSignals = alpha?.signals?.slice(0, 5) ?? [];
  const latestRun = alpha?.latestRun;
  const pnl = summary?.unrealizedPnl ?? 0;
  const pnlClass = pnl >= 0 ? "positive" : "negative";
  const statusLabel = summary?.latestRunStatus ?? latestRun?.status ?? "PENDING";
  const backtestResult = asRecord(alpha?.backtest?.result);
  const backtestBenchmark = asRecord(backtestResult.benchmark);
  const scheduler = alpha?.scheduler;

  return (
    <section className="settings-panel settings-panel-wide glass congress-alpha-panel">
      <div className="alpha-hero">
        <div className="alpha-identity">
          <div className="alpha-orb">
            <Bot size={22} />
          </div>
          <div>
            <span className="section-eyebrow">Delayed Disclosure Alpha</span>
            <h2>Congress Alpha Paper Bot</h2>
            <p>
              Converts cleaned PTR disclosures, price marks, and conflict flags into a simulated
              long-only equity basket.
            </p>
          </div>
        </div>
        <div className="alpha-run-stack">
          <strong className={`alpha-status alpha-status-${statusLabel.toLowerCase()}`}>
            {isRunning ? "RUNNING" : statusLabel}
          </strong>
          <button className="primary-action" disabled={isRunning} onClick={onRun}>
            {isRunning ? "Balancing..." : "Run Paper Rebalance"}
          </button>
        </div>
      </div>

      {!alpha ? (
        <div className="ticker-hierarchy-empty">
          No Congress Alpha state loaded yet. Refresh the page or run the paper bot.
        </div>
      ) : (
        <>
          {!alpha.ok ? (
            <div className="alpha-warning">
              <strong>{summary?.latestRunStatus ?? "FAILED"}</strong>
              <span>
                {alpha.error ?? alpha.hint ?? "Latest Congress Alpha run needs attention."}
              </span>
            </div>
          ) : null}
          <div className="alpha-kpi-grid">
            <div className="alpha-kpi alpha-kpi-large">
              <span>Paper Equity</span>
              <strong>{currency.format(summary?.equity ?? 0)}</strong>
              <small>
                {currency.format(summary?.cash ?? 0)} cash ·{" "}
                {currency.format(summary?.invested ?? 0)} invested
              </small>
            </div>
            <div className="alpha-kpi">
              <span>Unrealized PnL</span>
              <strong className={pnlClass}>
                {pnl >= 0 ? currency.format(pnl) : `-${currency.format(Math.abs(pnl))}`}
              </strong>
              <small>{alpha.mode}</small>
            </div>
            <div className="alpha-kpi">
              <span>Signal Stack</span>
              <strong>{compact.format(summary?.signalCount ?? 0)}</strong>
              <small>{compact.format(summary?.targetCount ?? 0)} active targets</small>
            </div>
            <div className="alpha-kpi">
              <span>Latest Run</span>
              <strong>{statusLabel}</strong>
              <small>{formatDateTime(alpha.generatedAt ?? latestRun?.completedAt ?? null)}</small>
            </div>
          </div>

          <div className="alpha-console-grid">
            <section className="congress-alpha-card alpha-controls">
              <div className="macro-card-header">
                <span>Bot Parameters</span>
                <code>paper vault</code>
              </div>
              <div className="alpha-control-grid">
                <label className="alpha-input alpha-toggle-input">
                  <span>Auto Daily Rebalance</span>
                  <button
                    className={settings.autoRunEnabled ? "alpha-toggle on" : "alpha-toggle"}
                    type="button"
                    onClick={() =>
                      onSettingsChange({
                        ...settings,
                        autoRunEnabled: !settings.autoRunEnabled
                      })
                    }
                  >
                    {settings.autoRunEnabled ? "Enabled" : "Disabled"}
                  </button>
                </label>
                <AlphaInput
                  label="Bankroll"
                  value={settings.bankroll}
                  onChange={(value) => onSettingsChange({ ...settings, bankroll: value })}
                />
                <AlphaInput
                  label="Max Positions"
                  value={settings.maxPositions}
                  onChange={(value) => onSettingsChange({ ...settings, maxPositions: value })}
                />
                <AlphaInput
                  label="Min Score"
                  value={settings.minScore}
                  onChange={(value) => onSettingsChange({ ...settings, minScore: value })}
                />
                <AlphaInput
                  label="Max Weight %"
                  value={settings.maxWeightPct}
                  onChange={(value) => onSettingsChange({ ...settings, maxWeightPct: value })}
                />
                <AlphaInput
                  label="Lookback Days"
                  value={settings.lookbackDays}
                  onChange={(value) => onSettingsChange({ ...settings, lookbackDays: value })}
                />
              </div>
              <div className="alpha-run-meta">
                <span>Run ID</span>
                <code>{summary?.latestRunId ?? latestRun?.runId ?? "none"}</code>
              </div>
              <div className="alpha-run-meta">
                <span>Operator</span>
                <code>{latestRun?.createdBy ?? "command-center"}</code>
              </div>
              <div className="alpha-run-meta">
                <span>Scheduler</span>
                <code>{scheduler?.autoRunEnabled ? "auto midnight" : "manual only"}</code>
              </div>
              <div className="alpha-run-meta">
                <span>Next Run</span>
                <code>
                  {scheduler
                    ? `${scheduler.nextRunLocalDate} ${scheduler.nextRunLocalTime} ${scheduler.timezone}`
                    : "n/a"}
                </code>
              </div>
              <div className="alpha-run-meta">
                <span>Last Cron</span>
                <code>{formatDateTime(scheduler?.lastScheduledRunAt ?? null)}</code>
              </div>
              <div className="alpha-action-row">
                <button onClick={onSave}>Save Settings</button>
                <button onClick={onEnrich}>Enrich Universe</button>
                <button onClick={onBacktest}>Run Backtest</button>
              </div>
            </section>

            <section className="congress-alpha-card">
              <div className="macro-card-header">
                <span>Target Basket</span>
                <code>{compact.format(targets.length)} names</code>
              </div>
              {targets.length === 0 ? (
                <div className="ticker-hierarchy-empty">
                  No eligible scored targets with price marks yet.
                </div>
              ) : (
                <div className="congress-alpha-list">
                  {targets.slice(0, 10).map((target) => (
                    <div className="congress-alpha-row" key={target.targetId}>
                      <strong>{target.symbol}</strong>
                      <span>{target.sector}</span>
                      <code>{compact.format(target.targetWeightPct)}%</code>
                      <code>{currency.format(target.targetNotional)}</code>
                      <small>Score {compact.format(target.score)}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="congress-alpha-card">
              <div className="macro-card-header">
                <span>Paper Positions</span>
                <code>{compact.format(positions.length)} open</code>
              </div>
              {positions.length === 0 ? (
                <div className="ticker-hierarchy-empty">No paper positions recorded yet.</div>
              ) : (
                <div className="congress-alpha-list">
                  {positions.slice(0, 10).map((position) => {
                    const positive = position.unrealizedPnl >= 0;
                    return (
                      <div className="congress-alpha-row" key={position.symbol}>
                        <strong>{position.symbol}</strong>
                        <span>{compact.format(position.quantity)} shares</span>
                        <code>{currency.format(position.marketValue)}</code>
                        <code className={positive ? "positive" : "negative"}>
                          {positive
                            ? currency.format(position.unrealizedPnl)
                            : `-${currency.format(Math.abs(position.unrealizedPnl))}`}
                        </code>
                        <small>{compact.format(position.targetWeightPct)}% target</small>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <div className="alpha-ledger-grid">
            <section className="congress-alpha-card">
              <div className="macro-card-header">
                <span>Paper Orders</span>
                <code>{compact.format(orders.length)} latest</code>
              </div>
              {orders.length === 0 ? (
                <div className="ticker-hierarchy-empty">No paper rebalance orders yet.</div>
              ) : (
                <div className="alpha-order-list">
                  {orders.slice(0, 8).map((order) => (
                    <div className="alpha-order-row" key={order.orderId}>
                      <strong className={order.side === "BUY" ? "positive" : "negative"}>
                        {order.side}
                      </strong>
                      <span>{order.symbol}</span>
                      <code>{compact.format(order.quantity)}</code>
                      <code>{currency.format(order.notional)}</code>
                      <small>{order.reason}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="congress-alpha-card">
              <div className="macro-card-header">
                <span>Signal Rationale</span>
                <code>{compact.format(topSignals.length)} ranked</code>
              </div>
              {topSignals.length === 0 ? (
                <div className="ticker-hierarchy-empty">Waiting for scored disclosures.</div>
              ) : (
                <div className="alpha-signal-list">
                  {topSignals.map((signal) => (
                    <div className="alpha-signal-row" key={signal.signalId}>
                      <div>
                        <strong>{signal.symbol}</strong>
                        <span>{signal.sector}</span>
                      </div>
                      <code>Score {compact.format(signal.score)}</code>
                      <code>{percentOrDash(signal.confidence * 100)}</code>
                      <small>
                        {compact.format(signal.purchaseCount)} buys ·{" "}
                        {compact.format(signal.memberCount)} members ·{" "}
                        {compact.format(signal.conflictCount)} conflicts
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="alpha-intel-grid">
            <section className="congress-alpha-card">
              <div className="macro-card-header">
                <span>External Enrichment</span>
                <code>{compact.format(alpha.enrichment?.count ?? 0)} symbols</code>
              </div>
              {(alpha.enrichment?.latest ?? []).length === 0 ? (
                <div className="ticker-hierarchy-empty">No SEC/Finnhub enrichment stored yet.</div>
              ) : (
                <div className="alpha-signal-list">
                  {(alpha.enrichment?.latest ?? []).slice(0, 6).map((row) => (
                    <EnrichmentRow row={row} key={String(row.symbol)} />
                  ))}
                </div>
              )}
            </section>

            <section className="congress-alpha-card">
              <div className="macro-card-header">
                <span>Research Backtest</span>
                <code>{alpha.backtest ? "available" : "pending"}</code>
              </div>
              {!alpha.backtest ? (
                <div className="ticker-hierarchy-empty">No Congress Alpha backtest stored yet.</div>
              ) : (
                <div className="alpha-kpi-grid alpha-kpi-grid-compact">
                  <div className="alpha-kpi">
                    <span>Signals</span>
                    <strong>{String(backtestResult.testedSignals ?? 0)}</strong>
                    <small>{String(backtestResult.markedSignals ?? 0)} marked</small>
                  </div>
                  <div className="alpha-kpi">
                    <span>Weighted Return</span>
                    <strong>{percentOrDash(numberOrNull(backtestResult.weightedReturnPct))}</strong>
                    <small>marked paper window</small>
                  </div>
                  <div className="alpha-kpi">
                    <span>Hit Rate</span>
                    <strong>
                      {percentOrDash(scaleFraction(numberOrNull(backtestResult.realizedHitRate)))}
                    </strong>
                    <small>
                      baseline{" "}
                      {percentOrDash(
                        scaleFraction(numberOrNull(backtestBenchmark.markedPurchaseHitRate))
                      )}
                    </small>
                  </div>
                  <div className="alpha-kpi">
                    <span>Alpha vs Congress</span>
                    <strong>
                      {percentOrDash(numberOrNull(backtestResult.alphaVsMarkedCongressPct))}
                    </strong>
                    <small>
                      avg Congress{" "}
                      {percentOrDash(
                        numberOrNull(backtestBenchmark.averageMarkedPurchaseReturnPct)
                      )}
                    </small>
                  </div>
                </div>
              )}
            </section>
          </div>

          <p className="copy-portfolio-note">
            Congress Alpha only simulates delayed-disclosure equity baskets. It does not call a
            broker, place market orders, or route through the crypto executioner.
          </p>
        </>
      )}
    </section>
  );
}

function EnrichmentRow({ row }: { row: Record<string, unknown> }) {
  const sources = asRecord(row.sources);
  const exposure = asRecord(sources.congressCommitteeExposure);
  const committees = Array.isArray(exposure.topCommittees) ? exposure.topCommittees.length : 0;

  return (
    <div className="alpha-signal-row">
      <div>
        <strong>{String(row.symbol ?? "N/A")}</strong>
        <span>{String(row.companyName ?? "Unresolved company")}</span>
      </div>
      <code>{String(row.cik ?? "no CIK")}</code>
      <code>{committees > 0 ? `${committees} committee flags` : "no committee flags"}</code>
      <small>{String(row.enrichedAt ?? "")}</small>
    </div>
  );
}

function AlphaInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="alpha-input">
      <span>{label}</span>
      <input
        inputMode="decimal"
        min="0"
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  return (
    <div className={`system-state ${status.toLowerCase()}`}>
      <span>{status}</span>
    </div>
  );
}

function Fault({ message }: { message: string }) {
  return <div className="fault">{message}</div>;
}

function percentOrDash(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${compact.format(value)}%` : "n/a";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scaleFraction(value: number | null): number | null {
  return value === null ? null : value * 100;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function defaultAlphaSettings(): CongressAlphaSettings {
  return {
    bankroll: 10_000,
    maxPositions: 10,
    minScore: 35,
    maxWeightPct: 10,
    lookbackDays: 180,
    autoRunEnabled: true
  };
}

function settingsToForm(settings: CongressAlphaSettings): CongressAlphaSettingsForm {
  return {
    bankroll: String(settings.bankroll),
    maxPositions: String(settings.maxPositions),
    minScore: String(settings.minScore),
    maxWeightPct: String(settings.maxWeightPct),
    lookbackDays: String(settings.lookbackDays),
    autoRunEnabled: settings.autoRunEnabled
  };
}

function settingsPayload(settings: CongressAlphaSettingsForm): CongressAlphaSettings {
  return {
    bankroll: Number(settings.bankroll),
    maxPositions: Number(settings.maxPositions),
    minScore: Number(settings.minScore),
    maxWeightPct: Number(settings.maxWeightPct),
    lookbackDays: Number(settings.lookbackDays),
    autoRunEnabled: settings.autoRunEnabled
  };
}

function errorMessage(caught: unknown): string {
  if (caught instanceof SovereignApiError) {
    return caught.message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

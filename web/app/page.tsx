"use client";

import {
  AlertTriangle,
  BellRing,
  Brain,
  ChevronRight,
  CircleDot,
  Gauge,
  KeyRound,
  LogOut,
  Lock,
  RadioTower,
  ReceiptText,
  Shield,
  SlidersHorizontal,
  TerminalSquare,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_API_BASE,
  clearOverride,
  injectMoltworkerIntent,
  login,
  readAttribution,
  readAlerts,
  readConfig,
  readState,
  readTradeHistory,
  readTrace,
  resetLatencyBaseline,
  sendTestAlert,
  toWebSocketUrl,
  updateConfig
} from "@/lib/api";
import {
  DEFAULT_TRANSPORT_SETTINGS,
  PARAMETER_MATRIX,
  changedMoreThanTenPercent,
  flattenState
} from "@/lib/parameters";
import type {
  AttributionResponse,
  AlertingResponse,
  AlertPriority,
  AlertTestResponse,
  DashboardPulse,
  DraftTransportSettings,
  EngineState,
  GlobalRiskConfig,
  GovernanceMode,
  JsonRecord,
  MacroBiasDirection,
  TradeHistoryEntry,
  TradeHistoryResponse,
  TraceResponse
} from "@/lib/types";

type ConnectionStatus = "LOCKED" | "AUTHENTICATED" | "STREAMING" | "ERROR";
interface MoltworkerDraft {
  direction: MacroBiasDirection;
  intensity: number;
  confidence: number;
  reason: string;
  durationMinutes: number;
  governanceMode: GovernanceMode;
  manualSkepticism: number;
  maxSkepticism: number;
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4
});

export default function CommandCenterPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("LOCKED");
  const [error, setError] = useState<string | null>(null);
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [config, setConfig] = useState<GlobalRiskConfig | null>(null);
  const [draftConfig, setDraftConfig] = useState<Partial<GlobalRiskConfig>>({});
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [attribution, setAttribution] = useState<AttributionResponse | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryResponse | null>(null);
  const [alerts, setAlerts] = useState<AlertingResponse | null>(null);
  const [lastAlertTest, setLastAlertTest] = useState<AlertTestResponse | null>(null);
  const [pulse, setPulse] = useState<DashboardPulse | null>(null);
  const [logicFeed, setLogicFeed] = useState<JsonRecord[]>([]);
  const [pendingFields, setPendingFields] = useState<string[]>([]);
  const [confirmText, setConfirmText] = useState("");
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [isApplyingMatrix, setIsApplyingMatrix] = useState(false);
  const [isClearingOverride, setIsClearingOverride] = useState(false);
  const [isResettingLatency, setIsResettingLatency] = useState(false);
  const [isTestingAlert, setIsTestingAlert] = useState(false);
  const [transport, setTransport] = useState<DraftTransportSettings>(DEFAULT_TRANSPORT_SETTINGS);
  const [moltworker, setMoltworker] = useState<MoltworkerDraft>({
    direction: "RISK_OFF" as MacroBiasDirection,
    intensity: 0.55,
    confidence: 0.75,
    reason: "Expected volatility cluster",
    durationMinutes: 60,
    governanceMode: "MANUAL",
    manualSkepticism: 2.5,
    maxSkepticism: 6
  });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const draftDirtyRef = useRef(false);
  const isUnlocked = Boolean(token);

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    const [stateResult, configResult, traceResult, attributionResult, historyResult, alertsResult] = await Promise.all([
      readState(apiBase, token),
      readConfig(apiBase, token),
      readTrace(apiBase, token),
      readAttribution(apiBase, token),
      readTradeHistory(apiBase, token),
      readAlerts(apiBase, token)
    ]);

    setEngineState(stateResult.state);
    setConfig(configResult.config);
    if (!draftDirtyRef.current) {
      setDraftConfig(configResult.config);
    }
    setTrace(traceResult);
    setAttribution(attributionResult);
    setTradeHistory(historyResult);
    setAlerts(alertsResult);
  }, [apiBase, token]);

  const connectStream = useCallback(() => {
    if (!token) {
      return;
    }

    wsRef.current?.close();
    const ws = new WebSocket(toWebSocketUrl(apiBase, token));
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectRef.current = 0;
      setStatus("STREAMING");
    };

    ws.onmessage = (event) => {
      const message = safeParse(event.data);
      if (!message || typeof message !== "object") {
        return;
      }

      const typed = message as { type?: string; payload?: unknown };
      if (typed.type === "DASHBOARD_PULSE") {
        const nextPulse = typed.payload as DashboardPulse;
        setPulse(nextPulse);
        setLogicFeed((items) => [
          ...((nextPulse.AgentLogicTrace ?? []) as JsonRecord[]),
          ...items
        ].slice(0, 80));
      }

      if (typed.type === "AGENT_SIGNAL" && typed.payload) {
        setLogicFeed((items) => [typed.payload as JsonRecord, ...items].slice(0, 80));
      }

      if (typed.type === "TRADE_EXECUTION_UPDATE" && typed.payload) {
        const trade = normalizeTradePayload(typed.payload);
        setTradeHistory((current) => ({
          ok: true,
          data: [trade, ...(current?.data ?? []).filter((row) => row.tradeId !== trade.tradeId)]
            .slice(0, 50),
          pagination: current?.pagination ?? {
            page: 1,
            limit: 50,
            total: 1,
            pageCount: 1,
            hasNextPage: false,
            hasPreviousPage: false
          },
          filters: current?.filters ?? { statusMode: "ALL" }
        }));
      }
    };

    ws.onerror = () => {
      setStatus("ERROR");
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) {
        return;
      }
      if (!token) {
        return;
      }
      reconnectRef.current += 1;
      const delay = Math.min(
        transport.reconnectMaxMs,
        transport.reconnectBaseMs * 2 ** reconnectRef.current
      );
      window.setTimeout(connectStream, delay);
    };
  }, [apiBase, token, transport.reconnectBaseMs, transport.reconnectMaxMs]);

  useEffect(() => {
    const savedToken = localStorage.getItem("sovereign.jwt");
    const savedBase = localStorage.getItem("sovereign.apiBase");
    const savedTransport = localStorage.getItem("sovereign.transport");
    if (savedBase) {
      setApiBase(savedBase);
    }
    if (savedTransport) {
      const parsed = safeParse(savedTransport) as Partial<DraftTransportSettings> | null;
      if (parsed) {
        setTransport((current) => ({ ...current, ...parsed }));
      }
    }
    if (savedToken) {
      setToken(savedToken);
      setStatus("AUTHENTICATED");
    }
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    refresh().catch((caught: unknown) => setError(errorMessage(caught)));
    connectStream();
    const interval = window.setInterval(() => {
      refresh().catch((caught: unknown) => setError(errorMessage(caught)));
    }, 10000);

    return () => {
      window.clearInterval(interval);
      wsRef.current?.close();
    };
  }, [token, refresh, connectStream]);

  const realizedAlpha = useMemo(
    () =>
      attribution?.byDriver.reduce((sum, driver) => sum + Number(driver.cumulativePnl ?? 0), 0) ??
      0,
    [attribution]
  );
  const tradeSummary = useMemo(() => summarizeTrades(tradeHistory?.data ?? []), [tradeHistory]);

  const stateRows = useMemo(
    () => flattenState(engineState ?? {}).filter(([key]) => !key.includes("posteriorPdf.points")),
    [engineState]
  );

  async function handleLogin() {
    setError(null);
    setCommandStatus("Authenticating...");

    try {
      const response = await login(apiBase, password);
      localStorage.setItem("sovereign.jwt", response.token);
      localStorage.setItem("sovereign.apiBase", apiBase);
      setToken(response.token);
      setStatus("AUTHENTICATED");
      setCommandStatus("Authenticated.");
      setPassword("");
    } catch (caught: unknown) {
      setStatus("ERROR");
      setError(errorMessage(caught));
      setCommandStatus("Authentication failed.");
    }
  }

  function handleLogout() {
    localStorage.removeItem("sovereign.jwt");
    wsRef.current?.close();
    setToken("");
    setPassword("");
    setStatus("LOCKED");
    setCommandStatus("Console locked.");
    setEngineState(null);
    setConfig(null);
    setDraftConfig({});
    setTrace(null);
    setAttribution(null);
    setTradeHistory(null);
    setAlerts(null);
    setLastAlertTest(null);
    setPulse(null);
    setLogicFeed([]);
  }

  function updateDraft(key: keyof GlobalRiskConfig, value: string | number | boolean) {
    draftDirtyRef.current = true;
    setDraftConfig((draft) => ({
      ...draft,
      [key]: value
    }));
  }

  async function submitDraftConfig(force = false) {
    if (!config) {
      return;
    }

    const overTen = changedMoreThanTenPercent(config, draftConfig);
    if (!force && overTen.length > 0) {
      setPendingFields(overTen);
      setConfirmText("");
      return;
    }

    setError(null);
    setCommandStatus("Applying matrix...");
    setIsApplyingMatrix(true);

    try {
      await updateConfig(apiBase, token, draftConfig);
      draftDirtyRef.current = false;
      setPendingFields([]);
      await refresh();
      setCommandStatus(
        temporaryOverride
          ? "Baseline matrix saved. Effective governance is still controlled by the active Moltworker override."
          : "Matrix applied."
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Matrix update failed.");
    } finally {
      setIsApplyingMatrix(false);
    }
  }

  async function submitMoltworker() {
    setError(null);
    setCommandStatus("Injecting Moltworker intent...");

    try {
      await injectMoltworkerIntent(apiBase, token, moltworker);
      await refresh();
      setCommandStatus("Moltworker override active.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Moltworker update failed.");
    }
  }

  async function submitClearOverride() {
    setError(null);
    setCommandStatus("Clearing Moltworker override...");
    setIsClearingOverride(true);

    try {
      await clearOverride(apiBase, token, temporaryOverride);
      await refresh();
      setCommandStatus("Moltworker override cleared. Matrix governance is now effective.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Override clear failed.");
    } finally {
      setIsClearingOverride(false);
    }
  }

  function submitTransportSettings() {
    localStorage.setItem("sovereign.transport", JSON.stringify(transport));
    reconnectRef.current = 0;
    wsRef.current?.close();
    connectStream();
    setCommandStatus("Transport controls applied to the live dashboard stream.");
  }

  async function submitResetLatency() {
    setError(null);
    setCommandStatus("Resetting stale telemetry baseline...");
    setIsResettingLatency(true);

    try {
      await resetLatencyBaseline(apiBase, token);
      await refresh();
      setCommandStatus("Latency baseline reset.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Latency reset failed.");
    } finally {
      setIsResettingLatency(false);
    }
  }

  async function submitAlertTest(priority: AlertPriority = "HIGH") {
    setError(null);
    setCommandStatus("Testing alert route...");
    setIsTestingAlert(true);

    try {
      const response = await sendTestAlert(apiBase, token, priority);
      setLastAlertTest(response);
      setAlerts({ ok: true, alerting: response.alerting });
      setCommandStatus(
        response.delivery.delivered > 0
          ? `Alert delivered to ${response.delivery.delivered}/${response.delivery.attempted} channel(s).`
          : "Alert route test found no configured delivery channel."
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Alert test failed.");
    } finally {
      setIsTestingAlert(false);
    }
  }

  const macroBias = pulse?.macroBias ?? engineState?.macroBias ?? null;
  const temporaryOverride = pulse?.temporaryOverride ?? engineState?.temporaryOverride ?? null;
  const displayEquity = pulse?.total_equity ?? engineState?.bankroll.equity ?? 0;
  const drawdown = pulse?.active_drawdown ?? engineState?.riskMetrics.rollingDrawdownPct ?? 0;
  const imbalance = pulse?.current_imbalance ?? engineState?.microstructure.weightedImbalance ?? null;
  const regime = pulse?.regime ?? engineState?.oracle.regime ?? "UNKNOWN";

  if (!isUnlocked) {
    return (
      <main className="login-shell">
        <section className="login-panel glass">
          <div className="brand-lockup">
            <div className="sigil">
              <Brain size={22} />
            </div>
            <div>
              <h1>Sovereign-Sigma</h1>
              <p>Admin Command Center</p>
            </div>
          </div>

          <div className="login-copy">
            <strong>Operator gate</strong>
            <span>Authenticate to unlock live telemetry, matrix controls, and Moltworker governance.</span>
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
              Unlock Admin
            </button>
          </form>

          <div className={`system-state ${status.toLowerCase()}`}>
            <CircleDot size={14} />
            <span>{status}</span>
          </div>

          {error ? (
            <div className="fault">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          {commandStatus ? (
            <div className="system-state">
              <ChevronRight size={14} />
              <span>{commandStatus}</span>
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="command-rail">
        <div className="brand-lockup">
          <div className="sigil">
            <Brain size={22} />
          </div>
          <div>
            <h1>Sovereign-Sigma</h1>
            <p>Moltworker Grand Command</p>
          </div>
        </div>

        <div className="session-card">
          <label>
            API
            <input value={apiBase} onChange={(event) => setApiBase(event.target.value)} />
          </label>
          <div className="session-token">
            <span>Session</span>
            <strong>JWT active</strong>
          </div>
          <button className="compact-action" onClick={handleLogout}>
            <LogOut size={16} />
            Lock Console
          </button>
        </div>

        <div className={`system-state ${status.toLowerCase()}`}>
          <CircleDot size={14} />
          <span>{status}</span>
        </div>

        {error ? (
          <div className="fault">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        ) : null}

        {commandStatus ? (
          <div className="system-state">
            <ChevronRight size={14} />
            <span>{commandStatus}</span>
          </div>
        ) : null}
      </section>

      <section className="grand-grid">
        <section className="bridge-panel glass">
          <div className="panel-title">
            <Shield size={17} />
            <span>Moltworker System 2</span>
            {temporaryOverride ? (
              <button
                className="danger-action compact-action"
                disabled={isClearingOverride}
                onClick={() => void submitClearOverride()}
              >
                Clear Override
              </button>
            ) : null}
          </div>
          <div className="intent-hero">
            <span>{macroBias?.direction ?? "NEUTRAL"}</span>
            <strong>{temporaryOverride ? "DEFENSIVE OVERRIDE" : "AUTONOMOUS WATCH"}</strong>
            <p>
              {temporaryOverride
                ? `${temporaryOverride.reason} · expires ${new Date(temporaryOverride.expiresAt).toLocaleTimeString()}`
                : macroBias?.reason ?? "No active supervisor intervention"}
            </p>
          </div>
          <div className="bridge-metrics">
            <Metric label="Realized Alpha" value={currency.format(realizedAlpha)} />
            <Metric label="κ Regime" value={compact.format(pulse?.regimeCoefficient ?? engineState?.oracle.skepticismMultiplier ?? 0)} />
            <Metric label="Bias Power" value={compact.format((macroBias?.intensity ?? 0) * (macroBias?.confidence ?? 0))} />
            <Metric label="Effective Gov" value={engineState?.cachedConfig.ORACLE_GOVERNANCE_MODE ?? "HYBRID"} />
            <Metric label="Baseline Gov" value={config?.ORACLE_GOVERNANCE_MODE ?? "HYBRID"} />
          </div>
        </section>

        <section className="market-strip glass">
          <Metric label="Equity" value={currency.format(displayEquity)} icon={<Gauge size={17} />} />
          <Metric label="Drawdown" value={`${compact.format(drawdown * 100)}%`} icon={<Shield size={17} />} />
          <Metric label="Imbalance" value={imbalance === null ? "n/a" : compact.format(imbalance)} icon={<Zap size={17} />} />
          <Metric label="Regime" value={regime.replace("REGIME_", "")} icon={<RadioTower size={17} />} />
          <Metric label="Latency" value={`${compact.format(pulse?.latency_ms ?? engineState?.averageLatency ?? 0)}ms`} />
          <Metric label="Jitter" value={`${compact.format(pulse?.jitter_ms ?? engineState?.executionProfile.jitterMs ?? 0)}ms`} />
          <Metric label="VPIN" value={compact.format(pulse?.toxicity_score ?? engineState?.toxicityScore ?? 0)} />
          <Metric label="Quotes" value={engineState?.quoteState.status ?? "n/a"} />
        </section>

        <section className="matrix-panel glass">
          <div className="panel-title">
            <SlidersHorizontal size={17} />
            <span>Full Parameter Matrix</span>
            <button
              disabled={isApplyingMatrix || !token || !config}
              onClick={() => void submitDraftConfig()}
            >
              {isApplyingMatrix ? "Applying" : "Apply Matrix"}
            </button>
          </div>
          <div className="param-grid">
            {PARAMETER_MATRIX.map((param) => (
              <ParameterControl
                key={param.key}
                param={param}
                value={draftConfig[param.key] ?? config?.[param.key]}
                onChange={(value) => updateDraft(param.key, value)}
              />
            ))}
          </div>
        </section>

        <section className="moltworker-panel glass">
          <div className="panel-title">
            <Brain size={17} />
            <span>Strategic Bias Injection</span>
            <button disabled={!token} onClick={() => void submitMoltworker()}>
              Inject Bias
            </button>
          </div>
          <div className="supervisor-grid">
            <label>
              Bias
              <select
                value={moltworker.direction}
                onChange={(event) =>
                  setMoltworker((draft) => ({
                    ...draft,
                    direction: event.target.value as MacroBiasDirection
                  }))
                }
              >
                <option>RISK_OFF</option>
                <option>RISK_ON</option>
                <option>BULLISH</option>
                <option>BEARISH</option>
                <option>NEUTRAL</option>
              </select>
            </label>
            <RangeField
              label="Intensity"
              value={moltworker.intensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => setMoltworker((draft) => ({ ...draft, intensity: value }))}
            />
            <RangeField
              label="Confidence"
              value={moltworker.confidence}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => setMoltworker((draft) => ({ ...draft, confidence: value }))}
            />
            <RangeField
              label="Duration"
              value={moltworker.durationMinutes}
              min={1}
              max={240}
              step={1}
              onChange={(value) => setMoltworker((draft) => ({ ...draft, durationMinutes: value }))}
            />
            <label className="wide">
              Strategic Intent
              <input
                value={moltworker.reason}
                onChange={(event) =>
                  setMoltworker((draft) => ({ ...draft, reason: event.target.value }))
                }
              />
            </label>
            <label>
              Self-Tuning
              <select
                value={moltworker.governanceMode}
                onChange={(event) =>
                  setMoltworker((draft) => ({
                    ...draft,
                    governanceMode: event.target.value as GovernanceMode
                  }))
                }
              >
                <option>MANUAL</option>
                <option>AUTONOMOUS</option>
                <option>HYBRID</option>
              </select>
            </label>
            <RangeField
              label="κ Manual"
              value={moltworker.manualSkepticism}
              min={1}
              max={10}
              step={0.05}
              onChange={(value) => setMoltworker((draft) => ({ ...draft, manualSkepticism: value }))}
            />
            <RangeField
              label="κ Max"
              value={moltworker.maxSkepticism}
              min={1}
              max={10}
              step={0.05}
              onChange={(value) => setMoltworker((draft) => ({ ...draft, maxSkepticism: value }))}
            />
          </div>
        </section>

        <section className="system-panel glass">
          <div className="panel-title">
            <RadioTower size={17} />
            <span>Transport & Limits</span>
            <button onClick={submitTransportSettings}>Apply Transport</button>
          </div>
          <div className="transport-grid">
            {(
              [
                ["reconnectBaseMs", "WS Base"],
                ["reconnectMaxMs", "WS Max"],
                ["watchdogMs", "Watchdog"],
                ["rateLimitCapacity", "Bucket Cap"],
                ["rateLimitRefillPerSecond", "Refill/s"]
              ] as Array<[keyof DraftTransportSettings, string]>
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  value={transport[key]}
                  onChange={(event) =>
                    setTransport((draft) => ({ ...draft, [key]: Number(event.target.value) }))
                  }
                />
              </label>
            ))}
          </div>
          <button
            className="danger-action full-action"
            disabled={isResettingLatency || !token}
            onClick={() => void submitResetLatency()}
          >
            {isResettingLatency ? "Resetting" : "Reset Latency Baseline"}
          </button>
        </section>

        <section className="alert-panel glass">
          <div className="panel-title">
            <BellRing size={17} />
            <span>Alerting Channel</span>
            <button disabled={!token || isTestingAlert} onClick={() => void submitAlertTest()}>
              {isTestingAlert ? "Testing" : "Test Alert"}
            </button>
          </div>
          <div className="alert-grid">
            {(alerts?.alerting.channels ?? []).map((channel) => (
              <div className={`channel-row ${channel.configured ? "configured" : "missing"}`} key={channel.channel}>
                <strong>{channel.channel.replace("_", " ")}</strong>
                <span>{channel.configured ? "ARMED" : "MISSING"}</span>
              </div>
            ))}
          </div>
          <div className="alert-summary">
            <Metric
              label="Configured"
              value={alerts?.alerting.configured ? "YES" : "NO"}
            />
            <Metric
              label="Debounce"
              value={`${compact.format(alerts?.alerting.debounceMs ?? 0)}ms`}
            />
            <Metric
              label="Last Delivery"
              value={
                lastAlertTest
                  ? `${lastAlertTest.delivery.delivered}/${lastAlertTest.delivery.attempted}`
                  : "n/a"
              }
            />
          </div>
          {lastAlertTest ? (
            <div className="alert-attempts">
              {lastAlertTest.delivery.attempts.map((attempt) => (
                <div className={attempt.ok ? "ok" : "fail"} key={attempt.channel}>
                  <code>{attempt.channel}</code>
                  <span>{attempt.ok ? `HTTP ${attempt.status}` : attempt.error ?? "FAILED"}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="efficacy-panel glass">
          <div className="panel-title">
            <Zap size={17} />
            <span>Agent Efficacy</span>
          </div>
          <div className="efficacy-grid">
            {(attribution?.byDriver ?? []).slice(0, 8).map((driver) => (
              <div className="driver-row" key={driver.driver}>
                <strong>{driver.driver}</strong>
                <span>{currency.format(driver.cumulativePnl)}</span>
                <span>SR {driver.sharpe === null ? "n/a" : compact.format(driver.sharpe)}</span>
                <span>PF {driver.profitFactor === null ? "n/a" : compact.format(driver.profitFactor)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="trade-panel glass">
          <div className="panel-title">
            <ReceiptText size={17} />
            <span>Trade History</span>
            <button disabled={!token} onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <div className="trade-summary">
            <Metric label="Executions" value={compact.format(tradeSummary.count)} />
            <Metric label="Filled" value={compact.format(tradeSummary.filled)} />
            <Metric label="Realized PnL" value={currency.format(tradeSummary.pnl)} />
            <Metric label="Fees" value={currency.format(tradeSummary.fees)} />
          </div>
          <div className="trade-table">
            {(tradeHistory?.data ?? []).length > 0 ? (
              (tradeHistory?.data ?? []).map((trade) => (
                <div className={`trade-row ${trade.status.toLowerCase()}`} key={trade.tradeId}>
                  <span>{formatClock(trade.executedAt)}</span>
                  <strong>{trade.asset}</strong>
                  <span>{trade.side}</span>
                  <span>{trade.status}</span>
                  <span>{compact.format(trade.size)}</span>
                  <span>{currency.format(trade.price)}</span>
                  <span>{currency.format(trade.resultingPnl ?? 0)}</span>
                  <code>{trade.primaryDriver ?? trade.agentName ?? "EXECUTIONER"}</code>
                </div>
              ))
            ) : (
              <div className="empty-row">NO EXECUTIONS</div>
            )}
          </div>
        </section>

        <section className="cctv-panel glass">
          <div className="panel-title">
            <TerminalSquare size={17} />
            <span>Agent CCTV</span>
          </div>
          <div className="terminal-feed">
            {logicFeed.length > 0
              ? logicFeed.map((item, index) => (
                  <pre key={`${index}:${JSON.stringify(item).slice(0, 20)}`}>
                    {JSON.stringify(item, null, 2)}
                  </pre>
                ))
              : (trace?.terminalFeed ?? []).map((line) => <pre key={line}>{line}</pre>)}
          </div>
        </section>

        <section className="state-panel glass">
          <div className="panel-title">
            <ChevronRight size={17} />
            <span>Raw State Matrix</span>
          </div>
          <div className="state-table">
            {stateRows.slice(0, 180).map(([key, value]) => (
              <div className="state-row" key={key}>
                <code>{key}</code>
                <span>{value}</span>
              </div>
            ))}
          </div>
        </section>
      </section>

      {pendingFields.length > 0 ? (
        <div className="modal-backdrop">
          <div className="confirm-modal">
            <div className="panel-title">
              <Lock size={17} />
              <span>Confirm Action</span>
            </div>
            <p>
              {pendingFields.join(", ")} changed by more than 10%. Type CONFIRM to apply.
            </p>
            <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
            <div className="modal-actions">
              <button onClick={() => setPendingFields([])}>Cancel</button>
              <button
                className="danger-action"
                disabled={confirmText !== "CONFIRM"}
                onClick={() => void submitDraftConfig(true)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Metric({
  label,
  value,
  icon
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="metric">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ParameterControl({
  param,
  value,
  onChange
}: {
  param: (typeof PARAMETER_MATRIX)[number];
  value: unknown;
  onChange: (value: string | number | boolean) => void;
}) {
  if (param.kind === "boolean") {
    return (
      <label className="param-control toggle-control">
        <span>{param.group}</span>
        <strong>{param.label}</strong>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  }

  if (param.kind === "select") {
    return (
      <label className="param-control">
        <span>{param.group}</span>
        <strong>{param.label}</strong>
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          {param.options?.map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
    );
  }

  return (
    <label className="param-control">
      <span>{param.group}</span>
      <strong>{param.label}</strong>
      <input
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={Number(value ?? 0)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <div className="range-line">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output>{compact.format(value)}</output>
      </div>
    </label>
  );
}

function summarizeTrades(trades: TradeHistoryEntry[]) {
  return trades.reduce(
    (summary, trade) => ({
      count: summary.count + 1,
      filled: summary.filled + (trade.status === "FILLED" || trade.status === "PARTIAL" ? 1 : 0),
      pnl: summary.pnl + Number(trade.resultingPnl ?? 0),
      fees: summary.fees + Number(trade.fees ?? 0)
    }),
    { count: 0, filled: 0, pnl: 0, fees: 0 }
  );
}

function normalizeTradePayload(payload: unknown): TradeHistoryEntry {
  const record = (payload && typeof payload === "object" ? payload : {}) as Partial<TradeHistoryEntry> & {
    tradeId?: string;
    orderId?: string;
    asset?: string;
    price?: number;
    size?: number;
    evAtExecution?: number;
    slippageBps?: number;
    resultingPnl?: number;
    fees?: number;
    status?: TradeHistoryEntry["status"];
    executedAt?: string;
  };
  const price = Number(record.price ?? 0);
  const size = Number(record.size ?? 0);

  return {
    tradeId: record.tradeId ?? crypto.randomUUID(),
    orderId: record.orderId ?? "unknown",
    signalId: record.signalId ?? null,
    venue: record.venue ?? "unknown",
    asset: record.asset ?? "unknown",
    side: record.side ?? "BUY",
    orderType: record.orderType ?? "LIMIT",
    price,
    size,
    notional: Number(record.notional ?? price * size),
    evAtExecution: Number(record.evAtExecution ?? 0),
    slippageBps: Number(record.slippageBps ?? 0),
    resultingPnl: Number(record.resultingPnl ?? 0),
    primaryDriver: record.primaryDriver ?? null,
    fees: Number(record.fees ?? 0),
    status: record.status ?? "ACCEPTED",
    exchangeTradeId: record.exchangeTradeId ?? null,
    rawExecution: record.rawExecution ?? {},
    agentName: record.agentName ?? null,
    traceId: record.traceId ?? null,
    executedAt: record.executedAt ?? new Date().toISOString(),
    createdAt: record.createdAt ?? new Date().toISOString()
  };
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleTimeString();
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown command-center error";
}

"use client";

import {
  AlertTriangle,
  BellRing,
  Brain,
  ChevronRight,
  CircleDot,
  Flame,
  Gauge,
  Info,
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
  readDiagnostics,
  readSettings,
  readState,
  readTradeHistory,
  readTrace,
  resetLatencyBaseline,
  sendTestAlert,
  toWebSocketUrl,
  updateConfig,
  updateTradingMode
} from "@/lib/api";
import {
  DEFAULT_TRANSPORT_SETTINGS,
  PARAMETER_MATRIX,
  changedMoreThanTenPercent,
  flattenState,
  parameterHelp,
  validateParameterDraft
} from "@/lib/parameters";
import type {
  AttributionResponse,
  AlertingResponse,
  AlertPriority,
  AlertTestResponse,
  AdminSettingsResponse,
  DashboardPulse,
  DiagnosticCheck,
  DiagnosticsResponse,
  DraftTransportSettings,
  EngineState,
  GlobalRiskConfig,
  GovernanceMode,
  JsonRecord,
  LiquidationHeatmapState,
  MacroBiasDirection,
  PaperPnlAsset,
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

interface PaperPnlDisplay {
  windowHours: number;
  tradeCount: number;
  paperMtm: number | null;
  returnBps: number | null;
  realizedPnl: number;
  totalEv: number;
  totalFees: number;
  grossNotional: number;
  assets: Array<
    PaperPnlAsset & {
      midPrice: number | null;
      markToMarketPnl: number | null;
      returnBps: number | null;
    }
  >;
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
  const [orderBook, setOrderBook] = useState<JsonRecord | null>(null);
  const [config, setConfig] = useState<GlobalRiskConfig | null>(null);
  const [draftConfig, setDraftConfig] = useState<Partial<GlobalRiskConfig>>({});
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [attribution, setAttribution] = useState<AttributionResponse | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryResponse | null>(null);
  const [alerts, setAlerts] = useState<AlertingResponse | null>(null);
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null);
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
  const [isSwitchingMode, setIsSwitchingMode] = useState(false);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
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

    const [stateResult, configResult, traceResult, attributionResult, historyResult, alertsResult, settingsResult] = await Promise.all([
      readState(apiBase, token),
      readConfig(apiBase, token),
      readTrace(apiBase, token),
      readAttribution(apiBase, token),
      readTradeHistory(apiBase, token),
      readAlerts(apiBase, token),
      readSettings(apiBase, token)
    ]);

    setEngineState(stateResult.state);
    setOrderBook(stateResult.orderBook ?? null);
    setConfig(configResult.config);
    if (!draftDirtyRef.current) {
      setDraftConfig(configResult.config);
    }
    setTrace(traceResult);
    setAttribution(attributionResult);
    setTradeHistory(historyResult);
    setAlerts(alertsResult);
    setSettings(settingsResult);
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
  const totalOrderEvents = tradeHistory?.pagination.total ?? tradeSummary.count;
  const paperPnl = useMemo(
    () => summarizePaperPnl(tradeHistory?.paperPnl, engineState),
    [engineState, tradeHistory?.paperPnl]
  );
  const operatorMode = useMemo<"OBSERVE" | "PAPER" | "LIVE">(() => {
    if (engineState?.mode === "LIVE") {
      return "LIVE";
    }

    return config?.TRADING_ENABLED ? "PAPER" : "OBSERVE";
  }, [config?.TRADING_ENABLED, engineState?.mode]);
  const executionSettings = isJsonRecord(settings?.backend.execution)
    ? settings.backend.execution
    : null;
  const shadowModeActive =
    engineState?.citadel?.shadowMode === true ||
    executionSettings?.shadowMode === true ||
    String(executionSettings?.shadowMode ?? process.env.NEXT_PUBLIC_SHADOW_MODE ?? "false")
      .toLowerCase() === "true";

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
    setOrderBook(null);
    setConfig(null);
    setDraftConfig({});
    setTrace(null);
    setAttribution(null);
    setTradeHistory(null);
    setAlerts(null);
    setSettings(null);
    setLastAlertTest(null);
    setDiagnostics(null);
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

    const validationErrors = validateParameterDraft(draftConfig);
    if (validationErrors.length > 0) {
      setError(validationErrors.join(" "));
      setCommandStatus("Matrix validation blocked.");
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

  async function switchTradingMode(mode: "OBSERVE" | "PAPER" | "LIVE") {
    if (!token) {
      return;
    }

    if (
      mode === "LIVE" &&
      !window.confirm("LIVE mode can submit real exchange orders when execution test mode is disabled. Continue?")
    ) {
      return;
    }

    setError(null);
    setIsSwitchingMode(true);
    setCommandStatus(mode === "LIVE" ? "Requesting live mode..." : `Switching to ${mode.toLowerCase()} mode...`);

    try {
      await updateTradingMode(apiBase, token, mode);
      draftDirtyRef.current = false;
      await refresh();
      setCommandStatus(
        mode === "OBSERVE"
          ? "Trading disabled. Engine remains in observation mode."
          : mode === "PAPER"
            ? "Paper trading enabled. Exchange execution remains test-mode locked."
            : "Live trading enabled."
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus(mode === "LIVE" ? "Live mode is locked by execution safeguards." : "Mode switch failed.");
    } finally {
      setIsSwitchingMode(false);
    }
  }

  async function switchGovernanceMode(mode: "AUTONOMOUS" | "MANUAL") {
    if (!token) {
      return;
    }

    setError(null);
    setIsSwitchingMode(true);
    setCommandStatus(`Switching governance to ${mode.toLowerCase()}...`);

    try {
      await updateConfig(apiBase, token, { ORACLE_GOVERNANCE_MODE: mode });
      draftDirtyRef.current = false;
      await refresh();
      setCommandStatus(mode === "AUTONOMOUS" ? "Autonomous governance armed." : "Manual intervention armed.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Governance switch failed.");
    } finally {
      setIsSwitchingMode(false);
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

  async function runIntegrityCheck() {
    if (!token) {
      return;
    }

    setError(null);
    setIsRunningDiagnostics(true);
    setCommandStatus("Running integrity diagnostics...");

    try {
      const response = await readDiagnostics(apiBase, token);
      setDiagnostics(response);
      setCommandStatus(response.ok ? "Integrity check optimal." : "Integrity check found anomalies.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Integrity check failed.");
    } finally {
      setIsRunningDiagnostics(false);
    }
  }

  const macroBias = pulse?.macroBias ?? engineState?.macroBias ?? null;
  const temporaryOverride = pulse?.temporaryOverride ?? engineState?.temporaryOverride ?? null;
  const governanceMode =
    engineState?.cachedConfig.ORACLE_GOVERNANCE_MODE ??
    config?.ORACLE_GOVERNANCE_MODE ??
    "HYBRID";
  const isManualGovernance = governanceMode === "MANUAL";
  const assetMatrix = useMemo(
    () => normalizeAssetMatrix(engineState?.assetMatrix),
    [engineState?.assetMatrix]
  );
  const displayEquity = pulse?.total_equity ?? engineState?.bankroll.equity ?? 0;
  const drawdown = pulse?.active_drawdown ?? engineState?.riskMetrics.rollingDrawdownPct ?? 0;
  const imbalance = pulse?.current_imbalance ?? engineState?.microstructure.weightedImbalance ?? null;
  const regime = pulse?.regime ?? engineState?.oracle.regime ?? "UNKNOWN";
  const dwellirReceiptLatencyMs =
    pulse?.exchange_to_receipt_ms ?? pulse?.latency_ms ?? engineState?.averageLatency ?? 0;
  const liquidationHeatmap = engineState?.liquidationHeatmap ?? null;
  const liquidationRows = useMemo(
    () => liquidationHeatmapRows(liquidationHeatmap),
    [liquidationHeatmap]
  );
  const ladder = useMemo(
    () => topOrderBookLadder(orderBook, engineState?.microstructure.midPrice ?? null),
    [orderBook, engineState?.microstructure.midPrice]
  );

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
    <main className={isManualGovernance ? "shell manual-governance" : "shell"}>
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
          <button
            className="compact-action integrity-action"
            disabled={isRunningDiagnostics}
            onClick={() => void runIntegrityCheck()}
          >
            <Shield size={16} />
            {isRunningDiagnostics ? "Scanning" : "Run Integrity Check"}
          </button>
        </div>

        <div className={`system-state ${status.toLowerCase()}`}>
          <CircleDot size={14} />
          <span>{status}</span>
        </div>

        <div className="dwellir-stream-state">
          <RadioTower size={14} />
          <span>[ DWELLIR ENTERPRISE gRPC + L2-100 BOOK WS: ACTIVE ]</span>
          <strong>{compact.format(dwellirReceiptLatencyMs)}ms</strong>
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

      {shadowModeActive ? (
        <section className="shadow-mode-banner" role="status" aria-live="polite">
          [ WARNING: SYSTEM IS OPERATING IN SHADOW MODE. NO REAL TRADES ARE BEING EXECUTED. ]
        </section>
      ) : null}

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
          <button
            className={isManualGovernance ? "governance-switch manual" : "governance-switch autonomous"}
            disabled={isSwitchingMode}
            onClick={() => void switchGovernanceMode(isManualGovernance ? "AUTONOMOUS" : "MANUAL")}
          >
            [{isManualGovernance ? " MANUAL INTERVENTION " : " AUTONOMOUS MODE "}]
          </button>
          <div className={isManualGovernance ? "asset-pulse-grid dimmed" : "asset-pulse-grid"}>
            {assetMatrix.map((asset) => (
              <span
                className={asset.selectedByMoltworker && asset.active ? "asset-pill live" : "asset-pill"}
                key={asset.instrumentCode}
                title={`${asset.instrumentCode} allocation ${compact.format(asset.capitalAllocationPct * 100)}%`}
              >
                <strong>{asset.selectedByMoltworker && asset.active ? "●" : "○"} {asset.coin}</strong>
                <small>{compact.format(asset.capitalAllocationPct * 100)}%</small>
              </span>
            ))}
          </div>
          <div className="bridge-metrics">
            <Metric label="Paper MTM" value={formatNullableCurrency(paperPnl.paperMtm)} />
            <Metric label="Paper Return" value={formatBps(paperPnl.returnBps)} />
            <Metric label="κ Regime" value={compact.format(pulse?.regimeCoefficient ?? engineState?.oracle.skepticismMultiplier ?? 0)} />
            <Metric label="Bias Power" value={compact.format((macroBias?.intensity ?? 0) * (macroBias?.confidence ?? 0))} />
            <Metric label="Realized Alpha" value={currency.format(realizedAlpha)} />
            <Metric label="Effective Gov" value={engineState?.cachedConfig.ORACLE_GOVERNANCE_MODE ?? "HYBRID"} />
          </div>
        </section>

        <section className="market-strip glass">
          <Metric label="Equity" value={currency.format(displayEquity)} icon={<Gauge size={17} />} />
          <Metric label="Drawdown" value={`${compact.format(drawdown * 100)}%`} icon={<Shield size={17} />} />
          <Metric label="Imbalance" value={imbalance === null ? "n/a" : compact.format(imbalance)} icon={<Zap size={17} />} />
          <Metric label="Regime" value={regime.replace("REGIME_", "")} icon={<RadioTower size={17} />} />
          <Metric label="Dwellir Receipt Δ" value={`${compact.format(dwellirReceiptLatencyMs)}ms`} />
          <Metric label="Jitter" value={`${compact.format(pulse?.jitter_ms ?? engineState?.executionProfile.jitterMs ?? 0)}ms`} />
          <Metric label="VPIN" value={compact.format(pulse?.toxicity_score ?? engineState?.toxicityScore ?? 0)} />
          <Metric label="Quotes" value={engineState?.quoteState.status ?? "n/a"} />
        </section>

        <section className="liquidation-panel glass">
          <div className="panel-title">
            <Flame size={17} />
            <span>Liquidation Hunt Map</span>
            <strong className="panel-pill">
              {currency.format(liquidationHeatmap?.totalEstimatedNotionalUsd ?? 0)}
            </strong>
          </div>
          <div className="hunt-grid">
            <div className="ladder-card">
              <div className="ladder-head">
                <span>Order Book</span>
                <code>{engineState?.microstructure.midPrice ? currency.format(engineState.microstructure.midPrice) : "mid n/a"}</code>
              </div>
              <div className="ladder-table asks">
                {ladder.asks.map((level) => (
                  <div className="ladder-row ask" key={`ask:${level.price}`}>
                    <span>{currency.format(level.price)}</span>
                    <strong>{compact.format(level.size)}</strong>
                  </div>
                ))}
              </div>
              <div className="midline">
                <span>Spread</span>
                <strong>{compact.format(engineState?.microstructure.spreadBps ?? 0)} bps</strong>
              </div>
              <div className="ladder-table bids">
                {ladder.bids.map((level) => (
                  <div className="ladder-row bid" key={`bid:${level.price}`}>
                    <span>{currency.format(level.price)}</span>
                    <strong>{compact.format(level.size)}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="heatmap-card">
              <div className="heatmap-head">
                <span>Leverage Cliffs</span>
                <code>{liquidationHeatmap?.clusters.length ?? 0} clusters</code>
              </div>
              <div className="heatmap-stack">
                {liquidationRows.length > 0 ? (
                  liquidationRows.map((cluster) => (
                    <div className={`heatmap-row ${cluster.side.toLowerCase()}`} key={cluster.clusterId}>
                      <div className="heatmap-main">
                        <strong>{currency.format(cluster.centerPrice)}</strong>
                        <span>{cluster.side} · {cluster.distance}</span>
                      </div>
                      <div className="heat-bar">
                        <i style={{ width: `${cluster.widthPct}%` }} />
                      </div>
                      <code>{currency.format(cluster.estimatedNotionalUsd)}</code>
                    </div>
                  ))
                ) : (
                  <div className="empty-row">NO WATCHLIST LIQUIDATION CLUSTERS</div>
                )}
              </div>
            </div>

            <div className="cascade-card">
              <Metric
                label="Cascade Distance"
                value={
                  liquidationHeatmap?.nearestCascade?.distanceFromMidBps === null ||
                  liquidationHeatmap?.nearestCascade?.distanceFromMidBps === undefined
                    ? "n/a"
                    : `${compact.format(liquidationHeatmap.nearestCascade.distanceFromMidBps)} bps`
                }
              />
              <Metric
                label="Shield"
                value={liquidationHeatmap?.nearestCascade?.isCascadeRisk ? "ARMED" : "CLEAR"}
              />
              <Metric
                label="Watchlist"
                value={compact.format(liquidationHeatmap?.sampledWalletCount ?? 0)}
              />
              <Metric
                label="Updated"
                value={
                  liquidationHeatmap?.updatedAt
                    ? formatClock(liquidationHeatmap.updatedAt)
                    : "n/a"
                }
              />
            </div>
          </div>
        </section>

        <section className="mode-panel glass">
          <div className="panel-title">
            <CircleDot size={17} />
            <span>Execution Mode</span>
          </div>
          <div className="mode-grid">
            <button
              className={operatorMode === "OBSERVE" ? "mode-active" : ""}
              disabled={isSwitchingMode || !token}
              onClick={() => void switchTradingMode("OBSERVE")}
            >
              Observe
            </button>
            <button
              className={operatorMode === "PAPER" ? "mode-active" : ""}
              disabled={isSwitchingMode || !token}
              onClick={() => void switchTradingMode("PAPER")}
            >
              Paper
            </button>
            <button
              className={operatorMode === "LIVE" ? "mode-live mode-active" : "mode-live"}
              disabled={isSwitchingMode || !token}
              onClick={() => void switchTradingMode("LIVE")}
            >
              Live
            </button>
          </div>
          <div className="mode-readout">
            <span>Engine {engineState?.mode ?? "PAPER"}</span>
            <span>Kill {config?.TRADING_ENABLED ? "OPEN" : "CLOSED"}</span>
            <span>
              {shadowModeActive
                ? "GHOST FILLS"
                : operatorMode === "LIVE"
                  ? "REAL ORDERS"
                  : operatorMode === "PAPER"
                    ? "SIGNED TEST ORDERS"
                    : "NO ORDERS"}
            </span>
          </div>
        </section>

        <section className="matrix-panel glass">
          <div className="panel-title">
            <SlidersHorizontal size={17} />
            <span>Full Parameter Matrix</span>
            <button
              disabled={isApplyingMatrix || !token || !config || !isManualGovernance}
              onClick={() => void submitDraftConfig()}
            >
              {isApplyingMatrix ? "APPLYING" : "APPLY CHANGES"}
            </button>
          </div>
          <div className="param-grid">
            {PARAMETER_MATRIX.map((param) => (
              <ParameterControl
                key={param.key}
                param={param}
                value={draftConfig[param.key] ?? config?.[param.key]}
                onChange={(value) => updateDraft(param.key, value)}
                disabled={!isManualGovernance}
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
            <Metric label="Order Events" value={compact.format(totalOrderEvents)} />
            <Metric label="Ghost Fills" value={compact.format(paperPnl.tradeCount || tradeSummary.filled)} />
            <Metric label="Paper MTM" value={formatNullableCurrency(paperPnl.paperMtm)} />
            <Metric label="Expected EV" value={currency.format(paperPnl.totalEv)} />
            <Metric label="Gross Notional" value={currency.format(paperPnl.grossNotional)} />
            <Metric label="Fees" value={currency.format(paperPnl.totalFees || tradeSummary.fees)} />
          </div>
          {paperPnl.assets.length > 0 ? (
            <div className="paper-pnl-grid" aria-label="Paper mark-to-market by asset">
              {paperPnl.assets.map((asset) => (
                <div
                  className={asset.markToMarketPnl !== null && asset.markToMarketPnl < 0 ? "paper-pnl-row negative" : "paper-pnl-row positive"}
                  key={asset.asset}
                >
                  <strong>{asset.asset}</strong>
                  <span>{formatNullableCurrency(asset.markToMarketPnl)}</span>
                  <span>Net {compact.format(asset.netQuantity)}</span>
                  <span>{asset.midPrice === null ? "mark n/a" : currency.format(asset.midPrice)}</span>
                  <code>{formatBps(asset.returnBps)}</code>
                </div>
              ))}
            </div>
          ) : null}
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
              <div className="empty-row">NO ORDER EVENTS</div>
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
              Warning: Overriding System 2 Logic. Confirm manual parameter override?
              {" "}{pendingFields.join(", ")} changed by more than 10%. Type CONFIRM to apply.
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

      {diagnostics ? (
        <div className="modal-backdrop">
          <div className="confirm-modal diagnostics-modal">
            <div className="panel-title">
              <Shield size={17} />
              <span>System Integrity Protocol</span>
            </div>
            <div className="diagnostic-list">
              {diagnostics.checks.map((check) => (
                <DiagnosticRow check={check} key={check.id} />
              ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setDiagnostics(null)}>Close</button>
              <button onClick={() => void runIntegrityCheck()} disabled={isRunningDiagnostics}>
                Re-run
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
  onChange,
  disabled = false
}: {
  param: (typeof PARAMETER_MATRIX)[number];
  value: unknown;
  onChange: (value: string | number | boolean) => void;
  disabled?: boolean;
}) {
  const help = parameterHelp(param);

  if (param.kind === "boolean") {
    return (
      <label className="param-control toggle-control">
        <span>{param.group}</span>
        <strong>{param.label}<InfoBadge text={help} /></strong>
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  }

  if (param.kind === "select") {
    return (
      <label className="param-control">
        <span>{param.group}</span>
        <strong>{param.label}<InfoBadge text={help} /></strong>
        <select
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {param.options?.map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
    );
  }

  return (
    <label className="param-control">
      <span>{param.group}</span>
      <strong>{param.label}<InfoBadge text={help} /></strong>
      <input
        type="number"
        aria-label={param.label}
        data-testid={`param-${String(param.key)}`}
        min={param.min}
        max={param.max}
        step={param.step}
        value={Number(value ?? 0)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function InfoBadge({ text }: { text: string }) {
  return (
    <span className="info-badge" tabIndex={0}>
      <Info size={11} />
      <span className="info-popover">{text}</span>
    </span>
  );
}

function DiagnosticRow({ check }: { check: DiagnosticCheck }) {
  return (
    <div className={`diagnostic-row ${check.status.toLowerCase()}`}>
      <code>{check.status}</code>
      <div>
        <strong>{check.label}</strong>
        <span>{check.detail}</span>
      </div>
    </div>
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
      filled:
        summary.filled +
        (trade.status === "FILLED" || trade.status === "PARTIAL" || trade.status === "GHOST_FILL"
          ? 1
          : 0),
      pnl: summary.pnl + Number(trade.resultingPnl ?? 0),
      fees: summary.fees + Number(trade.fees ?? 0)
    }),
    { count: 0, filled: 0, pnl: 0, fees: 0 }
  );
}

function summarizePaperPnl(
  summary: TradeHistoryResponse["paperPnl"] | undefined,
  state: EngineState | null
): PaperPnlDisplay {
  const sourceAssets = summary?.assets ?? [];
  let grossNotional = 0;
  let totalEv = 0;
  let totalFees = 0;
  let realizedPnl = 0;
  let markedPnl = 0;
  let hasMarks = false;

  const assets = sourceAssets.map((asset) => {
    const midPrice = findAssetMarkPrice(asset.asset, state);
    const gross = Number(asset.grossNotional ?? 0);
    const fees = Number(asset.totalFees ?? 0);
    const markToMarketPnl =
      midPrice === null
        ? null
        : roundDisplay(Number(asset.cashPnl ?? 0) + Number(asset.netQuantity ?? 0) * midPrice - fees);
    const returnBps =
      markToMarketPnl === null || gross <= 0
        ? null
        : roundDisplay((markToMarketPnl / gross) * 10_000, 4);

    grossNotional += gross;
    totalEv += Number(asset.totalEv ?? 0);
    totalFees += fees;
    realizedPnl += Number(asset.realizedPnl ?? 0);
    if (markToMarketPnl !== null) {
      markedPnl += markToMarketPnl;
      hasMarks = true;
    }

    return {
      ...asset,
      midPrice,
      markToMarketPnl,
      returnBps
    };
  });

  const totals = summary?.totals;
  const totalGross = Number(totals?.grossNotional ?? grossNotional);
  const paperMtm = hasMarks ? roundDisplay(markedPnl) : null;

  return {
    windowHours: Number(summary?.windowHours ?? 24),
    tradeCount: Number(totals?.tradeCount ?? sourceAssets.reduce((count, asset) => count + Number(asset.tradeCount ?? 0), 0)),
    paperMtm,
    returnBps: paperMtm === null || totalGross <= 0 ? null : roundDisplay((paperMtm / totalGross) * 10_000, 4),
    realizedPnl: roundDisplay(Number(totals?.realizedPnl ?? realizedPnl)),
    totalEv: roundDisplay(Number(totals?.totalEv ?? totalEv)),
    totalFees: roundDisplay(Number(totals?.totalFees ?? totalFees)),
    grossNotional: roundDisplay(totalGross),
    assets
  };
}

function findAssetMarkPrice(asset: string, state: EngineState | null): number | null {
  const matrix = state?.assetMatrix ?? {};
  const normalizedAsset = asset.toLowerCase().replace(/[^a-z0-9]/g, "");
  const directCandidates = [
    asset,
    asset.toUpperCase(),
    asset.toLowerCase(),
    `${asset}-PERP`,
    `${asset.toUpperCase()}-PERP`,
    `${asset.toLowerCase()}-perp`,
    `${asset}-USD`,
    `${asset.toUpperCase()}-USD`,
    `${asset.toLowerCase()}-usd`
  ];

  for (const candidate of directCandidates) {
    const mark = numberOrNull(matrix[candidate]?.midPrice);
    if (mark !== null) {
      return mark;
    }
  }

  for (const runtime of Object.values(matrix)) {
    const coin = runtime.coin.toLowerCase().replace(/[^a-z0-9]/g, "");
    const instrument = runtime.instrumentCode.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (coin === normalizedAsset || instrument.startsWith(normalizedAsset)) {
      const mark = numberOrNull(runtime.midPrice);
      if (mark !== null) {
        return mark;
      }
    }
  }

  return null;
}

function formatNullableCurrency(value: number | null): string {
  return value === null ? "n/a" : currency.format(value);
}

function formatBps(value: number | null): string {
  return value === null ? "n/a" : `${compact.format(value)} bps`;
}

function roundDisplay(value: number, precision = 8): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
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

function liquidationHeatmapRows(heatmap: LiquidationHeatmapState | null) {
  const clusters = (heatmap?.clusters ?? []).slice(0, 10);
  const maxNotional = Math.max(
    1,
    ...clusters.map((cluster) => Number(cluster.estimatedNotionalUsd ?? 0))
  );

  return clusters.map((cluster) => ({
    ...cluster,
    distance:
      cluster.distanceFromMidBps === null
        ? "distance n/a"
        : `${compact.format(cluster.distanceFromMidBps)} bps`,
    widthPct: Math.max(
      8,
      Math.min(100, (Number(cluster.estimatedNotionalUsd ?? 0) / maxNotional) * 100)
    )
  }));
}

function topOrderBookLadder(orderBook: JsonRecord | null, midPrice: number | null) {
  const snapshots = Object.values(orderBook ?? {})
    .filter(isJsonRecord)
    .map((value) => ({
      bids: readBookLevels(value.bids),
      asks: readBookLevels(value.asks),
      midPrice: numberOrNull(value.midPrice)
    }))
    .filter((value) => value.bids.length > 0 || value.asks.length > 0);
  const selected =
    snapshots.find((snapshot) => snapshot.midPrice === midPrice) ??
    snapshots[0] ??
    { bids: [], asks: [] };

  return {
    bids: selected.bids.slice(0, 8),
    asks: selected.asks.slice(0, 8).reverse()
  };
}

function normalizeAssetMatrix(value: EngineState["assetMatrix"] | undefined) {
  const fallback = [
    ["btc-usd", "BTC"],
    ["eth-usd", "ETH"],
    ["hype-usd", "HYPE"],
    ["sol-usd", "SOL"]
  ] as const;

  return fallback.map(([instrumentCode, coin]) => {
    const asset = value?.[instrumentCode];
    return {
      instrumentCode,
      coin,
      selectedByMoltworker: asset?.selectedByMoltworker ?? true,
      active: asset?.active ?? false,
      capitalAllocationPct: Number(asset?.capitalAllocationPct ?? 0),
      amVpin: Number(asset?.amVpin ?? 0),
      obi: asset?.obi ?? null,
      toxicityState: asset?.toxicityState ?? "NORMAL"
    };
  });
}

function readBookLevels(value: unknown): Array<{ price: number; size: number }> {
  return Array.isArray(value)
    ? value
        .filter(isJsonRecord)
        .map((item) => ({
          price: Number(item.price ?? 0),
          size: Number(item.size ?? 0)
        }))
        .filter((item) => Number.isFinite(item.price) && Number.isFinite(item.size))
    : [];
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

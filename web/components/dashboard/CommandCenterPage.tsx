"use client";

import {
  AlertTriangle,
  Bot,
  Brain,
  ChevronRight,
  CircleDot,
  DatabaseZap,
  Flame,
  Gauge,
  KeyRound,
  Landmark,
  LogOut,
  RadioTower,
  ReceiptText,
  Settings,
  Shield,
  TerminalSquare,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_API_BASE,
  clearOverride,
  closeCascadePosition,
  injectMoltworkerIntent,
  login,
  readAttribution,
  readCascadeActive,
  readCascadeHeat,
  readCascadePositions,
  readCascadeSignals,
  readConfig,
  readCostDashboard,
  readCongressStatus,
  readCongressTickerHierarchy,
  readDiagnostics,
  readExecutionQuality,
  readLiveReadiness,
  readSettings,
  readState,
  readTradeHistory,
  readTrace,
  readReplayStatus,
  resetLatencyBaseline,
  runCascadeBacktest,
  startReplay,
  toWebSocketUrl,
  updateConfig,
  updateTradingMode
} from "@/lib/api";
import { DEFAULT_TRANSPORT_SETTINGS } from "@/lib/parameters";
import { DiagnosticRow, Metric, RangeField } from "./DashboardPrimitives";
import type {
  AttributionResponse,
  AdminSettingsResponse,
  CostDashboardResponse,
  CascadeActiveItem,
  CascadeHeatResponse,
  CascadePositionItem,
  CongressStatusResponse,
  CongressTickerHierarchyResponse,
  DashboardPulse,
  DiagnosticsResponse,
  DraftTransportSettings,
  EngineState,
  ExecutionQualityResponse,
  GlobalRiskConfig,
  GovernanceMode,
  JsonRecord,
  LiveReadinessResponse,
  LiquidationHeatmapState,
  MacroBiasDirection,
  PaperPnlAsset,
  PaperLedger,
  ReplayStatus,
  StrategyMode,
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
  openUnrealizedPnl: number | null;
  returnBps: number | null;
  realizedPnl: number;
  realizedNetPnl: number;
  totalEv: number;
  totalFees: number;
  grossNotional: number;
  assets: Array<
    PaperPnlAsset & {
      midPrice: number | null;
      markToMarketPnl: number | null;
      realizedNetPnl: number;
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

const RETIRED_DRIVER_NAMES = new Set(["HEDGE"]);
const STRATEGY_MODE_OPTIONS: Array<{ value: StrategyMode; label: string }> = [
  { value: "OFF", label: "OFF" },
  { value: "MARKET_MAKING", label: "MM" },
  { value: "CASCADE_RECOVERY", label: "CASCADE" },
  { value: "BOTH_SHADOW", label: "BOTH SHADOW" },
  { value: "BOTH_LIVE", label: "BOTH LIVE" }
];
const CASCADE_ASSET_OPTIONS = ["BTC", "ETH", "SOL", "HYPE"] as const;

export default function CommandCenterPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("LOCKED");
  const [error, setError] = useState<string | null>(null);
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [orderBook, setOrderBook] = useState<JsonRecord | null>(null);
  const [config, setConfig] = useState<GlobalRiskConfig | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [attribution, setAttribution] = useState<AttributionResponse | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryResponse | null>(null);
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null);
  const [executionQuality, setExecutionQuality] = useState<ExecutionQualityResponse | null>(null);
  const [costDashboard, setCostDashboard] = useState<CostDashboardResponse | null>(null);
  const [congressStatus, setCongressStatus] = useState<CongressStatusResponse | null>(null);
  const [congressTickerHierarchy, setCongressTickerHierarchy] =
    useState<CongressTickerHierarchyResponse | null>(null);
  const [cascadeActive, setCascadeActive] = useState<CascadeActiveItem[]>([]);
  const [cascadePositions, setCascadePositions] = useState<CascadePositionItem[]>([]);
  const [cascadeSignals, setCascadeSignals] = useState<JsonRecord[]>([]);
  const [cascadeHeat, setCascadeHeat] = useState<CascadeHeatResponse["heat"] | null>(null);
  const [pulse, setPulse] = useState<DashboardPulse | null>(null);
  const [logicFeed, setLogicFeed] = useState<JsonRecord[]>([]);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [isClearingOverride, setIsClearingOverride] = useState(false);
  const [isResettingLatency, setIsResettingLatency] = useState(false);
  const [isSwitchingMode, setIsSwitchingMode] = useState(false);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [liveReadiness, setLiveReadiness] = useState<LiveReadinessResponse | null>(null);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus | null>(null);
  const [lastReplay, setLastReplay] = useState<JsonRecord | null>(null);
  const [lastCascadeBacktest, setLastCascadeBacktest] = useState<JsonRecord | null>(null);
  const [isRunningReplay, setIsRunningReplay] = useState(false);
  const [isRunningCascadeBacktest, setIsRunningCascadeBacktest] = useState(false);
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
  const isUnlocked = Boolean(token);

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    const [
      stateResult,
      configResult,
      traceResult,
      attributionResult,
      historyResult,
      settingsResult,
      liveReadinessResult,
      replayStatusResult,
      executionQualityResult,
      costDashboardResult,
      cascadeActiveResult,
      cascadePositionsResult,
      cascadeSignalsResult,
      cascadeHeatResult,
      congressStatusResult,
      congressTickerResult
    ] = await Promise.all([
      readState(apiBase, token),
      readConfig(apiBase, token),
      readTrace(apiBase, token),
      readAttribution(apiBase, token),
      readTradeHistory(apiBase, token),
      readSettings(apiBase, token),
      readLiveReadiness(apiBase, token),
      readReplayStatus(apiBase, token),
      readExecutionQuality(apiBase, token),
      readCostDashboard(apiBase, token),
      readCascadeActive(apiBase, token),
      readCascadePositions(apiBase, token),
      readCascadeSignals(apiBase, token, 50),
      readCascadeHeat(apiBase, token),
      readCongressStatus(apiBase, token).catch(() => null),
      readCongressTickerHierarchy(apiBase, token, "24h").catch(() => null)
    ]);

    setEngineState(stateResult.state);
    setOrderBook(stateResult.orderBook ?? null);
    setConfig(configResult.config);
    setTrace(traceResult);
    setAttribution(attributionResult);
    setTradeHistory(historyResult);
    setSettings(settingsResult);
    setLiveReadiness(liveReadinessResult);
    setReplayStatus(replayStatusResult.replay);
    setExecutionQuality(executionQualityResult);
    setCostDashboard(costDashboardResult);
    setCascadeActive(cascadeActiveResult.cascades ?? []);
    setCascadePositions(cascadePositionsResult.positions ?? []);
    setCascadeSignals(cascadeSignalsResult.signals ?? []);
    setCascadeHeat(cascadeHeatResult.heat ?? null);
    setCongressStatus(congressStatusResult?.ok ? congressStatusResult : null);
    setCongressTickerHierarchy(congressTickerResult?.ok ? congressTickerResult : null);
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
        setLogicFeed((items) =>
          [...((nextPulse.AgentLogicTrace ?? []) as JsonRecord[]), ...items].slice(0, 80)
        );
      }

      if (typed.type === "AGENT_SIGNAL" && typed.payload) {
        setLogicFeed((items) => [typed.payload as JsonRecord, ...items].slice(0, 80));
      }

      if (typed.type === "TRADE_EXECUTION_UPDATE" && typed.payload) {
        const trade = normalizeTradePayload(typed.payload);
        setTradeHistory((current) => ({
          ok: true,
          data: [
            trade,
            ...(current?.data ?? []).filter((row) => row.tradeId !== trade.tradeId)
          ].slice(0, 50),
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

  const visibleAttributionDrivers = useMemo(
    () => (attribution?.byDriver ?? []).filter(isActiveAttributionDriver),
    [attribution]
  );
  const agentHealthRows = useMemo(
    () => summarizeAgentHealth(engineState, visibleAttributionDrivers),
    [engineState, visibleAttributionDrivers]
  );
  const realizedAlpha = useMemo(
    () =>
      visibleAttributionDrivers.reduce((sum, driver) => sum + Number(driver.cumulativePnl ?? 0), 0),
    [visibleAttributionDrivers]
  );
  const tradeSummary = useMemo(() => summarizeTrades(tradeHistory?.data ?? []), [tradeHistory]);
  const paperTradeRows = tradeHistory?.paperTrades ?? [];
  const paperLedger = tradeHistory?.paperLedger ?? null;
  const statusSummary = useMemo(
    () => summarizeTradeStatuses(tradeHistory?.statusBreakdown ?? []),
    [tradeHistory?.statusBreakdown]
  );
  const totalOrderEvents = tradeHistory?.pagination.total ?? tradeSummary.count;
  const paperPnl = useMemo(
    () => summarizePaperPnl(tradeHistory?.paperPnl, engineState, paperLedger),
    [engineState, paperLedger, tradeHistory?.paperPnl]
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
  const ingestSettings = isJsonRecord(settings?.backend.ingest) ? settings.backend.ingest : null;
  const readiness = liveReadiness?.readiness ?? null;
  const failedReadinessChecks = readiness?.checks.filter((check) => !check.ok) ?? [];
  const pureGrpcBookActive = ingestSettings?.pureGrpcOrderbookActive === true;
  const dwellirStatusLabel = "DWELLIR L1 ACTIVE";
  const transportSummary = pureGrpcBookActive ? "Fills gRPC + Book gRPC" : "Fills gRPC + Book WS";
  const transportMode = pureGrpcBookActive ? "PURE" : "HYBRID";
  const shadowModeActive =
    engineState?.citadel?.shadowMode === true ||
    executionSettings?.shadowMode === true ||
    String(
      executionSettings?.shadowMode ?? process.env.NEXT_PUBLIC_SHADOW_MODE ?? "false"
    ).toLowerCase() === "true";
  const shadowQueue = engineState?.shadowQueue ?? pulse?.shadow_queue ?? null;
  const shadowQueueLight = shadowQueue?.lastDecision?.action ?? "IDLE";
  const executionQualitySummary = executionQuality?.summary ?? {};
  const fillRate = executionQuality?.fillRate ?? {};
  const costReport = costDashboard?.cost ?? null;
  const activeStrategyMode =
    config?.STRATEGY_MODE ?? engineState?.cachedConfig.STRATEGY_MODE ?? "OFF";
  const activeCascadeAssets = parseCascadeAssets(
    config?.CASCADE_INSTRUMENTS ?? engineState?.cachedConfig.CASCADE_INSTRUMENTS ?? "BTC,HYPE"
  );
  const topCongressTickers = congressTickerHierarchy?.tickers.slice(0, 5) ?? [];
  const isCascadeStrategyMode =
    activeStrategyMode === "CASCADE_RECOVERY" ||
    activeStrategyMode === "BOTH_SHADOW" ||
    activeStrategyMode === "BOTH_LIVE";

  const visibleLogicFeed = useMemo(() => logicFeed.filter(isVisibleLogicItem), [logicFeed]);
  const visibleTerminalFeed = useMemo(
    () => (trace?.terminalFeed ?? []).filter(isVisibleTerminalLine),
    [trace?.terminalFeed]
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
    setTrace(null);
    setAttribution(null);
    setTradeHistory(null);
    setSettings(null);
    setCongressStatus(null);
    setCongressTickerHierarchy(null);
    setCascadeActive([]);
    setCascadePositions([]);
    setCascadeSignals([]);
    setCascadeHeat(null);
    setDiagnostics(null);
    setPulse(null);
    setLogicFeed([]);
  }

  async function switchTradingMode(mode: "OBSERVE" | "PAPER" | "LIVE") {
    if (!token) {
      return;
    }

    if (
      mode === "LIVE" &&
      !window.confirm(
        "LIVE mode can submit real exchange orders when execution test mode is disabled. Continue?"
      )
    ) {
      return;
    }

    setError(null);
    setIsSwitchingMode(true);
    setCommandStatus(
      mode === "LIVE" ? "Requesting live mode..." : `Switching to ${mode.toLowerCase()} mode...`
    );

    try {
      await updateTradingMode(apiBase, token, mode);
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
      setCommandStatus(
        mode === "LIVE" ? "Live mode is locked by execution safeguards." : "Mode switch failed."
      );
    } finally {
      setIsSwitchingMode(false);
    }
  }

  async function switchStrategyMode(mode: StrategyMode) {
    if (!token) {
      return;
    }

    if (
      mode === "BOTH_LIVE" &&
      !window.confirm(
        "BOTH_LIVE can allow cascade taker execution when readiness gates pass. Continue?"
      )
    ) {
      return;
    }

    setError(null);
    setIsSwitchingMode(true);
    setCommandStatus(`Switching strategy mode to ${strategyModeLabel(mode)}...`);

    try {
      await updateConfig(apiBase, token, { STRATEGY_MODE: mode });
      await refresh();
      setCommandStatus(`Strategy mode set to ${strategyModeLabel(mode)}.`);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Strategy mode switch failed.");
    } finally {
      setIsSwitchingMode(false);
    }
  }

  async function toggleCascadeAsset(asset: string) {
    if (!token) {
      return;
    }

    const next = new Set(activeCascadeAssets);
    if (next.has(asset)) {
      next.delete(asset);
    } else {
      next.add(asset);
    }

    if (next.size === 0) {
      setError("At least one cascade asset must remain enabled.");
      return;
    }

    const instruments = CASCADE_ASSET_OPTIONS.filter((candidate) => next.has(candidate)).join(",");
    setError(null);
    setIsSwitchingMode(true);
    setCommandStatus(`Updating cascade universe to ${instruments}...`);

    try {
      await updateConfig(apiBase, token, { CASCADE_INSTRUMENTS: instruments });
      await refresh();
      setCommandStatus(`Cascade universe armed: ${instruments}.`);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Cascade asset toggle failed.");
    } finally {
      setIsSwitchingMode(false);
    }
  }

  async function submitCascadeClose(positionId: string) {
    if (!token) {
      return;
    }

    if (!window.confirm("Request an operator IOC close for this cascade position?")) {
      return;
    }

    setError(null);
    setCommandStatus("Requesting cascade position close...");

    try {
      await closeCascadePosition(apiBase, token, positionId, "dashboard-manual-close");
      await refresh();
      setCommandStatus("Cascade close intent dispatched.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Cascade close failed.");
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
      await refresh();
      setCommandStatus(
        mode === "AUTONOMOUS" ? "Autonomous governance armed." : "Manual intervention armed."
      );
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
      setCommandStatus(
        response.ok ? "Integrity check optimal." : "Integrity check found anomalies."
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Integrity check failed.");
    } finally {
      setIsRunningDiagnostics(false);
    }
  }

  async function runShadowReplay(
    scenario: "BASELINE" | "FLASH_CRASH" | "DELEVERAGING_2022" | "LATENCY_SHOCK" = "BASELINE"
  ) {
    if (!token) {
      return;
    }

    setError(null);
    setIsRunningReplay(true);
    setCommandStatus(`Running ${scenario.replaceAll("_", " ").toLowerCase()} replay...`);

    try {
      const response = await startReplay(apiBase, token, {
        scenario,
        strategyVersionId: settings?.strategyVault?.active?.versionId ?? null,
        shadowBankroll: paperEquity || 5000,
        limit: scenario === "BASELINE" ? 1200 : 800,
        speedMultiplier: 250,
        latencyMs: scenario === "LATENCY_SHOCK" ? 75 : 10,
        slippageBps: scenario === "FLASH_CRASH" ? 4 : 1,
        feeBps: Number(config?.EXCHANGE_FEE_BPS ?? 0),
        walkForward: true,
        sentimentAblation: true
      });
      setLastReplay(response.replay);
      const statusResponse = await readReplayStatus(apiBase, token);
      setReplayStatus(statusResponse.replay);
      setCommandStatus("Shadow replay completed and journaled.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Shadow replay failed.");
    } finally {
      setIsRunningReplay(false);
    }
  }

  async function runCascadeValidation() {
    if (!token) {
      return;
    }

    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    setError(null);
    setIsRunningCascadeBacktest(true);
    setCommandStatus("Running cascade backtest validation...");

    try {
      const response = await runCascadeBacktest(apiBase, token, {
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
        instruments: [...activeCascadeAssets].map((asset) => `${asset.toLowerCase()}-usd`),
        startingEquity: paperEquity || 5000
      });
      setLastCascadeBacktest(response.report);
      setCommandStatus(
        response.report.validation &&
          typeof response.report.validation === "object" &&
          "ok" in response.report.validation &&
          response.report.validation.ok === true
          ? "Cascade validation passed for available data."
          : "Cascade validation completed; inspect failed data checks."
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Cascade validation failed.");
    } finally {
      setIsRunningCascadeBacktest(false);
    }
  }

  const macroBias = pulse?.macroBias ?? engineState?.macroBias ?? null;
  const temporaryOverride = pulse?.temporaryOverride ?? engineState?.temporaryOverride ?? null;
  const governanceMode =
    engineState?.cachedConfig.ORACLE_GOVERNANCE_MODE ?? config?.ORACLE_GOVERNANCE_MODE ?? "HYBRID";
  const isManualGovernance = governanceMode === "MANUAL";
  const assetMatrix = useMemo(
    () => normalizeAssetMatrix(engineState?.assetMatrix),
    [engineState?.assetMatrix]
  );
  const seededEquity =
    numberOrNull(engineState?.bankroll.equity) ?? numberOrNull(pulse?.total_equity) ?? 0;
  const paperEquity =
    paperPnl.paperMtm === null ? seededEquity : roundDisplay(seededEquity + paperPnl.paperMtm);
  const drawdown = pulse?.active_drawdown ?? engineState?.riskMetrics.rollingDrawdownPct ?? 0;
  const imbalance =
    pulse?.current_imbalance ?? engineState?.microstructure.weightedImbalance ?? null;
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
            <span>
              Authenticate to unlock live telemetry, matrix controls, and Moltworker governance.
            </span>
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
            <button className="primary-action" type="submit">
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

        <div className={isUnlocked ? "session-card unlocked" : "session-card"}>
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
          <a className="compact-action settings-link" href="/settings">
            <Settings size={16} />
            Settings
          </a>
          <a className="compact-action settings-link" href="/congress">
            <DatabaseZap size={16} />
            Congress
          </a>
          <a className="compact-action settings-link" href="/congress-alpha">
            <Bot size={16} />
            Alpha Bot
          </a>
          <a className="compact-action settings-link" href="/equity">
            <Landmark size={16} />
            Equity
          </a>
          <a className="compact-action settings-link" href="#paper-ledger">
            <ReceiptText size={16} />
            Ledger
          </a>
        </div>

        <div className={`system-state ${status.toLowerCase()}`}>
          <CircleDot size={14} />
          <span>{status}</span>
        </div>

        <div className="dwellir-stream-state">
          <RadioTower size={14} />
          <span>{dwellirStatusLabel}</span>
          <strong>{compact.format(dwellirReceiptLatencyMs)}ms</strong>
        </div>
        <div className={pureGrpcBookActive ? "transport-state grpc" : "transport-state hybrid"}>
          <span>{transportSummary}</span>
          <strong>{transportMode}</strong>
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
                : (macroBias?.reason ?? "No active supervisor intervention")}
            </p>
          </div>
          <button
            className={
              isManualGovernance ? "governance-switch manual" : "governance-switch autonomous"
            }
            disabled={isSwitchingMode}
            onClick={() => void switchGovernanceMode(isManualGovernance ? "AUTONOMOUS" : "MANUAL")}
          >
            [{isManualGovernance ? " MANUAL INTERVENTION " : " AUTONOMOUS MODE "}]
          </button>
          <div className="strategy-command-strip" aria-label="Strategy selector">
            <div>
              <span>Strategy</span>
              <strong>{strategyModeLabel(activeStrategyMode)}</strong>
            </div>
            <div className="strategy-mode-grid compact-mode-grid">
              {STRATEGY_MODE_OPTIONS.map((option) => (
                <button
                  className={activeStrategyMode === option.value ? "mode-active" : ""}
                  disabled={isSwitchingMode || !token}
                  key={`hero-${option.value}`}
                  onClick={() => void switchStrategyMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="asset-toggle-strip" aria-label="Cascade asset toggles">
            <span>Cascade Assets</span>
            {CASCADE_ASSET_OPTIONS.map((asset) => (
              <button
                className={activeCascadeAssets.has(asset) ? "asset-toggle active" : "asset-toggle"}
                disabled={isSwitchingMode || !token}
                key={asset}
                onClick={() => void toggleCascadeAsset(asset)}
                title={`${asset} cascade recovery ${activeCascadeAssets.has(asset) ? "enabled" : "disabled"}`}
              >
                {activeCascadeAssets.has(asset) ? "●" : "○"} {asset}
              </button>
            ))}
          </div>
          <div className={isManualGovernance ? "asset-pulse-grid dimmed" : "asset-pulse-grid"}>
            {assetMatrix.map((asset) => (
              <span
                className={
                  asset.quoteStatus === "SUSPENDED"
                    ? "asset-pill suspended"
                    : asset.selectedByMoltworker && asset.active
                      ? "asset-pill live"
                      : "asset-pill"
                }
                key={asset.instrumentCode}
                title={`${asset.instrumentCode} allocation ${compact.format(asset.capitalAllocationPct * 100)}% · quotes ${asset.quoteStatus}${asset.quoteReason ? `: ${asset.quoteReason}` : ""}`}
              >
                <strong>
                  {asset.selectedByMoltworker && asset.active ? "●" : "○"} {asset.coin}
                </strong>
                <small>
                  {asset.quoteStatus === "SUSPENDED"
                    ? (asset.quoteReason ?? "SUSPENDED")
                    : `${compact.format(asset.capitalAllocationPct * 100)}%`}
                </small>
              </span>
            ))}
          </div>
          <div className="bridge-metrics">
            <Metric label="Paper MTM" value={formatNullableCurrency(paperPnl.paperMtm)} />
            <Metric label="Paper Return" value={formatBps(paperPnl.returnBps)} />
            <Metric
              label="κ Regime"
              value={compact.format(
                pulse?.regimeCoefficient ?? engineState?.oracle.skepticismMultiplier ?? 0
              )}
            />
            <Metric
              label="Ensemble"
              value={`${compact.format((engineState?.ensemble?.confidence ?? 0) * 100)}%`}
            />
            <Metric
              label="Kelly Mult"
              value={compact.format(engineState?.ensemble?.kellyMultiplier ?? 0)}
            />
            <Metric
              label="Bias Power"
              value={compact.format((macroBias?.intensity ?? 0) * (macroBias?.confidence ?? 0))}
            />
            <Metric label="Realized Alpha" value={currency.format(realizedAlpha)} />
            <Metric
              label="Effective Gov"
              value={engineState?.cachedConfig.ORACLE_GOVERNANCE_MODE ?? "HYBRID"}
            />
          </div>
        </section>

        <section className="market-strip glass">
          <Metric
            label="Paper Equity"
            value={currency.format(paperEquity)}
            icon={<Gauge size={17} />}
          />
          <Metric label="Seed Equity" value={currency.format(seededEquity)} />
          <Metric
            label="Drawdown"
            value={`${compact.format(drawdown * 100)}%`}
            icon={<Shield size={17} />}
          />
          <Metric
            label="Dwellir Receipt Δ"
            value={`${compact.format(dwellirReceiptLatencyMs)}ms`}
          />
          <Metric
            label="Regime"
            value={regime.replace("REGIME_", "")}
            icon={<RadioTower size={17} />}
          />
          <Metric
            label="Imbalance"
            value={imbalance === null ? "n/a" : compact.format(imbalance)}
            icon={<Zap size={17} />}
          />
          <Metric
            label="Jitter"
            value={`${compact.format(pulse?.jitter_ms ?? engineState?.executionProfile.jitterMs ?? 0)}ms`}
          />
          <Metric label="Quotes" value={engineState?.quoteState.status ?? "n/a"} />
        </section>

        <section className="congress-brief-panel glass">
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Congress 24h Tape</span>
            <a className="panel-link" href="/congress">
              Open Tracker
            </a>
          </div>
          <div className="trade-summary compact-summary">
            <Metric label="Filings" value={compact.format(congressStatus?.counts.filings ?? 0)} />
            <Metric
              label="Transactions"
              value={compact.format(congressStatus?.counts.transactions ?? 0)}
            />
            <Metric
              label="Marked"
              value={compact.format(congressStatus?.counts.markedTransactions ?? 0)}
            />
            <Metric
              label="24h Notional"
              value={currency.format(congressTickerHierarchy?.totalAmountMid ?? 0)}
            />
          </div>
          <div className="congress-brief-list">
            {topCongressTickers.length === 0 ? (
              <span className="muted">No Congressional ticker flow loaded for the last 24h.</span>
            ) : (
              topCongressTickers.map((item) => (
                <a className="congress-brief-row" href="/congress" key={item.ticker}>
                  <strong>
                    #{item.rank} {item.ticker}
                  </strong>
                  <span>{compact.format(item.weightPct)}%</span>
                  <code>{currency.format(item.totalAmountMid)}</code>
                </a>
              ))
            )}
          </div>
        </section>

        <section className="strategy-mode-panel glass">
          <div className="panel-title">
            <Shield size={17} />
            <span>Strategy Mode</span>
            <strong className="panel-pill">{strategyModeLabel(activeStrategyMode)}</strong>
          </div>
          <div className="strategy-mode-grid">
            {STRATEGY_MODE_OPTIONS.map((option) => (
              <button
                className={activeStrategyMode === option.value ? "mode-active" : ""}
                disabled={isSwitchingMode || !token}
                key={option.value}
                onClick={() => void switchStrategyMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="asset-toggle-strip inline-toggle-strip">
            <span>Cascade universe</span>
            {CASCADE_ASSET_OPTIONS.map((asset) => (
              <button
                className={activeCascadeAssets.has(asset) ? "asset-toggle active" : "asset-toggle"}
                disabled={isSwitchingMode || !token}
                key={`strategy-${asset}`}
                onClick={() => void toggleCascadeAsset(asset)}
              >
                {activeCascadeAssets.has(asset) ? "●" : "○"} {asset}
              </button>
            ))}
          </div>
          <div className="trade-summary compact-summary">
            <Metric label="Active Cascades" value={compact.format(cascadeActive.length)} />
            <Metric
              label="Open Cascade Positions"
              value={compact.format(cascadePositions.filter(isOpenCascadePositionRow).length)}
            />
            <Metric
              label="Heat"
              value={`${compact.format((cascadeHeat?.currentHeatPct ?? 0) * 100)}%`}
            />
            <Metric
              label="Heat Cap"
              value={`${compact.format((cascadeHeat?.heatCapPct ?? config?.HEAT_CAP_PCT ?? 0) * 100)}%`}
            />
          </div>
        </section>

        <section className="agent-health-panel glass">
          <div className="panel-title">
            <Gauge size={17} />
            <span>Real-Time Agent Health</span>
            <strong className="panel-pill">{agentHealthRows.length} agents</strong>
          </div>
          <div className="agent-health-grid">
            {agentHealthRows.map((agent) => (
              <div className={`agent-health-row ${agent.status.toLowerCase()}`} key={agent.agent}>
                <strong>{displayDriverName(agent.agent)}</strong>
                <span>{agent.status}</span>
                <span>
                  {agent.latencyMs === null ? "lat n/a" : `${compact.format(agent.latencyMs)}ms`}
                </span>
                <span>
                  {agent.accuracy === null ? "acc n/a" : `${compact.format(agent.accuracy * 100)}%`}
                </span>
                <code>{currency.format(agent.pnl)}</code>
              </div>
            ))}
          </div>
        </section>

        <section
          className={costReport?.ok === false ? "cost-panel glass over-budget" : "cost-panel glass"}
        >
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Cost Guardrails</span>
            <strong className="panel-pill">
              {costReport?.ok === false ? "BUDGET BREACH" : "WITHIN BUDGET"}
            </strong>
          </div>
          <div className="trade-summary">
            <Metric
              label="24h Est."
              value={currency.format(Number(costReport?.totals.estimatedUsd ?? 0))}
            />
            <Metric
              label="Daily Cap"
              value={currency.format(Number(costReport?.budgets.dailyBudgetUsd ?? 0))}
            />
            <Metric
              label="AI Calls"
              value={compact.format(Number(costReport?.totals.sentimentCalls ?? 0))}
            />
            <Metric
              label="D1 Writes"
              value={compact.format(Number(costReport?.totals.d1WriteRows ?? 0))}
            />
            <Metric
              label="DO ms"
              value={compact.format(Number(costReport?.totals.estimatedDoComputeMs ?? 0))}
            />
            <Metric
              label="Enforce"
              value={String(costReport?.budgets.enforcement ?? "BLOCK_LIVE")}
            />
          </div>
          <div className="cost-component-grid">
            {(costReport?.components ?? []).map((component) => (
              <div
                className={component.budgetExceeded ? "cost-row over" : "cost-row"}
                key={String(component.component)}
              >
                <strong>{String(component.component)}</strong>
                <span>
                  {compact.format(Number(component.quantity ?? 0))} {String(component.unit ?? "")}
                </span>
                <span>{currency.format(Number(component.estimatedUsd ?? 0))}</span>
                <code>{currency.format(Number(component.budgetUsd ?? 0))}</code>
              </div>
            ))}
          </div>
        </section>

        <section
          className={readiness?.ok ? "readiness-strip glass ready" : "readiness-strip glass locked"}
        >
          <div>
            <span>Live Readiness Gate</span>
            <strong>{readiness?.ok ? "CLEAR" : "LOCKED"}</strong>
          </div>
          <div className="readiness-checks">
            {(readiness?.checks ?? []).slice(0, 7).map((check) => (
              <span className={check.ok ? "ok" : "fail"} key={check.id} title={check.detail}>
                {check.ok ? "✓" : "×"} {check.label}
              </span>
            ))}
          </div>
          <small>
            {failedReadinessChecks.length === 0
              ? "All live-trading preflight checks are green."
              : `${failedReadinessChecks.length} blocker${failedReadinessChecks.length === 1 ? "" : "s"}: ${failedReadinessChecks
                  .map((check) => check.label)
                  .join(", ")}`}
          </small>
        </section>

        <section className="shadow-queue-panel glass">
          <div className="panel-title">
            <CircleDot size={17} />
            <span>Shadow Queue Matrix</span>
            <strong className={`shadow-light ${shadowQueueLight.toLowerCase()}`}>
              {shadowQueueLight.replace("_", " ")}
            </strong>
          </div>
          <div className="trade-summary">
            <Metric label="VLO Active" value={compact.format(shadowQueue?.activeOrders ?? 0)} />
            <Metric label="Pending Drift" value={compact.format(shadowQueue?.pendingDrifts ?? 0)} />
            <Metric label="Tape Ghost Fills" value={compact.format(shadowQueue?.ghostFills ?? 0)} />
            <Metric label="Green Lights" value={compact.format(shadowQueue?.greenLights ?? 0)} />
            <Metric label="Red Lights" value={compact.format(shadowQueue?.redLights ?? 0)} />
            <Metric
              label="Latency Budget"
              value={`${compact.format(shadowQueue?.latencyBudgetMs ?? 5)}ms`}
            />
          </div>
          <div className="shadow-queue-readout">
            <span>
              Last fill{" "}
              <strong>
                {shadowQueue?.lastFill
                  ? `${shadowQueue.lastFill.side} ${shadowQueue.lastFill.instrumentCode} @ ${currency.format(shadowQueue.lastFill.price)}`
                  : "none"}
              </strong>
            </span>
            <span>
              Drift{" "}
              <strong>
                {shadowQueue?.lastDecision
                  ? `${compact.format(shadowQueue.lastDecision.microDrift)} over ${shadowQueue.lastDecision.driftTrades} trades`
                  : "waiting"}
              </strong>
            </span>
            <span>
              Intent{" "}
              <strong>{shadowQueue?.lastDecision?.tradeIntentId ? "DISPATCHED" : "n/a"}</strong>
            </span>
          </div>
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
                <code>
                  {engineState?.microstructure.midPrice
                    ? currency.format(engineState.microstructure.midPrice)
                    : "mid n/a"}
                </code>
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
                    <div
                      className={`heatmap-row ${cluster.side.toLowerCase()}`}
                      key={cluster.clusterId}
                    >
                      <div className="heatmap-main">
                        <strong>{currency.format(cluster.centerPrice)}</strong>
                        <span>
                          {cluster.side} · {cluster.distance}
                        </span>
                      </div>
                      <div className="heat-bar">
                        <i style={{ width: `${cluster.widthPct}%` }} />
                      </div>
                      <code>{currency.format(cluster.estimatedNotionalUsd)}</code>
                    </div>
                  ))
                ) : (
                  <div className="empty-row">NO PROVIDER LIQUIDATION EVENTS</div>
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
                label="Provider Events"
                value={compact.format(liquidationHeatmap?.recentEvents?.length ?? 0)}
              />
              <Metric
                label="Updated"
                value={
                  liquidationHeatmap?.updatedAt ? formatClock(liquidationHeatmap.updatedAt) : "n/a"
                }
              />
            </div>
          </div>
        </section>

        {isCascadeStrategyMode ? (
          <section className="cascade-ops-panel glass">
            <div className="panel-title">
              <Flame size={17} />
              <span>Cascade Recovery Ops</span>
              <strong className="panel-pill">
                {compact.format(cascadePositions.filter(isOpenCascadePositionRow).length)} open
              </strong>
            </div>
            <div className="cascade-ops-grid">
              <div className="cascade-stack">
                <div className="ledger-heading">
                  <span>Active Cascades</span>
                  <code>detection / absorption</code>
                </div>
                {cascadeActive.length > 0 ? (
                  cascadeActive.slice(0, 6).map((cascade) => (
                    <div className="cascade-row" key={cascade.cascadeId}>
                      <strong>{cascade.instrumentCode.toUpperCase()}</strong>
                      <span>{cascade.phase.replaceAll("_", " ")}</span>
                      <span>{currency.format(cascade.liquidationNotional)}</span>
                      <code>Z {compact.format(cascade.zScore)}</code>
                    </div>
                  ))
                ) : (
                  <div className="empty-row">NO ACTIVE CASCADE SETUPS</div>
                )}
              </div>

              <div className="cascade-stack">
                <div className="ledger-heading">
                  <span>Open Positions</span>
                  <code>entry / stop / targets</code>
                </div>
                {cascadePositions.filter(isOpenCascadePositionRow).length > 0 ? (
                  cascadePositions
                    .filter(isOpenCascadePositionRow)
                    .slice(0, 6)
                    .map((position) => (
                      <div className="cascade-position-row" key={position.positionId}>
                        <div>
                          <strong>{position.instrumentCode.toUpperCase()}</strong>
                          <span>
                            {position.direction} · {position.status}
                          </span>
                        </div>
                        <span>{currency.format(position.entryPrice)}</span>
                        <span>Stop {currency.format(position.currentStopPrice)}</span>
                        <span>
                          R{" "}
                          {position.unrealizedR === null
                            ? "n/a"
                            : compact.format(position.unrealizedR)}
                        </span>
                        <button onClick={() => void submitCascadeClose(position.positionId)}>
                          Close
                        </button>
                      </div>
                    ))
                ) : (
                  <div className="empty-row">NO OPEN CASCADE POSITIONS</div>
                )}
              </div>

              <div className="cascade-stack">
                <div className="ledger-heading">
                  <span>Recent Signals</span>
                  <code>taken / skipped / closed</code>
                </div>
                {cascadeSignals.length > 0 ? (
                  cascadeSignals.slice(0, 8).map((signal) => (
                    <div className="cascade-signal-row" key={String(signal.signalId)}>
                      <strong>{String(signal.instrumentCode ?? "n/a").toUpperCase()}</strong>
                      <span>{String(signal.action ?? "HOLD")}</span>
                      <span>{String(signal.outcome ?? "EMITTED")}</span>
                      <code>{formatClock(String(signal.createdAt ?? ""))}</code>
                    </div>
                  ))
                ) : (
                  <div className="empty-row">NO CASCADE SIGNALS IN BUFFER</div>
                )}
              </div>

              <div className="cascade-heat-card">
                <span>Portfolio Heat</span>
                <strong>{compact.format((cascadeHeat?.percentOfCap ?? 0) * 100)}%</strong>
                <div className="heat-bar">
                  <i
                    style={{ width: `${Math.min(100, (cascadeHeat?.percentOfCap ?? 0) * 100)}%` }}
                  />
                </div>
                <code>
                  {compact.format((cascadeHeat?.currentHeatPct ?? 0) * 100)}% /{" "}
                  {compact.format((cascadeHeat?.heatCapPct ?? 0) * 100)}%
                </code>
              </div>
            </div>
          </section>
        ) : null}

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
                ? "SHADOW QUOTES"
                : operatorMode === "LIVE"
                  ? "REAL ORDERS"
                  : operatorMode === "PAPER"
                    ? "SIGNED TEST ORDERS"
                    : "NO ORDERS"}
            </span>
          </div>
          <button
            className={
              operatorMode === "PAPER" ? "paper-mirror-toggle active" : "paper-mirror-toggle"
            }
            disabled={isSwitchingMode || !token}
            onClick={() => void switchTradingMode(operatorMode === "PAPER" ? "OBSERVE" : "PAPER")}
          >
            <span>Paper Trading Mirror</span>
            <strong>{operatorMode === "PAPER" ? "ON" : "OFF"}</strong>
          </button>
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
              onChange={(value) =>
                setMoltworker((draft) => ({ ...draft, manualSkepticism: value }))
              }
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

        <section className="efficacy-panel glass">
          <div className="panel-title">
            <Zap size={17} />
            <span>Agent Efficacy</span>
          </div>
          <div className="efficacy-grid">
            {visibleAttributionDrivers.length > 0 ? (
              visibleAttributionDrivers.slice(0, 8).map((driver) => (
                <div className="driver-row" key={driver.driver}>
                  <strong>{displayDriverName(driver.driver)}</strong>
                  <span>{currency.format(driver.cumulativePnl)}</span>
                  <span>SR {driver.sharpe === null ? "n/a" : compact.format(driver.sharpe)}</span>
                  <span>
                    PF {driver.profitFactor === null ? "n/a" : compact.format(driver.profitFactor)}
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-row">NO ACTIVE AGENT ATTRIBUTION</div>
            )}
          </div>
        </section>

        <section className="system-panel glass">
          <div className="panel-title">
            <Brain size={17} />
            <span>Replay Lab & Attribution</span>
            <button
              disabled={!token || isRunningReplay}
              onClick={() => void runShadowReplay("BASELINE")}
            >
              {isRunningReplay ? "Running" : "Run Replay"}
            </button>
            <button
              disabled={!token || isRunningCascadeBacktest}
              onClick={() => void runCascadeValidation()}
            >
              {isRunningCascadeBacktest ? "Validating" : "Cascade Validate"}
            </button>
          </div>
          <div className="trade-summary">
            <Metric label="Replay Status" value={replayStatus?.status ?? "IDLE"} />
            <Metric label="Progress" value={`${compact.format(replayStatus?.progressPct ?? 0)}%`} />
            <Metric
              label="Scenario"
              value={String(lastReplay?.scenario ?? replayStatus?.scenario ?? "BASELINE")}
            />
            <Metric
              label="Replay PnL"
              value={formatNullableCurrency(numberOrNull(lastReplay?.theoreticalPnl))}
            />
            <Metric
              label="Max DD"
              value={formatBps(
                numberOrNull(lastReplay?.maxDrawdown) === null
                  ? null
                  : Number(lastReplay?.maxDrawdown) * 10_000
              )}
            />
            <Metric
              label="Sharpe"
              value={
                lastReplay?.sharpe === null || lastReplay?.sharpe === undefined
                  ? "n/a"
                  : compact.format(Number(lastReplay.sharpe))
              }
            />
          </div>
          <div className="mode-strip">
            <button disabled={isRunningReplay} onClick={() => void runShadowReplay("FLASH_CRASH")}>
              Flash Crash
            </button>
            <button
              disabled={isRunningReplay}
              onClick={() => void runShadowReplay("DELEVERAGING_2022")}
            >
              Deleveraging
            </button>
            <button
              disabled={isRunningReplay}
              onClick={() => void runShadowReplay("LATENCY_SHOCK")}
            >
              Latency Shock
            </button>
          </div>
          <div className="cascade-validation-grid">
            <Metric
              label="Cascade Validation"
              value={
                validationOk(lastCascadeBacktest)
                  ? "PASS"
                  : lastCascadeBacktest
                    ? "NEEDS DATA"
                    : "NOT RUN"
              }
            />
            <Metric
              label="Replay Cascades"
              value={compact.format(arrayLength(lastCascadeBacktest?.cascades))}
            />
            <Metric
              label="Signals"
              value={compact.format(arrayLength(lastCascadeBacktest?.signals))}
            />
            <Metric
              label="Backtest PnL"
              value={formatNullableCurrency(numberOrNull(lastCascadeBacktest?.totalPnl))}
            />
            <Metric
              label="Data Source"
              value={String(
                isJsonRecord(lastCascadeBacktest?.dataQuality)
                  ? (lastCascadeBacktest?.dataQuality.source ?? "n/a")
                  : "n/a"
              )}
            />
          </div>
          {lastCascadeBacktest ? (
            <div className="diagnostic-list compact-diagnostic-list">
              {validationChecks(lastCascadeBacktest).map((check) => (
                <DiagnosticRow
                  check={{
                    id: String(check.id),
                    label: String(check.label),
                    status: check.ok === true ? "OPTIMAL" : "WARN",
                    detail: String(check.detail ?? ""),
                    metadata: {}
                  }}
                  key={String(check.id)}
                />
              ))}
            </div>
          ) : null}
          <div className="efficacy-grid">
            {(lastReplay?.attribution as JsonRecord | undefined)?.byAgent instanceof Array ? (
              (((lastReplay?.attribution as JsonRecord | undefined)?.byAgent ?? []) as JsonRecord[])
                .slice(0, 6)
                .map((bucket) => (
                  <div className="driver-row" key={String(bucket.key)}>
                    <strong>{displayDriverName(String(bucket.key))}</strong>
                    <span>{currency.format(Number(bucket.pnl ?? 0))}</span>
                    <span>{compact.format(Number(bucket.tradeCount ?? 0))} trades</span>
                    <span>
                      SR{" "}
                      {bucket.sharpe === null ? "n/a" : compact.format(Number(bucket.sharpe ?? 0))}
                    </span>
                  </div>
                ))
            ) : (
              <div className="empty-row">RUN A REPLAY TO ATTRIBUTE AGENT EDGE</div>
            )}
          </div>
          <div className="paper-pnl-grid">
            {(attribution?.byAsset ?? []).slice(0, 4).map((asset) => (
              <div className="paper-pnl-row" key={String(asset.asset ?? asset.key)}>
                <strong>{String(asset.asset ?? asset.key)}</strong>
                <span>{currency.format(Number(asset.cumulativePnl ?? 0))}</span>
                <span>{compact.format(Number(asset.tradeCount ?? 0))} fills</span>
                <code>
                  PF{" "}
                  {asset.profitFactor === null
                    ? "n/a"
                    : compact.format(Number(asset.profitFactor ?? 0))}
                </code>
              </div>
            ))}
          </div>
        </section>

        <section className="trade-panel glass" id="paper-ledger">
          <div className="panel-title">
            <ReceiptText size={17} />
            <span>Trade History</span>
            <button disabled={!token} onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <div className="trade-summary">
            <Metric label="Order Events" value={compact.format(totalOrderEvents)} />
            <Metric label="Open Intents" value={compact.format(statusSummary.ACCEPTED)} />
            <Metric
              label="Paper Fills"
              value={compact.format(paperLedger?.summary.fillCount ?? paperPnl.tradeCount)}
            />
            <Metric label="Realized Net" value={currency.format(paperPnl.realizedNetPnl)} />
            <Metric label="Open MTM" value={formatNullableCurrency(paperPnl.openUnrealizedPnl)} />
            <Metric label="MTM Return" value={formatBps(paperPnl.returnBps)} />
            <Metric label="Gross Notional" value={currency.format(paperPnl.grossNotional)} />
            <Metric
              label="Open Lots"
              value={compact.format(paperLedger?.summary.openPositionCount ?? 0)}
            />
            <Metric label="Rejected" value={compact.format(statusSummary.REJECTED)} />
            <Metric label="Fill Rate" value={formatPercent(numberOrNull(fillRate.fillRate))} />
            <Metric
              label="Slippage"
              value={formatBps(numberOrNull(executionQualitySummary.averageSlippageBps))}
            />
            <Metric
              label="Adverse Sel."
              value={formatBps(numberOrNull(executionQualitySummary.adverseSelectionBps))}
            />
          </div>
          <div className="execution-ledger-note">
            <span>
              Paper fills are shadow fills only; unrealized MTM is open inventory, not realized
              profit.
            </span>
            <code>
              FIFO ledger: {paperLedger?.summary.entryCount ?? 0} entries ·{" "}
              {paperLedger?.summary.exitCount ?? 0} exits/reductions · fees included
            </code>
          </div>
          {paperPnl.assets.length > 0 ? (
            <div className="paper-pnl-grid" aria-label="Shadow mark-to-market by asset">
              {paperPnl.assets.map((asset) => (
                <div
                  className={
                    asset.realizedNetPnl < 0 ? "paper-pnl-row negative" : "paper-pnl-row positive"
                  }
                  key={asset.asset}
                >
                  <strong>{asset.asset}</strong>
                  <span>Realized {currency.format(asset.realizedNetPnl)}</span>
                  <span>MTM {formatNullableCurrency(asset.markToMarketPnl)}</span>
                  <span>Open {compact.format(asset.netQuantity)}</span>
                  <span>
                    {asset.midPrice === null ? "mark n/a" : currency.format(asset.midPrice)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {paperLedger && paperLedger.positions.length > 0 ? (
            <>
              <div className="ledger-heading">
                <span>Open Paper Positions</span>
                <code>FIFO lots, mark-to-market</code>
              </div>
              <div className="paper-pnl-grid" aria-label="Open paper position ledger">
                {paperLedger.positions.map((position) => {
                  const mark = findAssetMarkPrice(position.asset, engineState);
                  const signed = position.side === "LONG" ? 1 : -1;
                  const openMtm =
                    mark === null
                      ? null
                      : roundDisplay(
                          (mark - position.averageEntryPrice) * position.quantity * signed -
                            position.entryFeesRemaining
                        );

                  return (
                    <div
                      className={
                        openMtm !== null && openMtm < 0
                          ? "paper-pnl-row negative"
                          : "paper-pnl-row positive"
                      }
                      key={`${position.asset}:${position.side}`}
                    >
                      <strong>{position.asset}</strong>
                      <span>{position.side}</span>
                      <span>Qty {compact.format(position.quantity)}</span>
                      <span>Avg {currency.format(position.averageEntryPrice)}</span>
                      <span>MTM {formatNullableCurrency(openMtm)}</span>
                      <code>{position.lotCount} lots</code>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
          {paperLedger && paperLedger.events.length > 0 ? (
            <>
              <div className="ledger-heading">
                <span>Entry / Exit Ledger</span>
                <code>{paperLedger.events.length} matched events</code>
              </div>
              <div className="trade-table paper-ledger-table">
                {paperLedger.events
                  .slice()
                  .reverse()
                  .slice(0, 60)
                  .map((event) => (
                    <div
                      className={
                        event.realizedPnl < 0
                          ? "trade-row ghost_fill negative"
                          : "trade-row ghost_fill"
                      }
                      key={event.eventId}
                    >
                      <span>{formatClock(event.executedAt)}</span>
                      <strong>{event.asset}</strong>
                      <span>{event.type}</span>
                      <span>{event.side}</span>
                      <span>{compact.format(event.quantity)}</span>
                      <span>
                        {event.exitPrice === null
                          ? currency.format(event.entryPrice ?? 0)
                          : `${currency.format(event.entryPrice ?? 0)} → ${currency.format(
                              event.exitPrice
                            )}`}
                      </span>
                      <span>{currency.format(event.realizedPnl)}</span>
                      <code>{event.fillTradeId.slice(0, 18)}</code>
                    </div>
                  ))}
              </div>
            </>
          ) : null}
          <div className="ledger-heading">
            <span>Paper Fill Ledger</span>
            <code>{paperTradeRows.length} latest</code>
          </div>
          <div className="trade-table paper-fill-table">
            {paperTradeRows.length > 0 ? (
              paperTradeRows.map((trade) => (
                <div className="trade-row ghost_fill" key={`paper:${trade.tradeId}`}>
                  <span>{formatClock(trade.executedAt)}</span>
                  <strong>{trade.asset}</strong>
                  <span>{trade.side}</span>
                  <span>{trade.status}</span>
                  <span>{compact.format(trade.size)}</span>
                  <span>{currency.format(trade.price)}</span>
                  <span>
                    {currency.format(Number(trade.resultingPnl ?? 0) - Number(trade.fees ?? 0))}
                  </span>
                  <code>
                    {displayDriverName(trade.primaryDriver ?? trade.agentName ?? "PROFILER")}
                  </code>
                </div>
              ))
            ) : (
              <div className="empty-row">NO PAPER FILLS IN CURRENT WINDOW</div>
            )}
          </div>
          <div className="ledger-heading">
            <span>Execution Event Stream</span>
            <code>accepted/rejected/cancelled/fill events</code>
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
                  <code>
                    {displayDriverName(trade.primaryDriver ?? trade.agentName ?? "EXECUTIONER")}
                  </code>
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
            {visibleLogicFeed.length > 0
              ? visibleLogicFeed.map((item, index) => (
                  <pre key={`${index}:${JSON.stringify(item).slice(0, 20)}`}>
                    {JSON.stringify(item, null, 2)}
                  </pre>
                ))
              : visibleTerminalFeed.map((line) => <pre key={line}>{line}</pre>)}
          </div>
        </section>
      </section>

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

function isActiveAttributionDriver(driver: { driver: string }): boolean {
  return !RETIRED_DRIVER_NAMES.has(driver.driver.trim().toUpperCase());
}

function displayDriverName(driver: string | null | undefined): string {
  const normalized = driver?.trim().toUpperCase();

  if (!normalized || RETIRED_DRIVER_NAMES.has(normalized)) {
    return "EXECUTIONER";
  }

  return normalized;
}

function isVisibleLogicItem(item: JsonRecord): boolean {
  const sourceAgent = String(item.sourceAgent ?? item.source_agent ?? "").toUpperCase();
  const targetAgent = String(item.targetAgent ?? item.target_agent ?? "").toUpperCase();

  return !RETIRED_DRIVER_NAMES.has(sourceAgent) && !RETIRED_DRIVER_NAMES.has(targetAgent);
}

function isVisibleTerminalLine(line: string): boolean {
  const normalized = line.toUpperCase();
  return ![...RETIRED_DRIVER_NAMES].some((driver) => normalized.includes(driver));
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

function summarizeTradeStatuses(
  breakdown: NonNullable<TradeHistoryResponse["statusBreakdown"]>
): Record<TradeHistoryEntry["status"], number> {
  const initial: Record<TradeHistoryEntry["status"], number> = {
    ACCEPTED: 0,
    FILLED: 0,
    PARTIAL: 0,
    REJECTED: 0,
    CANCELLED: 0,
    GHOST_FILL: 0
  };

  return breakdown.reduce((summary, row) => {
    summary[row.status] = Number(row.count ?? 0);
    return summary;
  }, initial);
}

function summarizeAgentHealth(
  state: EngineState | null,
  attributionDrivers: AttributionResponse["byDriver"]
): Array<{
  agent: string;
  status: string;
  latencyMs: number | null;
  accuracy: number | null;
  pnl: number;
}> {
  const attribution = new Map(
    attributionDrivers.map((driver) => [displayDriverName(driver.driver), driver])
  );
  const health = state?.agentHealth;
  if (!health) {
    return [];
  }

  return Object.entries(health)
    .filter(([agent]) => isActiveAttributionDriver({ driver: agent }))
    .map(([agent, details]) => {
      const normalized = displayDriverName(agent);
      const driver = attribution.get(normalized);
      return {
        agent: normalized,
        status: String(details.status ?? "YELLOW"),
        latencyMs: numberOrNull(details.latencyMs),
        accuracy: numberOrNull(driver?.winRate),
        pnl: Number(driver?.cumulativePnl ?? 0)
      };
    })
    .sort((left, right) => right.pnl - left.pnl);
}

function summarizePaperPnl(
  summary: TradeHistoryResponse["paperPnl"] | undefined,
  state: EngineState | null,
  ledger: PaperLedger | null
): PaperPnlDisplay {
  const sourceAssets = summary?.assets ?? [];
  const ledgerAssets = new Map((ledger?.assets ?? []).map((asset) => [asset.asset, asset]));
  const ledgerPositions = new Map(
    (ledger?.positions ?? []).map((position) => [position.asset, position])
  );
  const assetKeys = new Set<string>([
    ...sourceAssets.map((asset) => asset.asset),
    ...(ledger?.assets ?? []).map((asset) => asset.asset)
  ]);
  let grossNotional = 0;
  let totalEv = 0;
  let totalFees = 0;
  let realizedPnl = 0;
  let realizedNetPnl = 0;
  let openUnrealizedPnl = 0;
  let markedPnl = 0;
  let hasMarks = false;

  const assets = [...assetKeys].map((assetKey) => {
    const asset =
      sourceAssets.find((candidate) => candidate.asset === assetKey) ??
      ({
        asset: assetKey,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        buySize: 0,
        sellSize: 0,
        buyNotional: 0,
        sellNotional: 0,
        netQuantity: 0,
        cashPnl: 0,
        grossNotional: 0,
        realizedPnl: 0,
        totalEv: 0,
        totalFees: 0,
        firstSeen: null,
        lastSeen: null
      } satisfies PaperPnlAsset);
    const ledgerAsset = ledgerAssets.get(asset.asset);
    const ledgerPosition = ledgerPositions.get(asset.asset);
    const midPrice = findAssetMarkPrice(asset.asset, state);
    const grossUsd = Number(
      ledger ? (ledger?.summary.grossNotional ?? 0) : (asset.grossNotional ?? 0)
    );
    const fees = Number(ledgerAsset?.totalFees ?? asset.totalFees ?? 0);
    const ledgerRealizedNet = Number(ledgerAsset?.realizedNetPnl ?? 0);
    const fallbackRealizedNet = Number(asset.realizedPnl ?? 0) - fees;
    const realizedNetForAsset = roundDisplay(ledger ? ledgerRealizedNet : fallbackRealizedNet);
    const signedOpenQuantity = Number(ledgerAsset?.openQuantity ?? asset.netQuantity ?? 0);
    const positionSide = ledgerPosition?.side;
    const openUnrealized =
      ledgerPosition && midPrice !== null
        ? roundDisplay(
            (midPrice - ledgerPosition.averageEntryPrice) *
              ledgerPosition.quantity *
              (positionSide === "LONG" ? 1 : -1) -
              ledgerPosition.entryFeesRemaining
          )
        : midPrice === null
          ? null
          : roundDisplay(
              Number(asset.cashPnl ?? 0) + Number(asset.netQuantity ?? 0) * midPrice - fees
            );
    const markToMarketPnl =
      openUnrealized === null ? null : roundDisplay(realizedNetForAsset + openUnrealized);
    const returnBps =
      markToMarketPnl === null || Number(asset.grossNotional ?? grossUsd) <= 0
        ? null
        : roundDisplay((markToMarketPnl / Number(asset.grossNotional ?? grossUsd)) * 10_000, 4);

    grossNotional += Number(asset.grossNotional ?? 0);
    totalEv += Number(asset.totalEv ?? 0);
    totalFees += fees;
    realizedPnl += ledger
      ? Number(ledgerAsset?.realizedGrossPnl ?? 0)
      : Number(asset.realizedPnl ?? 0);
    realizedNetPnl += realizedNetForAsset;
    if (openUnrealized !== null) {
      openUnrealizedPnl += openUnrealized;
    }
    if (markToMarketPnl !== null) {
      markedPnl += markToMarketPnl;
      hasMarks = true;
    }

    return {
      ...asset,
      tradeCount: ledgerAsset?.fillCount ?? asset.tradeCount,
      buyCount: ledgerAsset?.buyCount ?? asset.buyCount,
      sellCount: ledgerAsset?.sellCount ?? asset.sellCount,
      buySize: ledgerAsset?.buySize ?? asset.buySize,
      sellSize: ledgerAsset?.sellSize ?? asset.sellSize,
      netQuantity: signedOpenQuantity,
      grossNotional: asset.grossNotional || grossUsd,
      realizedPnl: ledgerAsset?.realizedGrossPnl ?? asset.realizedPnl,
      totalFees: fees,
      midPrice,
      markToMarketPnl,
      realizedNetPnl: realizedNetForAsset,
      returnBps
    };
  });

  const totals = summary?.totals;
  const totalGross = Number(
    ledger?.summary.grossNotional ?? totals?.grossNotional ?? grossNotional
  );
  const totalRealized = Number(
    ledger?.summary.realizedGrossPnl ?? totals?.realizedPnl ?? realizedPnl
  );
  const totalFeesValue = Number(ledger?.summary.totalFees ?? totals?.totalFees ?? totalFees);
  const paperMtm = hasMarks ? roundDisplay(markedPnl) : null;

  return {
    windowHours: Number(summary?.windowHours ?? 24),
    tradeCount: Number(ledger?.summary.fillCount ?? totals?.tradeCount ?? 0),
    paperMtm,
    openUnrealizedPnl: hasMarks ? roundDisplay(openUnrealizedPnl) : null,
    returnBps:
      paperMtm === null || totalGross <= 0
        ? null
        : roundDisplay((paperMtm / totalGross) * 10_000, 4),
    realizedPnl: roundDisplay(totalRealized),
    realizedNetPnl: roundDisplay(ledger ? realizedNetPnl : totalRealized - totalFeesValue),
    totalEv: roundDisplay(Number(totals?.totalEv ?? totalEv)),
    totalFees: roundDisplay(totalFeesValue),
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

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${compact.format(value * 100)}%`;
}

function roundDisplay(value: number, precision = 8): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function normalizeTradePayload(payload: unknown): TradeHistoryEntry {
  const record = (
    payload && typeof payload === "object" ? payload : {}
  ) as Partial<TradeHistoryEntry> & {
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
  const selected = snapshots.find((snapshot) => snapshot.midPrice === midPrice) ??
    snapshots[0] ?? { bids: [], asks: [] };

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
      toxicityState: asset?.toxicityState ?? "NORMAL",
      quoteStatus: asset?.quoteStatus ?? "ACTIVE",
      quoteReason: asset?.quoteReason ?? null,
      quoteEligible: asset?.quoteEligible ?? false,
      quoteSuspendedUntil: asset?.quoteSuspendedUntil ?? null,
      lastQuoteAt: asset?.lastQuoteAt ?? null
    };
  });
}

function strategyModeLabel(value: StrategyMode): string {
  switch (value) {
    case "MARKET_MAKING":
      return "MM";
    case "CASCADE_RECOVERY":
      return "CASCADE";
    case "BOTH_SHADOW":
      return "BOTH SHADOW";
    case "BOTH_LIVE":
      return "BOTH LIVE";
    default:
      return "OFF";
  }
}

function parseCascadeAssets(value: string): Set<string> {
  const parsed = value
    .split(",")
    .map((asset) => asset.trim().toUpperCase())
    .filter((asset) => asset.length > 0);
  return new Set(parsed.length > 0 ? parsed : ["BTC", "ETH", "SOL"]);
}

function validationOk(report: JsonRecord | null): boolean {
  const validation = isJsonRecord(report?.validation) ? report.validation : null;
  return validation?.ok === true;
}

function validationChecks(report: JsonRecord | null): JsonRecord[] {
  const validation = isJsonRecord(report?.validation) ? report.validation : null;
  return Array.isArray(validation?.checks) ? validation.checks.filter(isJsonRecord) : [];
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isOpenCascadePositionRow(position: CascadePositionItem): boolean {
  return (
    position.remainingSize > 0 &&
    position.status !== "CLOSED" &&
    position.status !== "STOPPED_OUT" &&
    position.status !== "TIME_STOPPED"
  );
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

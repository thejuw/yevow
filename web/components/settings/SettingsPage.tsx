"use client";

import {
  BellRing,
  ChevronRight,
  DatabaseZap,
  Flame,
  KeyRound,
  Lock,
  RadioTower,
  Save,
  Send,
  Settings,
  Shield,
  SlidersHorizontal,
  TerminalSquare,
  Wrench
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_API_BASE,
  activateStrategyVersion,
  createStrategyVersion,
  login,
  readSettings,
  readState,
  resetLatencyBaseline,
  rotateVaultSecret,
  sendTestAlert,
  testVaultConnection,
  toWebSocketUrl,
  updateConfig,
  updateCostBudgets,
  updateNotificationSettings
} from "@/lib/api";
import {
  CommandMessage,
  Fault,
  Metric,
  NumberField,
  ParameterControl,
  StatusPill,
  ToggleField
} from "./SettingsPrimitives";
import {
  PARAMETER_MATRIX,
  STRATEGY_KNOBS,
  changedMoreThanTenPercent,
  flattenState
} from "@/lib/parameters";
import type {
  AdminSettingsResponse,
  AlertPriority,
  AlertTestResponse,
  CostBudgetSettings,
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  NotificationSettings,
  NotificationSettingsUpdate,
  StrategyVersion,
  VaultKeyName
} from "@/lib/types";

type ConnectionStatus = "LOCKED" | "AUTHENTICATED" | "ERROR";
type CommandState = "IDLE" | "SAVING" | "TESTING";

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4
});

const VAULT_KEYS: VaultKeyName[] = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_WEBHOOK_URL",
  "ALERT_WEBHOOK_URL",
  "HL_AGENT_ADDRESS",
  "HL_AGENT_SECRET",
  "EXCHANGE_API_KEY",
  "EXCHANGE_API_SECRET",
  "EXCHANGE_HMAC_SECRET",
  "EXCHANGE_ED25519_PRIVATE_KEY"
];

const RETIRED_STATE_TOKENS = [
  ".hedge",
  ".agenthealth.hedge",
  ".spreads",
  "spreadmultiplier",
  "reservationshiftbps",
  "am_vpin_contested_spread_multiplier",
  "am_vpin_toxic_spread_multiplier",
  "hl_hedge_subaccount"
];

const CASCADE_DETECTION_KEYS = new Set<keyof GlobalRiskConfig>([
  "CASCADE_NOTIONAL_THRESHOLD_USD",
  "CASCADE_WINDOW_MS",
  "CASCADE_ZSCORE_THRESHOLD",
  "CASCADE_LOOKBACK_HOURS",
  "CASCADE_DIRECTIONAL_PCT",
  "CASCADE_MIN_PRICE_MOVE_ATR",
  "ABSORPTION_WINDOW_MS",
  "ABSORPTION_PRICE_BAND_BPS",
  "ABSORPTION_MIN_HOLD_SECONDS"
]);

const CASCADE_ENTRY_EXIT_KEYS = new Set<keyof GlobalRiskConfig>([
  "ENTRY_WINDOW_SECONDS",
  "IMPULSIVE_BAR_BODY_ATR",
  "IMPULSIVE_BAR_VOLUME_MULT",
  "STOP_BUFFER_ATR",
  "MIN_STOP_DISTANCE_BPS",
  "MAX_STOP_DISTANCE_BPS",
  "MIN_TIME_SINCE_LAST_CASCADE_SECONDS",
  "PARTIAL_1_R",
  "PARTIAL_1_SIZE_PCT",
  "PARTIAL_2_R",
  "PARTIAL_2_SIZE_PCT",
  "TRAILING_STOP_TYPE",
  "TRAILING_STOP_PARAM",
  "CASCADE_TIME_STOP_HOURS",
  "NEWS_BLACKOUT_MINUTES",
  "MAX_REALIZED_VOL_PERCENTILE",
  "RISK_PER_TRADE_PCT",
  "HEAT_CAP_PCT",
  "MAX_POSITION_NOTIONAL_PCT",
  "ASSET_LIQUIDITY_CAP_USD"
]);

const CASCADE_RISK_KEYS = new Set<keyof GlobalRiskConfig>([
  "CASCADE_TAKER_ENABLED",
  "DAILY_LOSS_LIMIT_PCT",
  "WEEKLY_LOSS_LIMIT_PCT",
  "MAX_CONSECUTIVE_LOSSES",
  "MAX_DRAWDOWN_PCT",
  "MAX_SPREAD_BPS_FOR_TAKER",
  "MAX_SINGLE_ORDER_NOTIONAL_USD",
  "SLICE_NOTIONAL_THRESHOLD_USD",
  "SLICE_NOTIONAL_PER_CHUNK",
  "SLICE_INTERVAL_MS",
  "SLICE_JITTER_MS",
  "MIN_FILL_RATIO"
]);
const CASCADE_ASSET_OPTIONS = ["BTC", "ETH", "SOL", "HYPE"] as const;

export default function SettingsPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("LOCKED");
  const [error, setError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [commandState, setCommandState] = useState<CommandState>("IDLE");
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null);
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [riskDraft, setRiskDraft] = useState<Partial<GlobalRiskConfig>>({});
  const [notificationDraft, setNotificationDraft] = useState<NotificationSettingsUpdate>({});
  const [costDraft, setCostDraft] = useState<Partial<CostBudgetSettings>>({});
  const [lastAlertTest, setLastAlertTest] = useState<AlertTestResponse | null>(null);
  const [vaultKey, setVaultKey] = useState<VaultKeyName>("TELEGRAM_BOT_TOKEN");
  const [vaultSecret, setVaultSecret] = useState("");
  const [rotationReason, setRotationReason] = useState("settings-page-rotation");
  const [strategyName, setStrategyName] = useState("BTC-HYPE Quant Stack");
  const [strategyDescription, setStrategyDescription] = useState(
    "Operator-reviewed parameter snapshot"
  );
  const [pendingFields, setPendingFields] = useState<string[]>([]);
  const [confirmText, setConfirmText] = useState("");
  const riskDirtyRef = useRef(false);
  const notificationDirtyRef = useRef(false);
  const costDirtyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    const [response, stateResponse] = await Promise.all([
      readSettings(apiBase, token),
      readState(apiBase, token)
    ]);
    setSettings(response);
    setEngineState(stateResponse.state);
    if (!riskDirtyRef.current) {
      setRiskDraft(response.config);
    }
    if (!notificationDirtyRef.current) {
      setNotificationDraft(response.notifications);
    }
    if (!costDirtyRef.current) {
      setCostDraft(response.costBudgets ?? {});
    }
  }, [apiBase, token]);

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
    if (!token) {
      return;
    }

    refresh().catch((caught: unknown) => setError(errorMessage(caught)));
  }, [token, refresh]);

  const backendRows = useMemo(
    () => flattenState(settings?.backend ?? {}, "backend").slice(0, 180),
    [settings]
  );
  const stateRows = useMemo(
    () =>
      flattenState(engineState ?? {}, "state")
        .filter(([key]) => isVisibleStateRow(key))
        .slice(0, 240),
    [engineState]
  );
  const ingestSettings = isJsonRecord(settings?.backend.ingest) ? settings.backend.ingest : {};
  const apiSettings = isJsonRecord(settings?.backend.api) ? settings.backend.api : {};
  const activeNotifications = settings?.notifications;
  const effectiveNotifications = {
    ...activeNotifications,
    ...notificationDraft
  } as NotificationSettings;
  const effectiveCostBudgets = {
    ...settings?.costBudgets,
    ...costDraft
  } as Partial<CostBudgetSettings>;
  const effectiveStrategyMode = (riskDraft.STRATEGY_MODE ??
    settings?.config.STRATEGY_MODE ??
    "OFF") as GlobalRiskConfig["STRATEGY_MODE"];
  const cascadeRelated =
    effectiveStrategyMode === "CASCADE_RECOVERY" ||
    effectiveStrategyMode === "BOTH_SHADOW" ||
    effectiveStrategyMode === "BOTH_LIVE";
  const cascadeAssets = parseCascadeAssets(
    String(riskDraft.CASCADE_INSTRUMENTS ?? settings?.config.CASCADE_INSTRUMENTS ?? "BTC,ETH,SOL")
  );
  const allParameterControls = [...STRATEGY_KNOBS, ...PARAMETER_MATRIX];
  const cascadeDetectionParams = allParameterControls.filter((param) =>
    CASCADE_DETECTION_KEYS.has(param.key)
  );
  const cascadeEntryExitParams = allParameterControls.filter((param) =>
    CASCADE_ENTRY_EXIT_KEYS.has(param.key)
  );
  const cascadeRiskParams = allParameterControls.filter((param) =>
    CASCADE_RISK_KEYS.has(param.key)
  );

  async function handleLogin() {
    setError(null);
    setCommandStatus("Authenticating...");

    try {
      const response = await login(apiBase, password);
      localStorage.setItem("sovereign.jwt", response.token);
      localStorage.setItem("sovereign.apiBase", apiBase);
      setToken(response.token);
      setPassword("");
      setStatus("AUTHENTICATED");
      setCommandStatus("Authenticated.");
    } catch (caught: unknown) {
      setStatus("ERROR");
      setError(errorMessage(caught));
      setCommandStatus("Authentication failed.");
    }
  }

  function handleLogout() {
    localStorage.removeItem("sovereign.jwt");
    setToken("");
    setStatus("LOCKED");
    setSettings(null);
    setEngineState(null);
    setRiskDraft({});
    setNotificationDraft({});
    setCostDraft({});
    setLastAlertTest(null);
    setCommandStatus("Settings console locked.");
  }

  function updateRiskDraft(key: keyof GlobalRiskConfig, value: string | number | boolean) {
    riskDirtyRef.current = true;
    setRiskDraft((draft) => ({
      ...draft,
      [key]: value
    }));
  }

  function toggleCascadeAsset(asset: string) {
    const next = new Set(cascadeAssets);
    if (next.has(asset)) {
      next.delete(asset);
    } else {
      next.add(asset);
    }
    if (next.size === 0) {
      setError("At least one cascade asset must remain enabled.");
      return;
    }
    updateRiskDraft(
      "CASCADE_INSTRUMENTS",
      CASCADE_ASSET_OPTIONS.filter((candidate) => next.has(candidate)).join(",")
    );
  }

  function updateNotificationDraft<K extends keyof NotificationSettingsUpdate>(
    key: K,
    value: NotificationSettingsUpdate[K]
  ) {
    notificationDirtyRef.current = true;
    setNotificationDraft((draft) => ({
      ...draft,
      [key]: value
    }));
  }

  function updateCostDraft<K extends keyof CostBudgetSettings>(
    key: K,
    value: CostBudgetSettings[K]
  ) {
    costDirtyRef.current = true;
    setCostDraft((draft) => ({
      ...draft,
      [key]: value
    }));
  }

  async function saveRisk(force = false) {
    if (!settings) {
      return;
    }

    const validationError = validateRiskDraft(riskDraft);
    if (validationError) {
      setError(validationError);
      setCommandStatus("Engine parameter validation failed.");
      return;
    }

    const overTen = changedMoreThanTenPercent(settings.config, riskDraft);
    if (!force && overTen.length > 0) {
      setPendingFields(overTen);
      setConfirmText("");
      return;
    }

    setCommandState("SAVING");
    setError(null);
    setCommandStatus("Saving engine parameters...");

    try {
      await updateConfig(apiBase, token, riskDraft);
      riskDirtyRef.current = false;
      setPendingFields([]);
      await refresh();
      setCommandStatus("Engine parameters saved and refreshed.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Engine parameter save failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function saveNotifications() {
    setCommandState("SAVING");
    setError(null);
    setCommandStatus("Saving notification settings...");

    try {
      const response = await updateNotificationSettings(apiBase, token, notificationDraft);
      notificationDirtyRef.current = false;
      setSettings((current) =>
        current
          ? {
              ...current,
              notifications: response.notifications,
              alerting: response.alerting
            }
          : current
      );
      setCommandStatus("Notification settings saved.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Notification settings save failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function saveVaultSecret() {
    setCommandState("SAVING");
    setError(null);
    setCommandStatus(`Rotating ${vaultKey}...`);

    try {
      await rotateVaultSecret(apiBase, token, {
        keyName: vaultKey,
        secret: vaultSecret,
        rotationReason
      });
      setVaultSecret("");
      await refresh();
      setCommandStatus(`${vaultKey} saved to encrypted vault.`);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Vault rotation failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function runAlertTest(priority: AlertPriority = "HIGH") {
    setCommandState("TESTING");
    setError(null);
    setCommandStatus("Sending test alert...");

    try {
      const response = await sendTestAlert(apiBase, token, priority);
      setLastAlertTest(response);
      setSettings((current) =>
        current
          ? {
              ...current,
              alerting: response.alerting
            }
          : current
      );
      setCommandStatus(
        response.delivery.delivered > 0
          ? `Alert delivered to ${response.delivery.delivered}/${response.delivery.attempted} channel(s).`
          : "No alert channel delivered the test."
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Alert test failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function runVaultTest() {
    setCommandState("TESTING");
    setError(null);
    setCommandStatus("Testing execution credential path...");

    try {
      await testVaultConnection(apiBase, token);
      setCommandStatus("Execution credential path responded.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Execution credential test failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function resetLatency() {
    setCommandState("TESTING");
    setError(null);
    setCommandStatus("Resetting latency baseline...");

    try {
      await resetLatencyBaseline(apiBase, token);
      setCommandStatus("Latency baseline reset.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Latency reset failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function saveCostBudgets() {
    setCommandState("SAVING");
    setError(null);
    setCommandStatus("Saving hard cost budgets...");

    try {
      const response = await updateCostBudgets(apiBase, token, costDraft);
      costDirtyRef.current = false;
      setSettings((current) =>
        current
          ? {
              ...current,
              costBudgets: response.budgets
            }
          : current
      );
      setCommandStatus("Cost budgets saved.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Cost budget save failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function snapshotStrategy() {
    if (!settings) {
      return;
    }

    setCommandState("SAVING");
    setError(null);
    setCommandStatus("Snapshotting strategy version...");

    try {
      await createStrategyVersion(apiBase, token, {
        name: strategyName,
        description: strategyDescription,
        config: settings.config
      });
      await refresh();
      setCommandStatus("Strategy version saved.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Strategy snapshot failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  async function activateStrategy(version: StrategyVersion) {
    setCommandState("SAVING");
    setError(null);
    setCommandStatus(`Activating ${version.name}...`);

    try {
      await activateStrategyVersion(apiBase, token, version.versionId);
      riskDirtyRef.current = false;
      await refresh();
      setCommandStatus("Strategy hot-swap applied to the engine.");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setCommandStatus("Strategy activation failed.");
    } finally {
      setCommandState("IDLE");
    }
  }

  if (!token) {
    return (
      <main className="login-shell">
        <section className="login-panel glass">
          <div className="brand-lockup">
            <div className="sigil">
              <Settings size={22} />
            </div>
            <div>
              <h1>Sovereign-Sigma</h1>
              <p>Settings Console</p>
            </div>
          </div>

          <div className="login-copy">
            <strong>Backend settings gate</strong>
            <span>
              Authenticate to manage vault credentials, alert cadence, and engine parameters.
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
            <button className="primary-action" disabled={!password.trim()} type="submit">
              <KeyRound size={16} />
              Unlock Settings
            </button>
          </form>

          <StatusPill status={status} />
          {error ? <Fault message={error} /> : null}
          {commandStatus ? <CommandMessage message={commandStatus} /> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="settings-shell">
      <section className="settings-hero glass">
        <div className="brand-lockup">
          <div className="sigil">
            <Settings size={22} />
          </div>
          <div>
            <h1>Sovereign-Sigma</h1>
            <p>Backend Settings Console</p>
          </div>
        </div>
        <div className="settings-nav">
          <a href="/">Command Center</a>
          <button onClick={() => void refresh()}>
            <RadioTower size={16} />
            Refresh
          </button>
          <button onClick={handleLogout}>
            <Lock size={16} />
            Lock
          </button>
        </div>
      </section>

      <section className="settings-grid">
        <section className="settings-panel glass">
          <div className="panel-title">
            <TerminalSquare size={17} />
            <span>API Surface</span>
          </div>
          <div className="settings-form">
            <label>
              Gateway API
              <input value={apiBase} onChange={(event) => setApiBase(event.target.value)} />
            </label>
            <label>
              Admin WebSocket
              <input value={toWebSocketUrl(apiBase, "token").replace("token", "<jwt>")} readOnly />
            </label>
            <label>
              Pages Admin
              <input value="https://app.yevow.co/settings" readOnly />
            </label>
          </div>
          <StatusPill status={status} />
          {commandStatus ? <CommandMessage message={commandStatus} /> : null}
          {error ? <Fault message={error} /> : null}
        </section>

        <section className="settings-panel glass">
          <div className="panel-title">
            <RadioTower size={17} />
            <span>Market Data Transport</span>
          </div>
          <div className="settings-metrics">
            <Metric label="Read Mode" value={settingString(ingestSettings.readMode, "n/a")} />
            <Metric
              label="Book Transport"
              value={settingString(
                ingestSettings.dwellirOrderbookTransportEffective,
                "n/a"
              ).toUpperCase()}
            />
            <Metric
              label="Pure gRPC Book"
              value={ingestSettings.pureGrpcOrderbookActive === true ? "ACTIVE" : "INACTIVE"}
            />
            <Metric
              label="Depth"
              value={settingString(ingestSettings.dwellirOrderbookDepth, "n/a")}
            />
          </div>
          <div className="transport-explainer">
            <strong>
              {settingString(ingestSettings.readArchitecture, "Dwellir read path unavailable")}
            </strong>
            <span>
              {settingString(
                ingestSettings.pureGrpcOrderbookRequirement,
                "No provider transport note returned"
              )}
            </span>
          </div>
        </section>

        <section className="settings-panel glass">
          <div className="panel-title">
            <BellRing size={17} />
            <span>Alerting & Telegram</span>
            <button disabled={commandState !== "IDLE"} onClick={() => void saveNotifications()}>
              <Save size={16} />
              Save
            </button>
          </div>
          <div className="settings-form two-col">
            <ToggleField
              label="Notifications"
              checked={Boolean(effectiveNotifications.enabled)}
              onChange={(value) => updateNotificationDraft("enabled", value)}
            />
            <ToggleField
              label="Telegram"
              checked={Boolean(effectiveNotifications.telegramEnabled)}
              onChange={(value) => updateNotificationDraft("telegramEnabled", value)}
            />
            <ToggleField
              label="Discord"
              checked={Boolean(effectiveNotifications.discordEnabled)}
              onChange={(value) => updateNotificationDraft("discordEnabled", value)}
            />
            <ToggleField
              label="Generic Webhook"
              checked={Boolean(effectiveNotifications.genericWebhookEnabled)}
              onChange={(value) => updateNotificationDraft("genericWebhookEnabled", value)}
            />
            <label>
              Min Priority
              <select
                value={effectiveNotifications.minPriority ?? "HIGH"}
                onChange={(event) =>
                  updateNotificationDraft("minPriority", event.target.value as AlertPriority)
                }
              >
                <option>LOW</option>
                <option>MEDIUM</option>
                <option>HIGH</option>
                <option>CRITICAL</option>
              </select>
            </label>
            <label>
              Trade Alerts
              <select
                value={effectiveNotifications.tradeAlertMode ?? "FILLED_ONLY"}
                onChange={(event) =>
                  updateNotificationDraft(
                    "tradeAlertMode",
                    event.target.value as NotificationSettings["tradeAlertMode"]
                  )
                }
              >
                <option>ALL</option>
                <option>FILLED_ONLY</option>
                <option>NONE</option>
              </select>
            </label>
            <NumberField
              label="Debounce ms"
              value={effectiveNotifications.debounceMs ?? 60000}
              min={0}
              max={3600000}
              step={1000}
              onChange={(value) => updateNotificationDraft("debounceMs", value)}
            />
            <NumberField
              label="Text Cadence ms"
              value={effectiveNotifications.textFrequencyMs ?? 300000}
              min={10000}
              max={86400000}
              step={10000}
              onChange={(value) => updateNotificationDraft("textFrequencyMs", value)}
            />
            <NumberField
              label="Digest Minutes"
              value={effectiveNotifications.heartbeatDigestMinutes ?? 15}
              min={1}
              max={1440}
              step={1}
              onChange={(value) => updateNotificationDraft("heartbeatDigestMinutes", value)}
            />
            <ToggleField
              label="Quiet Hours"
              checked={Boolean(effectiveNotifications.quietHoursEnabled)}
              onChange={(value) => updateNotificationDraft("quietHoursEnabled", value)}
            />
            <label>
              Quiet Start UTC
              <input
                type="time"
                value={effectiveNotifications.quietHoursStartUtc ?? "00:00"}
                onChange={(event) =>
                  updateNotificationDraft("quietHoursStartUtc", event.target.value)
                }
              />
            </label>
            <label>
              Quiet End UTC
              <input
                type="time"
                value={effectiveNotifications.quietHoursEndUtc ?? "00:00"}
                onChange={(event) =>
                  updateNotificationDraft("quietHoursEndUtc", event.target.value)
                }
              />
            </label>
          </div>
          <div className="channel-list">
            {(settings?.alerting.channels ?? []).map((channel) => (
              <div
                className={`channel-row ${channel.configured ? "configured" : "missing"}`}
                key={channel.channel}
              >
                <strong>{channel.channel.replace("_", " ")}</strong>
                <span>
                  {channel.enabled === false
                    ? "DISABLED"
                    : channel.configured
                      ? (channel.source ?? "ARMED")
                      : "MISSING"}
                </span>
              </div>
            ))}
          </div>
          <div className="alert-summary">
            <Metric label="Configured" value={settings?.alerting.configured ? "YES" : "NO"} />
            <Metric
              label="Debounce"
              value={`${compact.format(settings?.alerting.debounceMs ?? 0)}ms`}
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
                  <span>{attempt.ok ? `HTTP ${attempt.status}` : (attempt.error ?? "FAILED")}</span>
                </div>
              ))}
            </div>
          ) : null}
          <button className="primary-action full-action" onClick={() => void runAlertTest("HIGH")}>
            <Send size={16} />
            Send Test Alert
          </button>
        </section>

        <section className="settings-panel glass">
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Credential Vault</span>
            <button
              disabled={commandState !== "IDLE" || !vaultSecret.trim()}
              onClick={() => void saveVaultSecret()}
            >
              <Save size={16} />
              Save Secret
            </button>
          </div>
          <div className="settings-form">
            <label>
              Secret Key
              <select
                value={vaultKey}
                onChange={(event) => setVaultKey(event.target.value as VaultKeyName)}
              >
                {VAULT_KEYS.map((key) => (
                  <option key={key}>{key}</option>
                ))}
              </select>
            </label>
            <label>
              Secret Value
              <input
                type="password"
                value={vaultSecret}
                autoComplete="off"
                onChange={(event) => setVaultSecret(event.target.value)}
              />
            </label>
            <label>
              Rotation Reason
              <input
                value={rotationReason}
                onChange={(event) => setRotationReason(event.target.value)}
              />
            </label>
          </div>
          <div className="vault-table">
            {Object.entries(settings?.vault.entries ?? {}).map(([key, entry]) => (
              <div className="vault-row" key={key}>
                <code>{key}</code>
                <span>
                  {entry.envConfigured ? "ENV" : entry.vaultConfigured ? "VAULT" : "MISSING"}
                </span>
                <span>{entry.updatedAt ? formatClock(entry.updatedAt) : "n/a"}</span>
              </div>
            ))}
          </div>
          <button className="full-action" onClick={() => void runVaultTest()}>
            <Wrench size={16} />
            Test Exchange Credential Path
          </button>
        </section>

        <section className="settings-panel settings-panel-wide glass">
          <div className="panel-title">
            <Shield size={17} />
            <span>Strategy Knobs</span>
            <button disabled={commandState !== "IDLE" || !settings} onClick={() => void saveRisk()}>
              <Save size={16} />
              Apply Knobs
            </button>
          </div>
          <div className="strategy-knob-grid">
            {STRATEGY_KNOBS.map((param) => (
              <ParameterControl
                key={param.key}
                param={param}
                value={riskDraft[param.key] ?? settings?.config[param.key]}
                onChange={(value) => updateRiskDraft(param.key, value)}
              />
            ))}
          </div>
          <div className="transport-explainer">
            <strong>
              Agent gates are hot-swapped through KV and refreshed by the Durable Object.
            </strong>
            <span>
              Disabling Croupier or Pit Boss is fail-closed: telemetry continues, but new executable
              quote or trade dispatch is blocked.
            </span>
          </div>
        </section>

        {cascadeRelated ? (
          <>
            <section className="settings-panel settings-panel-wide glass">
              <div className="panel-title">
                <RadioTower size={17} />
                <span>Cascade Asset Universe</span>
                <button
                  disabled={commandState !== "IDLE" || !settings}
                  onClick={() => void saveRisk()}
                >
                  <Save size={16} />
                  Save Assets
                </button>
              </div>
              <div className="asset-toggle-strip settings-asset-toggle-strip">
                <span>Manual Enable</span>
                {CASCADE_ASSET_OPTIONS.map((asset) => (
                  <button
                    className={cascadeAssets.has(asset) ? "asset-toggle active" : "asset-toggle"}
                    key={`settings-cascade-${asset}`}
                    onClick={() => toggleCascadeAsset(asset)}
                    type="button"
                  >
                    {cascadeAssets.has(asset) ? "●" : "○"} {asset}
                  </button>
                ))}
              </div>
              <div className="transport-explainer">
                <strong>
                  {String(riskDraft.CASCADE_INSTRUMENTS ?? settings?.config.CASCADE_INSTRUMENTS)}
                </strong>
                <span>
                  These toggles gate cascade detection, absorption, and new entries per asset. Open
                  cascade positions are still managed to exit even if an asset is later disabled.
                </span>
              </div>
            </section>

            <section className="settings-panel settings-panel-wide glass">
              <div className="panel-title">
                <Flame size={17} />
                <span>Cascade Detection Parameters</span>
                <button
                  disabled={commandState !== "IDLE" || !settings}
                  onClick={() => void saveRisk()}
                >
                  <Save size={16} />
                  Save Detection
                </button>
              </div>
              <div className="param-grid compact-param-grid">
                {cascadeDetectionParams.map((param) => (
                  <ParameterControl
                    key={`cascade-detect-${param.key}`}
                    param={param}
                    value={riskDraft[param.key] ?? settings?.config[param.key]}
                    onChange={(value) => updateRiskDraft(param.key, value)}
                  />
                ))}
              </div>
            </section>

            <section className="settings-panel settings-panel-wide glass">
              <div className="panel-title">
                <SlidersHorizontal size={17} />
                <span>Cascade Entry & Exit Parameters</span>
                <button
                  disabled={commandState !== "IDLE" || !settings}
                  onClick={() => void saveRisk()}
                >
                  <Save size={16} />
                  Save Entries
                </button>
              </div>
              <div className="param-grid compact-param-grid">
                {cascadeEntryExitParams.map((param) => (
                  <ParameterControl
                    key={`cascade-entry-${param.key}`}
                    param={param}
                    value={riskDraft[param.key] ?? settings?.config[param.key]}
                    onChange={(value) => updateRiskDraft(param.key, value)}
                  />
                ))}
              </div>
            </section>

            <section className="settings-panel settings-panel-wide glass">
              <div className="panel-title">
                <Shield size={17} />
                <span>Cascade Risk Limits</span>
                <button
                  disabled={commandState !== "IDLE" || !settings}
                  onClick={() => void saveRisk()}
                >
                  <Save size={16} />
                  Save Risk
                </button>
              </div>
              <div className="param-grid compact-param-grid">
                {cascadeRiskParams.map((param) => (
                  <ParameterControl
                    key={`cascade-risk-${param.key}`}
                    param={param}
                    value={riskDraft[param.key] ?? settings?.config[param.key]}
                    onChange={(value) => updateRiskDraft(param.key, value)}
                  />
                ))}
              </div>
            </section>
          </>
        ) : null}

        <section className="settings-panel settings-panel-wide glass">
          <div className="panel-title">
            <SlidersHorizontal size={17} />
            <span>Full Parameter Matrix</span>
            <button disabled={commandState !== "IDLE" || !settings} onClick={() => void saveRisk()}>
              <Save size={16} />
              Save Matrix
            </button>
          </div>
          <div className="param-grid">
            {PARAMETER_MATRIX.map((param) => (
              <ParameterControl
                key={param.key}
                param={param}
                value={riskDraft[param.key] ?? settings?.config[param.key]}
                onChange={(value) => updateRiskDraft(param.key, value)}
              />
            ))}
          </div>
        </section>

        <section className="settings-panel settings-panel-wide glass">
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Strategy Vault</span>
            <button
              disabled={commandState !== "IDLE" || !settings}
              onClick={() => void snapshotStrategy()}
            >
              <Save size={16} />
              Snapshot
            </button>
          </div>
          <div className="settings-form two-col">
            <label>
              Version Name
              <input
                value={strategyName}
                onChange={(event) => setStrategyName(event.target.value)}
              />
            </label>
            <label>
              Description
              <input
                value={strategyDescription}
                onChange={(event) => setStrategyDescription(event.target.value)}
              />
            </label>
          </div>
          <div className="vault-table strategy-table">
            {(settings?.strategyVault?.versions ?? []).map((version) => (
              <div className={`vault-row ${version.status.toLowerCase()}`} key={version.versionId}>
                <code>{version.name}</code>
                <span>{version.status}</span>
                <span>
                  {version.activatedAt
                    ? formatClock(version.activatedAt)
                    : formatClock(version.createdAt)}
                </span>
                <button
                  disabled={commandState !== "IDLE" || version.status === "ACTIVE"}
                  onClick={() => void activateStrategy(version)}
                >
                  Activate
                </button>
              </div>
            ))}
            {(settings?.strategyVault?.versions ?? []).length === 0 ? (
              <div className="vault-row">
                <code>NO_STRATEGY_VERSIONS</code>
                <span>Snapshot the current matrix before the next tuning pass.</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="settings-panel glass">
          <div className="panel-title">
            <Shield size={17} />
            <span>Operations</span>
          </div>
          <div className="settings-metrics">
            <Metric
              label="Trading"
              value={settings?.config.TRADING_ENABLED ? "ENABLED" : "DISABLED"}
            />
            <Metric
              label="Max Latency"
              value={`${compact.format(settings?.config.LATENCY_THRESHOLD_MS ?? 0)}ms`}
            />
            <Metric
              label="Alert Debounce"
              value={`${compact.format(settings?.notifications.debounceMs ?? 0)}ms`}
            />
            <Metric
              label="Vault Entries"
              value={String(Object.keys(settings?.vault.entries ?? {}).length)}
            />
          </div>
          <button className="danger-action full-action" onClick={() => void resetLatency()}>
            Reset Latency Baseline
          </button>
        </section>

        <section className="settings-panel settings-panel-wide glass">
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Cost Budgets & Log Export</span>
            <button disabled={commandState !== "IDLE"} onClick={() => void saveCostBudgets()}>
              <Save size={16} />
              Save Budgets
            </button>
          </div>
          <div className="settings-metrics">
            <Metric
              label="Structured Logs"
              value={settingString(apiSettings.structuredConsoleLogs, "false").toUpperCase()}
            />
            <Metric
              label="Sink Provider"
              value={settingString(apiSettings.logSinkProvider, "disabled").toUpperCase()}
            />
            <Metric
              label="Sink Armed"
              value={apiSettings.logSinkConfigured === true ? "YES" : "NO"}
            />
            <Metric label="Sink Dataset" value={settingString(apiSettings.logSinkDataset, "n/a")} />
          </div>
          <div className="settings-form two-col">
            <NumberField
              label="Daily Hard Budget USD"
              value={numberSetting(effectiveCostBudgets.dailyBudgetUsd, 25)}
              min={0}
              max={1000000}
              step={1}
              onChange={(value) => updateCostDraft("dailyBudgetUsd", value)}
            />
            <NumberField
              label="Workers AI Budget USD"
              value={numberSetting(effectiveCostBudgets.workersAiDailyBudgetUsd, 2)}
              min={0}
              max={100000}
              step={0.01}
              onChange={(value) => updateCostDraft("workersAiDailyBudgetUsd", value)}
            />
            <NumberField
              label="Durable Object Budget USD"
              value={numberSetting(effectiveCostBudgets.durableObjectDailyBudgetUsd, 10)}
              min={0}
              max={100000}
              step={0.01}
              onChange={(value) => updateCostDraft("durableObjectDailyBudgetUsd", value)}
            />
            <NumberField
              label="D1 Budget USD"
              value={numberSetting(effectiveCostBudgets.d1DailyBudgetUsd, 5)}
              min={0}
              max={100000}
              step={0.01}
              onChange={(value) => updateCostDraft("d1DailyBudgetUsd", value)}
            />
            <NumberField
              label="Workers AI Cost / Call"
              value={numberSetting(effectiveCostBudgets.workersAiCostPerCallUsd, 0)}
              min={0}
              max={1000}
              step={0.000001}
              onChange={(value) => updateCostDraft("workersAiCostPerCallUsd", value)}
            />
            <NumberField
              label="DO Cost / ms"
              value={numberSetting(effectiveCostBudgets.durableObjectCostPerMsUsd, 0)}
              min={0}
              max={1000}
              step={0.000000001}
              onChange={(value) => updateCostDraft("durableObjectCostPerMsUsd", value)}
            />
            <NumberField
              label="D1 Read Cost / Query"
              value={numberSetting(effectiveCostBudgets.d1ReadCostPerQueryUsd, 0)}
              min={0}
              max={1000}
              step={0.000001}
              onChange={(value) => updateCostDraft("d1ReadCostPerQueryUsd", value)}
            />
            <NumberField
              label="D1 Write Cost / Row"
              value={numberSetting(effectiveCostBudgets.d1WriteCostPerRowUsd, 0)}
              min={0}
              max={1000}
              step={0.000001}
              onChange={(value) => updateCostDraft("d1WriteCostPerRowUsd", value)}
            />
            <label>
              Budget Enforcement
              <select
                value={effectiveCostBudgets.enforcement ?? "BLOCK_LIVE"}
                onChange={(event) =>
                  updateCostDraft(
                    "enforcement",
                    event.target.value as CostBudgetSettings["enforcement"]
                  )
                }
              >
                <option>WARN</option>
                <option>BLOCK_LIVE</option>
                <option>BLOCK_ALL</option>
              </select>
            </label>
          </div>
          <div className="transport-explainer">
            <strong>Hard budgets gate live posture changes.</strong>
            <span>
              Unit costs are explicit operator inputs, so the dashboard never invents provider
              billing numbers. Set Axiom/Honeycomb/HTTP sink secrets with Wrangler.
            </span>
          </div>
        </section>

        <section className="settings-panel settings-panel-wide glass">
          <div className="panel-title">
            <ChevronRight size={17} />
            <span>Engine Raw State Matrix</span>
          </div>
          <div className="state-table settings-state-table">
            {stateRows.map(([key, value]) => (
              <div className="state-row" key={key}>
                <code>{key}</code>
                <span>{value}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="settings-panel settings-panel-wide glass">
          <div className="panel-title">
            <ChevronRight size={17} />
            <span>Backend Runtime Settings</span>
          </div>
          <div className="state-table settings-state-table">
            {backendRows.map(([key, value]) => (
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
              <span>Confirm Matrix Change</span>
            </div>
            <p>{pendingFields.join(", ")} changed by more than 10%. Type CONFIRM to apply.</p>
            <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
            <div className="modal-actions">
              <button onClick={() => setPendingFields([])}>Cancel</button>
              <button
                className="danger-action"
                disabled={confirmText !== "CONFIRM"}
                onClick={() => void saveRisk(true)}
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

function validateRiskDraft(draft: Partial<GlobalRiskConfig>): string | null {
  const descriptors = [...STRATEGY_KNOBS, ...PARAMETER_MATRIX];

  for (const descriptor of descriptors) {
    if (descriptor.kind !== "number" || !(descriptor.key in draft)) {
      continue;
    }

    const value = Number(draft[descriptor.key]);
    if (!Number.isFinite(value)) {
      return `${descriptor.label} must be a finite number.`;
    }
    if (descriptor.min !== undefined && value < descriptor.min) {
      return `${descriptor.label} must be greater than or equal to ${descriptor.min}.`;
    }
    if (descriptor.max !== undefined && value > descriptor.max) {
      return `${descriptor.label} must be less than or equal to ${descriptor.max}.`;
    }
  }

  return null;
}

function parseCascadeAssets(value: string): Set<string> {
  const parsed = value
    .split(",")
    .map((asset) => asset.trim().toUpperCase())
    .filter((asset) => asset.length > 0);
  return new Set(parsed.length > 0 ? parsed : ["BTC", "ETH", "SOL"]);
}

function formatClock(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : value;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settingString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

function isVisibleStateRow(key: string): boolean {
  const normalized = key.toLowerCase();

  if (normalized.includes("posteriorpdf.points")) {
    return false;
  }

  return !RETIRED_STATE_TOKENS.some((token) => normalized.includes(token));
}

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

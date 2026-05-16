"use client";

import {
  AlertTriangle,
  BellRing,
  ChevronRight,
  CircleDot,
  DatabaseZap,
  Info,
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
  login,
  readSettings,
  resetLatencyBaseline,
  rotateVaultSecret,
  sendTestAlert,
  testVaultConnection,
  toWebSocketUrl,
  updateConfig,
  updateNotificationSettings
} from "@/lib/api";
import {
  PARAMETER_MATRIX,
  changedMoreThanTenPercent,
  flattenState,
  parameterHelp
} from "@/lib/parameters";
import type {
  AdminSettingsResponse,
  AlertPriority,
  GlobalRiskConfig,
  NotificationSettings,
  NotificationSettingsUpdate,
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

export default function SettingsPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("LOCKED");
  const [error, setError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [commandState, setCommandState] = useState<CommandState>("IDLE");
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null);
  const [riskDraft, setRiskDraft] = useState<Partial<GlobalRiskConfig>>({});
  const [notificationDraft, setNotificationDraft] = useState<NotificationSettingsUpdate>({});
  const [vaultKey, setVaultKey] = useState<VaultKeyName>("TELEGRAM_BOT_TOKEN");
  const [vaultSecret, setVaultSecret] = useState("");
  const [rotationReason, setRotationReason] = useState("settings-page-rotation");
  const [pendingFields, setPendingFields] = useState<string[]>([]);
  const [confirmText, setConfirmText] = useState("");
  const riskDirtyRef = useRef(false);
  const notificationDirtyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    const response = await readSettings(apiBase, token);
    setSettings(response);
    if (!riskDirtyRef.current) {
      setRiskDraft(response.config);
    }
    if (!notificationDirtyRef.current) {
      setNotificationDraft(response.notifications);
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
  const activeNotifications = settings?.notifications;
  const effectiveNotifications = {
    ...activeNotifications,
    ...notificationDraft
  } as NotificationSettings;

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
    setRiskDraft({});
    setNotificationDraft({});
    setCommandStatus("Settings console locked.");
  }

  function updateRiskDraft(key: keyof GlobalRiskConfig, value: string | number | boolean) {
    riskDirtyRef.current = true;
    setRiskDraft((draft) => ({
      ...draft,
      [key]: value
    }));
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

  async function saveRisk(force = false) {
    if (!settings) {
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
            <span>Authenticate to manage vault credentials, alert cadence, and engine parameters.</span>
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
                onChange={(event) => updateNotificationDraft("quietHoursStartUtc", event.target.value)}
              />
            </label>
            <label>
              Quiet End UTC
              <input
                type="time"
                value={effectiveNotifications.quietHoursEndUtc ?? "00:00"}
                onChange={(event) => updateNotificationDraft("quietHoursEndUtc", event.target.value)}
              />
            </label>
          </div>
          <div className="channel-list">
            {(settings?.alerting.channels ?? []).map((channel) => (
              <div className={`channel-row ${channel.configured ? "configured" : "missing"}`} key={channel.channel}>
                <strong>{channel.channel.replace("_", " ")}</strong>
                <span>{channel.enabled === false ? "DISABLED" : channel.configured ? channel.source ?? "ARMED" : "MISSING"}</span>
              </div>
            ))}
          </div>
          <button className="primary-action full-action" onClick={() => void runAlertTest("HIGH")}>
            <Send size={16} />
            Send Test Alert
          </button>
        </section>

        <section className="settings-panel glass">
          <div className="panel-title">
            <DatabaseZap size={17} />
            <span>Credential Vault</span>
            <button disabled={commandState !== "IDLE" || !vaultSecret.trim()} onClick={() => void saveVaultSecret()}>
              <Save size={16} />
              Save Secret
            </button>
          </div>
          <div className="settings-form">
            <label>
              Secret Key
              <select value={vaultKey} onChange={(event) => setVaultKey(event.target.value as VaultKeyName)}>
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
              <input value={rotationReason} onChange={(event) => setRotationReason(event.target.value)} />
            </label>
          </div>
          <div className="vault-table">
            {Object.entries(settings?.vault.entries ?? {}).map(([key, entry]) => (
              <div className="vault-row" key={key}>
                <code>{key}</code>
                <span>{entry.envConfigured ? "ENV" : entry.vaultConfigured ? "VAULT" : "MISSING"}</span>
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
            <SlidersHorizontal size={17} />
            <span>Engine Parameter Matrix</span>
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

        <section className="settings-panel glass">
          <div className="panel-title">
            <Shield size={17} />
            <span>Operations</span>
          </div>
          <div className="settings-metrics">
            <Metric label="Trading" value={settings?.config.TRADING_ENABLED ? "ENABLED" : "DISABLED"} />
            <Metric label="Max Latency" value={`${compact.format(settings?.config.LATENCY_THRESHOLD_MS ?? 0)}ms`} />
            <Metric label="Alert Debounce" value={`${compact.format(settings?.notifications.debounceMs ?? 0)}ms`} />
            <Metric label="Vault Entries" value={String(Object.keys(settings?.vault.entries ?? {}).length)} />
          </div>
          <button className="danger-action full-action" onClick={() => void resetLatency()}>
            Reset Latency Baseline
          </button>
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
            <p>
              {pendingFields.join(", ")} changed by more than 10%. Type CONFIRM to apply.
            </p>
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

function ParameterControl({
  param,
  value,
  onChange
}: {
  param: (typeof PARAMETER_MATRIX)[number];
  value: unknown;
  onChange: (value: string | number | boolean) => void;
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
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
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
        min={param.min}
        max={param.max}
        step={param.step}
        value={Number(value ?? 0)}
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

function ToggleField({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function NumberField({
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
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  return (
    <div className={`system-state ${status.toLowerCase()}`}>
      <CircleDot size={14} />
      <span>{status}</span>
    </div>
  );
}

function Fault({ message }: { message: string }) {
  return (
    <div className="fault">
      <AlertTriangle size={16} />
      <span>{message}</span>
    </div>
  );
}

function CommandMessage({ message }: { message: string }) {
  return (
    <div className="system-state">
      <ChevronRight size={14} />
      <span>{message}</span>
    </div>
  );
}

function formatClock(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

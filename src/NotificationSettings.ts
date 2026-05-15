import type { Env, NotificationSettings, NotificationSettingsUpdate } from "./types";

export const NOTIFICATION_SETTINGS_KEY = "notification_settings";

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_TEXT_FREQUENCY_MS = 300_000;
const DEFAULT_HEARTBEAT_DIGEST_MINUTES = 15;

export function defaultNotificationSettings(env: Env): NotificationSettings {
  return {
    schemaVersion: "notification-settings.v1",
    enabled: true,
    minPriority: "HIGH",
    debounceMs: positiveInteger(env.NOTIFIER_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS),
    textFrequencyMs: DEFAULT_TEXT_FREQUENCY_MS,
    heartbeatDigestMinutes: DEFAULT_HEARTBEAT_DIGEST_MINUTES,
    tradeAlertMode: "FILLED_ONLY",
    telegramEnabled: true,
    discordEnabled: true,
    genericWebhookEnabled: true,
    quietHoursEnabled: false,
    quietHoursStartUtc: "00:00",
    quietHoursEndUtc: "00:00",
    updatedAt: "1970-01-01T00:00:00.000Z",
    updatedBy: "system-default",
    version: "default"
  };
}

export async function readNotificationSettings(env: Env): Promise<NotificationSettings> {
  try {
    const stored = await env.CONFIG_STORE.get<Partial<NotificationSettings>>(
      NOTIFICATION_SETTINGS_KEY,
      "json"
    );

    return normalizeNotificationSettings(stored ?? {}, env);
  } catch (error) {
    console.error(
      "[Sovereign-Sigma] notification settings read failed; defaults active",
      error instanceof Error ? error.message : error
    );
    return defaultNotificationSettings(env);
  }
}

export async function writeNotificationSettings(
  env: Env,
  update: NotificationSettingsUpdate,
  updatedBy: string
): Promise<NotificationSettings> {
  const current = await readNotificationSettings(env);
  const next = normalizeNotificationSettings(
    {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
      updatedBy,
      version: crypto.randomUUID()
    },
    env
  );

  await env.CONFIG_STORE.put(NOTIFICATION_SETTINGS_KEY, JSON.stringify(next));

  return next;
}

function normalizeNotificationSettings(
  value: Partial<NotificationSettings>,
  env: Env
): NotificationSettings {
  const fallback = defaultNotificationSettings(env);

  return {
    schemaVersion: "notification-settings.v1",
    enabled: value.enabled !== false,
    minPriority: normalizePriority(value.minPriority, fallback.minPriority),
    debounceMs: boundedInteger(value.debounceMs, 0, 3_600_000, fallback.debounceMs),
    textFrequencyMs: boundedInteger(
      value.textFrequencyMs,
      10_000,
      86_400_000,
      fallback.textFrequencyMs
    ),
    heartbeatDigestMinutes: boundedInteger(
      value.heartbeatDigestMinutes,
      1,
      1_440,
      fallback.heartbeatDigestMinutes
    ),
    tradeAlertMode: normalizeTradeAlertMode(value.tradeAlertMode, fallback.tradeAlertMode),
    telegramEnabled: value.telegramEnabled !== false,
    discordEnabled: value.discordEnabled !== false,
    genericWebhookEnabled: value.genericWebhookEnabled !== false,
    quietHoursEnabled: value.quietHoursEnabled === true,
    quietHoursStartUtc: normalizeUtcTime(value.quietHoursStartUtc, fallback.quietHoursStartUtc),
    quietHoursEndUtc: normalizeUtcTime(value.quietHoursEndUtc, fallback.quietHoursEndUtc),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : fallback.updatedBy,
    version: typeof value.version === "string" ? value.version : fallback.version
  };
}

function normalizePriority(
  value: unknown,
  fallback: NotificationSettings["minPriority"]
): NotificationSettings["minPriority"] {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "CRITICAL"
    ? value
    : fallback;
}

function normalizeTradeAlertMode(
  value: unknown,
  fallback: NotificationSettings["tradeAlertMode"]
): NotificationSettings["tradeAlertMode"] {
  return value === "ALL" || value === "FILLED_ONLY" || value === "NONE" ? value : fallback;
}

function normalizeUtcTime(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

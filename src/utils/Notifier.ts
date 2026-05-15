import { defaultNotificationSettings, readNotificationSettings } from "../NotificationSettings";
import type { Env, JsonRecord, JsonValue, NotificationSettings } from "../types";

export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertChannel = "DISCORD" | "TELEGRAM" | "GENERIC_WEBHOOK";

export interface NotifierEvent {
  priority: AlertPriority;
  title: string;
  message: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface AlertChannelStatus {
  channel: AlertChannel;
  configured: boolean;
  enabled: boolean;
  envConfigured: boolean;
  vaultConfigured: boolean;
  source: "ENV" | "VAULT" | "MISSING";
}

export interface AlertDeliveryAttempt {
  channel: AlertChannel;
  ok: boolean;
  status: number | null;
  error?: string;
}

export interface AlertDeliveryResult {
  ok: boolean;
  debounced: boolean;
  configuredChannels: AlertChannelStatus[];
  attempted: number;
  delivered: number;
  attempts: AlertDeliveryAttempt[];
  observedAt: string;
}

type WaitUntil = (promise: Promise<unknown>) => void;
type DeliverOptions = {
  respectDebounce?: boolean;
};

const TELEGRAM_MAX_MESSAGE_LENGTH = 3_500;
const DISCORD_MAX_MESSAGE_LENGTH = 1_900;
const GENERIC_WEBHOOK_MAX_MESSAGE_LENGTH = 5_000;
const PRIORITY_RANK: Record<AlertPriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

interface ChannelSecrets {
  discordWebhookUrl: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  genericWebhookUrl: string | null;
  statuses: AlertChannelStatus[];
}

export class Notifier {
  constructor(
    private readonly env: Env,
    private readonly waitUntil: WaitUntil
  ) {}

  notify(event: NotifierEvent): void {
    this.waitUntil(this.deliver(event));
  }

  status(): { channels: AlertChannelStatus[]; debounceMs: number; settings: NotificationSettings } {
    const settings = defaultNotificationSettings(this.env);

    return {
      channels: configuredChannelsFromEnv(this.env, settings),
      debounceMs: settings.debounceMs,
      settings
    };
  }

  async statusAsync(): Promise<{
    channels: AlertChannelStatus[];
    debounceMs: number;
    settings: NotificationSettings;
  }> {
    const settings = await readNotificationSettings(this.env);
    const secrets = await this.resolveChannelSecrets(settings);

    return {
      channels: secrets.statuses,
      debounceMs: settings.debounceMs,
      settings
    };
  }

  async deliverNow(
    event: NotifierEvent,
    options: DeliverOptions = {}
  ): Promise<AlertDeliveryResult> {
    return this.deliver(event, {
      respectDebounce: options.respectDebounce ?? true
    });
  }

  private async deliver(
    event: NotifierEvent,
    options: DeliverOptions = { respectDebounce: true }
  ): Promise<AlertDeliveryResult> {
    const settings = await readNotificationSettings(this.env);
    const secrets = await this.resolveChannelSecrets(settings);
    const channelStatus = secrets.statuses;

    try {
      if (
        !settings.enabled ||
        PRIORITY_RANK[event.priority] < PRIORITY_RANK[settings.minPriority] ||
        isQuietHour(settings)
      ) {
        return {
          ok: true,
          debounced: false,
          configuredChannels: channelStatus,
          attempted: 0,
          delivered: 0,
          attempts: [],
          observedAt: new Date().toISOString()
        };
      }

      if (options.respectDebounce !== false && (await this.isDebounced(event, settings))) {
        return {
          ok: true,
          debounced: true,
          configuredChannels: channelStatus,
          attempted: 0,
          delivered: 0,
          attempts: [],
          observedAt: new Date().toISOString()
        };
      }

      const sanitized = sanitizeMetadata(event.metadata ?? {});
      const message = formatAlert(event, sanitized);
      const jobs: Array<Promise<AlertDeliveryAttempt>> = [];

      if (settings.discordEnabled && secrets.discordWebhookUrl) {
        jobs.push(
          fetch(secrets.discordWebhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: trim(message, DISCORD_MAX_MESSAGE_LENGTH),
              allowed_mentions: { parse: [] }
            })
          }).then((response) => deliveryAttempt("DISCORD", response))
            .catch((error) => rejectedAttempt("DISCORD", error))
        );
      }

      if (settings.telegramEnabled && secrets.telegramBotToken && secrets.telegramChatId) {
        jobs.push(
          fetch(`https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: secrets.telegramChatId,
              text: trim(message, TELEGRAM_MAX_MESSAGE_LENGTH),
              disable_web_page_preview: true
            })
          }).then((response) => deliveryAttempt("TELEGRAM", response))
            .catch((error) => rejectedAttempt("TELEGRAM", error))
        );
      }

      if (settings.genericWebhookEnabled && secrets.genericWebhookUrl) {
        jobs.push(
          fetch(secrets.genericWebhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              schemaVersion: "sovereign-alert.v1",
              priority: event.priority,
              title: event.title,
              message: trim(event.message, GENERIC_WEBHOOK_MAX_MESSAGE_LENGTH),
              metadata: sanitized,
              observedAt: new Date().toISOString()
            })
          }).then((response) => deliveryAttempt("GENERIC_WEBHOOK", response))
            .catch((error) => rejectedAttempt("GENERIC_WEBHOOK", error))
        );
      }

      const attempts = await Promise.all(jobs);
      for (const attempt of attempts) {
        if (!attempt.ok) {
          console.error(
            "[Sovereign-Sigma] notifier delivery failed",
            attempt.channel,
            attempt.status,
            attempt.error ?? "HTTP_ERROR"
          );
        }
      }

      const delivered = attempts.filter((attempt) => attempt.ok).length;

      return {
        ok: jobs.length > 0 && delivered === jobs.length,
        debounced: false,
        configuredChannels: channelStatus,
        attempted: jobs.length,
        delivered,
        attempts,
        observedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] notifier failed",
        error instanceof Error ? error.message : error
      );
      return {
        ok: false,
        debounced: false,
        configuredChannels: channelStatus,
        attempted: 0,
        delivered: 0,
        attempts: [
          {
            channel: "GENERIC_WEBHOOK",
            ok: false,
            status: null,
            error: error instanceof Error ? error.message : "UNKNOWN_NOTIFIER_ERROR"
          }
        ],
        observedAt: new Date().toISOString()
      };
    }
  }

  private async isDebounced(
    event: NotifierEvent,
    settings: NotificationSettings
  ): Promise<boolean> {
    if (!event.dedupeKey || !this.env.CONFIG_STORE) {
      return false;
    }

    const debounceMs = settings.debounceMs;
    if (debounceMs <= 0) {
      return false;
    }

    const key = `notifier:dedupe:${event.priority}:${event.dedupeKey}`;

    try {
      const existing = await this.env.CONFIG_STORE.get(key);
      if (existing) {
        return true;
      }

      await this.env.CONFIG_STORE.put(key, "1", {
        expirationTtl: Math.max(1, Math.ceil(debounceMs / 1000))
      });
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] notifier debounce unavailable",
        error instanceof Error ? error.message : error
      );
    }

    return false;
  }

  private async resolveChannelSecrets(settings: NotificationSettings): Promise<ChannelSecrets> {
    const [
      discordVault,
      telegramBotVault,
      telegramChatVault,
      genericWebhookVault
    ] = await Promise.all([
      readVaultSecret(this.env, "DISCORD_WEBHOOK_URL"),
      readVaultSecret(this.env, "TELEGRAM_BOT_TOKEN"),
      readVaultSecret(this.env, "TELEGRAM_CHAT_ID"),
      readVaultSecret(this.env, "ALERT_WEBHOOK_URL")
    ]);
    const discordWebhookUrl = this.env.DISCORD_WEBHOOK_URL ?? discordVault.value;
    const telegramBotToken = this.env.TELEGRAM_BOT_TOKEN ?? telegramBotVault.value;
    const telegramChatId = this.env.TELEGRAM_CHAT_ID ?? telegramChatVault.value;
    const genericWebhookUrl = this.env.ALERT_WEBHOOK_URL ?? genericWebhookVault.value;
    const statuses: AlertChannelStatus[] = [
      channelStatus("DISCORD", settings.discordEnabled, Boolean(this.env.DISCORD_WEBHOOK_URL), discordVault.configured),
      channelStatus(
        "TELEGRAM",
        settings.telegramEnabled,
        Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID),
        telegramBotVault.configured && telegramChatVault.configured
      ),
      channelStatus(
        "GENERIC_WEBHOOK",
        settings.genericWebhookEnabled,
        Boolean(this.env.ALERT_WEBHOOK_URL),
        genericWebhookVault.configured
      )
    ];

    return {
      discordWebhookUrl,
      telegramBotToken,
      telegramChatId,
      genericWebhookUrl,
      statuses
    };
  }
}

function configuredChannelsFromEnv(
  env: Env,
  settings: NotificationSettings
): AlertChannelStatus[] {
  return [
    channelStatus("DISCORD", settings.discordEnabled, Boolean(env.DISCORD_WEBHOOK_URL), false),
    channelStatus(
      "TELEGRAM",
      settings.telegramEnabled,
      Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      false
    ),
    channelStatus("GENERIC_WEBHOOK", settings.genericWebhookEnabled, Boolean(env.ALERT_WEBHOOK_URL), false)
  ];
}

function channelStatus(
  channel: AlertChannel,
  enabled: boolean,
  envConfigured: boolean,
  vaultConfigured: boolean
): AlertChannelStatus {
  const source = envConfigured ? "ENV" : vaultConfigured ? "VAULT" : "MISSING";

  return {
    channel,
    enabled,
    envConfigured,
    vaultConfigured,
    source,
    configured: enabled && (envConfigured || vaultConfigured)
  };
}

function deliveryAttempt(channel: AlertChannel, response: Response): AlertDeliveryAttempt {
  return {
    channel,
    ok: response.ok,
    status: response.status,
    error: response.ok ? undefined : `HTTP_${response.status}`
  };
}

function rejectedAttempt(channel: AlertChannel, error: unknown): AlertDeliveryAttempt {
  return {
    channel,
    ok: false,
    status: null,
    error: error instanceof Error ? error.message : "NETWORK_ERROR"
  };
}

function formatAlert(event: NotifierEvent, metadata: JsonRecord): string {
  return [
    `[${event.priority}] ${event.title}`,
    event.message,
    Object.keys(metadata).length > 0 ? `metadata=${JSON.stringify(metadata)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function trim(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function sanitizeMetadata(value: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item, key)])
  );
}

function sanitizeJsonValue(value: unknown, keyHint = ""): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return isSensitiveKey(keyHint) ? "[REDACTED]" : redactSecrets(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, keyHint));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item, key)])
    );
  }

  return String(value);
}

function redactSecrets(value: string): string {
  return /(secret|token|password|api[_-]?key)/i.test(value) ? "[REDACTED]" : value;
}

function isSensitiveKey(value: string): boolean {
  return /(secret|token|password|api[_-]?key|webhook|authorization|bearer)/i.test(value);
}

function isQuietHour(settings: NotificationSettings): boolean {
  if (!settings.quietHoursEnabled || settings.quietHoursStartUtc === settings.quietHoursEndUtc) {
    return false;
  }

  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = parseUtcMinutes(settings.quietHoursStartUtc);
  const endMinutes = parseUtcMinutes(settings.quietHoursEndUtc);

  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  return startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function parseUtcMinutes(value: string): number | null {
  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

async function readVaultSecret(
  env: Env,
  keyName: string
): Promise<{ configured: boolean; value: string | null }> {
  try {
    const metadata = await env.RISK_VAULT.get<JsonRecord>(`vault:metadata:${keyName}`, "json");
    if (!metadata) {
      return { configured: false, value: null };
    }

    const encryptionSecret = env.VAULT_ENCRYPTION_SECRET ?? env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;
    if (!encryptionSecret) {
      return { configured: false, value: null };
    }

    const encrypted = await env.RISK_VAULT.get<JsonRecord>(`vault:secret:${keyName}`, "json");
    if (!encrypted) {
      return { configured: false, value: null };
    }

    const value = await decryptSecret(encrypted, encryptionSecret);

    return {
      configured: Boolean(value),
      value
    };
  } catch (error) {
    console.error(
      "[Sovereign-Sigma] notifier vault lookup failed",
      keyName,
      error instanceof Error ? error.message : error
    );
    return { configured: false, value: null };
  }
}

async function decryptSecret(encrypted: JsonRecord, keyMaterial: string): Promise<string | null> {
  if (
    encrypted.alg !== "AES-GCM" ||
    typeof encrypted.iv !== "string" ||
    typeof encrypted.ciphertext !== "string"
  ) {
    return null;
  }

  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
    key,
    base64ToBytes(encrypted.ciphertext)
  );

  return new TextDecoder().decode(plaintext);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

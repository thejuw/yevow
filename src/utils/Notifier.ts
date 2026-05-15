import type { Env, JsonRecord, JsonValue } from "../types";

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

const DEFAULT_DEBOUNCE_MS = 60_000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 3_500;
const DISCORD_MAX_MESSAGE_LENGTH = 1_900;
const GENERIC_WEBHOOK_MAX_MESSAGE_LENGTH = 5_000;

export class Notifier {
  constructor(
    private readonly env: Env,
    private readonly waitUntil: WaitUntil
  ) {}

  notify(event: NotifierEvent): void {
    this.waitUntil(this.deliver(event));
  }

  status(): { channels: AlertChannelStatus[]; debounceMs: number } {
    return {
      channels: configuredChannels(this.env),
      debounceMs: readPositiveInteger(this.env.NOTIFIER_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS)
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
    const channelStatus = configuredChannels(this.env);

    try {
      if (options.respectDebounce !== false && (await this.isDebounced(event))) {
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

      if (this.env.DISCORD_WEBHOOK_URL) {
        jobs.push(
          fetch(this.env.DISCORD_WEBHOOK_URL, {
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

      if (this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID) {
        jobs.push(
          fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: this.env.TELEGRAM_CHAT_ID,
              text: trim(message, TELEGRAM_MAX_MESSAGE_LENGTH),
              disable_web_page_preview: true
            })
          }).then((response) => deliveryAttempt("TELEGRAM", response))
            .catch((error) => rejectedAttempt("TELEGRAM", error))
        );
      }

      if (this.env.ALERT_WEBHOOK_URL) {
        jobs.push(
          fetch(this.env.ALERT_WEBHOOK_URL, {
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

  private async isDebounced(event: NotifierEvent): Promise<boolean> {
    if (!event.dedupeKey || !this.env.CONFIG_STORE) {
      return false;
    }

    const debounceMs = readPositiveInteger(this.env.NOTIFIER_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS);
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
}

function configuredChannels(env: Env): AlertChannelStatus[] {
  return [
    { channel: "DISCORD", configured: Boolean(env.DISCORD_WEBHOOK_URL) },
    {
      channel: "TELEGRAM",
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    },
    { channel: "GENERIC_WEBHOOK", configured: Boolean(env.ALERT_WEBHOOK_URL) }
  ];
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

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

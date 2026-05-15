import type { Env, JsonRecord, JsonValue } from "../types";

export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface NotifierEvent {
  priority: AlertPriority;
  title: string;
  message: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

type WaitUntil = (promise: Promise<unknown>) => void;

const DEFAULT_DEBOUNCE_MS = 60_000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 3_500;
const DISCORD_MAX_MESSAGE_LENGTH = 1_900;

export class Notifier {
  constructor(
    private readonly env: Env,
    private readonly waitUntil: WaitUntil
  ) {}

  notify(event: NotifierEvent): void {
    this.waitUntil(this.deliver(event));
  }

  private async deliver(event: NotifierEvent): Promise<void> {
    try {
      if (await this.isDebounced(event)) {
        return;
      }

      const sanitized = sanitizeMetadata(event.metadata ?? {});
      const message = formatAlert(event, sanitized);
      const jobs: Promise<Response>[] = [];

      if (this.env.DISCORD_WEBHOOK_URL) {
        jobs.push(
          fetch(this.env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: trim(message, DISCORD_MAX_MESSAGE_LENGTH),
              allowed_mentions: { parse: [] }
            })
          })
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
          })
        );
      }

      const results = await Promise.allSettled(jobs);
      for (const result of results) {
        if (result.status === "fulfilled" && !result.value.ok) {
          console.error("[Sovereign-Sigma] notifier delivery failed", result.value.status);
        } else if (result.status === "rejected") {
          console.error(
            "[Sovereign-Sigma] notifier delivery failed",
            result.reason instanceof Error ? result.reason.message : result.reason
          );
        }
      }
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] notifier failed",
        error instanceof Error ? error.message : error
      );
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
    Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)])
  );
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return redactSecrets(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)])
    );
  }

  return String(value);
}

function redactSecrets(value: string): string {
  return /(secret|token|password|api[_-]?key)/i.test(value) ? "[REDACTED]" : value;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

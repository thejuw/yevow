import type { JsonRecord } from "../types";
import type { AlertPriority } from "../utils/Notifier";

export function normalizeVaultKey(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  const allowed = new Set([
    "EXCHANGE_API_KEY",
    "EXCHANGE_API_SECRET",
    "HL_AGENT_ADDRESS",
    "HL_AGENT_SECRET",
    "EXCHANGE_HMAC_SECRET",
    "EXCHANGE_ED25519_PRIVATE_KEY",
    "DISCORD_WEBHOOK_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "ALERT_WEBHOOK_URL",
    "CONGRESS_RUNNER_URL",
    "CONGRESS_RUNNER_TOKEN"
  ]);

  return normalized && allowed.has(normalized) ? normalized : null;
}

export function sanitizeReason(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  return value.slice(0, 256).replace(/[^\w .:/@-]/g, "");
}

export function normalizeAlertPriority(value: AlertPriority | undefined): AlertPriority {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "CRITICAL"
    ? value
    : "HIGH";
}

export function safeAlertText(
  value: string | undefined,
  fallback: string,
  maxLength: number
): string {
  const text = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return text.slice(0, maxLength).replace(/[^\w .,:/@()[\]#-]/g, "");
}

export async function encryptSecret(secret: string, keyMaterial: string): Promise<JsonRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret)
  );

  return {
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString()
  };
}

export async function safeResponseJson(response: Response): Promise<JsonRecord | null> {
  try {
    const payload = await response.json<unknown>();
    return isGatewayJsonRecord(payload) ? payload : { value: JSON.stringify(payload) };
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function isGatewayJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

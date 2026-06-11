import { SignatureEngine } from "../utils/SignatureEngine";
import type { Env, JsonRecord } from "../types";
import { safeResponseJson } from "./AdminValidation";
import { isJsonRecord } from "./ValueCodecs";

export async function evaluateHyperliquidSecrets(env: Env): Promise<{
  ok: boolean;
  detail: string;
  metadata: JsonRecord;
}> {
  const executionerDiagnostic = await evaluateExecutionerHyperliquidSecrets(env);
  if (executionerDiagnostic) {
    return executionerDiagnostic;
  }

  const [secret, address] = await Promise.all([
    readDiagnosticSecret(env, "HL_AGENT_SECRET"),
    readDiagnosticSecret(env, "HL_AGENT_ADDRESS")
  ]);

  if (!secret.value || !address.value) {
    return {
      ok: false,
      detail:
        "HL_AGENT_SECRET or HL_AGENT_ADDRESS is not available from Workers secrets or the encrypted vault.",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        hasSecret: Boolean(secret.value),
        hasAddress: Boolean(address.value)
      }
    };
  }

  try {
    const derivedAddress = SignatureEngine.preloadHyperliquidAgentSecret(secret.value).address;
    const configuredAddress = address.value.trim().toLowerCase();
    const ok = derivedAddress === configuredAddress;

    return {
      ok,
      detail: ok
        ? "Hyperliquid API agent private key derives the configured agent address."
        : "HL_AGENT_ADDRESS does not match the address derived from HL_AGENT_SECRET.",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        configuredAddress: maskAddress(configuredAddress),
        derivedAddress: maskAddress(derivedAddress)
      }
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "HL_AGENT_SECRET_VALIDATION_FAILED",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source
      }
    };
  }
}

async function decryptDiagnosticSecret(
  encrypted: JsonRecord,
  keyMaterial: string
): Promise<string | null> {
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

async function evaluateExecutionerHyperliquidSecrets(env: Env): Promise<{
  ok: boolean;
  detail: string;
  metadata: JsonRecord;
} | null> {
  if (!env.EXECUTIONER) {
    return null;
  }

  try {
    const response = await env.EXECUTIONER.fetch(
      new Request("https://executioner.internal/diagnostics", {
        headers: { accept: "application/json" }
      })
    );
    const body = await safeResponseJson(response);
    const secretCheck = isJsonRecord(body?.hyperliquidSecrets) ? body.hyperliquidSecrets : null;

    if (!secretCheck) {
      return {
        ok: false,
        detail: `Executioner diagnostics returned HTTP ${response.status} without Hyperliquid secret status.`,
        metadata: {
          source: "EXECUTIONER",
          status: response.status
        }
      };
    }

    const metadata = isJsonRecord(secretCheck.metadata) ? secretCheck.metadata : {};
    return {
      ok: Boolean(secretCheck.ok),
      detail:
        typeof secretCheck.detail === "string"
          ? secretCheck.detail
          : "Executioner Hyperliquid secret diagnostic completed.",
      metadata: {
        ...metadata,
        source: "EXECUTIONER",
        status: response.status
      }
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "EXECUTIONER_DIAGNOSTICS_FAILED",
      metadata: { source: "EXECUTIONER" }
    };
  }
}

async function readDiagnosticSecret(
  env: Env,
  keyName: "HL_AGENT_SECRET" | "HL_AGENT_ADDRESS"
): Promise<{ source: "ENV" | "VAULT" | "MISSING"; value: string | null }> {
  const direct = (env as unknown as Record<string, string | undefined>)[keyName];
  if (direct) {
    return { source: "ENV", value: direct };
  }

  const encryptionSecret = env.VAULT_ENCRYPTION_SECRET ?? env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;
  if (!encryptionSecret) {
    return { source: "MISSING", value: null };
  }

  const encrypted = await env.RISK_VAULT.get<JsonRecord>(`vault:secret:${keyName}`, "json");
  if (!encrypted) {
    return { source: "MISSING", value: null };
  }

  return {
    source: "VAULT",
    value: await decryptDiagnosticSecret(encrypted, encryptionSecret)
  };
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function maskAddress(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

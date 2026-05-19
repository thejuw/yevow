import type { Env, JsonRecord } from "../types";

const secretCache = new Map<string, { value: string | null; expiresAt: number }>();

export async function exchangeSecret(env: Env, keyName: string): Promise<string | undefined> {
  const direct = (env as unknown as Record<string, string | undefined>)[keyName];
  if (direct) {
    return direct;
  }

  const now = Date.now();
  const cached = secretCache.get(keyName);
  if (cached && cached.expiresAt > now) {
    return cached.value ?? undefined;
  }

  const value = await readVaultSecret(env, keyName);
  secretCache.set(keyName, {
    value: value ?? null,
    expiresAt: now + 60_000
  });

  return value ?? undefined;
}

export async function exchangeSecretWithSource(
  env: Env,
  keyName: string
): Promise<{ source: "ENV" | "VAULT" | "MISSING"; value: string | null }> {
  const direct = (env as unknown as Record<string, string | undefined>)[keyName];
  if (direct) {
    return { source: "ENV", value: direct };
  }

  const value = await readVaultSecret(env, keyName);
  return value ? { source: "VAULT", value } : { source: "MISSING", value: null };
}

async function readVaultSecret(env: Env, keyName: string): Promise<string | null> {
  try {
    const encryptionSecret = env.VAULT_ENCRYPTION_SECRET ?? env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;
    if (!encryptionSecret) {
      return null;
    }

    const encrypted = await env.RISK_VAULT.get<JsonRecord>(`vault:secret:${keyName}`, "json");
    if (!encrypted) {
      return null;
    }

    return await decryptSecret(encrypted, encryptionSecret);
  } catch (error) {
    console.error(
      "[Sovereign-Sigma] executioner vault secret lookup failed",
      keyName,
      error instanceof Error ? error.message : error
    );
    return null;
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

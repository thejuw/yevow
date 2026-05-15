type SignatureAlgorithm = "HMAC-SHA256" | "ED25519";

const keyCache = new Map<string, CryptoKey>();

export class SignatureEngine {
  static async sign(input: {
    algorithm: SignatureAlgorithm;
    secret: string;
    payload: string;
  }): Promise<string> {
    if (input.algorithm === "ED25519") {
      const key = await importEd25519Key(input.secret);
      const signature = await crypto.subtle.sign("Ed25519", key, text(input.payload));
      return base64(signature);
    }

    const key = await importHmacKey(input.secret);
    const signature = await crypto.subtle.sign("HMAC", key, text(input.payload));
    return hex(signature);
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cacheKey = `hmac:${await fingerprintSecret(secret)}`;
  const cached = keyCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    text(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  keyCache.set(cacheKey, key);
  return key;
}

async function importEd25519Key(rawBase64: string): Promise<CryptoKey> {
  const cacheKey = `ed25519:${await fingerprintSecret(rawBase64)}`;
  const cached = keyCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const binary = Uint8Array.from(atob(rawBase64), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", binary, "Ed25519", false, ["sign"]);
  keyCache.set(cacheKey, key);
  return key;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function fingerprintSecret(secret: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", text(secret)));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(buffer: ArrayBuffer): string {
  let raw = "";
  for (const byte of new Uint8Array(buffer)) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw);
}

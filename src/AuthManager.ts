export type AdminScope =
  | "READ"
  | "WRITE"
  | "TELEMETRY:READ"
  | "CONFIG:WRITE"
  | "TRADING:WRITE"
  | "VAULT:WRITE"
  | "SECURITY:WRITE"
  | "REPLAY:WRITE"
  | "ALERTS:WRITE"
  | "STRATEGY:WRITE";

export interface AuthClaims {
  [key: string]: unknown;
  sub: string;
  scopes: AdminScope[];
  iat: number;
  exp: number;
  nbf?: number;
  jti: string;
}

const JWT_ALGORITHM = "HS256";
const JWT_TYPE = "JWT";
const TOKEN_TTL_SECONDS = 60 * 60;
const textEncoder = new TextEncoder();

export class AuthManager {
  constructor(
    private readonly jwtSecret: string,
    private readonly adminPassword?: string
  ) {}

  async verifyToken(token: string): Promise<boolean> {
    return (await this.verifyClaims(token)) !== null;
  }

  async verifyClaims(token: string): Promise<AuthClaims | null> {
    try {
      const parts = token.split(".");

      if (parts.length !== 3) {
        return null;
      }

      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      const header = parseJson<{ alg?: string; typ?: string }>(
        decodeBase64UrlToString(encodedHeader)
      );
      const payload = parseJson<Record<string, unknown>>(decodeBase64UrlToString(encodedPayload));

      if (
        !header ||
        header.alg !== JWT_ALGORITHM ||
        header.typ !== JWT_TYPE ||
        !payload ||
        typeof payload.sub !== "string" ||
        !payload.sub
      ) {
        return null;
      }

      const verified = await crypto.subtle.verify(
        "HMAC",
        await this.importKey(["verify"]),
        decodeBase64UrlToBytes(encodedSignature),
        textEncoder.encode(`${encodedHeader}.${encodedPayload}`)
      );

      if (!verified || !isWithinTokenWindow(payload)) {
        return null;
      }

      return {
        ...payload,
        sub: payload.sub,
        scopes: AuthManager.normalizeScopes(payload.scopes ?? payload.scope),
        iat: Number(payload.iat),
        exp: Number(payload.exp),
        nbf: payload.nbf === undefined ? undefined : Number(payload.nbf),
        jti: typeof payload.jti === "string" ? payload.jti : ""
      };
    } catch {
      return null;
    }
  }

  async generateToken(payload: Record<string, unknown>): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const expiresAt = nowSeconds + TOKEN_TTL_SECONDS;
    const header = {
      alg: JWT_ALGORITHM,
      typ: JWT_TYPE
    };
    const claims = {
      ...payload,
      sub: typeof payload.sub === "string" && payload.sub ? payload.sub : "admin",
      scopes: AuthManager.normalizeScopes(payload.scopes ?? payload.scope),
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: expiresAt,
      jti: crypto.randomUUID()
    };
    const encodedHeader = encodeBase64Url(JSON.stringify(header));
    const encodedPayload = encodeBase64Url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.importKey(["sign"]),
      textEncoder.encode(`${encodedHeader}.${encodedPayload}`)
    );

    return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
  }

  async verifyPassword(candidate: string): Promise<boolean> {
    if (!this.adminPassword) {
      return false;
    }

    return constantTimeEqual(candidate, this.adminPassword);
  }

  static hasScope(claims: AuthClaims, requiredScope: AdminScope): boolean {
    const scopes = AuthManager.normalizeScopes(claims.scopes);

    if (scopes.includes("WRITE")) {
      return true;
    }

    if (requiredScope === "READ") {
      return scopes.includes("READ") || scopes.includes("TELEMETRY:READ");
    }

    if (requiredScope === "TELEMETRY:READ") {
      return scopes.includes("TELEMETRY:READ") || scopes.includes("READ");
    }

    return scopes.includes(requiredScope);
  }

  static normalizeScopes(value: unknown): AdminScope[] {
    const rawScopes = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[,\s]+/)
        : [];
    const scopes = new Set<AdminScope>();

    for (const scope of rawScopes) {
      const normalized = String(scope).trim().toUpperCase();

      if (isAdminScope(normalized)) {
        scopes.add(normalized);
      }
    }

    if (scopes.size === 0) {
      scopes.add("READ");
    }

    return [...scopes];
  }

  static tokenTtlSeconds(): number {
    return TOKEN_TTL_SECONDS;
  }

  private importKey(keyUsages: Array<"sign" | "verify">): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      textEncoder.encode(this.jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      keyUsages
    );
  }
}

function isAdminScope(value: string): value is AdminScope {
  return (
    value === "READ" ||
    value === "WRITE" ||
    value === "TELEMETRY:READ" ||
    value === "CONFIG:WRITE" ||
    value === "TRADING:WRITE" ||
    value === "VAULT:WRITE" ||
    value === "SECURITY:WRITE" ||
    value === "REPLAY:WRITE" ||
    value === "ALERTS:WRITE" ||
    value === "STRATEGY:WRITE"
  );
}

function isWithinTokenWindow(payload: Record<string, unknown>): boolean {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  const notBefore = payload.nbf === undefined ? undefined : Number(payload.nbf);

  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return false;
  }

  if (issuedAt > nowSeconds || expiresAt <= nowSeconds) {
    return false;
  }

  if (notBefore !== undefined && (!Number.isFinite(notBefore) || notBefore > nowSeconds)) {
    return false;
  }

  return expiresAt - issuedAt <= TOKEN_TTL_SECONDS;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(left)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}

function encodeBase64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : new Uint8Array(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function decodeBase64UrlToString(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlToBytes(value));
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

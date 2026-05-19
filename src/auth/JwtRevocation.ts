export interface RevocationRecord {
  jti: string;
  revokedAt: string;
  expiresAt: string;
  reason: string;
  revokedBy: string;
}

export interface ActiveTokenRecord {
  jti: string;
  subject: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
}

export class JwtRevocationStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly revokedPrefix = "auth:jti:revoked:"
  ) {}

  async revoke(jti: string, expiresAt: number, reason: string, revokedBy: string): Promise<void> {
    const nowMs = Date.now();
    const expiresAtMs = normalizeEpochMs(expiresAt);
    const ttlSeconds = Math.max(60, Math.ceil((expiresAtMs - nowMs) / 1_000));
    const record: RevocationRecord = {
      jti,
      revokedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      reason,
      revokedBy
    };

    await this.kv.put(`${this.revokedPrefix}${jti}`, JSON.stringify(record), {
      expirationTtl: ttlSeconds
    });
  }

  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) {
      return true;
    }

    return (await this.kv.get(`${this.revokedPrefix}${jti}`)) !== null;
  }

  async listRevoked(limit: number): Promise<RevocationRecord[]> {
    const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), 1_000);
    const listed = await this.kv.list({ prefix: this.revokedPrefix, limit: cappedLimit });
    const records: RevocationRecord[] = [];

    for (const key of listed.keys) {
      const raw = await this.kv.get(key.name);
      const parsed = parseRecord(raw);

      if (isRevocationRecord(parsed)) {
        records.push(parsed);
      }
    }

    return records.sort((left, right) => right.revokedAt.localeCompare(left.revokedAt));
  }
}

export class ActiveTokenStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly activePrefix = "auth:active:"
  ) {}

  async track(record: ActiveTokenRecord): Promise<void> {
    const expiresAtMs = Date.parse(record.expiresAt);
    const ttlSeconds = Math.max(60, Math.ceil((expiresAtMs - Date.now()) / 1_000));
    await this.kv.put(this.key(record.subject, record.jti), JSON.stringify(record), {
      expirationTtl: ttlSeconds
    });
  }

  async listForSubject(subject: string, limit = 1_000): Promise<ActiveTokenRecord[]> {
    const listed = await this.kv.list({
      prefix: `${this.activePrefix}${subject}:`,
      limit: Math.min(Math.max(Math.floor(limit), 1), 1_000)
    });
    const records: ActiveTokenRecord[] = [];

    for (const key of listed.keys) {
      const parsed = parseRecord(await this.kv.get(key.name));

      if (isActiveTokenRecord(parsed)) {
        records.push(parsed);
      }
    }

    return records;
  }

  async remove(subject: string, jti: string): Promise<void> {
    await this.kv.delete(this.key(subject, jti));
  }

  private key(subject: string, jti: string): string {
    return `${this.activePrefix}${subject}:${jti}`;
  }
}

function normalizeEpochMs(value: number): number {
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function parseRecord(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRevocationRecord(value: unknown): value is RevocationRecord {
  return (
    isObject(value) &&
    typeof value.jti === "string" &&
    typeof value.revokedAt === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.reason === "string" &&
    typeof value.revokedBy === "string"
  );
}

function isActiveTokenRecord(value: unknown): value is ActiveTokenRecord {
  return (
    isObject(value) &&
    typeof value.jti === "string" &&
    typeof value.subject === "string" &&
    typeof value.issuedAt === "string" &&
    typeof value.expiresAt === "string" &&
    Array.isArray(value.scopes)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

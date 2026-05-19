export interface AuthContext {
  subject: string;
  scopes: readonly string[];
}

export interface ScopeMatcherOptions {
  migrateLegacyScopes?: boolean;
}

export class MissingScopeError extends Error {
  constructor(readonly missingScopes: readonly string[]) {
    super(`Missing required scope: ${missingScopes.join(", ")}`);
    this.name = "MissingScopeError";
  }
}

const LEGACY_READ_EXPANSION = [
  "auth:read",
  "cascade:read",
  "config:read",
  "cost:read",
  "position:read",
  "replay:read",
  "strategy:read",
  "telemetry:read",
  "vault:read"
] as const;

const LEGACY_WRITE_EXPANSION = [
  ...LEGACY_READ_EXPANSION,
  "alerts:write",
  "auth:revoke",
  "cascade:blackout",
  "cascade:enable",
  "config:strategy:write",
  "config:write",
  "cost:write",
  "maintenance:write",
  "moltworker:write",
  "position:close",
  "replay:run",
  "security:write",
  "strategy:write",
  "system:kill-switch",
  "trading:write",
  "vault:write"
] as const;

const LEGACY_SCOPE_ALIASES: Record<string, readonly string[]> = {
  READ: LEGACY_READ_EXPANSION,
  WRITE: LEGACY_WRITE_EXPANSION,
  "TELEMETRY:READ": ["telemetry:read"],
  "CONFIG:WRITE": ["config:write"],
  "TRADING:WRITE": ["trading:write", "maintenance:write", "position:close"],
  "VAULT:WRITE": ["vault:write"],
  "SECURITY:WRITE": ["security:write", "auth:revoke"],
  "REPLAY:WRITE": ["replay:run"],
  "ALERTS:WRITE": ["alerts:write"],
  "STRATEGY:WRITE": ["strategy:write", "config:strategy:write"]
};

export function normalizeScope(scope: string): string {
  const trimmed = scope.trim();

  if (trimmed.includes(":") && trimmed !== trimmed.toUpperCase()) {
    return trimmed.toLowerCase();
  }

  const upper = trimmed.toUpperCase();
  return LEGACY_SCOPE_ALIASES[upper] ? upper : trimmed.toLowerCase();
}

export function expandLegacyScopes(
  scopes: readonly string[],
  options: ScopeMatcherOptions = {}
): string[] {
  const migrateLegacyScopes = options.migrateLegacyScopes !== false;
  const expanded = new Set<string>();

  for (const rawScope of scopes) {
    const scope = normalizeScope(rawScope);
    expanded.add(scope);

    if (!migrateLegacyScopes) {
      continue;
    }

    const aliases = LEGACY_SCOPE_ALIASES[scope];

    if (!aliases) {
      continue;
    }

    for (const alias of aliases) {
      expanded.add(alias);
    }
  }

  return [...expanded];
}

export function hasScope(
  authContext: AuthContext,
  required: string,
  options: ScopeMatcherOptions = {}
): boolean {
  const requiredScope = normalizeScope(required);
  const scopes = expandLegacyScopes(authContext.scopes, options);

  if (scopes.includes("WRITE")) {
    return options.migrateLegacyScopes === false ? requiredScope === "WRITE" : true;
  }

  return scopes.includes(requiredScope);
}

export function requireScopes(
  authContext: AuthContext,
  required: readonly string[],
  options: ScopeMatcherOptions = {}
): void {
  const missing = required.filter((scope) => !hasScope(authContext, scope, options));

  if (missing.length > 0) {
    throw new MissingScopeError(missing);
  }
}

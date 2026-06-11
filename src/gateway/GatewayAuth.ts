import { AuthManager, type AdminScope } from "../AuthManager";
import { ActiveTokenStore, JwtRevocationStore } from "../auth/JwtRevocation";
import { hasScope } from "../auth/ScopeMatcher";
import type { Logger } from "../Logger";
import type { EdgeTopology, Env } from "../types";
import type { AuthenticatedAdmin } from "./AdminModels";
import { ACTIVE_TOKEN_PREFIX, JWT_REVOCATION_PREFIX } from "./GatewayConstants";
import {
  evaluateRateLimit,
  ipRateLimitKey,
  subjectRateLimitKey
} from "./middleware/RateLimitMiddleware";
import { json, readJsonBody } from "./ResponseHelpers";
import { logSecurityEvent, maskTokenId, sourceIp } from "./SecurityAudit";
import { clampInteger } from "./ValueCodecs";

export async function authenticateAdmin(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  requiredScope: AdminScope
): Promise<AuthenticatedAdmin | Response> {
  const url = new URL(request.url);
  const authManager = createAuthManager(env);

  if (!authManager) {
    logSecurityEvent(
      logger,
      "AUTH_CONFIG_MISSING",
      "Admin JWT secret is not configured",
      request,
      url,
      topology
    );
    return json({ ok: false, error: "Authentication unavailable" }, 503);
  }

  const token = bearerToken(request);

  if (!token) {
    logSecurityEvent(
      logger,
      "ADMIN_AUTH_REJECTED",
      "Rejected admin request without bearer token",
      request,
      url,
      topology,
      { reason: "MISSING_BEARER_TOKEN" }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const claims = await authManager.verifyClaims(token);

  if (!claims) {
    logSecurityEvent(
      logger,
      "ADMIN_AUTH_REJECTED",
      "Rejected admin request with invalid JWT",
      request,
      url,
      topology,
      { reason: "INVALID_JWT" }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  if (
    claims.jti &&
    (await new JwtRevocationStore(authKv(env), JWT_REVOCATION_PREFIX).isRevoked(claims.jti))
  ) {
    logSecurityEvent(
      logger,
      "ADMIN_AUTH_REJECTED",
      "Rejected admin request with revoked JWT",
      request,
      url,
      topology,
      { reason: "JTI_REVOKED", subject: claims.sub }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  if (
    !hasScope({ subject: claims.sub, scopes: claims.scopes }, requiredScope, {
      migrateLegacyScopes: migrateLegacyScopesEnabled(env)
    })
  ) {
    logSecurityEvent(
      logger,
      "ADMIN_SCOPE_REJECTED",
      "Rejected admin request with insufficient scope",
      request,
      url,
      topology,
      {
        reason: "INSUFFICIENT_SCOPE",
        requiredScope,
        subject: claims.sub,
        scopes: claims.scopes
      }
    );
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  return {
    claims,
    subject: claims.sub
  };
}

export async function authenticateIngest(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology
): Promise<true | Response> {
  const url = new URL(request.url);
  const expected = env.INGESTOR_CONTROL_TOKEN;

  if (!expected) {
    logSecurityEvent(
      logger,
      "INGEST_AUTH_CONFIG_MISSING",
      "Rejected ingest request because INGESTOR_CONTROL_TOKEN is not configured",
      request,
      url,
      topology
    );
    return json({ ok: false, error: "Ingest authentication unavailable" }, 503);
  }

  const supplied =
    bearerToken(request) ??
    request.headers.get("x-ingestor-token") ??
    request.headers.get("x-sovereign-ingest-token");

  if (!supplied || !(await constantTimeStringEqual(supplied, expected))) {
    logSecurityEvent(
      logger,
      "INGEST_AUTH_REJECTED",
      "Rejected unauthorized market ingest request",
      request,
      url,
      topology,
      {
        reason: supplied ? "INVALID_TOKEN" : "MISSING_TOKEN",
        sourceHeader: request.headers.get("x-source") ?? null
      }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  return true;
}

export function authKv(env: Env): KVNamespace {
  return env.AUTH_STORE ?? env.CONFIG_STORE;
}

export function createAuthManager(env: Env): AuthManager | null {
  const jwtSecret = env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;

  return jwtSecret ? new AuthManager(jwtSecret, env.ADMIN_PASSWORD) : null;
}

export async function currentLoginLockout(
  request: Request,
  env: Env
): Promise<{
  allowed: false;
  key: string;
  count: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
  locked: true;
} | null> {
  const key = ipRateLimitKey("login:failed", request);
  const raw = await authKv(env).get(key);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { count?: number; lockedUntil?: number };
    const lockedUntil = Number(parsed.lockedUntil);

    if (!Number.isFinite(lockedUntil) || lockedUntil <= Date.now()) {
      return null;
    }

    return {
      allowed: false,
      key,
      count: Number(parsed.count) || 0,
      remaining: 0,
      resetAt: new Date(lockedUntil).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1_000)),
      locked: true
    };
  } catch {
    return null;
  }
}

export async function enforceAdminRateLimit(
  request: Request,
  env: Env,
  auth: AuthenticatedAdmin,
  logger: Logger,
  topology: EdgeTopology
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }

  if (url.pathname === "/admin/system/kill-switch") {
    return null;
  }

  const config = adminRateLimitConfig(url.pathname);
  const decision = await evaluateRateLimit(
    authKv(env),
    subjectRateLimitKey(config.key, auth.subject),
    { windowMs: config.windowMs, maxRequests: config.maxRequests }
  );

  if (decision.allowed) {
    return null;
  }

  logger.warn("ADMIN_RATE_LIMITED", "Admin write endpoint rate-limited", {
    subject: auth.subject,
    endpoint: url.pathname,
    retryAfterSeconds: decision.retryAfterSeconds,
    colo: topology.colo,
    placement: topology.placement,
    sourceIp: sourceIp(request)
  });

  return rateLimitResponse(decision);
}

export async function listRevokedAdminTokens(env: Env, url: URL): Promise<Response> {
  const limit = clampInteger(url.searchParams.get("limit"), 100, 1, 1_000);
  const revoked = await new JwtRevocationStore(authKv(env), JWT_REVOCATION_PREFIX).listRevoked(
    limit
  );
  return json({ ok: true, data: revoked, count: revoked.length });
}

export function rateLimitResponse(decision: {
  retryAfterSeconds: number;
  resetAt: string;
}): Response {
  return json(
    {
      ok: false,
      error: "RATE_LIMITED",
      retryAfterSeconds: decision.retryAfterSeconds,
      resetAt: decision.resetAt
    },
    429,
    { "retry-after": String(decision.retryAfterSeconds) }
  );
}

export function requiredScopeForAdminRequest(request: Request): AdminScope {
  const { pathname } = new URL(request.url);

  if (pathname === "/admin/auth/revoked") {
    return "auth:read";
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (pathname.includes("/config") || pathname.includes("/settings")) {
      return "config:read";
    }
    if (pathname.includes("/history") || pathname.includes("/positions")) {
      return "position:read";
    }
    if (pathname.includes("/replay")) {
      return "replay:read";
    }
    if (pathname.includes("/vault")) {
      return "vault:read";
    }
    if (pathname.includes("/strategy")) {
      return "strategy:read";
    }
    return "telemetry:read";
  }

  if (pathname === "/admin/live-readiness/approve") {
    return "READ";
  }

  if (pathname.includes("/vault")) {
    return "vault:write";
  }
  if (pathname.includes("/auth/")) {
    return "auth:revoke";
  }
  if (pathname.includes("/replay") || pathname.includes("/backtest")) {
    return "replay:run";
  }
  if (pathname.includes("/alerts") || pathname.includes("/settings/notifications")) {
    return "alerts:write";
  }
  if (pathname.includes("/strategy")) {
    return "strategy:write";
  }
  if (pathname.includes("/cascade/positions")) {
    return "position:close";
  }
  if (pathname.includes("/cascade/blackout")) {
    return "cascade:blackout";
  }
  if (
    pathname.includes("/maintenance") ||
    pathname.includes("/moltworker") ||
    pathname.includes("/cascade/")
  ) {
    return "trading:write";
  }

  return "config:write";
}

export async function revokeAdminToken(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const body =
    (await readJsonBody<{
      jti?: string;
      reason?: string;
    }>(request)) ?? {};
  const jti = typeof body.jti === "string" && body.jti.length > 0 ? body.jti : admin.claims.jti;

  if (!jti) {
    return json({ ok: false, error: "JTI_REQUIRED" }, 400);
  }

  const reason = body.reason ?? "admin-request";
  await new JwtRevocationStore(authKv(env), JWT_REVOCATION_PREFIX).revoke(
    jti,
    admin.claims.exp,
    reason,
    admin.subject
  );

  logger.warn("ADMIN_JWT_REVOKED", "Admin JWT JTI was revoked", {
    actor: admin.subject,
    revokedJti: maskTokenId(jti),
    reason,
    colo: topology.colo,
    placement: topology.placement,
    sourceIp: sourceIp(request)
  });

  const ttlSeconds = Math.max(60, admin.claims.exp - Math.floor(Date.now() / 1_000));
  return json({ ok: true, revoked: true, jti: maskTokenId(jti), expiresIn: ttlSeconds });
}

export async function revokeAllTokensForSubject(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const body =
    (await readJsonBody<{
      subject?: string;
      reason?: string;
    }>(request)) ?? {};
  const subject = typeof body.subject === "string" && body.subject.length > 0 ? body.subject : "";

  if (!subject) {
    return json({ ok: false, error: "SUBJECT_REQUIRED" }, 400);
  }

  const activeStore = new ActiveTokenStore(authKv(env), ACTIVE_TOKEN_PREFIX);
  const revocationStore = new JwtRevocationStore(authKv(env), JWT_REVOCATION_PREFIX);
  const activeTokens = await activeStore.listForSubject(subject);
  const reason = body.reason ?? "admin-revoke-all";
  let revokedCount = 0;

  for (const token of activeTokens) {
    await revocationStore.revoke(token.jti, Date.parse(token.expiresAt), reason, admin.subject);
    await activeStore.remove(subject, token.jti);
    revokedCount += 1;
  }

  logger.warn("ADMIN_JWT_REVOKED_FOR_SUBJECT", "Admin revoked all active JWTs for subject", {
    actor: admin.subject,
    subject,
    revokedCount,
    reason,
    colo: topology.colo,
    placement: topology.placement,
    sourceIp: sourceIp(request)
  });

  return json({ ok: true, subject, revokedCount });
}

function adminRateLimitConfig(pathname: string): {
  key: string;
  windowMs: number;
  maxRequests: number;
} {
  if (pathname.startsWith("/admin/auth/revoke")) {
    return { key: "admin:auth-revoke:minute", windowMs: 60_000, maxRequests: 10 };
  }

  if (pathname === "/admin/strategy/mode") {
    return { key: "admin:strategy-mode:minute", windowMs: 60_000, maxRequests: 3 };
  }

  if (pathname.startsWith("/admin/cascade/")) {
    return { key: "admin:cascade:minute", windowMs: 60_000, maxRequests: 10 };
  }

  return { key: "admin:default:minute", windowMs: 60_000, maxRequests: 60 };
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return null;
    }

    const url = new URL(request.url);
    const queryToken = url.searchParams.get("access_token") ?? url.searchParams.get("token");
    return queryToken && queryToken.length > 0 ? queryToken : null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function constantTimeStringEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}

function migrateLegacyScopesEnabled(env: Env): boolean {
  return env.MIGRATE_LEGACY_SCOPES !== "false";
}

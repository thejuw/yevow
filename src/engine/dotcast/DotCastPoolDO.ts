import { impliedProb, previewPayout } from "./Parimutuel";
import {
  buildDotCastAuditWritePlan,
  writeDotCastAuditPlan,
  type DotCastAuditAction,
  type DotCastAuditDb
} from "./DotCastAuditLedger";
import {
  createPoolFromMarket,
  placeEntry,
  type CreatePoolInput,
  type PlaceEntryInput
} from "./PoolLifecycle";
import {
  applyRouterResolution,
  type DotCastResolutionIntakeResult,
  lockSnapshotIfNeeded,
  normalizePoolSnapshot,
  settlePoolSnapshot,
  voidPoolSnapshot
} from "./PoolSettlement";
import {
  fetchDotCastRouterResolution,
  type DotCastRouterResolutionFetchResult
} from "./RouterResolutionClient";
import { applyUsdcPoolTerminalSettlement, D1DotCastUsdcPoolFundingStore } from "./UsdcPoolFunding";
import type {
  DotCastEntry,
  DotCastLiveOddsSnapshot,
  DotCastPoolSnapshot,
  DotCastResolutionOutcome,
  DotCastRouterResolution,
  DotCastVenue,
  DotCastVoidReason,
  Side,
  StakeBalance
} from "./types";
import type { Env } from "../../types";

const POOL_STATE_KEY = "dotcast:pool-state:v1";
const DEFAULT_POINTS_BALANCE = 10_000;
const DEFAULT_ROUTER_RESOLUTION_POLL_MS = 60_000;

interface CreatePoolPayload extends Omit<CreatePoolInput, "now"> {
  now?: string;
}

interface PlaceEntryPayload {
  userId?: unknown;
  side?: unknown;
  amount?: unknown;
  now?: string;
  entryId?: string;
  settlementFunding?: {
    rail?: unknown;
    lockId?: unknown;
    reservedAmount?: unknown;
  };
}

interface LockPoolPayload {
  now?: string;
}

interface SettlePoolPayload {
  outcome?: unknown;
  now?: string;
}

interface VoidPoolPayload {
  reason?: unknown;
  now?: string;
}

interface RouterResolutionPayload {
  marketId?: unknown;
  outcome?: unknown;
  resolvedAt?: unknown;
  fetchedAt?: unknown;
  stale?: unknown;
  source?: unknown;
  now?: string;
  maxGraceMs?: unknown;
}

interface PollResolutionPayload {
  now?: string;
}

export class DotCastPool {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/create") {
        return await this.create(request);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return await this.read();
      }

      if (request.method === "GET" && url.pathname === "/odds") {
        return await this.readOdds(request);
      }

      if (request.method === "POST" && url.pathname === "/entries") {
        return await this.placeEntry(request);
      }

      if (request.method === "POST" && url.pathname === "/lock") {
        return await this.lock(request);
      }

      if (request.method === "POST" && url.pathname === "/settle") {
        return await this.settle(request);
      }

      if (request.method === "POST" && url.pathname === "/resolution") {
        return await this.applyResolution(request);
      }

      if (request.method === "POST" && url.pathname === "/poll-resolution") {
        return await this.pollResolution(request);
      }

      if (request.method === "POST" && url.pathname === "/void") {
        return await this.void(request);
      }

      return jsonResponse({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ ok: false, error: errorMessage(error) }, 400);
    }
  }

  private async create(request: Request): Promise<Response> {
    const payload = await readJson<CreatePoolPayload>(request);
    const existing = await this.readSnapshot();
    const now = payload.now ?? new Date().toISOString();

    if (existing) {
      if (existing.pool.marketId !== payload.market.id) {
        return jsonResponse({ ok: false, error: "pool object already initialized" }, 409);
      }

      return jsonResponse({ ok: true, created: false, ...decorateSnapshot(existing) });
    }

    const pool = createPoolFromMarket({
      ...payload,
      id: payload.id,
      now
    });
    const snapshot: DotCastPoolSnapshot = {
      pool,
      entries: [],
      balances: {},
      houseLedger: [],
      settlement: null,
      voidReason: null,
      lastResolution: null,
      updatedAt: now
    };

    await this.persistSnapshot(snapshot, now);
    const responseBody = { ok: true, created: true, ...decorateSnapshot(snapshot) };
    await this.audit("create", responseBody);
    return jsonResponse(responseBody, 201);
  }

  private async read(): Promise<Response> {
    const snapshot = await this.requireSnapshot();
    const lockedSnapshot = await this.lockIfNeeded(snapshot, new Date().toISOString());
    return jsonResponse({ ok: true, ...decorateSnapshot(lockedSnapshot) });
  }

  private async readOdds(request: Request): Promise<Response> {
    const snapshot = await this.requireSnapshot();
    const lockedSnapshot = await this.lockIfNeeded(snapshot, new Date().toISOString());
    const amount = parseOptionalAmount(new URL(request.url).searchParams.get("amount"));

    return jsonResponse({
      ok: true,
      liveOdds: buildLiveOdds(lockedSnapshot, amount),
      ...decorateSnapshot(lockedSnapshot)
    });
  }

  private async placeEntry(request: Request): Promise<Response> {
    const payload = await readJson<PlaceEntryPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const userId = parseUserId(payload.userId);
    const side = parseSide(payload.side);
    const amount = parseAmount(payload.amount);
    const settlementFunding = parseSettlementFunding(
      payload.settlementFunding,
      snapshot.pool.unit,
      amount
    );
    const existingEntry = payload.entryId
      ? snapshot.entries.find((entry) => entry.id === payload.entryId)
      : null;

    if (existingEntry) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        entry: existingEntry,
        balance: snapshot.balances[userId] ?? null,
        ...decorateSnapshot(snapshot)
      });
    }

    const currentBalance = snapshot.balances[userId] ?? seedBalance(userId, snapshot.pool.unit);
    const balance = settlementFunding
      ? {
          ...currentBalance,
          available: currentBalance.available + settlementFunding.reservedAmount
        }
      : currentBalance;
    const input: PlaceEntryInput = {
      pool: snapshot.pool,
      balance,
      userId,
      side,
      amount,
      now,
      entryId: payload.entryId ?? randomId("entry")
    };
    const result = placeEntry(input);
    const placedSnapshot: DotCastPoolSnapshot = {
      ...snapshot,
      pool: result.pool,
      entries: [...snapshot.entries, result.entry],
      balances: {
        ...snapshot.balances,
        [userId]: result.balance
      },
      updatedAt: now
    };
    const nextSnapshot = lockSnapshotIfNeeded(placedSnapshot, now);

    await this.persistSnapshot(nextSnapshot, now);
    const responseBody = {
      ok: true,
      entry: result.entry,
      balance: result.balance,
      ...(settlementFunding
        ? {
            settlementFunding: {
              rail: settlementFunding.rail,
              lockId: settlementFunding.lockId,
              reservedAmount: settlementFunding.reservedAmount
            }
          }
        : {}),
      ...decorateSnapshot(nextSnapshot)
    };
    await this.audit("entry", responseBody);

    if (nextSnapshot.pool.status !== result.pool.status) {
      await this.audit("lock", { ok: true, ...decorateSnapshot(nextSnapshot) });
    }

    return jsonResponse(responseBody, 201);
  }

  private async lock(request: Request): Promise<Response> {
    const payload = await readJson<LockPoolPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const nextSnapshot = await this.lockIfNeeded(snapshot, now);

    if (nextSnapshot.pool.status !== "locked" && nextSnapshot.pool.status !== "voided") {
      return jsonResponse(
        { ok: false, error: "pool is not ready to lock", ...decorateSnapshot(nextSnapshot) },
        409
      );
    }

    return jsonResponse({ ok: true, ...decorateSnapshot(nextSnapshot) });
  }

  private async settle(request: Request): Promise<Response> {
    const payload = await readJson<SettlePoolPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const outcome = parseOutcome(payload.outcome);
    const nextSnapshot = settlePoolSnapshot(snapshot, outcome, now);

    await this.persistSnapshot(nextSnapshot, now);
    const responseBody = { ok: true, ...decorateSnapshot(nextSnapshot) };
    await this.audit("settle", responseBody);
    return jsonResponse(responseBody);
  }

  private async applyResolution(request: Request): Promise<Response> {
    const payload = await readJson<RouterResolutionPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const result = applyRouterResolution({
      snapshot,
      resolution: parseRouterResolution(payload, now),
      now,
      maxGraceMs: parseOptionalNonNegativeInteger(payload.maxGraceMs, "maxGraceMs")
    });

    await this.persistSnapshot(result.snapshot, now);
    const responseBody = {
      ok: true,
      action: result.action,
      reason: result.reason,
      ...decorateSnapshot(result.snapshot)
    };
    await this.audit("resolution", responseBody);
    return jsonResponse(responseBody);
  }

  private async pollResolution(request: Request): Promise<Response> {
    const payload = await readJson<PollResolutionPayload>(request);
    const now = payload.now ?? new Date().toISOString();
    const result = await this.pollRouterResolution(now);

    if (!result.ok) {
      return jsonResponse(result, typeof result.status === "number" ? result.status : 500);
    }

    return jsonResponse(result);
  }

  private async void(request: Request): Promise<Response> {
    const payload = await readJson<VoidPoolPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const reason = parseVoidReason(payload.reason);
    const nextSnapshot = voidPoolSnapshot(snapshot, reason, now);

    await this.persistSnapshot(nextSnapshot, now);
    const responseBody = { ok: true, ...decorateSnapshot(nextSnapshot) };
    await this.audit("void", responseBody);
    return jsonResponse(responseBody);
  }

  async alarm(): Promise<void> {
    await this.pollRouterResolution(new Date().toISOString());
  }

  private async lockIfNeeded(
    snapshot: DotCastPoolSnapshot,
    now: string
  ): Promise<DotCastPoolSnapshot> {
    const nextSnapshot = lockSnapshotIfNeeded(snapshot, now);

    if (nextSnapshot === snapshot) {
      return snapshot;
    }

    await this.persistSnapshot(nextSnapshot, now);
    await this.audit("lock", { ok: true, ...decorateSnapshot(nextSnapshot) });
    return nextSnapshot;
  }

  private async pollRouterResolution(now: string): Promise<Record<string, unknown>> {
    const snapshot = await this.requireSnapshot();
    const lockedSnapshot = await this.lockIfNeeded(snapshot, now);

    if (lockedSnapshot.pool.status === "settled" || lockedSnapshot.pool.status === "voided") {
      await this.reconcileResolutionAlarm(lockedSnapshot, now);
      const result = {
        ok: true,
        poll: { kind: "ignored" },
        action: "ignored",
        reason: "TERMINAL_POOL",
        ...decorateSnapshot(lockedSnapshot)
      };
      await this.audit("poll", result);
      return result;
    }

    if (lockedSnapshot.pool.status !== "locked" && lockedSnapshot.pool.status !== "resolving") {
      await this.reconcileResolutionAlarm(lockedSnapshot, now);
      const result = {
        ok: true,
        poll: { kind: "held" },
        action: "held",
        reason: "POOL_NOT_LOCKED",
        ...decorateSnapshot(lockedSnapshot)
      };
      await this.audit("poll", result);
      return result;
    }

    let fetchResult: DotCastRouterResolutionFetchResult;
    try {
      fetchResult = await fetchDotCastRouterResolution(this.env, lockedSnapshot.pool.marketId, now);
    } catch (error) {
      await this.reconcileResolutionAlarm(lockedSnapshot, now);
      const result = {
        ok: false,
        status: 502,
        error: errorMessage(error),
        poll: { kind: "error" },
        ...decorateSnapshot(lockedSnapshot)
      };
      await this.audit("poll", result);
      return result;
    }

    if (fetchResult.kind === "not_configured") {
      await this.reconcileResolutionAlarm(lockedSnapshot, now);
      const result = {
        ok: false,
        status: 503,
        error: fetchResult.error,
        poll: { kind: "not_configured" },
        ...decorateSnapshot(lockedSnapshot)
      };
      await this.audit("poll", result);
      return result;
    }

    const result: DotCastResolutionIntakeResult = applyRouterResolution({
      snapshot: lockedSnapshot,
      resolution: fetchResult.resolution,
      now,
      maxGraceMs: parseEnvNonNegativeInteger(
        this.env.DOTCAST_ROUTER_RESOLUTION_MAX_GRACE_MS,
        "DOTCAST_ROUTER_RESOLUTION_MAX_GRACE_MS"
      )
    });
    await this.persistSnapshot(result.snapshot, now);

    const responseBody = {
      ok: true,
      poll: { kind: fetchResult.kind },
      action: result.action,
      reason: result.reason,
      ...decorateSnapshot(result.snapshot)
    };
    await this.audit("poll", responseBody);
    return responseBody;
  }

  private async requireSnapshot(): Promise<DotCastPoolSnapshot> {
    const snapshot = await this.readSnapshot();

    if (!snapshot) {
      throw new Error("pool has not been created");
    }

    return snapshot;
  }

  private async readSnapshot(): Promise<DotCastPoolSnapshot | null> {
    const snapshot = (await this.state.storage.get<DotCastPoolSnapshot>(POOL_STATE_KEY)) ?? null;
    return snapshot ? normalizePoolSnapshot(snapshot) : null;
  }

  private async writeSnapshot(snapshot: DotCastPoolSnapshot): Promise<void> {
    await this.state.storage.put(POOL_STATE_KEY, snapshot);
  }

  private async persistSnapshot(snapshot: DotCastPoolSnapshot, now: string): Promise<void> {
    await this.writeSnapshot(snapshot);
    await this.reconcileResolutionAlarm(snapshot, now);
    await this.reconcileUsdcPoolFunding(snapshot, now);
  }

  private async reconcileResolutionAlarm(
    snapshot: DotCastPoolSnapshot,
    now: string
  ): Promise<void> {
    if (snapshot.pool.status === "locked" || snapshot.pool.status === "resolving") {
      await this.state.storage.setAlarm(
        Date.parse(now) + resolvePollIntervalMs(this.env.DOTCAST_ROUTER_RESOLUTION_POLL_MS)
      );
      return;
    }

    await this.state.storage.deleteAlarm();
  }

  private async audit(action: DotCastAuditAction, body: Record<string, unknown>): Promise<void> {
    const db = (this.env as Partial<Env>).TRADING_DB as DotCastAuditDb | undefined;

    if (!db) {
      return;
    }

    const plan = buildDotCastAuditWritePlan(action, body);

    if (
      plan.events.length === 0 &&
      plan.balanceLedger.length === 0 &&
      plan.houseLedger.length === 0
    ) {
      return;
    }

    try {
      await writeDotCastAuditPlan(db, plan);
    } catch (error) {
      console.error(
        "[dotCast] failed to write audit ledger",
        error instanceof Error ? error.message : error
      );
    }
  }

  private async reconcileUsdcPoolFunding(
    snapshot: DotCastPoolSnapshot,
    now: string
  ): Promise<void> {
    if (
      snapshot.pool.unit !== "usdc" ||
      (snapshot.pool.status !== "settled" && snapshot.pool.status !== "voided")
    ) {
      return;
    }

    if (!this.env.TRADING_DB) {
      throw new Error("E6 USDC pool funding database is not configured");
    }

    await applyUsdcPoolTerminalSettlement(
      new D1DotCastUsdcPoolFundingStore(this.env.TRADING_DB),
      this.env,
      { snapshot, now }
    );
  }
}

function decorateSnapshot(snapshot: DotCastPoolSnapshot) {
  return {
    snapshot,
    odds: impliedProb(snapshot.pool.pools),
    previews: {
      yes: previewForSide(snapshot, "yes"),
      no: previewForSide(snapshot, "no")
    }
  };
}

function buildLiveOdds(
  snapshot: DotCastPoolSnapshot,
  hypotheticalAmount: number | null = null
): DotCastLiveOddsSnapshot {
  return {
    poolId: snapshot.pool.id,
    marketId: snapshot.pool.marketId,
    status: snapshot.pool.status,
    unit: snapshot.pool.unit,
    odds: impliedProb(snapshot.pool.pools),
    pools: snapshot.pool.pools,
    totalStaked: snapshot.pool.pools.yes + snapshot.pool.pools.no,
    entryCount: snapshot.entries.length,
    updatedAt: snapshot.updatedAt,
    previews: {
      yes: previewForSide(snapshot, "yes"),
      no: previewForSide(snapshot, "no")
    },
    hypothetical:
      hypotheticalAmount !== null
        ? {
            amount: hypotheticalAmount,
            payout: {
              yes: previewPayout(
                snapshot.pool.pools,
                "yes",
                hypotheticalAmount,
                snapshot.pool.rake
              ),
              no: previewPayout(snapshot.pool.pools, "no", hypotheticalAmount, snapshot.pool.rake)
            }
          }
        : null
  };
}

function previewForSide(snapshot: DotCastPoolSnapshot, side: Side): Record<string, number> {
  return {
    "10": previewPayout(snapshot.pool.pools, side, 10, snapshot.pool.rake),
    "25": previewPayout(snapshot.pool.pools, side, 25, snapshot.pool.rake),
    "100": previewPayout(snapshot.pool.pools, side, 100, snapshot.pool.rake)
  };
}

function seedBalance(userId: string, unit: StakeBalance["unit"]): StakeBalance {
  return {
    userId,
    unit,
    available: unit === "points" ? DEFAULT_POINTS_BALANCE : 0,
    locked: 0
  };
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("request body must be JSON");
  }
}

function parseUserId(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error("userId is required");
}

function parseSide(value: unknown): Side {
  if (value === "yes" || value === "no") {
    return value;
  }

  throw new Error("side must be yes or no");
}

function parseSettlementFunding(
  value: PlaceEntryPayload["settlementFunding"],
  unit: StakeBalance["unit"],
  amount: number
): { rail: string; lockId: string; reservedAmount: number } | null {
  if (unit !== "usdc") {
    return null;
  }

  if (!value || typeof value !== "object") {
    throw new Error("usdc entries require an E6 settlement funding reservation");
  }

  const rail = parseRequiredString(value.rail, "settlementFunding.rail");
  const lockId = parseRequiredString(value.lockId, "settlementFunding.lockId");
  const reservedAmount = parseAmount(value.reservedAmount);

  if (rail !== "solana-usdc-devnet") {
    throw new Error("usdc entries require a solana-usdc-devnet funding rail");
  }

  if (reservedAmount !== amount) {
    throw new Error("settlement funding reservation must equal entry amount");
  }

  return { rail, lockId, reservedAmount };
}

function parseOutcome(value: unknown): Side | "invalid" {
  if (value === "yes" || value === "no" || value === "invalid") {
    return value;
  }

  throw new Error("outcome must be yes, no, or invalid");
}

function parseResolutionOutcome(value: unknown): DotCastResolutionOutcome {
  if (value === "yes" || value === "no" || value === "invalid" || value === "pending") {
    return value;
  }

  throw new Error("resolution outcome must be yes, no, invalid, or pending");
}

function parseRouterResolution(
  payload: RouterResolutionPayload,
  fallbackFetchedAt: string
): DotCastRouterResolution {
  return {
    marketId: parseRequiredString(payload.marketId, "resolution.marketId"),
    outcome: parseResolutionOutcome(payload.outcome),
    resolvedAt: parseNullableString(payload.resolvedAt, "resolution.resolvedAt"),
    fetchedAt: parseOptionalString(payload.fetchedAt, "resolution.fetchedAt") ?? fallbackFetchedAt,
    stale: typeof payload.stale === "boolean" ? payload.stale : false,
    source: parseOptionalVenue(payload.source)
  };
}

function parseRequiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`${label} is required`);
}

function parseOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`${label} must be a non-empty string`);
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return parseOptionalString(value, label) ?? null;
}

function parseOptionalVenue(value: unknown): DotCastVenue | undefined {
  if (value === "kalshi" || value === "polymarket" || value === "dotcast" || value === "unknown") {
    return value;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  throw new Error("resolution.source must be a supported venue");
}

function parseOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return value;
}

function parseEnvNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function resolvePollIntervalMs(value: string | undefined): number {
  const parsed = parseEnvNonNegativeInteger(value, "DOTCAST_ROUTER_RESOLUTION_POLL_MS");
  return parsed ?? DEFAULT_ROUTER_RESOLUTION_POLL_MS;
}

function parseVoidReason(value: unknown): DotCastVoidReason {
  if (
    value === "UNDER_LIQUIDITY" ||
    value === "ONE_SIDED_POOL" ||
    value === "NO_WINNING_ENTRIES" ||
    value === "INVALID_RESOLUTION" ||
    value === "GRACE_TIMEOUT" ||
    value === "SOURCE_CANCELLED" ||
    value === "ADMIN_VOID"
  ) {
    return value;
  }

  throw new Error("void reason is required");
}

function parseOptionalAmount(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("amount must be a positive integer minor-unit amount");
  }

  return parsed;
}

function parseAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("amount must be a positive integer minor-unit amount");
  }

  return value;
}

function randomId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid request";
}

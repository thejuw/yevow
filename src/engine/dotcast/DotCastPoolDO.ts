import { impliedProb, previewPayout } from "./Parimutuel";
import {
  createPoolFromMarket,
  placeEntry,
  type CreatePoolInput,
  type PlaceEntryInput
} from "./PoolLifecycle";
import {
  lockSnapshotIfNeeded,
  normalizePoolSnapshot,
  settlePoolSnapshot,
  voidPoolSnapshot
} from "./PoolSettlement";
import type {
  DotCastVoidReason,
  DotCastEntry,
  DotCastPoolSnapshot,
  Side,
  StakeBalance
} from "./types";
import type { Env } from "../../types";

const POOL_STATE_KEY = "dotcast:pool-state:v1";
const DEFAULT_POINTS_BALANCE = 10_000;

interface CreatePoolPayload extends Omit<CreatePoolInput, "now"> {
  now?: string;
}

interface PlaceEntryPayload {
  userId?: unknown;
  side?: unknown;
  amount?: unknown;
  now?: string;
  entryId?: string;
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

      if (request.method === "POST" && url.pathname === "/entries") {
        return await this.placeEntry(request);
      }

      if (request.method === "POST" && url.pathname === "/lock") {
        return await this.lock(request);
      }

      if (request.method === "POST" && url.pathname === "/settle") {
        return await this.settle(request);
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
      updatedAt: now
    };

    await this.writeSnapshot(snapshot);
    return jsonResponse({ ok: true, created: true, ...decorateSnapshot(snapshot) }, 201);
  }

  private async read(): Promise<Response> {
    const snapshot = await this.requireSnapshot();
    const lockedSnapshot = await this.lockIfNeeded(snapshot, new Date().toISOString());
    return jsonResponse({ ok: true, ...decorateSnapshot(lockedSnapshot) });
  }

  private async placeEntry(request: Request): Promise<Response> {
    const payload = await readJson<PlaceEntryPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const userId = parseUserId(payload.userId);
    const side = parseSide(payload.side);
    const amount = parseAmount(payload.amount);
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

    const balance = snapshot.balances[userId] ?? seedBalance(userId, snapshot.pool.unit);
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

    await this.writeSnapshot(nextSnapshot);
    return jsonResponse(
      { ok: true, entry: result.entry, balance: result.balance, ...decorateSnapshot(nextSnapshot) },
      201
    );
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

    await this.writeSnapshot(nextSnapshot);
    return jsonResponse({ ok: true, ...decorateSnapshot(nextSnapshot) });
  }

  private async void(request: Request): Promise<Response> {
    const payload = await readJson<VoidPoolPayload>(request);
    const snapshot = await this.requireSnapshot();
    const now = payload.now ?? new Date().toISOString();
    const reason = parseVoidReason(payload.reason);
    const nextSnapshot = voidPoolSnapshot(snapshot, reason, now);

    await this.writeSnapshot(nextSnapshot);
    return jsonResponse({ ok: true, ...decorateSnapshot(nextSnapshot) });
  }

  private async lockIfNeeded(
    snapshot: DotCastPoolSnapshot,
    now: string
  ): Promise<DotCastPoolSnapshot> {
    const nextSnapshot = lockSnapshotIfNeeded(snapshot, now);

    if (nextSnapshot === snapshot) {
      return snapshot;
    }

    await this.writeSnapshot(nextSnapshot);
    return nextSnapshot;
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

function parseOutcome(value: unknown): Side | "invalid" {
  if (value === "yes" || value === "no" || value === "invalid") {
    return value;
  }

  throw new Error("outcome must be yes, no, or invalid");
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

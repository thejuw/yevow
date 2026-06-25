import { settleParimutuel, type SettlementEntry } from "./Parimutuel";
import { lockPoolIfNeeded, transitionPool } from "./PoolLifecycle";
import type {
  DotCastEntry,
  DotCastPool,
  DotCastPoolSnapshot,
  DotCastRouterResolution,
  DotCastSettlementRecord,
  DotCastVoidReason,
  HouseLedgerEntry,
  Side,
  StakeBalance
} from "./types";

export type DotCastResolutionIntakeAction = "settled" | "voided" | "held" | "ignored";

export type DotCastResolutionIntakeReason =
  | "DEFINITIVE_OUTCOME"
  | "INVALID_RESOLUTION"
  | "PENDING_RESOLUTION"
  | "STALE_RESOLUTION"
  | "GRACE_TIMEOUT"
  | "LOCK_VOID"
  | "POOL_NOT_LOCKED"
  | "TERMINAL_POOL";

export interface DotCastResolutionIntakeInput {
  snapshot: DotCastPoolSnapshot;
  resolution: DotCastRouterResolution;
  now: string;
  maxGraceMs?: number;
}

export interface DotCastResolutionIntakeResult {
  action: DotCastResolutionIntakeAction;
  reason: DotCastResolutionIntakeReason;
  snapshot: DotCastPoolSnapshot;
}

const DEFAULT_RESOLUTION_MAX_GRACE_MS = 24 * 60 * 60 * 1000;

export function normalizePoolSnapshot(snapshot: DotCastPoolSnapshot): DotCastPoolSnapshot {
  return {
    ...snapshot,
    houseLedger: snapshot.houseLedger ?? [],
    settlement: snapshot.settlement ?? null,
    voidReason: snapshot.voidReason ?? null,
    lastResolution: snapshot.lastResolution ?? null
  };
}

export function lockSnapshotIfNeeded(
  snapshot: DotCastPoolSnapshot,
  now: string
): DotCastPoolSnapshot {
  const normalized = normalizePoolSnapshot(snapshot);
  const pool = lockPoolIfNeeded(normalized.pool, now);

  if (pool === normalized.pool) {
    return normalized;
  }

  const voidReason = lockVoidReason(pool);
  if (voidReason) {
    return voidPoolSnapshot(
      {
        ...normalized,
        pool: normalized.pool
      },
      voidReason,
      now
    );
  }

  return {
    ...normalized,
    pool,
    updatedAt: now
  };
}

export function settlePoolSnapshot(
  snapshot: DotCastPoolSnapshot,
  outcome: Side | "invalid",
  now: string
): DotCastPoolSnapshot {
  const normalized = normalizePoolSnapshot(snapshot);

  if (normalized.pool.status === "settled" || normalized.pool.status === "voided") {
    return normalized;
  }

  if (outcome === "invalid") {
    return voidPoolSnapshot(normalized, "INVALID_RESOLUTION", now, "invalid");
  }

  if (normalized.pool.status !== "locked" && normalized.pool.status !== "resolving") {
    throw new Error("settlement requires a locked or resolving pool");
  }

  const resolvingPool =
    normalized.pool.status === "locked"
      ? transitionPool(normalized.pool, "resolving", now)
      : normalized.pool;
  const settlement = settleParimutuel(
    normalized.entries.map(toSettlementEntry),
    outcome,
    resolvingPool.rake
  );

  if (settlement.kind === "void_required") {
    return voidPoolSnapshot(
      {
        ...normalized,
        pool: resolvingPool
      },
      "NO_WINNING_ENTRIES",
      now
    );
  }

  const payoutsByEntry = new Map(settlement.payouts.map((payout) => [payout.entryId, payout]));
  const balances = { ...normalized.balances };
  const entries = normalized.entries.map((entry) => {
    const payout = payoutsByEntry.get(entry.id);

    if (!payout) {
      throw new Error(`settlement payout missing for entry ${entry.id}`);
    }

    if (entry.funding === "user") {
      const balance = requireBalance(balances, entry);
      balances[entry.userId] = {
        ...balance,
        available: balance.available + payout.payout,
        locked: balance.locked - entry.amount
      };
      assertNonNegativeBalance(balances[entry.userId], entry.userId);
    } else if (payout.payout > 0) {
      const balance = balances[entry.userId] ?? emptyBalance(entry.userId, normalized.pool.unit);
      balances[entry.userId] = {
        ...balance,
        available: balance.available + payout.payout
      };
    }

    return {
      ...entry,
      payout: payout.payout,
      refunded: false
    };
  });
  const payoutTotal = settlement.payouts.reduce((sum, payout) => sum + payout.payout, 0);
  const record: DotCastSettlementRecord = {
    id: `settlement:${normalized.pool.id}:${outcome}`,
    poolId: normalized.pool.id,
    outcome,
    totalStaked: settlement.totalStaked,
    payoutTotal,
    rakeAmount: settlement.rakeAmount,
    createdAt: now
  };
  const houseLedger =
    settlement.rakeAmount > 0
      ? [...normalized.houseLedger, houseRakeEntry(normalized.pool, settlement.rakeAmount, now)]
      : normalized.houseLedger;

  return {
    pool: transitionPool(resolvingPool, "settled", now, outcome),
    entries,
    balances,
    houseLedger,
    settlement: record,
    voidReason: null,
    lastResolution: normalized.lastResolution,
    updatedAt: now
  };
}

export function applyRouterResolution(
  input: DotCastResolutionIntakeInput
): DotCastResolutionIntakeResult {
  const nowMs = assertIso(input.now, "now");
  assertIso(input.resolution.fetchedAt, "resolution.fetchedAt");

  if (input.resolution.resolvedAt !== null) {
    assertIso(input.resolution.resolvedAt, "resolution.resolvedAt");
  }

  const maxGraceMs = input.maxGraceMs ?? DEFAULT_RESOLUTION_MAX_GRACE_MS;
  if (!Number.isSafeInteger(maxGraceMs) || maxGraceMs < 0) {
    throw new RangeError("maxGraceMs must be a non-negative safe integer");
  }

  const normalized = withResolution(
    normalizePoolSnapshot(input.snapshot),
    input.resolution,
    input.now
  );

  if (normalized.pool.marketId !== input.resolution.marketId) {
    throw new Error("resolution marketId does not match pool marketId");
  }

  if (normalized.pool.status === "settled" || normalized.pool.status === "voided") {
    return {
      action: "ignored",
      reason: "TERMINAL_POOL",
      snapshot: normalized
    };
  }

  const lockedSnapshot = lockSnapshotIfNeeded(normalized, input.now);

  if (lockedSnapshot.pool.status === "voided") {
    return {
      action: "voided",
      reason: "LOCK_VOID",
      snapshot: lockedSnapshot
    };
  }

  if (lockedSnapshot.pool.status !== "locked" && lockedSnapshot.pool.status !== "resolving") {
    return {
      action: "held",
      reason: "POOL_NOT_LOCKED",
      snapshot: lockedSnapshot
    };
  }

  if (input.resolution.stale) {
    if (isPastResolutionGrace(lockedSnapshot.pool, nowMs, maxGraceMs)) {
      return {
        action: "voided",
        reason: "GRACE_TIMEOUT",
        snapshot: voidPoolSnapshot(lockedSnapshot, "GRACE_TIMEOUT", input.now)
      };
    }

    return {
      action: "held",
      reason: "STALE_RESOLUTION",
      snapshot: lockedSnapshot
    };
  }

  if (input.resolution.outcome === "pending") {
    if (isPastResolutionGrace(lockedSnapshot.pool, nowMs, maxGraceMs)) {
      return {
        action: "voided",
        reason: "GRACE_TIMEOUT",
        snapshot: voidPoolSnapshot(lockedSnapshot, "GRACE_TIMEOUT", input.now)
      };
    }

    return {
      action: "held",
      reason: "PENDING_RESOLUTION",
      snapshot: lockedSnapshot
    };
  }

  if (input.resolution.outcome === "invalid") {
    return {
      action: "voided",
      reason: "INVALID_RESOLUTION",
      snapshot: settlePoolSnapshot(lockedSnapshot, "invalid", input.now)
    };
  }

  const settled = settlePoolSnapshot(lockedSnapshot, input.resolution.outcome, input.now);
  return {
    action: settled.pool.status === "voided" ? "voided" : "settled",
    reason: "DEFINITIVE_OUTCOME",
    snapshot: settled
  };
}

export function voidPoolSnapshot(
  snapshot: DotCastPoolSnapshot,
  reason: DotCastVoidReason,
  now: string,
  outcome: Side | "invalid" | null = snapshot.pool.outcome
): DotCastPoolSnapshot {
  const normalized = normalizePoolSnapshot(snapshot);

  if (normalized.pool.status === "voided") {
    return normalized;
  }

  if (normalized.pool.status === "settled") {
    throw new Error("settled pools cannot be voided");
  }

  const balances = { ...normalized.balances };
  const entries = normalized.entries.map((entry) => {
    if (entry.refunded) {
      return entry;
    }

    if (entry.funding === "user") {
      const balance = requireBalance(balances, entry);
      balances[entry.userId] = {
        ...balance,
        available: balance.available + entry.amount,
        locked: balance.locked - entry.amount
      };
      assertNonNegativeBalance(balances[entry.userId], entry.userId);
    }

    return {
      ...entry,
      payout: null,
      refunded: true
    };
  });

  return {
    ...normalized,
    pool: transitionPool(normalized.pool, "voided", now, outcome),
    entries,
    balances,
    settlement: null,
    voidReason: reason,
    updatedAt: now
  };
}

export function lockVoidReason(pool: DotCastPool): DotCastVoidReason | null {
  const totalStaked = pool.pools.yes + pool.pools.no;

  if (totalStaked < pool.minLiquidity) {
    return "UNDER_LIQUIDITY";
  }

  if (pool.pools.yes === 0 || pool.pools.no === 0) {
    return "ONE_SIDED_POOL";
  }

  return null;
}

function withResolution(
  snapshot: DotCastPoolSnapshot,
  resolution: DotCastRouterResolution,
  now: string
): DotCastPoolSnapshot {
  return {
    ...snapshot,
    lastResolution: resolution,
    updatedAt: now
  };
}

function isPastResolutionGrace(pool: DotCastPool, nowMs: number, maxGraceMs: number): boolean {
  if (!pool.expectedResolveAt) {
    return false;
  }

  const expectedMs = assertIso(pool.expectedResolveAt, "expectedResolveAt");
  return nowMs > expectedMs + maxGraceMs;
}

function toSettlementEntry(entry: DotCastEntry): SettlementEntry {
  return {
    id: entry.id,
    side: entry.side,
    amount: entry.amount,
    placedAt: entry.placedAt
  };
}

function requireBalance(balances: Record<string, StakeBalance>, entry: DotCastEntry): StakeBalance {
  const balance = balances[entry.userId];

  if (!balance) {
    throw new Error(`stake balance missing for entry user ${entry.userId}`);
  }

  if (balance.locked < entry.amount) {
    throw new Error(`locked balance below entry amount for user ${entry.userId}`);
  }

  return balance;
}

function emptyBalance(userId: string, unit: StakeBalance["unit"]): StakeBalance {
  return {
    userId,
    unit,
    available: 0,
    locked: 0
  };
}

function assertNonNegativeBalance(balance: StakeBalance, userId: string): void {
  if (balance.available < 0 || balance.locked < 0) {
    throw new Error(`negative stake balance for user ${userId}`);
  }
}

function houseRakeEntry(pool: DotCastPool, amount: number, now: string): HouseLedgerEntry {
  return {
    id: `house:rake:${pool.id}:${Date.parse(now)}`,
    poolId: pool.id,
    unit: pool.unit,
    amount,
    reason: "rake",
    createdAt: now
  };
}

function assertIso(value: string, label: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }

  return parsed;
}

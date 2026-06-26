import {
  readSolanaUsdcSettlementRailStatus,
  type DotCastSettlementRailEnv
} from "./SolanaUsdcSettlementRail";
import type {
  DotCastPoolSnapshot,
  DotCastSettlementBalance,
  DotCastSettlementRailStatus,
  DotCastUsdcPoolFundingEvent,
  DotCastUsdcPoolFundingEventType,
  DotCastUsdcPoolFundingLock,
  DotCastUsdcPoolFundingLockStatus
} from "./types";

export interface DotCastUsdcPoolFundingEnv extends DotCastSettlementRailEnv {
  DOTCAST_USDC_POOLS_ENABLED?: string;
}

export interface DotCastUsdcPoolFundingStatus {
  enabled: boolean;
  ready: boolean;
  rail: DotCastSettlementRailStatus;
  guards: string[];
}

export interface DotCastUsdcPoolFundingStore {
  getBalance(userId: string): Promise<DotCastSettlementBalance | null>;
  saveBalance(balance: DotCastSettlementBalance): Promise<void>;
  getPoolFundingLock(lockId: string): Promise<DotCastUsdcPoolFundingLock | null>;
  insertPoolFundingLock(lock: DotCastUsdcPoolFundingLock): Promise<void>;
  updatePoolFundingLock(lock: DotCastUsdcPoolFundingLock): Promise<void>;
  appendPoolFundingEvent(event: DotCastUsdcPoolFundingEvent): Promise<void>;
}

export interface ReserveUsdcPoolEntryInput {
  poolId: string;
  entryId: string;
  userId: string;
  amount: number;
  now?: string;
}

export interface ReleaseUsdcPoolEntryReservationInput {
  poolId: string;
  entryId: string;
  userId: string;
  reason: string;
  now?: string;
}

export interface ApplyUsdcPoolTerminalSettlementInput {
  snapshot: DotCastPoolSnapshot;
  now?: string;
}

export class DotCastUsdcPoolFundingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastUsdcPoolFundingError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastUsdcPoolFundingStore implements DotCastUsdcPoolFundingStore {
  constructor(private readonly db: D1Database) {}

  async getBalance(userId: string): Promise<DotCastSettlementBalance | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, available_usdc, pending_deposit_usdc, pending_withdrawal_usdc,
                locked_pool_usdc, updated_at
         FROM dotcast_settlement_balances
         WHERE user_id = ?`
      )
      .bind(userId)
      .first<Record<string, unknown>>();

    return row ? balanceFromRow(row) : null;
  }

  async saveBalance(balance: DotCastSettlementBalance): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_settlement_balances (
           user_id, available_usdc, pending_deposit_usdc, pending_withdrawal_usdc,
           locked_pool_usdc, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           available_usdc = excluded.available_usdc,
           pending_deposit_usdc = excluded.pending_deposit_usdc,
           pending_withdrawal_usdc = excluded.pending_withdrawal_usdc,
           locked_pool_usdc = excluded.locked_pool_usdc,
           updated_at = excluded.updated_at`
      )
      .bind(
        balance.userId,
        balance.availableUsdc,
        balance.pendingDepositUsdc,
        balance.pendingWithdrawalUsdc,
        balance.lockedPoolUsdc,
        balance.updatedAt
      )
      .run();
  }

  async getPoolFundingLock(lockId: string): Promise<DotCastUsdcPoolFundingLock | null> {
    const row = await this.db
      .prepare(
        `SELECT lock_id, pool_id, entry_id, user_id, amount, status, payout, created_at,
                updated_at, event_json
         FROM dotcast_usdc_pool_locks
         WHERE lock_id = ?`
      )
      .bind(lockId)
      .first<Record<string, unknown>>();

    return row ? poolFundingLockFromRow(row) : null;
  }

  async insertPoolFundingLock(lock: DotCastUsdcPoolFundingLock): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_usdc_pool_locks (
           lock_id, pool_id, entry_id, user_id, amount, status, payout, created_at, updated_at,
           event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...poolFundingLockParams(lock))
      .run();
  }

  async updatePoolFundingLock(lock: DotCastUsdcPoolFundingLock): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dotcast_usdc_pool_locks
         SET status = ?, payout = ?, updated_at = ?, event_json = ?
         WHERE lock_id = ?`
      )
      .bind(lock.status, lock.payout, lock.updatedAt, JSON.stringify(lock.eventJson), lock.lockId)
      .run();
  }

  async appendPoolFundingEvent(event: DotCastUsdcPoolFundingEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_usdc_pool_events (
           event_id, lock_id, pool_id, entry_id, user_id, event_type, amount, payout, status,
           event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.lockId,
        event.poolId,
        event.entryId,
        event.userId,
        event.eventType,
        event.amount,
        event.payout,
        event.status,
        JSON.stringify(event.eventJson),
        event.createdAt
      )
      .run();
  }
}

export function readUsdcPoolFundingStatus(
  env: DotCastUsdcPoolFundingEnv
): DotCastUsdcPoolFundingStatus {
  const rail = readSolanaUsdcSettlementRailStatus(env);
  const enabled = env.DOTCAST_USDC_POOLS_ENABLED === "true";
  const guards = [...rail.guards];

  if (!enabled) {
    guards.push("usdc pools disabled");
  }

  if (!rail.ready) {
    guards.push("settlement rail not ready");
  }

  return {
    enabled,
    ready: enabled && rail.ready,
    rail,
    guards
  };
}

export async function reserveUsdcPoolEntry(
  store: DotCastUsdcPoolFundingStore,
  env: DotCastUsdcPoolFundingEnv,
  input: ReserveUsdcPoolEntryInput
): Promise<{
  status: "locked";
  idempotent: boolean;
  lock: DotCastUsdcPoolFundingLock;
  balance: DotCastSettlementBalance;
  funding: DotCastUsdcPoolFundingStatus;
}> {
  const funding = assertUsdcPoolFundingReady(env);
  const now = input.now ?? new Date().toISOString();
  const poolId = requireText(input.poolId, "poolId");
  const entryId = requireText(input.entryId, "entryId");
  const userId = requireText(input.userId, "userId");
  assertPositiveAmount(input.amount, "amount");

  const lockId = poolFundingLockId(poolId, entryId);
  const existing = await store.getPoolFundingLock(lockId);
  if (existing) {
    if (existing.userId !== userId || existing.amount !== input.amount) {
      throw new DotCastUsdcPoolFundingError(
        "USDC_POOL_LOCK_CONFLICT",
        "USDC pool funding lock already belongs to a different entry",
        409
      );
    }

    return {
      status: "locked",
      idempotent: true,
      lock: existing,
      balance: await readPoolFundingBalance(store, userId, now),
      funding
    };
  }

  const balance = await readPoolFundingBalance(store, userId, now);
  if (balance.availableUsdc < input.amount) {
    throw new DotCastUsdcPoolFundingError(
      "INSUFFICIENT_USDC_BALANCE",
      "available USDC balance is insufficient for this pool entry",
      409
    );
  }

  const nextBalance = {
    ...balance,
    availableUsdc: balance.availableUsdc - input.amount,
    lockedPoolUsdc: balance.lockedPoolUsdc + input.amount,
    updatedAt: now
  };
  const lock: DotCastUsdcPoolFundingLock = {
    lockId,
    poolId,
    entryId,
    userId,
    amount: input.amount,
    status: "locked",
    payout: null,
    createdAt: now,
    updatedAt: now,
    eventJson: {
      source: "dotcast-e6-usdc-pool-funding",
      rail: funding.rail.network
    }
  };

  await store.insertPoolFundingLock(lock);
  await store.saveBalance(nextBalance);
  await store.appendPoolFundingEvent(poolFundingEvent(lock, "POOL_ENTRY_RESERVED", now));

  return {
    status: "locked",
    idempotent: false,
    lock,
    balance: nextBalance,
    funding
  };
}

export async function releaseUsdcPoolEntryReservation(
  store: DotCastUsdcPoolFundingStore,
  env: DotCastUsdcPoolFundingEnv,
  input: ReleaseUsdcPoolEntryReservationInput
): Promise<{
  status: "released";
  idempotent: boolean;
  lock: DotCastUsdcPoolFundingLock;
  balance: DotCastSettlementBalance;
  funding: DotCastUsdcPoolFundingStatus;
}> {
  const funding = assertUsdcPoolFundingReady(env);
  const now = input.now ?? new Date().toISOString();
  const poolId = requireText(input.poolId, "poolId");
  const entryId = requireText(input.entryId, "entryId");
  const userId = requireText(input.userId, "userId");
  const lock = await requirePoolFundingLock(store, poolId, entryId);

  if (lock.userId !== userId) {
    throw new DotCastUsdcPoolFundingError(
      "USDC_POOL_LOCK_CONFLICT",
      "USDC pool funding lock user does not match release user",
      409
    );
  }

  if (lock.status !== "locked") {
    return {
      status: "released",
      idempotent: true,
      lock,
      balance: await readPoolFundingBalance(store, userId, now),
      funding
    };
  }

  const balance = await readPoolFundingBalance(store, userId, now);
  const nextBalance = {
    ...balance,
    availableUsdc: balance.availableUsdc + lock.amount,
    lockedPoolUsdc: Math.max(0, balance.lockedPoolUsdc - lock.amount),
    updatedAt: now
  };
  const released = {
    ...lock,
    status: "released" as const,
    updatedAt: now,
    eventJson: {
      ...lock.eventJson,
      releasedAt: now,
      releaseReason: input.reason
    }
  };

  await store.updatePoolFundingLock(released);
  await store.saveBalance(nextBalance);
  await store.appendPoolFundingEvent(poolFundingEvent(released, "POOL_ENTRY_RELEASED", now));

  return {
    status: "released",
    idempotent: false,
    lock: released,
    balance: nextBalance,
    funding
  };
}

export async function applyUsdcPoolTerminalSettlement(
  store: DotCastUsdcPoolFundingStore,
  env: DotCastUsdcPoolFundingEnv,
  input: ApplyUsdcPoolTerminalSettlementInput
): Promise<{
  applied: number;
  idempotent: number;
  funding: DotCastUsdcPoolFundingStatus;
}> {
  const funding = assertUsdcPoolFundingReady(env);
  const snapshot = input.snapshot;
  const now = input.now ?? snapshot.updatedAt ?? new Date().toISOString();

  if (snapshot.pool.unit !== "usdc") {
    return { applied: 0, idempotent: 0, funding };
  }

  if (snapshot.pool.status !== "settled" && snapshot.pool.status !== "voided") {
    return { applied: 0, idempotent: 0, funding };
  }

  let applied = 0;
  let idempotent = 0;

  for (const entry of snapshot.entries) {
    if (entry.funding !== "user") {
      continue;
    }

    const lock = await requirePoolFundingLock(store, snapshot.pool.id, entry.id);
    if (lock.status !== "locked") {
      idempotent += 1;
      continue;
    }

    const payout = entry.refunded ? entry.amount : (entry.payout ?? 0);
    const status: DotCastUsdcPoolFundingLockStatus = entry.refunded ? "refunded" : "settled";
    const eventType: DotCastUsdcPoolFundingEventType = entry.refunded
      ? "POOL_ENTRY_REFUNDED"
      : "POOL_ENTRY_SETTLED";
    const balance = await readPoolFundingBalance(store, entry.userId, now);
    const nextBalance = {
      ...balance,
      availableUsdc: balance.availableUsdc + payout,
      lockedPoolUsdc: Math.max(0, balance.lockedPoolUsdc - entry.amount),
      updatedAt: now
    };
    const finalized = {
      ...lock,
      status,
      payout,
      updatedAt: now,
      eventJson: {
        ...lock.eventJson,
        finalizedAt: now,
        poolStatus: snapshot.pool.status,
        outcome: snapshot.pool.outcome
      }
    };

    await store.updatePoolFundingLock(finalized);
    await store.saveBalance(nextBalance);
    await store.appendPoolFundingEvent(poolFundingEvent(finalized, eventType, now));
    applied += 1;
  }

  return { applied, idempotent, funding };
}

export function poolFundingLockId(poolId: string, entryId: string): string {
  return `dotcast:e6:pool-lock:${poolId}:${entryId}`;
}

function assertUsdcPoolFundingReady(env: DotCastUsdcPoolFundingEnv): DotCastUsdcPoolFundingStatus {
  const funding = readUsdcPoolFundingStatus(env);

  if (!funding.enabled) {
    throw new DotCastUsdcPoolFundingError(
      "USDC_POOLS_DISABLED",
      "USDC pools are disabled until the E6 pool funding rail is enabled",
      503
    );
  }

  if (!funding.rail.ready) {
    throw new DotCastUsdcPoolFundingError(
      "USDC_POOL_FUNDING_NOT_READY",
      funding.guards[0] ?? "USDC pool funding is not ready",
      503
    );
  }

  return funding;
}

async function readPoolFundingBalance(
  store: DotCastUsdcPoolFundingStore,
  userId: string,
  now: string
): Promise<DotCastSettlementBalance> {
  return (
    (await store.getBalance(userId)) ?? {
      userId,
      availableUsdc: 0,
      pendingDepositUsdc: 0,
      pendingWithdrawalUsdc: 0,
      lockedPoolUsdc: 0,
      updatedAt: now
    }
  );
}

async function requirePoolFundingLock(
  store: DotCastUsdcPoolFundingStore,
  poolId: string,
  entryId: string
): Promise<DotCastUsdcPoolFundingLock> {
  const lock = await store.getPoolFundingLock(poolFundingLockId(poolId, entryId));

  if (!lock) {
    throw new DotCastUsdcPoolFundingError(
      "USDC_POOL_LOCK_NOT_FOUND",
      "USDC pool funding lock was not found for terminal settlement",
      409
    );
  }

  return lock;
}

function poolFundingEvent(
  lock: DotCastUsdcPoolFundingLock,
  eventType: DotCastUsdcPoolFundingEventType,
  createdAt: string
): DotCastUsdcPoolFundingEvent {
  return {
    eventId: `${lock.lockId}:${eventType.toLowerCase()}`,
    lockId: lock.lockId,
    poolId: lock.poolId,
    entryId: lock.entryId,
    userId: lock.userId,
    eventType,
    amount: lock.amount,
    payout: lock.payout,
    status: lock.status,
    eventJson: lock.eventJson,
    createdAt
  };
}

function balanceFromRow(row: Record<string, unknown>): DotCastSettlementBalance {
  return {
    userId: String(row.user_id),
    availableUsdc: Number(row.available_usdc ?? 0),
    pendingDepositUsdc: Number(row.pending_deposit_usdc ?? 0),
    pendingWithdrawalUsdc: Number(row.pending_withdrawal_usdc ?? 0),
    lockedPoolUsdc: Number(row.locked_pool_usdc ?? 0),
    updatedAt: String(row.updated_at)
  };
}

function poolFundingLockFromRow(row: Record<string, unknown>): DotCastUsdcPoolFundingLock {
  return {
    lockId: String(row.lock_id),
    poolId: String(row.pool_id),
    entryId: String(row.entry_id),
    userId: String(row.user_id),
    amount: Number(row.amount ?? 0),
    status: parseLockStatus(row.status),
    payout: row.payout === null || row.payout === undefined ? null : Number(row.payout),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    eventJson: parseJsonObject(row.event_json)
  };
}

function parseLockStatus(value: unknown): DotCastUsdcPoolFundingLockStatus {
  if (value === "released" || value === "settled" || value === "refunded") {
    return value;
  }

  return "locked";
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function poolFundingLockParams(lock: DotCastUsdcPoolFundingLock): unknown[] {
  return [
    lock.lockId,
    lock.poolId,
    lock.entryId,
    lock.userId,
    lock.amount,
    lock.status,
    lock.payout,
    lock.createdAt,
    lock.updatedAt,
    JSON.stringify(lock.eventJson)
  ];
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastUsdcPoolFundingError(
    "INVALID_USDC_POOL_FUNDING_INPUT",
    `${label} is required`,
    400
  );
}

function assertPositiveAmount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DotCastUsdcPoolFundingError(
      "INVALID_USDC_POOL_FUNDING_AMOUNT",
      `${label} must be a positive integer minor-unit amount`,
      400
    );
  }
}

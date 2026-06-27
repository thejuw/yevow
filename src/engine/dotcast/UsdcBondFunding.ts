import { readUsdcPoolFundingStatus, type DotCastUsdcPoolFundingEnv } from "./UsdcPoolFunding";
import type {
  DotCastSettlementBalance,
  DotCastUsdcBondEvent,
  DotCastUsdcBondEventType,
  DotCastUsdcBondLock,
  DotCastUsdcBondLockStatus,
  DotCastUsdcBondPurpose
} from "./types";

export interface DotCastUsdcBondFundingStore {
  getBalance(userId: string): Promise<DotCastSettlementBalance | null>;
  saveBalance(balance: DotCastSettlementBalance): Promise<void>;
  getBondLock(lockId: string): Promise<DotCastUsdcBondLock | null>;
  insertBondLock(lock: DotCastUsdcBondLock): Promise<void>;
  updateBondLock(lock: DotCastUsdcBondLock): Promise<void>;
  appendBondEvent(event: DotCastUsdcBondEvent): Promise<void>;
}

export interface ReserveUsdcBondInput {
  lockId: string;
  purpose: DotCastUsdcBondPurpose;
  ownerId: string;
  amount: number;
  routeId?: string | null;
  poolId?: string | null;
  panelId?: string | null;
  assignmentId?: string | null;
  challengeId?: string | null;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface SettleUsdcBondInput {
  lockId: string;
  action: "release" | "slash";
  reason: string;
  creditMinorUnits?: number;
  metadata?: Record<string, unknown>;
  now?: string;
  allowMissing?: boolean;
}

export class DotCastUsdcBondFundingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastUsdcBondFundingError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastUsdcBondFundingStore implements DotCastUsdcBondFundingStore {
  constructor(private readonly db: D1Database) {}

  async getBalance(userId: string): Promise<DotCastSettlementBalance | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, available_usdc, pending_deposit_usdc, pending_withdrawal_usdc,
                locked_pool_usdc, locked_bond_usdc, updated_at
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
           locked_pool_usdc, locked_bond_usdc, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           available_usdc = excluded.available_usdc,
           pending_deposit_usdc = excluded.pending_deposit_usdc,
           pending_withdrawal_usdc = excluded.pending_withdrawal_usdc,
           locked_pool_usdc = excluded.locked_pool_usdc,
           locked_bond_usdc = excluded.locked_bond_usdc,
           updated_at = excluded.updated_at`
      )
      .bind(
        balance.userId,
        balance.availableUsdc,
        balance.pendingDepositUsdc,
        balance.pendingWithdrawalUsdc,
        balance.lockedPoolUsdc,
        balance.lockedBondUsdc,
        balance.updatedAt
      )
      .run();
  }

  async getBondLock(lockId: string): Promise<DotCastUsdcBondLock | null> {
    const row = await this.db
      .prepare(
        `SELECT lock_id, purpose, owner_id, route_id, pool_id, panel_id, assignment_id,
                challenge_id, amount, status, credit, created_at, updated_at, event_json
         FROM dotcast_usdc_bond_locks
         WHERE lock_id = ?`
      )
      .bind(lockId)
      .first<Record<string, unknown>>();

    return row ? bondLockFromRow(row) : null;
  }

  async insertBondLock(lock: DotCastUsdcBondLock): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_usdc_bond_locks (
           lock_id, purpose, owner_id, route_id, pool_id, panel_id, assignment_id, challenge_id,
           amount, status, credit, created_at, updated_at, event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...bondLockParams(lock))
      .run();
  }

  async updateBondLock(lock: DotCastUsdcBondLock): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dotcast_usdc_bond_locks
         SET status = ?, credit = ?, updated_at = ?, event_json = ?
         WHERE lock_id = ?`
      )
      .bind(lock.status, lock.credit, lock.updatedAt, JSON.stringify(lock.eventJson), lock.lockId)
      .run();
  }

  async appendBondEvent(event: DotCastUsdcBondEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_usdc_bond_events (
           event_id, lock_id, purpose, owner_id, route_id, pool_id, panel_id, assignment_id,
           challenge_id, event_type, amount, credit, status, reason, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.lockId,
        event.purpose,
        event.ownerId,
        event.routeId,
        event.poolId,
        event.panelId,
        event.assignmentId,
        event.challengeId,
        event.eventType,
        event.amount,
        event.credit,
        event.status,
        event.reason,
        JSON.stringify(event.eventJson),
        event.createdAt
      )
      .run();
  }
}

export async function reserveUsdcBond(
  store: DotCastUsdcBondFundingStore,
  env: DotCastUsdcPoolFundingEnv,
  input: ReserveUsdcBondInput
): Promise<{
  status: "locked";
  idempotent: boolean;
  lock: DotCastUsdcBondLock;
  balance: DotCastSettlementBalance;
}> {
  assertBondFundingReady(env);
  const now = input.now ?? new Date().toISOString();
  const lockId = requireText(input.lockId, "lockId");
  const ownerId = requireText(input.ownerId, "ownerId");
  assertPositiveAmount(input.amount, "amount");

  const existing = await store.getBondLock(lockId);
  if (existing) {
    if (
      existing.ownerId !== ownerId ||
      existing.purpose !== input.purpose ||
      existing.amount !== input.amount
    ) {
      throw new DotCastUsdcBondFundingError(
        "USDC_BOND_LOCK_CONFLICT",
        "USDC bond lock already belongs to a different owner or amount",
        409
      );
    }

    if (existing.status !== "locked") {
      throw new DotCastUsdcBondFundingError(
        "USDC_BOND_LOCK_FINALIZED",
        "USDC bond lock has already been finalized",
        409
      );
    }

    return {
      status: "locked",
      idempotent: true,
      lock: existing,
      balance: await readBondBalance(store, ownerId, now)
    };
  }

  const balance = await readBondBalance(store, ownerId, now);
  if (balance.availableUsdc < input.amount) {
    throw new DotCastUsdcBondFundingError(
      "INSUFFICIENT_USDC_BOND_BALANCE",
      "available USDC balance is insufficient for this E13 bond",
      409
    );
  }

  const nextBalance = {
    ...balance,
    availableUsdc: balance.availableUsdc - input.amount,
    lockedBondUsdc: balance.lockedBondUsdc + input.amount,
    updatedAt: now
  };
  const lock: DotCastUsdcBondLock = {
    lockId,
    purpose: input.purpose,
    ownerId,
    routeId: input.routeId ?? null,
    poolId: input.poolId ?? null,
    panelId: input.panelId ?? null,
    assignmentId: input.assignmentId ?? null,
    challengeId: input.challengeId ?? null,
    amount: input.amount,
    status: "locked",
    credit: 0,
    createdAt: now,
    updatedAt: now,
    eventJson: {
      source: "dotcast-e13-usdc-bond-funding",
      metadata: input.metadata ?? {}
    }
  };

  await store.insertBondLock(lock);
  await store.saveBalance(nextBalance);
  await store.appendBondEvent(bondEvent(lock, "BOND_LOCKED", null, now));

  return {
    status: "locked",
    idempotent: false,
    lock,
    balance: nextBalance
  };
}

export async function settleUsdcBond(
  store: DotCastUsdcBondFundingStore,
  env: DotCastUsdcPoolFundingEnv,
  input: SettleUsdcBondInput
): Promise<{
  status: DotCastUsdcBondLockStatus | "missing";
  idempotent: boolean;
  lock: DotCastUsdcBondLock | null;
  balance: DotCastSettlementBalance | null;
}> {
  assertBondFundingReady(env);
  const now = input.now ?? new Date().toISOString();
  const lockId = requireText(input.lockId, "lockId");
  const lock = await store.getBondLock(lockId);

  if (!lock) {
    if (input.allowMissing) {
      return { status: "missing", idempotent: true, lock: null, balance: null };
    }

    throw new DotCastUsdcBondFundingError(
      "USDC_BOND_LOCK_NOT_FOUND",
      "USDC bond lock was not found for E13 settlement",
      409
    );
  }

  const nextStatus: DotCastUsdcBondLockStatus = input.action === "release" ? "released" : "slashed";
  if (lock.status !== "locked") {
    return {
      status: lock.status,
      idempotent: lock.status === nextStatus,
      lock,
      balance: await readBondBalance(store, lock.ownerId, now)
    };
  }

  const extraCredit = input.creditMinorUnits ?? 0;
  assertNonNegativeAmount(extraCredit, "creditMinorUnits");
  const credit = input.action === "release" ? lock.amount + extraCredit : 0;
  const balance = await readBondBalance(store, lock.ownerId, now);
  const nextBalance = {
    ...balance,
    availableUsdc: balance.availableUsdc + credit,
    lockedBondUsdc: Math.max(0, balance.lockedBondUsdc - lock.amount),
    updatedAt: now
  };
  const finalized: DotCastUsdcBondLock = {
    ...lock,
    status: nextStatus,
    credit,
    updatedAt: now,
    eventJson: {
      ...lock.eventJson,
      finalizedAt: now,
      finalAction: input.action,
      reason: input.reason,
      metadata: input.metadata ?? {}
    }
  };

  await store.updateBondLock(finalized);
  await store.saveBalance(nextBalance);
  await store.appendBondEvent(
    bondEvent(
      finalized,
      input.action === "release" ? "BOND_RELEASED" : "BOND_SLASHED",
      input.reason,
      now
    )
  );

  return {
    status: finalized.status,
    idempotent: false,
    lock: finalized,
    balance: nextBalance
  };
}

export function usdcBondLockId(prefix: string, id: string): string {
  return `dotcast:e13:usdc-bond:${prefix}:${id}`;
}

function assertBondFundingReady(env: DotCastUsdcPoolFundingEnv): void {
  const funding = readUsdcPoolFundingStatus(env);

  if (!funding.ready) {
    throw new DotCastUsdcBondFundingError(
      "USDC_BOND_FUNDING_NOT_READY",
      funding.guards[0] ?? "E13 USDC bond funding is not ready",
      503
    );
  }
}

async function readBondBalance(
  store: DotCastUsdcBondFundingStore,
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
      lockedBondUsdc: 0,
      updatedAt: now
    }
  );
}

function bondEvent(
  lock: DotCastUsdcBondLock,
  eventType: DotCastUsdcBondEventType,
  reason: string | null,
  createdAt: string
): DotCastUsdcBondEvent {
  return {
    eventId: `${lock.lockId}:${eventType.toLowerCase()}`,
    lockId: lock.lockId,
    purpose: lock.purpose,
    ownerId: lock.ownerId,
    routeId: lock.routeId,
    poolId: lock.poolId,
    panelId: lock.panelId,
    assignmentId: lock.assignmentId,
    challengeId: lock.challengeId,
    eventType,
    amount: lock.amount,
    credit: lock.credit,
    status: lock.status,
    reason,
    eventJson: lock.eventJson,
    createdAt
  };
}

function bondLockFromRow(row: Record<string, unknown>): DotCastUsdcBondLock {
  return {
    lockId: String(row.lock_id),
    purpose: parsePurpose(row.purpose),
    ownerId: String(row.owner_id),
    routeId: nullableText(row.route_id),
    poolId: nullableText(row.pool_id),
    panelId: nullableText(row.panel_id),
    assignmentId: nullableText(row.assignment_id),
    challengeId: nullableText(row.challenge_id),
    amount: Number(row.amount ?? 0),
    status: parseStatus(row.status),
    credit: Number(row.credit ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    eventJson: parseJsonObject(row.event_json)
  };
}

function bondLockParams(lock: DotCastUsdcBondLock): unknown[] {
  return [
    lock.lockId,
    lock.purpose,
    lock.ownerId,
    lock.routeId,
    lock.poolId,
    lock.panelId,
    lock.assignmentId,
    lock.challengeId,
    lock.amount,
    lock.status,
    lock.credit,
    lock.createdAt,
    lock.updatedAt,
    JSON.stringify(lock.eventJson)
  ];
}

function balanceFromRow(row: Record<string, unknown>): DotCastSettlementBalance {
  return {
    userId: String(row.user_id),
    availableUsdc: Number(row.available_usdc ?? 0),
    pendingDepositUsdc: Number(row.pending_deposit_usdc ?? 0),
    pendingWithdrawalUsdc: Number(row.pending_withdrawal_usdc ?? 0),
    lockedPoolUsdc: Number(row.locked_pool_usdc ?? 0),
    lockedBondUsdc: Number(row.locked_bond_usdc ?? 0),
    updatedAt: String(row.updated_at)
  };
}

function parsePurpose(value: unknown): DotCastUsdcBondPurpose {
  return value === "resolver_assignment" ? "resolver_assignment" : "resolution_challenge";
}

function parseStatus(value: unknown): DotCastUsdcBondLockStatus {
  if (value === "released" || value === "slashed") {
    return value;
  }

  return "locked";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastUsdcBondFundingError("INVALID_USDC_BOND_INPUT", `${label} is required`, 400);
}

function assertPositiveAmount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DotCastUsdcBondFundingError(
      "INVALID_USDC_BOND_AMOUNT",
      `${label} must be a positive integer minor-unit amount`,
      400
    );
  }
}

function assertNonNegativeAmount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DotCastUsdcBondFundingError(
      "INVALID_USDC_BOND_AMOUNT",
      `${label} must be a non-negative integer minor-unit amount`,
      400
    );
  }
}

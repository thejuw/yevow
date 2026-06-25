import type {
  DotCastEntry,
  DotCastPoolSnapshot,
  HouseLedgerEntry,
  Side,
  StakeBalance,
  StakeUnit
} from "./types";

export type DotCastAuditAction =
  | "create"
  | "entry"
  | "lock"
  | "settle"
  | "resolution"
  | "poll"
  | "void";

export type DotCastAuditEventType =
  | "POOL_CREATED"
  | "ENTRY_PLACED"
  | "POOL_LOCKED"
  | "POOL_VOIDED"
  | "POOL_SETTLED"
  | "RESOLUTION_APPLIED"
  | "ROUTER_POLL"
  | "RAKE_RECORDED";

export type DotCastBalanceLedgerReason =
  | "ENTRY_LOCK"
  | "SETTLEMENT_PAYOUT"
  | "VOID_REFUND"
  | "HOUSE_ENTRY_PAYOUT"
  | "ADJUSTMENT";

export type DotCastHouseLedgerReason = "RAKE" | "HOUSE_REFUND" | "HOUSE_STAKE";

export interface DotCastAuditDb {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface DotCastAuditContext {
  correlationId?: string;
}

export interface DotCastAuditEventRecord {
  eventId: string;
  poolId: string;
  marketId: string | null;
  eventType: DotCastAuditEventType;
  userId: string | null;
  entryId: string | null;
  unit: StakeUnit | null;
  amount: number | null;
  side: Side | null;
  status: string | null;
  reason: string | null;
  correlationId: string | null;
  eventJson: unknown;
  createdAt: string;
}

export interface DotCastBalanceLedgerRecord {
  ledgerId: string;
  poolId: string;
  entryId: string | null;
  userId: string;
  unit: StakeUnit;
  deltaAvailable: number;
  deltaLocked: number;
  availableAfter: number;
  lockedAfter: number;
  reason: DotCastBalanceLedgerReason;
  eventJson: unknown;
  createdAt: string;
}

export interface DotCastHouseLedgerRecord {
  ledgerId: string;
  poolId: string;
  unit: StakeUnit;
  amount: number;
  reason: DotCastHouseLedgerReason;
  eventJson: unknown;
  createdAt: string;
}

export interface DotCastAuditWritePlan {
  events: DotCastAuditEventRecord[];
  balanceLedger: DotCastBalanceLedgerRecord[];
  houseLedger: DotCastHouseLedgerRecord[];
}

export function buildDotCastAuditWritePlan(
  action: DotCastAuditAction,
  responseBody: unknown,
  context: DotCastAuditContext = {}
): DotCastAuditWritePlan {
  const body = asRecord(responseBody);
  const snapshot = asSnapshot(body?.snapshot);

  if (!body || !snapshot) {
    return emptyPlan();
  }

  if ((action === "create" && body.created === false) || (action === "entry" && body.duplicate)) {
    return emptyPlan();
  }

  const eventType = primaryEventType(action, snapshot);

  if (!eventType) {
    return emptyPlan();
  }

  const primaryEvent = buildPrimaryEvent(action, eventType, body, snapshot, context);
  const events = [primaryEvent];
  const balanceLedger: DotCastBalanceLedgerRecord[] = [];
  const houseLedger: DotCastHouseLedgerRecord[] = [];

  if (action === "entry") {
    const entry = asEntry(body.entry);
    const balance = asBalance(body.balance) ?? (entry ? snapshot.balances[entry.userId] : null);

    if (entry && balance && entry.funding === "user") {
      balanceLedger.push({
        ledgerId: `dotcast:balance:entry:${entry.id}`,
        poolId: entry.poolId,
        entryId: entry.id,
        userId: entry.userId,
        unit: balance.unit,
        deltaAvailable: -entry.amount,
        deltaLocked: entry.amount,
        availableAfter: balance.available,
        lockedAfter: balance.locked,
        reason: "ENTRY_LOCK",
        eventJson: { action, entry, balance },
        createdAt: entry.placedAt
      });
    }
  }

  if (shouldRecordTerminalBalances(action, body, snapshot)) {
    balanceLedger.push(...terminalBalanceLedger(snapshot, action, body));
  }

  if (snapshot.houseLedger.length > 0) {
    for (const houseEntry of snapshot.houseLedger) {
      houseLedger.push(toHouseLedgerRecord(houseEntry));
      events.push(buildRakeEvent(houseEntry, snapshot, context));
    }
  }

  return { events, balanceLedger, houseLedger };
}

export function dotCastAuditStatements(
  db: DotCastAuditDb,
  plan: DotCastAuditWritePlan
): D1PreparedStatement[] {
  return [
    ...plan.events.map((event) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO dotcast_audit_events (
             event_id, pool_id, market_id, event_type, user_id, entry_id, unit, amount,
             side, status, reason, correlation_id, event_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          event.eventId,
          event.poolId,
          event.marketId,
          event.eventType,
          event.userId,
          event.entryId,
          event.unit,
          event.amount,
          event.side,
          event.status,
          event.reason,
          event.correlationId,
          JSON.stringify(event.eventJson),
          event.createdAt
        )
    ),
    ...plan.balanceLedger.map((entry) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO dotcast_balance_ledger (
             ledger_id, pool_id, entry_id, user_id, unit, delta_available, delta_locked,
             available_after, locked_after, reason, event_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          entry.ledgerId,
          entry.poolId,
          entry.entryId,
          entry.userId,
          entry.unit,
          entry.deltaAvailable,
          entry.deltaLocked,
          entry.availableAfter,
          entry.lockedAfter,
          entry.reason,
          JSON.stringify(entry.eventJson),
          entry.createdAt
        )
    ),
    ...plan.houseLedger.map((entry) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO dotcast_house_ledger (
             ledger_id, pool_id, unit, amount, reason, event_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          entry.ledgerId,
          entry.poolId,
          entry.unit,
          entry.amount,
          entry.reason,
          JSON.stringify(entry.eventJson),
          entry.createdAt
        )
    )
  ];
}

export async function writeDotCastAuditPlan(
  db: DotCastAuditDb,
  plan: DotCastAuditWritePlan
): Promise<void> {
  const statements = dotCastAuditStatements(db, plan);

  if (statements.length === 0) {
    return;
  }

  await db.batch(statements);
}

function buildPrimaryEvent(
  action: DotCastAuditAction,
  eventType: DotCastAuditEventType,
  body: Record<string, unknown>,
  snapshot: DotCastPoolSnapshot,
  context: DotCastAuditContext
): DotCastAuditEventRecord {
  const entry = asEntry(body.entry);
  const amount = entry?.amount ?? snapshot.pool.pools.yes + snapshot.pool.pools.no;
  const reason = textValue(body.reason) ?? snapshot.voidReason ?? pollKind(body);
  const side = entry?.side ?? (isSide(snapshot.pool.outcome) ? snapshot.pool.outcome : null);

  return {
    eventId: primaryEventId(action, eventType, body, snapshot, entry),
    poolId: snapshot.pool.id,
    marketId: snapshot.pool.marketId,
    eventType,
    userId: entry?.userId ?? null,
    entryId: entry?.id ?? null,
    unit: snapshot.pool.unit,
    amount,
    side,
    status: textValue(body.action) ?? snapshot.pool.status,
    reason,
    correlationId: context.correlationId ?? null,
    eventJson: { action, response: body },
    createdAt: primaryEventTime(action, body, snapshot, entry)
  };
}

function buildRakeEvent(
  entry: HouseLedgerEntry,
  snapshot: DotCastPoolSnapshot,
  context: DotCastAuditContext
): DotCastAuditEventRecord {
  return {
    eventId: `dotcast:audit:rake:${entry.id}`,
    poolId: entry.poolId,
    marketId: snapshot.pool.marketId,
    eventType: "RAKE_RECORDED",
    userId: null,
    entryId: null,
    unit: entry.unit,
    amount: entry.amount,
    side: null,
    status: snapshot.pool.status,
    reason: "RAKE",
    correlationId: context.correlationId ?? null,
    eventJson: { action: "house_ledger", entry },
    createdAt: entry.createdAt
  };
}

function primaryEventType(
  action: DotCastAuditAction,
  snapshot: DotCastPoolSnapshot
): DotCastAuditEventType | null {
  if (action === "create") {
    return "POOL_CREATED";
  }

  if (action === "entry") {
    return "ENTRY_PLACED";
  }

  if (action === "lock") {
    return snapshot.pool.status === "voided" ? "POOL_VOIDED" : "POOL_LOCKED";
  }

  if (action === "settle") {
    return snapshot.pool.status === "voided" ? "POOL_VOIDED" : "POOL_SETTLED";
  }

  if (action === "resolution") {
    return "RESOLUTION_APPLIED";
  }

  if (action === "poll") {
    return "ROUTER_POLL";
  }

  if (action === "void") {
    return "POOL_VOIDED";
  }

  return null;
}

function primaryEventId(
  action: DotCastAuditAction,
  eventType: DotCastAuditEventType,
  body: Record<string, unknown>,
  snapshot: DotCastPoolSnapshot,
  entry: DotCastEntry | null
): string {
  if (action === "create") {
    return `dotcast:audit:pool:${snapshot.pool.id}:created`;
  }

  if (action === "entry" && entry) {
    return `dotcast:audit:entry:${entry.id}`;
  }

  if (action === "settle" && snapshot.settlement) {
    return `dotcast:audit:settlement:${snapshot.settlement.id}`;
  }

  if (action === "resolution") {
    const resolutionTime = snapshot.lastResolution?.fetchedAt ?? snapshot.updatedAt;
    return `dotcast:audit:resolution:${snapshot.pool.id}:${resolutionTime}:${textValue(body.action) ?? eventType}`;
  }

  if (action === "poll") {
    return `dotcast:audit:poll:${snapshot.pool.id}:${snapshot.updatedAt}:${pollKind(body) ?? "unknown"}:${textValue(body.action) ?? "none"}`;
  }

  if (eventType === "POOL_VOIDED") {
    return `dotcast:audit:void:${snapshot.pool.id}:${snapshot.voidReason ?? "unknown"}:${snapshot.pool.settledAt ?? snapshot.updatedAt}`;
  }

  return `dotcast:audit:${eventType}:${snapshot.pool.id}:${snapshot.updatedAt}`;
}

function primaryEventTime(
  action: DotCastAuditAction,
  body: Record<string, unknown>,
  snapshot: DotCastPoolSnapshot,
  entry: DotCastEntry | null
): string {
  if (action === "create") {
    return snapshot.pool.createdAt;
  }

  if (action === "entry" && entry) {
    return entry.placedAt;
  }

  if (action === "settle" && snapshot.settlement) {
    return snapshot.settlement.createdAt;
  }

  if (action === "resolution" && snapshot.lastResolution) {
    return snapshot.lastResolution.fetchedAt;
  }

  return textValue(body.now) ?? snapshot.pool.settledAt ?? snapshot.updatedAt;
}

function shouldRecordTerminalBalances(
  action: DotCastAuditAction,
  body: Record<string, unknown>,
  snapshot: DotCastPoolSnapshot
): boolean {
  if (snapshot.pool.status !== "settled" && snapshot.pool.status !== "voided") {
    return false;
  }

  if (action === "settle" || action === "void") {
    return true;
  }

  if (action === "resolution") {
    return body.action === "settled" || body.action === "voided";
  }

  if (action === "poll") {
    return body.action === "settled" || body.action === "voided";
  }

  if (action === "lock") {
    return snapshot.pool.status === "voided";
  }

  return false;
}

function terminalBalanceLedger(
  snapshot: DotCastPoolSnapshot,
  action: DotCastAuditAction,
  body: Record<string, unknown>
): DotCastBalanceLedgerRecord[] {
  return snapshot.entries.flatMap((entry): DotCastBalanceLedgerRecord[] => {
    if (entry.funding !== "user") {
      return [];
    }

    const balance = snapshot.balances[entry.userId];

    if (!balance) {
      return [];
    }

    if (snapshot.pool.status === "settled" && typeof entry.payout === "number") {
      return [
        {
          ledgerId: `dotcast:balance:settlement:${snapshot.settlement?.id ?? snapshot.pool.id}:${entry.id}`,
          poolId: snapshot.pool.id,
          entryId: entry.id,
          userId: entry.userId,
          unit: balance.unit,
          deltaAvailable: entry.payout,
          deltaLocked: -entry.amount,
          availableAfter: balance.available,
          lockedAfter: balance.locked,
          reason: "SETTLEMENT_PAYOUT",
          eventJson: { action, responseAction: body.action ?? null, entry },
          createdAt: snapshot.settlement?.createdAt ?? snapshot.pool.settledAt ?? snapshot.updatedAt
        }
      ];
    }

    if (snapshot.pool.status === "voided" && entry.refunded) {
      return [
        {
          ledgerId: `dotcast:balance:void:${snapshot.pool.id}:${entry.id}:${snapshot.pool.settledAt ?? snapshot.updatedAt}`,
          poolId: snapshot.pool.id,
          entryId: entry.id,
          userId: entry.userId,
          unit: balance.unit,
          deltaAvailable: entry.amount,
          deltaLocked: -entry.amount,
          availableAfter: balance.available,
          lockedAfter: balance.locked,
          reason: "VOID_REFUND",
          eventJson: { action, responseAction: body.action ?? null, entry },
          createdAt: snapshot.pool.settledAt ?? snapshot.updatedAt
        }
      ];
    }

    return [];
  });
}

function toHouseLedgerRecord(entry: HouseLedgerEntry): DotCastHouseLedgerRecord {
  return {
    ledgerId: entry.id,
    poolId: entry.poolId,
    unit: entry.unit,
    amount: entry.amount,
    reason: "RAKE",
    eventJson: entry,
    createdAt: entry.createdAt
  };
}

function emptyPlan(): DotCastAuditWritePlan {
  return { events: [], balanceLedger: [], houseLedger: [] };
}

function asSnapshot(value: unknown): DotCastPoolSnapshot | null {
  const snapshot = asRecord(value);
  const pool = asRecord(snapshot?.pool);

  if (!snapshot || !pool || typeof pool.id !== "string") {
    return null;
  }

  return {
    ...(value as DotCastPoolSnapshot),
    houseLedger: Array.isArray(snapshot.houseLedger)
      ? (snapshot.houseLedger as HouseLedgerEntry[])
      : [],
    settlement: snapshot.settlement
      ? (snapshot.settlement as DotCastPoolSnapshot["settlement"])
      : null,
    voidReason:
      typeof snapshot.voidReason === "string"
        ? (snapshot.voidReason as DotCastPoolSnapshot["voidReason"])
        : null,
    lastResolution: snapshot.lastResolution
      ? (snapshot.lastResolution as DotCastPoolSnapshot["lastResolution"])
      : null
  };
}

function asEntry(value: unknown): DotCastEntry | null {
  const entry = asRecord(value);

  if (!entry || typeof entry.id !== "string" || typeof entry.userId !== "string") {
    return null;
  }

  return value as DotCastEntry;
}

function asBalance(value: unknown): StakeBalance | null {
  const balance = asRecord(value);

  if (!balance || typeof balance.userId !== "string" || !isStakeUnit(balance.unit)) {
    return null;
  }

  return value as StakeBalance;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isSide(value: unknown): value is Side {
  return value === "yes" || value === "no";
}

function isStakeUnit(value: unknown): value is StakeUnit {
  return value === "points" || value === "usdc";
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pollKind(body: Record<string, unknown>): string | null {
  const poll = asRecord(body.poll);
  return textValue(poll?.kind);
}

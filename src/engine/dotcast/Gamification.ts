import type {
  DotCastEntry,
  DotCastGamificationProfile,
  DotCastGamificationSettlement,
  DotCastPoolSnapshot,
  FreeEntryCredit,
  PointsLedgerEntry,
  PointsLedgerReason,
  Side
} from "./types";

export interface DotCastGamificationEnv {
  DOTCAST_GAMIFICATION_ENABLED?: string;
  DOTCAST_GAMIFICATION_CORRECT_POINTS?: string;
  DOTCAST_GAMIFICATION_INCORRECT_POINTS?: string;
  DOTCAST_GAMIFICATION_STREAK_BONUS_POINTS?: string;
  DOTCAST_GAMIFICATION_STREAK_BONUS_INTERVAL?: string;
  DOTCAST_GAMIFICATION_FREE_ENTRY_STREAK_INTERVAL?: string;
  DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS?: string;
}

export interface DotCastGamificationStatus {
  enabled: boolean;
  ready: boolean;
  correctPoints: number;
  incorrectPoints: number;
  streakBonusPoints: number;
  streakBonusInterval: number;
  freeEntryStreakInterval: number;
  maxFreeEntryCredits: number;
  guards: string[];
}

export interface DotCastGamificationUserSummary {
  profile: DotCastGamificationProfile;
  availableFreeEntries: number;
  recentLedger: PointsLedgerEntry[];
  freeEntries: FreeEntryCredit[];
}

export interface DotCastGamificationSettlementPlan {
  settlement: DotCastGamificationSettlement;
  profiles: DotCastGamificationProfile[];
  ledger: PointsLedgerEntry[];
  freeEntries: FreeEntryCredit[];
}

export interface DotCastGamificationSettlementResult {
  applied: boolean;
  idempotent: boolean;
  settlement: DotCastGamificationSettlement;
  profiles: DotCastGamificationProfile[];
  ledger: PointsLedgerEntry[];
  freeEntries: FreeEntryCredit[];
  status: DotCastGamificationStatus;
}

export interface DotCastGamificationStore {
  getProfile(userId: string): Promise<DotCastGamificationProfile | null>;
  getSettlement(poolId: string): Promise<DotCastGamificationSettlement | null>;
  listLedger(userId: string, limit: number): Promise<PointsLedgerEntry[]>;
  listFreeEntries(userId: string, limit: number): Promise<FreeEntryCredit[]>;
  applySettlementPlan(plan: DotCastGamificationSettlementPlan): Promise<void>;
}

const DEFAULT_CORRECT_POINTS = 100;
const DEFAULT_INCORRECT_POINTS = 10;
const DEFAULT_STREAK_BONUS_POINTS = 50;
const DEFAULT_STREAK_BONUS_INTERVAL = 3;
const DEFAULT_FREE_ENTRY_STREAK_INTERVAL = 5;
const DEFAULT_MAX_FREE_ENTRY_CREDITS = 10;

type GamificationRow = Record<string, unknown>;

export class DotCastGamificationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastGamificationError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastGamificationStore implements DotCastGamificationStore {
  constructor(private readonly db: D1Database) {}

  async getProfile(userId: string): Promise<DotCastGamificationProfile | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, points_balance, current_streak, longest_streak,
                settled_predictions, correct_predictions, incorrect_predictions,
                free_entries_granted, free_entries_consumed, last_settled_pool_id,
                last_settled_at, updated_at
         FROM dotcast_gamification_profiles
         WHERE user_id = ?`
      )
      .bind(userId)
      .first<GamificationRow>();

    return row ? profileFromRow(row) : null;
  }

  async getSettlement(poolId: string): Promise<DotCastGamificationSettlement | null> {
    const row = await this.db
      .prepare(
        `SELECT pool_id, settlement_id, outcome, unit, status, applied_entries,
                correct_entries, incorrect_entries, points_awarded, free_entries_granted,
                idempotency_key, event_json, created_at
         FROM dotcast_gamification_settlements
         WHERE pool_id = ?`
      )
      .bind(poolId)
      .first<GamificationRow>();

    return row ? settlementFromRow(row) : null;
  }

  async listLedger(userId: string, limit: number): Promise<PointsLedgerEntry[]> {
    const result = await this.db
      .prepare(
        `SELECT ledger_id, user_id, delta, reason, pool_id, entry_id, balance_after,
                event_json, created_at
         FROM dotcast_points_ledger
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(userId, limit)
      .all<GamificationRow>();

    return (result.results ?? []).map(ledgerFromRow);
  }

  async listFreeEntries(userId: string, limit: number): Promise<FreeEntryCredit[]> {
    const result = await this.db
      .prepare(
        `SELECT credit_id, user_id, grant_reason, pool_id, granted_at, expires_at,
                consumed_at, consumed_by_entry_id, event_json
         FROM dotcast_free_entry_credits
         WHERE user_id = ?
         ORDER BY granted_at DESC
         LIMIT ?`
      )
      .bind(userId, limit)
      .all<GamificationRow>();

    return (result.results ?? []).map(freeEntryFromRow);
  }

  async applySettlementPlan(plan: DotCastGamificationSettlementPlan): Promise<void> {
    const statements: D1PreparedStatement[] = [];

    for (const profile of plan.profiles) {
      statements.push(this.db.prepare(profileUpsertSql()).bind(...profileParams(profile)));
    }

    for (const entry of plan.ledger) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO dotcast_points_ledger (
               ledger_id, user_id, delta, reason, pool_id, entry_id, balance_after,
               event_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(...ledgerParams(entry))
      );
    }

    for (const credit of plan.freeEntries) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO dotcast_free_entry_credits (
               credit_id, user_id, grant_reason, pool_id, granted_at, expires_at,
               consumed_at, consumed_by_entry_id, event_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(...freeEntryParams(credit))
      );
    }

    statements.push(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO dotcast_gamification_settlements (
             pool_id, settlement_id, outcome, unit, status, applied_entries,
             correct_entries, incorrect_entries, points_awarded, free_entries_granted,
             idempotency_key, event_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(...settlementParams(plan.settlement))
    );

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }
}

export function readDotCastGamificationStatus(
  env: DotCastGamificationEnv,
  hasDatabase = false
): DotCastGamificationStatus {
  const enabled = env.DOTCAST_GAMIFICATION_ENABLED !== "false";
  const correctPoints = parsePositiveInt(
    env.DOTCAST_GAMIFICATION_CORRECT_POINTS,
    DEFAULT_CORRECT_POINTS,
    "DOTCAST_GAMIFICATION_CORRECT_POINTS"
  );
  const incorrectPoints = parseNonNegativeInt(
    env.DOTCAST_GAMIFICATION_INCORRECT_POINTS,
    DEFAULT_INCORRECT_POINTS,
    "DOTCAST_GAMIFICATION_INCORRECT_POINTS"
  );
  const streakBonusPoints = parseNonNegativeInt(
    env.DOTCAST_GAMIFICATION_STREAK_BONUS_POINTS,
    DEFAULT_STREAK_BONUS_POINTS,
    "DOTCAST_GAMIFICATION_STREAK_BONUS_POINTS"
  );
  const streakBonusInterval = parsePositiveInt(
    env.DOTCAST_GAMIFICATION_STREAK_BONUS_INTERVAL,
    DEFAULT_STREAK_BONUS_INTERVAL,
    "DOTCAST_GAMIFICATION_STREAK_BONUS_INTERVAL"
  );
  const freeEntryStreakInterval = parsePositiveInt(
    env.DOTCAST_GAMIFICATION_FREE_ENTRY_STREAK_INTERVAL,
    DEFAULT_FREE_ENTRY_STREAK_INTERVAL,
    "DOTCAST_GAMIFICATION_FREE_ENTRY_STREAK_INTERVAL"
  );
  const maxFreeEntryCredits = parseNonNegativeInt(
    env.DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS,
    DEFAULT_MAX_FREE_ENTRY_CREDITS,
    "DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS"
  );
  const guards: string[] = [];

  if (!enabled) {
    guards.push("gamification disabled");
  }

  if (!hasDatabase) {
    guards.push("gamification database not configured");
  }

  return {
    enabled,
    ready: enabled && hasDatabase,
    correctPoints,
    incorrectPoints,
    streakBonusPoints,
    streakBonusInterval,
    freeEntryStreakInterval,
    maxFreeEntryCredits,
    guards
  };
}

export async function readDotCastGamificationUserSummary(
  store: DotCastGamificationStore,
  userId: string,
  now = new Date().toISOString()
): Promise<DotCastGamificationUserSummary> {
  const [profile, ledger, freeEntries] = await Promise.all([
    store.getProfile(userId),
    store.listLedger(userId, 25),
    store.listFreeEntries(userId, 25)
  ]);
  const credits = freeEntries.filter((credit) => isCreditAvailable(credit, now));

  return {
    profile: profile ?? emptyProfile(userId, now),
    availableFreeEntries: credits.length,
    recentLedger: ledger,
    freeEntries
  };
}

export async function applyDotCastGamificationSettlement(
  store: DotCastGamificationStore,
  env: DotCastGamificationEnv,
  snapshot: DotCastPoolSnapshot,
  input: { now?: string; hasDatabase?: boolean } = {}
): Promise<DotCastGamificationSettlementResult> {
  const status = readDotCastGamificationStatus(env, input.hasDatabase ?? true);

  if (!status.ready) {
    throw new DotCastGamificationError(
      "GAMIFICATION_NOT_READY",
      status.guards.join("; ") || "E8 gamification is not ready",
      503
    );
  }

  assertSettledPointsSnapshot(snapshot);

  const existing = await store.getSettlement(snapshot.pool.id);
  if (existing) {
    return {
      applied: false,
      idempotent: true,
      settlement: existing,
      profiles: [],
      ledger: [],
      freeEntries: [],
      status
    };
  }

  const plan = await buildDotCastGamificationSettlementPlan(store, status, snapshot, input.now);
  await store.applySettlementPlan(plan);

  return {
    applied: true,
    idempotent: false,
    ...plan,
    status
  };
}

async function buildDotCastGamificationSettlementPlan(
  store: DotCastGamificationStore,
  status: DotCastGamificationStatus,
  snapshot: DotCastPoolSnapshot,
  now = new Date().toISOString()
): Promise<DotCastGamificationSettlementPlan> {
  const userEntries = snapshot.entries
    .filter((entry) => entry.funding === "user" && !entry.refunded)
    .sort(
      (left, right) =>
        left.placedAt.localeCompare(right.placedAt) || left.id.localeCompare(right.id)
    );
  const profiles = new Map<string, DotCastGamificationProfile>();
  const ledger: PointsLedgerEntry[] = [];
  const freeEntries: FreeEntryCredit[] = [];
  let correctEntries = 0;
  let incorrectEntries = 0;
  let pointsAwarded = 0;
  const outcome = snapshot.pool.outcome;

  if (outcome !== "yes" && outcome !== "no") {
    throw new DotCastGamificationError(
      "INVALID_GAMIFICATION_OUTCOME",
      "E8 gamification requires a yes/no settled outcome",
      409
    );
  }

  for (const entry of userEntries) {
    const startingProfile =
      profiles.get(entry.userId) ??
      (await store.getProfile(entry.userId)) ??
      emptyProfile(entry.userId, now);
    const correct = entry.side === outcome;
    const baseReason: PointsLedgerReason = correct ? "predict_correct" : "predict_incorrect";
    const baseDelta = correct ? status.correctPoints : status.incorrectPoints;
    const baseProfile = applyPredictionResult(startingProfile, {
      poolId: snapshot.pool.id,
      correct,
      delta: baseDelta,
      now
    });

    ledger.push(
      buildLedgerEntry({
        id: ledgerId(snapshot.pool.id, entry, baseReason),
        userId: entry.userId,
        delta: baseDelta,
        reason: baseReason,
        poolId: snapshot.pool.id,
        entryId: entry.id,
        balanceAfter: baseProfile.pointsBalance,
        createdAt: now,
        eventJson: ledgerEventJson(snapshot, entry, correct)
      })
    );

    pointsAwarded += baseDelta;

    if (correct) {
      correctEntries += 1;
    } else {
      incorrectEntries += 1;
    }

    let nextProfile = baseProfile;
    if (
      correct &&
      status.streakBonusPoints > 0 &&
      nextProfile.currentStreak % status.streakBonusInterval === 0
    ) {
      nextProfile = {
        ...nextProfile,
        pointsBalance: nextProfile.pointsBalance + status.streakBonusPoints
      };
      ledger.push(
        buildLedgerEntry({
          id: ledgerId(snapshot.pool.id, entry, "streak_bonus"),
          userId: entry.userId,
          delta: status.streakBonusPoints,
          reason: "streak_bonus",
          poolId: snapshot.pool.id,
          entryId: entry.id,
          balanceAfter: nextProfile.pointsBalance,
          createdAt: now,
          eventJson: {
            poolId: snapshot.pool.id,
            entryId: entry.id,
            streak: nextProfile.currentStreak,
            marketId: snapshot.pool.marketId
          }
        })
      );
      pointsAwarded += status.streakBonusPoints;
    }

    if (
      correct &&
      status.maxFreeEntryCredits > 0 &&
      nextProfile.currentStreak % status.freeEntryStreakInterval === 0 &&
      availableFreeEntryCount(nextProfile) < status.maxFreeEntryCredits
    ) {
      const credit = buildFreeEntryCredit(snapshot, entry, nextProfile.currentStreak, now);
      freeEntries.push(credit);
      nextProfile = {
        ...nextProfile,
        freeEntriesGranted: nextProfile.freeEntriesGranted + 1
      };
    }

    profiles.set(entry.userId, nextProfile);
  }

  const profileList = [...profiles.values()];
  const settlement: DotCastGamificationSettlement = {
    poolId: snapshot.pool.id,
    settlementId: snapshot.settlement?.id ?? `settlement:${snapshot.pool.id}:${outcome}`,
    outcome,
    unit: snapshot.pool.unit,
    status: snapshot.pool.status,
    appliedEntries: userEntries.length,
    correctEntries,
    incorrectEntries,
    pointsAwarded,
    freeEntriesGranted: freeEntries.length,
    idempotencyKey: `dotcast:e8:settlement:${snapshot.pool.id}:${outcome}`,
    eventJson: {
      marketId: snapshot.pool.marketId,
      question: snapshot.pool.question,
      totalStaked:
        snapshot.settlement?.totalStaked ?? snapshot.pool.pools.yes + snapshot.pool.pools.no,
      payoutTotal: snapshot.settlement?.payoutTotal ?? 0,
      rakeAmount: snapshot.settlement?.rakeAmount ?? 0
    },
    createdAt: now
  };

  return {
    settlement,
    profiles: profileList,
    ledger,
    freeEntries
  };
}

function applyPredictionResult(
  profile: DotCastGamificationProfile,
  input: {
    poolId: string;
    correct: boolean;
    delta: number;
    now: string;
  }
): DotCastGamificationProfile {
  const currentStreak = input.correct ? profile.currentStreak + 1 : 0;
  const longestStreak = Math.max(profile.longestStreak, currentStreak);

  return {
    ...profile,
    pointsBalance: profile.pointsBalance + input.delta,
    currentStreak,
    longestStreak,
    settledPredictions: profile.settledPredictions + 1,
    correctPredictions: profile.correctPredictions + (input.correct ? 1 : 0),
    incorrectPredictions: profile.incorrectPredictions + (input.correct ? 0 : 1),
    lastSettledPoolId: input.poolId,
    lastSettledAt: input.now,
    updatedAt: input.now
  };
}

function assertSettledPointsSnapshot(snapshot: DotCastPoolSnapshot): void {
  if (snapshot.pool.unit !== "points") {
    throw new DotCastGamificationError(
      "GAMIFICATION_POINTS_ONLY",
      "E8 gamification only applies to points pools",
      409
    );
  }

  if (snapshot.pool.status !== "settled") {
    throw new DotCastGamificationError(
      "GAMIFICATION_REQUIRES_SETTLEMENT",
      "E8 gamification requires a settled pool",
      409
    );
  }
}

function buildLedgerEntry(input: PointsLedgerEntry): PointsLedgerEntry {
  return input;
}

function buildFreeEntryCredit(
  snapshot: DotCastPoolSnapshot,
  entry: DotCastEntry,
  streak: number,
  now: string
): FreeEntryCredit {
  return {
    id: `dotcast:e8:free-entry:${snapshot.pool.id}:${entry.id}:${streak}`,
    userId: entry.userId,
    grantReason: "streak_bonus",
    poolId: snapshot.pool.id,
    grantedAt: now,
    expiresAt: null,
    consumedAt: null,
    consumedByEntryId: null,
    eventJson: {
      marketId: snapshot.pool.marketId,
      entryId: entry.id,
      streak
    }
  };
}

function ledgerId(poolId: string, entry: DotCastEntry, reason: PointsLedgerReason): string {
  return `dotcast:e8:points:${poolId}:${entry.id}:${reason}`;
}

function ledgerEventJson(
  snapshot: DotCastPoolSnapshot,
  entry: DotCastEntry,
  correct: boolean
): Record<string, unknown> {
  return {
    marketId: snapshot.pool.marketId,
    question: snapshot.pool.question,
    outcome: snapshot.pool.outcome,
    side: entry.side,
    amount: entry.amount,
    payout: entry.payout,
    correct
  };
}

function availableFreeEntryCount(profile: DotCastGamificationProfile): number {
  return Math.max(0, profile.freeEntriesGranted - profile.freeEntriesConsumed);
}

function emptyProfile(userId: string, now: string): DotCastGamificationProfile {
  return {
    userId,
    pointsBalance: 0,
    currentStreak: 0,
    longestStreak: 0,
    settledPredictions: 0,
    correctPredictions: 0,
    incorrectPredictions: 0,
    freeEntriesGranted: 0,
    freeEntriesConsumed: 0,
    lastSettledPoolId: null,
    lastSettledAt: null,
    updatedAt: now
  };
}

function isCreditAvailable(credit: FreeEntryCredit, now: string): boolean {
  if (credit.consumedAt) {
    return false;
  }

  return !credit.expiresAt || Date.parse(credit.expiresAt) > Date.parse(now);
}

function profileUpsertSql(): string {
  return `INSERT INTO dotcast_gamification_profiles (
            user_id, points_balance, current_streak, longest_streak,
            settled_predictions, correct_predictions, incorrect_predictions,
            free_entries_granted, free_entries_consumed, last_settled_pool_id,
            last_settled_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            points_balance = excluded.points_balance,
            current_streak = excluded.current_streak,
            longest_streak = excluded.longest_streak,
            settled_predictions = excluded.settled_predictions,
            correct_predictions = excluded.correct_predictions,
            incorrect_predictions = excluded.incorrect_predictions,
            free_entries_granted = excluded.free_entries_granted,
            free_entries_consumed = excluded.free_entries_consumed,
            last_settled_pool_id = excluded.last_settled_pool_id,
            last_settled_at = excluded.last_settled_at,
            updated_at = excluded.updated_at`;
}

function profileParams(profile: DotCastGamificationProfile): unknown[] {
  return [
    profile.userId,
    profile.pointsBalance,
    profile.currentStreak,
    profile.longestStreak,
    profile.settledPredictions,
    profile.correctPredictions,
    profile.incorrectPredictions,
    profile.freeEntriesGranted,
    profile.freeEntriesConsumed,
    profile.lastSettledPoolId,
    profile.lastSettledAt,
    profile.updatedAt
  ];
}

function ledgerParams(entry: PointsLedgerEntry): unknown[] {
  return [
    entry.id,
    entry.userId,
    entry.delta,
    entry.reason,
    entry.poolId,
    entry.entryId,
    entry.balanceAfter,
    JSON.stringify(entry.eventJson),
    entry.createdAt
  ];
}

function freeEntryParams(credit: FreeEntryCredit): unknown[] {
  return [
    credit.id,
    credit.userId,
    credit.grantReason,
    credit.poolId,
    credit.grantedAt,
    credit.expiresAt,
    credit.consumedAt,
    credit.consumedByEntryId,
    JSON.stringify(credit.eventJson)
  ];
}

function settlementParams(settlement: DotCastGamificationSettlement): unknown[] {
  return [
    settlement.poolId,
    settlement.settlementId,
    settlement.outcome,
    settlement.unit,
    settlement.status,
    settlement.appliedEntries,
    settlement.correctEntries,
    settlement.incorrectEntries,
    settlement.pointsAwarded,
    settlement.freeEntriesGranted,
    settlement.idempotencyKey,
    JSON.stringify(settlement.eventJson),
    settlement.createdAt
  ];
}

function profileFromRow(row: GamificationRow): DotCastGamificationProfile {
  return {
    userId: requireText(row.user_id, "user_id"),
    pointsBalance: requireInt(row.points_balance, "points_balance"),
    currentStreak: requireInt(row.current_streak, "current_streak"),
    longestStreak: requireInt(row.longest_streak, "longest_streak"),
    settledPredictions: requireInt(row.settled_predictions, "settled_predictions"),
    correctPredictions: requireInt(row.correct_predictions, "correct_predictions"),
    incorrectPredictions: requireInt(row.incorrect_predictions, "incorrect_predictions"),
    freeEntriesGranted: requireInt(row.free_entries_granted, "free_entries_granted"),
    freeEntriesConsumed: requireInt(row.free_entries_consumed, "free_entries_consumed"),
    lastSettledPoolId: nullableText(row.last_settled_pool_id),
    lastSettledAt: nullableText(row.last_settled_at),
    updatedAt: requireText(row.updated_at, "updated_at")
  };
}

function settlementFromRow(row: GamificationRow): DotCastGamificationSettlement {
  return {
    poolId: requireText(row.pool_id, "pool_id"),
    settlementId: requireText(row.settlement_id, "settlement_id"),
    outcome: parseSide(row.outcome),
    unit: row.unit === "points" || row.unit === "usdc" ? row.unit : "points",
    status:
      row.status === "settled" ||
      row.status === "voided" ||
      row.status === "locked" ||
      row.status === "resolving"
        ? row.status
        : "open",
    appliedEntries: requireInt(row.applied_entries, "applied_entries"),
    correctEntries: requireInt(row.correct_entries, "correct_entries"),
    incorrectEntries: requireInt(row.incorrect_entries, "incorrect_entries"),
    pointsAwarded: requireInt(row.points_awarded, "points_awarded"),
    freeEntriesGranted: requireInt(row.free_entries_granted, "free_entries_granted"),
    idempotencyKey: requireText(row.idempotency_key, "idempotency_key"),
    eventJson: parseJsonObject(row.event_json),
    createdAt: requireText(row.created_at, "created_at")
  };
}

function ledgerFromRow(row: GamificationRow): PointsLedgerEntry {
  return {
    id: requireText(row.ledger_id, "ledger_id"),
    userId: requireText(row.user_id, "user_id"),
    delta: requireInt(row.delta, "delta"),
    reason: parseLedgerReason(row.reason),
    poolId: nullableText(row.pool_id),
    entryId: nullableText(row.entry_id),
    balanceAfter: requireInt(row.balance_after, "balance_after"),
    eventJson: parseJsonObject(row.event_json),
    createdAt: requireText(row.created_at, "created_at")
  };
}

function freeEntryFromRow(row: GamificationRow): FreeEntryCredit {
  return {
    id: requireText(row.credit_id, "credit_id"),
    userId: requireText(row.user_id, "user_id"),
    grantReason: parseGrantReason(row.grant_reason),
    poolId: nullableText(row.pool_id),
    grantedAt: requireText(row.granted_at, "granted_at"),
    expiresAt: nullableText(row.expires_at),
    consumedAt: nullableText(row.consumed_at),
    consumedByEntryId: nullableText(row.consumed_by_entry_id),
    eventJson: parseJsonObject(row.event_json)
  };
}

function parseLedgerReason(value: unknown): PointsLedgerReason {
  if (
    value === "predict_correct" ||
    value === "predict_incorrect" ||
    value === "streak_bonus" ||
    value === "free_entry_grant" ||
    value === "free_entry_redeem" ||
    value === "adjustment"
  ) {
    return value;
  }

  throw new DotCastGamificationError("INVALID_LEDGER_REASON", "invalid points ledger reason", 500);
}

function parseGrantReason(value: unknown): FreeEntryCredit["grantReason"] {
  if (
    value === "streak_bonus" ||
    value === "manual_grant" ||
    value === "rewarded_ad" ||
    value === "adjustment"
  ) {
    return value;
  }

  return "adjustment";
}

function parseSide(value: unknown): Side {
  if (value === "yes" || value === "no") {
    return value;
  }

  throw new DotCastGamificationError("INVALID_OUTCOME", "invalid gamification outcome", 500);
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed <= 0) {
    throw new DotCastGamificationError(
      "INVALID_GAMIFICATION_CONFIG",
      `${label} must be positive`,
      500
    );
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed < 0) {
    throw new DotCastGamificationError(
      "INVALID_GAMIFICATION_CONFIG",
      `${label} must be non-negative`,
      500
    );
  }

  return parsed;
}

function parseOptionalInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new DotCastGamificationError(
      "INVALID_GAMIFICATION_CONFIG",
      `${label} must be a safe integer`,
      500
    );
  }

  return parsed;
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new DotCastGamificationError("INVALID_GAMIFICATION_ROW", `${label} is required`, 500);
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireInt(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  throw new DotCastGamificationError(
    "INVALID_GAMIFICATION_ROW",
    `${label} must be a safe integer`,
    500
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
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

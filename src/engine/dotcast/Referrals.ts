import type {
  DotCastGamificationProfile,
  DotCastReferral,
  DotCastReferralAmlFlag,
  DotCastReferralCode,
  DotCastReferralCodeStatus,
  DotCastReferralEvent,
  DotCastReferralIdentityBinding,
  DotCastReferralQualificationEvent,
  DotCastReferralQualifier,
  DotCastReferralReward,
  FreeEntryCredit
} from "./types";

export interface DotCastReferralEnv {
  DOTCAST_REFERRALS_ENABLED?: string;
  DOTCAST_REFERRAL_THRESHOLD?: string;
  DOTCAST_REFERRAL_QUALIFY?: string;
  DOTCAST_REFERRAL_REWARD_BOTH?: string;
  DOTCAST_REFERRAL_MAX_PER_PERIOD?: string;
  DOTCAST_REFERRAL_PERIOD_DAYS?: string;
  DOTCAST_REFERRAL_FREE_ENTRY_REWARD?: string;
  DOTCAST_REFERRAL_FREE_ENTRY_TTL_DAYS?: string;
  DOTCAST_REFERRAL_AML_MIN_RING_SIZE?: string;
  DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS?: string;
}

export interface DotCastReferralProgramStatus {
  enabled: boolean;
  ready: boolean;
  threshold: number;
  qualifier: DotCastReferralQualifier;
  rewardBoth: boolean;
  freeEntryReward: number;
  maxPerPeriod: number;
  periodDays: number;
  freeEntryTtlDays: number;
  amlMinRingSize: number;
  maxFreeEntryCredits: number;
  guards: string[];
  safeguards: {
    signupOnlyQualification: false;
    cashRewards: false;
    requiresDistinctWalletIdentity: true;
    perReferrerCap: true;
    usesP6FreeEntryLedger: true;
    rewardGrantReason: "referral";
  };
}

export interface CreateReferralCodeInput {
  userId: string;
  identityHash: string;
  walletAddress?: string | null;
  code?: string;
  now?: string;
}

export interface CreateReferralCodeResult {
  idempotent: boolean;
  code: DotCastReferralCode;
  identity: DotCastReferralIdentityBinding;
  status: DotCastReferralProgramStatus;
}

export interface ClaimReferralInput {
  code?: string;
  referrerUserId?: string;
  referredUserId: string;
  referrerIdentityHash?: string;
  referredIdentityHash: string;
  referredWalletAddress?: string | null;
  idempotencyKey?: string;
  eventJson?: Record<string, unknown>;
  now?: string;
}

export interface ClaimReferralResult {
  idempotent: boolean;
  referral: DotCastReferral;
  referrerIdentity: DotCastReferralIdentityBinding;
  referredIdentity: DotCastReferralIdentityBinding;
  status: DotCastReferralProgramStatus;
}

export interface ApplyReferralQualificationInput {
  referralId?: string;
  referredUserId?: string;
  eventType?: DotCastReferralQualificationEvent;
  depositAmount?: number;
  txRef?: string;
  kycComplete?: boolean;
  firstAdFundedEntryEarned?: boolean;
  withdrawalAt?: string | null;
  withdrawalWithinHours?: number;
  depositWithdrawPattern?: boolean;
  clusterKey?: string;
  relatedReferralIds?: string[];
  relatedIdentityHashes?: string[];
  idempotencyKey?: string;
  eventJson?: Record<string, unknown>;
  now?: string;
}

export interface DotCastReferralQualificationPlan {
  referral: DotCastReferral;
  referrerIdentity: DotCastReferralIdentityBinding;
  referredIdentity: DotCastReferralIdentityBinding;
  profiles: DotCastGamificationProfile[];
  rewards: DotCastReferralReward[];
  freeEntries: FreeEntryCredit[];
  events: DotCastReferralEvent[];
  amlFlags: DotCastReferralAmlFlag[];
}

export interface ApplyReferralQualificationResult {
  idempotent: boolean;
  qualified: boolean;
  referral: DotCastReferral;
  rewards: DotCastReferralReward[];
  freeEntries: FreeEntryCredit[];
  amlFlags: DotCastReferralAmlFlag[];
  status: DotCastReferralProgramStatus;
}

export interface DotCastReferralUserSummary {
  code: DotCastReferralCode | null;
  inboundReferral: DotCastReferral | null;
  outboundReferrals: DotCastReferral[];
  rewards: DotCastReferralReward[];
  amlFlags: DotCastReferralAmlFlag[];
}

export interface DotCastReferralStore {
  getCode(code: string): Promise<DotCastReferralCode | null>;
  getCodeByUser(userId: string): Promise<DotCastReferralCode | null>;
  getIdentity(userId: string): Promise<DotCastReferralIdentityBinding | null>;
  getReferral(referralId: string): Promise<DotCastReferral | null>;
  getReferralByReferredUser(userId: string): Promise<DotCastReferral | null>;
  getReferralByIdempotencyKey(idempotencyKey: string): Promise<DotCastReferral | null>;
  countQualifiedReferralsByReferrer(
    referrerUserId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<number>;
  countReferralIdentityByReferrer(referrerUserId: string, identityHash: string): Promise<number>;
  listReferralsByReferrer(referrerUserId: string, limit: number): Promise<DotCastReferral[]>;
  listRewardsByUser(userId: string, limit: number): Promise<DotCastReferralReward[]>;
  listRewardsByReferral(referralId: string): Promise<DotCastReferralReward[]>;
  listAmlFlagsByUser(userId: string, limit: number): Promise<DotCastReferralAmlFlag[]>;
  getProfile(userId: string): Promise<DotCastGamificationProfile | null>;
  createReferralCode(
    code: DotCastReferralCode,
    identity: DotCastReferralIdentityBinding,
    event: DotCastReferralEvent
  ): Promise<void>;
  claimReferral(
    referral: DotCastReferral,
    referrerIdentity: DotCastReferralIdentityBinding,
    referredIdentity: DotCastReferralIdentityBinding,
    event: DotCastReferralEvent
  ): Promise<void>;
  applyQualificationPlan(plan: DotCastReferralQualificationPlan): Promise<void>;
}

const DEFAULT_REFERRAL_THRESHOLD = 3;
const DEFAULT_REFERRAL_MAX_PER_PERIOD = 30;
const DEFAULT_REFERRAL_PERIOD_DAYS = 30;
const DEFAULT_REFERRAL_FREE_ENTRY_REWARD = 1;
const DEFAULT_REFERRAL_FREE_ENTRY_TTL_DAYS = 30;
const DEFAULT_REFERRAL_AML_MIN_RING_SIZE = 3;
const DEFAULT_MAX_FREE_ENTRY_CREDITS = 10;

type ReferralRow = Record<string, unknown>;

export class DotCastReferralError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastReferralError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastReferralStore implements DotCastReferralStore {
  constructor(private readonly db: D1Database) {}

  async getCode(code: string): Promise<DotCastReferralCode | null> {
    const row = await this.db
      .prepare(codeSelectSql("code = ?"))
      .bind(normalizeReferralCode(code))
      .first<ReferralRow>();

    return row ? codeFromRow(row) : null;
  }

  async getCodeByUser(userId: string): Promise<DotCastReferralCode | null> {
    const row = await this.db
      .prepare(`${codeSelectSql("user_id = ?")} ORDER BY updated_at DESC LIMIT 1`)
      .bind(userId)
      .first<ReferralRow>();

    return row ? codeFromRow(row) : null;
  }

  async getIdentity(userId: string): Promise<DotCastReferralIdentityBinding | null> {
    const row = await this.db
      .prepare(identitySelectSql("user_id = ?"))
      .bind(userId)
      .first<ReferralRow>();

    return row ? identityFromRow(row) : null;
  }

  async getReferral(referralId: string): Promise<DotCastReferral | null> {
    const row = await this.db
      .prepare(referralSelectSql("referral_id = ?"))
      .bind(referralId)
      .first<ReferralRow>();

    return row ? referralFromRow(row) : null;
  }

  async getReferralByReferredUser(userId: string): Promise<DotCastReferral | null> {
    const row = await this.db
      .prepare(referralSelectSql("referred_user_id = ?"))
      .bind(userId)
      .first<ReferralRow>();

    return row ? referralFromRow(row) : null;
  }

  async getReferralByIdempotencyKey(idempotencyKey: string): Promise<DotCastReferral | null> {
    const row = await this.db
      .prepare(referralSelectSql("idempotency_key = ?"))
      .bind(idempotencyKey)
      .first<ReferralRow>();

    return row ? referralFromRow(row) : null;
  }

  async countQualifiedReferralsByReferrer(
    referrerUserId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM dotcast_referrals
         WHERE referrer_user_id = ?
           AND status IN ('qualified', 'rewarded')
           AND qualified_at IS NOT NULL
           AND qualified_at >= ?
           AND qualified_at < ?`
      )
      .bind(referrerUserId, periodStart, periodEnd)
      .first<ReferralRow>();

    return requireInt(row?.count ?? 0, "count");
  }

  async countReferralIdentityByReferrer(
    referrerUserId: string,
    identityHash: string
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM dotcast_referrals
         WHERE referrer_user_id = ? AND referred_identity_hash = ?`
      )
      .bind(referrerUserId, normalizeIdentityHash(identityHash))
      .first<ReferralRow>();

    return requireInt(row?.count ?? 0, "count");
  }

  async listReferralsByReferrer(referrerUserId: string, limit: number): Promise<DotCastReferral[]> {
    const result = await this.db
      .prepare(`${referralSelectSql("referrer_user_id = ?")} ORDER BY updated_at DESC LIMIT ?`)
      .bind(referrerUserId, limit)
      .all<ReferralRow>();

    return (result.results ?? []).map(referralFromRow);
  }

  async listRewardsByUser(userId: string, limit: number): Promise<DotCastReferralReward[]> {
    const result = await this.db
      .prepare(`${rewardSelectSql("user_id = ?")} ORDER BY created_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<ReferralRow>();

    return (result.results ?? []).map(rewardFromRow);
  }

  async listRewardsByReferral(referralId: string): Promise<DotCastReferralReward[]> {
    const result = await this.db
      .prepare(`${rewardSelectSql("referral_id = ?")} ORDER BY created_at ASC`)
      .bind(referralId)
      .all<ReferralRow>();

    return (result.results ?? []).map(rewardFromRow);
  }

  async listAmlFlagsByUser(userId: string, limit: number): Promise<DotCastReferralAmlFlag[]> {
    const result = await this.db
      .prepare(
        `${amlFlagSelectSql("referrer_user_id = ? OR referred_user_id = ?")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(userId, userId, limit)
      .all<ReferralRow>();

    return (result.results ?? []).map(amlFlagFromRow);
  }

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
      .first<ReferralRow>();

    return row ? profileFromRow(row) : null;
  }

  async createReferralCode(
    code: DotCastReferralCode,
    identity: DotCastReferralIdentityBinding,
    event: DotCastReferralEvent
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(identityUpsertSql()).bind(...identityParams(identity)),
      this.db.prepare(codeInsertSql()).bind(...codeParams(code)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async claimReferral(
    referral: DotCastReferral,
    referrerIdentity: DotCastReferralIdentityBinding,
    referredIdentity: DotCastReferralIdentityBinding,
    event: DotCastReferralEvent
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(identityUpsertSql()).bind(...identityParams(referrerIdentity)),
      this.db.prepare(identityUpsertSql()).bind(...identityParams(referredIdentity)),
      this.db.prepare(referralInsertSql()).bind(...referralParams(referral)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async applyQualificationPlan(plan: DotCastReferralQualificationPlan): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(identityUpsertSql()).bind(...identityParams(plan.referrerIdentity)),
      this.db.prepare(identityUpsertSql()).bind(...identityParams(plan.referredIdentity)),
      this.db.prepare(referralUpdateSql()).bind(...referralUpdateParams(plan.referral))
    ];

    for (const profile of plan.profiles) {
      statements.push(this.db.prepare(profileUpsertSql()).bind(...profileParams(profile)));
    }

    for (const reward of plan.rewards) {
      statements.push(this.db.prepare(rewardInsertSql()).bind(...rewardParams(reward)));
    }

    for (const credit of plan.freeEntries) {
      statements.push(this.db.prepare(freeEntryInsertSql()).bind(...freeEntryParams(credit)));
    }

    for (const flag of plan.amlFlags) {
      statements.push(this.db.prepare(amlFlagInsertSql()).bind(...amlFlagParams(flag)));
    }

    for (const event of plan.events) {
      statements.push(this.db.prepare(eventInsertSql()).bind(...eventParams(event)));
    }

    await this.db.batch(statements);
  }
}

export function readDotCastReferralStatus(
  env: DotCastReferralEnv,
  hasDatabase = false
): DotCastReferralProgramStatus {
  const enabled = env.DOTCAST_REFERRALS_ENABLED !== "false";
  const qualifier = parseQualifierEnv(env.DOTCAST_REFERRAL_QUALIFY);
  const threshold = parsePositiveInt(
    env.DOTCAST_REFERRAL_THRESHOLD,
    DEFAULT_REFERRAL_THRESHOLD,
    "DOTCAST_REFERRAL_THRESHOLD"
  );
  const maxPerPeriod = parsePositiveInt(
    env.DOTCAST_REFERRAL_MAX_PER_PERIOD,
    DEFAULT_REFERRAL_MAX_PER_PERIOD,
    "DOTCAST_REFERRAL_MAX_PER_PERIOD"
  );
  const periodDays = parsePositiveInt(
    env.DOTCAST_REFERRAL_PERIOD_DAYS,
    DEFAULT_REFERRAL_PERIOD_DAYS,
    "DOTCAST_REFERRAL_PERIOD_DAYS"
  );
  const freeEntryReward = parseNonNegativeInt(
    env.DOTCAST_REFERRAL_FREE_ENTRY_REWARD,
    DEFAULT_REFERRAL_FREE_ENTRY_REWARD,
    "DOTCAST_REFERRAL_FREE_ENTRY_REWARD"
  );
  const freeEntryTtlDays = parseNonNegativeInt(
    env.DOTCAST_REFERRAL_FREE_ENTRY_TTL_DAYS,
    DEFAULT_REFERRAL_FREE_ENTRY_TTL_DAYS,
    "DOTCAST_REFERRAL_FREE_ENTRY_TTL_DAYS"
  );
  const amlMinRingSize = parsePositiveInt(
    env.DOTCAST_REFERRAL_AML_MIN_RING_SIZE,
    DEFAULT_REFERRAL_AML_MIN_RING_SIZE,
    "DOTCAST_REFERRAL_AML_MIN_RING_SIZE"
  );
  const maxFreeEntryCredits = parseNonNegativeInt(
    env.DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS,
    DEFAULT_MAX_FREE_ENTRY_CREDITS,
    "DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS"
  );
  const guards: string[] = [];

  if (!enabled) {
    guards.push("referrals disabled");
  }

  if (!hasDatabase) {
    guards.push("referral database not configured");
  }

  if (freeEntryReward === 0) {
    guards.push("referral free-entry reward disabled");
  }

  return {
    enabled,
    ready: enabled && hasDatabase && freeEntryReward > 0,
    threshold,
    qualifier,
    rewardBoth: env.DOTCAST_REFERRAL_REWARD_BOTH !== "false",
    freeEntryReward,
    maxPerPeriod,
    periodDays,
    freeEntryTtlDays,
    amlMinRingSize,
    maxFreeEntryCredits,
    guards,
    safeguards: {
      signupOnlyQualification: false,
      cashRewards: false,
      requiresDistinctWalletIdentity: true,
      perReferrerCap: true,
      usesP6FreeEntryLedger: true,
      rewardGrantReason: "referral"
    }
  };
}

export async function createDotCastReferralCode(
  store: DotCastReferralStore,
  env: DotCastReferralEnv,
  input: CreateReferralCodeInput,
  hasDatabase = true
): Promise<CreateReferralCodeResult> {
  const status = requireReferralReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const userId = requireNonEmpty(input.userId, "userId");
  const identityHash = normalizeIdentityHash(input.identityHash);
  const code = normalizeReferralCode(input.code ?? generateReferralCode(userId));
  const existingForUser = await store.getCodeByUser(userId);

  if (existingForUser) {
    const identity =
      (await store.getIdentity(userId)) ??
      buildIdentityBinding({
        userId,
        identityHash: existingForUser.identityHash,
        walletAddress: input.walletAddress,
        now
      });

    return {
      idempotent: true,
      code: existingForUser,
      identity,
      status
    };
  }

  const existingCode = await store.getCode(code);
  if (existingCode && existingCode.userId !== userId) {
    throw new DotCastReferralError(
      "REFERRAL_CODE_ALREADY_EXISTS",
      "referral code is already assigned to another user",
      409
    );
  }

  const codeRecord: DotCastReferralCode = {
    code,
    userId,
    identityHash,
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  const identity = buildIdentityBinding({
    userId,
    identityHash,
    walletAddress: input.walletAddress,
    now
  });
  const event = buildReferralEvent({
    eventType: "REFERRAL_CODE_CREATED",
    referrerUserId: userId,
    referredUserId: null,
    referralId: null,
    now,
    eventJson: {
      code,
      identityHash
    }
  });

  await store.createReferralCode(codeRecord, identity, event);

  return {
    idempotent: false,
    code: codeRecord,
    identity,
    status
  };
}

export async function claimDotCastReferral(
  store: DotCastReferralStore,
  env: DotCastReferralEnv,
  input: ClaimReferralInput,
  hasDatabase = true
): Promise<ClaimReferralResult> {
  const status = requireReferralReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const referredUserId = requireNonEmpty(input.referredUserId, "referredUserId");
  const idempotencyKey =
    input.idempotencyKey ??
    `dotcast:e12:claim:${input.code ?? input.referrerUserId ?? "direct"}:${referredUserId}`;
  const replayed = await store.getReferralByIdempotencyKey(idempotencyKey);

  if (replayed) {
    return {
      idempotent: true,
      referral: replayed,
      referrerIdentity: await requireIdentity(store, replayed.referrerUserId),
      referredIdentity: await requireIdentity(store, replayed.referredUserId),
      status
    };
  }

  const existingForReferred = await store.getReferralByReferredUser(referredUserId);
  if (existingForReferred) {
    throw new DotCastReferralError(
      "REFERRED_USER_ALREADY_CLAIMED",
      "referred user already has a referral attribution",
      409
    );
  }

  const codeRecord = input.code
    ? await store.getCode(input.code)
    : input.referrerUserId
      ? await store.getCodeByUser(input.referrerUserId)
      : null;

  if (input.code && !codeRecord) {
    throw new DotCastReferralError("REFERRAL_CODE_NOT_FOUND", "referral code was not found", 404);
  }

  if (codeRecord?.status === "disabled") {
    throw new DotCastReferralError("REFERRAL_CODE_DISABLED", "referral code is disabled", 409);
  }

  const referrerUserId =
    codeRecord?.userId ?? requireNonEmpty(input.referrerUserId, "referrerUserId");
  const referrerIdentityHash = normalizeIdentityHash(
    codeRecord?.identityHash ?? requireNonEmpty(input.referrerIdentityHash, "referrerIdentityHash")
  );
  const referredIdentityHash = normalizeIdentityHash(input.referredIdentityHash);

  if (referrerUserId === referredUserId) {
    throw new DotCastReferralError(
      "REFERRAL_SELF_REFERRAL_BLOCKED",
      "users cannot refer themselves",
      409
    );
  }

  if (referrerIdentityHash === referredIdentityHash) {
    throw new DotCastReferralError(
      "REFERRAL_SYBIL_IDENTITY_MATCH",
      "referrer and referred user must have distinct wallet identities",
      409
    );
  }

  const matchingIdentityCount = await store.countReferralIdentityByReferrer(
    referrerUserId,
    referredIdentityHash
  );

  if (matchingIdentityCount > 0) {
    throw new DotCastReferralError(
      "REFERRAL_DUPLICATE_BOUND_IDENTITY",
      "referrer already has a referral bound to this identity",
      409
    );
  }

  const referral: DotCastReferral = {
    referralId: `dotcast:e12:referral:${referrerUserId}:${referredUserId}`,
    code: codeRecord?.code ?? null,
    referrerUserId,
    referredUserId,
    referrerIdentityHash,
    referredIdentityHash,
    qualifier: status.qualifier,
    status: "claimed",
    qualifiedAt: null,
    rejectedReason: null,
    rewardBatchId: null,
    idempotencyKey,
    eventJson: {
      source: "referral_claim",
      ...(input.eventJson ?? {})
    },
    createdAt: now,
    updatedAt: now
  };
  const referrerIdentity =
    (await store.getIdentity(referrerUserId)) ??
    buildIdentityBinding({
      userId: referrerUserId,
      identityHash: referrerIdentityHash,
      walletAddress: null,
      now
    });
  const referredIdentity = buildIdentityBinding({
    userId: referredUserId,
    identityHash: referredIdentityHash,
    walletAddress: input.referredWalletAddress,
    now
  });
  const event = buildReferralEvent({
    eventType: "REFERRAL_CLAIMED",
    referrerUserId,
    referredUserId,
    referralId: referral.referralId,
    now,
    eventJson: referral.eventJson
  });

  await store.claimReferral(referral, referrerIdentity, referredIdentity, event);

  return {
    idempotent: false,
    referral,
    referrerIdentity,
    referredIdentity,
    status
  };
}

export async function applyDotCastReferralQualification(
  store: DotCastReferralStore,
  env: DotCastReferralEnv,
  input: ApplyReferralQualificationInput,
  hasDatabase = true
): Promise<ApplyReferralQualificationResult> {
  const status = requireReferralReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const referral = await resolveReferralForQualification(store, input);

  if (referral.status === "rewarded" || referral.status === "qualified") {
    return {
      idempotent: true,
      qualified: true,
      referral,
      rewards: await store.listRewardsByReferral(referral.referralId),
      freeEntries: [],
      amlFlags: [],
      status
    };
  }

  if (referral.status === "rejected") {
    return {
      idempotent: true,
      qualified: false,
      referral,
      rewards: [],
      freeEntries: [],
      amlFlags: [],
      status
    };
  }

  const eventType = input.eventType ?? status.qualifier;

  if (eventType === "signup") {
    throw new DotCastReferralError(
      "REFERRAL_SIGNUP_ONLY_NOT_QUALIFYING",
      "signup alone does not qualify a referral",
      409
    );
  }

  if (eventType !== status.qualifier) {
    throw new DotCastReferralError(
      "REFERRAL_QUALIFIER_MISMATCH",
      `referral program currently requires ${status.qualifier}`,
      409
    );
  }

  assertQualifierEvidence(status.qualifier, input);

  const referrerIdentity = await requireIdentity(store, referral.referrerUserId);
  const referredIdentity = await requireIdentity(store, referral.referredUserId);

  if (referral.referrerIdentityHash === referral.referredIdentityHash) {
    return await rejectReferral(store, env, referral, referrerIdentity, referredIdentity, {
      now,
      rejectedReason: "shared_bound_identity",
      eventJson: input.eventJson
    });
  }

  const identityMatchCount = await store.countReferralIdentityByReferrer(
    referral.referrerUserId,
    referral.referredIdentityHash
  );

  if (identityMatchCount > 1) {
    return await rejectReferral(store, env, referral, referrerIdentity, referredIdentity, {
      now,
      rejectedReason: "duplicate_bound_identity",
      eventJson: input.eventJson
    });
  }

  const periodEnd = now;
  const periodStart = periodStartIso(now, status.periodDays);
  const alreadyQualified = await store.countQualifiedReferralsByReferrer(
    referral.referrerUserId,
    periodStart,
    periodEnd
  );

  if (alreadyQualified >= status.maxPerPeriod) {
    return await rejectReferral(store, env, referral, referrerIdentity, referredIdentity, {
      now,
      rejectedReason: "referrer_period_cap_exceeded",
      eventJson: input.eventJson
    });
  }

  const qualifiedCountAfter = alreadyQualified + 1;
  const rewardBatchNumber = Math.floor(qualifiedCountAfter / status.threshold);
  const referrerRewardDue = qualifiedCountAfter % status.threshold === 0;
  const rewardBatchId = referrerRewardDue
    ? `dotcast:e12:batch:${referral.referrerUserId}:${rewardBatchNumber}`
    : `dotcast:e12:activation:${referral.referralId}`;
  const nextReferral: DotCastReferral = {
    ...referral,
    status: referrerRewardDue || status.rewardBoth ? "rewarded" : "qualified",
    qualifiedAt: now,
    rejectedReason: null,
    rewardBatchId,
    updatedAt: now,
    eventJson: {
      ...referral.eventJson,
      qualifier: status.qualifier,
      qualifyingEvent: eventType,
      qualifiedCountAfter,
      ...(input.eventJson ?? {})
    }
  };
  const updatedReferrerIdentity = touchIdentity(referrerIdentity, input, now, false);
  const updatedReferredIdentity = touchIdentity(referredIdentity, input, now, true);
  const { profiles, rewards, freeEntries } = await buildReferralRewards(store, status, {
    referral: nextReferral,
    referrerRewardDue,
    rewardBatchId,
    now,
    eventJson: nextReferral.eventJson
  });
  const amlFlags = buildReferralAmlFlags(status, nextReferral, input, now);
  const events: DotCastReferralEvent[] = [
    buildReferralEvent({
      eventType: "REFERRAL_QUALIFIED",
      referralId: nextReferral.referralId,
      referrerUserId: nextReferral.referrerUserId,
      referredUserId: nextReferral.referredUserId,
      now,
      eventJson: nextReferral.eventJson
    })
  ];

  if (rewards.length > 0) {
    events.push(
      buildReferralEvent({
        eventType: "REFERRAL_REWARDED",
        referralId: nextReferral.referralId,
        referrerUserId: nextReferral.referrerUserId,
        referredUserId: nextReferral.referredUserId,
        now,
        eventJson: {
          rewardBatchId,
          rewards: rewards.map((reward) => ({
            userId: reward.userId,
            role: reward.role,
            status: reward.status,
            freeEntriesGranted: reward.freeEntriesGranted
          }))
        }
      })
    );
  }

  if (amlFlags.length > 0) {
    events.push(
      buildReferralEvent({
        eventType: "REFERRAL_AML_FLAGGED",
        referralId: nextReferral.referralId,
        referrerUserId: nextReferral.referrerUserId,
        referredUserId: nextReferral.referredUserId,
        now,
        eventJson: {
          flags: amlFlags.map((flag) => ({
            flagId: flag.flagId,
            reason: flag.reason,
            severity: flag.severity,
            clusterKey: flag.clusterKey
          }))
        }
      })
    );
  }

  await store.applyQualificationPlan({
    referral: nextReferral,
    referrerIdentity: updatedReferrerIdentity,
    referredIdentity: updatedReferredIdentity,
    profiles,
    rewards,
    freeEntries,
    events,
    amlFlags
  });

  return {
    idempotent: false,
    qualified: true,
    referral: nextReferral,
    rewards,
    freeEntries,
    amlFlags,
    status
  };
}

export async function readDotCastReferralUserSummary(
  store: DotCastReferralStore,
  userId: string,
  limit = 25
): Promise<DotCastReferralUserSummary> {
  const parsedUserId = requireNonEmpty(userId, "userId");
  const [code, inboundReferral, outboundReferrals, rewards, amlFlags] = await Promise.all([
    store.getCodeByUser(parsedUserId),
    store.getReferralByReferredUser(parsedUserId),
    store.listReferralsByReferrer(parsedUserId, limit),
    store.listRewardsByUser(parsedUserId, limit),
    store.listAmlFlagsByUser(parsedUserId, limit)
  ]);

  return {
    code,
    inboundReferral,
    outboundReferrals,
    rewards,
    amlFlags
  };
}

async function rejectReferral(
  store: DotCastReferralStore,
  env: DotCastReferralEnv,
  referral: DotCastReferral,
  referrerIdentity: DotCastReferralIdentityBinding,
  referredIdentity: DotCastReferralIdentityBinding,
  input: {
    now: string;
    rejectedReason: string;
    eventJson?: Record<string, unknown>;
  }
): Promise<ApplyReferralQualificationResult> {
  const status = readDotCastReferralStatus(env, true);
  const rejected: DotCastReferral = {
    ...referral,
    status: "rejected",
    rejectedReason: input.rejectedReason,
    updatedAt: input.now,
    eventJson: {
      ...referral.eventJson,
      rejectedReason: input.rejectedReason,
      ...(input.eventJson ?? {})
    }
  };
  const event = buildReferralEvent({
    eventType: "REFERRAL_REJECTED",
    referralId: rejected.referralId,
    referrerUserId: rejected.referrerUserId,
    referredUserId: rejected.referredUserId,
    now: input.now,
    eventJson: rejected.eventJson
  });

  await store.applyQualificationPlan({
    referral: rejected,
    referrerIdentity,
    referredIdentity,
    profiles: [],
    rewards: [],
    freeEntries: [],
    events: [event],
    amlFlags: []
  });

  return {
    idempotent: false,
    qualified: false,
    referral: rejected,
    rewards: [],
    freeEntries: [],
    amlFlags: [],
    status
  };
}

function requireReferralReady(
  env: DotCastReferralEnv,
  hasDatabase: boolean
): DotCastReferralProgramStatus {
  const status = readDotCastReferralStatus(env, hasDatabase);

  if (!status.ready) {
    throw new DotCastReferralError(
      "REFERRALS_NOT_READY",
      status.guards.join("; ") || "referrals are not ready",
      503
    );
  }

  return status;
}

async function resolveReferralForQualification(
  store: DotCastReferralStore,
  input: ApplyReferralQualificationInput
): Promise<DotCastReferral> {
  const referral = input.referralId
    ? await store.getReferral(input.referralId)
    : input.referredUserId
      ? await store.getReferralByReferredUser(input.referredUserId)
      : null;

  if (!referral) {
    throw new DotCastReferralError("REFERRAL_NOT_FOUND", "referral attribution was not found", 404);
  }

  return referral;
}

async function requireIdentity(
  store: DotCastReferralStore,
  userId: string
): Promise<DotCastReferralIdentityBinding> {
  const identity = await store.getIdentity(userId);

  if (!identity) {
    throw new DotCastReferralError(
      "REFERRAL_IDENTITY_NOT_BOUND",
      "referral user is missing a bound wallet identity",
      409
    );
  }

  return identity;
}

function assertQualifierEvidence(
  qualifier: DotCastReferralQualifier,
  input: ApplyReferralQualificationInput
): void {
  if (qualifier === "first_deposit") {
    if (
      !input.txRef ||
      input.txRef.trim().length === 0 ||
      !input.depositAmount ||
      input.depositAmount <= 0
    ) {
      throw new DotCastReferralError(
        "REFERRAL_FIRST_DEPOSIT_REQUIRED",
        "first-deposit qualification requires a positive deposit and txRef",
        409
      );
    }
    return;
  }

  if (!input.kycComplete || !input.firstAdFundedEntryEarned) {
    throw new DotCastReferralError(
      "REFERRAL_KYC_AND_FIRST_ENTRY_REQUIRED",
      "kyc_plus_first_entry qualification requires KYC complete and first ad-funded entry earned",
      409
    );
  }
}

async function buildReferralRewards(
  store: DotCastReferralStore,
  status: DotCastReferralProgramStatus,
  input: {
    referral: DotCastReferral;
    referrerRewardDue: boolean;
    rewardBatchId: string;
    now: string;
    eventJson: Record<string, unknown>;
  }
): Promise<{
  profiles: DotCastGamificationProfile[];
  rewards: DotCastReferralReward[];
  freeEntries: FreeEntryCredit[];
}> {
  const profiles = new Map<string, DotCastGamificationProfile>();
  const rewards: DotCastReferralReward[] = [];
  const freeEntries: FreeEntryCredit[] = [];

  if (status.rewardBoth) {
    await appendReferralReward(store, status, profiles, rewards, freeEntries, {
      referral: input.referral,
      userId: input.referral.referredUserId,
      role: "referred",
      rewardBatchId: input.rewardBatchId,
      now: input.now,
      eventJson: input.eventJson
    });
  }

  if (input.referrerRewardDue) {
    await appendReferralReward(store, status, profiles, rewards, freeEntries, {
      referral: input.referral,
      userId: input.referral.referrerUserId,
      role: "referrer",
      rewardBatchId: input.rewardBatchId,
      now: input.now,
      eventJson: input.eventJson
    });
  }

  return {
    profiles: [...profiles.values()],
    rewards,
    freeEntries
  };
}

async function appendReferralReward(
  store: DotCastReferralStore,
  status: DotCastReferralProgramStatus,
  profiles: Map<string, DotCastGamificationProfile>,
  rewards: DotCastReferralReward[],
  freeEntries: FreeEntryCredit[],
  input: {
    referral: DotCastReferral;
    userId: string;
    role: "referrer" | "referred";
    rewardBatchId: string;
    now: string;
    eventJson: Record<string, unknown>;
  }
): Promise<void> {
  const currentProfile =
    profiles.get(input.userId) ??
    (await store.getProfile(input.userId)) ??
    emptyProfile(input.userId, input.now);
  const pendingForUser = freeEntries.filter((credit) => credit.userId === input.userId).length;
  const available = availableFreeEntryCount(currentProfile) + pendingForUser;
  const grantable = Math.max(
    0,
    Math.min(status.freeEntryReward, status.maxFreeEntryCredits - available)
  );
  const rewardId = `dotcast:e12:reward:${input.referral.referralId}:${input.role}`;
  const creditIds: string[] = [];
  const rewardEventJson = {
    ...input.eventJson,
    source: "referral",
    role: input.role,
    referralId: input.referral.referralId,
    rewardBatchId: input.rewardBatchId,
    qualifier: input.referral.qualifier,
    threshold: status.threshold,
    freeEntryReward: status.freeEntryReward
  };

  for (let index = 0; index < grantable; index += 1) {
    const creditId = `dotcast:e12:free-entry:${rewardId}:${index + 1}`;
    creditIds.push(creditId);
    freeEntries.push({
      id: creditId,
      userId: input.userId,
      grantReason: "referral",
      poolId: null,
      grantedAt: input.now,
      expiresAt: freeEntryExpiresAt(input.now, status.freeEntryTtlDays),
      consumedAt: null,
      consumedByEntryId: null,
      eventJson: rewardEventJson
    });
  }

  profiles.set(input.userId, {
    ...currentProfile,
    freeEntriesGranted: currentProfile.freeEntriesGranted + grantable,
    updatedAt: input.now
  });
  rewards.push({
    rewardId,
    referralId: input.referral.referralId,
    rewardBatchId: input.rewardBatchId,
    userId: input.userId,
    role: input.role,
    status: grantable > 0 ? "granted" : "suppressed",
    freeEntriesGranted: grantable,
    suppressedReason: grantable > 0 ? null : "free_entry_cap",
    creditIds,
    idempotencyKey: `dotcast:e12:reward:${input.referral.referralId}:${input.role}`,
    eventJson: rewardEventJson,
    createdAt: input.now
  });
}

function buildReferralAmlFlags(
  status: DotCastReferralProgramStatus,
  referral: DotCastReferral,
  input: ApplyReferralQualificationInput,
  now: string
): DotCastReferralAmlFlag[] {
  const relatedIdentityHashes = [
    referral.referrerIdentityHash,
    referral.referredIdentityHash,
    ...(input.relatedIdentityHashes ?? []).map(normalizeIdentityHash)
  ];
  const ringSize = new Set(relatedIdentityHashes).size;
  const withdrawalWindowHit =
    input.withdrawalWithinHours !== undefined && input.withdrawalWithinHours >= 0
      ? input.withdrawalWithinHours <= 24
      : Boolean(input.depositWithdrawPattern);

  if (!withdrawalWindowHit || ringSize < status.amlMinRingSize) {
    return [];
  }

  const clusterKey =
    input.clusterKey ??
    `dotcast:e12:aml:${referral.referrerUserId}:${relatedIdentityHashes.sort().join(":")}`;

  return [
    {
      flagId: `dotcast:e12:aml:${referral.referralId}`,
      referrerUserId: referral.referrerUserId,
      referredUserId: referral.referredUserId,
      clusterKey,
      reason: "deposit_refer_withdraw_ring",
      severity: "high",
      relatedReferralIds: [referral.referralId, ...(input.relatedReferralIds ?? [])],
      relatedIdentityHashes: [...new Set(relatedIdentityHashes)],
      eventJson: {
        source: "referral_aml",
        depositWithdrawPattern: input.depositWithdrawPattern ?? null,
        withdrawalWithinHours: input.withdrawalWithinHours ?? null,
        withdrawalAt: input.withdrawalAt ?? null,
        txRef: input.txRef ?? null
      },
      createdAt: now
    }
  ];
}

function touchIdentity(
  identity: DotCastReferralIdentityBinding,
  input: ApplyReferralQualificationInput,
  now: string,
  isReferred: boolean
): DotCastReferralIdentityBinding {
  return {
    ...identity,
    kycComplete: identity.kycComplete || Boolean(input.kycComplete && isReferred),
    firstEntryEarned:
      identity.firstEntryEarned || Boolean(input.firstAdFundedEntryEarned && isReferred),
    firstDepositAt:
      identity.firstDepositAt ??
      (isReferred && input.eventType !== "signup" && input.depositAmount && input.depositAmount > 0
        ? now
        : null),
    lastWithdrawalAt:
      identity.lastWithdrawalAt ?? (isReferred && input.withdrawalAt ? input.withdrawalAt : null),
    updatedAt: now
  };
}

function buildIdentityBinding(input: {
  userId: string;
  identityHash: string;
  walletAddress?: string | null;
  now: string;
}): DotCastReferralIdentityBinding {
  return {
    userId: input.userId,
    identityHash: normalizeIdentityHash(input.identityHash),
    walletAddress: input.walletAddress ?? null,
    kycComplete: false,
    firstEntryEarned: false,
    firstDepositAt: null,
    lastWithdrawalAt: null,
    updatedAt: input.now
  };
}

function buildReferralEvent(input: {
  eventType: DotCastReferralEvent["eventType"];
  referralId: string | null;
  referrerUserId: string | null;
  referredUserId: string | null;
  eventJson: Record<string, unknown>;
  now: string;
}): DotCastReferralEvent {
  return {
    eventId: `dotcast:e12:event:${input.eventType}:${input.referralId ?? input.referrerUserId ?? "system"}:${input.now}`,
    referralId: input.referralId,
    referrerUserId: input.referrerUserId,
    referredUserId: input.referredUserId,
    eventType: input.eventType,
    eventJson: input.eventJson,
    createdAt: input.now
  };
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

function availableFreeEntryCount(profile: DotCastGamificationProfile): number {
  return Math.max(0, profile.freeEntriesGranted - profile.freeEntriesConsumed);
}

function periodStartIso(now: string, days: number): string {
  return new Date(new Date(now).getTime() - days * 86_400_000).toISOString();
}

function freeEntryExpiresAt(now: string, days: number): string | null {
  if (days <= 0) {
    return null;
  }

  return new Date(new Date(now).getTime() + days * 86_400_000).toISOString();
}

function generateReferralCode(userId: string): string {
  const prefix = userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  return `${prefix || "dotcast"}-${suffix}`;
}

function normalizeReferralCode(code: string): string {
  const normalized = requireNonEmpty(code, "code")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");

  if (normalized.length < 3 || normalized.length > 64) {
    throw new DotCastReferralError(
      "REFERRAL_CODE_INVALID",
      "referral code must be between 3 and 64 characters",
      400
    );
  }

  return normalized;
}

function normalizeIdentityHash(identityHash: string): string {
  const normalized = requireNonEmpty(identityHash, "identityHash").toLowerCase();

  if (normalized.length < 8) {
    throw new DotCastReferralError(
      "REFERRAL_IDENTITY_INVALID",
      "wallet identity hash must be at least 8 characters",
      400
    );
  }

  return normalized;
}

function requireNonEmpty(value: string | undefined | null, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastReferralError("REFERRAL_INPUT_INVALID", `${label} is required`, 400);
}

function parseQualifierEnv(value: string | undefined): DotCastReferralQualifier {
  if (value === undefined || value === null || value === "" || value === "first_deposit") {
    return "first_deposit";
  }

  if (value === "kyc_plus_first_entry") {
    return value;
  }

  throw new DotCastReferralError(
    "REFERRAL_CONFIG_INVALID",
    "DOTCAST_REFERRAL_QUALIFY must be first_deposit or kyc_plus_first_entry",
    500
  );
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed <= 0) {
    throw new DotCastReferralError("REFERRAL_CONFIG_INVALID", `${label} must be positive`, 500);
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed < 0) {
    throw new DotCastReferralError("REFERRAL_CONFIG_INVALID", `${label} must be non-negative`, 500);
  }

  return parsed;
}

function parseOptionalInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new DotCastReferralError("REFERRAL_CONFIG_INVALID", `${label} must be an integer`, 500);
  }

  return parsed;
}

function codeSelectSql(where: string): string {
  return `SELECT code, user_id, identity_hash, status, created_at, updated_at
          FROM dotcast_referral_codes
          WHERE ${where}`;
}

function identitySelectSql(where: string): string {
  return `SELECT user_id, identity_hash, wallet_address, kyc_complete, first_entry_earned,
                 first_deposit_at, last_withdrawal_at, updated_at
          FROM dotcast_referral_identity_bindings
          WHERE ${where}`;
}

function referralSelectSql(where: string): string {
  return `SELECT referral_id, code, referrer_user_id, referred_user_id,
                 referrer_identity_hash, referred_identity_hash, qualifier, status,
                 qualified_at, rejected_reason, reward_batch_id, idempotency_key,
                 event_json, created_at, updated_at
          FROM dotcast_referrals
          WHERE ${where}`;
}

function rewardSelectSql(where: string): string {
  return `SELECT reward_id, referral_id, reward_batch_id, user_id, role, status,
                 free_entries_granted, suppressed_reason, credit_ids_json,
                 idempotency_key, event_json, created_at
          FROM dotcast_referral_rewards
          WHERE ${where}`;
}

function amlFlagSelectSql(where: string): string {
  return `SELECT flag_id, referrer_user_id, referred_user_id, cluster_key, reason,
                 severity, related_referral_ids_json, related_identity_hashes_json,
                 event_json, created_at
          FROM dotcast_referral_aml_flags
          WHERE ${where}`;
}

function identityUpsertSql(): string {
  return `INSERT INTO dotcast_referral_identity_bindings (
            user_id, identity_hash, wallet_address, kyc_complete, first_entry_earned,
            first_deposit_at, last_withdrawal_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            identity_hash = excluded.identity_hash,
            wallet_address = COALESCE(excluded.wallet_address, dotcast_referral_identity_bindings.wallet_address),
            kyc_complete = MAX(dotcast_referral_identity_bindings.kyc_complete, excluded.kyc_complete),
            first_entry_earned = MAX(dotcast_referral_identity_bindings.first_entry_earned, excluded.first_entry_earned),
            first_deposit_at = COALESCE(dotcast_referral_identity_bindings.first_deposit_at, excluded.first_deposit_at),
            last_withdrawal_at = COALESCE(excluded.last_withdrawal_at, dotcast_referral_identity_bindings.last_withdrawal_at),
            updated_at = excluded.updated_at`;
}

function codeInsertSql(): string {
  return `INSERT INTO dotcast_referral_codes (
            code, user_id, identity_hash, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`;
}

function referralInsertSql(): string {
  return `INSERT INTO dotcast_referrals (
            referral_id, code, referrer_user_id, referred_user_id,
            referrer_identity_hash, referred_identity_hash, qualifier, status,
            qualified_at, rejected_reason, reward_batch_id, idempotency_key,
            event_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function referralUpdateSql(): string {
  return `UPDATE dotcast_referrals
          SET status = ?,
              qualified_at = ?,
              rejected_reason = ?,
              reward_batch_id = ?,
              event_json = ?,
              updated_at = ?
          WHERE referral_id = ?`;
}

function rewardInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_referral_rewards (
            reward_id, referral_id, reward_batch_id, user_id, role, status,
            free_entries_granted, suppressed_reason, credit_ids_json,
            idempotency_key, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function freeEntryInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_free_entry_credits (
            credit_id, user_id, grant_reason, pool_id, granted_at, expires_at,
            consumed_at, consumed_by_entry_id, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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

function amlFlagInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_referral_aml_flags (
            flag_id, referrer_user_id, referred_user_id, cluster_key, reason,
            severity, related_referral_ids_json, related_identity_hashes_json,
            event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function eventInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_referral_events (
            event_id, referral_id, referrer_user_id, referred_user_id, event_type,
            event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`;
}

function identityParams(identity: DotCastReferralIdentityBinding): unknown[] {
  return [
    identity.userId,
    identity.identityHash,
    identity.walletAddress,
    boolToInt(identity.kycComplete),
    boolToInt(identity.firstEntryEarned),
    identity.firstDepositAt,
    identity.lastWithdrawalAt,
    identity.updatedAt
  ];
}

function codeParams(code: DotCastReferralCode): unknown[] {
  return [code.code, code.userId, code.identityHash, code.status, code.createdAt, code.updatedAt];
}

function referralParams(referral: DotCastReferral): unknown[] {
  return [
    referral.referralId,
    referral.code,
    referral.referrerUserId,
    referral.referredUserId,
    referral.referrerIdentityHash,
    referral.referredIdentityHash,
    referral.qualifier,
    referral.status,
    referral.qualifiedAt,
    referral.rejectedReason,
    referral.rewardBatchId,
    referral.idempotencyKey,
    JSON.stringify(referral.eventJson),
    referral.createdAt,
    referral.updatedAt
  ];
}

function referralUpdateParams(referral: DotCastReferral): unknown[] {
  return [
    referral.status,
    referral.qualifiedAt,
    referral.rejectedReason,
    referral.rewardBatchId,
    JSON.stringify(referral.eventJson),
    referral.updatedAt,
    referral.referralId
  ];
}

function rewardParams(reward: DotCastReferralReward): unknown[] {
  return [
    reward.rewardId,
    reward.referralId,
    reward.rewardBatchId,
    reward.userId,
    reward.role,
    reward.status,
    reward.freeEntriesGranted,
    reward.suppressedReason,
    JSON.stringify(reward.creditIds),
    reward.idempotencyKey,
    JSON.stringify(reward.eventJson),
    reward.createdAt
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

function amlFlagParams(flag: DotCastReferralAmlFlag): unknown[] {
  return [
    flag.flagId,
    flag.referrerUserId,
    flag.referredUserId,
    flag.clusterKey,
    flag.reason,
    flag.severity,
    JSON.stringify(flag.relatedReferralIds),
    JSON.stringify(flag.relatedIdentityHashes),
    JSON.stringify(flag.eventJson),
    flag.createdAt
  ];
}

function eventParams(event: DotCastReferralEvent): unknown[] {
  return [
    event.eventId,
    event.referralId,
    event.referrerUserId,
    event.referredUserId,
    event.eventType,
    JSON.stringify(event.eventJson),
    event.createdAt
  ];
}

function codeFromRow(row: ReferralRow): DotCastReferralCode {
  return {
    code: requireString(row.code, "code"),
    userId: requireString(row.user_id, "user_id"),
    identityHash: requireString(row.identity_hash, "identity_hash"),
    status: parseCodeStatus(row.status),
    createdAt: requireString(row.created_at, "created_at"),
    updatedAt: requireString(row.updated_at, "updated_at")
  };
}

function identityFromRow(row: ReferralRow): DotCastReferralIdentityBinding {
  return {
    userId: requireString(row.user_id, "user_id"),
    identityHash: requireString(row.identity_hash, "identity_hash"),
    walletAddress: nullableString(row.wallet_address),
    kycComplete: truthyInt(row.kyc_complete),
    firstEntryEarned: truthyInt(row.first_entry_earned),
    firstDepositAt: nullableString(row.first_deposit_at),
    lastWithdrawalAt: nullableString(row.last_withdrawal_at),
    updatedAt: requireString(row.updated_at, "updated_at")
  };
}

function referralFromRow(row: ReferralRow): DotCastReferral {
  return {
    referralId: requireString(row.referral_id, "referral_id"),
    code: nullableString(row.code),
    referrerUserId: requireString(row.referrer_user_id, "referrer_user_id"),
    referredUserId: requireString(row.referred_user_id, "referred_user_id"),
    referrerIdentityHash: requireString(row.referrer_identity_hash, "referrer_identity_hash"),
    referredIdentityHash: requireString(row.referred_identity_hash, "referred_identity_hash"),
    qualifier: parseReferralQualifier(row.qualifier),
    status: parseReferralStatus(row.status),
    qualifiedAt: nullableString(row.qualified_at),
    rejectedReason: nullableString(row.rejected_reason),
    rewardBatchId: nullableString(row.reward_batch_id),
    idempotencyKey: requireString(row.idempotency_key, "idempotency_key"),
    eventJson: parseJson(row.event_json),
    createdAt: requireString(row.created_at, "created_at"),
    updatedAt: requireString(row.updated_at, "updated_at")
  };
}

function rewardFromRow(row: ReferralRow): DotCastReferralReward {
  const status = row.status;
  const role = row.role;

  if (status !== "granted" && status !== "suppressed") {
    throw new Error("invalid referral reward status");
  }

  if (role !== "referrer" && role !== "referred") {
    throw new Error("invalid referral reward role");
  }

  return {
    rewardId: requireString(row.reward_id, "reward_id"),
    referralId: requireString(row.referral_id, "referral_id"),
    rewardBatchId: requireString(row.reward_batch_id, "reward_batch_id"),
    userId: requireString(row.user_id, "user_id"),
    role,
    status,
    freeEntriesGranted: requireInt(row.free_entries_granted, "free_entries_granted"),
    suppressedReason: nullableString(row.suppressed_reason),
    creditIds: parseStringArray(row.credit_ids_json),
    idempotencyKey: requireString(row.idempotency_key, "idempotency_key"),
    eventJson: parseJson(row.event_json),
    createdAt: requireString(row.created_at, "created_at")
  };
}

function amlFlagFromRow(row: ReferralRow): DotCastReferralAmlFlag {
  const severity = row.severity;

  if (severity !== "medium" && severity !== "high") {
    throw new Error("invalid referral AML severity");
  }

  return {
    flagId: requireString(row.flag_id, "flag_id"),
    referrerUserId: requireString(row.referrer_user_id, "referrer_user_id"),
    referredUserId: requireString(row.referred_user_id, "referred_user_id"),
    clusterKey: requireString(row.cluster_key, "cluster_key"),
    reason: "deposit_refer_withdraw_ring",
    severity,
    relatedReferralIds: parseStringArray(row.related_referral_ids_json),
    relatedIdentityHashes: parseStringArray(row.related_identity_hashes_json),
    eventJson: parseJson(row.event_json),
    createdAt: requireString(row.created_at, "created_at")
  };
}

function profileFromRow(row: ReferralRow): DotCastGamificationProfile {
  return {
    userId: requireString(row.user_id, "user_id"),
    pointsBalance: requireInt(row.points_balance, "points_balance"),
    currentStreak: requireInt(row.current_streak, "current_streak"),
    longestStreak: requireInt(row.longest_streak, "longest_streak"),
    settledPredictions: requireInt(row.settled_predictions, "settled_predictions"),
    correctPredictions: requireInt(row.correct_predictions, "correct_predictions"),
    incorrectPredictions: requireInt(row.incorrect_predictions, "incorrect_predictions"),
    freeEntriesGranted: requireInt(row.free_entries_granted, "free_entries_granted"),
    freeEntriesConsumed: requireInt(row.free_entries_consumed, "free_entries_consumed"),
    lastSettledPoolId: nullableString(row.last_settled_pool_id),
    lastSettledAt: nullableString(row.last_settled_at),
    updatedAt: requireString(row.updated_at, "updated_at")
  };
}

function parseCodeStatus(value: unknown): DotCastReferralCodeStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new Error("invalid referral code status");
}

function parseReferralQualifier(value: unknown): DotCastReferralQualifier {
  if (value === "first_deposit" || value === "kyc_plus_first_entry") {
    return value;
  }

  throw new Error("invalid referral qualifier");
}

function parseReferralStatus(value: unknown): DotCastReferral["status"] {
  if (
    value === "claimed" ||
    value === "qualified" ||
    value === "rewarded" ||
    value === "rejected"
  ) {
    return value;
  }

  throw new Error("invalid referral status");
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`${label} must be a string`);
}

function requireInt(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  throw new Error(`${label} must be an integer`);
}

function truthyInt(value: unknown): boolean {
  return value === 1 || value === true;
}

function boolToInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

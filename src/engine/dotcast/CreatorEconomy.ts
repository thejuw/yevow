import {
  confirmMockWithdrawal,
  readSettlementBalance,
  readSolanaUsdcSettlementRailStatus,
  requestDevnetWithdrawal,
  type DotCastSettlementRailEnv,
  type DotCastSettlementRailStore
} from "./SolanaUsdcSettlementRail";
import type {
  DotCastCreatorEarningsBalance,
  DotCastCreatorEvent,
  DotCastCreatorKycStatus,
  DotCastCreatorPayout,
  DotCastCreatorPayoutSchedule,
  DotCastCreatorPoolSeed,
  DotCastCreatorProfile,
  DotCastCreatorRakeAccrual,
  DotCastCreatorSeedMode,
  DotCastCreatorStatus,
  DotCastCreatorTier,
  DotCastPoolSnapshot,
  DotCastResolutionBinding,
  StakeUnit
} from "./types";

export interface DotCastCreatorEconomyEnv extends DotCastSettlementRailEnv {
  DOTCAST_CREATOR_ECONOMY_ENABLED?: string;
  DOTCAST_CREATOR_RAKE_SHARE_CASUAL_BPS?: string;
  DOTCAST_CREATOR_RAKE_SHARE_VERIFIED_BPS?: string;
  DOTCAST_CREATOR_RAKE_SHARE_PARTNER_BPS?: string;
  DOTCAST_CREATOR_PAYOUT_MIN_MINOR_UNITS?: string;
  DOTCAST_CREATOR_PAYOUT_MAX_MINOR_UNITS?: string;
  DOTCAST_CREATOR_PAYOUT_SCHEDULE?: string;
  DOTCAST_CREATOR_MIN_RETENTION_BPS?: string;
  DOTCAST_CREATOR_SEED_HANDLING_FEE_BPS?: string;
}

export interface DotCastCreatorEconomyStatus {
  enabled: boolean;
  ready: boolean;
  tierSharesBps: Record<DotCastCreatorTier, number>;
  payoutMinMinorUnits: number;
  payoutMaxMinorUnits: number;
  payoutSchedule: DotCastCreatorPayoutSchedule;
  minRetentionBps: number;
  seedHandlingFeeBps: number;
  guards: string[];
  integrityWall: {
    resolutionWriteAccess: false;
    oddsWriteAccess: false;
    userLimitBypass: false;
    urgencyTooling: false;
    separateCreatorLedger: true;
    payoutRail: "p5-solana-usdc";
  };
}

export interface OnboardCreatorInput {
  creatorId: string;
  displayName: string;
  tier?: DotCastCreatorTier;
  status?: DotCastCreatorStatus;
  kycStatus?: DotCastCreatorKycStatus;
  payoutDestination?: string | null;
  accuracyBps?: number;
  retentionBps?: number;
  volumeScore?: number;
  manualReviewRequired?: boolean;
  sponsorshipEligible?: boolean;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface ApplyCreatorRakeShareInput {
  snapshot: DotCastPoolSnapshot;
  now?: string;
}

export interface ApplyCreatorRakeShareResult {
  applied: boolean;
  idempotent: boolean;
  creator: DotCastCreatorProfile | null;
  accrual: DotCastCreatorRakeAccrual | null;
  balance: DotCastCreatorEarningsBalance | null;
  status: DotCastCreatorEconomyStatus;
}

export interface RequestCreatorPayoutInput {
  creatorId: string;
  amount: number;
  destination?: string;
  idempotencyKey: string;
  operatorApproved?: boolean;
  now?: string;
}

export interface RequestCreatorPayoutResult {
  idempotent: boolean;
  payout: DotCastCreatorPayout;
  balance: DotCastCreatorEarningsBalance;
  status: DotCastCreatorEconomyStatus;
}

export interface ConfirmCreatorPayoutInput {
  payoutId: string;
  txRef?: string;
  now?: string;
}

export interface ConfirmCreatorPayoutResult {
  idempotent: boolean;
  payout: DotCastCreatorPayout;
  balance: DotCastCreatorEarningsBalance;
  status: DotCastCreatorEconomyStatus;
}

export interface CreatorNudgeRecipient {
  userId: string;
  selfLimited?: boolean;
  lossLimited?: boolean;
  cooldownUntil?: string | null;
  blockedByResponsiblePlay?: boolean;
}

export interface CreatorNudgePlanInput {
  creatorId: string;
  poolId: string;
  recipients: CreatorNudgeRecipient[];
  now?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatorNudgePlan {
  creatorId: string;
  poolId: string;
  allowed: CreatorNudgeRecipient[];
  suppressed: (CreatorNudgeRecipient & { reason: string })[];
  integrity: DotCastCreatorEconomyStatus["integrityWall"];
}

export interface RecordCreatorSeedInput {
  seedId?: string;
  creatorId: string;
  poolId: string;
  unit: StakeUnit;
  amount: number;
  mode: DotCastCreatorSeedMode;
  resolutionBinding: DotCastResolutionBinding;
  creatorHoldsPosition?: boolean;
  now?: string;
  eventJson?: Record<string, unknown>;
}

export interface DotCastCreatorSummary {
  creator: DotCastCreatorProfile;
  balances: DotCastCreatorEarningsBalance[];
  recentAccruals: DotCastCreatorRakeAccrual[];
  recentPayouts: DotCastCreatorPayout[];
}

export interface DotCastCreatorStore {
  getCreator(creatorId: string): Promise<DotCastCreatorProfile | null>;
  upsertCreator(creator: DotCastCreatorProfile, event: DotCastCreatorEvent): Promise<void>;
  getBalance(creatorId: string, unit: StakeUnit): Promise<DotCastCreatorEarningsBalance | null>;
  listBalances(creatorId: string): Promise<DotCastCreatorEarningsBalance[]>;
  getAccrualByPool(poolId: string): Promise<DotCastCreatorRakeAccrual | null>;
  listAccruals(creatorId: string, limit: number): Promise<DotCastCreatorRakeAccrual[]>;
  listPayouts(creatorId: string, limit: number): Promise<DotCastCreatorPayout[]>;
  applyAccrual(
    accrual: DotCastCreatorRakeAccrual,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void>;
  getPayout(payoutId: string): Promise<DotCastCreatorPayout | null>;
  getPayoutByIdempotencyKey(idempotencyKey: string): Promise<DotCastCreatorPayout | null>;
  insertPayout(
    payout: DotCastCreatorPayout,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void>;
  updatePayout(
    payout: DotCastCreatorPayout,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void>;
  insertSeed(seed: DotCastCreatorPoolSeed, event: DotCastCreatorEvent): Promise<void>;
  appendEvent(event: DotCastCreatorEvent): Promise<void>;
}

const DEFAULT_TIER_SHARES_BPS: Record<DotCastCreatorTier, number> = {
  casual: 1000,
  verified: 2500,
  partner: 4000
};
const DEFAULT_PAYOUT_MIN_MINOR_UNITS = 500_000;
const DEFAULT_PAYOUT_MAX_MINOR_UNITS = 1_000_000;
const DEFAULT_MIN_RETENTION_BPS = 2500;
const DEFAULT_SEED_HANDLING_FEE_BPS = 0;
const PROHIBITED_URGENCY_FIELDS = new Set([
  "countdownSeconds",
  "expiresInSeconds",
  "fomoLabel",
  "urgencyLabel",
  "flashDeadline"
]);

type CreatorRow = Record<string, unknown>;

export class DotCastCreatorEconomyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastCreatorEconomyError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastCreatorStore implements DotCastCreatorStore {
  constructor(private readonly db: D1Database) {}

  async getCreator(creatorId: string): Promise<DotCastCreatorProfile | null> {
    const row = await this.db
      .prepare(creatorSelectSql("creator_id = ?"))
      .bind(creatorId)
      .first<CreatorRow>();

    return row ? creatorFromRow(row) : null;
  }

  async upsertCreator(creator: DotCastCreatorProfile, event: DotCastCreatorEvent): Promise<void> {
    await this.db.batch([
      this.db.prepare(creatorUpsertSql()).bind(...creatorParams(creator)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async getBalance(
    creatorId: string,
    unit: StakeUnit
  ): Promise<DotCastCreatorEarningsBalance | null> {
    const row = await this.db
      .prepare(
        `SELECT creator_id, unit, available, pending_payout, lifetime_accrued,
                lifetime_paid, updated_at
         FROM dotcast_creator_earnings_balances
         WHERE creator_id = ? AND unit = ?`
      )
      .bind(creatorId, unit)
      .first<CreatorRow>();

    return row ? balanceFromRow(row) : null;
  }

  async listBalances(creatorId: string): Promise<DotCastCreatorEarningsBalance[]> {
    const result = await this.db
      .prepare(
        `SELECT creator_id, unit, available, pending_payout, lifetime_accrued,
                lifetime_paid, updated_at
         FROM dotcast_creator_earnings_balances
         WHERE creator_id = ?
         ORDER BY unit`
      )
      .bind(creatorId)
      .all<CreatorRow>();

    return (result.results ?? []).map(balanceFromRow);
  }

  async getAccrualByPool(poolId: string): Promise<DotCastCreatorRakeAccrual | null> {
    const row = await this.db
      .prepare(accrualSelectSql("pool_id = ?"))
      .bind(poolId)
      .first<CreatorRow>();

    return row ? accrualFromRow(row) : null;
  }

  async listAccruals(creatorId: string, limit: number): Promise<DotCastCreatorRakeAccrual[]> {
    const result = await this.db
      .prepare(`${accrualSelectSql("creator_id = ?")} ORDER BY created_at DESC LIMIT ?`)
      .bind(creatorId, limit)
      .all<CreatorRow>();

    return (result.results ?? []).map(accrualFromRow);
  }

  async listPayouts(creatorId: string, limit: number): Promise<DotCastCreatorPayout[]> {
    const result = await this.db
      .prepare(`${payoutSelectSql("creator_id = ?")} ORDER BY updated_at DESC LIMIT ?`)
      .bind(creatorId, limit)
      .all<CreatorRow>();

    return (result.results ?? []).map(payoutFromRow);
  }

  async applyAccrual(
    accrual: DotCastCreatorRakeAccrual,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(accrualInsertSql()).bind(...accrualParams(accrual)),
      this.db.prepare(balanceUpsertSql()).bind(...balanceParams(balance)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async getPayout(payoutId: string): Promise<DotCastCreatorPayout | null> {
    const row = await this.db
      .prepare(payoutSelectSql("payout_id = ?"))
      .bind(payoutId)
      .first<CreatorRow>();

    return row ? payoutFromRow(row) : null;
  }

  async getPayoutByIdempotencyKey(idempotencyKey: string): Promise<DotCastCreatorPayout | null> {
    const row = await this.db
      .prepare(payoutSelectSql("idempotency_key = ?"))
      .bind(idempotencyKey)
      .first<CreatorRow>();

    return row ? payoutFromRow(row) : null;
  }

  async insertPayout(
    payout: DotCastCreatorPayout,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(payoutInsertSql()).bind(...payoutParams(payout)),
      this.db.prepare(balanceUpsertSql()).bind(...balanceParams(balance)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async updatePayout(
    payout: DotCastCreatorPayout,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE dotcast_creator_payouts
           SET status = ?, rail_tx_ref = ?, mock_signature = ?, updated_at = ?, event_json = ?
           WHERE payout_id = ?`
        )
        .bind(
          payout.status,
          payout.railTxRef,
          payout.mockSignature,
          payout.updatedAt,
          JSON.stringify(payout.eventJson),
          payout.payoutId
        ),
      this.db.prepare(balanceUpsertSql()).bind(...balanceParams(balance)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async insertSeed(seed: DotCastCreatorPoolSeed, event: DotCastCreatorEvent): Promise<void> {
    await this.db.batch([
      this.db.prepare(seedInsertSql()).bind(...seedParams(seed)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async appendEvent(event: DotCastCreatorEvent): Promise<void> {
    await this.db
      .prepare(eventInsertSql())
      .bind(...eventParams(event))
      .run();
  }
}

export function readDotCastCreatorEconomyStatus(
  env: DotCastCreatorEconomyEnv,
  hasDatabase = false
): DotCastCreatorEconomyStatus {
  const enabled = env.DOTCAST_CREATOR_ECONOMY_ENABLED !== "false";
  const tierSharesBps = {
    casual: parseBps(
      env.DOTCAST_CREATOR_RAKE_SHARE_CASUAL_BPS,
      DEFAULT_TIER_SHARES_BPS.casual,
      "DOTCAST_CREATOR_RAKE_SHARE_CASUAL_BPS"
    ),
    verified: parseBps(
      env.DOTCAST_CREATOR_RAKE_SHARE_VERIFIED_BPS,
      DEFAULT_TIER_SHARES_BPS.verified,
      "DOTCAST_CREATOR_RAKE_SHARE_VERIFIED_BPS"
    ),
    partner: parseBps(
      env.DOTCAST_CREATOR_RAKE_SHARE_PARTNER_BPS,
      DEFAULT_TIER_SHARES_BPS.partner,
      "DOTCAST_CREATOR_RAKE_SHARE_PARTNER_BPS"
    )
  };
  const payoutMinMinorUnits = parseNonNegativeInt(
    env.DOTCAST_CREATOR_PAYOUT_MIN_MINOR_UNITS,
    DEFAULT_PAYOUT_MIN_MINOR_UNITS,
    "DOTCAST_CREATOR_PAYOUT_MIN_MINOR_UNITS"
  );
  const payoutMaxMinorUnits = parsePositiveInt(
    env.DOTCAST_CREATOR_PAYOUT_MAX_MINOR_UNITS,
    DEFAULT_PAYOUT_MAX_MINOR_UNITS,
    "DOTCAST_CREATOR_PAYOUT_MAX_MINOR_UNITS"
  );
  const payoutSchedule = parsePayoutSchedule(env.DOTCAST_CREATOR_PAYOUT_SCHEDULE);
  const minRetentionBps = parseBps(
    env.DOTCAST_CREATOR_MIN_RETENTION_BPS,
    DEFAULT_MIN_RETENTION_BPS,
    "DOTCAST_CREATOR_MIN_RETENTION_BPS"
  );
  const seedHandlingFeeBps = parseBps(
    env.DOTCAST_CREATOR_SEED_HANDLING_FEE_BPS,
    DEFAULT_SEED_HANDLING_FEE_BPS,
    "DOTCAST_CREATOR_SEED_HANDLING_FEE_BPS"
  );
  const rail = readSolanaUsdcSettlementRailStatus(env);
  const guards: string[] = [];

  if (!enabled) {
    guards.push("creator economy disabled");
  }

  if (!hasDatabase) {
    guards.push("creator economy database not configured");
  }

  if (!rail.ready) {
    guards.push("creator payouts require the E5 devnet mock settlement rail");
  }

  if (payoutMinMinorUnits > payoutMaxMinorUnits) {
    guards.push("creator payout minimum exceeds creator payout maximum");
  }

  return {
    enabled,
    ready: enabled && hasDatabase && rail.ready && guards.length === 0,
    tierSharesBps,
    payoutMinMinorUnits,
    payoutMaxMinorUnits,
    payoutSchedule,
    minRetentionBps,
    seedHandlingFeeBps,
    guards,
    integrityWall: creatorIntegrityWall()
  };
}

export async function onboardDotCastCreator(
  store: DotCastCreatorStore,
  env: DotCastCreatorEconomyEnv,
  input: OnboardCreatorInput,
  hasDatabase = true
): Promise<{ creator: DotCastCreatorProfile; status: DotCastCreatorEconomyStatus }> {
  const status = assertCreatorEconomyReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const existing = await store.getCreator(input.creatorId);
  const creator: DotCastCreatorProfile = {
    creatorId: requireText(input.creatorId, "creatorId"),
    displayName: requireText(input.displayName, "displayName"),
    tier: parseTier(input.tier ?? existing?.tier ?? "casual"),
    status: parseCreatorStatus(input.status ?? existing?.status ?? "active"),
    kycStatus: parseKycStatus(input.kycStatus ?? existing?.kycStatus ?? "unverified"),
    payoutDestination: parseNullableText(
      input.payoutDestination ?? existing?.payoutDestination ?? null,
      "payoutDestination"
    ),
    accuracyBps: parseBpsNumber(input.accuracyBps ?? existing?.accuracyBps ?? 5000, "accuracyBps"),
    retentionBps: parseBpsNumber(
      input.retentionBps ?? existing?.retentionBps ?? status.minRetentionBps,
      "retentionBps"
    ),
    volumeScore: parseNonNegativeNumber(input.volumeScore ?? existing?.volumeScore ?? 0),
    manualReviewRequired: input.manualReviewRequired ?? existing?.manualReviewRequired ?? true,
    sponsorshipEligible:
      input.sponsorshipEligible ?? existing?.sponsorshipEligible ?? input.tier === "verified",
    metadata: input.metadata ?? existing?.metadata ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  await store.upsertCreator(
    creator,
    creatorEvent(existing ? "CREATOR_UPDATED" : "CREATOR_ONBOARDED", creator, null, null, null, {
      tier: creator.tier,
      kycStatus: creator.kycStatus,
      manualReviewRequired: creator.manualReviewRequired
    })
  );

  return { creator, status };
}

export async function readDotCastCreatorSummary(
  store: DotCastCreatorStore,
  creatorId: string,
  limit = 25
): Promise<DotCastCreatorSummary> {
  const creator = await store.getCreator(requireText(creatorId, "creatorId"));

  if (!creator) {
    throw new DotCastCreatorEconomyError("CREATOR_NOT_FOUND", "dotCast creator was not found", 404);
  }

  const safeLimit = parseLimit(limit);
  const [balances, recentAccruals, recentPayouts] = await Promise.all([
    store.listBalances(creator.creatorId),
    store.listAccruals(creator.creatorId, safeLimit),
    store.listPayouts(creator.creatorId, safeLimit)
  ]);

  return { creator, balances, recentAccruals, recentPayouts };
}

export async function applyDotCastCreatorRakeShareSettlement(
  store: DotCastCreatorStore,
  env: DotCastCreatorEconomyEnv,
  input: ApplyCreatorRakeShareInput,
  hasDatabase = true
): Promise<ApplyCreatorRakeShareResult> {
  const status = assertCreatorEconomyReady(env, hasDatabase);
  const snapshot = input.snapshot;
  const now = input.now ?? snapshot.updatedAt ?? new Date().toISOString();
  const creatorId = snapshot.pool.originatingCreatorId ?? null;

  if (!creatorId) {
    return {
      applied: false,
      idempotent: false,
      creator: null,
      accrual: null,
      balance: null,
      status
    };
  }

  if (snapshot.pool.status !== "settled" || !snapshot.settlement) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_SETTLEMENT_REQUIRES_SETTLED_POOL",
      "creator rake-share accrual requires a settled pool snapshot",
      409
    );
  }

  const existing = await store.getAccrualByPool(snapshot.pool.id);
  if (existing) {
    const balance = await store.getBalance(existing.creatorId, existing.unit);
    return {
      applied: true,
      idempotent: true,
      creator: await store.getCreator(existing.creatorId),
      accrual: existing,
      balance,
      status
    };
  }

  const creator = await store.getCreator(creatorId);
  if (creator?.status !== "active") {
    throw new DotCastCreatorEconomyError(
      "CREATOR_NOT_ACTIVE",
      "creator rake-share requires an active onboarded creator",
      409
    );
  }

  const effectiveShareBps = calculateCreatorEffectiveShareBps(creator, status);
  const creatorShare = Math.floor((snapshot.settlement.rakeAmount * effectiveShareBps) / 10_000);
  const houseShare = snapshot.settlement.rakeAmount - creatorShare;
  const previousBalance =
    (await store.getBalance(creator.creatorId, snapshot.pool.unit)) ??
    emptyBalance(creator.creatorId, snapshot.pool.unit, now);
  const balance: DotCastCreatorEarningsBalance = {
    ...previousBalance,
    available: previousBalance.available + creatorShare,
    lifetimeAccrued: previousBalance.lifetimeAccrued + creatorShare,
    updatedAt: now
  };
  const accrual: DotCastCreatorRakeAccrual = {
    accrualId: `dotcast:e11:accrual:${snapshot.pool.id}:${snapshot.settlement.id}`,
    poolId: snapshot.pool.id,
    settlementId: snapshot.settlement.id,
    creatorId: creator.creatorId,
    unit: snapshot.pool.unit,
    totalRake: snapshot.settlement.rakeAmount,
    creatorShare,
    houseShare,
    tier: creator.tier,
    tierShareBps: status.tierSharesBps[creator.tier],
    effectiveShareBps,
    accuracyBps: creator.accuracyBps,
    retentionBps: creator.retentionBps,
    idempotencyKey: `dotcast:e11:rake-share:${snapshot.pool.id}:${snapshot.settlement.id}`,
    eventJson: {
      source: "pool_settlement",
      conservation: creatorShare + houseShare === snapshot.settlement.rakeAmount,
      manualReviewRequired: creator.manualReviewRequired,
      volumeScoreIgnoredAsSoleBasis: true
    },
    createdAt: now
  };

  await store.applyAccrual(
    accrual,
    balance,
    creatorEvent(
      "CREATOR_RAKE_ACCRUED",
      creator,
      snapshot.pool.id,
      snapshot.pool.unit,
      creatorShare,
      {
        accrualId: accrual.accrualId,
        settlementId: accrual.settlementId,
        totalRake: accrual.totalRake,
        creatorShare,
        houseShare,
        effectiveShareBps
      }
    )
  );

  return { applied: true, idempotent: false, creator, accrual, balance, status };
}

export async function requestDotCastCreatorPayout(
  store: DotCastCreatorStore,
  railStore: DotCastSettlementRailStore,
  env: DotCastCreatorEconomyEnv,
  input: RequestCreatorPayoutInput,
  hasDatabase = true
): Promise<RequestCreatorPayoutResult> {
  const status = assertCreatorEconomyReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  const existing = await store.getPayoutByIdempotencyKey(idempotencyKey);

  if (existing) {
    return {
      idempotent: true,
      payout: existing,
      balance: await requireCreatorBalance(store, existing.creatorId, "usdc"),
      status
    };
  }

  const creator = await requireActiveCreator(store, input.creatorId);
  if (creator.kycStatus !== "verified") {
    throw new DotCastCreatorEconomyError(
      "CREATOR_PAYOUT_REQUIRES_KYC",
      "creator payout requires a KYC-verified creator identity",
      403
    );
  }

  if (status.payoutSchedule === "manual" && input.operatorApproved !== true) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_PAYOUT_REQUIRES_OPERATOR_APPROVAL",
      "manual creator payout schedule requires operator approval",
      403
    );
  }

  const amount = parseMinorUnits(input.amount, "amount");
  if (amount < status.payoutMinMinorUnits) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_PAYOUT_BELOW_MINIMUM",
      "creator payout amount is below the configured minimum",
      400
    );
  }

  if (amount > status.payoutMaxMinorUnits) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_PAYOUT_EXCEEDS_MAXIMUM",
      "creator payout amount exceeds the configured maximum",
      400
    );
  }

  const balance = await requireCreatorBalance(store, creator.creatorId, "usdc");
  if (balance.available < amount) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_EARNINGS_BALANCE_INSUFFICIENT",
      "creator available USDC earnings are insufficient for payout",
      409
    );
  }

  const destination =
    input.destination ??
    creator.payoutDestination ??
    failText("creator payout destination missing");
  const railUserId = creatorRailUserId(creator.creatorId);
  const railBalance = await readSettlementBalance(railStore, railUserId, now);
  if (railBalance.availableUsdc < balance.available) {
    await railStore.saveBalance({
      ...railBalance,
      availableUsdc: balance.available,
      updatedAt: now
    });
  }

  const railResult = await requestDevnetWithdrawal(railStore, env, {
    userId: railUserId,
    amount,
    destination,
    idempotencyKey: `creator:${idempotencyKey}`,
    now
  });
  const payout: DotCastCreatorPayout = {
    payoutId: `dotcast:e11:payout:${creator.creatorId}:${idempotencyKey}`,
    creatorId: creator.creatorId,
    unit: "usdc",
    amount,
    status: "signed",
    destination,
    idempotencyKey,
    railTransferId: railResult.transfer.transferId,
    railTxRef: railResult.transfer.txRef,
    mockSignature: railResult.transfer.mockSignature,
    requestedAt: now,
    updatedAt: now,
    eventJson: {
      rail: "p5-solana-usdc",
      signerMode: railResult.rail.signerMode,
      broadcast: railResult.broadcast,
      schedule: status.payoutSchedule
    }
  };
  const nextBalance: DotCastCreatorEarningsBalance = {
    ...balance,
    available: balance.available - amount,
    pendingPayout: balance.pendingPayout + amount,
    updatedAt: now
  };

  await store.insertPayout(
    payout,
    nextBalance,
    creatorEvent("CREATOR_PAYOUT_REQUESTED", creator, null, "usdc", amount, {
      payoutId: payout.payoutId,
      railTransferId: payout.railTransferId,
      status: payout.status
    })
  );

  return { idempotent: false, payout, balance: nextBalance, status };
}

export async function confirmDotCastCreatorPayout(
  store: DotCastCreatorStore,
  railStore: DotCastSettlementRailStore,
  env: DotCastCreatorEconomyEnv,
  input: ConfirmCreatorPayoutInput,
  hasDatabase = true
): Promise<ConfirmCreatorPayoutResult> {
  const status = assertCreatorEconomyReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const payout = await store.getPayout(requireText(input.payoutId, "payoutId"));

  if (!payout) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_PAYOUT_NOT_FOUND",
      "creator payout was not found",
      404
    );
  }

  if (payout.status === "confirmed") {
    return {
      idempotent: true,
      payout,
      balance: await requireCreatorBalance(store, payout.creatorId, "usdc"),
      status
    };
  }

  if (!payout.railTransferId) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_PAYOUT_MISSING_RAIL_TRANSFER",
      "creator payout is missing a settlement rail transfer",
      409
    );
  }

  const creator = await requireActiveCreator(store, payout.creatorId);
  const railResult = await confirmMockWithdrawal(railStore, env, {
    transferId: payout.railTransferId,
    txRef: input.txRef,
    now
  });
  const balance = await requireCreatorBalance(store, payout.creatorId, "usdc");
  const nextBalance: DotCastCreatorEarningsBalance = {
    ...balance,
    pendingPayout: Math.max(0, balance.pendingPayout - payout.amount),
    lifetimePaid: balance.lifetimePaid + payout.amount,
    updatedAt: now
  };
  const confirmed: DotCastCreatorPayout = {
    ...payout,
    status: "confirmed",
    railTxRef: railResult.transfer.txRef,
    mockSignature: railResult.transfer.mockSignature,
    updatedAt: now,
    eventJson: {
      ...payout.eventJson,
      confirmedAt: now,
      railStatus: railResult.status
    }
  };

  await store.updatePayout(
    confirmed,
    nextBalance,
    creatorEvent("CREATOR_PAYOUT_CONFIRMED", creator, null, "usdc", payout.amount, {
      payoutId: payout.payoutId,
      railTransferId: payout.railTransferId,
      txRef: confirmed.railTxRef
    })
  );

  return { idempotent: false, payout: confirmed, balance: nextBalance, status };
}

export function planCreatorPoolNudges(input: CreatorNudgePlanInput): CreatorNudgePlan {
  const now = input.now ?? new Date().toISOString();
  assertNoUrgencyTooling(input.metadata ?? {});

  const allowed: CreatorNudgeRecipient[] = [];
  const suppressed: CreatorNudgePlan["suppressed"] = [];

  for (const recipient of input.recipients) {
    const reason = nudgeSuppressionReason(recipient, now);

    if (reason) {
      suppressed.push({ ...recipient, reason });
    } else {
      allowed.push(recipient);
    }
  }

  return {
    creatorId: requireText(input.creatorId, "creatorId"),
    poolId: requireText(input.poolId, "poolId"),
    allowed,
    suppressed,
    integrity: creatorIntegrityWall()
  };
}

export async function recordDotCastCreatorPoolSeed(
  store: DotCastCreatorStore,
  env: DotCastCreatorEconomyEnv,
  input: RecordCreatorSeedInput,
  hasDatabase = true
): Promise<{ seed: DotCastCreatorPoolSeed; status: DotCastCreatorEconomyStatus }> {
  const status = assertCreatorEconomyReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const creator = await requireActiveCreator(store, input.creatorId);
  const mode = parseSeedMode(input.mode);
  const resolutionBinding = parseResolutionBinding(input.resolutionBinding);

  if (resolutionBinding !== "oracle_bound") {
    throw new DotCastCreatorEconomyError(
      "CREATOR_SEED_REQUIRES_ORACLE_BOUND_MARKET",
      "creator seed-as-boost is only accepted on oracle-bound markets",
      409
    );
  }

  const seed: DotCastCreatorPoolSeed = {
    seedId:
      input.seedId ?? `dotcast:e11:seed:${input.creatorId}:${input.poolId}:${Date.parse(now)}`,
    creatorId: creator.creatorId,
    poolId: requireText(input.poolId, "poolId"),
    unit: parseStakeUnit(input.unit),
    amount: parseMinorUnits(input.amount, "amount"),
    mode,
    resolutionBinding,
    status: "accepted",
    disclosureLabel: "Creator seed",
    creatorHoldsPosition: input.creatorHoldsPosition ?? false,
    eventJson: {
      ...(input.eventJson ?? {}),
      seedHandlingFeeBps: status.seedHandlingFeeBps,
      seedAmountRaked: false,
      resolutionInfluence: false
    },
    createdAt: now
  };

  await store.insertSeed(
    seed,
    creatorEvent("CREATOR_SEED_RECORDED", creator, seed.poolId, seed.unit, seed.amount, {
      seedId: seed.seedId,
      mode: seed.mode,
      disclosureLabel: seed.disclosureLabel,
      resolutionBinding: seed.resolutionBinding
    })
  );

  return { seed, status };
}

export function calculateCreatorEffectiveShareBps(
  creator: DotCastCreatorProfile,
  status: DotCastCreatorEconomyStatus
): number {
  const baseShare = status.tierSharesBps[creator.tier];

  if (creator.manualReviewRequired) {
    return baseShare;
  }

  const accuracyComponent = Math.floor(creator.accuracyBps * 0.35);
  const retentionComponent = Math.floor(creator.retentionBps * 0.55);
  const healthyFloorComponent = 1000;
  const qualityBps = clampBps(healthyFloorComponent + accuracyComponent + retentionComponent);

  return Math.floor((baseShare * qualityBps) / 10_000);
}

export function creatorRailUserId(creatorId: string): string {
  return `creator:${requireText(creatorId, "creatorId")}`;
}

function assertCreatorEconomyReady(
  env: DotCastCreatorEconomyEnv,
  hasDatabase: boolean
): DotCastCreatorEconomyStatus {
  const status = readDotCastCreatorEconomyStatus(env, hasDatabase);

  if (!status.ready) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_ECONOMY_NOT_READY",
      status.guards.join("; ") || "E11 creator economy is not ready",
      503
    );
  }

  return status;
}

async function requireActiveCreator(
  store: DotCastCreatorStore,
  creatorId: string
): Promise<DotCastCreatorProfile> {
  const creator = await store.getCreator(requireText(creatorId, "creatorId"));

  if (creator?.status !== "active") {
    throw new DotCastCreatorEconomyError(
      "CREATOR_NOT_ACTIVE",
      "creator is not active or has not been onboarded",
      409
    );
  }

  return creator;
}

async function requireCreatorBalance(
  store: DotCastCreatorStore,
  creatorId: string,
  unit: StakeUnit
): Promise<DotCastCreatorEarningsBalance> {
  const balance = await store.getBalance(creatorId, unit);

  if (!balance) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_EARNINGS_BALANCE_NOT_FOUND",
      "creator earnings balance was not found",
      404
    );
  }

  return balance;
}

function nudgeSuppressionReason(recipient: CreatorNudgeRecipient, now: string): string | null {
  if (recipient.blockedByResponsiblePlay) {
    return "responsible_play_block";
  }

  if (recipient.selfLimited) {
    return "self_limit";
  }

  if (recipient.lossLimited) {
    return "loss_limit";
  }

  if (recipient.cooldownUntil && Date.parse(recipient.cooldownUntil) > Date.parse(now)) {
    return "cooldown";
  }

  return null;
}

function assertNoUrgencyTooling(metadata: Record<string, unknown>): void {
  for (const key of Object.keys(metadata)) {
    if (PROHIBITED_URGENCY_FIELDS.has(key)) {
      throw new DotCastCreatorEconomyError(
        "CREATOR_URGENCY_TOOLING_BLOCKED",
        `creator tooling cannot set urgency field ${key}`,
        400
      );
    }
  }
}

function creatorIntegrityWall(): DotCastCreatorEconomyStatus["integrityWall"] {
  return {
    resolutionWriteAccess: false,
    oddsWriteAccess: false,
    userLimitBypass: false,
    urgencyTooling: false,
    separateCreatorLedger: true,
    payoutRail: "p5-solana-usdc"
  };
}

function creatorEvent(
  eventType: DotCastCreatorEvent["eventType"],
  creator: DotCastCreatorProfile,
  poolId: string | null,
  unit: StakeUnit | null,
  amount: number | null,
  eventJson: Record<string, unknown>
): DotCastCreatorEvent {
  const createdAt =
    typeof eventJson.createdAt === "string" ? eventJson.createdAt : new Date().toISOString();

  return {
    eventId: `dotcast:e11:event:${creator.creatorId}:${eventType}:${poolId ?? "none"}:${Date.parse(
      createdAt
    )}:${amount ?? 0}`,
    creatorId: creator.creatorId,
    poolId,
    eventType,
    unit,
    amount,
    eventJson,
    createdAt
  };
}

function emptyBalance(
  creatorId: string,
  unit: StakeUnit,
  now: string
): DotCastCreatorEarningsBalance {
  return {
    creatorId,
    unit,
    available: 0,
    pendingPayout: 0,
    lifetimeAccrued: 0,
    lifetimePaid: 0,
    updatedAt: now
  };
}

function creatorSelectSql(where: string): string {
  return `SELECT creator_id, display_name, tier, status, kyc_status, payout_destination,
                 accuracy_bps, retention_bps, volume_score, manual_review_required,
                 sponsorship_eligible, metadata_json, created_at, updated_at
          FROM dotcast_creators
          WHERE ${where}`;
}

function creatorUpsertSql(): string {
  return `INSERT INTO dotcast_creators (
            creator_id, display_name, tier, status, kyc_status, payout_destination,
            accuracy_bps, retention_bps, volume_score, manual_review_required,
            sponsorship_eligible, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(creator_id) DO UPDATE SET
            display_name = excluded.display_name,
            tier = excluded.tier,
            status = excluded.status,
            kyc_status = excluded.kyc_status,
            payout_destination = excluded.payout_destination,
            accuracy_bps = excluded.accuracy_bps,
            retention_bps = excluded.retention_bps,
            volume_score = excluded.volume_score,
            manual_review_required = excluded.manual_review_required,
            sponsorship_eligible = excluded.sponsorship_eligible,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at`;
}

function balanceUpsertSql(): string {
  return `INSERT INTO dotcast_creator_earnings_balances (
            creator_id, unit, available, pending_payout, lifetime_accrued, lifetime_paid, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(creator_id, unit) DO UPDATE SET
            available = excluded.available,
            pending_payout = excluded.pending_payout,
            lifetime_accrued = excluded.lifetime_accrued,
            lifetime_paid = excluded.lifetime_paid,
            updated_at = excluded.updated_at`;
}

function accrualSelectSql(where: string): string {
  return `SELECT accrual_id, pool_id, settlement_id, creator_id, unit, total_rake,
                 creator_share, house_share, tier, tier_share_bps, effective_share_bps,
                 accuracy_bps, retention_bps, idempotency_key, event_json, created_at
          FROM dotcast_creator_rake_accruals
          WHERE ${where}`;
}

function accrualInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_creator_rake_accruals (
            accrual_id, pool_id, settlement_id, creator_id, unit, total_rake,
            creator_share, house_share, tier, tier_share_bps, effective_share_bps,
            accuracy_bps, retention_bps, idempotency_key, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function payoutSelectSql(where: string): string {
  return `SELECT payout_id, creator_id, unit, amount, status, destination, idempotency_key,
                 rail_transfer_id, rail_tx_ref, mock_signature, requested_at, updated_at,
                 event_json
          FROM dotcast_creator_payouts
          WHERE ${where}`;
}

function payoutInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_creator_payouts (
            payout_id, creator_id, unit, amount, status, destination, idempotency_key,
            rail_transfer_id, rail_tx_ref, mock_signature, requested_at, updated_at, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function seedInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_creator_pool_seeds (
            seed_id, creator_id, pool_id, unit, amount, mode, resolution_binding, status,
            disclosure_label, creator_holds_position, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function eventInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_creator_events (
            event_id, creator_id, pool_id, event_type, unit, amount, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
}

function creatorParams(creator: DotCastCreatorProfile): unknown[] {
  return [
    creator.creatorId,
    creator.displayName,
    creator.tier,
    creator.status,
    creator.kycStatus,
    creator.payoutDestination,
    creator.accuracyBps,
    creator.retentionBps,
    creator.volumeScore,
    creator.manualReviewRequired ? 1 : 0,
    creator.sponsorshipEligible ? 1 : 0,
    JSON.stringify(creator.metadata),
    creator.createdAt,
    creator.updatedAt
  ];
}

function balanceParams(balance: DotCastCreatorEarningsBalance): unknown[] {
  return [
    balance.creatorId,
    balance.unit,
    balance.available,
    balance.pendingPayout,
    balance.lifetimeAccrued,
    balance.lifetimePaid,
    balance.updatedAt
  ];
}

function accrualParams(accrual: DotCastCreatorRakeAccrual): unknown[] {
  return [
    accrual.accrualId,
    accrual.poolId,
    accrual.settlementId,
    accrual.creatorId,
    accrual.unit,
    accrual.totalRake,
    accrual.creatorShare,
    accrual.houseShare,
    accrual.tier,
    accrual.tierShareBps,
    accrual.effectiveShareBps,
    accrual.accuracyBps,
    accrual.retentionBps,
    accrual.idempotencyKey,
    JSON.stringify(accrual.eventJson),
    accrual.createdAt
  ];
}

function payoutParams(payout: DotCastCreatorPayout): unknown[] {
  return [
    payout.payoutId,
    payout.creatorId,
    payout.unit,
    payout.amount,
    payout.status,
    payout.destination,
    payout.idempotencyKey,
    payout.railTransferId,
    payout.railTxRef,
    payout.mockSignature,
    payout.requestedAt,
    payout.updatedAt,
    JSON.stringify(payout.eventJson)
  ];
}

function seedParams(seed: DotCastCreatorPoolSeed): unknown[] {
  return [
    seed.seedId,
    seed.creatorId,
    seed.poolId,
    seed.unit,
    seed.amount,
    seed.mode,
    seed.resolutionBinding,
    seed.status,
    seed.disclosureLabel,
    seed.creatorHoldsPosition ? 1 : 0,
    JSON.stringify(seed.eventJson),
    seed.createdAt
  ];
}

function eventParams(event: DotCastCreatorEvent): unknown[] {
  return [
    event.eventId,
    event.creatorId,
    event.poolId,
    event.eventType,
    event.unit,
    event.amount,
    JSON.stringify(event.eventJson),
    event.createdAt
  ];
}

function creatorFromRow(row: CreatorRow): DotCastCreatorProfile {
  return {
    creatorId: requireRowText(row.creator_id, "creator_id"),
    displayName: requireRowText(row.display_name, "display_name"),
    tier: parseTier(row.tier),
    status: parseCreatorStatus(row.status),
    kycStatus: parseKycStatus(row.kyc_status),
    payoutDestination: parseNullableText(row.payout_destination, "payout_destination"),
    accuracyBps: requireRowInt(row.accuracy_bps, "accuracy_bps"),
    retentionBps: requireRowInt(row.retention_bps, "retention_bps"),
    volumeScore: requireRowInt(row.volume_score, "volume_score"),
    manualReviewRequired: Number(row.manual_review_required ?? 0) === 1,
    sponsorshipEligible: Number(row.sponsorship_eligible ?? 0) === 1,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: requireRowText(row.created_at, "created_at"),
    updatedAt: requireRowText(row.updated_at, "updated_at")
  };
}

function balanceFromRow(row: CreatorRow): DotCastCreatorEarningsBalance {
  return {
    creatorId: requireRowText(row.creator_id, "creator_id"),
    unit: parseStakeUnit(row.unit),
    available: requireRowInt(row.available, "available"),
    pendingPayout: requireRowInt(row.pending_payout, "pending_payout"),
    lifetimeAccrued: requireRowInt(row.lifetime_accrued, "lifetime_accrued"),
    lifetimePaid: requireRowInt(row.lifetime_paid, "lifetime_paid"),
    updatedAt: requireRowText(row.updated_at, "updated_at")
  };
}

function accrualFromRow(row: CreatorRow): DotCastCreatorRakeAccrual {
  return {
    accrualId: requireRowText(row.accrual_id, "accrual_id"),
    poolId: requireRowText(row.pool_id, "pool_id"),
    settlementId: requireRowText(row.settlement_id, "settlement_id"),
    creatorId: requireRowText(row.creator_id, "creator_id"),
    unit: parseStakeUnit(row.unit),
    totalRake: requireRowInt(row.total_rake, "total_rake"),
    creatorShare: requireRowInt(row.creator_share, "creator_share"),
    houseShare: requireRowInt(row.house_share, "house_share"),
    tier: parseTier(row.tier),
    tierShareBps: requireRowInt(row.tier_share_bps, "tier_share_bps"),
    effectiveShareBps: requireRowInt(row.effective_share_bps, "effective_share_bps"),
    accuracyBps: requireRowInt(row.accuracy_bps, "accuracy_bps"),
    retentionBps: requireRowInt(row.retention_bps, "retention_bps"),
    idempotencyKey: requireRowText(row.idempotency_key, "idempotency_key"),
    eventJson: parseJsonObject(row.event_json),
    createdAt: requireRowText(row.created_at, "created_at")
  };
}

function payoutFromRow(row: CreatorRow): DotCastCreatorPayout {
  return {
    payoutId: requireRowText(row.payout_id, "payout_id"),
    creatorId: requireRowText(row.creator_id, "creator_id"),
    unit: "usdc",
    amount: requireRowInt(row.amount, "amount"),
    status: parsePayoutStatus(row.status),
    destination: requireRowText(row.destination, "destination"),
    idempotencyKey: requireRowText(row.idempotency_key, "idempotency_key"),
    railTransferId: parseNullableText(row.rail_transfer_id, "rail_transfer_id"),
    railTxRef: parseNullableText(row.rail_tx_ref, "rail_tx_ref"),
    mockSignature: parseNullableText(row.mock_signature, "mock_signature"),
    requestedAt: requireRowText(row.requested_at, "requested_at"),
    updatedAt: requireRowText(row.updated_at, "updated_at"),
    eventJson: parseJsonObject(row.event_json)
  };
}

function parseTier(value: unknown): DotCastCreatorTier {
  if (value === "casual" || value === "verified" || value === "partner") {
    return value;
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_TIER", "creator tier is invalid", 400);
}

function parseCreatorStatus(value: unknown): DotCastCreatorStatus {
  if (value === "active" || value === "suspended" || value === "archived") {
    return value;
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_STATUS", "creator status is invalid", 400);
}

function parseKycStatus(value: unknown): DotCastCreatorKycStatus {
  if (value === "unverified" || value === "verified" || value === "rejected") {
    return value;
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_KYC", "creator KYC status is invalid", 400);
}

function parsePayoutStatus(value: unknown): DotCastCreatorPayout["status"] {
  if (
    value === "requested" ||
    value === "signed" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "rejected"
  ) {
    return value;
  }

  throw new DotCastCreatorEconomyError(
    "INVALID_CREATOR_PAYOUT_STATUS",
    "creator payout status is invalid",
    500
  );
}

function parsePayoutSchedule(value: string | undefined): DotCastCreatorPayoutSchedule {
  if (value === "manual" || value === "weekly" || value === "on_demand") {
    return value;
  }

  return "manual";
}

function parseSeedMode(value: unknown): DotCastCreatorSeedMode {
  if (value === "boost_winners" || value === "void_insurance" || value === "bonus_pool") {
    return value;
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_SEED_MODE", "seed mode is invalid", 400);
}

function parseResolutionBinding(value: unknown): DotCastResolutionBinding {
  if (
    value === "oracle_bound" ||
    value === "optimistic" ||
    value === "jury" ||
    value === "unknown"
  ) {
    return value;
  }

  throw new DotCastCreatorEconomyError(
    "INVALID_CREATOR_SEED_RESOLUTION_BINDING",
    "resolution binding is invalid",
    400
  );
}

function parseStakeUnit(value: unknown): StakeUnit {
  if (value === "points" || value === "usdc") {
    return value;
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_UNIT", "unit must be points or usdc", 400);
}

function parseBps(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  return parseBpsNumber(Number(value), label);
}

function parseBpsNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new DotCastCreatorEconomyError(
      "INVALID_CREATOR_BPS",
      `${label} must be an integer from 0 to 10000`,
      400
    );
  }

  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed <= 0) {
    throw new DotCastCreatorEconomyError(
      "INVALID_CREATOR_CONFIG",
      `${label} must be positive`,
      500
    );
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed < 0) {
    throw new DotCastCreatorEconomyError(
      "INVALID_CREATOR_CONFIG",
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
    throw new DotCastCreatorEconomyError(
      "INVALID_CREATOR_CONFIG",
      `${label} must be a safe integer`,
      500
    );
  }

  return parsed;
}

function parseLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 25;
  }

  return Math.min(100, value);
}

function parseMinorUnits(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DotCastCreatorEconomyError(
      "INVALID_CREATOR_AMOUNT",
      `${label} must be a positive integer minor-unit amount`,
      400
    );
  }

  return value;
}

function parseNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DotCastCreatorEconomyError(
      "INVALID_CREATOR_SCORE",
      "creator score must be a non-negative integer",
      400
    );
  }

  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_INPUT", `${label} is required`, 400);
}

function failText(message: string): never {
  throw new DotCastCreatorEconomyError("INVALID_CREATOR_INPUT", message, 400);
}

function parseNullableText(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return requireText(value, label);
}

function requireRowText(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new DotCastCreatorEconomyError("INVALID_CREATOR_ROW", `${label} is required`, 500);
}

function requireRowInt(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  throw new DotCastCreatorEconomyError(
    "INVALID_CREATOR_ROW",
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

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, value));
}

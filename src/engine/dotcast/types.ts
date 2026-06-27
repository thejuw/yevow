export type DotCastVenue = "kalshi" | "polymarket" | "dotcast" | "unknown";

export type StakeUnit = "points" | "usdc";

export type DotCastCreatorTier = "casual" | "verified" | "partner";

export type DotCastCreatorStatus = "active" | "suspended" | "archived";

export type DotCastCreatorKycStatus = "unverified" | "verified" | "rejected";

export type DotCastCreatorPayoutSchedule = "manual" | "weekly" | "on_demand";

export type DotCastCreatorPayoutStatus =
  | "requested"
  | "signed"
  | "confirmed"
  | "failed"
  | "rejected";

export type DotCastCreatorEventType =
  | "CREATOR_ONBOARDED"
  | "CREATOR_UPDATED"
  | "CREATOR_RAKE_ACCRUED"
  | "CREATOR_PAYOUT_REQUESTED"
  | "CREATOR_PAYOUT_CONFIRMED"
  | "CREATOR_PAYOUT_REJECTED"
  | "CREATOR_SEED_RECORDED"
  | "CREATOR_NUDGE_SUPPRESSED";

export type DotCastCreatorSeedMode = "boost_winners" | "void_insurance" | "bonus_pool";

export type DotCastResolutionBinding = "oracle_bound" | "optimistic" | "jury" | "unknown";

export type DotCastResolutionTier =
  | "hard_oracle"
  | "computed_oracle"
  | "ai_perception"
  | "optimistic_bonded"
  | "human_jury";

export type DotCastResolutionRouteStatus = "locked" | "review_required" | "points_only" | "blocked";

export type DotCastResolutionSourceKind =
  | "router_market"
  | "external_oracle"
  | "computed_feed"
  | "livestream_ai"
  | "resolver_network"
  | "manual_review";

export interface DotCastResolutionSource {
  kind: DotCastResolutionSourceKind;
  label: string;
  url: string | null;
  required: boolean;
}

export interface DotCastResolutionRoute {
  routeId: string;
  marketId: string;
  poolId: string | null;
  tier: DotCastResolutionTier;
  status: DotCastResolutionRouteStatus;
  confidenceBps: number;
  resolutionStatement: string;
  sources: DotCastResolutionSource[];
  sourceAvailable: boolean;
  autoResolvable: boolean;
  reviewRequired: boolean;
  pointsOnly: boolean;
  blockedReason: string | null;
  steeringPrompt: string | null;
  feeBps: number;
  bondMinorUnits: number;
  panelSize: number;
  lockedAt: string | null;
  classifierVersion: string;
  createdAt: string;
  eventJson: Record<string, unknown>;
}

export interface DotCastAiResolutionLog {
  logId: string;
  routeId: string;
  poolId: string | null;
  modelConfidenceBps: number;
  predictedOutcome: DotCastResolutionOutcome;
  action: "auto_resolved" | "escalated";
  thresholdBps: number;
  evidenceRefs: string[];
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastResolverProfile {
  resolverId: string;
  identityHash: string;
  reputationBps: number;
  bondAvailableMinorUnits: number;
  stakeHeldPoolIds: string[];
}

export type DotCastResolverStatus = "active" | "suspended" | "archived";

export interface DotCastResolverRegistryProfile extends DotCastResolverProfile {
  status: DotCastResolverStatus;
  displayName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type DotCastResolverBondLedgerEventType =
  | "resolver_onboarded"
  | "bond_deposited"
  | "assignment_locked"
  | "bond_released"
  | "bond_slashed"
  | "fee_credited"
  | "manual_adjustment";

export interface DotCastResolverBondLedgerEntry {
  entryId: string;
  resolverId: string;
  assignmentId: string | null;
  panelId: string | null;
  eventType: DotCastResolverBondLedgerEventType;
  deltaMinorUnits: number;
  balanceAfterMinorUnits: number;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastResolverReputationEvent {
  eventId: string;
  resolverId: string;
  assignmentId: string | null;
  panelId: string | null;
  previousReputationBps: number;
  newReputationBps: number;
  deltaBps: number;
  reason: "settlement_consensus_match" | "settlement_consensus_miss" | "manual_adjustment";
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastResolverAssignment {
  assignmentId: string;
  panelId: string;
  poolId: string;
  routeId: string;
  resolverId: string;
  identityHash: string;
  reputationBps: number;
  bondMinorUnits: number;
  status: "assigned" | "committed" | "revealed" | "paid" | "slashed";
  assignedAt: string;
}

export interface DotCastResolverPanel {
  panelId: string;
  poolId: string;
  routeId: string;
  tier: DotCastResolutionTier;
  panelSize: number;
  estimatedStakeMinorUnits: number;
  resolverFeeBps: number;
  assignments: DotCastResolverAssignment[];
  createdAt: string;
}

export interface DotCastResolverCommit {
  assignmentId: string;
  panelId: string;
  resolverId: string;
  commitHash: string;
  committedAt: string;
}

export interface DotCastResolverReveal {
  assignmentId: string;
  panelId: string;
  resolverId: string;
  outcome: Side | "invalid";
  salt: string;
  revealedAt: string;
}

export interface DotCastResolverPayout {
  assignmentId: string;
  panelId: string;
  resolverId: string;
  matchedConsensus: boolean;
  bondReturnedMinorUnits: number;
  feePaidMinorUnits: number;
  slashedBondMinorUnits: number;
  createdAt: string;
}

export type DotCastResolutionReviewStatus = "queued" | "approved" | "denied" | "reshaped";

export type DotCastResolutionReviewAction = "approve" | "deny" | "reshape";

export interface DotCastResolutionReview {
  reviewId: string;
  routeId: string;
  poolId: string | null;
  marketId: string;
  status: DotCastResolutionReviewStatus;
  reviewerId: string | null;
  decisionJson: Record<string, unknown>;
  createdAt: string;
}

export type DotCastReferralQualifier = "first_deposit" | "kyc_plus_first_entry";

export type DotCastReferralQualificationEvent = DotCastReferralQualifier | "signup";

export type DotCastReferralCodeStatus = "active" | "disabled";

export type DotCastReferralStatus = "claimed" | "qualified" | "rewarded" | "rejected";

export type DotCastReferralRewardRole = "referrer" | "referred";

export type DotCastReferralRewardStatus = "granted" | "suppressed";

export type DotCastReferralAmlSeverity = "medium" | "high";

export type DotCastReferralEventType =
  | "REFERRAL_CODE_CREATED"
  | "REFERRAL_CLAIMED"
  | "REFERRAL_QUALIFIED"
  | "REFERRAL_REWARDED"
  | "REFERRAL_REJECTED"
  | "REFERRAL_AML_FLAGGED";

export type DotCastMarketStatus = "open" | "closed" | "settled" | "cancelled" | "voided";

export type PoolStatus = "open" | "locked" | "resolving" | "settled" | "voided";

export type Side = "yes" | "no";

export type DotCastResolutionOutcome = Side | "invalid" | "pending";

export type DotCastVoidReason =
  | "UNDER_LIQUIDITY"
  | "ONE_SIDED_POOL"
  | "NO_WINNING_ENTRIES"
  | "INVALID_RESOLUTION"
  | "GRACE_TIMEOUT"
  | "SOURCE_CANCELLED"
  | "ADMIN_VOID";

export interface SideTotals {
  yes: number;
  no: number;
}

export interface DotCastReferencePrice {
  marketId: string;
  venue: DotCastVenue;
  price: SideTotals;
  lastUpdated: string;
  stale: boolean;
  sourceLabel: string;
  referenceUrl: string | null;
  fetchedAt: string;
}

export interface DotCastLiveOddsSnapshot {
  poolId: string;
  marketId: string;
  status: PoolStatus;
  unit: StakeUnit;
  odds: SideTotals;
  pools: SideTotals;
  totalStaked: number;
  entryCount: number;
  updatedAt: string;
  previews: {
    yes: Record<string, number>;
    no: Record<string, number>;
  };
  hypothetical: {
    amount: number;
    payout: Record<Side, number>;
  } | null;
}

export interface DotCastPool {
  id: string;
  marketId: string;
  venue: DotCastVenue;
  unit: StakeUnit;
  question: string;
  status: PoolStatus;
  entryOpensAt: string;
  entryClosesAt: string;
  expectedResolveAt: string | null;
  rake: number;
  pools: SideTotals;
  minLiquidity: number;
  createdAt: string;
  settledAt: string | null;
  outcome: Side | "invalid" | null;
  originatingCreatorId?: string | null;
  creatorBrand?: DotCastCreatorPoolBranding | null;
  resolutionRoute?: DotCastResolutionRoute | null;
}

export interface DotCastCreatorPoolBranding {
  creatorId: string;
  displayName: string;
  disclosureLabel: "Creator-originated";
}

export interface DotCastMarketSnapshot {
  id: string;
  venue: DotCastVenue;
  question: string;
  status: DotCastMarketStatus;
  closeTime: string;
  expectedResolveAt: string | null;
  referenceUrl?: string;
}

export interface DotCastEntry {
  id: string;
  poolId: string;
  userId: string;
  side: Side;
  amount: number;
  funding: "user" | "house";
  placedAt: string;
  payout: number | null;
  refunded: boolean;
}

export interface StakeBalance {
  userId: string;
  unit: StakeUnit;
  available: number;
  locked: number;
}

export type DotCastSettlementRailMode = "disabled" | "devnet" | "mainnet";

export type DotCastSolanaCluster = "devnet" | "mainnet-beta";

export type DotCastSettlementSignerMode = "mock" | "external" | "unknown";

export type DotCastSettlementRailEventType =
  | "DEPOSIT_OBSERVED"
  | "DEPOSIT_CREDITED"
  | "DEPOSIT_REORGED"
  | "WITHDRAWAL_REQUESTED"
  | "WITHDRAWAL_SIGNED"
  | "WITHDRAWAL_CONFIRMED"
  | "WITHDRAWAL_FAILED"
  | "RECONCILIATION";

export type DotCastSettlementTransferKind = "deposit" | "withdrawal";

export type DotCastSettlementTransferStatus =
  | "observed"
  | "credited"
  | "reorged"
  | "requested"
  | "signed"
  | "confirmed"
  | "failed";

export interface DotCastSettlementRailStatus {
  mode: DotCastSettlementRailMode;
  network: "solana-devnet" | "solana-mainnet-beta";
  cluster: DotCastSolanaCluster;
  mint: string;
  decimals: 6;
  signerMode: DotCastSettlementSignerMode;
  depositConfirmationsRequired: number;
  withdrawalMaxMinorUnits: number;
  operatorWithdrawalsApproved: boolean;
  ready: boolean;
  operational: boolean;
  guards: string[];
}

export interface DotCastSettlementBalance {
  userId: string;
  availableUsdc: number;
  pendingDepositUsdc: number;
  pendingWithdrawalUsdc: number;
  lockedPoolUsdc: number;
  updatedAt: string;
}

export interface DotCastSettlementTransfer {
  transferId: string;
  userId: string;
  kind: DotCastSettlementTransferKind;
  status: DotCastSettlementTransferStatus;
  network: DotCastSettlementRailStatus["network"];
  cluster: DotCastSolanaCluster;
  mint: string;
  amount: number;
  txRef: string | null;
  destination: string | null;
  signerMode: DotCastSettlementSignerMode;
  mockSignature: string | null;
  requestedAt: string;
  updatedAt: string;
  eventJson: Record<string, unknown>;
}

export interface DotCastSettlementRailEvent {
  eventId: string;
  userId: string;
  eventType: DotCastSettlementRailEventType;
  network: DotCastSettlementRailStatus["network"];
  cluster: DotCastSolanaCluster;
  mint: string;
  amount: number | null;
  txRef: string | null;
  withdrawalId: string | null;
  status: DotCastSettlementTransferStatus | "reconciled" | null;
  reason: string | null;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export type DotCastUsdcPoolFundingLockStatus = "locked" | "released" | "settled" | "refunded";

export type DotCastUsdcPoolFundingEventType =
  | "POOL_ENTRY_RESERVED"
  | "POOL_ENTRY_RELEASED"
  | "POOL_ENTRY_SETTLED"
  | "POOL_ENTRY_REFUNDED";

export interface DotCastUsdcPoolFundingLock {
  lockId: string;
  poolId: string;
  entryId: string;
  userId: string;
  amount: number;
  status: DotCastUsdcPoolFundingLockStatus;
  payout: number | null;
  createdAt: string;
  updatedAt: string;
  eventJson: Record<string, unknown>;
}

export interface DotCastUsdcPoolFundingEvent {
  eventId: string;
  lockId: string;
  poolId: string;
  entryId: string;
  userId: string;
  eventType: DotCastUsdcPoolFundingEventType;
  amount: number;
  payout: number | null;
  status: DotCastUsdcPoolFundingLockStatus;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export type PointsLedgerReason =
  | "predict_correct"
  | "predict_incorrect"
  | "streak_bonus"
  | "free_entry_grant"
  | "free_entry_redeem"
  | "rewarded_stream"
  | "adjustment";

export interface PointsLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  reason: PointsLedgerReason;
  poolId: string | null;
  entryId: string | null;
  createdAt: string;
  balanceAfter: number;
  eventJson: Record<string, unknown>;
}

export interface FreeEntryCredit {
  id: string;
  userId: string;
  grantReason: "streak_bonus" | "manual_grant" | "rewarded_stream" | "referral" | "adjustment";
  poolId: string | null;
  grantedAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
  consumedByEntryId: string | null;
  eventJson: Record<string, unknown>;
}

export interface DotCastGamificationProfile {
  userId: string;
  pointsBalance: number;
  currentStreak: number;
  longestStreak: number;
  settledPredictions: number;
  correctPredictions: number;
  incorrectPredictions: number;
  freeEntriesGranted: number;
  freeEntriesConsumed: number;
  lastSettledPoolId: string | null;
  lastSettledAt: string | null;
  updatedAt: string;
}

export interface DotCastGamificationSettlement {
  poolId: string;
  settlementId: string;
  outcome: Side;
  unit: StakeUnit;
  status: PoolStatus;
  appliedEntries: number;
  correctEntries: number;
  incorrectEntries: number;
  pointsAwarded: number;
  freeEntriesGranted: number;
  idempotencyKey: string;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export type DotCastRewardedStreamSessionStatus = "started" | "completed" | "invalidated";

export interface DotCastRewardedStreamSession {
  sessionId: string;
  userId: string;
  streamId: string;
  status: DotCastRewardedStreamSessionStatus;
  startedAt: string;
  completedAt: string | null;
  watchedSeconds: number;
  requiredWatchSeconds: number;
  streamStartedAt: string;
  streamStoppedAt: string | null;
  rewardId: string | null;
  eventJson: Record<string, unknown>;
}

export interface DotCastRewardedStreamProgress {
  userId: string;
  completedStreams: number;
  cycleCompletedStreams: number;
  rewardCycles: number;
  pointsEarned: number;
  freeEntriesEarned: number;
  updatedAt: string;
}

export interface DotCastRewardedStreamReward {
  rewardId: string;
  userId: string;
  cycleNumber: number;
  completedSessionId: string;
  completedStreams: number;
  pointsGranted: number;
  freeEntriesGranted: number;
  idempotencyKey: string;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastReferralCode {
  code: string;
  userId: string;
  identityHash: string;
  status: DotCastReferralCodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DotCastReferralIdentityBinding {
  userId: string;
  identityHash: string;
  walletAddress: string | null;
  kycComplete: boolean;
  firstEntryEarned: boolean;
  firstDepositAt: string | null;
  lastWithdrawalAt: string | null;
  updatedAt: string;
}

export interface DotCastReferral {
  referralId: string;
  code: string | null;
  referrerUserId: string;
  referredUserId: string;
  referrerIdentityHash: string;
  referredIdentityHash: string;
  qualifier: DotCastReferralQualifier;
  status: DotCastReferralStatus;
  qualifiedAt: string | null;
  rejectedReason: string | null;
  rewardBatchId: string | null;
  idempotencyKey: string;
  eventJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DotCastReferralReward {
  rewardId: string;
  referralId: string;
  rewardBatchId: string;
  userId: string;
  role: DotCastReferralRewardRole;
  status: DotCastReferralRewardStatus;
  freeEntriesGranted: number;
  suppressedReason: string | null;
  creditIds: string[];
  idempotencyKey: string;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastReferralAmlFlag {
  flagId: string;
  referrerUserId: string;
  referredUserId: string;
  clusterKey: string;
  reason: "deposit_refer_withdraw_ring";
  severity: DotCastReferralAmlSeverity;
  relatedReferralIds: string[];
  relatedIdentityHashes: string[];
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastReferralEvent {
  eventId: string;
  referralId: string | null;
  referrerUserId: string | null;
  referredUserId: string | null;
  eventType: DotCastReferralEventType;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export type DotCastSponsoredQuestionStatus =
  | "pending_review"
  | "active"
  | "paused"
  | "archived"
  | "rejected";

export type DotCastSponsoredQuestionPricingModel =
  | "flat_fee"
  | "cpm"
  | "completed_prediction"
  | "auction";

export type DotCastSponsoredQuestionConflictStatus = "clear" | "blocked" | "pending";

export interface DotCastSponsoredQuestionMarketSource {
  id: string;
  venue: "kalshi" | "polymarket";
  question: string;
  status: DotCastMarketStatus;
  closeTime: string;
  expectedResolveAt: string | null;
  referenceUrl: string | null;
}

export interface DotCastSponsoredQuestion {
  sponsorshipId: string;
  sponsorId: string;
  campaignId: string;
  market: DotCastSponsoredQuestionMarketSource;
  pricingModel: DotCastSponsoredQuestionPricingModel;
  budgetMinorUnits: number;
  placementPriority: number;
  status: DotCastSponsoredQuestionStatus;
  disclosureLabel: "Sponsored";
  sponsorName: string;
  brandColor: string | null;
  logoUrl: string | null;
  contextText: string | null;
  conflictStatus: DotCastSponsoredQuestionConflictStatus;
  conflictReasons: string[];
  startsAt: string | null;
  endsAt: string | null;
  metadata: Record<string, unknown>;
  integrityHash: string;
  createdAt: string;
  updatedAt: string;
}

export type DotCastSponsoredQuestionBillingEventType =
  | "flat_fee_reserved"
  | "impression"
  | "completed_prediction"
  | "auction_charge"
  | "adjustment";

export interface DotCastSponsoredQuestionBillingEvent {
  billingEventId: string;
  sponsorshipId: string;
  sponsorId: string;
  eventType: DotCastSponsoredQuestionBillingEventType;
  pricingModel: DotCastSponsoredQuestionPricingModel;
  quantity: number;
  amountMinorUnits: number;
  idempotencyKey: string;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastCreatorProfile {
  creatorId: string;
  displayName: string;
  tier: DotCastCreatorTier;
  status: DotCastCreatorStatus;
  kycStatus: DotCastCreatorKycStatus;
  payoutDestination: string | null;
  accuracyBps: number;
  retentionBps: number;
  volumeScore: number;
  manualReviewRequired: boolean;
  sponsorshipEligible: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DotCastCreatorEarningsBalance {
  creatorId: string;
  unit: StakeUnit;
  available: number;
  pendingPayout: number;
  lifetimeAccrued: number;
  lifetimePaid: number;
  updatedAt: string;
}

export interface DotCastCreatorRakeAccrual {
  accrualId: string;
  poolId: string;
  settlementId: string;
  creatorId: string;
  unit: StakeUnit;
  totalRake: number;
  creatorShare: number;
  houseShare: number;
  tier: DotCastCreatorTier;
  tierShareBps: number;
  effectiveShareBps: number;
  accuracyBps: number;
  retentionBps: number;
  idempotencyKey: string;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastCreatorPayout {
  payoutId: string;
  creatorId: string;
  unit: "usdc";
  amount: number;
  status: DotCastCreatorPayoutStatus;
  destination: string;
  idempotencyKey: string;
  railTransferId: string | null;
  railTxRef: string | null;
  mockSignature: string | null;
  requestedAt: string;
  updatedAt: string;
  eventJson: Record<string, unknown>;
}

export interface DotCastCreatorEvent {
  eventId: string;
  creatorId: string;
  poolId: string | null;
  eventType: DotCastCreatorEventType;
  unit: StakeUnit | null;
  amount: number | null;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastCreatorPoolSeed {
  seedId: string;
  creatorId: string;
  poolId: string;
  unit: StakeUnit;
  amount: number;
  mode: DotCastCreatorSeedMode;
  resolutionBinding: DotCastResolutionBinding;
  status: "accepted" | "rejected" | "applied" | "returned";
  disclosureLabel: "Creator seed";
  creatorHoldsPosition: boolean;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastRouterResolution {
  marketId: string;
  outcome: DotCastResolutionOutcome;
  resolvedAt: string | null;
  fetchedAt: string;
  stale: boolean;
  source?: DotCastVenue;
}

export interface HouseLedgerEntry {
  id: string;
  poolId: string;
  unit: StakeUnit;
  amount: number;
  reason: "rake";
  createdAt: string;
}

export interface DotCastSettlementRecord {
  id: string;
  poolId: string;
  outcome: Side;
  totalStaked: number;
  payoutTotal: number;
  rakeAmount: number;
  createdAt: string;
}

export interface DotCastPoolSnapshot {
  pool: DotCastPool;
  entries: DotCastEntry[];
  balances: Record<string, StakeBalance>;
  houseLedger: HouseLedgerEntry[];
  settlement: DotCastSettlementRecord | null;
  voidReason: DotCastVoidReason | null;
  lastResolution: DotCastRouterResolution | null;
  updatedAt: string;
}

export type DotCastLivestreamStatus = "draft" | "live" | "paused" | "ended";

export type DotCastLivestreamViewerRole = "viewer" | "host" | "moderator";

export type DotCastLivestreamEventType =
  | "STREAM_CREATED"
  | "STREAM_STARTED"
  | "STREAM_PAUSED"
  | "STREAM_RESUMED"
  | "STREAM_ENDED"
  | "POOL_ATTACHED"
  | "POOL_DETACHED"
  | "FEATURED_POOL_CHANGED"
  | "PRESENCE_HEARTBEAT";

export interface DotCastLivestreamPool {
  poolId: string;
  marketId: string;
  question: string;
  unit: StakeUnit;
  status: PoolStatus;
  order: number;
  pinned: boolean;
  addedAt: string;
  updatedAt: string;
}

export interface DotCastLivestreamViewerPresence {
  viewerId: string;
  role: DotCastLivestreamViewerRole;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DotCastLivestreamSession {
  id: string;
  hostId: string;
  title: string;
  status: DotCastLivestreamStatus;
  featuredPoolId: string | null;
  viewerCount: number;
  poolCount: number;
  createdAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface DotCastLivestreamEvent {
  id: number;
  eventId: string;
  streamId: string;
  eventType: DotCastLivestreamEventType;
  poolId: string | null;
  viewerId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastLivestreamSnapshot {
  session: DotCastLivestreamSession;
  pools: DotCastLivestreamPool[];
  viewers: DotCastLivestreamViewerPresence[];
  events: DotCastLivestreamEvent[];
  updatedAt: string;
}

export type DotCastLivestreamProvider = "mux";

export type DotCastLivestreamControlLayer = "livewire";

export type DotCastMuxPlaybackPolicy = "public" | "signed";

export type DotCastLivestreamMetadataStatus = "idle" | "live" | "errored" | "archived";

export interface DotCastLivestreamMetadata {
  streamId: string;
  provider: DotCastLivestreamProvider;
  controlLayer: DotCastLivestreamControlLayer;
  muxLiveStreamId: string;
  playbackId: string;
  playbackPolicy: DotCastMuxPlaybackPolicy;
  hostId: string;
  title: string;
  status: DotCastLivestreamMetadataStatus;
  muxStatus: string;
  recordingAssetId: string | null;
  recordingPlaybackId: string | null;
  lowLatency: boolean;
  recordingEnabled: boolean;
  reconnectWindowSeconds: number;
  ingestRtmpUrl: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  archivedAt: string | null;
  lastWebhookEventId: string | null;
  metadata: Record<string, unknown>;
}

export interface DotCastLivestreamPoolLink {
  streamId: string;
  poolId: string;
  marketId: string;
  question: string;
  unit: StakeUnit;
  status: PoolStatus;
  pinned: boolean;
  attachedAt: string;
  updatedAt: string;
}

export interface DotCastLivestreamMetadataEvent {
  eventId: string;
  streamId: string;
  muxLiveStreamId: string;
  eventType: string;
  status: DotCastLivestreamMetadataStatus | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

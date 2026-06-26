export type DotCastVenue = "kalshi" | "polymarket" | "dotcast" | "unknown";

export type StakeUnit = "points" | "usdc";

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
  grantReason: "streak_bonus" | "manual_grant" | "rewarded_stream" | "adjustment";
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

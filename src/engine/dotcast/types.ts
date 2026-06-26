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
  | "free_entry_redeem"
  | "adjustment";

export interface PointsLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  reason: PointsLedgerReason;
  poolId: string | null;
  createdAt: string;
  balanceAfter: number;
}

export interface FreeEntryCredit {
  id: string;
  userId: string;
  grantedAt: string;
  consumedAt: string | null;
  consumedByEntryId: string | null;
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

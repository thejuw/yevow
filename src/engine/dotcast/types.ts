export type DotCastVenue = "kalshi" | "polymarket" | "dotcast" | "unknown";

export type StakeUnit = "points" | "usdc";

export type DotCastMarketStatus = "open" | "closed" | "settled" | "cancelled" | "voided";

export type PoolStatus = "open" | "locked" | "resolving" | "settled" | "voided";

export type Side = "yes" | "no";

export interface SideTotals {
  yes: number;
  no: number;
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

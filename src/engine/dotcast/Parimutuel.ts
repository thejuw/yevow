import type { Side, SideTotals } from "./types";

export interface SettlementEntry {
  id: string;
  side: Side;
  amount: number;
  placedAt?: string;
}

export interface SettlementPayout {
  entryId: string;
  side: Side;
  stake: number;
  payout: number;
}

export interface SettledParimutuelResult {
  kind: "settled";
  outcome: Side;
  totals: SideTotals;
  totalStaked: number;
  rakeAmount: number;
  prizePool: number;
  payouts: SettlementPayout[];
}

export interface VoidRequiredParimutuelResult {
  kind: "void_required";
  reason: "NO_WINNING_ENTRIES";
  outcome: Side;
  totals: SideTotals;
  totalStaked: number;
  rakeAmount: 0;
  prizePool: 0;
  payouts: SettlementPayout[];
}

export type ParimutuelSettlementResult =
  | SettledParimutuelResult
  | VoidRequiredParimutuelResult;

interface AllocationDraft {
  entry: SettlementEntry;
  baseWinnings: number;
  remainder: bigint;
  index: number;
}

const RAKE_DENOMINATOR_BPS = 10_000n;

export function settleParimutuel(
  entries: SettlementEntry[],
  outcome: Side,
  rake: number
): ParimutuelSettlementResult {
  if (entries.length === 0) {
    return {
      kind: "void_required",
      reason: "NO_WINNING_ENTRIES",
      outcome,
      totals: { yes: 0, no: 0 },
      totalStaked: 0,
      rakeAmount: 0,
      prizePool: 0,
      payouts: []
    };
  }

  const normalizedEntries = entries.map((entry) => validateEntry(entry));
  const totals = calculatePoolTotals(normalizedEntries);
  const winningEntries = normalizedEntries.filter((entry) => entry.side === outcome);
  const losingEntries = normalizedEntries.filter((entry) => entry.side !== outcome);
  const winPool = totals[outcome];
  const losePool = outcome === "yes" ? totals.no : totals.yes;
  const totalStaked = totals.yes + totals.no;

  if (winPool === 0) {
    return {
      kind: "void_required",
      reason: "NO_WINNING_ENTRIES",
      outcome,
      totals,
      totalStaked,
      rakeAmount: 0,
      prizePool: 0,
      payouts: normalizedEntries.map((entry) => ({
        entryId: entry.id,
        side: entry.side,
        stake: entry.amount,
        payout: 0
      }))
    };
  }

  const rakeAmount = calculateRakeAmount(losePool, rake);
  const prizePool = losePool - rakeAmount;
  const winningsByEntry = allocatePrizePool(winningEntries, winPool, prizePool);

  return {
    kind: "settled",
    outcome,
    totals,
    totalStaked,
    rakeAmount,
    prizePool,
    payouts: [
      ...winningEntries.map((entry) => ({
        entryId: entry.id,
        side: entry.side,
        stake: entry.amount,
        payout: entry.amount + (winningsByEntry.get(entry.id) ?? 0)
      })),
      ...losingEntries.map((entry) => ({
        entryId: entry.id,
        side: entry.side,
        stake: entry.amount,
        payout: 0
      }))
    ].sort((left, right) => left.entryId.localeCompare(right.entryId))
  };
}

export function calculatePoolTotals(entries: SettlementEntry[]): SideTotals {
  return entries.reduce<SideTotals>(
    (totals, entry) => {
      const normalizedEntry = validateEntry(entry);
      totals[normalizedEntry.side] += normalizedEntry.amount;
      assertSafeMinorUnits(totals[normalizedEntry.side], `${normalizedEntry.side} pool`);
      return totals;
    },
    { yes: 0, no: 0 }
  );
}

export function impliedProb(totals: SideTotals): SideTotals {
  assertSafeMinorUnits(totals.yes, "yes pool");
  assertSafeMinorUnits(totals.no, "no pool");

  const total = totals.yes + totals.no;

  if (total === 0) {
    return { yes: 0.5, no: 0.5 };
  }

  return {
    yes: totals.yes / total,
    no: totals.no / total
  };
}

export function previewPayout(
  totals: SideTotals,
  side: Side,
  amount: number,
  rake: number
): number {
  assertPositiveMinorUnits(amount, "amount");
  assertSafeMinorUnits(totals.yes, "yes pool");
  assertSafeMinorUnits(totals.no, "no pool");

  const projectedTotals = {
    yes: totals.yes + (side === "yes" ? amount : 0),
    no: totals.no + (side === "no" ? amount : 0)
  };
  const winPool = projectedTotals[side];
  const losePool = side === "yes" ? projectedTotals.no : projectedTotals.yes;

  if (losePool === 0) {
    return amount;
  }

  const rakeAmount = calculateRakeAmount(losePool, rake);
  const prizePool = losePool - rakeAmount;
  const winnings = Number((BigInt(amount) * BigInt(prizePool)) / BigInt(winPool));

  assertSafeMinorUnits(winnings, "preview winnings");
  return amount + winnings;
}

export function calculateRakeAmount(losingPool: number, rake: number): number {
  assertSafeMinorUnits(losingPool, "losing pool");

  if (!Number.isFinite(rake) || rake < 0 || rake > 1) {
    throw new RangeError("rake must be a finite fraction between 0 and 1");
  }

  const rakeBps = BigInt(Math.round(rake * Number(RAKE_DENOMINATOR_BPS)));
  const rakeAmount = Number((BigInt(losingPool) * rakeBps) / RAKE_DENOMINATOR_BPS);
  assertSafeMinorUnits(rakeAmount, "rake amount");
  return rakeAmount;
}

function allocatePrizePool(
  winningEntries: SettlementEntry[],
  winPool: number,
  prizePool: number
): Map<string, number> {
  const allocations = new Map<string, number>();

  if (prizePool === 0) {
    for (const entry of winningEntries) {
      allocations.set(entry.id, 0);
    }
    return allocations;
  }

  const drafts = winningEntries.map<AllocationDraft>((entry, index) => {
    const numerator = BigInt(entry.amount) * BigInt(prizePool);
    const baseWinnings = Number(numerator / BigInt(winPool));
    const remainder = numerator % BigInt(winPool);
    allocations.set(entry.id, baseWinnings);
    return { entry, baseWinnings, remainder, index };
  });

  const baseTotal = drafts.reduce((sum, draft) => sum + draft.baseWinnings, 0);
  let undistributed = prizePool - baseTotal;
  const remainderOrder = [...drafts].sort(compareRemainderDrafts);

  for (let index = 0; index < remainderOrder.length && undistributed > 0; index += 1) {
    const entryId = remainderOrder[index].entry.id;
    allocations.set(entryId, (allocations.get(entryId) ?? 0) + 1);
    undistributed -= 1;
  }

  return allocations;
}

function compareRemainderDrafts(left: AllocationDraft, right: AllocationDraft): number {
  if (left.remainder !== right.remainder) {
    return left.remainder > right.remainder ? -1 : 1;
  }

  const placedAtComparison = (left.entry.placedAt ?? "").localeCompare(right.entry.placedAt ?? "");
  if (placedAtComparison !== 0) {
    return placedAtComparison;
  }

  const idComparison = left.entry.id.localeCompare(right.entry.id);
  return idComparison === 0 ? left.index - right.index : idComparison;
}

function validateEntry(entry: SettlementEntry): SettlementEntry {
  if (entry.side !== "yes" && entry.side !== "no") {
    throw new Error(`unsupported side: ${String(entry.side)}`);
  }

  assertPositiveMinorUnits(entry.amount, `entry ${entry.id} amount`);
  return entry;
}

function assertPositiveMinorUnits(value: number, label: string): void {
  assertSafeMinorUnits(value, label);

  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
}

function assertSafeMinorUnits(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer minor-unit amount`);
  }
}

import type { JsonRecord } from "../../types";
import { DEFAULT_LOOKBACK_DAYS, DEFAULT_MIN_SCORE, clamp, round } from "./Common";

export type AlphaDirection = "LONG" | "FLAT" | "AVOID";

export interface CongressAlphaSignal {
  signalId: string;
  runId: string;
  symbol: string;
  sector: string;
  asOf: string;
  score: number;
  confidence: number;
  direction: AlphaDirection;
  horizonDays: number;
  latestTradeAt: string | null;
  currentPrice: number | null;
  netAmountMid: number;
  purchaseAmountMid: number;
  saleAmountMid: number;
  transactionCount: number;
  purchaseCount: number;
  saleCount: number;
  memberCount: number;
  conflictCount: number;
  bipartisanScore: number;
  freshnessPenalty: number;
  rationale: JsonRecord;
}

export interface CongressAlphaTarget {
  targetId: string;
  runId: string;
  signalId: string;
  symbol: string;
  sector: string;
  referencePrice: number;
  targetWeightPct: number;
  targetNotional: number;
  score: number;
  confidence: number;
  reason: string;
}

export interface CongressAlphaScoringInput {
  transactionCount: number;
  purchaseCount: number;
  saleCount: number;
  purchaseAmountMid: number;
  saleAmountMid: number;
  netAmountMid: number;
  memberCount: number;
  conflictCount: number;
  democraticPurchaseCount: number;
  republicanPurchaseCount: number;
  latestTradeAt: string | null;
  asOf: string;
}

export interface CongressAlphaScoreResult {
  score: number;
  confidence: number;
  direction: AlphaDirection;
  bipartisanScore: number;
  freshnessPenalty: number;
  rationale: JsonRecord;
}

export function scoreCongressAlphaCandidate(
  input: CongressAlphaScoringInput
): CongressAlphaScoreResult {
  const totalAmount = Math.max(1, input.purchaseAmountMid + input.saleAmountMid);
  const purchaseIntensity = input.purchaseAmountMid / totalAmount;
  const netFlow = input.netAmountMid / totalAmount;
  const repeatScore = Math.min(20, input.transactionCount * 4);
  const memberScore = Math.min(20, input.memberCount * 6);
  const bipartisanScore =
    input.democraticPurchaseCount > 0 && input.republicanPurchaseCount > 0 ? 10 : 0;
  const conflictScore = Math.min(15, input.conflictCount * 5);
  const latestTime = input.latestTradeAt ? Date.parse(input.latestTradeAt) : NaN;
  const asOfTime = Date.parse(input.asOf);
  const ageDays =
    Number.isFinite(latestTime) && Number.isFinite(asOfTime)
      ? Math.max(0, (asOfTime - latestTime) / 86_400_000)
      : DEFAULT_LOOKBACK_DAYS;
  const freshnessPenalty = Math.min(35, ageDays / 4);
  const rawScore =
    purchaseIntensity * 45 +
    Math.max(0, netFlow) * 30 +
    repeatScore +
    memberScore +
    bipartisanScore +
    conflictScore -
    freshnessPenalty;
  const score = round(clamp(rawScore, 0, 100), 2);
  const dataQuality = input.purchaseCount > 0 ? Math.min(1, input.memberCount / 3 + 0.25) : 0;
  const confidence = round(
    clamp((score / 100) * dataQuality * (1 - Math.min(0.45, ageDays / 400)), 0, 1),
    4
  );
  const direction: AlphaDirection =
    input.purchaseCount === 0 || input.purchaseCount < input.saleCount || score < DEFAULT_MIN_SCORE
      ? score >= 20
        ? "FLAT"
        : "AVOID"
      : "LONG";

  return {
    score,
    confidence,
    direction,
    bipartisanScore,
    freshnessPenalty: round(freshnessPenalty, 2),
    rationale: {
      purchaseIntensity: round(purchaseIntensity, 4),
      netFlow: round(netFlow, 4),
      repeatScore,
      memberScore,
      bipartisanScore,
      conflictScore,
      ageDays: round(ageDays, 2),
      freshnessPenalty: round(freshnessPenalty, 2),
      caveat:
        "Congressional PTRs are delayed public disclosures. This score is for paper research and portfolio simulation, not intraday execution."
    }
  };
}

export function buildCongressAlphaTargets(
  signals: CongressAlphaSignal[],
  options: {
    bankroll: number;
    maxPositions: number;
    minScore: number;
    maxWeightPct: number;
  }
): CongressAlphaTarget[] {
  const eligible = signals
    .filter(
      (signal) =>
        signal.direction === "LONG" &&
        signal.score >= options.minScore &&
        typeof signal.currentPrice === "number" &&
        signal.currentPrice > 0
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, options.maxPositions);
  const scoreSum = eligible.reduce((sum, signal) => sum + signal.score, 0);
  const grossBudgetPct = Math.min(80, options.maxPositions * options.maxWeightPct);

  if (scoreSum <= 0) {
    return [];
  }

  return eligible.map((signal) => {
    const targetWeightPct = round(
      Math.min(options.maxWeightPct, (signal.score / scoreSum) * grossBudgetPct),
      4
    );
    return {
      targetId: crypto.randomUUID(),
      runId: signal.runId,
      signalId: signal.signalId,
      symbol: signal.symbol,
      sector: signal.sector,
      referencePrice: signal.currentPrice ?? 0,
      targetWeightPct,
      targetNotional: round((options.bankroll * targetWeightPct) / 100, 2),
      score: signal.score,
      confidence: signal.confidence,
      reason: `Score ${signal.score}; ${signal.purchaseCount} buys across ${signal.memberCount} member(s).`
    };
  });
}

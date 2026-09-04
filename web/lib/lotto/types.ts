/** Shared, browser-safe domain types for the RabbitHoleTX dashboard. */

export const GAME_CODES = ["lotto", "twostep", "cash5", "pb", "mm", "p3", "d4", "aon"] as const;

export type GameCode = (typeof GAME_CODES)[number];
export type GameKind = "pool" | "bonus" | "digits";
export type Seed = string | number;

export interface NumberPoolRule {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly allowDuplicates: boolean;
}

export interface ExportSource {
  readonly name: string;
  readonly url: string;
  readonly session?: "morning" | "day" | "evening" | "night";
}

export interface GameManifestEntry {
  readonly code: GameCode;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly kind: GameKind;
  readonly main: NumberPoolRule;
  readonly bonus?: NumberPoolRule;
  readonly baseCostCents: number;
  readonly outcomeCount: number;
  readonly topPrizeOdds: number;
  readonly auditStart: string;
  readonly schedule: string;
  readonly officialPage: string;
  readonly exportSources: readonly ExportSource[];
  readonly notes: readonly string[];
  readonly verifiedOn: string;
  readonly optimizerPlayStyles: readonly DigitPlayStyle[];
  readonly evPlayStyles: readonly DigitPlayStyle[];
}

export type DigitPlayStyle =
  | "straight"
  | "exact"
  | "exact-order"
  | "box"
  | "anybox"
  | "any-order"
  | "straight-box"
  | "straight/box"
  | "straight+box"
  | "exact-any"
  | "exact/any"
  | "exact-any-order"
  | "exact/any-order"
  | "exact/anybox"
  | "combo"
  | "front-pair"
  | "mid-pair"
  | "middle-pair"
  | "back-pair";

export type Pick3Pattern = "aaa" | "aab" | "abc";
export type Daily4Pattern = "aaaa" | "aaab" | "aabb" | "aabc" | "abcd";
export type DigitPattern = Pick3Pattern | Daily4Pattern;

export interface Ticket {
  readonly game: GameCode;
  readonly main: readonly number[];
  readonly bonus?: readonly number[];
  readonly playStyle?: DigitPlayStyle | "straight";
}

export interface SplitRiskResult {
  readonly score: number;
  readonly level: "low" | "moderate" | "high";
  readonly notes: readonly string[];
  readonly disclaimer: string;
}

export interface ScoredTicket {
  readonly ticket: Ticket;
  readonly splitRisk: SplitRiskResult;
}

export interface CoverageResult {
  readonly distinctPairs: number;
  readonly possiblePairs: number;
  readonly coveragePercent: number;
  readonly definition: string;
}

export interface GenerateTicketsInput {
  readonly game: GameCode;
  readonly count: number;
  readonly seed?: Seed;
  readonly candidatePoolSize?: number;
  readonly playStyle?: DigitPlayStyle | "straight";
}

export interface PickResult {
  readonly game: GameCode;
  readonly seed: Seed;
  readonly tickets: readonly ScoredTicket[];
  readonly coverage: CoverageResult;
  readonly averageSplitRisk: number;
  readonly notes: readonly string[];
}

export type PrizeKind =
  | "fixed"
  | "pari-mutuel jackpot"
  | "pari-mutuel estimate"
  | "pari-mutuel estimate + fixed add-on"
  | "free ticket"
  | "liability-capped fixed prize"
  | "fixed prize with built-in multiplier";

export interface EvInput {
  readonly game: GameCode;
  /** Pre-tax cash value, in integer cents; never the advertised annuity. */
  readonly jackpotCents?: number;
  /** Total plays, including the modeled play when nonzero; never sales dollars. */
  readonly ticketSales?: number;
  /** Relative frequency with which competitors choose this exact combination. */
  readonly popularityMultiplier?: number;
  /** Lotto Texas only; adds exactly 100 cents to the ticket price. */
  readonly extra?: boolean;
  /** Pick 3 / Daily 4 base stake in legal integer-cent increments. */
  readonly stakeCents?: 50 | 100 | 200 | 300 | 400 | 500;
  readonly playStyle?: DigitPlayStyle;
  readonly digitPattern?: DigitPattern;
}

export interface EvTierResult {
  readonly tier: string;
  readonly eventCount: number;
  readonly totalOutcomes: number;
  readonly probability: number;
  readonly nominalPrizeCents: number;
  readonly adjustedPrizeCents: number;
  readonly expectedValueCents: number;
  readonly prizeKind: PrizeKind;
  readonly pariMutuel: boolean;
  readonly splitLambda: number;
  readonly notes: readonly string[];
}

export interface EvResult {
  readonly game: GameCode;
  readonly gameName: string;
  readonly ticketCostCents: number;
  readonly grossEvCents: number;
  readonly netEvCents: number;
  readonly returnPercent: number;
  readonly evPerTwoDollarsCents: number;
  readonly jackpotCents: number;
  readonly ticketSales: number;
  readonly popularityMultiplier: number;
  readonly splitLambda: number;
  readonly expectedJackpotShare: number;
  readonly tiers: readonly EvTierResult[];
  readonly assumptions: readonly string[];
}

export type EvInputsByGame = Partial<Record<GameCode, Omit<EvInput, "game">>>;

export interface AuditFindingSnapshot {
  readonly name: string;
  readonly statistic: number;
  readonly pValue: number;
  readonly verdict: "NO FLAG" | "FLAG";
  readonly detail: string;
}

export interface FrequencySnapshot {
  readonly value: number;
  readonly appearances: number;
  readonly deviationPercent: number;
}

export interface GapSnapshot {
  readonly value: number;
  readonly currentGap: number;
  readonly meanCompletedGap: number;
}

export interface CombinationSnapshot {
  readonly values: readonly number[];
  readonly count: number;
}

export interface AuditSnapshot {
  readonly game: "lotto" | "cash5";
  readonly generatedAt: string;
  readonly eraStart: string;
  readonly drawsAnalyzed: number;
  readonly observedFrom: string;
  readonly observedThrough: string;
  readonly source: {
    readonly url: string;
    readonly sha256: string;
    readonly recordsRepresented: number;
  };
  readonly familyWiseAlpha: number;
  readonly bonferroniThreshold: number;
  readonly findings: readonly AuditFindingSnapshot[];
  readonly frequencySampleSize: number;
  readonly frequencies: readonly FrequencySnapshot[];
  readonly gaps: readonly GapSnapshot[];
  readonly topPairs: readonly CombinationSnapshot[];
  readonly topTriplets: readonly CombinationSnapshot[];
  readonly notes: readonly string[];
  readonly disclaimer: string;
}

export class LottoValidationError extends Error {
  override readonly name = "LottoValidationError";
}

export class EvConfigurationError extends Error {
  override readonly name = "EvConfigurationError";
}

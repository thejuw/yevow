/** Public API for the dependency-free RabbitHoleTX browser core. */

export { AUDIT_SNAPSHOTS } from "./audit";
export {
  calculatePairCoverage,
  combinationCount,
  coverageDefinition,
  pairKeys,
  possiblePairCount
} from "./coverage";
export {
  breakEvenJackpotCents,
  calculateAllEv,
  calculateEv,
  EV_RULES,
  expectedSplitShare,
  formatMoneyCents,
  formatProbability
} from "./ev";
export { GAME_MANIFEST, getGameManifest, isGameCode } from "./manifest";
export { generateTickets } from "./picker";
export {
  LottoPicksClientError,
  parseLottoDailyPicks,
  readLottoDailyPicks
} from "./picks-client";
export type {
  LottoDailyPicksResponse,
  LottoDrawSlot,
  LottoPersistedGenerationRun,
  LottoPersistedTicket,
  LottoSplitRiskLevel,
  ReadLottoDailyPicksOptions
} from "./picks-client";
export {
  LottoTicketLabClientError,
  parseTicketLabEntries,
  parseTicketLabSummary,
  readTicketLabEntries,
  readTicketLabSummary
} from "./ticket-lab-client";
export type {
  ReadTicketLabOptions,
  TicketLabBestHit,
  TicketLabComparison,
  TicketLabEntriesResponse,
  TicketLabEntry,
  TicketLabEntryStatus,
  TicketLabFilters,
  TicketLabOrigin,
  TicketLabPayoutStatus,
  TicketLabPrizeTier,
  TicketLabPurchaseStatus,
  TicketLabScorecard,
  TicketLabSummaryResponse,
  TicketLabTicket,
  TicketLabTicketGrade
} from "./ticket-lab-client";
export { createSeededRng } from "./rng";
export { scoreSplitRisk } from "./risk";
export {
  configuredLottoApiBase,
  DEFAULT_LOTTO_API_BASE,
  LottoStatusClientError,
  normalizeLottoApiBase,
  parseLottoStatus,
  readLottoStatus
} from "./status-client";
export type {
  LottoFreshness,
  LottoGameStatus,
  LottoSourceStatus,
  LottoStatusResponse,
  ReadLottoStatusOptions
} from "./status-client";
export { EvConfigurationError, GAME_CODES, LottoValidationError } from "./types";
export type {
  AuditFindingSnapshot,
  AuditSnapshot,
  CombinationSnapshot,
  CoverageResult,
  Daily4Pattern,
  DigitPattern,
  DigitPlayStyle,
  EvInput,
  EvInputsByGame,
  EvResult,
  EvTierResult,
  ExportSource,
  FrequencySnapshot,
  GameCode,
  GameKind,
  GameManifestEntry,
  GapSnapshot,
  GenerateTicketsInput,
  NumberPoolRule,
  Pick3Pattern,
  PickResult,
  PrizeKind,
  ScoredTicket,
  Seed,
  SplitRiskResult,
  Ticket
} from "./types";
export { isPermutationStyle, isPurePermutationStyle, validateTicket } from "./validation";

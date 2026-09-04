import type {
  DotCastAiResolutionLog,
  DotCastMarketSnapshot,
  DotCastResolutionChallenge,
  DotCastResolutionChallengeDecisionAction,
  DotCastResolutionOutcome,
  DotCastResolutionReview,
  DotCastResolutionReviewAction,
  DotCastResolutionRoute,
  DotCastResolutionSource,
  DotCastResolutionTier,
  DotCastResolverAdminAction,
  DotCastResolverAssignment,
  DotCastResolverBondLedgerEntry,
  DotCastResolverCommit,
  DotCastResolverPanel,
  DotCastResolverPayout,
  DotCastResolverProfile,
  DotCastResolverRegistryProfile,
  DotCastResolverReputationEvent,
  DotCastResolverReveal,
  DotCastResolverStatus,
  DotCastResolverTimeoutPhase,
  Side,
  StakeUnit
} from "./types";

export interface DotCastResolutionRouterEnv {
  DOTCAST_RESOLUTION_ROUTER_ENABLED?: string;
  DOTCAST_RESOLUTION_CLASSIFIER_MIN_CONFIDENCE_BPS?: string;
  DOTCAST_AI_PERCEPTION_AUTO_CONFIDENCE_BPS?: string;
  DOTCAST_RESOLUTION_HIGH_STAKES_THRESHOLD_MINOR_UNITS?: string;
  DOTCAST_RESOLVER_BASE_PANEL_SIZE?: string;
  DOTCAST_RESOLVER_HIGH_STAKES_PANEL_SIZE?: string;
  DOTCAST_RESOLVER_MIN_BOND_MINOR_UNITS?: string;
  DOTCAST_RESOLVER_HIGH_STAKES_MIN_BOND_MINOR_UNITS?: string;
  DOTCAST_RESOLVER_FEE_BPS?: string;
  DOTCAST_RESOLUTION_CHALLENGE_WINDOW_SECONDS?: string;
}

export interface DotCastResolutionRouterStatus {
  enabled: boolean;
  ready: boolean;
  classifierVersion: string;
  minConfidenceBps: number;
  aiAutoConfidenceBps: number;
  highStakesThresholdMinorUnits: number;
  basePanelSize: number;
  highStakesPanelSize: number;
  resolverMinBondMinorUnits: number;
  resolverHighStakesMinBondMinorUnits: number;
  resolverFeeBps: number;
  challengeWindowSeconds: number;
  guards: string[];
}

export interface ClassifyDotCastResolutionRouteInput {
  market: DotCastMarketSnapshot;
  unit: StakeUnit;
  poolId?: string | null;
  streamId?: string | null;
  estimatedStakeMinorUnits?: number | null;
  sources?: DotCastResolutionSource[];
  now?: string;
}

export interface PrepareDotCastPoolResolutionRouteInput extends ClassifyDotCastResolutionRouteInput {
  explicitRoute?: DotCastResolutionRoute | null;
}

export interface ResolveDotCastAiPerceptionInput {
  route: DotCastResolutionRoute;
  poolId?: string | null;
  modelConfidenceBps: number;
  predictedOutcome: DotCastResolutionOutcome;
  evidenceRefs?: string[];
  now?: string;
}

export interface DotCastAiPerceptionResolutionResult {
  status: "auto_resolved" | "escalated";
  outcome: DotCastResolutionOutcome;
  route: DotCastResolutionRoute;
  escalatedRoute: DotCastResolutionRoute | null;
  log: DotCastAiResolutionLog;
}

export interface SelectDotCastResolverPanelInput {
  poolId: string;
  route: DotCastResolutionRoute;
  candidates: DotCastResolverProfile[];
  positionUserIds?: string[];
  estimatedStakeMinorUnits?: number;
  panelId?: string;
  now?: string;
}

export interface CreateDotCastResolverCommitInput {
  assignment: DotCastResolverAssignment;
  outcome: Side | "invalid";
  salt: string;
  now?: string;
}

export interface RevealDotCastResolverCommitInput {
  commit: DotCastResolverCommit;
  outcome: Side | "invalid";
  salt: string;
  now?: string;
}

export interface SettleDotCastResolverPanelInput {
  panel: DotCastResolverPanel;
  reveals: DotCastResolverReveal[];
  now?: string;
}

export interface EvaluateDotCastResolverPanelTimeoutInput {
  panel: DotCastResolverPanel;
  commits?: DotCastResolverCommit[];
  reveals?: DotCastResolverReveal[];
  phase: DotCastResolverTimeoutPhase;
  now?: string;
}

export interface DotCastResolverPanelSettlement {
  consensusOutcome: Side | "invalid";
  totalWeight: number;
  consensusWeight: number;
  payouts: DotCastResolverPayout[];
}

export interface DotCastResolverPanelTimeoutResult {
  phase: DotCastResolverTimeoutPhase;
  timedOutAssignmentIds: string[];
  unaffectedAssignmentIds: string[];
  payouts: DotCastResolverPayout[];
  createdAt: string;
}

export interface UpsertDotCastResolverProfileInput {
  resolverId: string;
  identityHash: string;
  displayName?: string | null;
  reputationBps?: number;
  bondAvailableMinorUnits?: number;
  stakeHeldPoolIds?: string[];
  status?: DotCastResolverStatus;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface ApplyDotCastResolutionReviewDecisionInput {
  route: DotCastResolutionRoute;
  action: DotCastResolutionReviewAction;
  reviewerId?: string | null;
  reviewId?: string;
  resolutionStatement?: string | null;
  sources?: DotCastResolutionSource[];
  blockedReason?: string | null;
  steeringPrompt?: string | null;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface DotCastResolutionReviewDecisionResult {
  review: DotCastResolutionReview;
  resultingRoute: DotCastResolutionRoute | null;
  canOpenRealMoney: boolean;
}

export interface OpenDotCastResolutionChallengeInput {
  route: DotCastResolutionRoute;
  challengerId: string;
  reason: string;
  evidenceRefs?: string[];
  bondMinorUnits?: number;
  challengeId?: string;
  windowSeconds?: number;
  now?: string;
  metadata?: Record<string, unknown>;
}

export interface DecideDotCastResolutionChallengeInput {
  challenge: DotCastResolutionChallenge;
  action: DotCastResolutionChallengeDecisionAction;
  decisionBy?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface DotCastResolutionChallengeSettlementPolicy {
  action: "allow" | "hold" | "block";
  reason: string;
  routeId: string;
  acceptedChallengeIds: string[];
  rejectedChallengeIds: string[];
  openChallengeIds: string[];
  expiredChallengeIds: string[];
}

export type DotCastResolutionSettlementSource =
  | "optimistic_auto"
  | "ai_perception_auto"
  | "resolver_consensus"
  | "manual_review";

export interface EvaluateDotCastResolutionChallengeSettlementPolicyOptions {
  settlementSource?: DotCastResolutionSettlementSource;
}

export interface ApplyDotCastResolverAdminActionInput {
  profile: DotCastResolverRegistryProfile;
  action: DotCastResolverAdminAction;
  adminId?: string | null;
  bondDeltaMinorUnits?: number;
  reputationDeltaBps?: number;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface DotCastResolverAdminActionResult {
  action: DotCastResolverAdminAction;
  profile: DotCastResolverRegistryProfile;
  previousProfile: DotCastResolverRegistryProfile;
  bondLedgerEntry: DotCastResolverBondLedgerEntry | null;
  reputationEvent: DotCastResolverReputationEvent | null;
}

export interface DotCastResolutionReviewQueueFilters {
  status?: DotCastResolutionRoute["status"];
  tier?: DotCastResolutionTier;
  limit?: number;
}

export interface DotCastResolutionReviewFilters {
  routeId?: string;
  status?: DotCastResolutionReview["status"];
  limit?: number;
}

export interface DotCastResolutionChallengeFilters {
  routeId?: string;
  status?: DotCastResolutionChallenge["status"];
  limit?: number;
}

export interface DotCastResolutionRouterStore {
  getRoute(routeId: string): Promise<DotCastResolutionRoute | null>;
  listReviewQueue(filters?: DotCastResolutionReviewQueueFilters): Promise<DotCastResolutionRoute[]>;
  insertRoute(route: DotCastResolutionRoute): Promise<void>;
  appendAiResolutionLog(log: DotCastAiResolutionLog): Promise<void>;
  getResolverProfile(resolverId: string): Promise<DotCastResolverRegistryProfile | null>;
  listResolverProfiles(limit?: number): Promise<DotCastResolverRegistryProfile[]>;
  upsertResolverProfile(profile: DotCastResolverRegistryProfile): Promise<void>;
  updateResolverProfile(profile: DotCastResolverRegistryProfile): Promise<void>;
  listResolverBondLedger(
    resolverId: string,
    limit?: number
  ): Promise<DotCastResolverBondLedgerEntry[]>;
  appendResolverBondLedgerEntry(entry: DotCastResolverBondLedgerEntry): Promise<void>;
  appendResolverReputationEvent(event: DotCastResolverReputationEvent): Promise<void>;
  insertResolutionReview(review: DotCastResolutionReview): Promise<void>;
  listResolutionReviews(
    filters?: DotCastResolutionReviewFilters
  ): Promise<DotCastResolutionReview[]>;
  insertResolutionChallenge(challenge: DotCastResolutionChallenge): Promise<void>;
  updateResolutionChallenge(challenge: DotCastResolutionChallenge): Promise<void>;
  getResolutionChallenge(challengeId: string): Promise<DotCastResolutionChallenge | null>;
  listResolutionChallenges(
    filters?: DotCastResolutionChallengeFilters
  ): Promise<DotCastResolutionChallenge[]>;
  getResolverPanel(panelId: string): Promise<DotCastResolverPanel | null>;
  getResolverAssignment(assignmentId: string): Promise<DotCastResolverAssignment | null>;
  getResolverCommit(assignmentId: string): Promise<DotCastResolverCommit | null>;
  listResolverCommits(panelId: string): Promise<DotCastResolverCommit[]>;
  listResolverReveals(panelId: string): Promise<DotCastResolverReveal[]>;
  insertResolverPanel(panel: DotCastResolverPanel): Promise<void>;
  insertResolverCommit(commit: DotCastResolverCommit): Promise<void>;
  insertResolverReveal(reveal: DotCastResolverReveal): Promise<void>;
  insertResolverPayouts(payouts: DotCastResolverPayout[]): Promise<void>;
}

export class DotCastResolutionRouterError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastResolutionRouterError";
    this.code = code;
    this.status = status;
  }
}

const CLASSIFIER_VERSION = "dotcast-e13-resolution-router-v1";
const DEFAULT_MIN_CONFIDENCE_BPS = 8000;
const DEFAULT_AI_AUTO_CONFIDENCE_BPS = 9500;
const DEFAULT_HIGH_STAKES_THRESHOLD_MINOR_UNITS = 5_000_000;
const DEFAULT_BASE_PANEL_SIZE = 3;
const DEFAULT_HIGH_STAKES_PANEL_SIZE = 7;
const DEFAULT_RESOLVER_MIN_BOND_MINOR_UNITS = 50_000;
const DEFAULT_RESOLVER_HIGH_STAKES_MIN_BOND_MINOR_UNITS = 250_000;
const DEFAULT_RESOLVER_FEE_BPS = 200;
const DEFAULT_RESOLVER_REPUTATION_BPS = 7500;
const DEFAULT_RESOLUTION_CHALLENGE_WINDOW_SECONDS = 900;
const RESOLVER_REPUTATION_CORRECT_DELTA_BPS = 100;
const RESOLVER_REPUTATION_MISS_DELTA_BPS = -250;

const HARD_ORACLE_TERMS = [
  "official",
  "final",
  "election",
  "winner",
  "wins",
  "settle",
  "result",
  "closing price",
  "will the fed",
  "will congress"
];
const COMPUTED_TERMS = [
  "above",
  "below",
  "over",
  "under",
  "greater than",
  "less than",
  "at least",
  "more than",
  "price",
  "score",
  "volume",
  "temperature"
];
const AI_PERCEPTION_TERMS = [
  "stream",
  "livestream",
  "on-air",
  "on air",
  "call",
  "says",
  "say",
  "shows",
  "show",
  "wear",
  "appears",
  "reaction",
  "clip"
];
const SUBJECTIVE_TERMS = [
  "best",
  "better",
  "funniest",
  "good",
  "great",
  "cool",
  "impressive",
  "deserve",
  "should",
  "fair",
  "beautiful"
];

export class D1DotCastResolutionRouterStore implements DotCastResolutionRouterStore {
  constructor(private readonly db: D1Database) {}

  async getRoute(routeId: string): Promise<DotCastResolutionRoute | null> {
    const row = await this.db
      .prepare(
        `SELECT route_id, market_id, pool_id, tier, status, confidence_bps,
                resolution_statement, sources_json, source_available, auto_resolvable,
                review_required, points_only, blocked_reason, steering_prompt, fee_bps,
                bond_minor_units, panel_size, locked_at, classifier_version, event_json,
                created_at
         FROM dotcast_resolution_routes
         WHERE route_id = ?`
      )
      .bind(routeId)
      .first();

    return row ? routeFromRow(row) : null;
  }

  async listReviewQueue(
    filters: DotCastResolutionReviewQueueFilters = {}
  ): Promise<DotCastResolutionRoute[]> {
    const status = filters.status ?? "review_required";
    const safeLimit = boundedLimit(filters.limit, 100);
    const params: unknown[] = [status];
    let query = `SELECT route_id, market_id, pool_id, tier, status, confidence_bps,
                        resolution_statement, sources_json, source_available, auto_resolvable,
                        review_required, points_only, blocked_reason, steering_prompt, fee_bps,
                        bond_minor_units, panel_size, locked_at, classifier_version, event_json,
                        created_at
                 FROM dotcast_resolution_routes
                 WHERE status = ?`;

    if (filters.tier) {
      query += " AND tier = ?";
      params.push(filters.tier);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(safeLimit);

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return (result.results ?? []).map(routeFromRow);
  }

  async insertRoute(route: DotCastResolutionRoute): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolution_routes (
           route_id, market_id, pool_id, tier, status, confidence_bps,
           resolution_statement, sources_json, source_available, auto_resolvable,
           review_required, points_only, blocked_reason, steering_prompt, fee_bps,
           bond_minor_units, panel_size, locked_at, classifier_version, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...routeParams(route))
      .run();
  }

  async updateResolverProfile(profile: DotCastResolverRegistryProfile): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_resolver_profiles (
           resolver_id, identity_hash, status, display_name, reputation_bps,
           bond_available_minor_units, stake_held_pool_ids_json, metadata_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resolver_id) DO UPDATE SET
           identity_hash = excluded.identity_hash,
           status = excluded.status,
           display_name = excluded.display_name,
           reputation_bps = excluded.reputation_bps,
           bond_available_minor_units = excluded.bond_available_minor_units,
           stake_held_pool_ids_json = excluded.stake_held_pool_ids_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .bind(
        profile.resolverId,
        profile.identityHash,
        profile.status,
        profile.displayName,
        profile.reputationBps,
        profile.bondAvailableMinorUnits,
        JSON.stringify(profile.stakeHeldPoolIds),
        JSON.stringify(profile.metadata),
        profile.createdAt,
        profile.updatedAt
      )
      .run();
  }

  async appendAiResolutionLog(log: DotCastAiResolutionLog): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_ai_resolution_logs (
           log_id, route_id, pool_id, model_confidence_bps, predicted_outcome, action,
           threshold_bps, evidence_refs_json, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        log.logId,
        log.routeId,
        log.poolId,
        log.modelConfidenceBps,
        log.predictedOutcome,
        log.action,
        log.thresholdBps,
        JSON.stringify(log.evidenceRefs),
        JSON.stringify(log.eventJson),
        log.createdAt
      )
      .run();
  }

  async getResolverProfile(resolverId: string): Promise<DotCastResolverRegistryProfile | null> {
    const row = await this.db
      .prepare(
        `SELECT resolver_id, identity_hash, status, display_name, reputation_bps,
                bond_available_minor_units, stake_held_pool_ids_json, metadata_json,
                created_at, updated_at
         FROM dotcast_resolver_profiles
         WHERE resolver_id = ?`
      )
      .bind(resolverId)
      .first();

    return row ? resolverProfileFromRow(row) : null;
  }

  async listResolverProfiles(limit = 100): Promise<DotCastResolverRegistryProfile[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = await this.db
      .prepare(
        `SELECT resolver_id, identity_hash, status, display_name, reputation_bps,
                bond_available_minor_units, stake_held_pool_ids_json, metadata_json,
                created_at, updated_at
         FROM dotcast_resolver_profiles
         WHERE status = 'active'
         ORDER BY reputation_bps DESC, bond_available_minor_units DESC, updated_at DESC
         LIMIT ?`
      )
      .bind(safeLimit)
      .all();

    return (result.results ?? []).map(resolverProfileFromRow);
  }

  async upsertResolverProfile(profile: DotCastResolverRegistryProfile): Promise<void> {
    const existing = await this.getResolverProfile(profile.resolverId);

    await this.db
      .prepare(
        `INSERT INTO dotcast_resolver_profiles (
           resolver_id, identity_hash, status, display_name, reputation_bps,
           bond_available_minor_units, stake_held_pool_ids_json, metadata_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resolver_id) DO UPDATE SET
           identity_hash = excluded.identity_hash,
           status = excluded.status,
           display_name = excluded.display_name,
           reputation_bps = excluded.reputation_bps,
           bond_available_minor_units = excluded.bond_available_minor_units,
           stake_held_pool_ids_json = excluded.stake_held_pool_ids_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .bind(
        profile.resolverId,
        profile.identityHash,
        profile.status,
        profile.displayName,
        profile.reputationBps,
        profile.bondAvailableMinorUnits,
        JSON.stringify(profile.stakeHeldPoolIds),
        JSON.stringify(profile.metadata),
        profile.createdAt,
        profile.updatedAt
      )
      .run();

    if (!existing) {
      await this.insertResolverBondLedgerEntry({
        entryId: `dotcast:e13:resolver-onboarded:${profile.resolverId}:${Date.parse(
          profile.createdAt
        )}`,
        resolverId: profile.resolverId,
        assignmentId: null,
        panelId: null,
        eventType: "resolver_onboarded",
        deltaMinorUnits: 0,
        balanceAfterMinorUnits: 0,
        eventJson: {
          identityHash: profile.identityHash,
          status: profile.status
        },
        createdAt: profile.createdAt
      });

      if (profile.bondAvailableMinorUnits > 0) {
        await this.insertResolverBondLedgerEntry({
          entryId: `dotcast:e13:bond-deposit:${profile.resolverId}:${Date.parse(
            profile.createdAt
          )}`,
          resolverId: profile.resolverId,
          assignmentId: null,
          panelId: null,
          eventType: "bond_deposited",
          deltaMinorUnits: profile.bondAvailableMinorUnits,
          balanceAfterMinorUnits: profile.bondAvailableMinorUnits,
          eventJson: {
            source: "resolver_onboarding"
          },
          createdAt: profile.createdAt
        });
      }
    } else if (existing.bondAvailableMinorUnits !== profile.bondAvailableMinorUnits) {
      const deltaMinorUnits = profile.bondAvailableMinorUnits - existing.bondAvailableMinorUnits;
      await this.insertResolverBondLedgerEntry({
        entryId: `dotcast:e13:bond-adjustment:${profile.resolverId}:${Date.parse(
          profile.updatedAt
        )}`,
        resolverId: profile.resolverId,
        assignmentId: null,
        panelId: null,
        eventType: deltaMinorUnits > 0 ? "bond_deposited" : "manual_adjustment",
        deltaMinorUnits,
        balanceAfterMinorUnits: profile.bondAvailableMinorUnits,
        eventJson: {
          previousBalanceMinorUnits: existing.bondAvailableMinorUnits,
          source: "resolver_profile_upsert"
        },
        createdAt: profile.updatedAt
      });
    }
  }

  async listResolverBondLedger(
    resolverId: string,
    limit = 100
  ): Promise<DotCastResolverBondLedgerEntry[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = await this.db
      .prepare(
        `SELECT entry_id, resolver_id, assignment_id, panel_id, event_type, delta_minor_units,
                balance_after_minor_units, event_json, created_at
         FROM dotcast_resolver_bond_ledger
         WHERE resolver_id = ?
         ORDER BY created_at DESC, entry_id DESC
         LIMIT ?`
      )
      .bind(resolverId, safeLimit)
      .all();

    return (result.results ?? []).map(resolverBondLedgerFromRow);
  }

  async appendResolverBondLedgerEntry(entry: DotCastResolverBondLedgerEntry): Promise<void> {
    await this.insertResolverBondLedgerEntry(entry);
  }

  async appendResolverReputationEvent(event: DotCastResolverReputationEvent): Promise<void> {
    await this.insertResolverReputationEvent(event);
  }

  async insertResolutionReview(review: DotCastResolutionReview): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolution_reviews (
           review_id, route_id, pool_id, market_id, status, reviewer_id, decision_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        review.reviewId,
        review.routeId,
        review.poolId,
        review.marketId,
        review.status,
        review.reviewerId,
        JSON.stringify(review.decisionJson),
        review.createdAt
      )
      .run();
  }

  async listResolutionReviews(
    filters: DotCastResolutionReviewFilters = {}
  ): Promise<DotCastResolutionReview[]> {
    const safeLimit = boundedLimit(filters.limit, 100);
    const clauses: string[] = [];
    const params: unknown[] = [];
    let query = `SELECT review_id, route_id, pool_id, market_id, status, reviewer_id,
                        decision_json, created_at
                 FROM dotcast_resolution_reviews`;

    if (filters.routeId) {
      clauses.push("route_id = ?");
      params.push(filters.routeId);
    }

    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }

    query += " ORDER BY created_at DESC, review_id DESC LIMIT ?";
    params.push(safeLimit);

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return (result.results ?? []).map(reviewFromRow);
  }

  async insertResolutionChallenge(challenge: DotCastResolutionChallenge): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolution_challenges (
           challenge_id, route_id, pool_id, market_id, challenger_id, status, reason,
           evidence_refs_json, bond_minor_units, opened_at, challenge_window_closes_at,
           decided_at, decision_by, decision_json, event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...challengeParams(challenge))
      .run();
  }

  async updateResolutionChallenge(challenge: DotCastResolutionChallenge): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dotcast_resolution_challenges
         SET status = ?,
             decided_at = ?,
             decision_by = ?,
             decision_json = ?,
             event_json = ?
         WHERE challenge_id = ?`
      )
      .bind(
        challenge.status,
        challenge.decidedAt,
        challenge.decisionBy,
        JSON.stringify(challenge.decisionJson),
        JSON.stringify(challenge.eventJson),
        challenge.challengeId
      )
      .run();
  }

  async getResolutionChallenge(challengeId: string): Promise<DotCastResolutionChallenge | null> {
    const row = await this.db
      .prepare(
        `SELECT challenge_id, route_id, pool_id, market_id, challenger_id, status, reason,
                evidence_refs_json, bond_minor_units, opened_at, challenge_window_closes_at,
                decided_at, decision_by, decision_json, event_json
         FROM dotcast_resolution_challenges
         WHERE challenge_id = ?`
      )
      .bind(challengeId)
      .first();

    return row ? challengeFromRow(row) : null;
  }

  async listResolutionChallenges(
    filters: DotCastResolutionChallengeFilters = {}
  ): Promise<DotCastResolutionChallenge[]> {
    const safeLimit = boundedLimit(filters.limit, 100);
    const clauses: string[] = [];
    const params: unknown[] = [];
    let query = `SELECT challenge_id, route_id, pool_id, market_id, challenger_id, status, reason,
                        evidence_refs_json, bond_minor_units, opened_at, challenge_window_closes_at,
                        decided_at, decision_by, decision_json, event_json
                 FROM dotcast_resolution_challenges`;

    if (filters.routeId) {
      clauses.push("route_id = ?");
      params.push(filters.routeId);
    }

    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }

    query += " ORDER BY opened_at DESC, challenge_id DESC LIMIT ?";
    params.push(safeLimit);

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return (result.results ?? []).map(challengeFromRow);
  }

  async getResolverPanel(panelId: string): Promise<DotCastResolverPanel | null> {
    const panelRow = await this.db
      .prepare(
        `SELECT panel_id, pool_id, route_id, tier, panel_size, estimated_stake_minor_units,
                resolver_fee_bps, created_at
         FROM dotcast_resolver_panels
         WHERE panel_id = ?`
      )
      .bind(panelId)
      .first();

    if (!panelRow) {
      return null;
    }

    const assignments = await this.db
      .prepare(
        `SELECT assignment_id, panel_id, pool_id, route_id, resolver_id, identity_hash,
                reputation_bps, bond_minor_units, status, assigned_at
         FROM dotcast_resolver_assignments
         WHERE panel_id = ?
         ORDER BY assigned_at ASC, assignment_id ASC`
      )
      .bind(panelId)
      .all();

    return {
      panelId: requireText(panelRow.panel_id, "panel_id"),
      poolId: requireText(panelRow.pool_id, "pool_id"),
      routeId: requireText(panelRow.route_id, "route_id"),
      tier: parseTier(panelRow.tier),
      panelSize: requireInteger(panelRow.panel_size, "panel_size"),
      estimatedStakeMinorUnits: requireInteger(
        panelRow.estimated_stake_minor_units,
        "estimated_stake_minor_units"
      ),
      resolverFeeBps: requireInteger(panelRow.resolver_fee_bps, "resolver_fee_bps"),
      assignments: (assignments.results ?? []).map(assignmentFromRow),
      createdAt: requireText(panelRow.created_at, "created_at")
    };
  }

  async getResolverAssignment(assignmentId: string): Promise<DotCastResolverAssignment | null> {
    const row = await this.db
      .prepare(
        `SELECT assignment_id, panel_id, pool_id, route_id, resolver_id, identity_hash,
                reputation_bps, bond_minor_units, status, assigned_at
         FROM dotcast_resolver_assignments
         WHERE assignment_id = ?`
      )
      .bind(assignmentId)
      .first();

    return row ? assignmentFromRow(row) : null;
  }

  async getResolverCommit(assignmentId: string): Promise<DotCastResolverCommit | null> {
    const row = await this.db
      .prepare(
        `SELECT assignment_id, panel_id, resolver_id, commit_hash, committed_at
         FROM dotcast_resolver_commits
         WHERE assignment_id = ?`
      )
      .bind(assignmentId)
      .first();

    return row ? commitFromRow(row) : null;
  }

  async listResolverCommits(panelId: string): Promise<DotCastResolverCommit[]> {
    const result = await this.db
      .prepare(
        `SELECT assignment_id, panel_id, resolver_id, commit_hash, committed_at
         FROM dotcast_resolver_commits
         WHERE panel_id = ?
         ORDER BY committed_at ASC, assignment_id ASC`
      )
      .bind(panelId)
      .all();

    return (result.results ?? []).map(commitFromRow);
  }

  async listResolverReveals(panelId: string): Promise<DotCastResolverReveal[]> {
    const result = await this.db
      .prepare(
        `SELECT assignment_id, panel_id, resolver_id, outcome, salt, revealed_at
         FROM dotcast_resolver_reveals
         WHERE panel_id = ?
         ORDER BY revealed_at ASC, assignment_id ASC`
      )
      .bind(panelId)
      .all();

    return (result.results ?? []).map(revealFromRow);
  }

  async insertResolverPanel(panel: DotCastResolverPanel): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolver_panels (
           panel_id, pool_id, route_id, tier, panel_size, estimated_stake_minor_units,
           resolver_fee_bps, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        panel.panelId,
        panel.poolId,
        panel.routeId,
        panel.tier,
        panel.panelSize,
        panel.estimatedStakeMinorUnits,
        panel.resolverFeeBps,
        panel.createdAt
      )
      .run();

    for (const assignment of panel.assignments) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO dotcast_resolver_assignments (
             assignment_id, panel_id, pool_id, route_id, resolver_id, identity_hash,
             reputation_bps, bond_minor_units, status, assigned_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          assignment.assignmentId,
          assignment.panelId,
          assignment.poolId,
          assignment.routeId,
          assignment.resolverId,
          assignment.identityHash,
          assignment.reputationBps,
          assignment.bondMinorUnits,
          assignment.status,
          assignment.assignedAt
        )
        .run();

      await this.ensureResolverProfileForAssignment(assignment);
      await this.applyResolverBondDelta({
        entryId: `dotcast:e13:bond-lock:${assignment.assignmentId}`,
        resolverId: assignment.resolverId,
        assignmentId: assignment.assignmentId,
        panelId: assignment.panelId,
        eventType: "assignment_locked",
        deltaMinorUnits: -assignment.bondMinorUnits,
        eventJson: {
          poolId: assignment.poolId,
          routeId: assignment.routeId,
          identityHash: assignment.identityHash
        },
        createdAt: assignment.assignedAt
      });
    }
  }

  async insertResolverCommit(commit: DotCastResolverCommit): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolver_commits (
           assignment_id, panel_id, resolver_id, commit_hash, committed_at
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        commit.assignmentId,
        commit.panelId,
        commit.resolverId,
        commit.commitHash,
        commit.committedAt
      )
      .run();
    await this.updateResolverAssignmentStatus(commit.assignmentId, "committed");
  }

  async insertResolverReveal(reveal: DotCastResolverReveal): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolver_reveals (
           assignment_id, panel_id, resolver_id, outcome, salt, revealed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        reveal.assignmentId,
        reveal.panelId,
        reveal.resolverId,
        reveal.outcome,
        reveal.salt,
        reveal.revealedAt
      )
      .run();
    await this.updateResolverAssignmentStatus(reveal.assignmentId, "revealed");
  }

  async insertResolverPayouts(payouts: DotCastResolverPayout[]): Promise<void> {
    for (const payout of payouts) {
      if (await this.resolverPayoutExists(payout.assignmentId, payout.panelId)) {
        continue;
      }

      await this.db
        .prepare(
          `INSERT OR IGNORE INTO dotcast_resolver_payouts (
             assignment_id, panel_id, resolver_id, matched_consensus, bond_returned_minor_units,
             fee_paid_minor_units, slashed_bond_minor_units, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          payout.assignmentId,
          payout.panelId,
          payout.resolverId,
          payout.matchedConsensus ? 1 : 0,
          payout.bondReturnedMinorUnits,
          payout.feePaidMinorUnits,
          payout.slashedBondMinorUnits,
          payout.createdAt
        )
        .run();
      await this.updateResolverAssignmentStatus(
        payout.assignmentId,
        payout.matchedConsensus ? "paid" : "slashed"
      );
      await this.applyResolverPayoutAccounting(payout);
    }
  }

  private async updateResolverAssignmentStatus(
    assignmentId: string,
    status: DotCastResolverAssignment["status"]
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dotcast_resolver_assignments
         SET status = ?
         WHERE assignment_id = ?`
      )
      .bind(status, assignmentId)
      .run();
  }

  private async ensureResolverProfileForAssignment(
    assignment: DotCastResolverAssignment
  ): Promise<void> {
    const existing = await this.getResolverProfile(assignment.resolverId);

    if (existing) {
      return;
    }

    await this.upsertResolverProfile({
      resolverId: assignment.resolverId,
      identityHash: assignment.identityHash,
      status: "active",
      displayName: null,
      reputationBps: assignment.reputationBps,
      bondAvailableMinorUnits: assignment.bondMinorUnits,
      stakeHeldPoolIds: [],
      metadata: {
        createdFromAssignmentId: assignment.assignmentId,
        createdFromPanelId: assignment.panelId
      },
      createdAt: assignment.assignedAt,
      updatedAt: assignment.assignedAt
    });
  }

  private async applyResolverPayoutAccounting(payout: DotCastResolverPayout): Promise<void> {
    const assignment = await this.getResolverAssignment(payout.assignmentId);

    if (!assignment) {
      throw new DotCastResolutionRouterError(
        "RESOLVER_ASSIGNMENT_NOT_FOUND",
        "resolver payout accounting requires the persisted assignment",
        404
      );
    }

    if (payout.matchedConsensus) {
      if (payout.bondReturnedMinorUnits > 0) {
        await this.applyResolverBondDelta({
          entryId: `dotcast:e13:bond-release:${payout.assignmentId}`,
          resolverId: payout.resolverId,
          assignmentId: payout.assignmentId,
          panelId: payout.panelId,
          eventType: "bond_released",
          deltaMinorUnits: payout.bondReturnedMinorUnits,
          eventJson: {
            matchedConsensus: true
          },
          createdAt: payout.createdAt
        });
      }

      if (payout.feePaidMinorUnits > 0) {
        await this.applyResolverBondDelta({
          entryId: `dotcast:e13:fee-credit:${payout.assignmentId}`,
          resolverId: payout.resolverId,
          assignmentId: payout.assignmentId,
          panelId: payout.panelId,
          eventType: "fee_credited",
          deltaMinorUnits: payout.feePaidMinorUnits,
          eventJson: {
            matchedConsensus: true
          },
          createdAt: payout.createdAt
        });
      }
    } else {
      await this.applyResolverBondDelta({
        entryId: `dotcast:e13:bond-slash:${payout.assignmentId}`,
        resolverId: payout.resolverId,
        assignmentId: payout.assignmentId,
        panelId: payout.panelId,
        eventType: "bond_slashed",
        deltaMinorUnits: 0,
        eventJson: {
          matchedConsensus: false,
          slashedBondMinorUnits: payout.slashedBondMinorUnits
        },
        createdAt: payout.createdAt
      });
    }

    await this.applyResolverReputationDelta(assignment, payout.matchedConsensus, payout.createdAt);
  }

  private async applyResolverBondDelta(
    entry: Omit<DotCastResolverBondLedgerEntry, "balanceAfterMinorUnits">
  ): Promise<void> {
    if (await this.bondLedgerEntryExists(entry.entryId)) {
      return;
    }

    const profile = await this.getResolverProfile(entry.resolverId);

    if (!profile) {
      throw new DotCastResolutionRouterError(
        "RESOLVER_PROFILE_NOT_FOUND",
        "resolver bond ledger requires a registered resolver profile",
        404
      );
    }

    const balanceAfter = profile.bondAvailableMinorUnits + entry.deltaMinorUnits;

    if (balanceAfter < 0) {
      throw new DotCastResolutionRouterError(
        "RESOLVER_BOND_INSUFFICIENT",
        "resolver does not have enough available bond for this E13 assignment",
        409
      );
    }

    await this.db
      .prepare(
        `UPDATE dotcast_resolver_profiles
         SET bond_available_minor_units = ?, updated_at = ?
         WHERE resolver_id = ?`
      )
      .bind(balanceAfter, entry.createdAt, entry.resolverId)
      .run();

    await this.insertResolverBondLedgerEntry({
      ...entry,
      balanceAfterMinorUnits: balanceAfter
    });
  }

  private async applyResolverReputationDelta(
    assignment: DotCastResolverAssignment,
    matchedConsensus: boolean,
    now: string
  ): Promise<void> {
    const eventId = `dotcast:e13:reputation:${assignment.assignmentId}`;

    if (await this.reputationEventExists(eventId)) {
      return;
    }

    const profile = await this.getResolverProfile(assignment.resolverId);

    if (!profile) {
      throw new DotCastResolutionRouterError(
        "RESOLVER_PROFILE_NOT_FOUND",
        "resolver reputation accounting requires a registered resolver profile",
        404
      );
    }

    const deltaBps = matchedConsensus
      ? RESOLVER_REPUTATION_CORRECT_DELTA_BPS
      : RESOLVER_REPUTATION_MISS_DELTA_BPS;
    const newReputationBps = clampBps(profile.reputationBps + deltaBps);

    await this.db
      .prepare(
        `UPDATE dotcast_resolver_profiles
         SET reputation_bps = ?, updated_at = ?
         WHERE resolver_id = ?`
      )
      .bind(newReputationBps, now, assignment.resolverId)
      .run();

    await this.insertResolverReputationEvent({
      eventId,
      resolverId: assignment.resolverId,
      assignmentId: assignment.assignmentId,
      panelId: assignment.panelId,
      previousReputationBps: profile.reputationBps,
      newReputationBps,
      deltaBps,
      reason: matchedConsensus ? "settlement_consensus_match" : "settlement_consensus_miss",
      eventJson: {
        poolId: assignment.poolId,
        routeId: assignment.routeId,
        matchedConsensus
      },
      createdAt: now
    });
  }

  private async bondLedgerEntryExists(entryId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT entry_id FROM dotcast_resolver_bond_ledger WHERE entry_id = ?`)
      .bind(entryId)
      .first();

    return Boolean(row);
  }

  private async resolverPayoutExists(assignmentId: string, panelId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT assignment_id
         FROM dotcast_resolver_payouts
         WHERE assignment_id = ? AND panel_id = ?`
      )
      .bind(assignmentId, panelId)
      .first();

    return Boolean(row);
  }

  private async reputationEventExists(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT event_id FROM dotcast_resolver_reputation_events WHERE event_id = ?`)
      .bind(eventId)
      .first();

    return Boolean(row);
  }

  private async insertResolverBondLedgerEntry(
    entry: DotCastResolverBondLedgerEntry
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolver_bond_ledger (
           entry_id, resolver_id, assignment_id, panel_id, event_type, delta_minor_units,
           balance_after_minor_units, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.entryId,
        entry.resolverId,
        entry.assignmentId,
        entry.panelId,
        entry.eventType,
        entry.deltaMinorUnits,
        entry.balanceAfterMinorUnits,
        JSON.stringify(entry.eventJson),
        entry.createdAt
      )
      .run();
  }

  private async insertResolverReputationEvent(
    event: DotCastResolverReputationEvent
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_resolver_reputation_events (
           event_id, resolver_id, assignment_id, panel_id, previous_reputation_bps,
           new_reputation_bps, delta_bps, reason, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.resolverId,
        event.assignmentId,
        event.panelId,
        event.previousReputationBps,
        event.newReputationBps,
        event.deltaBps,
        event.reason,
        JSON.stringify(event.eventJson),
        event.createdAt
      )
      .run();
  }
}

export function readDotCastResolutionRouterStatus(
  env: DotCastResolutionRouterEnv,
  hasDatabase: boolean
): DotCastResolutionRouterStatus {
  const enabled = env.DOTCAST_RESOLUTION_ROUTER_ENABLED !== "false";
  const minConfidenceBps = readBps(
    env.DOTCAST_RESOLUTION_CLASSIFIER_MIN_CONFIDENCE_BPS,
    DEFAULT_MIN_CONFIDENCE_BPS
  );
  const aiAutoConfidenceBps = readBps(
    env.DOTCAST_AI_PERCEPTION_AUTO_CONFIDENCE_BPS,
    DEFAULT_AI_AUTO_CONFIDENCE_BPS
  );
  const highStakesThresholdMinorUnits = readNonNegativeInteger(
    env.DOTCAST_RESOLUTION_HIGH_STAKES_THRESHOLD_MINOR_UNITS,
    DEFAULT_HIGH_STAKES_THRESHOLD_MINOR_UNITS
  );
  const basePanelSize = oddPanelSize(
    readNonNegativeInteger(env.DOTCAST_RESOLVER_BASE_PANEL_SIZE, DEFAULT_BASE_PANEL_SIZE)
  );
  const highStakesPanelSize = oddPanelSize(
    readNonNegativeInteger(
      env.DOTCAST_RESOLVER_HIGH_STAKES_PANEL_SIZE,
      DEFAULT_HIGH_STAKES_PANEL_SIZE
    )
  );
  const resolverMinBondMinorUnits = readNonNegativeInteger(
    env.DOTCAST_RESOLVER_MIN_BOND_MINOR_UNITS,
    DEFAULT_RESOLVER_MIN_BOND_MINOR_UNITS
  );
  const resolverHighStakesMinBondMinorUnits = readNonNegativeInteger(
    env.DOTCAST_RESOLVER_HIGH_STAKES_MIN_BOND_MINOR_UNITS,
    DEFAULT_RESOLVER_HIGH_STAKES_MIN_BOND_MINOR_UNITS
  );
  const resolverFeeBps = readBps(env.DOTCAST_RESOLVER_FEE_BPS, DEFAULT_RESOLVER_FEE_BPS);
  const challengeWindowSeconds = Math.max(
    60,
    readNonNegativeInteger(
      env.DOTCAST_RESOLUTION_CHALLENGE_WINDOW_SECONDS,
      DEFAULT_RESOLUTION_CHALLENGE_WINDOW_SECONDS
    )
  );
  const guards: string[] = [];

  if (!enabled) {
    guards.push("resolution router disabled");
  }

  if (!hasDatabase) {
    guards.push("resolution router audit database not configured");
  }

  if (aiAutoConfidenceBps < minConfidenceBps) {
    guards.push("ai auto confidence threshold is below classifier lock threshold");
  }

  return {
    enabled,
    ready: enabled && hasDatabase && aiAutoConfidenceBps >= minConfidenceBps,
    classifierVersion: CLASSIFIER_VERSION,
    minConfidenceBps,
    aiAutoConfidenceBps,
    highStakesThresholdMinorUnits,
    basePanelSize,
    highStakesPanelSize,
    resolverMinBondMinorUnits,
    resolverHighStakesMinBondMinorUnits,
    resolverFeeBps,
    challengeWindowSeconds,
    guards
  };
}

export function buildDotCastResolverRegistryProfile(
  input: UpsertDotCastResolverProfileInput
): DotCastResolverRegistryProfile {
  const now = input.now ?? new Date().toISOString();
  const reputationBps = input.reputationBps ?? DEFAULT_RESOLVER_REPUTATION_BPS;
  const bondAvailableMinorUnits = input.bondAvailableMinorUnits ?? 0;

  assertBps(reputationBps, "reputationBps");
  assertNonNegativeInteger(bondAvailableMinorUnits, "bondAvailableMinorUnits");

  return {
    resolverId: requireNonEmptyInput(input.resolverId, "resolverId"),
    identityHash: requireNonEmptyInput(input.identityHash, "identityHash"),
    status: input.status ?? "active",
    displayName: nullableText(input.displayName?.trim()),
    reputationBps,
    bondAvailableMinorUnits,
    stakeHeldPoolIds: uniqueStrings(input.stakeHeldPoolIds ?? []),
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now
  };
}

export function applyDotCastResolutionReviewDecision(
  input: ApplyDotCastResolutionReviewDecisionInput
): DotCastResolutionReviewDecisionResult {
  const now = input.now ?? new Date().toISOString();
  const reviewId =
    input.reviewId ??
    `dotcast:e13:review:${input.route.routeId}:${input.action}:${Date.parse(now)}`;
  const metadata = input.metadata ?? {};
  const resultingRoute = buildReviewedRoute(input, now);
  const status = reviewStatusForAction(input.action);
  const review: DotCastResolutionReview = {
    reviewId,
    routeId: input.route.routeId,
    poolId: input.route.poolId,
    marketId: input.route.marketId,
    status,
    reviewerId: nullableText(input.reviewerId?.trim()),
    decisionJson: {
      action: input.action,
      originalStatus: input.route.status,
      resultingRouteId: resultingRoute?.routeId ?? null,
      blockedReason: input.blockedReason ?? null,
      steeringPrompt: input.steeringPrompt ?? null,
      metadata
    },
    createdAt: now
  };

  return {
    review,
    resultingRoute,
    canOpenRealMoney: resultingRoute?.status === "locked"
  };
}

export function openDotCastResolutionChallenge(
  input: OpenDotCastResolutionChallengeInput
): DotCastResolutionChallenge {
  const now = input.now ?? new Date().toISOString();
  const windowSeconds = Math.max(
    60,
    Math.floor(input.windowSeconds ?? DEFAULT_RESOLUTION_CHALLENGE_WINDOW_SECONDS)
  );
  const openedAtMs = Date.parse(now);

  if (!Number.isFinite(openedAtMs)) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_CHALLENGE_TIME_INVALID",
      "challenge timestamp is invalid",
      422
    );
  }

  if (input.route.tier !== "optimistic_bonded") {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_CHALLENGE_ROUTE_INELIGIBLE",
      "only optimistic bonded E13 routes can be challenged",
      409
    );
  }

  if (input.route.status === "blocked" || input.route.status === "points_only") {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_CHALLENGE_ROUTE_CLOSED",
      "blocked or points-only E13 routes cannot be challenged",
      409
    );
  }

  const routeCreatedAtMs = Date.parse(input.route.createdAt);
  const routeWindowClosesAtMs =
    Number.isFinite(routeCreatedAtMs) && routeCreatedAtMs > 0
      ? routeCreatedAtMs + windowSeconds * 1000
      : openedAtMs + windowSeconds * 1000;

  if (openedAtMs > routeWindowClosesAtMs) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_CHALLENGE_WINDOW_CLOSED",
      "the E13 optimistic challenge window has closed",
      409
    );
  }

  const challengeWindowClosesAt = new Date(routeWindowClosesAtMs).toISOString();
  const challengerId = requireNonEmptyInput(input.challengerId, "challengerId");
  const reason = requireNonEmptyInput(input.reason, "reason");
  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
  const bondMinorUnits = input.bondMinorUnits ?? Math.max(0, input.route.bondMinorUnits);

  assertNonNegativeInteger(bondMinorUnits, "bondMinorUnits");

  return {
    challengeId:
      input.challengeId ??
      `dotcast:e13:challenge:${input.route.routeId}:${challengerId}:${Date.parse(now)}`,
    routeId: input.route.routeId,
    poolId: input.route.poolId,
    marketId: input.route.marketId,
    challengerId,
    status: "open",
    reason,
    evidenceRefs,
    bondMinorUnits,
    openedAt: now,
    challengeWindowClosesAt,
    decidedAt: null,
    decisionBy: null,
    decisionJson: {},
    eventJson: {
      routeTier: input.route.tier,
      routeStatus: input.route.status,
      routeCreatedAt: input.route.createdAt,
      metadata: input.metadata ?? {}
    }
  };
}

export function decideDotCastResolutionChallenge(
  input: DecideDotCastResolutionChallengeInput
): DotCastResolutionChallenge {
  const now = input.now ?? new Date().toISOString();

  if (input.challenge.status !== "open") {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_CHALLENGE_ALREADY_DECIDED",
      "only open E13 challenges can be decided",
      409
    );
  }

  const closesAtMs = Date.parse(input.challenge.challengeWindowClosesAt);
  const nowMs = Date.parse(now);

  if (input.action !== "expire" && Number.isFinite(closesAtMs) && nowMs > closesAtMs) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_CHALLENGE_WINDOW_CLOSED",
      "E13 challenge decisions after the window must use expire",
      409
    );
  }

  const status = challengeStatusForDecision(input.action);
  return {
    ...input.challenge,
    status,
    decidedAt: now,
    decisionBy: nullableText(input.decisionBy?.trim()),
    decisionJson: {
      action: input.action,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {}
    },
    eventJson: {
      ...input.challenge.eventJson,
      lastDecision: {
        action: input.action,
        decisionBy: input.decisionBy ?? null,
        reason: input.reason ?? null,
        at: now
      }
    }
  };
}

export function evaluateDotCastResolutionChallengeSettlementPolicy(
  route: DotCastResolutionRoute,
  challenges: DotCastResolutionChallenge[],
  options: EvaluateDotCastResolutionChallengeSettlementPolicyOptions = {}
): DotCastResolutionChallengeSettlementPolicy {
  const routeChallenges = challenges.filter((challenge) => challenge.routeId === route.routeId);
  const settlementSource = options.settlementSource ?? "optimistic_auto";
  const acceptedChallengeIds = routeChallenges
    .filter((challenge) => challenge.status === "accepted")
    .map((challenge) => challenge.challengeId);
  const openChallengeIds = routeChallenges
    .filter((challenge) => challenge.status === "open")
    .map((challenge) => challenge.challengeId);
  const rejectedChallengeIds = routeChallenges
    .filter((challenge) => challenge.status === "rejected")
    .map((challenge) => challenge.challengeId);
  const expiredChallengeIds = routeChallenges
    .filter((challenge) => challenge.status === "expired" || challenge.status === "withdrawn")
    .map((challenge) => challenge.challengeId);

  if (route.tier !== "optimistic_bonded") {
    return {
      action: "allow",
      reason: "not_optimistic_bonded",
      routeId: route.routeId,
      acceptedChallengeIds,
      rejectedChallengeIds,
      openChallengeIds,
      expiredChallengeIds
    };
  }

  if (acceptedChallengeIds.length > 0) {
    if (settlementSource === "resolver_consensus" || settlementSource === "manual_review") {
      return {
        action: "allow",
        reason: "accepted_challenge_resolved_by_escalation",
        routeId: route.routeId,
        acceptedChallengeIds,
        rejectedChallengeIds,
        openChallengeIds,
        expiredChallengeIds
      };
    }

    return {
      action: "block",
      reason: "accepted_challenge_blocks_optimistic_settlement",
      routeId: route.routeId,
      acceptedChallengeIds,
      rejectedChallengeIds,
      openChallengeIds,
      expiredChallengeIds
    };
  }

  if (openChallengeIds.length > 0) {
    return {
      action: "hold",
      reason: "open_challenge_holds_optimistic_settlement",
      routeId: route.routeId,
      acceptedChallengeIds,
      rejectedChallengeIds,
      openChallengeIds,
      expiredChallengeIds
    };
  }

  return {
    action: "allow",
    reason:
      rejectedChallengeIds.length > 0 || expiredChallengeIds.length > 0
        ? "all_challenges_rejected_or_expired"
        : "no_challenges",
    routeId: route.routeId,
    acceptedChallengeIds,
    rejectedChallengeIds,
    openChallengeIds,
    expiredChallengeIds
  };
}

export function applyDotCastResolverAdminAction(
  input: ApplyDotCastResolverAdminActionInput
): DotCastResolverAdminActionResult {
  const now = input.now ?? new Date().toISOString();
  const previousProfile = input.profile;
  const metadata = input.metadata ?? {};
  let profile: DotCastResolverRegistryProfile = {
    ...previousProfile,
    metadata: {
      ...previousProfile.metadata,
      lastAdminAction: {
        action: input.action,
        adminId: input.adminId ?? null,
        reason: input.reason ?? null,
        metadata,
        at: now
      }
    },
    updatedAt: now
  };
  let bondLedgerEntry: DotCastResolverBondLedgerEntry | null = null;
  let reputationEvent: DotCastResolverReputationEvent | null = null;

  if (input.action === "activate") {
    profile = { ...profile, status: "active" };
  } else if (input.action === "suspend") {
    profile = { ...profile, status: "suspended" };
  } else if (input.action === "archive") {
    profile = { ...profile, status: "archived" };
  } else if (input.action === "adjust_bond") {
    const deltaMinorUnits = requireSignedInteger(input.bondDeltaMinorUnits, "bondDeltaMinorUnits");
    const balanceAfterMinorUnits = profile.bondAvailableMinorUnits + deltaMinorUnits;

    if (balanceAfterMinorUnits < 0) {
      throw new DotCastResolutionRouterError(
        "RESOLVER_BOND_INSUFFICIENT",
        "manual resolver bond adjustment cannot make available bond negative",
        409
      );
    }

    profile = { ...profile, bondAvailableMinorUnits: balanceAfterMinorUnits };
    bondLedgerEntry = {
      entryId: `dotcast:e13:admin-bond:${profile.resolverId}:${Date.parse(now)}`,
      resolverId: profile.resolverId,
      assignmentId: null,
      panelId: null,
      eventType: "manual_adjustment",
      deltaMinorUnits,
      balanceAfterMinorUnits,
      eventJson: {
        adminId: input.adminId ?? null,
        reason: input.reason ?? null,
        metadata
      },
      createdAt: now
    };
  } else {
    const deltaBps = requireSignedInteger(input.reputationDeltaBps, "reputationDeltaBps");
    const newReputationBps = clampBps(profile.reputationBps + deltaBps);

    profile = { ...profile, reputationBps: newReputationBps };
    reputationEvent = {
      eventId: `dotcast:e13:admin-reputation:${profile.resolverId}:${Date.parse(now)}`,
      resolverId: profile.resolverId,
      assignmentId: null,
      panelId: null,
      previousReputationBps: previousProfile.reputationBps,
      newReputationBps,
      deltaBps,
      reason: "manual_adjustment",
      eventJson: {
        adminId: input.adminId ?? null,
        reason: input.reason ?? null,
        metadata
      },
      createdAt: now
    };
  }

  return {
    action: input.action,
    profile,
    previousProfile,
    bondLedgerEntry,
    reputationEvent
  };
}

export function classifyDotCastResolutionRoute(
  env: DotCastResolutionRouterEnv,
  input: ClassifyDotCastResolutionRouteInput
): DotCastResolutionRoute {
  const status = readDotCastResolutionRouterStatus(env, true);
  const now = input.now ?? new Date().toISOString();
  const market = input.market;
  const question = market.question.trim();
  const normalized = question.toLowerCase();
  const estimatedStakeMinorUnits = input.estimatedStakeMinorUnits ?? 0;
  const panelSize = panelSizeForStake(status, estimatedStakeMinorUnits);
  const bondMinorUnits = bondForStake(status, estimatedStakeMinorUnits);
  const providedSources = input.sources ?? [];
  const venueSource = market.venue === "kalshi" || market.venue === "polymarket";
  const hasExternalSource = Boolean(market.referenceUrl) || providedSources.length > 0;
  const hasStreamSource = Boolean(input.streamId);
  const baseSources = [
    ...providedSources,
    ...(venueSource
      ? [
          {
            kind: "router_market" as const,
            label: `${market.venue} market outcome`,
            url: market.referenceUrl ?? null,
            required: true
          }
        ]
      : []),
    ...(hasStreamSource
      ? [
          {
            kind: "livestream_ai" as const,
            label: `Mux/Livewire stream ${input.streamId}`,
            url: null,
            required: true
          }
        ]
      : [])
  ];

  const subjective = includesAny(normalized, SUBJECTIVE_TERMS);
  const aiPerception = hasStreamSource || includesAny(normalized, AI_PERCEPTION_TERMS);
  const computed = includesAny(normalized, COMPUTED_TERMS);
  const hardOracle =
    venueSource || includesAny(normalized, HARD_ORACLE_TERMS) || Boolean(market.referenceUrl);

  let tier: DotCastResolutionTier = "optimistic_bonded";
  let confidenceBps = 6400;
  let sourceAvailable = hasExternalSource || venueSource || hasStreamSource;
  let autoResolvable = false;
  let reviewRequired = true;
  let pointsOnly = false;
  let blockedReason: string | null = null;
  let steeringPrompt: string | null = null;
  let resolutionStatement = `Resolve "${question}" using the locked dotCast E13 route.`;

  if (subjective) {
    tier = "human_jury";
    confidenceBps = 4200;
    sourceAvailable = false;
    reviewRequired = true;
    pointsOnly = true;
    blockedReason = "question is subjective or normative without an objective fact source";
    steeringPrompt =
      "Reshape this into an externally verifiable yes/no question with a named source, cutoff time, and exact settling fact.";
    resolutionStatement = `Subjective question requires reshape or points-only jury review: "${question}".`;
  } else if (aiPerception) {
    tier = "ai_perception";
    confidenceBps = hasStreamSource ? 9200 : 7600;
    sourceAvailable = hasStreamSource;
    autoResolvable = hasStreamSource && confidenceBps >= status.aiAutoConfidenceBps;
    reviewRequired = !sourceAvailable || confidenceBps < status.minConfidenceBps;
    resolutionStatement = `Resolve from livestream perception evidence for "${question}" with AI confidence gate ${status.aiAutoConfidenceBps} bps.`;
  } else if (hardOracle && venueSource) {
    tier = "hard_oracle";
    confidenceBps = 9400;
    sourceAvailable = true;
    autoResolvable = true;
    reviewRequired = false;
    resolutionStatement = `Use the originating ${market.venue} final market outcome for "${question}".`;
  } else if (computed && hasExternalSource) {
    tier = "computed_oracle";
    confidenceBps = 8800;
    sourceAvailable = true;
    autoResolvable = true;
    reviewRequired = false;
    resolutionStatement = `Compute the outcome for "${question}" from the locked feed/source at market close.`;
  } else if (hardOracle) {
    tier = "hard_oracle";
    confidenceBps = 8600;
    sourceAvailable = true;
    autoResolvable = true;
    reviewRequired = false;
    resolutionStatement = `Use the originating ${market.venue} final market outcome for "${question}".`;
  }

  if (!sourceAvailable && tier !== "human_jury") {
    confidenceBps = Math.min(confidenceBps, 6200);
    reviewRequired = true;
    resolutionStatement = `No deterministic source is available yet for "${question}"; route to conservative review.`;
  }

  let routeStatus: DotCastResolutionRoute["status"] =
    sourceAvailable && confidenceBps >= status.minConfidenceBps ? "locked" : "review_required";

  if (pointsOnly) {
    routeStatus = input.unit === "usdc" ? "blocked" : "points_only";
  }

  return {
    routeId: routeIdFor(market.id, input.poolId ?? null, now),
    marketId: market.id,
    poolId: input.poolId ?? null,
    tier,
    status: routeStatus,
    confidenceBps,
    resolutionStatement,
    sources: baseSources.length > 0 ? baseSources : fallbackSources(tier),
    sourceAvailable,
    autoResolvable: routeStatus === "locked" && autoResolvable,
    reviewRequired: routeStatus !== "locked" || reviewRequired,
    pointsOnly: routeStatus === "points_only",
    blockedReason:
      routeStatus === "blocked"
        ? (blockedReason ?? "resolution route is not locked")
        : blockedReason,
    steeringPrompt,
    feeBps: tier === "optimistic_bonded" || tier === "human_jury" ? status.resolverFeeBps : 0,
    bondMinorUnits: tier === "optimistic_bonded" || tier === "human_jury" ? bondMinorUnits : 0,
    panelSize: tier === "optimistic_bonded" || tier === "human_jury" ? panelSize : 0,
    lockedAt: routeStatus === "locked" ? now : null,
    classifierVersion: status.classifierVersion,
    createdAt: now,
    eventJson: {
      unit: input.unit,
      streamId: input.streamId ?? null,
      estimatedStakeMinorUnits,
      classifierSignals: {
        hardOracle,
        computed,
        aiPerception,
        subjective,
        sourceAvailable
      }
    }
  };
}

export function prepareDotCastPoolResolutionRoute(
  env: DotCastResolutionRouterEnv,
  input: PrepareDotCastPoolResolutionRouteInput
): DotCastResolutionRoute {
  const now = input.now ?? new Date().toISOString();
  const route = input.explicitRoute
    ? normalizeExplicitRoute(input.explicitRoute, input.market.id, input.poolId ?? null, now)
    : classifyDotCastResolutionRoute(env, { ...input, now });

  if (input.unit === "usdc" && route.status !== "locked") {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_REQUIRED",
      "real-money dotCast pools require a locked E13 resolution route before creation",
      422
    );
  }

  return route;
}

export function assertLockedRealMoneyResolutionRoute(
  unit: StakeUnit,
  route: DotCastResolutionRoute | null | undefined
): void {
  if (unit !== "usdc") {
    return;
  }

  if (route?.status !== "locked") {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_REQUIRED",
      "real-money dotCast pools require a locked E13 resolution route before creation",
      422
    );
  }
}

export function resolveDotCastAiPerception(
  env: DotCastResolutionRouterEnv,
  input: ResolveDotCastAiPerceptionInput
): DotCastAiPerceptionResolutionResult {
  if (input.route.tier !== "ai_perception") {
    throw new DotCastResolutionRouterError(
      "AI_ROUTE_REQUIRED",
      "AI perception resolution requires an ai_perception route",
      400
    );
  }

  assertBps(input.modelConfidenceBps, "modelConfidenceBps");
  const status = readDotCastResolutionRouterStatus(env, true);
  const now = input.now ?? new Date().toISOString();
  const autoResolve = input.modelConfidenceBps >= status.aiAutoConfidenceBps;
  const action = autoResolve ? "auto_resolved" : "escalated";
  const log: DotCastAiResolutionLog = {
    logId: `dotcast:e13:ai-log:${input.route.routeId}:${Date.parse(now)}`,
    routeId: input.route.routeId,
    poolId: input.poolId ?? input.route.poolId,
    modelConfidenceBps: input.modelConfidenceBps,
    predictedOutcome: input.predictedOutcome,
    action,
    thresholdBps: status.aiAutoConfidenceBps,
    evidenceRefs: input.evidenceRefs ?? [],
    eventJson: {
      classifierVersion: input.route.classifierVersion,
      previousTier: input.route.tier
    },
    createdAt: now
  };
  const escalatedRoute = autoResolve
    ? null
    : {
        ...input.route,
        tier: "optimistic_bonded" as const,
        autoResolvable: false,
        reviewRequired: true,
        feeBps: status.resolverFeeBps,
        bondMinorUnits: bondForStake(status, 0),
        panelSize: status.basePanelSize,
        resolutionStatement: `${input.route.resolutionStatement} AI confidence was below threshold; use optimistic bonded dispute resolution.`,
        eventJson: {
          ...input.route.eventJson,
          aiEscalation: {
            modelConfidenceBps: input.modelConfidenceBps,
            thresholdBps: status.aiAutoConfidenceBps,
            at: now
          }
        }
      };

  return {
    status: action,
    outcome: autoResolve ? input.predictedOutcome : "pending",
    route: input.route,
    escalatedRoute,
    log
  };
}

export function selectDotCastResolverPanel(
  env: DotCastResolutionRouterEnv,
  input: SelectDotCastResolverPanelInput
): DotCastResolverPanel {
  const status = readDotCastResolutionRouterStatus(env, true);
  const now = input.now ?? new Date().toISOString();
  const estimatedStakeMinorUnits = input.estimatedStakeMinorUnits ?? 0;
  const panelSize = panelSizeForStake(status, estimatedStakeMinorUnits);
  const bondMinorUnits = bondForStake(status, estimatedStakeMinorUnits);
  const panelId =
    input.panelId ?? `dotcast:e13:panel:${input.poolId}:${input.route.routeId}:${Date.parse(now)}`;
  const stakeExcluded = new Set(input.positionUserIds ?? []);
  const uniqueCandidates = uniqueIdentityCandidates(input.candidates)
    .filter((candidate) => !stakeExcluded.has(candidate.resolverId))
    .filter((candidate) => !candidate.stakeHeldPoolIds.includes(input.poolId))
    .filter((candidate) => candidate.bondAvailableMinorUnits >= bondMinorUnits);
  const selected = deterministicResolverShuffle(uniqueCandidates, panelId).slice(0, panelSize);

  if (selected.length < panelSize) {
    throw new DotCastResolutionRouterError(
      "RESOLVER_PANEL_INSUFFICIENT",
      "not enough stake-excluded, bonded, unique-identity resolvers for the required panel",
      409
    );
  }

  return {
    panelId,
    poolId: input.poolId,
    routeId: input.route.routeId,
    tier: input.route.tier,
    panelSize,
    estimatedStakeMinorUnits,
    resolverFeeBps:
      input.route.tier === "optimistic_bonded" || input.route.tier === "human_jury"
        ? status.resolverFeeBps
        : 0,
    assignments: selected.map((candidate, index) => ({
      assignmentId: `${panelId}:assignment:${index + 1}`,
      panelId,
      poolId: input.poolId,
      routeId: input.route.routeId,
      resolverId: candidate.resolverId,
      identityHash: candidate.identityHash,
      reputationBps: candidate.reputationBps,
      bondMinorUnits,
      status: "assigned",
      assignedAt: now
    })),
    createdAt: now
  };
}

export async function createDotCastResolverCommit(
  input: CreateDotCastResolverCommitInput
): Promise<DotCastResolverCommit> {
  return {
    assignmentId: input.assignment.assignmentId,
    panelId: input.assignment.panelId,
    resolverId: input.assignment.resolverId,
    commitHash: await resolverCommitHash(input.outcome, input.salt),
    committedAt: input.now ?? new Date().toISOString()
  };
}

export async function revealDotCastResolverCommit(
  input: RevealDotCastResolverCommitInput
): Promise<DotCastResolverReveal> {
  const expected = await resolverCommitHash(input.outcome, input.salt);

  if (expected !== input.commit.commitHash) {
    throw new DotCastResolutionRouterError(
      "RESOLVER_REVEAL_MISMATCH",
      "resolver reveal does not match the committed hash",
      409
    );
  }

  return {
    assignmentId: input.commit.assignmentId,
    panelId: input.commit.panelId,
    resolverId: input.commit.resolverId,
    outcome: input.outcome,
    salt: input.salt,
    revealedAt: input.now ?? new Date().toISOString()
  };
}

export function settleDotCastResolverPanel(
  input: SettleDotCastResolverPanelInput
): DotCastResolverPanelSettlement {
  const now = input.now ?? new Date().toISOString();
  const revealsByAssignment = new Map(input.reveals.map((reveal) => [reveal.assignmentId, reveal]));
  const weights: Record<Side | "invalid", number> = { yes: 0, no: 0, invalid: 0 };

  for (const assignment of input.panel.assignments) {
    const reveal = revealsByAssignment.get(assignment.assignmentId);
    if (reveal) {
      weights[reveal.outcome] += Math.max(1, assignment.reputationBps);
    }
  }

  const consensusOutcome = (Object.entries(weights) as [Side | "invalid", number][]).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0][0];
  const totalWeight = weights.yes + weights.no + weights.invalid;
  const consensusWeight = weights[consensusOutcome];

  if (totalWeight <= 0) {
    throw new DotCastResolutionRouterError(
      "RESOLVER_PANEL_NO_REVEALS",
      "resolver panel cannot settle without at least one valid reveal",
      409
    );
  }

  const correctAssignments = input.panel.assignments.filter(
    (assignment) => revealsByAssignment.get(assignment.assignmentId)?.outcome === consensusOutcome
  );
  const feePool = Math.floor(
    (input.panel.estimatedStakeMinorUnits * input.panel.resolverFeeBps) / 10_000
  );
  const feePerCorrect =
    input.panel.resolverFeeBps > 0 && correctAssignments.length > 0
      ? Math.floor(feePool / correctAssignments.length)
      : 0;

  return {
    consensusOutcome,
    totalWeight,
    consensusWeight,
    payouts: input.panel.assignments.map((assignment) => {
      const reveal = revealsByAssignment.get(assignment.assignmentId);
      const matchedConsensus = reveal?.outcome === consensusOutcome;
      return {
        assignmentId: assignment.assignmentId,
        panelId: assignment.panelId,
        resolverId: assignment.resolverId,
        matchedConsensus,
        bondReturnedMinorUnits: matchedConsensus ? assignment.bondMinorUnits : 0,
        feePaidMinorUnits: matchedConsensus ? feePerCorrect : 0,
        slashedBondMinorUnits: matchedConsensus ? 0 : assignment.bondMinorUnits,
        createdAt: now
      };
    })
  };
}

export function evaluateDotCastResolverPanelTimeout(
  input: EvaluateDotCastResolverPanelTimeoutInput
): DotCastResolverPanelTimeoutResult {
  const now = input.now ?? new Date().toISOString();
  const commitsByAssignment = new Set((input.commits ?? []).map((commit) => commit.assignmentId));
  const revealsByAssignment = new Set((input.reveals ?? []).map((reveal) => reveal.assignmentId));
  const timedOutAssignments = input.panel.assignments.filter((assignment) => {
    if (assignment.status === "paid" || assignment.status === "slashed") {
      return false;
    }

    if (input.phase === "commit") {
      return !commitsByAssignment.has(assignment.assignmentId);
    }

    return !revealsByAssignment.has(assignment.assignmentId);
  });
  const timedOutAssignmentIds = timedOutAssignments.map((assignment) => assignment.assignmentId);

  return {
    phase: input.phase,
    timedOutAssignmentIds,
    unaffectedAssignmentIds: input.panel.assignments
      .filter((assignment) => !timedOutAssignmentIds.includes(assignment.assignmentId))
      .map((assignment) => assignment.assignmentId),
    payouts: timedOutAssignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      panelId: assignment.panelId,
      resolverId: assignment.resolverId,
      matchedConsensus: false,
      bondReturnedMinorUnits: 0,
      feePaidMinorUnits: 0,
      slashedBondMinorUnits: assignment.bondMinorUnits,
      createdAt: now
    })),
    createdAt: now
  };
}

function buildReviewedRoute(
  input: ApplyDotCastResolutionReviewDecisionInput,
  now: string
): DotCastResolutionRoute {
  const resolutionStatement =
    nullableText(input.resolutionStatement?.trim()) ?? input.route.resolutionStatement;
  const sources = input.sources && input.sources.length > 0 ? input.sources : input.route.sources;
  const reviewEvent = {
    operatorReview: {
      action: input.action,
      reviewerId: input.reviewerId ?? null,
      reviewedAt: now,
      metadata: input.metadata ?? {}
    }
  };

  if (input.action === "approve") {
    if (sources.length === 0) {
      throw new DotCastResolutionRouterError(
        "RESOLUTION_REVIEW_SOURCE_REQUIRED",
        "operator approval requires at least one E13 resolution source",
        422
      );
    }

    return {
      ...input.route,
      routeId: reviewedRouteId(input.route.routeId, "approved", now),
      status: "locked",
      confidenceBps: Math.max(input.route.confidenceBps, 8000),
      resolutionStatement,
      sources,
      sourceAvailable: true,
      autoResolvable: false,
      reviewRequired: false,
      pointsOnly: false,
      blockedReason: null,
      steeringPrompt: null,
      lockedAt: now,
      createdAt: now,
      eventJson: {
        ...input.route.eventJson,
        ...reviewEvent
      }
    };
  }

  if (input.action === "deny") {
    return {
      ...input.route,
      routeId: reviewedRouteId(input.route.routeId, "denied", now),
      status: "blocked",
      autoResolvable: false,
      reviewRequired: true,
      pointsOnly: false,
      blockedReason: input.blockedReason ?? "operator denied the E13 resolution route",
      steeringPrompt: input.steeringPrompt ?? input.route.steeringPrompt,
      lockedAt: null,
      createdAt: now,
      eventJson: {
        ...input.route.eventJson,
        ...reviewEvent
      }
    };
  }

  return {
    ...input.route,
    routeId: reviewedRouteId(input.route.routeId, "reshaped", now),
    status: "review_required",
    confidenceBps: Math.min(input.route.confidenceBps, 7900),
    resolutionStatement,
    sources,
    sourceAvailable: sources.length > 0,
    autoResolvable: false,
    reviewRequired: true,
    pointsOnly: false,
    blockedReason: null,
    steeringPrompt:
      input.steeringPrompt ??
      "Review the reshaped E13 route before opening this market to real-money pools.",
    lockedAt: null,
    createdAt: now,
    eventJson: {
      ...input.route.eventJson,
      ...reviewEvent
    }
  };
}

function normalizeExplicitRoute(
  route: DotCastResolutionRoute,
  marketId: string,
  poolId: string | null,
  now: string
): DotCastResolutionRoute {
  if (route.marketId !== marketId) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_MARKET_MISMATCH",
      "explicit resolution route marketId does not match the pool market",
      409
    );
  }

  if (route.status === "locked" && !route.lockedAt) {
    return { ...route, poolId, lockedAt: now };
  }

  return { ...route, poolId: route.poolId ?? poolId };
}

function routeFromRow(row: Record<string, unknown>): DotCastResolutionRoute {
  return {
    routeId: requireText(row.route_id, "route_id"),
    marketId: requireText(row.market_id, "market_id"),
    poolId: nullableText(row.pool_id),
    tier: parseTier(row.tier),
    status: parseRouteStatus(row.status),
    confidenceBps: requireInteger(row.confidence_bps, "confidence_bps"),
    resolutionStatement: requireText(row.resolution_statement, "resolution_statement"),
    sources: parseSources(row.sources_json),
    sourceAvailable: row.source_available === 1,
    autoResolvable: row.auto_resolvable === 1,
    reviewRequired: row.review_required === 1,
    pointsOnly: row.points_only === 1,
    blockedReason: nullableText(row.blocked_reason),
    steeringPrompt: nullableText(row.steering_prompt),
    feeBps: requireInteger(row.fee_bps, "fee_bps"),
    bondMinorUnits: requireInteger(row.bond_minor_units, "bond_minor_units"),
    panelSize: requireInteger(row.panel_size, "panel_size"),
    lockedAt: nullableText(row.locked_at),
    classifierVersion: requireText(row.classifier_version, "classifier_version"),
    createdAt: requireText(row.created_at, "created_at"),
    eventJson: parseRecord(row.event_json, "event_json")
  };
}

function resolverProfileFromRow(row: Record<string, unknown>): DotCastResolverRegistryProfile {
  return {
    resolverId: requireText(row.resolver_id, "resolver_id"),
    identityHash: requireText(row.identity_hash, "identity_hash"),
    status: parseResolverStatus(row.status),
    displayName: nullableText(row.display_name),
    reputationBps: requireInteger(row.reputation_bps, "reputation_bps"),
    bondAvailableMinorUnits: requireInteger(
      row.bond_available_minor_units,
      "bond_available_minor_units"
    ),
    stakeHeldPoolIds: parseStringArray(row.stake_held_pool_ids_json, "stake_held_pool_ids_json"),
    metadata: parseRecord(row.metadata_json, "metadata_json"),
    createdAt: requireText(row.created_at, "created_at"),
    updatedAt: requireText(row.updated_at, "updated_at")
  };
}

function resolverBondLedgerFromRow(row: Record<string, unknown>): DotCastResolverBondLedgerEntry {
  return {
    entryId: requireText(row.entry_id, "entry_id"),
    resolverId: requireText(row.resolver_id, "resolver_id"),
    assignmentId: nullableText(row.assignment_id),
    panelId: nullableText(row.panel_id),
    eventType: parseResolverBondLedgerEventType(row.event_type),
    deltaMinorUnits: requireInteger(row.delta_minor_units, "delta_minor_units"),
    balanceAfterMinorUnits: requireInteger(
      row.balance_after_minor_units,
      "balance_after_minor_units"
    ),
    eventJson: parseRecord(row.event_json, "event_json"),
    createdAt: requireText(row.created_at, "created_at")
  };
}

function reviewFromRow(row: Record<string, unknown>): DotCastResolutionReview {
  return {
    reviewId: requireText(row.review_id, "review_id"),
    routeId: requireText(row.route_id, "route_id"),
    poolId: nullableText(row.pool_id),
    marketId: requireText(row.market_id, "market_id"),
    status: parseReviewStatus(row.status),
    reviewerId: nullableText(row.reviewer_id),
    decisionJson: parseRecord(row.decision_json, "decision_json"),
    createdAt: requireText(row.created_at, "created_at")
  };
}

function challengeFromRow(row: Record<string, unknown>): DotCastResolutionChallenge {
  return {
    challengeId: requireText(row.challenge_id, "challenge_id"),
    routeId: requireText(row.route_id, "route_id"),
    poolId: nullableText(row.pool_id),
    marketId: requireText(row.market_id, "market_id"),
    challengerId: requireText(row.challenger_id, "challenger_id"),
    status: parseChallengeStatus(row.status),
    reason: requireText(row.reason, "reason"),
    evidenceRefs: parseStringArray(row.evidence_refs_json, "evidence_refs_json"),
    bondMinorUnits: requireInteger(row.bond_minor_units, "bond_minor_units"),
    openedAt: requireText(row.opened_at, "opened_at"),
    challengeWindowClosesAt: requireText(
      row.challenge_window_closes_at,
      "challenge_window_closes_at"
    ),
    decidedAt: nullableText(row.decided_at),
    decisionBy: nullableText(row.decision_by),
    decisionJson: parseRecord(row.decision_json, "decision_json"),
    eventJson: parseRecord(row.event_json, "event_json")
  };
}

function assignmentFromRow(row: Record<string, unknown>): DotCastResolverAssignment {
  return {
    assignmentId: requireText(row.assignment_id, "assignment_id"),
    panelId: requireText(row.panel_id, "panel_id"),
    poolId: requireText(row.pool_id, "pool_id"),
    routeId: requireText(row.route_id, "route_id"),
    resolverId: requireText(row.resolver_id, "resolver_id"),
    identityHash: requireText(row.identity_hash, "identity_hash"),
    reputationBps: requireInteger(row.reputation_bps, "reputation_bps"),
    bondMinorUnits: requireInteger(row.bond_minor_units, "bond_minor_units"),
    status: parseAssignmentStatus(row.status),
    assignedAt: requireText(row.assigned_at, "assigned_at")
  };
}

function commitFromRow(row: Record<string, unknown>): DotCastResolverCommit {
  return {
    assignmentId: requireText(row.assignment_id, "assignment_id"),
    panelId: requireText(row.panel_id, "panel_id"),
    resolverId: requireText(row.resolver_id, "resolver_id"),
    commitHash: requireText(row.commit_hash, "commit_hash"),
    committedAt: requireText(row.committed_at, "committed_at")
  };
}

function revealFromRow(row: Record<string, unknown>): DotCastResolverReveal {
  return {
    assignmentId: requireText(row.assignment_id, "assignment_id"),
    panelId: requireText(row.panel_id, "panel_id"),
    resolverId: requireText(row.resolver_id, "resolver_id"),
    outcome: parseResolvedOutcome(row.outcome),
    salt: requireText(row.salt, "salt"),
    revealedAt: requireText(row.revealed_at, "revealed_at")
  };
}

function routeParams(route: DotCastResolutionRoute): unknown[] {
  return [
    route.routeId,
    route.marketId,
    route.poolId,
    route.tier,
    route.status,
    route.confidenceBps,
    route.resolutionStatement,
    JSON.stringify(route.sources),
    route.sourceAvailable ? 1 : 0,
    route.autoResolvable ? 1 : 0,
    route.reviewRequired ? 1 : 0,
    route.pointsOnly ? 1 : 0,
    route.blockedReason,
    route.steeringPrompt,
    route.feeBps,
    route.bondMinorUnits,
    route.panelSize,
    route.lockedAt,
    route.classifierVersion,
    JSON.stringify(route.eventJson),
    route.createdAt
  ];
}

function challengeParams(challenge: DotCastResolutionChallenge): unknown[] {
  return [
    challenge.challengeId,
    challenge.routeId,
    challenge.poolId,
    challenge.marketId,
    challenge.challengerId,
    challenge.status,
    challenge.reason,
    JSON.stringify(challenge.evidenceRefs),
    challenge.bondMinorUnits,
    challenge.openedAt,
    challenge.challengeWindowClosesAt,
    challenge.decidedAt,
    challenge.decisionBy,
    JSON.stringify(challenge.decisionJson),
    JSON.stringify(challenge.eventJson)
  ];
}

function parseSources(value: unknown): DotCastResolutionSource[] {
  const parsed = parseJson(value, "sources_json");

  if (!Array.isArray(parsed)) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_ROW_INVALID",
      "resolution route sources_json must decode to an array",
      500
    );
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new DotCastResolutionRouterError(
        "RESOLUTION_ROUTE_ROW_INVALID",
        `resolution route source ${index} must be an object`,
        500
      );
    }

    const source = item as Record<string, unknown>;
    return {
      kind: parseSourceKind(source.kind),
      label: requireText(source.label, `sources[${index}].label`),
      url: nullableText(source.url),
      required: source.required === true
    };
  });
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed as Record<string, unknown>;
}

function parseStringArray(value: unknown, label: string): string[] {
  const parsed = parseJson(value, label);

  if (!Array.isArray(parsed)) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_ROW_INVALID",
      `${label} must decode to an array`,
      500
    );
  }

  return parsed.map((item, index) => {
    if (typeof item !== "string") {
      throw new DotCastResolutionRouterError(
        "RESOLUTION_ROUTE_ROW_INVALID",
        `${label}[${index}] must be a string`,
        500
      );
    }

    return item;
  });
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_ROW_INVALID",
      `${label} must be stored as JSON text`,
      500
    );
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTE_ROW_INVALID",
      `${label} must be valid JSON`,
      500
    );
  }
}

function parseTier(value: unknown): DotCastResolutionTier {
  if (
    value === "hard_oracle" ||
    value === "computed_oracle" ||
    value === "ai_perception" ||
    value === "optimistic_bonded" ||
    value === "human_jury"
  ) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolution tier is invalid",
    500
  );
}

function parseRouteStatus(value: unknown): DotCastResolutionRoute["status"] {
  if (
    value === "locked" ||
    value === "review_required" ||
    value === "points_only" ||
    value === "blocked"
  ) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolution route status is invalid",
    500
  );
}

function parseSourceKind(value: unknown): DotCastResolutionSource["kind"] {
  if (
    value === "router_market" ||
    value === "external_oracle" ||
    value === "computed_feed" ||
    value === "livestream_ai" ||
    value === "resolver_network" ||
    value === "manual_review"
  ) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolution source kind is invalid",
    500
  );
}

function parseResolverStatus(value: unknown): DotCastResolverStatus {
  if (value === "active" || value === "suspended" || value === "archived") {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolver status is invalid",
    500
  );
}

function parseResolverBondLedgerEventType(
  value: unknown
): DotCastResolverBondLedgerEntry["eventType"] {
  if (
    value === "resolver_onboarded" ||
    value === "bond_deposited" ||
    value === "assignment_locked" ||
    value === "bond_released" ||
    value === "bond_slashed" ||
    value === "fee_credited" ||
    value === "manual_adjustment"
  ) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolver bond ledger event type is invalid",
    500
  );
}

function parseReviewStatus(value: unknown): DotCastResolutionReview["status"] {
  if (value === "queued" || value === "approved" || value === "denied" || value === "reshaped") {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolution review status is invalid",
    500
  );
}

function parseChallengeStatus(value: unknown): DotCastResolutionChallenge["status"] {
  if (
    value === "open" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "expired" ||
    value === "withdrawn"
  ) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolution challenge status is invalid",
    500
  );
}

function parseAssignmentStatus(value: unknown): DotCastResolverAssignment["status"] {
  if (
    value === "assigned" ||
    value === "committed" ||
    value === "revealed" ||
    value === "paid" ||
    value === "slashed"
  ) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolver assignment status is invalid",
    500
  );
}

function parseResolvedOutcome(value: unknown): Side | "invalid" {
  if (value === "yes" || value === "no" || value === "invalid") {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    "stored resolver reveal outcome is invalid",
    500
  );
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    `${label} is missing from stored E13 row`,
    500
  );
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "RESOLUTION_ROUTE_ROW_INVALID",
    `${label} must be an integer in stored E13 row`,
    500
  );
}

function fallbackSources(tier: DotCastResolutionTier): DotCastResolutionSource[] {
  if (tier === "human_jury") {
    return [{ kind: "manual_review", label: "Human jury review", url: null, required: true }];
  }

  return [
    {
      kind: tier === "ai_perception" ? "livestream_ai" : "resolver_network",
      label: "dotCast resolution review",
      url: null,
      required: true
    }
  ];
}

function routeIdFor(marketId: string, poolId: string | null, now: string): string {
  return `dotcast:e13:route:${poolId ?? marketId}:${Date.parse(now)}`;
}

function reviewedRouteId(routeId: string, action: "approved" | "denied" | "reshaped", now: string) {
  return `${routeId}:review:${action}:${Date.parse(now)}`;
}

function reviewStatusForAction(
  action: DotCastResolutionReviewAction
): DotCastResolutionReview["status"] {
  if (action === "approve") {
    return "approved";
  }

  if (action === "deny") {
    return "denied";
  }

  return "reshaped";
}

function challengeStatusForDecision(
  action: DotCastResolutionChallengeDecisionAction
): DotCastResolutionChallenge["status"] {
  if (action === "accept") {
    return "accepted";
  }

  if (action === "reject") {
    return "rejected";
  }

  return "expired";
}

function panelSizeForStake(
  status: DotCastResolutionRouterStatus,
  estimatedStakeMinorUnits: number
): number {
  return estimatedStakeMinorUnits >= status.highStakesThresholdMinorUnits
    ? status.highStakesPanelSize
    : status.basePanelSize;
}

function bondForStake(
  status: DotCastResolutionRouterStatus,
  estimatedStakeMinorUnits: number
): number {
  return estimatedStakeMinorUnits >= status.highStakesThresholdMinorUnits
    ? status.resolverHighStakesMinBondMinorUnits
    : status.resolverMinBondMinorUnits;
}

function uniqueIdentityCandidates(candidates: DotCastResolverProfile[]): DotCastResolverProfile[] {
  const byIdentity = new Map<string, DotCastResolverProfile>();

  for (const candidate of candidates) {
    const existing = byIdentity.get(candidate.identityHash);
    if (!existing || candidate.reputationBps > existing.reputationBps) {
      byIdentity.set(candidate.identityHash, candidate);
    }
  }

  return [...byIdentity.values()];
}

function deterministicResolverShuffle(
  candidates: DotCastResolverProfile[],
  seed: string
): DotCastResolverProfile[] {
  return [...candidates].sort((a, b) => {
    const aScore = stableScore(`${seed}:${a.resolverId}:${a.identityHash}`);
    const bScore = stableScore(`${seed}:${b.resolverId}:${b.identityHash}`);
    return aScore - bScore || b.reputationBps - a.reputationBps;
  });
}

function stableScore(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

async function resolverCommitHash(outcome: Side | "invalid", salt: string): Promise<string> {
  if (!salt) {
    throw new DotCastResolutionRouterError(
      "RESOLVER_SALT_REQUIRED",
      "resolver commit salt is required",
      400
    );
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${outcome}:${salt}`)
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function includesAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function requireNonEmptyInput(value: string, label: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new DotCastResolutionRouterError("INVALID_RESOLVER_PROFILE", `${label} is required`, 400);
  }

  return trimmed;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DotCastResolutionRouterError(
      "INVALID_RESOLVER_PROFILE",
      `${label} must be a non-negative integer`,
      400
    );
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function requireSignedInteger(value: number | undefined, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== 0) {
    return value;
  }

  throw new DotCastResolutionRouterError(
    "INVALID_RESOLVER_ADMIN_ACTION",
    `${label} must be a non-zero integer`,
    400
  );
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, value));
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    return fallback;
  }

  return Math.min(500, value);
}

function readBps(value: string | undefined, fallback: number): number {
  const parsed = readNonNegativeInteger(value, fallback);
  return Math.max(0, Math.min(10_000, parsed));
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function oddPanelSize(value: number): number {
  const minimum = Math.max(1, value);
  return minimum % 2 === 1 ? minimum : minimum + 1;
}

function assertBps(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new DotCastResolutionRouterError(
      "INVALID_CONFIDENCE_BPS",
      `${label} must be an integer between 0 and 10000`,
      400
    );
  }
}

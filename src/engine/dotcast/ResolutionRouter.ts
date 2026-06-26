import type {
  DotCastAiResolutionLog,
  DotCastMarketSnapshot,
  DotCastResolutionOutcome,
  DotCastResolutionRoute,
  DotCastResolutionSource,
  DotCastResolutionTier,
  DotCastResolverAssignment,
  DotCastResolverCommit,
  DotCastResolverPanel,
  DotCastResolverPayout,
  DotCastResolverProfile,
  DotCastResolverReveal,
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

export interface DotCastResolverPanelSettlement {
  consensusOutcome: Side | "invalid";
  totalWeight: number;
  consensusWeight: number;
  payouts: DotCastResolverPayout[];
}

export interface DotCastResolutionRouterStore {
  insertRoute(route: DotCastResolutionRoute): Promise<void>;
  appendAiResolutionLog(log: DotCastAiResolutionLog): Promise<void>;
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
  }

  async insertResolverPayouts(payouts: DotCastResolverPayout[]): Promise<void> {
    for (const payout of payouts) {
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
    }
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
    guards
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

  if (!route || route.status !== "locked") {
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

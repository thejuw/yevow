import {
  confirmMockWithdrawal,
  confirmDotCastCreatorPayout,
  applyDotCastGamificationSettlement,
  applyDotCastCreatorRakeShareSettlement,
  creditDevnetDeposit,
  D1DotCastCreatorStore,
  D1DotCastReferralStore,
  D1DotCastResolutionRouterStore,
  D1DotCastSettlementRailStore,
  D1DotCastGamificationStore,
  D1DotCastRewardedStreamStore,
  D1DotCastSponsoredQuestionStore,
  D1DotCastUsdcPoolFundingStore,
  D1DotCastLivestreamStore,
  DotCastCreatorEconomyError,
  DotCastReferralError,
  DotCastGamificationError,
  DotCastResolutionRouterError,
  DotCastRewardedStreamError,
  DotCastSponsoredQuestionError,
  DotCastSettlementRailError,
  DotCastLivestreamError,
  DotCastUsdcPoolFundingError,
  buildMuxLivestreamRecord,
  buildMuxPlaybackDescriptor,
  claimDotCastReferral,
  createDotCastSponsoredQuestion,
  createDotCastReferralCode,
  createMuxLiveStream,
  fetchDotCastReferencePrice,
  impliedProb,
  listDotCastSponsoredQuestionFeed,
  onboardDotCastCreator,
  planCreatorPoolNudges,
  applyDotCastReferralQualification,
  classifyDotCastResolutionRoute,
  createDotCastResolverCommit,
  parseVerifiedMuxWebhook,
  previewPayout,
  readSettlementBalance,
  readDotCastCreatorEconomyStatus,
  readDotCastCreatorSummary,
  readDotCastReferralStatus,
  readDotCastReferralUserSummary,
  readDotCastGamificationStatus,
  readDotCastGamificationUserSummary,
  readDotCastResolutionRouterStatus,
  readDotCastRewardedStreamStatus,
  readDotCastRewardedStreamUserSummary,
  readDotCastSponsoredQuestionsStatus,
  readMuxLivestreamConfig,
  readSolanaUsdcSettlementRailStatus,
  readUsdcPoolFundingStatus,
  reconcileDevnetSettlementRail,
  recordDotCastCreatorPoolSeed,
  recordDotCastSponsoredQuestionBillingEvent,
  prepareDotCastPoolResolutionRoute,
  resolveDotCastAiPerception,
  revealDotCastResolverCommit,
  releaseUsdcPoolEntryReservation,
  reserveUsdcPoolEntry,
  requestDevnetWithdrawal,
  requestDotCastCreatorPayout,
  selectDotCastResolverPanel,
  settleParimutuel,
  settleDotCastResolverPanel,
  type CreatorNudgeRecipient,
  startDotCastRewardedStreamSession,
  completeDotCastRewardedStreamSession,
  type DotCastLiveOddsSnapshot,
  type DotCastLivestreamMetadata,
  type DotCastMarketSnapshot,
  type DotCastPoolSnapshot,
  type DotCastReferencePriceFetchResult,
  type DotCastResolutionOutcome,
  type DotCastResolutionRoute,
  type DotCastResolutionSource,
  type DotCastCreatorKycStatus,
  type DotCastResolverAssignment,
  type DotCastResolverCommit,
  type DotCastResolverPanel,
  type DotCastResolverProfile,
  type DotCastResolverReveal,
  type DotCastCreatorSeedMode,
  type DotCastCreatorStatus,
  type DotCastCreatorTier,
  type DotCastReferralQualificationEvent,
  type DotCastResolutionBinding,
  type DotCastSponsoredQuestionBillingEventType,
  type DotCastSponsoredQuestionPricingModel,
  type DotCastSponsoredQuestionStatus,
  type SponsoredQuestionIntegrityAttestation,
  type SettlementEntry,
  type Side,
  type SideTotals,
  type StakeUnit
} from "../engine/dotcast";
import type { Env } from "../types";
import { json, readJsonBody, withCors } from "./ResponseHelpers";

interface DotCastPreviewRequest {
  pools?: Partial<SideTotals>;
  side?: unknown;
  amount?: unknown;
  rake?: unknown;
}

interface DotCastSettlementSimulationRequest {
  entries?: unknown;
  outcome?: unknown;
  rake?: unknown;
}

interface DotCastCreatePoolRequest {
  id?: unknown;
  market?: Partial<DotCastMarketSnapshot>;
  unit?: unknown;
  entryOpensAt?: unknown;
  entryClosesAt?: unknown;
  rake?: unknown;
  minLiquidity?: unknown;
  resolutionRoute?: unknown;
  streamId?: unknown;
  estimatedStake?: unknown;
  sourceBindings?: unknown;
  creator?: DotCastCreatorAttributionRequest;
  originatingCreatorId?: unknown;
  creatorDisplayName?: unknown;
  now?: unknown;
}

interface DotCastResolutionClassifierRequest {
  market?: Partial<DotCastMarketSnapshot>;
  unit?: unknown;
  poolId?: unknown;
  streamId?: unknown;
  estimatedStake?: unknown;
  sourceBindings?: unknown;
  now?: unknown;
}

interface DotCastAiPerceptionResolutionRequest {
  route?: unknown;
  poolId?: unknown;
  modelConfidenceBps?: unknown;
  predictedOutcome?: unknown;
  evidenceRefs?: unknown;
  now?: unknown;
}

interface DotCastResolverPanelRequest {
  poolId?: unknown;
  route?: unknown;
  candidates?: unknown;
  positionUserIds?: unknown;
  estimatedStake?: unknown;
  panelId?: unknown;
  now?: unknown;
}

interface DotCastResolverCommitRequest {
  assignment?: unknown;
  outcome?: unknown;
  salt?: unknown;
  now?: unknown;
}

interface DotCastResolverRevealRequest {
  commit?: unknown;
  outcome?: unknown;
  salt?: unknown;
  now?: unknown;
}

interface DotCastResolverSettleRequest {
  panel?: unknown;
  reveals?: unknown;
  now?: unknown;
}

interface DotCastCreateLivestreamRequest {
  streamId?: unknown;
  hostId?: unknown;
  title?: unknown;
  now?: unknown;
  metadata?: unknown;
}

interface DotCastAttachLivestreamPoolRequest {
  poolId?: unknown;
  marketId?: unknown;
  question?: unknown;
  unit?: unknown;
  status?: unknown;
  pinned?: unknown;
  now?: unknown;
}

interface DotCastArchiveLivestreamRequest {
  now?: unknown;
}

interface DotCastPlaceEntryRequest {
  userId?: unknown;
  side?: unknown;
  amount?: unknown;
  now?: unknown;
  entryId?: unknown;
  streamId?: unknown;
}

interface ParsedDotCastPlaceEntry {
  userId: string;
  side: Side;
  amount: number;
  now?: string;
  entryId: string;
}

interface DotCastSettlePoolRequest {
  outcome?: unknown;
  now?: unknown;
  streamId?: unknown;
}

interface DotCastVoidPoolRequest {
  reason?: unknown;
  now?: unknown;
  streamId?: unknown;
}

interface DotCastRouterResolutionRequest {
  marketId?: unknown;
  outcome?: unknown;
  resolvedAt?: unknown;
  fetchedAt?: unknown;
  stale?: unknown;
  source?: unknown;
  now?: unknown;
  maxGraceMs?: unknown;
  streamId?: unknown;
}

interface DotCastPollResolutionRequest {
  now?: unknown;
  streamId?: unknown;
}

interface DotCastDevnetDepositRequest {
  userId?: unknown;
  amount?: unknown;
  txRef?: unknown;
  confirmations?: unknown;
  now?: unknown;
}

interface DotCastDevnetWithdrawalRequest {
  userId?: unknown;
  amount?: unknown;
  destination?: unknown;
  idempotencyKey?: unknown;
  now?: unknown;
}

interface DotCastConfirmWithdrawalRequest {
  txRef?: unknown;
  now?: unknown;
}

interface DotCastReconcileRailRequest {
  custodiedAmount?: unknown;
  now?: unknown;
}

interface DotCastStartRewardedStreamRequest {
  userId?: unknown;
  streamId?: unknown;
  sessionId?: unknown;
  now?: unknown;
}

interface DotCastCompleteRewardedStreamRequest {
  watchedSeconds?: unknown;
  now?: unknown;
}

interface DotCastCreateSponsoredQuestionRequest {
  sponsorshipId?: unknown;
  sponsorId?: unknown;
  campaignId?: unknown;
  market?: unknown;
  pricingModel?: unknown;
  budgetMinorUnits?: unknown;
  placementPriority?: unknown;
  sponsorName?: unknown;
  brandColor?: unknown;
  logoUrl?: unknown;
  contextText?: unknown;
  sponsorAliases?: unknown;
  conflictTerms?: unknown;
  relationshipToOutcome?: unknown;
  attestation?: unknown;
  status?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  now?: unknown;
  metadata?: unknown;
}

interface DotCastCreatorAttributionRequest {
  creatorId?: unknown;
  displayName?: unknown;
}

interface DotCastOnboardCreatorRequest {
  creatorId?: unknown;
  displayName?: unknown;
  tier?: unknown;
  status?: unknown;
  kycStatus?: unknown;
  payoutDestination?: unknown;
  accuracyBps?: unknown;
  retentionBps?: unknown;
  volumeScore?: unknown;
  manualReviewRequired?: unknown;
  sponsorshipEligible?: unknown;
  metadata?: unknown;
  now?: unknown;
}

interface DotCastApplyCreatorAccrualRequest {
  now?: unknown;
}

interface DotCastCreatorPayoutRequest {
  amount?: unknown;
  destination?: unknown;
  idempotencyKey?: unknown;
  operatorApproved?: unknown;
  now?: unknown;
}

interface DotCastConfirmCreatorPayoutRequest {
  txRef?: unknown;
  now?: unknown;
}

interface DotCastCreatorNudgePlanRequest {
  poolId?: unknown;
  recipients?: unknown;
  now?: unknown;
  metadata?: unknown;
}

interface DotCastCreatorSeedRequest {
  seedId?: unknown;
  poolId?: unknown;
  unit?: unknown;
  amount?: unknown;
  mode?: unknown;
  resolutionBinding?: unknown;
  creatorHoldsPosition?: unknown;
  now?: unknown;
  eventJson?: unknown;
}

interface DotCastReferralCodeRequest {
  userId?: unknown;
  identityHash?: unknown;
  walletAddress?: unknown;
  code?: unknown;
  now?: unknown;
}

interface DotCastReferralClaimRequest {
  code?: unknown;
  referrerUserId?: unknown;
  referredUserId?: unknown;
  referrerIdentityHash?: unknown;
  referredIdentityHash?: unknown;
  referredWalletAddress?: unknown;
  idempotencyKey?: unknown;
  eventJson?: unknown;
  now?: unknown;
}

interface DotCastReferralQualificationRequest {
  referredUserId?: unknown;
  eventType?: unknown;
  depositAmount?: unknown;
  txRef?: unknown;
  kycComplete?: unknown;
  firstAdFundedEntryEarned?: unknown;
  withdrawalAt?: unknown;
  withdrawalWithinHours?: unknown;
  depositWithdrawPattern?: unknown;
  clusterKey?: unknown;
  relatedReferralIds?: unknown;
  relatedIdentityHashes?: unknown;
  idempotencyKey?: unknown;
  eventJson?: unknown;
  now?: unknown;
}

interface DotCastSponsoredQuestionBillingRequest {
  eventType?: unknown;
  quantity?: unknown;
  amountMinorUnits?: unknown;
  idempotencyKey?: unknown;
  now?: unknown;
  eventJson?: unknown;
}

export function readDotCastHealth(env?: Env): Response {
  const settlementRail = env ? readSolanaUsdcSettlementRailStatus(env) : null;
  const usdcPoolFunding = env ? readUsdcPoolFundingStatus(env) : null;
  const livestream = env ? readMuxLivestreamConfig(env) : null;
  const gamification = env
    ? readDotCastGamificationStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
    : null;
  const rewardedStream = env
    ? readDotCastRewardedStreamStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
    : null;
  const sponsoredQuestions = env
    ? readDotCastSponsoredQuestionsStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
    : null;
  const creatorEconomy = env
    ? readDotCastCreatorEconomyStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
    : null;
  const referrals = env
    ? readDotCastReferralStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
    : null;
  const resolutionRouter = env
    ? readDotCastResolutionRouterStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
    : null;

  return json({
    ok: true,
    product: "dotCast",
    engine: "live-parimutuel",
    milestones: {
      e0: "parimutuel-core-ready",
      e1: "pool-lifecycle-core-ready",
      e2: "router-resolution-polling-ready",
      e3: "live-odds-reference-endpoint-ready",
      e4: "void-refund-core-ready",
      e5: "solana-usdc-devnet-mock-rail-ready",
      e6: "usdc-pool-funding-devnet-ready",
      e7: "audit-ledger-core-ready",
      e8: gamification?.ready ? "gamification-ledger-ready" : "gamification-code-ready",
      e9: rewardedStream?.ready
        ? "rewarded-stream-onramp-ready"
        : "rewarded-stream-onramp-code-ready",
      e10: sponsoredQuestions?.ready
        ? "sponsored-questions-placement-ready"
        : "sponsored-questions-code-ready",
      e11: creatorEconomy?.ready ? "creator-economy-ready" : "creator-economy-code-ready",
      e12: referrals?.ready ? "referrals-ready" : "referrals-code-ready",
      e13: resolutionRouter?.ready ? "resolution-router-ready" : "resolution-router-code-ready",
      persistence: "durable-object-ready",
      livestreamEngine: "stream-spine-ready",
      livestreamProvider: livestream?.ready ? "mux-livewire-ready" : "mux-livewire-code-ready",
      livestreamRealtime: "sse-odds-results-ready",
      settlementRail: settlementRail?.ready ? "devnet-mock-ready" : "devnet-mock-code-ready",
      usdcPoolFunding: usdcPoolFunding?.ready ? "devnet-ready" : "devnet-code-ready"
    },
    ...(settlementRail ? { settlementRail } : {}),
    ...(usdcPoolFunding ? { usdcPoolFunding } : {}),
    ...(livestream ? { livestream } : {}),
    ...(gamification ? { gamification } : {}),
    ...(rewardedStream ? { rewardedStream } : {}),
    ...(sponsoredQuestions ? { sponsoredQuestions } : {}),
    ...(creatorEconomy ? { creatorEconomy } : {}),
    ...(referrals ? { referrals } : {}),
    ...(resolutionRouter ? { resolutionRouter } : {}),
    routes: [
      "GET /api/dotcast/health",
      "POST /api/dotcast/preview",
      "POST /api/dotcast/settlement/simulate",
      "GET /api/dotcast/settlement-rail/status",
      "GET /api/dotcast/settlement-rail/balances/:userId",
      "POST /api/dotcast/settlement-rail/deposits/devnet",
      "POST /api/dotcast/settlement-rail/withdrawals/devnet",
      "POST /api/dotcast/settlement-rail/withdrawals/:id/confirm",
      "POST /api/dotcast/settlement-rail/reconcile/devnet",
      "GET /api/dotcast/gamification/users/:userId",
      "POST /api/dotcast/gamification/pools/:id/apply",
      "GET /api/dotcast/rewarded-streams/status",
      "GET /api/dotcast/rewarded-streams/users/:userId",
      "POST /api/dotcast/rewarded-streams/sessions",
      "POST /api/dotcast/rewarded-streams/sessions/:sessionId/complete",
      "GET /api/dotcast/sponsored-questions/status",
      "GET /api/dotcast/sponsored-questions/feed",
      "GET /api/dotcast/sponsored-questions/:id",
      "POST /api/dotcast/sponsored-questions",
      "POST /api/dotcast/sponsored-questions/:id/billing-events",
      "GET /api/dotcast/creators/status",
      "POST /api/dotcast/creators",
      "GET /api/dotcast/creators/:id",
      "POST /api/dotcast/creators/:id/pools/:poolId/apply-rake-share",
      "POST /api/dotcast/creators/:id/payouts",
      "POST /api/dotcast/creators/:id/payouts/:payoutId/confirm",
      "POST /api/dotcast/creators/:id/nudges/plan",
      "POST /api/dotcast/creators/:id/seeds",
      "GET /api/dotcast/referrals/status",
      "POST /api/dotcast/referrals/codes",
      "GET /api/dotcast/referrals/users/:userId",
      "POST /api/dotcast/referrals/claims",
      "POST /api/dotcast/referrals/:id/qualify",
      "GET /api/dotcast/resolution-router/status",
      "POST /api/dotcast/resolution-router/classify",
      "POST /api/dotcast/resolution-router/ai-perception/resolve",
      "POST /api/dotcast/resolution-router/resolvers/panel",
      "POST /api/dotcast/resolution-router/resolvers/commit",
      "POST /api/dotcast/resolution-router/resolvers/reveal",
      "POST /api/dotcast/resolution-router/resolvers/settle",
      "POST /api/dotcast/livestreams",
      "GET /api/dotcast/livestreams/:id",
      "GET /api/dotcast/livestreams/:id/playback",
      "POST /api/dotcast/livestreams/:id/start",
      "POST /api/dotcast/livestreams/:id/pause",
      "POST /api/dotcast/livestreams/:id/resume",
      "POST /api/dotcast/livestreams/:id/end",
      "POST /api/dotcast/livestreams/:id/archive",
      "POST /api/dotcast/livestreams/:id/pools",
      "DELETE /api/dotcast/livestreams/:id/pools/:poolId",
      "POST /api/dotcast/livestreams/:id/featured",
      "POST /api/dotcast/livestreams/:id/presence",
      "GET /api/dotcast/livestreams/:id/events",
      "GET /api/dotcast/livestreams/:id/stream",
      "POST /api/dotcast/livestreams/:id/pools/:poolId/refresh",
      "POST /api/dotcast/livestreams/webhooks/mux",
      "POST /api/dotcast/pools",
      "GET /api/dotcast/pools/:id",
      "GET /api/dotcast/pools/:id/odds",
      "POST /api/dotcast/pools/:id/entries",
      "POST /api/dotcast/pools/:id/lock",
      "POST /api/dotcast/pools/:id/settle",
      "POST /api/dotcast/pools/:id/resolution",
      "POST /api/dotcast/pools/:id/poll-resolution",
      "POST /api/dotcast/pools/:id/void"
    ]
  });
}

export function readDotCastSettlementRailStatus(env: Env): Response {
  return json({
    ok: true,
    milestone: "E5",
    rail: readSolanaUsdcSettlementRailStatus(env),
    safeguards: {
      privateKeysInRepo: false,
      signer: "mock",
      mainnetWithdrawals: "blocked-until-operator-approval"
    }
  });
}

export async function readDotCastSettlementRailBalance(
  userId: string,
  env: Env
): Promise<Response> {
  try {
    const balance = await readSettlementBalance(
      settlementRailStore(env),
      parseRequiredString(userId, "userId")
    );

    return json({
      ok: true,
      milestone: "E5",
      balance,
      rail: readSolanaUsdcSettlementRailStatus(env)
    });
  } catch (error) {
    return settlementRailErrorResponse(error);
  }
}

export async function recordDotCastDevnetDeposit(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastDevnetDepositRequest>(request);
    const result = await creditDevnetDeposit(settlementRailStore(env), env, {
      userId: parseRequiredString(body?.userId, "userId"),
      amount: parseMinorUnits(body?.amount, "amount"),
      txRef: parseRequiredString(body?.txRef, "txRef"),
      confirmations: parseOptionalMinorUnits(body?.confirmations, "confirmations") ?? 0,
      now: parseOptionalString(body?.now, "now")
    });

    return json({
      ok: true,
      milestone: "E5",
      ...result
    });
  } catch (error) {
    return settlementRailErrorResponse(error);
  }
}

export async function requestDotCastDevnetWithdrawal(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastDevnetWithdrawalRequest>(request);
    const result = await requestDevnetWithdrawal(settlementRailStore(env), env, {
      userId: parseRequiredString(body?.userId, "userId"),
      amount: parseMinorUnits(body?.amount, "amount"),
      destination: parseRequiredString(body?.destination, "destination"),
      idempotencyKey: parseRequiredString(body?.idempotencyKey, "idempotencyKey"),
      now: parseOptionalString(body?.now, "now")
    });

    return json({
      ok: true,
      milestone: "E5",
      ...result
    });
  } catch (error) {
    return settlementRailErrorResponse(error);
  }
}

export async function confirmDotCastMockWithdrawal(
  transferId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastConfirmWithdrawalRequest>(request);
    const result = await confirmMockWithdrawal(settlementRailStore(env), env, {
      transferId: parseRequiredString(transferId, "transferId"),
      txRef: parseOptionalString(body?.txRef, "txRef"),
      now: parseOptionalString(body?.now, "now")
    });

    return json({
      ok: true,
      milestone: "E5",
      ...result
    });
  } catch (error) {
    return settlementRailErrorResponse(error);
  }
}

export async function reconcileDotCastDevnetSettlementRail(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastReconcileRailRequest>(request);
    const result = await reconcileDevnetSettlementRail(settlementRailStore(env), env, {
      custodiedAmount: parseMinorUnits(body?.custodiedAmount, "custodiedAmount", true),
      now: parseOptionalString(body?.now, "now")
    });

    return json({
      ok: true,
      milestone: "E5",
      reconciliation: result
    });
  } catch (error) {
    return settlementRailErrorResponse(error);
  }
}

export async function readDotCastGamificationUser(userId: string, env: Env): Promise<Response> {
  try {
    const summary = await readDotCastGamificationUserSummary(
      gamificationStore(env),
      parseRequiredString(userId, "userId")
    );

    return json({
      ok: true,
      milestone: "E8",
      gamification: readDotCastGamificationStatus(env, true),
      summary
    });
  } catch (error) {
    return gamificationErrorResponse(error);
  }
}

export async function applyDotCastGamificationForPool(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<{ now?: unknown }>(request);
    const now = parseOptionalString(body?.now, "now") ?? new Date().toISOString();
    const snapshot = await readDotCastPoolSnapshot(poolId, env);
    const result = await applyDotCastGamificationSettlement(gamificationStore(env), env, snapshot, {
      now,
      hasDatabase: true
    });

    return json({
      ok: true,
      milestone: "E8",
      gamification: summarizeGamificationResult(result)
    });
  } catch (error) {
    return gamificationErrorResponse(error);
  }
}

export function readDotCastRewardedStreamOnrampStatus(env: Env): Response {
  return json({
    ok: true,
    milestone: "E9",
    rewardedStream: readDotCastRewardedStreamStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
  });
}

export async function readDotCastRewardedStreamUser(userId: string, env: Env): Promise<Response> {
  try {
    const summary = await readDotCastRewardedStreamUserSummary(
      rewardedStreamStore(env),
      env,
      parseRequiredString(userId, "userId"),
      true
    );

    return json({
      ok: true,
      milestone: "E9",
      rewardedStream: summary
    });
  } catch (error) {
    return rewardedStreamErrorResponse(error);
  }
}

export async function startDotCastRewardedStreamOnrampSession(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastStartRewardedStreamRequest>(request);
    const streamId = parseRequiredString(body?.streamId, "streamId");
    const stream = await requireLivestreamRecord(streamId, env);
    const result = await startDotCastRewardedStreamSession(
      rewardedStreamStore(env),
      env,
      {
        userId: parseRequiredString(body?.userId, "userId"),
        stream,
        sessionId: parseOptionalString(body?.sessionId, "sessionId"),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json(
      {
        ok: true,
        milestone: "E9",
        rewardedStream: result
      },
      result.idempotent ? 200 : 201
    );
  } catch (error) {
    return rewardedStreamErrorResponse(error);
  }
}

export async function completeDotCastRewardedStreamOnrampSession(
  sessionId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCompleteRewardedStreamRequest>(request);
    const store = rewardedStreamStore(env);
    const session = await store.getSession(parseRequiredString(sessionId, "sessionId"));

    if (!session) {
      throw new DotCastRewardedStreamError(
        "REWARDED_STREAM_SESSION_NOT_FOUND",
        "rewarded stream session was not found",
        404
      );
    }

    const stream = await requireLivestreamRecord(session.streamId, env);
    const result = await completeDotCastRewardedStreamSession(
      store,
      env,
      {
        session,
        stream,
        watchedSeconds: parseOptionalMinorUnits(body?.watchedSeconds, "watchedSeconds"),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json({
      ok: true,
      milestone: "E9",
      rewardedStream: result
    });
  } catch (error) {
    return rewardedStreamErrorResponse(error);
  }
}

export function readDotCastSponsoredQuestionPlacementStatus(env: Env): Response {
  return json({
    ok: true,
    milestone: "E10",
    sponsoredQuestions: readDotCastSponsoredQuestionsStatus(
      env,
      Boolean(env.DOTCAST_DB ?? env.TRADING_DB)
    )
  });
}

export async function createDotCastSponsoredQuestionPlacement(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreateSponsoredQuestionRequest>(request);
    const result = await createDotCastSponsoredQuestion(
      sponsoredQuestionStore(env),
      env,
      {
        sponsorshipId: parseOptionalString(body?.sponsorshipId, "sponsorshipId"),
        sponsorId: parseRequiredString(body?.sponsorId, "sponsorId"),
        campaignId: parseRequiredString(body?.campaignId, "campaignId"),
        market: parseSponsoredQuestionMarket(body?.market),
        pricingModel: parseSponsoredQuestionPricingModel(body?.pricingModel),
        budgetMinorUnits: parseOptionalMinorUnits(body?.budgetMinorUnits, "budgetMinorUnits"),
        placementPriority: parseOptionalSignedInteger(body?.placementPriority, "placementPriority"),
        sponsorName: parseRequiredString(body?.sponsorName, "sponsorName"),
        brandColor: parseNullableString(body?.brandColor, "brandColor"),
        logoUrl: parseNullableString(body?.logoUrl, "logoUrl"),
        contextText: parseNullableString(body?.contextText, "contextText"),
        sponsorAliases: parseOptionalStringArray(body?.sponsorAliases, "sponsorAliases"),
        conflictTerms: parseOptionalStringArray(body?.conflictTerms, "conflictTerms"),
        relationshipToOutcome: parseSponsoredQuestionRelationship(body?.relationshipToOutcome),
        attestation: parseSponsoredQuestionAttestation(body?.attestation),
        status: parseOptionalSponsorshipStatus(body?.status),
        startsAt: parseNullableString(body?.startsAt, "startsAt"),
        endsAt: parseNullableString(body?.endsAt, "endsAt"),
        now: parseOptionalString(body?.now, "now"),
        metadata: parseMetadataRecord(body?.metadata)
      },
      true
    );

    return json(
      {
        ok: true,
        milestone: "E10",
        sponsoredQuestion: result
      },
      201
    );
  } catch (error) {
    return sponsoredQuestionErrorResponse(error);
  }
}

export async function listDotCastSponsoredQuestionPlacements(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const result = await listDotCastSponsoredQuestionFeed(
      sponsoredQuestionStore(env),
      env,
      {
        now: parseOptionalString(url.searchParams.get("now"), "now"),
        limit: parseOptionalQueryInteger(url.searchParams.get("limit"), "limit")
      },
      true
    );

    return json({
      ok: true,
      milestone: "E10",
      sponsoredQuestions: result
    });
  } catch (error) {
    return sponsoredQuestionErrorResponse(error);
  }
}

export async function readDotCastSponsoredQuestionPlacement(
  sponsorshipId: string,
  env: Env
): Promise<Response> {
  try {
    const sponsorship = await sponsoredQuestionStore(env).getSponsorship(
      parseRequiredString(sponsorshipId, "sponsorshipId")
    );

    if (!sponsorship) {
      throw new DotCastSponsoredQuestionError(
        "SPONSORED_QUESTION_NOT_FOUND",
        "sponsored question was not found",
        404
      );
    }

    return json({
      ok: true,
      milestone: "E10",
      sponsoredQuestion: sponsorship
    });
  } catch (error) {
    return sponsoredQuestionErrorResponse(error);
  }
}

export async function recordDotCastSponsoredQuestionPlacementBilling(
  sponsorshipId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastSponsoredQuestionBillingRequest>(request);
    const store = sponsoredQuestionStore(env);
    const sponsorship = await store.getSponsorship(
      parseRequiredString(sponsorshipId, "sponsorshipId")
    );

    if (!sponsorship) {
      throw new DotCastSponsoredQuestionError(
        "SPONSORED_QUESTION_NOT_FOUND",
        "sponsored question was not found",
        404
      );
    }

    const result = await recordDotCastSponsoredQuestionBillingEvent(
      store,
      env,
      {
        sponsorship,
        eventType: parseSponsoredQuestionBillingEventType(body?.eventType),
        quantity: parseOptionalMinorUnits(body?.quantity, "quantity"),
        amountMinorUnits: parseOptionalMinorUnits(body?.amountMinorUnits, "amountMinorUnits"),
        idempotencyKey: parseOptionalString(body?.idempotencyKey, "idempotencyKey"),
        now: parseOptionalString(body?.now, "now"),
        eventJson: parseMetadataRecord(body?.eventJson)
      },
      true
    );

    return json({
      ok: true,
      milestone: "E10",
      sponsoredQuestionBilling: result
    });
  } catch (error) {
    return sponsoredQuestionErrorResponse(error);
  }
}

export function readDotCastCreatorEconomyReadiness(env: Env): Response {
  return json({
    ok: true,
    milestone: "E11",
    creatorEconomy: readDotCastCreatorEconomyStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
  });
}

export async function onboardDotCastCreatorProfile(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastOnboardCreatorRequest>(request);
    const result = await onboardDotCastCreator(
      creatorStore(env),
      env,
      {
        creatorId: parseRequiredString(body?.creatorId, "creatorId"),
        displayName: parseRequiredString(body?.displayName, "displayName"),
        tier: parseOptionalCreatorTier(body?.tier),
        status: parseOptionalCreatorStatus(body?.status),
        kycStatus: parseOptionalCreatorKycStatus(body?.kycStatus),
        payoutDestination: parseNullableString(body?.payoutDestination, "payoutDestination"),
        accuracyBps: parseOptionalMinorUnits(body?.accuracyBps, "accuracyBps"),
        retentionBps: parseOptionalMinorUnits(body?.retentionBps, "retentionBps"),
        volumeScore: parseOptionalMinorUnits(body?.volumeScore, "volumeScore"),
        manualReviewRequired: parseOptionalBoolean(
          body?.manualReviewRequired,
          "manualReviewRequired"
        ),
        sponsorshipEligible: parseOptionalBoolean(body?.sponsorshipEligible, "sponsorshipEligible"),
        metadata: parseMetadataRecord(body?.metadata),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json(
      {
        ok: true,
        milestone: "E11",
        creatorEconomy: result
      },
      201
    );
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export async function readDotCastCreatorProfile(
  creatorId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const limit = parseOptionalQueryInteger(
      new URL(request.url).searchParams.get("limit"),
      "limit"
    );
    const summary = await readDotCastCreatorSummary(
      creatorStore(env),
      parseRequiredString(creatorId, "creatorId"),
      limit ?? 25
    );

    return json({
      ok: true,
      milestone: "E11",
      creatorEconomy: {
        status: readDotCastCreatorEconomyStatus(env, true),
        summary
      }
    });
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export async function applyDotCastCreatorRakeShareForPool(
  creatorId: string,
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastApplyCreatorAccrualRequest>(request);
    const snapshot = await readDotCastPoolSnapshot(poolId, env);
    const parsedCreatorId = parseRequiredString(creatorId, "creatorId");

    if (snapshot.pool.originatingCreatorId !== parsedCreatorId) {
      throw new DotCastCreatorEconomyError(
        "CREATOR_POOL_ATTRIBUTION_MISMATCH",
        "pool is not attributed to this creator",
        409
      );
    }

    const result = await applyDotCastCreatorRakeShareSettlement(
      creatorStore(env),
      env,
      {
        snapshot,
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json({
      ok: true,
      milestone: "E11",
      creatorEconomy: summarizeCreatorAccrualResult(result)
    });
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export async function requestDotCastCreatorEconomyPayout(
  creatorId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreatorPayoutRequest>(request);
    const result = await requestDotCastCreatorPayout(
      creatorStore(env),
      settlementRailStore(env),
      env,
      {
        creatorId: parseRequiredString(creatorId, "creatorId"),
        amount: parseMinorUnits(body?.amount, "amount"),
        destination: parseOptionalString(body?.destination, "destination"),
        idempotencyKey: parseRequiredString(body?.idempotencyKey, "idempotencyKey"),
        operatorApproved: parseOptionalBoolean(body?.operatorApproved, "operatorApproved"),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json({
      ok: true,
      milestone: "E11",
      creatorEconomy: result
    });
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export async function confirmDotCastCreatorEconomyPayout(
  creatorId: string,
  payoutId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    parseRequiredString(creatorId, "creatorId");
    const body = await readJsonBody<DotCastConfirmCreatorPayoutRequest>(request);
    const result = await confirmDotCastCreatorPayout(
      creatorStore(env),
      settlementRailStore(env),
      env,
      {
        payoutId: parseRequiredString(payoutId, "payoutId"),
        txRef: parseOptionalString(body?.txRef, "txRef"),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    if (result.payout.creatorId !== creatorId) {
      throw new DotCastCreatorEconomyError(
        "CREATOR_PAYOUT_ATTRIBUTION_MISMATCH",
        "payout does not belong to this creator",
        409
      );
    }

    return json({
      ok: true,
      milestone: "E11",
      creatorEconomy: result
    });
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export async function planDotCastCreatorNudges(
  creatorId: string,
  request: Request
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreatorNudgePlanRequest>(request);
    const plan = planCreatorPoolNudges({
      creatorId: parseRequiredString(creatorId, "creatorId"),
      poolId: parseRequiredString(body?.poolId, "poolId"),
      recipients: parseCreatorNudgeRecipients(body?.recipients),
      now: parseOptionalString(body?.now, "now"),
      metadata: parseMetadataRecord(body?.metadata)
    });

    return json({
      ok: true,
      milestone: "E11",
      creatorEconomy: {
        nudgePlan: plan,
        suppressedCount: plan.suppressed.length,
        allowedCount: plan.allowed.length
      }
    });
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export async function recordDotCastCreatorSeed(
  creatorId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreatorSeedRequest>(request);
    const result = await recordDotCastCreatorPoolSeed(
      creatorStore(env),
      env,
      {
        seedId: parseOptionalString(body?.seedId, "seedId"),
        creatorId: parseRequiredString(creatorId, "creatorId"),
        poolId: parseRequiredString(body?.poolId, "poolId"),
        unit: parseStakeUnit(body?.unit),
        amount: parseMinorUnits(body?.amount, "amount"),
        mode: parseCreatorSeedMode(body?.mode),
        resolutionBinding: parseResolutionBinding(body?.resolutionBinding),
        creatorHoldsPosition: parseOptionalBoolean(
          body?.creatorHoldsPosition,
          "creatorHoldsPosition"
        ),
        now: parseOptionalString(body?.now, "now"),
        eventJson: parseMetadataRecord(body?.eventJson)
      },
      true
    );

    return json({
      ok: true,
      milestone: "E11",
      creatorEconomy: result
    });
  } catch (error) {
    return creatorEconomyErrorResponse(error);
  }
}

export function readDotCastReferralProgramStatus(env: Env): Response {
  return json({
    ok: true,
    milestone: "E12",
    referrals: readDotCastReferralStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
  });
}

export async function createDotCastReferralProgramCode(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastReferralCodeRequest>(request);
    const result = await createDotCastReferralCode(
      referralStore(env),
      env,
      {
        userId: parseRequiredString(body?.userId, "userId"),
        identityHash: parseRequiredString(body?.identityHash, "identityHash"),
        walletAddress: parseNullableString(body?.walletAddress, "walletAddress"),
        code: parseOptionalString(body?.code, "code"),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json(
      {
        ok: true,
        milestone: "E12",
        referrals: result
      },
      result.idempotent ? 200 : 201
    );
  } catch (error) {
    return referralErrorResponse(error);
  }
}

export async function readDotCastReferralProgramUser(
  userId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const limit = parseOptionalQueryInteger(
      new URL(request.url).searchParams.get("limit"),
      "limit"
    );
    const summary = await readDotCastReferralUserSummary(
      referralStore(env),
      parseRequiredString(userId, "userId"),
      limit ?? 25
    );

    return json({
      ok: true,
      milestone: "E12",
      referrals: {
        status: readDotCastReferralStatus(env, true),
        summary
      }
    });
  } catch (error) {
    return referralErrorResponse(error);
  }
}

export async function claimDotCastReferralProgram(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastReferralClaimRequest>(request);
    const result = await claimDotCastReferral(
      referralStore(env),
      env,
      {
        code: parseOptionalString(body?.code, "code"),
        referrerUserId: parseOptionalString(body?.referrerUserId, "referrerUserId"),
        referredUserId: parseRequiredString(body?.referredUserId, "referredUserId"),
        referrerIdentityHash: parseOptionalString(
          body?.referrerIdentityHash,
          "referrerIdentityHash"
        ),
        referredIdentityHash: parseRequiredString(
          body?.referredIdentityHash,
          "referredIdentityHash"
        ),
        referredWalletAddress: parseNullableString(
          body?.referredWalletAddress,
          "referredWalletAddress"
        ),
        idempotencyKey: parseOptionalString(body?.idempotencyKey, "idempotencyKey"),
        eventJson: parseMetadataRecord(body?.eventJson),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json(
      {
        ok: true,
        milestone: "E12",
        referrals: result
      },
      result.idempotent ? 200 : 201
    );
  } catch (error) {
    return referralErrorResponse(error);
  }
}

export async function applyDotCastReferralProgramQualification(
  referralId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastReferralQualificationRequest>(request);
    const result = await applyDotCastReferralQualification(
      referralStore(env),
      env,
      {
        referralId: parseRequiredString(referralId, "referralId"),
        referredUserId: parseOptionalString(body?.referredUserId, "referredUserId"),
        eventType: parseOptionalReferralQualificationEvent(body?.eventType),
        depositAmount: parseOptionalMinorUnits(body?.depositAmount, "depositAmount"),
        txRef: parseOptionalString(body?.txRef, "txRef"),
        kycComplete: parseOptionalBoolean(body?.kycComplete, "kycComplete"),
        firstAdFundedEntryEarned: parseOptionalBoolean(
          body?.firstAdFundedEntryEarned,
          "firstAdFundedEntryEarned"
        ),
        withdrawalAt: parseNullableString(body?.withdrawalAt, "withdrawalAt"),
        withdrawalWithinHours: parseOptionalSignedInteger(
          body?.withdrawalWithinHours,
          "withdrawalWithinHours"
        ),
        depositWithdrawPattern: parseOptionalBoolean(
          body?.depositWithdrawPattern,
          "depositWithdrawPattern"
        ),
        clusterKey: parseOptionalString(body?.clusterKey, "clusterKey"),
        relatedReferralIds: parseOptionalStringArray(
          body?.relatedReferralIds,
          "relatedReferralIds"
        ),
        relatedIdentityHashes: parseOptionalStringArray(
          body?.relatedIdentityHashes,
          "relatedIdentityHashes"
        ),
        idempotencyKey: parseOptionalString(body?.idempotencyKey, "idempotencyKey"),
        eventJson: parseMetadataRecord(body?.eventJson),
        now: parseOptionalString(body?.now, "now")
      },
      true
    );

    return json({
      ok: true,
      milestone: "E12",
      referrals: result
    });
  } catch (error) {
    return referralErrorResponse(error);
  }
}

export function readDotCastResolutionRouterReadiness(env: Env): Response {
  return json({
    ok: true,
    milestone: "E13",
    resolutionRouter: readDotCastResolutionRouterStatus(
      env,
      Boolean(env.DOTCAST_DB ?? env.TRADING_DB)
    )
  });
}

export async function classifyDotCastResolutionRouterRequest(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastResolutionClassifierRequest>(request);
    const now = parseOptionalString(body?.now, "now") ?? new Date().toISOString();
    const route = classifyDotCastResolutionRoute(env, {
      market: parseMarketSnapshot(body?.market),
      unit: parseStakeUnit(body?.unit ?? "points"),
      poolId: parseNullableString(body?.poolId, "poolId"),
      streamId: parseNullableString(body?.streamId, "streamId"),
      estimatedStakeMinorUnits: parseOptionalMinorUnits(body?.estimatedStake, "estimatedStake"),
      sources: parseResolutionSources(body?.sourceBindings),
      now
    });

    await maybePersistResolutionRoute(env, route);

    return json({
      ok: true,
      milestone: "E13",
      resolutionRouter: {
        status: readDotCastResolutionRouterStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB)),
        route,
        canOpenRealMoney: route.status === "locked"
      }
    });
  } catch (error) {
    return resolutionRouterErrorResponse(error);
  }
}

export async function resolveDotCastAiPerceptionRoute(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastAiPerceptionResolutionRequest>(request);
    const result = resolveDotCastAiPerception(env, {
      route: parseResolutionRouteObject(body?.route, "route"),
      poolId: parseNullableString(body?.poolId, "poolId"),
      modelConfidenceBps: parseBps(body?.modelConfidenceBps, "modelConfidenceBps"),
      predictedOutcome: parseResolutionOutcome(body?.predictedOutcome),
      evidenceRefs: parseOptionalStringArray(body?.evidenceRefs, "evidenceRefs") ?? [],
      now: parseOptionalString(body?.now, "now")
    });

    await maybePersistAiResolutionLog(env, result.log);
    if (result.escalatedRoute) {
      await maybePersistResolutionRoute(env, result.escalatedRoute);
    }

    return json({
      ok: true,
      milestone: "E13",
      resolutionRouter: result
    });
  } catch (error) {
    return resolutionRouterErrorResponse(error);
  }
}

export async function planDotCastResolverPanelRoute(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastResolverPanelRequest>(request);
    const panel = selectDotCastResolverPanel(env, {
      poolId: parseRequiredString(body?.poolId, "poolId"),
      route: parseResolutionRouteObject(body?.route, "route"),
      candidates: parseResolverProfiles(body?.candidates),
      positionUserIds: parseOptionalStringArray(body?.positionUserIds, "positionUserIds") ?? [],
      estimatedStakeMinorUnits: parseOptionalMinorUnits(body?.estimatedStake, "estimatedStake"),
      panelId: parseOptionalString(body?.panelId, "panelId"),
      now: parseOptionalString(body?.now, "now")
    });

    await maybePersistResolverPanel(env, panel);

    return json({
      ok: true,
      milestone: "E13",
      resolutionRouter: {
        panel,
        payForCorrectness: true,
        stakeExcluded: true,
        commitRevealRequired: true
      }
    });
  } catch (error) {
    return resolutionRouterErrorResponse(error);
  }
}

export async function commitDotCastResolverRoute(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastResolverCommitRequest>(request);
    const commit = await createDotCastResolverCommit({
      assignment: parseResolverAssignment(body?.assignment, "assignment"),
      outcome: parseOutcome(body?.outcome),
      salt: parseRequiredString(body?.salt, "salt"),
      now: parseOptionalString(body?.now, "now")
    });

    await maybePersistResolverCommit(env, commit);

    return json({
      ok: true,
      milestone: "E13",
      resolutionRouter: {
        commit,
        answerHiddenUntilReveal: true
      }
    });
  } catch (error) {
    return resolutionRouterErrorResponse(error);
  }
}

export async function revealDotCastResolverRoute(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastResolverRevealRequest>(request);
    const reveal = await revealDotCastResolverCommit({
      commit: parseResolverCommit(body?.commit, "commit"),
      outcome: parseOutcome(body?.outcome),
      salt: parseRequiredString(body?.salt, "salt"),
      now: parseOptionalString(body?.now, "now")
    });

    await maybePersistResolverReveal(env, reveal);

    return json({
      ok: true,
      milestone: "E13",
      resolutionRouter: {
        reveal,
        commitVerified: true
      }
    });
  } catch (error) {
    return resolutionRouterErrorResponse(error);
  }
}

export async function settleDotCastResolverPanelRoute(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastResolverSettleRequest>(request);
    const settlement = settleDotCastResolverPanel({
      panel: parseResolverPanel(body?.panel, "panel"),
      reveals: parseResolverReveals(body?.reveals),
      now: parseOptionalString(body?.now, "now")
    });

    await maybePersistResolverPayouts(env, settlement.payouts);

    return json({
      ok: true,
      milestone: "E13",
      resolutionRouter: settlement
    });
  } catch (error) {
    return resolutionRouterErrorResponse(error);
  }
}

export async function createDotCastLivestreamSession(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreateLivestreamRequest>(request);
    const now = parseOptionalString(body?.now, "now") ?? new Date().toISOString();
    const streamId =
      parseOptionalString(body?.streamId, "streamId") ?? `stream:${crypto.randomUUID()}`;
    const hostId = parseRequiredString(body?.hostId, "hostId");
    const title = parseRequiredString(body?.title, "title");
    const metadata = parseMetadataRecord(body?.metadata);
    const config = readMuxLivestreamConfig(env);
    const mux = await createMuxLiveStream(env, {
      streamId,
      passthrough: streamId,
      metadata
    });
    const record = buildMuxLivestreamRecord({
      streamId,
      hostId,
      title,
      mux,
      config,
      now,
      metadata
    });
    const store = livestreamStore(env);

    await store.upsertLivestream(record);
    await store.appendEvent({
      eventId: `dotcast:livestream:${streamId}:created`,
      streamId,
      muxLiveStreamId: record.muxLiveStreamId,
      eventType: "DOTCAST_LIVESTREAM_CREATED",
      status: record.status,
      payload: {
        provider: record.provider,
        controlLayer: record.controlLayer,
        muxLiveStreamId: record.muxLiveStreamId,
        playbackId: record.playbackId,
        playbackPolicy: record.playbackPolicy
      },
      createdAt: now
    });

    if (env.DOTCAST_LIVESTREAM) {
      await proxyDotCastLivestreamRequest(env, streamId, "/create", {
        method: "POST",
        body: JSON.stringify({ hostId, title, status: "paused", now })
      });
    }

    return json(
      {
        ok: true,
        livestream: publicLivestream(record),
        videoPlane: {
          provider: "mux",
          muxLiveStreamId: record.muxLiveStreamId,
          playbackId: record.playbackId,
          playbackPolicy: record.playbackPolicy,
          lowLatency: record.lowLatency,
          recordingEnabled: record.recordingEnabled,
          reconnectWindowSeconds: record.reconnectWindowSeconds
        },
        controlPlane: {
          gateway: "dotcast-worker",
          controlLayer: record.controlLayer,
          realtimeState: "durable-object-per-live-room"
        },
        hostIngest: {
          rtmpUrl: record.ingestRtmpUrl,
          streamKey: mux.streamKey,
          warning: "Treat this stream key like a password. Never expose it to viewers."
        },
        viewerPlayback: await buildMuxPlaybackDescriptor(record, env, new Date(now))
      },
      201
    );
  } catch (error) {
    return livestreamErrorResponse(error);
  }
}

export async function readDotCastLivestream(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  if (env.DOTCAST_DB ?? env.TRADING_DB) {
    try {
      const record = await livestreamStore(env).getLivestream(streamId);

      if (!record) {
        return json({ ok: false, error: "dotCast livestream was not found" }, 404);
      }

      const pools = await livestreamStore(env).listPools(streamId);
      const realtime = env.DOTCAST_LIVESTREAM
        ? await readLivestreamRealtimeSnapshot(streamId, request, env)
        : null;

      return json({
        ok: true,
        livestream: {
          metadata: publicLivestream(record),
          pools,
          realtime
        }
      });
    } catch (error) {
      return livestreamErrorResponse(error);
    }
  }

  const search = new URL(request.url).search;
  return proxyDotCastLivestreamRequest(env, streamId, `/${search}`, { method: "GET" });
}

export async function readDotCastLivestreamPlayback(streamId: string, env: Env): Promise<Response> {
  try {
    const record = await requireLivestreamRecord(streamId, env);

    return json({
      ok: true,
      livestream: publicLivestream(record),
      viewerPlayback: await buildMuxPlaybackDescriptor(record, env)
    });
  } catch (error) {
    return livestreamErrorResponse(error);
  }
}

export async function handleMuxLivestreamWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const event = await parseVerifiedMuxWebhook(request, env);

    if (!event.muxLiveStreamId) {
      return json({ ok: true, ignored: true, reason: "Mux event has no live stream id" }, 202);
    }

    const store = livestreamStore(env);
    const record = await store.getLivestreamByMuxId(event.muxLiveStreamId);

    if (!record) {
      return json({ ok: true, ignored: true, reason: "Mux live stream is unknown" }, 202);
    }

    const updated = await store.updateLivestreamFromWebhook(
      record.streamId,
      event,
      event.createdAt
    );

    if (updated && env.DOTCAST_LIVESTREAM) {
      await syncRealtimeLivestreamFromMuxWebhook(updated, event, env);
    }

    return json({
      ok: true,
      event: {
        id: event.eventId,
        type: event.eventType,
        muxLiveStreamId: event.muxLiveStreamId,
        status: event.metadataStatus
      },
      livestream: updated ? publicLivestream(updated) : null,
      predictionSettlement: "not_triggered"
    });
  } catch (error) {
    return livestreamErrorResponse(error);
  }
}

export async function archiveDotCastLivestream(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await readJsonBody<DotCastArchiveLivestreamRequest>(request)) ?? {};
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const archived = await livestreamStore(env).archiveLivestream(streamId, now);

    if (!archived) {
      return json({ ok: false, error: "dotCast livestream was not found" }, 404);
    }

    if (env.DOTCAST_LIVESTREAM) {
      await proxyDotCastLivestreamRequest(env, streamId, "/end", {
        method: "POST",
        body: JSON.stringify({ now })
      });
    }

    return json({ ok: true, livestream: publicLivestream(archived) });
  } catch (error) {
    return livestreamErrorResponse(error);
  }
}

export async function startDotCastLivestream(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, "/start", {
    method: "POST",
    body: await request.text()
  });
}

export async function pauseDotCastLivestream(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, "/pause", {
    method: "POST",
    body: await request.text()
  });
}

export async function resumeDotCastLivestream(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, "/resume", {
    method: "POST",
    body: await request.text()
  });
}

export async function endDotCastLivestream(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, "/end", {
    method: "POST",
    body: await request.text()
  });
}

export async function attachDotCastLivestreamPool(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const rawBody = await request.text();

  if (env.DOTCAST_DB ?? env.TRADING_DB) {
    try {
      const body: DotCastAttachLivestreamPoolRequest = parseJsonObject(rawBody);
      const record = await livestreamStore(env).getLivestream(streamId);

      if (!record) {
        return json({ ok: false, error: "dotCast livestream was not found" }, 404);
      }

      const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
      await livestreamStore(env).attachPool({
        streamId,
        poolId: parseRequiredString(body.poolId, "poolId"),
        marketId: parseRequiredString(body.marketId, "marketId"),
        question: parseRequiredString(body.question, "question"),
        unit: parseStakeUnit(body.unit),
        status: parsePoolStatus(body.status),
        pinned: parseOptionalBoolean(body.pinned, "pinned") ?? false,
        attachedAt: now,
        updatedAt: now
      });
    } catch (error) {
      return livestreamErrorResponse(error);
    }
  }

  return proxyDotCastLivestreamRequest(env, streamId, "/pools", {
    method: "POST",
    body: rawBody
  });
}

export async function detachDotCastLivestreamPool(
  streamId: string,
  poolId: string,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, `/pools/${encodeURIComponent(poolId)}`, {
    method: "DELETE"
  });
}

export async function setDotCastLivestreamFeaturedPool(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, "/featured", {
    method: "POST",
    body: await request.text()
  });
}

export async function recordDotCastLivestreamPresence(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  return proxyDotCastLivestreamRequest(env, streamId, "/presence", {
    method: "POST",
    body: await request.text()
  });
}

export async function readDotCastLivestreamEvents(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const search = new URL(request.url).search;
  return proxyDotCastLivestreamRequest(env, streamId, `/events${search}`, { method: "GET" });
}

export async function streamDotCastLivestreamRealtime(
  streamId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const search = new URL(request.url).search;
  return proxyDotCastLivestreamRequest(env, streamId, `/stream${search}`, {
    method: "GET",
    headers: {
      accept: request.headers.get("accept") ?? "text/event-stream"
    }
  });
}

export async function refreshDotCastLivestreamPool(
  streamId: string,
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const body = await readJsonBody<{ now?: unknown }>(request);
  return proxyDotCastLivestreamRequest(env, streamId, "/pool-updates", {
    method: "POST",
    body: JSON.stringify({
      poolId,
      now: parseOptionalString(body?.now, "now")
    })
  });
}

export async function createDotCastPool(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreatePoolRequest>(request);
    const payload = parseCreatePoolPayload(body, env);
    const poolId = payload.id;
    await maybePersistResolutionRoute(env, payload.resolutionRoute);
    return await proxyDotCastPoolRequest(env, poolId, "/create", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error instanceof DotCastResolutionRouterError) {
      return resolutionRouterErrorResponse(error);
    }

    if (error instanceof DotCastUsdcPoolFundingError) {
      return settlementRailErrorResponse(error, "E6");
    }

    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function readDotCastPool(poolId: string, env: Env): Promise<Response> {
  return proxyDotCastPoolRequest(env, poolId, "/", { method: "GET" });
}

export async function readDotCastPoolLiveOdds(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const pathname = `/odds${requestUrl.search}`;
  const response = await proxyDotCastPoolRequest(env, poolId, pathname, { method: "GET" });

  if (!response.ok) {
    return response;
  }

  try {
    const body = await response.clone().json<Record<string, unknown>>();
    const marketId = extractLiveOddsMarketId(body);
    const referencePrice = await fetchDotCastReferencePrice(
      env,
      marketId,
      new Date().toISOString()
    );

    return json(
      {
        ...body,
        referencePrice: toReferencePriceEnvelope(referencePrice)
      },
      response.status
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid pool odds response"
      },
      502
    );
  }
}

export async function placeDotCastPoolEntry(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastPlaceEntryRequest>(request);
    const payload = {
      userId: parseRequiredString(body?.userId, "userId"),
      side: parseSide(body?.side),
      amount: parseMinorUnits(body?.amount, "amount"),
      now: parseOptionalString(body?.now, "now"),
      entryId: parseOptionalString(body?.entryId, "entryId") ?? randomId("entry")
    };
    const streamId = parseOptionalString(body?.streamId, "streamId");
    const poolUnit = await readDotCastPoolUnit(poolId, env);
    const response =
      poolUnit === "usdc"
        ? await placeDotCastUsdcPoolEntry(poolId, payload, env)
        : await proxyDotCastPoolRequest(env, poolId, "/entries", {
            method: "POST",
            body: JSON.stringify(payload)
          });

    if (response.ok) {
      await refreshLivestreamPoolIfRequested(env, streamId, poolId, payload.now);
    }

    return response;
  } catch (error) {
    if (error instanceof DotCastUsdcPoolFundingError) {
      return settlementRailErrorResponse(error, "E6");
    }

    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function lockDotCastPool(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<{ now?: unknown; streamId?: unknown }>(request);
    const now = parseOptionalString(body?.now, "now");
    const streamId = parseOptionalString(body?.streamId, "streamId");
    const response = await proxyDotCastPoolRequest(env, poolId, "/lock", {
      method: "POST",
      body: JSON.stringify({
        now
      })
    });

    if (response.ok) {
      await refreshLivestreamPoolIfRequested(env, streamId, poolId, now);
      return await applySettlementHooksIfSettled(response, env, now);
    }

    return response;
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function settleDotCastPool(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastSettlePoolRequest>(request);
    const now = parseOptionalString(body?.now, "now");
    const streamId = parseOptionalString(body?.streamId, "streamId");
    const response = await proxyDotCastPoolRequest(env, poolId, "/settle", {
      method: "POST",
      body: JSON.stringify({
        outcome: parseOutcome(body?.outcome),
        now
      })
    });

    if (response.ok) {
      await refreshLivestreamPoolIfRequested(env, streamId, poolId, now);
      return await applySettlementHooksIfSettled(response, env, now);
    }

    return response;
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function applyDotCastPoolResolution(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastRouterResolutionRequest>(request);
    const now = parseOptionalString(body?.now, "now");
    const streamId = parseOptionalString(body?.streamId, "streamId");
    const response = await proxyDotCastPoolRequest(env, poolId, "/resolution", {
      method: "POST",
      body: JSON.stringify({
        marketId: parseRequiredString(body?.marketId, "resolution.marketId"),
        outcome: parseResolutionOutcome(body?.outcome),
        resolvedAt: parseNullableString(body?.resolvedAt, "resolution.resolvedAt"),
        fetchedAt: parseOptionalString(body?.fetchedAt, "resolution.fetchedAt"),
        stale: parseOptionalBoolean(body?.stale, "resolution.stale") ?? false,
        source: parseOptionalVenue(body?.source, "resolution.source"),
        now,
        maxGraceMs: parseOptionalMinorUnits(body?.maxGraceMs, "maxGraceMs")
      })
    });

    if (response.ok) {
      await refreshLivestreamPoolIfRequested(env, streamId, poolId, now);
      return await applySettlementHooksIfSettled(response, env, now);
    }

    return response;
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function pollDotCastPoolResolution(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastPollResolutionRequest>(request);
    const now = parseOptionalString(body?.now, "now");
    const streamId = parseOptionalString(body?.streamId, "streamId");
    const response = await proxyDotCastPoolRequest(env, poolId, "/poll-resolution", {
      method: "POST",
      body: JSON.stringify({
        now
      })
    });

    if (response.ok) {
      await refreshLivestreamPoolIfRequested(env, streamId, poolId, now);
      return await applySettlementHooksIfSettled(response, env, now);
    }

    return response;
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function voidDotCastPool(
  poolId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastVoidPoolRequest>(request);
    const now = parseOptionalString(body?.now, "now");
    const streamId = parseOptionalString(body?.streamId, "streamId");
    const response = await proxyDotCastPoolRequest(env, poolId, "/void", {
      method: "POST",
      body: JSON.stringify({
        reason: parseVoidReason(body?.reason),
        now
      })
    });

    if (response.ok) {
      await refreshLivestreamPoolIfRequested(env, streamId, poolId, now);
    }

    return response;
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function previewDotCastOdds(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastPreviewRequest>(request);
    const pools = parseSideTotals(body?.pools);
    const side = parseSide(body?.side);
    const amount = parseMinorUnits(body?.amount, "amount");
    const rake = parseRake(body?.rake);
    const odds = impliedProb(pools);

    return json({
      ok: true,
      pools,
      odds,
      preview: {
        side,
        amount,
        payout: previewPayout(pools, side, amount, rake)
      },
      rake
    });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

export async function simulateDotCastSettlement(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastSettlementSimulationRequest>(request);
    const entries = parseEntries(body?.entries);
    const outcome = parseSide(body?.outcome);
    const rake = parseRake(body?.rake);
    const result = settleParimutuel(entries, outcome, rake);
    const payoutTotal = result.payouts.reduce((sum, payout) => sum + payout.payout, 0);

    return json({
      ok: true,
      result,
      conservation: {
        payoutTotal,
        rakeAmount: result.rakeAmount,
        totalStaked: result.totalStaked,
        conserved: payoutTotal + result.rakeAmount === result.totalStaked
      }
    });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request" },
      400
    );
  }
}

function parseEntries(value: unknown): SettlementEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("entries must be a non-empty array");
  }

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`entries[${index}] must be an object`);
    }

    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `entry-${index}`;

    return {
      id,
      side: parseSide(record.side),
      amount: parseMinorUnits(record.amount, `entries[${index}].amount`),
      placedAt: typeof record.placedAt === "string" ? record.placedAt : undefined
    };
  });
}

function parseCreatePoolPayload(body: DotCastCreatePoolRequest | null, env: Env) {
  const now = parseOptionalString(body?.now, "now") ?? new Date().toISOString();
  const market = parseMarketSnapshot(body?.market);
  const unit = parseStakeUnit(body?.unit ?? "points");
  const id = parseOptionalString(body?.id, "id") ?? randomPoolId(market.id, now);
  const creator = parseCreatorAttribution(body);

  if (unit === "usdc" && !readUsdcPoolFundingStatus(env).ready) {
    throw new Error("usdc pools are disabled until the E6 pool funding rail is enabled");
  }

  const resolutionRoute = prepareDotCastPoolResolutionRoute(env, {
    market,
    unit,
    poolId: id,
    streamId: parseNullableString(body?.streamId, "streamId"),
    estimatedStakeMinorUnits: parseOptionalMinorUnits(body?.estimatedStake, "estimatedStake"),
    sources: parseResolutionSources(body?.sourceBindings),
    explicitRoute:
      body?.resolutionRoute === undefined || body.resolutionRoute === null
        ? null
        : parseResolutionRouteObject(body.resolutionRoute, "resolutionRoute"),
    now
  });

  return {
    id,
    market,
    unit,
    entryOpensAt: parseOptionalString(body?.entryOpensAt, "entryOpensAt"),
    entryClosesAt: parseRequiredString(body?.entryClosesAt, "entryClosesAt"),
    rake: parseRake(body?.rake ?? 0.05),
    minLiquidity: parseMinorUnits(body?.minLiquidity ?? 0, "minLiquidity", true),
    resolutionRoute,
    ...(creator
      ? {
          originatingCreatorId: creator.creatorId,
          creatorBrand: creator
        }
      : {}),
    now
  };
}

function parseCreatorAttribution(
  body: DotCastCreatePoolRequest | null
): { creatorId: string; displayName: string; disclosureLabel: "Creator-originated" } | null {
  const creatorId = parseNullableString(
    body?.creator?.creatorId ?? body?.originatingCreatorId,
    "creator.creatorId"
  );

  if (!creatorId) {
    return null;
  }

  return {
    creatorId,
    displayName:
      parseNullableString(
        body?.creator?.displayName ?? body?.creatorDisplayName,
        "creator.displayName"
      ) ?? creatorId,
    disclosureLabel: "Creator-originated"
  };
}

function parseMarketSnapshot(value: DotCastCreatePoolRequest["market"]): DotCastMarketSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("market is required");
  }

  return {
    id: parseRequiredString(value.id, "market.id"),
    venue:
      value.venue === "kalshi" ||
      value.venue === "polymarket" ||
      value.venue === "dotcast" ||
      value.venue === "unknown"
        ? value.venue
        : "unknown",
    question: parseRequiredString(value.question, "market.question"),
    status: value.status === "open" ? "open" : "closed",
    closeTime: parseRequiredString(value.closeTime, "market.closeTime"),
    expectedResolveAt:
      typeof value.expectedResolveAt === "string" || value.expectedResolveAt === null
        ? value.expectedResolveAt
        : null,
    referenceUrl: typeof value.referenceUrl === "string" ? value.referenceUrl : undefined
  };
}

function parseResolutionRouteObject(value: unknown, label: string): DotCastResolutionRoute {
  const record = parseObjectRecord(value, label);
  const status = parseResolutionRouteStatus(record.status, `${label}.status`);

  return {
    routeId: parseRequiredString(record.routeId, `${label}.routeId`),
    marketId: parseRequiredString(record.marketId, `${label}.marketId`),
    poolId: parseNullableString(record.poolId, `${label}.poolId`),
    tier: parseResolutionTier(record.tier, `${label}.tier`),
    status,
    confidenceBps: parseBps(record.confidenceBps, `${label}.confidenceBps`),
    resolutionStatement: parseRequiredString(
      record.resolutionStatement,
      `${label}.resolutionStatement`
    ),
    sources: parseResolutionSources(record.sources) ?? [],
    sourceAvailable: parseRequiredBoolean(record.sourceAvailable, `${label}.sourceAvailable`),
    autoResolvable: parseRequiredBoolean(record.autoResolvable, `${label}.autoResolvable`),
    reviewRequired: parseRequiredBoolean(record.reviewRequired, `${label}.reviewRequired`),
    pointsOnly: parseRequiredBoolean(record.pointsOnly, `${label}.pointsOnly`),
    blockedReason: parseNullableString(record.blockedReason, `${label}.blockedReason`),
    steeringPrompt: parseNullableString(record.steeringPrompt, `${label}.steeringPrompt`),
    feeBps: parseBps(record.feeBps, `${label}.feeBps`),
    bondMinorUnits: parseMinorUnits(record.bondMinorUnits, `${label}.bondMinorUnits`, true),
    panelSize: parseMinorUnits(record.panelSize, `${label}.panelSize`, true),
    lockedAt:
      status === "locked"
        ? parseRequiredString(record.lockedAt, `${label}.lockedAt`)
        : parseNullableString(record.lockedAt, `${label}.lockedAt`),
    classifierVersion: parseRequiredString(record.classifierVersion, `${label}.classifierVersion`),
    createdAt: parseRequiredString(record.createdAt, `${label}.createdAt`),
    eventJson: parseMetadataRecord(record.eventJson)
  };
}

function parseResolutionSources(value: unknown): DotCastResolutionSource[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error("sourceBindings/sources must be an array");
  }

  return value.map((item, index) => {
    const record = parseObjectRecord(item, `sources[${index}]`);
    return {
      kind: parseResolutionSourceKind(record.kind, `sources[${index}].kind`),
      label: parseRequiredString(record.label, `sources[${index}].label`),
      url: parseNullableString(record.url, `sources[${index}].url`),
      required: parseRequiredBoolean(record.required ?? true, `sources[${index}].required`)
    };
  });
}

function parseResolutionTier(value: unknown, label: string): DotCastResolutionRoute["tier"] {
  if (
    value === "hard_oracle" ||
    value === "computed_oracle" ||
    value === "ai_perception" ||
    value === "optimistic_bonded" ||
    value === "human_jury"
  ) {
    return value;
  }

  throw new Error(`${label} is not a valid E13 resolution tier`);
}

function parseResolutionRouteStatus(
  value: unknown,
  label: string
): DotCastResolutionRoute["status"] {
  if (
    value === "locked" ||
    value === "review_required" ||
    value === "points_only" ||
    value === "blocked"
  ) {
    return value;
  }

  throw new Error(`${label} is not a valid E13 route status`);
}

function parseResolutionSourceKind(value: unknown, label: string): DotCastResolutionSource["kind"] {
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

  throw new Error(`${label} is not a valid E13 source kind`);
}

function parseResolverProfiles(value: unknown): DotCastResolverProfile[] {
  if (!Array.isArray(value)) {
    throw new Error("candidates must be an array");
  }

  return value.map((item, index) => {
    const record = parseObjectRecord(item, `candidates[${index}]`);
    return {
      resolverId: parseRequiredString(record.resolverId, `candidates[${index}].resolverId`),
      identityHash: parseRequiredString(record.identityHash, `candidates[${index}].identityHash`),
      reputationBps: parseBps(record.reputationBps, `candidates[${index}].reputationBps`),
      bondAvailableMinorUnits: parseMinorUnits(
        record.bondAvailableMinorUnits,
        `candidates[${index}].bondAvailableMinorUnits`,
        true
      ),
      stakeHeldPoolIds:
        parseOptionalStringArray(
          record.stakeHeldPoolIds,
          `candidates[${index}].stakeHeldPoolIds`
        ) ?? []
    };
  });
}

function parseResolverPanel(value: unknown, label: string): DotCastResolverPanel {
  const record = parseObjectRecord(value, label);
  return {
    panelId: parseRequiredString(record.panelId, `${label}.panelId`),
    poolId: parseRequiredString(record.poolId, `${label}.poolId`),
    routeId: parseRequiredString(record.routeId, `${label}.routeId`),
    tier: parseResolutionTier(record.tier, `${label}.tier`),
    panelSize: parseMinorUnits(record.panelSize, `${label}.panelSize`),
    estimatedStakeMinorUnits: parseMinorUnits(
      record.estimatedStakeMinorUnits,
      `${label}.estimatedStakeMinorUnits`,
      true
    ),
    resolverFeeBps: parseBps(record.resolverFeeBps, `${label}.resolverFeeBps`),
    assignments: parseResolverAssignments(record.assignments, `${label}.assignments`),
    createdAt: parseRequiredString(record.createdAt, `${label}.createdAt`)
  };
}

function parseResolverAssignments(value: unknown, label: string): DotCastResolverAssignment[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) => parseResolverAssignment(item, `${label}[${index}]`));
}

function parseResolverAssignment(value: unknown, label: string): DotCastResolverAssignment {
  const record = parseObjectRecord(value, label);
  return {
    assignmentId: parseRequiredString(record.assignmentId, `${label}.assignmentId`),
    panelId: parseRequiredString(record.panelId, `${label}.panelId`),
    poolId: parseRequiredString(record.poolId, `${label}.poolId`),
    routeId: parseRequiredString(record.routeId, `${label}.routeId`),
    resolverId: parseRequiredString(record.resolverId, `${label}.resolverId`),
    identityHash: parseRequiredString(record.identityHash, `${label}.identityHash`),
    reputationBps: parseBps(record.reputationBps, `${label}.reputationBps`),
    bondMinorUnits: parseMinorUnits(record.bondMinorUnits, `${label}.bondMinorUnits`, true),
    status: parseResolverAssignmentStatus(record.status, `${label}.status`),
    assignedAt: parseRequiredString(record.assignedAt, `${label}.assignedAt`)
  };
}

function parseResolverAssignmentStatus(
  value: unknown,
  label: string
): DotCastResolverAssignment["status"] {
  if (
    value === "assigned" ||
    value === "committed" ||
    value === "revealed" ||
    value === "paid" ||
    value === "slashed"
  ) {
    return value;
  }

  throw new Error(`${label} is not a valid resolver assignment status`);
}

function parseResolverCommit(value: unknown, label: string): DotCastResolverCommit {
  const record = parseObjectRecord(value, label);
  return {
    assignmentId: parseRequiredString(record.assignmentId, `${label}.assignmentId`),
    panelId: parseRequiredString(record.panelId, `${label}.panelId`),
    resolverId: parseRequiredString(record.resolverId, `${label}.resolverId`),
    commitHash: parseRequiredString(record.commitHash, `${label}.commitHash`),
    committedAt: parseRequiredString(record.committedAt, `${label}.committedAt`)
  };
}

function parseResolverReveals(value: unknown): DotCastResolverReveal[] {
  if (!Array.isArray(value)) {
    throw new Error("reveals must be an array");
  }

  return value.map((item, index) => {
    const record = parseObjectRecord(item, `reveals[${index}]`);
    return {
      assignmentId: parseRequiredString(record.assignmentId, `reveals[${index}].assignmentId`),
      panelId: parseRequiredString(record.panelId, `reveals[${index}].panelId`),
      resolverId: parseRequiredString(record.resolverId, `reveals[${index}].resolverId`),
      outcome: parseOutcome(record.outcome),
      salt: parseRequiredString(record.salt, `reveals[${index}].salt`),
      revealedAt: parseRequiredString(record.revealedAt, `reveals[${index}].revealedAt`)
    };
  });
}

function parseSideTotals(value: DotCastPreviewRequest["pools"]): SideTotals {
  return {
    yes: parseMinorUnits(value?.yes ?? 0, "pools.yes", true),
    no: parseMinorUnits(value?.no ?? 0, "pools.no", true)
  };
}

function parseSide(value: unknown): Side {
  if (value === "yes" || value === "no") {
    return value;
  }

  throw new Error("side/outcome must be yes or no");
}

function parseOutcome(value: unknown): Side | "invalid" {
  if (value === "yes" || value === "no" || value === "invalid") {
    return value;
  }

  throw new Error("outcome must be yes, no, or invalid");
}

function parseResolutionOutcome(value: unknown): DotCastResolutionOutcome {
  if (value === "yes" || value === "no" || value === "invalid" || value === "pending") {
    return value;
  }

  throw new Error("resolution outcome must be yes, no, invalid, or pending");
}

function parseVoidReason(value: unknown): string {
  if (
    value === "UNDER_LIQUIDITY" ||
    value === "ONE_SIDED_POOL" ||
    value === "NO_WINNING_ENTRIES" ||
    value === "INVALID_RESOLUTION" ||
    value === "GRACE_TIMEOUT" ||
    value === "SOURCE_CANCELLED" ||
    value === "ADMIN_VOID"
  ) {
    return value;
  }

  throw new Error("void reason is required");
}

function parseOptionalVenue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "kalshi" || value === "polymarket" || value === "dotcast" || value === "unknown") {
    return value;
  }

  throw new Error(`${label} must be a supported venue`);
}

function parseStakeUnit(value: unknown): StakeUnit {
  if (value === "points" || value === "usdc") {
    return value;
  }

  throw new Error("unit must be points or usdc");
}

function parseOptionalCreatorTier(value: unknown): DotCastCreatorTier | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "casual" || value === "verified" || value === "partner") {
    return value;
  }

  throw new Error("creator tier must be casual, verified, or partner");
}

function parseOptionalCreatorStatus(value: unknown): DotCastCreatorStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "active" || value === "suspended" || value === "archived") {
    return value;
  }

  throw new Error("creator status must be active, suspended, or archived");
}

function parseOptionalCreatorKycStatus(value: unknown): DotCastCreatorKycStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "unverified" || value === "verified" || value === "rejected") {
    return value;
  }

  throw new Error("creator KYC status must be unverified, verified, or rejected");
}

function parseCreatorSeedMode(value: unknown): DotCastCreatorSeedMode {
  if (value === "boost_winners" || value === "void_insurance" || value === "bonus_pool") {
    return value;
  }

  throw new Error("creator seed mode must be boost_winners, void_insurance, or bonus_pool");
}

function parseResolutionBinding(value: unknown): DotCastResolutionBinding {
  if (
    value === "oracle_bound" ||
    value === "optimistic" ||
    value === "jury" ||
    value === "unknown"
  ) {
    return value;
  }

  throw new Error("resolutionBinding must be oracle_bound, optimistic, jury, or unknown");
}

function parseOptionalReferralQualificationEvent(
  value: unknown
): DotCastReferralQualificationEvent | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "signup" || value === "first_deposit" || value === "kyc_plus_first_entry") {
    return value;
  }

  throw new Error("eventType must be signup, first_deposit, or kyc_plus_first_entry");
}

function parseCreatorNudgeRecipients(value: unknown): CreatorNudgeRecipient[] {
  if (!Array.isArray(value)) {
    throw new Error("recipients must be an array");
  }

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`recipients[${index}] must be an object`);
    }

    const record = candidate as Record<string, unknown>;

    return {
      userId: parseRequiredString(record.userId, `recipients[${index}].userId`),
      selfLimited: parseOptionalBoolean(record.selfLimited, `recipients[${index}].selfLimited`),
      lossLimited: parseOptionalBoolean(record.lossLimited, `recipients[${index}].lossLimited`),
      cooldownUntil: parseNullableString(
        record.cooldownUntil,
        `recipients[${index}].cooldownUntil`
      ),
      blockedByResponsiblePlay: parseOptionalBoolean(
        record.blockedByResponsiblePlay,
        `recipients[${index}].blockedByResponsiblePlay`
      )
    };
  });
}

function parseSponsoredQuestionMarket(value: unknown): DotCastMarketSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("market is required");
  }

  const record = value as Record<string, unknown>;
  const venue = record.venue;

  if (venue !== "kalshi" && venue !== "polymarket") {
    throw new Error("sponsored question market venue must be kalshi or polymarket");
  }

  return {
    id: parseRequiredString(record.id, "market.id"),
    venue,
    question: parseRequiredString(record.question, "market.question"),
    status: parseDotCastMarketStatus(record.status),
    closeTime: parseRequiredString(record.closeTime ?? record.close_time, "market.closeTime"),
    expectedResolveAt: parseNullableString(
      record.expectedResolveAt ?? record.expected_resolve_at,
      "market.expectedResolveAt"
    ),
    referenceUrl:
      parseNullableString(record.referenceUrl ?? record.reference_url, "market.referenceUrl") ??
      undefined
  };
}

function parseDotCastMarketStatus(value: unknown): DotCastMarketSnapshot["status"] {
  if (
    value === "open" ||
    value === "closed" ||
    value === "settled" ||
    value === "cancelled" ||
    value === "voided"
  ) {
    return value;
  }

  throw new Error("market.status must be open, closed, settled, cancelled, or voided");
}

function parseSponsoredQuestionPricingModel(value: unknown): DotCastSponsoredQuestionPricingModel {
  if (
    value === "flat_fee" ||
    value === "cpm" ||
    value === "completed_prediction" ||
    value === "auction"
  ) {
    return value;
  }

  throw new Error("pricingModel must be flat_fee, cpm, completed_prediction, or auction");
}

function parseSponsoredQuestionBillingEventType(
  value: unknown
): DotCastSponsoredQuestionBillingEventType {
  if (
    value === "flat_fee_reserved" ||
    value === "impression" ||
    value === "completed_prediction" ||
    value === "auction_charge" ||
    value === "adjustment"
  ) {
    return value;
  }

  throw new Error(
    "eventType must be flat_fee_reserved, impression, completed_prediction, auction_charge, or adjustment"
  );
}

function parseSponsoredQuestionRelationship(
  value: unknown
): "none" | "participant" | "issuer" | "candidate" | "organizer" | "other" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (
    value === "none" ||
    value === "participant" ||
    value === "issuer" ||
    value === "candidate" ||
    value === "organizer" ||
    value === "other"
  ) {
    return value;
  }

  throw new Error("relationshipToOutcome is invalid");
}

function parseOptionalSponsorshipStatus(
  value: unknown
): DotCastSponsoredQuestionStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (
    value === "pending_review" ||
    value === "active" ||
    value === "paused" ||
    value === "archived" ||
    value === "rejected"
  ) {
    return value;
  }

  throw new Error("sponsored question status is invalid");
}

function parseSponsoredQuestionAttestation(
  value: unknown
): SponsoredQuestionIntegrityAttestation | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attestation must be an object");
  }

  const record = value as Record<string, unknown>;

  return {
    noOutcomeInfluence: parseOptionalBoolean(
      record.noOutcomeInfluence,
      "attestation.noOutcomeInfluence"
    ),
    cosmeticOnly: parseOptionalBoolean(record.cosmeticOnly, "attestation.cosmeticOnly"),
    noUserDataAccess: parseOptionalBoolean(record.noUserDataAccess, "attestation.noUserDataAccess")
  };
}

function parseOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  return value.map((item, index) => parseRequiredString(item, `${label}[${index}]`));
}

function parseRequiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`${label} is required`);
}

function parseOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`${label} must be a non-empty string`);
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseOptionalString(value, label) ?? null;
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${label} must be a boolean`);
}

function parseRequiredBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${label} must be a boolean`);
}

function parseBps(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label} must be an integer between 0 and 10000`);
  }

  return value;
}

function parseOptionalMinorUnits(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parseMinorUnits(value, label, true);
}

function parseOptionalSignedInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }

  return value;
}

function parseOptionalQueryInteger(value: string | null, label: string): number | undefined {
  if (value === null || value.length === 0) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }

  return parsed;
}

function parseMinorUnits(value: unknown, label: string, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer minor-unit amount`
    );
  }

  return value;
}

function parseRake(value: unknown): number {
  const rake = value ?? 0;

  if (typeof rake !== "number" || !Number.isFinite(rake) || rake < 0 || rake > 1) {
    throw new Error("rake must be a number between 0 and 1");
  }

  return rake;
}

function parsePoolStatus(value: unknown): "open" | "locked" | "resolving" | "settled" | "voided" {
  if (value === "locked" || value === "resolving" || value === "settled" || value === "voided") {
    return value;
  }

  return "open";
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("request body must be JSON");
  }
}

function parseObjectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function parseMetadataRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("metadata must be an object");
}

function publicLivestream(record: DotCastLivestreamMetadata): Record<string, unknown> {
  return {
    streamId: record.streamId,
    provider: record.provider,
    controlLayer: record.controlLayer,
    muxLiveStreamId: record.muxLiveStreamId,
    playbackId: record.playbackId,
    playbackPolicy: record.playbackPolicy,
    hostId: record.hostId,
    title: record.title,
    status: record.status,
    muxStatus: record.muxStatus,
    recordingAssetId: record.recordingAssetId,
    recordingPlaybackId: record.recordingPlaybackId,
    lowLatency: record.lowLatency,
    recordingEnabled: record.recordingEnabled,
    reconnectWindowSeconds: record.reconnectWindowSeconds,
    ingest: {
      rtmpUrl: record.ingestRtmpUrl,
      streamKeyExposed: false
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    archivedAt: record.archivedAt,
    metadata: record.metadata
  };
}

async function readLivestreamRealtimeSnapshot(
  streamId: string,
  request: Request,
  env: Env
): Promise<unknown> {
  const search = new URL(request.url).search;
  const response = await proxyDotCastLivestreamRequest(env, streamId, `/${search}`, {
    method: "GET"
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function syncRealtimeLivestreamFromMuxWebhook(
  record: DotCastLivestreamMetadata,
  event: { eventType: string; createdAt: string },
  env: Env
): Promise<void> {
  if (event.eventType === "video.live_stream.active") {
    await proxyDotCastLivestreamRequest(env, record.streamId, "/start", {
      method: "POST",
      body: JSON.stringify({
        hostId: record.hostId,
        title: record.title,
        now: event.createdAt
      })
    });
    return;
  }

  if (
    event.eventType === "video.live_stream.idle" ||
    event.eventType === "video.live_stream.errored"
  ) {
    await proxyDotCastLivestreamRequest(env, record.streamId, "/pause", {
      method: "POST",
      body: JSON.stringify({ now: event.createdAt })
    });
  }
}

async function proxyDotCastPoolRequest(
  env: Env,
  poolId: string,
  pathname: string,
  init: RequestInit
): Promise<Response> {
  if (!env.DOTCAST_POOL) {
    return json({ ok: false, error: "dotCast pool storage is not configured" }, 503);
  }

  const objectId = env.DOTCAST_POOL.idFromName(poolId);
  const object = env.DOTCAST_POOL.get(objectId);
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json;charset=UTF-8");
  const response = await object.fetch(
    new Request(`https://dotcast.pool${pathname}`, {
      ...init,
      headers
    })
  );

  return withCors(response);
}

async function proxyDotCastLivestreamRequest(
  env: Env,
  streamId: string,
  pathname: string,
  init: RequestInit
): Promise<Response> {
  if (!env.DOTCAST_LIVESTREAM) {
    return json({ ok: false, error: "dotCast livestream storage is not configured" }, 503);
  }

  const objectId = env.DOTCAST_LIVESTREAM.idFromName(streamId);
  const object = env.DOTCAST_LIVESTREAM.get(objectId);
  const separator = pathname.includes("?") ? "&" : "?";
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json;charset=UTF-8");
  const response = await object.fetch(
    new Request(
      `https://dotcast.livestream${pathname}${separator}streamId=${encodeURIComponent(streamId)}`,
      {
        ...init,
        headers
      }
    )
  );

  return withCors(response);
}

async function refreshLivestreamPoolIfRequested(
  env: Env,
  streamId: string | undefined,
  poolId: string,
  now?: string
): Promise<void> {
  if (!streamId) {
    return;
  }

  try {
    const response = await proxyDotCastLivestreamRequest(env, streamId, "/pool-updates", {
      method: "POST",
      body: JSON.stringify({ poolId, now })
    });

    if (!response.ok) {
      console.error("[dotCast] livestream pool refresh failed", {
        streamId,
        poolId,
        status: response.status
      });
    }
  } catch (error) {
    console.error("[dotCast] livestream pool refresh failed", {
      streamId,
      poolId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function placeDotCastUsdcPoolEntry(
  poolId: string,
  payload: ParsedDotCastPlaceEntry,
  env: Env
): Promise<Response> {
  const store = usdcPoolFundingStore(env);
  const now = payload.now ?? new Date().toISOString();
  const reservation = await reserveUsdcPoolEntry(store, env, {
    poolId,
    entryId: payload.entryId,
    userId: payload.userId,
    amount: payload.amount,
    now
  });
  const response = await proxyDotCastPoolRequest(env, poolId, "/entries", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      now,
      settlementFunding: {
        rail: "solana-usdc-devnet",
        lockId: reservation.lock.lockId,
        reservedAmount: payload.amount
      }
    })
  });

  if (!response.ok) {
    await releaseUsdcPoolEntryReservation(store, env, {
      poolId,
      entryId: payload.entryId,
      userId: payload.userId,
      reason: `pool_entry_rejected:${response.status}`,
      now
    });
    return response;
  }

  const body = await response.json<Record<string, unknown>>();
  return json(
    {
      ...body,
      settlementFunding: {
        milestone: "E6",
        status: reservation.status,
        idempotent: reservation.idempotent,
        lock: reservation.lock,
        balance: reservation.balance
      }
    },
    response.status
  );
}

async function readDotCastPoolUnit(poolId: string, env: Env): Promise<StakeUnit> {
  const response = await proxyDotCastPoolRequest(env, poolId, "/", { method: "GET" });

  if (!response.ok) {
    throw new Error(`pool read failed before entry placement: ${response.status}`);
  }

  const body = await response.json<{ snapshot?: Partial<DotCastPoolSnapshot> }>();
  const unit = body.snapshot?.pool?.unit;

  if (unit !== "points" && unit !== "usdc") {
    throw new Error("pool snapshot is missing stake unit");
  }

  return unit;
}

async function readDotCastPoolSnapshot(poolId: string, env: Env): Promise<DotCastPoolSnapshot> {
  const response = await proxyDotCastPoolRequest(env, poolId, "/", { method: "GET" });

  if (!response.ok) {
    throw new DotCastGamificationError(
      "POOL_READ_FAILED",
      `pool read failed before E8 gamification apply: ${response.status}`,
      502
    );
  }

  const body = await response.json<Record<string, unknown>>();
  const snapshot = extractPoolSnapshot(body);

  if (!snapshot) {
    throw new DotCastGamificationError(
      "POOL_SNAPSHOT_MISSING",
      "pool response is missing a dotCast snapshot",
      502
    );
  }

  return snapshot;
}

async function applySettlementHooksIfSettled(
  response: Response,
  env: Env,
  now?: string
): Promise<Response> {
  if (!(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return response;
  }

  let body: Record<string, unknown>;
  try {
    body = await response.clone().json<Record<string, unknown>>();
  } catch {
    return response;
  }

  const snapshot = extractPoolSnapshot(body);
  if (snapshot?.pool.status !== "settled") {
    return response;
  }

  const enriched: Record<string, unknown> = { ...body };

  try {
    if (snapshot.pool.unit === "points") {
      const result = await applyDotCastGamificationSettlement(
        gamificationStore(env),
        env,
        snapshot,
        {
          now: now ?? snapshot.updatedAt,
          hasDatabase: true
        }
      );
      enriched.gamification = summarizeGamificationResult(result);
    }
  } catch (error) {
    console.error("[dotCast] E8 gamification settlement apply failed", {
      poolId: snapshot.pool.id,
      error: error instanceof Error ? error.message : String(error)
    });
    enriched.gamification = {
      milestone: "E8",
      applied: false,
      idempotent: false,
      error: error instanceof Error ? error.message : "E8 gamification apply failed"
    };
  }

  if (snapshot.pool.originatingCreatorId) {
    try {
      const result = await applyDotCastCreatorRakeShareSettlement(
        creatorStore(env),
        env,
        {
          snapshot,
          now: now ?? snapshot.updatedAt
        },
        true
      );
      enriched.creatorEconomy = summarizeCreatorAccrualResult(result);
    } catch (error) {
      console.error("[dotCast] E11 creator rake-share apply failed", {
        poolId: snapshot.pool.id,
        creatorId: snapshot.pool.originatingCreatorId,
        error: error instanceof Error ? error.message : String(error)
      });
      enriched.creatorEconomy = {
        milestone: "E11",
        applied: false,
        idempotent: false,
        error: error instanceof Error ? error.message : "E11 creator rake-share apply failed"
      };
    }
  }

  return json(enriched, response.status);
}

function extractPoolSnapshot(body: Record<string, unknown>): DotCastPoolSnapshot | null {
  const snapshot = body.snapshot as Partial<DotCastPoolSnapshot> | undefined;

  if (
    snapshot?.pool &&
    typeof snapshot.pool.id === "string" &&
    (snapshot.pool.unit === "points" || snapshot.pool.unit === "usdc") &&
    Array.isArray(snapshot.entries)
  ) {
    return snapshot as DotCastPoolSnapshot;
  }

  return null;
}

function summarizeGamificationResult(
  result: Awaited<ReturnType<typeof applyDotCastGamificationSettlement>>
) {
  return {
    milestone: "E8",
    applied: result.applied,
    idempotent: result.idempotent,
    settlement: result.settlement,
    affectedUsers: result.profiles.map((profile) => ({
      userId: profile.userId,
      pointsBalance: profile.pointsBalance,
      currentStreak: profile.currentStreak,
      longestStreak: profile.longestStreak,
      availableFreeEntries: Math.max(0, profile.freeEntriesGranted - profile.freeEntriesConsumed)
    })),
    ledgerEntries: result.ledger.length,
    pointsAwarded: result.settlement.pointsAwarded,
    freeEntriesGranted: result.freeEntries.length,
    status: result.status
  };
}

function summarizeCreatorAccrualResult(
  result: Awaited<ReturnType<typeof applyDotCastCreatorRakeShareSettlement>>
) {
  return {
    milestone: "E11",
    applied: result.applied,
    idempotent: result.idempotent,
    creatorId: result.creator?.creatorId ?? null,
    accrual: result.accrual,
    balance: result.balance,
    conservation: result.accrual
      ? result.accrual.creatorShare + result.accrual.houseShare === result.accrual.totalRake
      : null,
    status: result.status
  };
}

function settlementRailStore(env: Env): D1DotCastSettlementRailStore {
  if (!env.TRADING_DB) {
    throw new DotCastSettlementRailError(
      "SETTLEMENT_DB_NOT_CONFIGURED",
      "E5 settlement rail database is not configured",
      503
    );
  }

  return new D1DotCastSettlementRailStore(env.TRADING_DB);
}

function gamificationStore(env: Env): D1DotCastGamificationStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastGamificationError(
      "GAMIFICATION_DB_NOT_CONFIGURED",
      "E8 gamification database is not configured",
      503
    );
  }

  return new D1DotCastGamificationStore(db);
}

function rewardedStreamStore(env: Env): D1DotCastRewardedStreamStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_DB_NOT_CONFIGURED",
      "E9 rewarded stream database is not configured",
      503
    );
  }

  return new D1DotCastRewardedStreamStore(db);
}

function sponsoredQuestionStore(env: Env): D1DotCastSponsoredQuestionStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_DB_NOT_CONFIGURED",
      "E10 sponsored question database is not configured",
      503
    );
  }

  return new D1DotCastSponsoredQuestionStore(db);
}

function creatorStore(env: Env): D1DotCastCreatorStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastCreatorEconomyError(
      "CREATOR_ECONOMY_DB_NOT_CONFIGURED",
      "E11 creator economy database is not configured",
      503
    );
  }

  return new D1DotCastCreatorStore(db);
}

function referralStore(env: Env): D1DotCastReferralStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastReferralError(
      "REFERRAL_DB_NOT_CONFIGURED",
      "E12 referral database is not configured",
      503
    );
  }

  return new D1DotCastReferralStore(db);
}

function resolutionRouterStore(env: Env): D1DotCastResolutionRouterStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastResolutionRouterError(
      "RESOLUTION_ROUTER_DB_NOT_CONFIGURED",
      "E13 resolution router database is not configured",
      503
    );
  }

  return new D1DotCastResolutionRouterStore(db);
}

async function maybePersistResolutionRoute(
  env: Env,
  route: DotCastResolutionRoute | null | undefined
): Promise<void> {
  if (!route || !(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return;
  }

  await resolutionRouterStore(env).insertRoute(route);
}

async function maybePersistAiResolutionLog(
  env: Env,
  log: Parameters<D1DotCastResolutionRouterStore["appendAiResolutionLog"]>[0]
): Promise<void> {
  if (!(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return;
  }

  await resolutionRouterStore(env).appendAiResolutionLog(log);
}

async function maybePersistResolverPanel(env: Env, panel: DotCastResolverPanel): Promise<void> {
  if (!(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return;
  }

  await resolutionRouterStore(env).insertResolverPanel(panel);
}

async function maybePersistResolverCommit(env: Env, commit: DotCastResolverCommit): Promise<void> {
  if (!(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return;
  }

  await resolutionRouterStore(env).insertResolverCommit(commit);
}

async function maybePersistResolverReveal(env: Env, reveal: DotCastResolverReveal): Promise<void> {
  if (!(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return;
  }

  await resolutionRouterStore(env).insertResolverReveal(reveal);
}

async function maybePersistResolverPayouts(
  env: Env,
  payouts: Parameters<D1DotCastResolutionRouterStore["insertResolverPayouts"]>[0]
): Promise<void> {
  if (!(env.DOTCAST_DB ?? env.TRADING_DB)) {
    return;
  }

  await resolutionRouterStore(env).insertResolverPayouts(payouts);
}

function livestreamStore(env: Env): D1DotCastLivestreamStore {
  const db = env.DOTCAST_DB ?? env.TRADING_DB;

  if (!db) {
    throw new DotCastLivestreamError(
      "LIVESTREAM_DB_NOT_CONFIGURED",
      "dotCast livestream metadata database is not configured",
      503
    );
  }

  return new D1DotCastLivestreamStore(db);
}

async function requireLivestreamRecord(
  streamId: string,
  env: Env
): Promise<DotCastLivestreamMetadata> {
  const record = await livestreamStore(env).getLivestream(streamId);

  if (!record) {
    throw new DotCastLivestreamError(
      "LIVESTREAM_NOT_FOUND",
      "dotCast livestream was not found",
      404
    );
  }

  return record;
}

function usdcPoolFundingStore(env: Env): D1DotCastUsdcPoolFundingStore {
  if (!env.TRADING_DB) {
    throw new DotCastUsdcPoolFundingError(
      "SETTLEMENT_DB_NOT_CONFIGURED",
      "E6 USDC pool funding database is not configured",
      503
    );
  }

  return new D1DotCastUsdcPoolFundingStore(env.TRADING_DB);
}

function livestreamErrorResponse(error: unknown): Response {
  if (error instanceof DotCastLivestreamError) {
    return json(
      {
        ok: false,
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function gamificationErrorResponse(error: unknown): Response {
  if (error instanceof DotCastGamificationError) {
    return json(
      {
        ok: false,
        milestone: "E8",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E8",
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function rewardedStreamErrorResponse(error: unknown): Response {
  if (error instanceof DotCastRewardedStreamError) {
    return json(
      {
        ok: false,
        milestone: "E9",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E9",
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function sponsoredQuestionErrorResponse(error: unknown): Response {
  if (error instanceof DotCastSponsoredQuestionError) {
    return json(
      {
        ok: false,
        milestone: "E10",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E10",
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function creatorEconomyErrorResponse(error: unknown): Response {
  if (error instanceof DotCastCreatorEconomyError) {
    return json(
      {
        ok: false,
        milestone: "E11",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  if (error instanceof DotCastSettlementRailError) {
    return json(
      {
        ok: false,
        milestone: "E11",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E11",
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function referralErrorResponse(error: unknown): Response {
  if (error instanceof DotCastReferralError) {
    return json(
      {
        ok: false,
        milestone: "E12",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E12",
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function resolutionRouterErrorResponse(error: unknown): Response {
  if (error instanceof DotCastResolutionRouterError) {
    return json(
      {
        ok: false,
        milestone: "E13",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E13",
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function settlementRailErrorResponse(error: unknown, milestone = "E5"): Response {
  if (error instanceof DotCastSettlementRailError) {
    return json(
      {
        ok: false,
        milestone,
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  if (error instanceof DotCastUsdcPoolFundingError) {
    return json(
      {
        ok: false,
        milestone: "E6",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone,
      error: error instanceof Error ? error.message : "Invalid request"
    },
    400
  );
}

function extractLiveOddsMarketId(body: Record<string, unknown>): string {
  const liveOdds = body.liveOdds as Partial<DotCastLiveOddsSnapshot> | undefined;

  if (liveOdds && typeof liveOdds.marketId === "string" && liveOdds.marketId.length > 0) {
    return liveOdds.marketId;
  }

  const snapshot = body.snapshot as { pool?: { marketId?: unknown } } | undefined;
  const marketId = snapshot?.pool?.marketId;

  if (typeof marketId === "string" && marketId.length > 0) {
    return marketId;
  }

  throw new Error("pool odds response is missing marketId");
}

function toReferencePriceEnvelope(result: DotCastReferencePriceFetchResult) {
  if (result.kind === "reference") {
    return {
      available: true,
      kind: result.kind,
      ...result.referencePrice
    };
  }

  return {
    available: false,
    kind: result.kind,
    error: result.error,
    ...(result.kind === "unavailable" && result.status ? { status: result.status } : {})
  };
}

function randomPoolId(marketId: string, now: string): string {
  return `dotcast:${marketId}:${Date.parse(now)}:${randomId("pool")}`;
}

function randomId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

import {
  confirmMockWithdrawal,
  creditDevnetDeposit,
  D1DotCastSettlementRailStore,
  DotCastSettlementRailError,
  fetchDotCastReferencePrice,
  impliedProb,
  previewPayout,
  readSettlementBalance,
  readSolanaUsdcSettlementRailStatus,
  reconcileDevnetSettlementRail,
  requestDevnetWithdrawal,
  settleParimutuel,
  type DotCastLiveOddsSnapshot,
  type DotCastMarketSnapshot,
  type DotCastReferencePriceFetchResult,
  type DotCastResolutionOutcome,
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
  now?: unknown;
}

interface DotCastPlaceEntryRequest {
  userId?: unknown;
  side?: unknown;
  amount?: unknown;
  now?: unknown;
  entryId?: unknown;
}

interface DotCastSettlePoolRequest {
  outcome?: unknown;
  now?: unknown;
}

interface DotCastVoidPoolRequest {
  reason?: unknown;
  now?: unknown;
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
}

interface DotCastPollResolutionRequest {
  now?: unknown;
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

export function readDotCastHealth(env?: Env): Response {
  const settlementRail = env ? readSolanaUsdcSettlementRailStatus(env) : null;

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
      e6: "points-layer-not-started",
      e7: "audit-ledger-core-ready",
      e8: "gamification-not-started",
      e9: "rewarded-ad-onramp-not-started",
      e10: "sponsored-questions-not-started",
      e11: "creator-economy-not-started",
      e12: "referrals-not-started",
      e13: "resolution-router-not-started",
      persistence: "durable-object-ready",
      settlementRail: settlementRail?.ready ? "devnet-mock-ready" : "devnet-mock-code-ready"
    },
    ...(settlementRail ? { settlementRail } : {}),
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

export async function createDotCastPool(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastCreatePoolRequest>(request);
    const payload = parseCreatePoolPayload(body);
    const poolId = payload.id;
    return proxyDotCastPoolRequest(env, poolId, "/create", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  } catch (error) {
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
    const body = (await response.clone().json()) as Record<string, unknown>;
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

    return proxyDotCastPoolRequest(env, poolId, "/entries", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  } catch (error) {
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
    const body = await readJsonBody<{ now?: unknown }>(request);
    return proxyDotCastPoolRequest(env, poolId, "/lock", {
      method: "POST",
      body: JSON.stringify({
        now: parseOptionalString(body?.now, "now")
      })
    });
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
    return proxyDotCastPoolRequest(env, poolId, "/settle", {
      method: "POST",
      body: JSON.stringify({
        outcome: parseOutcome(body?.outcome),
        now: parseOptionalString(body?.now, "now")
      })
    });
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
    return proxyDotCastPoolRequest(env, poolId, "/resolution", {
      method: "POST",
      body: JSON.stringify({
        marketId: parseRequiredString(body?.marketId, "resolution.marketId"),
        outcome: parseResolutionOutcome(body?.outcome),
        resolvedAt: parseNullableString(body?.resolvedAt, "resolution.resolvedAt"),
        fetchedAt: parseOptionalString(body?.fetchedAt, "resolution.fetchedAt"),
        stale: parseOptionalBoolean(body?.stale, "resolution.stale") ?? false,
        source: parseOptionalVenue(body?.source, "resolution.source"),
        now: parseOptionalString(body?.now, "now"),
        maxGraceMs: parseOptionalMinorUnits(body?.maxGraceMs, "maxGraceMs")
      })
    });
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
    return proxyDotCastPoolRequest(env, poolId, "/poll-resolution", {
      method: "POST",
      body: JSON.stringify({
        now: parseOptionalString(body?.now, "now")
      })
    });
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
    return proxyDotCastPoolRequest(env, poolId, "/void", {
      method: "POST",
      body: JSON.stringify({
        reason: parseVoidReason(body?.reason),
        now: parseOptionalString(body?.now, "now")
      })
    });
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

function parseCreatePoolPayload(body: DotCastCreatePoolRequest | null) {
  const now = parseOptionalString(body?.now, "now") ?? new Date().toISOString();
  const market = parseMarketSnapshot(body?.market);
  const unit = parseStakeUnit(body?.unit ?? "points");
  const id = parseOptionalString(body?.id, "id") ?? randomPoolId(market.id, now);

  if (unit !== "points") {
    throw new Error("usdc pools are disabled until the settlement rail is enabled");
  }

  return {
    id,
    market,
    unit,
    entryOpensAt: parseOptionalString(body?.entryOpensAt, "entryOpensAt"),
    entryClosesAt: parseRequiredString(body?.entryClosesAt, "entryClosesAt"),
    rake: parseRake(body?.rake ?? 0.05),
    minLiquidity: parseMinorUnits(body?.minLiquidity ?? 0, "minLiquidity", true),
    now
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

function parseOptionalMinorUnits(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parseMinorUnits(value, label, true);
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
  const response = await object.fetch(
    new Request(`https://dotcast.pool${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json;charset=UTF-8",
        ...(init.headers ?? {})
      }
    })
  );

  return withCors(response);
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

function settlementRailErrorResponse(error: unknown): Response {
  if (error instanceof DotCastSettlementRailError) {
    return json(
      {
        ok: false,
        milestone: "E5",
        code: error.code,
        error: error.message
      },
      error.status
    );
  }

  return json(
    {
      ok: false,
      milestone: "E5",
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

import {
  confirmMockWithdrawal,
  applyDotCastGamificationSettlement,
  creditDevnetDeposit,
  D1DotCastSettlementRailStore,
  D1DotCastGamificationStore,
  D1DotCastUsdcPoolFundingStore,
  D1DotCastLivestreamStore,
  DotCastGamificationError,
  DotCastSettlementRailError,
  DotCastLivestreamError,
  DotCastUsdcPoolFundingError,
  buildMuxLivestreamRecord,
  buildMuxPlaybackDescriptor,
  createMuxLiveStream,
  fetchDotCastReferencePrice,
  impliedProb,
  parseVerifiedMuxWebhook,
  previewPayout,
  readSettlementBalance,
  readDotCastGamificationStatus,
  readDotCastGamificationUserSummary,
  readMuxLivestreamConfig,
  readSolanaUsdcSettlementRailStatus,
  readUsdcPoolFundingStatus,
  reconcileDevnetSettlementRail,
  releaseUsdcPoolEntryReservation,
  reserveUsdcPoolEntry,
  requestDevnetWithdrawal,
  settleParimutuel,
  type DotCastLiveOddsSnapshot,
  type DotCastLivestreamMetadata,
  type DotCastMarketSnapshot,
  type DotCastPoolSnapshot,
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

export function readDotCastHealth(env?: Env): Response {
  const settlementRail = env ? readSolanaUsdcSettlementRailStatus(env) : null;
  const usdcPoolFunding = env ? readUsdcPoolFundingStatus(env) : null;
  const livestream = env ? readMuxLivestreamConfig(env) : null;
  const gamification = env
    ? readDotCastGamificationStatus(env, Boolean(env.DOTCAST_DB ?? env.TRADING_DB))
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
      e9: "rewarded-ad-onramp-not-started",
      e10: "sponsored-questions-not-started",
      e11: "creator-economy-not-started",
      e12: "referrals-not-started",
      e13: "resolution-router-not-started",
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
    return await proxyDotCastPoolRequest(env, poolId, "/create", {
      method: "POST",
      body: JSON.stringify(payload)
    });
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
      return await applyGamificationIfSettled(response, env, now);
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
      return await applyGamificationIfSettled(response, env, now);
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
      return await applyGamificationIfSettled(response, env, now);
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
      return await applyGamificationIfSettled(response, env, now);
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

  if (unit === "usdc" && !readUsdcPoolFundingStatus(env).ready) {
    throw new Error("usdc pools are disabled until the E6 pool funding rail is enabled");
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

async function applyGamificationIfSettled(
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
  if (snapshot?.pool.unit !== "points" || snapshot.pool.status !== "settled") {
    return response;
  }

  try {
    const result = await applyDotCastGamificationSettlement(gamificationStore(env), env, snapshot, {
      now: now ?? snapshot.updatedAt,
      hasDatabase: true
    });

    return json(
      {
        ...body,
        gamification: summarizeGamificationResult(result)
      },
      response.status
    );
  } catch (error) {
    console.error("[dotCast] E8 gamification settlement apply failed", {
      poolId: snapshot.pool.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return json(
      {
        ...body,
        gamification: {
          milestone: "E8",
          applied: false,
          idempotent: false,
          error: error instanceof Error ? error.message : "E8 gamification apply failed"
        }
      },
      response.status
    );
  }
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

import type {
  DotCastLiveOddsSnapshot,
  DotCastLivestreamEvent,
  DotCastLivestreamEventType,
  DotCastLivestreamPool,
  DotCastLivestreamSession,
  DotCastLivestreamSnapshot,
  DotCastLivestreamStatus,
  DotCastLivestreamViewerPresence,
  DotCastLivestreamViewerRole,
  PoolStatus,
  StakeUnit
} from "./types";
import type { Env } from "../../types";

const LIVESTREAM_STATE_KEY = "dotcast:livestream-state:v1";
const MAX_EVENTS = 250;
const PRESENCE_TTL_MS = 60_000;
const SSE_RETRY_MS = 3_000;

interface RealtimeClient {
  clientId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

interface LivestreamState {
  session: DotCastLivestreamSession;
  pools: Record<string, DotCastLivestreamPool>;
  viewers: Record<string, DotCastLivestreamViewerPresence>;
  events: DotCastLivestreamEvent[];
  nextEventId: number;
  updatedAt: string;
}

interface StartLivestreamPayload {
  hostId?: unknown;
  title?: unknown;
  now?: unknown;
}

interface CreateLivestreamPayload extends StartLivestreamPayload {
  status?: unknown;
}

interface AddPoolPayload {
  poolId?: unknown;
  marketId?: unknown;
  question?: unknown;
  unit?: unknown;
  status?: unknown;
  pinned?: unknown;
  now?: unknown;
}

interface FeaturedPoolPayload {
  poolId?: unknown;
  now?: unknown;
}

interface PresencePayload {
  viewerId?: unknown;
  role?: unknown;
  now?: unknown;
}

interface TransitionPayload {
  now?: unknown;
}

interface PoolUpdatePayload {
  poolId?: unknown;
  now?: unknown;
}

interface RealtimePoolSnapshot {
  poolId: string;
  marketId: string;
  question: string;
  unit: StakeUnit;
  attachedStatus: PoolStatus;
  liveOdds: DotCastLiveOddsSnapshot | null;
  pool: Record<string, unknown> | null;
  settlement: unknown;
  voidReason: unknown;
  updatedAt: string;
  error: string | null;
}

export class DotCastLivestream {
  private readonly realtimeClients = new Map<string, RealtimeClient>();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env?: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return await this.read(url.searchParams);
      }

      if (request.method === "POST" && url.pathname === "/create") {
        return await this.create(request);
      }

      if (request.method === "POST" && url.pathname === "/start") {
        return await this.start(request);
      }

      if (request.method === "POST" && url.pathname === "/pause") {
        return await this.pause(request);
      }

      if (request.method === "POST" && url.pathname === "/resume") {
        return await this.resume(request);
      }

      if (request.method === "POST" && url.pathname === "/end") {
        return await this.end(request);
      }

      if (request.method === "POST" && url.pathname === "/pools") {
        return await this.attachPool(request);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/pools/")) {
        return await this.detachPool(decodeURIComponent(url.pathname.slice("/pools/".length)));
      }

      if (request.method === "POST" && url.pathname === "/featured") {
        return await this.setFeaturedPool(request);
      }

      if (request.method === "POST" && url.pathname === "/presence") {
        return await this.recordPresence(request);
      }

      if (request.method === "GET" && url.pathname === "/events") {
        return await this.readEvents(url.searchParams);
      }

      if (request.method === "GET" && url.pathname === "/stream") {
        return await this.stream(url.searchParams);
      }

      if (request.method === "POST" && url.pathname === "/pool-updates") {
        return await this.pushPoolUpdate(request);
      }

      return jsonResponse({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ ok: false, error: errorMessage(error) }, 400);
    }
  }

  private async create(request: Request): Promise<Response> {
    const body = await readJson<CreateLivestreamPayload>(request);
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const existing = await this.readState();

    if (existing) {
      return jsonResponse({ ok: true, created: false, ...decorateLivestream(existing) });
    }

    const status = parseCreateStatus(body.status);
    const streamId = streamIdFromRequest(request);
    const session: DotCastLivestreamSession = {
      id: streamId,
      hostId: parseRequiredString(body.hostId, "hostId"),
      title: parseRequiredString(body.title, "title"),
      status,
      featuredPoolId: null,
      viewerCount: 0,
      poolCount: 0,
      createdAt: now,
      startedAt: status === "live" ? now : null,
      pausedAt: status === "paused" ? now : null,
      endedAt: null,
      updatedAt: now
    };
    const initial: LivestreamState = {
      session,
      pools: {},
      viewers: {},
      events: [],
      nextEventId: 1,
      updatedAt: now
    };
    const next = appendEvent(initial, "STREAM_CREATED", now, null, null, {
      hostId: session.hostId,
      title: session.title,
      status
    });
    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, created: true, ...decorateLivestream(next) }, 201);
  }

  private async read(searchParams: URLSearchParams): Promise<Response> {
    const state = await this.requireState();
    const now = parseOptionalString(searchParams.get("now"), "now") ?? new Date().toISOString();
    const compacted = await this.compactPresence(state, now);

    return jsonResponse({ ok: true, ...decorateLivestream(compacted) });
  }

  private async start(request: Request): Promise<Response> {
    const body = await readJson<StartLivestreamPayload>(request);
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const existing = await this.readState();

    if (existing) {
      if (existing.session.status === "ended") {
        return jsonResponse({ ok: false, error: "ended livestreams cannot restart" }, 409);
      }

      const session = {
        ...existing.session,
        status: "live" as const,
        pausedAt: null,
        startedAt: existing.session.startedAt ?? now,
        updatedAt: now
      };
      const next = appendEvent(
        this.withSession(existing, session, now),
        "STREAM_RESUMED",
        now,
        null,
        null,
        { reason: "start_existing" }
      );
      await this.writeState(next);
      await this.publishLatestEvent(next);
      return jsonResponse({ ok: true, created: false, ...decorateLivestream(next) });
    }

    const streamId = streamIdFromRequest(request);
    const session: DotCastLivestreamSession = {
      id: streamId,
      hostId: parseRequiredString(body.hostId, "hostId"),
      title: parseRequiredString(body.title, "title"),
      status: "live",
      featuredPoolId: null,
      viewerCount: 0,
      poolCount: 0,
      createdAt: now,
      startedAt: now,
      pausedAt: null,
      endedAt: null,
      updatedAt: now
    };
    const initial: LivestreamState = {
      session,
      pools: {},
      viewers: {},
      events: [],
      nextEventId: 1,
      updatedAt: now
    };
    const next = appendEvent(initial, "STREAM_STARTED", now, null, null, {
      hostId: session.hostId,
      title: session.title
    });
    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, created: true, ...decorateLivestream(next) }, 201);
  }

  private async pause(request: Request): Promise<Response> {
    const body = await readJson<TransitionPayload>(request);
    const state = await this.requireState();
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    assertTransitionAllowed(state.session.status, "paused");

    if (state.session.status === "paused") {
      return jsonResponse({ ok: true, idempotent: true, ...decorateLivestream(state) });
    }

    const session = {
      ...state.session,
      status: "paused" as const,
      pausedAt: now,
      updatedAt: now
    };
    const next = appendEvent(this.withSession(state, session, now), "STREAM_PAUSED", now);
    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, ...decorateLivestream(next) });
  }

  private async resume(request: Request): Promise<Response> {
    const body = await readJson<TransitionPayload>(request);
    const state = await this.requireState();
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    assertTransitionAllowed(state.session.status, "live");

    if (state.session.status === "live") {
      return jsonResponse({ ok: true, idempotent: true, ...decorateLivestream(state) });
    }

    const session = {
      ...state.session,
      status: "live" as const,
      pausedAt: null,
      updatedAt: now
    };
    const next = appendEvent(this.withSession(state, session, now), "STREAM_RESUMED", now);
    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, ...decorateLivestream(next) });
  }

  private async end(request: Request): Promise<Response> {
    const body = await readJson<TransitionPayload>(request);
    const state = await this.requireState();
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();

    if (state.session.status === "ended") {
      return jsonResponse({ ok: true, idempotent: true, ...decorateLivestream(state) });
    }

    const session = {
      ...state.session,
      status: "ended" as const,
      endedAt: now,
      updatedAt: now
    };
    const next = appendEvent(this.withSession(state, session, now), "STREAM_ENDED", now);
    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, ...decorateLivestream(next) });
  }

  private async attachPool(request: Request): Promise<Response> {
    const body = await readJson<AddPoolPayload>(request);
    const state = await this.requireMutableState();
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const poolId = parseRequiredString(body.poolId, "poolId");
    const existing = state.pools[poolId];
    const pool: DotCastLivestreamPool = {
      poolId,
      marketId: parseRequiredString(body.marketId, "marketId"),
      question: parseRequiredString(body.question, "question"),
      unit: parseStakeUnit(body.unit),
      status: parsePoolStatus(body.status),
      order: existing?.order ?? Object.keys(state.pools).length + 1,
      pinned: parseOptionalBoolean(body.pinned, "pinned") ?? existing?.pinned ?? false,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now
    };
    const pools = {
      ...state.pools,
      [poolId]: pool
    };
    const session = updateSessionCounts(
      {
        ...state.session,
        featuredPoolId: state.session.featuredPoolId ?? poolId,
        updatedAt: now
      },
      pools,
      state.viewers
    );
    const next = appendEvent(
      {
        ...state,
        session,
        pools,
        updatedAt: now
      },
      "POOL_ATTACHED",
      now,
      poolId,
      null,
      { marketId: pool.marketId, unit: pool.unit, status: pool.status }
    );

    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, pool, ...decorateLivestream(next) }, existing ? 200 : 201);
  }

  private async detachPool(poolId: string): Promise<Response> {
    const state = await this.requireMutableState();
    const pool = state.pools[poolId];

    if (!pool) {
      return jsonResponse({ ok: true, detached: false, ...decorateLivestream(state) });
    }

    const now = new Date().toISOString();
    const pools = { ...state.pools };
    delete pools[poolId];
    const nextFeatured =
      state.session.featuredPoolId === poolId
        ? (orderedPools(pools)[0]?.poolId ?? null)
        : state.session.featuredPoolId;
    const session = updateSessionCounts(
      {
        ...state.session,
        featuredPoolId: nextFeatured,
        updatedAt: now
      },
      pools,
      state.viewers
    );
    const next = appendEvent(
      { ...state, session, pools, updatedAt: now },
      "POOL_DETACHED",
      now,
      poolId
    );

    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, detached: true, ...decorateLivestream(next) });
  }

  private async setFeaturedPool(request: Request): Promise<Response> {
    const body = await readJson<FeaturedPoolPayload>(request);
    const state = await this.requireMutableState();
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const poolId = parseRequiredString(body.poolId, "poolId");

    if (!state.pools[poolId]) {
      throw new Error("featured pool must already be attached to the livestream");
    }

    const session = {
      ...state.session,
      featuredPoolId: poolId,
      updatedAt: now
    };
    const next = appendEvent(
      this.withSession(state, session, now),
      "FEATURED_POOL_CHANGED",
      now,
      poolId
    );
    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, featuredPoolId: poolId, ...decorateLivestream(next) });
  }

  private async recordPresence(request: Request): Promise<Response> {
    const body = await readJson<PresencePayload>(request);
    const state = await this.requireMutableState();
    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const viewerId = parseRequiredString(body.viewerId, "viewerId");
    const existing = state.viewers[viewerId];
    const viewer: DotCastLivestreamViewerPresence = {
      viewerId,
      role: parseViewerRole(body.role),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now
    };
    const viewers = activeViewers(
      {
        ...state.viewers,
        [viewerId]: viewer
      },
      now
    );
    const session = updateSessionCounts(
      {
        ...state.session,
        updatedAt: now
      },
      state.pools,
      viewers
    );
    const next = appendEvent(
      {
        ...state,
        session,
        viewers,
        updatedAt: now
      },
      "PRESENCE_HEARTBEAT",
      now,
      null,
      viewerId,
      { role: viewer.role }
    );

    await this.writeState(next);
    await this.publishLatestEvent(next);
    return jsonResponse({ ok: true, viewer, ...decorateLivestream(next) });
  }

  private async readEvents(searchParams: URLSearchParams): Promise<Response> {
    const state = await this.requireState();
    const after = parseOptionalNonNegativeInteger(searchParams.get("after"), "after") ?? 0;
    const limit = Math.min(
      parseOptionalNonNegativeInteger(searchParams.get("limit"), "limit") ?? 50,
      100
    );
    const events = state.events.filter((event) => event.id > after).slice(0, limit);

    return jsonResponse({
      ok: true,
      streamId: state.session.id,
      events,
      cursor: events.at(-1)?.id ?? after,
      latestEventId: state.events.at(-1)?.id ?? 0
    });
  }

  private async stream(searchParams: URLSearchParams): Promise<Response> {
    const state = await this.requireState();
    const now = parseOptionalString(searchParams.get("now"), "now") ?? new Date().toISOString();
    const compacted = await this.compactPresence(state, now);
    const once = searchParams.get("once") === "true";
    let clientId: string | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientId = `sse:${crypto.randomUUID()}`;
        const client: RealtimeClient = { clientId, controller };

        if (!once) {
          this.realtimeClients.set(clientId, client);
        }

        this.enqueueSse(client, "livestream.ready", {
          ok: true,
          streamId: compacted.session.id,
          clientId,
          retryMs: SSE_RETRY_MS,
          createdAt: now
        });
        void this.writeInitialRealtimeFrame(client, compacted, now, once);
      },
      cancel: () => {
        if (clientId) {
          this.realtimeClients.delete(clientId);
        }
      }
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream;charset=UTF-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  }

  private async pushPoolUpdate(request: Request): Promise<Response> {
    const body = await readJson<PoolUpdatePayload>(request);
    const state = await this.requireState();
    const poolId = parseRequiredString(body.poolId, "poolId");
    const pool = state.pools[poolId];

    if (!pool) {
      return jsonResponse({ ok: false, error: "pool is not attached to livestream" }, 404);
    }

    const now = parseOptionalString(body.now, "now") ?? new Date().toISOString();
    const poolOdds = await this.readPoolRealtimeSnapshot(pool);
    this.broadcastPoolRealtimeFrame(state, poolOdds, now);

    return jsonResponse({
      ok: true,
      streamId: state.session.id,
      poolId,
      poolOdds,
      clientCount: this.realtimeClients.size
    });
  }

  private async compactPresence(state: LivestreamState, now: string): Promise<LivestreamState> {
    const viewers = activeViewers(state.viewers, now);

    if (Object.keys(viewers).length === Object.keys(state.viewers).length) {
      return state;
    }

    const session = updateSessionCounts(state.session, state.pools, viewers);
    const next = {
      ...state,
      session,
      viewers,
      updatedAt: now
    };
    await this.writeState(next);
    return next;
  }

  private withSession(
    state: LivestreamState,
    session: DotCastLivestreamSession,
    now: string
  ): LivestreamState {
    return {
      ...state,
      session: updateSessionCounts(session, state.pools, state.viewers),
      updatedAt: now
    };
  }

  private async requireMutableState(): Promise<LivestreamState> {
    const state = await this.requireState();

    if (state.session.status === "ended") {
      throw new Error("ended livestreams cannot be mutated");
    }

    return state;
  }

  private async requireState(): Promise<LivestreamState> {
    const state = await this.readState();

    if (!state) {
      throw new Error("livestream has not been started");
    }

    return normalizeState(state);
  }

  private async readState(): Promise<LivestreamState | null> {
    const state = (await this.state.storage.get<LivestreamState>(LIVESTREAM_STATE_KEY)) ?? null;
    return state ? normalizeState(state) : null;
  }

  private async writeState(state: LivestreamState): Promise<void> {
    await this.state.storage.put(LIVESTREAM_STATE_KEY, normalizeState(state));
  }

  private async writeInitialRealtimeFrame(
    client: RealtimeClient,
    state: LivestreamState,
    now: string,
    once: boolean
  ): Promise<void> {
    try {
      this.enqueueSse(client, "livestream.snapshot", {
        ok: true,
        type: "livestream.snapshot",
        streamId: state.session.id,
        cursor: state.events.at(-1)?.id ?? 0,
        latestEventId: state.events.at(-1)?.id ?? 0,
        livestream: decorateLivestream(state).livestream,
        poolOdds: await this.readAttachedPoolRealtimeSnapshots(state),
        createdAt: now
      });

      if (once) {
        client.controller.close();
      }
    } catch {
      this.realtimeClients.delete(client.clientId);
      try {
        client.controller.close();
      } catch {
        // Client already disconnected.
      }
    }
  }

  private async publishLatestEvent(state: LivestreamState): Promise<void> {
    const event = state.events.at(-1);

    if (!event || this.realtimeClients.size === 0) {
      return;
    }

    const poolOdds =
      event.poolId && state.pools[event.poolId]
        ? await this.readPoolRealtimeSnapshot(state.pools[event.poolId])
        : null;

    this.broadcastLivestreamEventFrame(state, event, poolOdds);
  }

  private broadcastLivestreamEventFrame(
    state: LivestreamState,
    event: DotCastLivestreamEvent,
    poolOdds: RealtimePoolSnapshot | null
  ): void {
    const frame = {
      ok: true,
      type: "livestream.event",
      streamId: state.session.id,
      cursor: event.id,
      latestEventId: state.events.at(-1)?.id ?? event.id,
      event,
      livestream: decorateLivestream(state).livestream,
      poolOdds,
      createdAt: event.createdAt
    };

    for (const client of this.realtimeClients.values()) {
      this.enqueueSse(client, "livestream.event", frame, event.id);
    }
  }

  private broadcastPoolRealtimeFrame(
    state: LivestreamState,
    poolOdds: RealtimePoolSnapshot,
    now: string
  ): void {
    const latestEventId = state.events.at(-1)?.id ?? 0;
    const frame = {
      ok: true,
      type: "livestream.pool_odds",
      streamId: state.session.id,
      cursor: latestEventId,
      latestEventId,
      poolOdds,
      createdAt: now
    };

    for (const client of this.realtimeClients.values()) {
      this.enqueueSse(client, "livestream.pool_odds", frame, latestEventId);
    }
  }

  private async readAttachedPoolRealtimeSnapshots(
    state: LivestreamState
  ): Promise<RealtimePoolSnapshot[]> {
    return Promise.all(
      orderedPools(state.pools).map((pool) => this.readPoolRealtimeSnapshot(pool))
    );
  }

  private async readPoolRealtimeSnapshot(
    pool: DotCastLivestreamPool
  ): Promise<RealtimePoolSnapshot> {
    if (!this.env?.DOTCAST_POOL) {
      return {
        ...baseRealtimePool(pool),
        liveOdds: null,
        pool: null,
        settlement: null,
        voidReason: null,
        updatedAt: pool.updatedAt,
        error: "dotCast pool storage is not configured"
      };
    }

    try {
      const objectId = this.env.DOTCAST_POOL.idFromName(pool.poolId);
      const object = this.env.DOTCAST_POOL.get(objectId);
      const response = await object.fetch(new Request("https://dotcast.pool/odds"));

      if (!response.ok) {
        return {
          ...baseRealtimePool(pool),
          liveOdds: null,
          pool: null,
          settlement: null,
          voidReason: null,
          updatedAt: pool.updatedAt,
          error: `pool odds fetch failed with status ${response.status}`
        };
      }

      const body = parseRecord(await response.json());
      const snapshot = parseRecord(body.snapshot);

      return {
        ...baseRealtimePool(pool),
        liveOdds: parseNullableRecord(body.liveOdds) as DotCastLiveOddsSnapshot | null,
        pool: parseNullableRecord(snapshot.pool),
        settlement: snapshot.settlement ?? null,
        voidReason: snapshot.voidReason ?? null,
        updatedAt: parseOptionalString(snapshot.updatedAt, "snapshot.updatedAt") ?? pool.updatedAt,
        error: null
      };
    } catch (error) {
      return {
        ...baseRealtimePool(pool),
        liveOdds: null,
        pool: null,
        settlement: null,
        voidReason: null,
        updatedAt: pool.updatedAt,
        error: errorMessage(error)
      };
    }
  }

  private enqueueSse(
    client: RealtimeClient,
    eventName: string,
    payload: Record<string, unknown>,
    id?: number
  ): void {
    try {
      client.controller.enqueue(this.encoder.encode(formatSse(eventName, payload, id)));
    } catch {
      this.realtimeClients.delete(client.clientId);
    }
  }
}

function baseRealtimePool(pool: DotCastLivestreamPool) {
  return {
    poolId: pool.poolId,
    marketId: pool.marketId,
    question: pool.question,
    unit: pool.unit,
    attachedStatus: pool.status
  };
}

function formatSse(eventName: string, payload: Record<string, unknown>, id?: number): string {
  const lines = [`event: ${eventName}`];

  if (id !== undefined) {
    lines.unshift(`id: ${id}`);
  }

  lines.push(`retry: ${SSE_RETRY_MS}`);
  lines.push(`data: ${JSON.stringify(payload)}`);
  return `${lines.join("\n")}\n\n`;
}

function appendEvent(
  state: LivestreamState,
  eventType: DotCastLivestreamEventType,
  createdAt: string,
  poolId: string | null = null,
  viewerId: string | null = null,
  payload: Record<string, unknown> = {}
): LivestreamState {
  const event: DotCastLivestreamEvent = {
    id: state.nextEventId,
    eventId: `dotcast:livestream:${state.session.id}:${state.nextEventId}`,
    streamId: state.session.id,
    eventType,
    poolId,
    viewerId,
    payload,
    createdAt
  };

  return {
    ...state,
    events: [...state.events, event].slice(-MAX_EVENTS),
    nextEventId: state.nextEventId + 1,
    updatedAt: createdAt
  };
}

function decorateLivestream(state: LivestreamState): { livestream: DotCastLivestreamSnapshot } {
  return {
    livestream: {
      session: state.session,
      pools: orderedPools(state.pools),
      viewers: orderedViewers(state.viewers),
      events: state.events.slice(-25),
      updatedAt: state.updatedAt
    }
  };
}

function normalizeState(state: LivestreamState): LivestreamState {
  return {
    ...state,
    pools: state.pools ?? {},
    viewers: state.viewers ?? {},
    events: state.events ?? [],
    nextEventId: state.nextEventId ?? (state.events?.at(-1)?.id ?? 0) + 1,
    session: updateSessionCounts(state.session, state.pools ?? {}, state.viewers ?? {}),
    updatedAt: state.updatedAt ?? state.session.updatedAt
  };
}

function updateSessionCounts(
  session: DotCastLivestreamSession,
  pools: Record<string, DotCastLivestreamPool>,
  viewers: Record<string, DotCastLivestreamViewerPresence>
): DotCastLivestreamSession {
  return {
    ...session,
    poolCount: Object.keys(pools).length,
    viewerCount: Object.keys(viewers).length
  };
}

function orderedPools(pools: Record<string, DotCastLivestreamPool>): DotCastLivestreamPool[] {
  return Object.values(pools).sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    return left.order - right.order || left.addedAt.localeCompare(right.addedAt);
  });
}

function orderedViewers(
  viewers: Record<string, DotCastLivestreamViewerPresence>
): DotCastLivestreamViewerPresence[] {
  return Object.values(viewers).sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt)
  );
}

function activeViewers(
  viewers: Record<string, DotCastLivestreamViewerPresence>,
  now: string
): Record<string, DotCastLivestreamViewerPresence> {
  const nowMs = Date.parse(now);

  return Object.fromEntries(
    Object.entries(viewers).filter(
      ([, viewer]) => nowMs - Date.parse(viewer.lastSeenAt) <= PRESENCE_TTL_MS
    )
  );
}

function assertTransitionAllowed(
  current: DotCastLivestreamStatus,
  target: DotCastLivestreamStatus
): void {
  const allowed: Record<DotCastLivestreamStatus, DotCastLivestreamStatus[]> = {
    draft: ["live", "ended"],
    live: ["paused", "ended"],
    paused: ["live", "ended"],
    ended: []
  };

  if (current === target) {
    return;
  }

  if (!allowed[current].includes(target)) {
    throw new Error(`illegal livestream transition ${current} -> ${target}`);
  }
}

function streamIdFromRequest(request: Request): string {
  const value = new URL(request.url).searchParams.get("streamId");
  return parseRequiredString(value, "streamId");
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw new Error("request body must be JSON");
  }
}

function parseCreateStatus(value: unknown): "live" | "paused" | "draft" {
  if (value === undefined || value === null) {
    return "paused";
  }

  if (value === "live" || value === "paused" || value === "draft") {
    return value;
  }

  throw new Error("status must be live, paused, or draft");
}

function parseStakeUnit(value: unknown): StakeUnit {
  if (value === "points" || value === "usdc") {
    return value;
  }

  throw new Error("unit must be points or usdc");
}

function parsePoolStatus(value: unknown): PoolStatus {
  if (
    value === "open" ||
    value === "locked" ||
    value === "resolving" ||
    value === "settled" ||
    value === "voided"
  ) {
    return value;
  }

  return "open";
}

function parseViewerRole(value: unknown): DotCastLivestreamViewerRole {
  if (value === "host" || value === "moderator" || value === "viewer") {
    return value;
  }

  return "viewer";
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function parseNullableRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseRecord(value);
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

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${label} must be a boolean`);
}

function parseOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = typeof value === "string" ? Number(value) : value;

  if (Number.isSafeInteger(parsed) && (parsed as number) >= 0) {
    return parsed as number;
  }

  throw new Error(`${label} must be a non-negative integer`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid request";
}

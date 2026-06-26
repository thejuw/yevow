import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDotCastPoolResolution,
  archiveDotCastLivestream,
  attachDotCastLivestreamPool,
  createDotCastPool,
  createDotCastLivestreamSession,
  detachDotCastLivestreamPool,
  endDotCastLivestream,
  handleMuxLivestreamWebhook,
  placeDotCastPoolEntry,
  pauseDotCastLivestream,
  pollDotCastPoolResolution,
  previewDotCastOdds,
  readDotCastLivestream,
  readDotCastLivestreamEvents,
  readDotCastLivestreamPlayback,
  readDotCastSettlementRailBalance,
  readDotCastSettlementRailStatus,
  recordDotCastDevnetDeposit,
  recordDotCastLivestreamPresence,
  readDotCastPoolLiveOdds,
  readDotCastHealth,
  requestDotCastDevnetWithdrawal,
  resumeDotCastLivestream,
  setDotCastLivestreamFeaturedPool,
  settleDotCastPool,
  simulateDotCastSettlement,
  startDotCastLivestream,
  voidDotCastPool
} from "../../src/gateway/DotCastGateway";
import type { Env } from "../../src/types";

describe("dotCast gateway handlers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports milestone health without requiring funds or persistence", async () => {
    const response = readDotCastHealth();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      product: "dotCast",
      engine: "live-parimutuel",
      milestones: {
        e0: "parimutuel-core-ready",
        e1: "pool-lifecycle-core-ready",
        e2: "router-resolution-polling-ready",
        e3: "live-odds-reference-endpoint-ready",
        livestreamEngine: "stream-spine-ready",
        e13: "resolution-router-not-started"
      }
    });
  });

  it("previews live odds and payout from integer minor-unit pools", async () => {
    const response = await previewDotCastOdds(
      jsonRequest("/api/dotcast/preview", {
        pools: { yes: 7000, no: 3000 },
        side: "yes",
        amount: 700,
        rake: 0.05
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      odds: { yes: 0.7, no: 0.3 },
      preview: { side: "yes", amount: 700, payout: 959 },
      rake: 0.05
    });
  });

  it("rejects malformed preview requests", async () => {
    const response = await previewDotCastOdds(
      jsonRequest("/api/dotcast/preview", {
        pools: { yes: 1, no: 0 },
        side: "maybe",
        amount: 10
      })
    );

    expect(response.status).toBe(400);
  });

  it("simulates deterministic settlement and reports conservation", async () => {
    const response = await simulateDotCastSettlement(
      jsonRequest("/api/dotcast/settlement/simulate", {
        entries: [
          { id: "yes-target", side: "yes", amount: 700 },
          { id: "yes-rest", side: "yes", amount: 6300 },
          { id: "no-pool", side: "no", amount: 3000 }
        ],
        outcome: "yes",
        rake: 0.05
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      conservation: {
        payoutTotal: 9850,
        rakeAmount: 150,
        totalStaked: 10000,
        conserved: true
      }
    });
  });

  it("proxies persistent pool creation through the Durable Object binding", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = await request.json<Record<string, unknown>>();
      return Response.json({ ok: true, created: true, snapshot: { pool: { id: body.id } } });
    });
    const response = await createDotCastPool(
      jsonRequest("/api/dotcast/pools", {
        id: "pool-gateway",
        market: {
          id: "kalshi:gateway",
          venue: "kalshi",
          question: "Will gateway creation work?",
          status: "open",
          closeTime: "2026-06-25T17:05:00.000Z",
          expectedResolveAt: null
        },
        unit: "points",
        entryClosesAt: "2026-06-25T17:05:00.000Z",
        now: "2026-06-25T17:00:00.000Z"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["POST /create"]);
    expect(await response.json()).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          id: "pool-gateway"
        }
      }
    });
  });

  it("rejects public USDC pool creation until E6 funding is enabled", async () => {
    const response = await createDotCastPool(
      jsonRequest("/api/dotcast/pools", {
        id: "pool-usdc",
        market: {
          id: "kalshi:gateway",
          venue: "kalshi",
          question: "Will gateway creation work?",
          status: "open",
          closeTime: "2026-06-25T17:05:00.000Z",
          expectedResolveAt: null
        },
        unit: "usdc",
        entryClosesAt: "2026-06-25T17:05:00.000Z",
        now: "2026-06-25T17:00:00.000Z"
      }),
      envWithDotCastPool(async () => Response.json({ ok: true }))
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "usdc pools are disabled until the E6 pool funding rail is enabled"
    });
  });

  it("allows devnet-gated USDC pool creation once E6 funding is ready", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPoolAndSettlementRail(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = await request.json<Record<string, unknown>>();
      return Response.json({
        ok: true,
        created: true,
        snapshot: { pool: { id: body.id, unit: body.unit } }
      });
    });
    const response = await createDotCastPool(
      jsonRequest("/api/dotcast/pools", {
        id: "pool-usdc",
        market: {
          id: "kalshi:gateway",
          venue: "kalshi",
          question: "Will gateway creation work?",
          status: "open",
          closeTime: "2026-06-25T17:05:00.000Z",
          expectedResolveAt: null
        },
        unit: "usdc",
        entryClosesAt: "2026-06-25T17:05:00.000Z",
        now: "2026-06-25T17:00:00.000Z"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["POST /create"]);
    expect(await response.json()).toMatchObject({
      ok: true,
      snapshot: { pool: { id: "pool-usdc", unit: "usdc" } }
    });
  });

  it("proxies livestream routes through the stream Durable Object binding", async () => {
    const calls: { route: string; search: string; body: Record<string, unknown> | null }[] = [];
    const env = envWithDotCastLivestream(async (request) => {
      const url = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "DELETE"
          ? null
          : await request.json<Record<string, unknown>>();
      calls.push({ route: `${request.method} ${url.pathname}`, search: url.search, body });
      return Response.json({ ok: true });
    });
    const id = "stream-gateway";

    const started = await startDotCastLivestream(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/start`, {
        hostId: "host-gateway",
        title: "Gateway stream",
        now: "2099-06-25T17:00:00.000Z"
      }),
      env
    );
    const attached = await attachDotCastLivestreamPool(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/pools`, {
        poolId: "pool-gateway-live",
        marketId: "kalshi:gateway-live",
        question: "Will gateway livestream routing work?",
        unit: "points",
        status: "open",
        pinned: true,
        now: "2099-06-25T17:01:00.000Z"
      }),
      env
    );
    const featured = await setDotCastLivestreamFeaturedPool(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/featured`, {
        poolId: "pool-gateway-live",
        now: "2099-06-25T17:02:00.000Z"
      }),
      env
    );
    const presence = await recordDotCastLivestreamPresence(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/presence`, {
        viewerId: "viewer-gateway",
        role: "viewer",
        now: "2099-06-25T17:02:30.000Z"
      }),
      env
    );
    const read = await readDotCastLivestream(
      id,
      new Request(`https://api.test/api/dotcast/livestreams/${id}?now=2099`),
      env
    );
    const events = await readDotCastLivestreamEvents(
      id,
      new Request(`https://api.test/api/dotcast/livestreams/${id}/events?after=2&limit=5`),
      env
    );
    const paused = await pauseDotCastLivestream(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/pause`, {
        now: "2099-06-25T17:03:00.000Z"
      }),
      env
    );
    const resumed = await resumeDotCastLivestream(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/resume`, {
        now: "2099-06-25T17:04:00.000Z"
      }),
      env
    );
    const detached = await detachDotCastLivestreamPool(id, "pool-gateway-live", env);
    const ended = await endDotCastLivestream(
      id,
      jsonRequest(`/api/dotcast/livestreams/${id}/end`, {
        now: "2099-06-25T17:05:00.000Z"
      }),
      env
    );

    expect([
      started.status,
      attached.status,
      featured.status,
      presence.status,
      read.status,
      events.status,
      paused.status,
      resumed.status,
      detached.status,
      ended.status
    ]).toEqual(Array(10).fill(200));
    expect(calls).toEqual([
      {
        route: "POST /start",
        search: "?streamId=stream-gateway",
        body: {
          hostId: "host-gateway",
          title: "Gateway stream",
          now: "2099-06-25T17:00:00.000Z"
        }
      },
      {
        route: "POST /pools",
        search: "?streamId=stream-gateway",
        body: {
          poolId: "pool-gateway-live",
          marketId: "kalshi:gateway-live",
          question: "Will gateway livestream routing work?",
          unit: "points",
          status: "open",
          pinned: true,
          now: "2099-06-25T17:01:00.000Z"
        }
      },
      {
        route: "POST /featured",
        search: "?streamId=stream-gateway",
        body: {
          poolId: "pool-gateway-live",
          now: "2099-06-25T17:02:00.000Z"
        }
      },
      {
        route: "POST /presence",
        search: "?streamId=stream-gateway",
        body: {
          viewerId: "viewer-gateway",
          role: "viewer",
          now: "2099-06-25T17:02:30.000Z"
        }
      },
      {
        route: "GET /",
        search: "?now=2099&streamId=stream-gateway",
        body: null
      },
      {
        route: "GET /events",
        search: "?after=2&limit=5&streamId=stream-gateway",
        body: null
      },
      {
        route: "POST /pause",
        search: "?streamId=stream-gateway",
        body: { now: "2099-06-25T17:03:00.000Z" }
      },
      {
        route: "POST /resume",
        search: "?streamId=stream-gateway",
        body: { now: "2099-06-25T17:04:00.000Z" }
      },
      {
        route: "DELETE /pools/pool-gateway-live",
        search: "?streamId=stream-gateway",
        body: null
      },
      {
        route: "POST /end",
        search: "?streamId=stream-gateway",
        body: { now: "2099-06-25T17:05:00.000Z" }
      }
    ]);
  });

  it("returns a readiness error when livestream storage is not configured", async () => {
    const response = await readDotCastLivestream(
      "stream-missing",
      new Request("https://api.test/api/dotcast/livestreams/stream-missing"),
      {} as Env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "dotCast livestream storage is not configured"
    });
  });

  it("creates Mux-backed livestream sessions and keeps stream keys host-only", async () => {
    const calls: string[] = [];
    const d1 = new FakeLivestreamD1();
    const env = envWithMuxLivestream(d1, async (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}${url.search}`);
      return Response.json({ ok: true });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.mux.com/video/v1/live-streams");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          playback_policies: ["public"],
          latency_mode: "low",
          reconnect_window: 60,
          new_asset_settings: { playback_policies: ["public"] },
          passthrough: "stream-mux"
        });
        return Response.json({
          data: {
            id: "mux-live-1",
            stream_key: "mux-secret-stream-key",
            status: "idle",
            reconnect_window: 60,
            playback_ids: [{ id: "mux-playback-1", policy: "public" }],
            created_at: String(Math.floor(Date.now() / 1000))
          }
        });
      })
    );

    const response = await createDotCastLivestreamSession(
      jsonRequest("/api/dotcast/livestreams", {
        streamId: "stream-mux",
        hostId: "host-mux",
        title: "Mux-backed dotCast stream",
        now: "2099-06-25T17:00:00.000Z",
        metadata: { show: "orbital" }
      }),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      livestream: {
        streamId: "stream-mux",
        provider: "mux",
        controlLayer: "livewire",
        muxLiveStreamId: "mux-live-1",
        playbackId: "mux-playback-1",
        status: "idle",
        ingest: { streamKeyExposed: false }
      },
      videoPlane: {
        provider: "mux",
        lowLatency: true,
        recordingEnabled: true
      },
      hostIngest: {
        rtmpUrl: "rtmp://global-live.mux.com:5222/app",
        streamKey: "mux-secret-stream-key"
      },
      viewerPlayback: {
        playbackUrl: "https://stream.mux.com/mux-playback-1.m3u8",
        token: null
      }
    });
    expect(serialized).toContain("mux-secret-stream-key");
    expect(JSON.stringify(d1.livestreams.get("stream-mux"))).not.toContain("mux-secret-stream-key");
    expect(calls).toEqual(["POST /create?streamId=stream-mux"]);

    const playback = await readDotCastLivestreamPlayback("stream-mux", env);
    const playbackBody = (await playback.json()) as Record<string, unknown>;

    expect(playback.status).toBe(200);
    expect(JSON.stringify(playbackBody)).not.toContain("mux-secret-stream-key");
    expect(playbackBody).toMatchObject({
      viewerPlayback: {
        playbackId: "mux-playback-1",
        playbackPolicy: "public",
        playbackUrl: "https://stream.mux.com/mux-playback-1.m3u8"
      }
    });
  });

  it("stores livestream pool links while forwarding prediction state to the room object", async () => {
    const d1 = new FakeLivestreamD1();
    const forwarded: { route: string; body: Record<string, unknown> | null }[] = [];
    const env = envWithMuxLivestream(d1, async (request) => {
      forwarded.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: request.method === "DELETE" ? null : await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true });
    });
    d1.livestreams.set("stream-link", livestreamRow());

    const response = await attachDotCastLivestreamPool(
      "stream-link",
      jsonRequest("/api/dotcast/livestreams/stream-link/pools", {
        poolId: "pool-link",
        marketId: "kalshi:pool-link",
        question: "Will the linked pool show live odds?",
        unit: "usdc",
        status: "open",
        pinned: true,
        now: "2099-06-25T17:01:00.000Z"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(d1.poolLinks.get("stream-link:pool-link")).toMatchObject({
      stream_id: "stream-link",
      pool_id: "pool-link",
      market_id: "kalshi:pool-link",
      pinned: 1
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.route).toBe("POST /pools");
    expect(forwarded[0]?.body).toMatchObject({
      poolId: "pool-link",
      marketId: "kalshi:pool-link"
    });
  });

  it("accepts verified Mux webhooks as lifecycle source without settling predictions", async () => {
    const d1 = new FakeLivestreamD1();
    const calls: string[] = [];
    const env = envWithMuxLivestream(d1, async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ ok: true });
    });
    d1.livestreams.set("stream-webhook", livestreamRow());

    const activeBody = JSON.stringify({
      id: "mux-event-active",
      type: "video.live_stream.active",
      created_at: Math.floor(Date.now() / 1000),
      data: { id: "mux-live-1", status: "active" }
    });
    const recordingBody = JSON.stringify({
      id: "mux-event-recording",
      type: "video.asset.ready",
      created_at: Math.floor(Date.now() / 1000),
      data: {
        id: "asset-1",
        live_stream_id: "mux-live-1",
        playback_ids: [{ id: "recording-playback-1", policy: "public" }]
      }
    });
    const idleBody = JSON.stringify({
      id: "mux-event-idle",
      type: "video.live_stream.idle",
      created_at: Math.floor(Date.now() / 1000),
      data: { id: "mux-live-1", status: "idle" }
    });

    const active = await handleMuxLivestreamWebhook(await muxWebhookRequest(activeBody), env);
    const recording = await handleMuxLivestreamWebhook(await muxWebhookRequest(recordingBody), env);
    const idle = await handleMuxLivestreamWebhook(await muxWebhookRequest(idleBody), env);

    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      ok: true,
      event: { type: "video.live_stream.active", status: "live" },
      predictionSettlement: "not_triggered"
    });
    expect(recording.status).toBe(200);
    expect(idle.status).toBe(200);
    expect(d1.livestreams.get("stream-webhook")).toMatchObject({
      status: "idle",
      mux_status: "idle",
      recording_asset_id: "asset-1",
      recording_playback_id: "recording-playback-1",
      last_webhook_event_id: "mux-event-idle"
    });
    expect([...d1.events.keys()]).toEqual([
      "mux-event-active",
      "mux-event-recording",
      "mux-event-idle"
    ]);
    expect(calls).toEqual(["POST /start", "POST /pause"]);
  });

  it("rejects unverified Mux webhooks and archives metadata separately from video lifecycle", async () => {
    const d1 = new FakeLivestreamD1();
    const calls: string[] = [];
    const env = envWithMuxLivestream(d1, async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ ok: true });
    });
    d1.livestreams.set("stream-archive", livestreamRow({ stream_id: "stream-archive" }));

    const invalid = await handleMuxLivestreamWebhook(
      new Request("https://api.test/api/dotcast/livestreams/webhooks/mux", {
        method: "POST",
        headers: { "mux-signature": "t=1,v1=bad" },
        body: JSON.stringify({ type: "video.live_stream.active", data: { id: "mux-live-1" } })
      }),
      env
    );
    const archived = await archiveDotCastLivestream(
      "stream-archive",
      jsonRequest("/api/dotcast/livestreams/stream-archive/archive", {
        now: "2099-06-25T18:00:00.000Z"
      }),
      env
    );

    expect(invalid.status).toBe(401);
    expect(archived.status).toBe(200);
    expect(d1.livestreams.get("stream-archive")).toMatchObject({
      status: "archived",
      archived_at: "2099-06-25T18:00:00.000Z"
    });
    expect(calls).toEqual(["POST /end"]);
  });

  it("handles E5 devnet USDC deposits and mock withdrawals through the gateway", async () => {
    const env = envWithSettlementRailDb();
    const statusResponse = readDotCastSettlementRailStatus(env);
    const depositResponse = await recordDotCastDevnetDeposit(
      jsonRequest("/api/dotcast/settlement-rail/deposits/devnet", {
        userId: "user-gateway",
        amount: 1_000_000,
        txRef: "gateway-devnet-deposit",
        confirmations: 1,
        now: "2099-06-25T17:00:00.000Z"
      }),
      env
    );
    const balanceResponse = await readDotCastSettlementRailBalance("user-gateway", env);
    const withdrawalResponse = await requestDotCastDevnetWithdrawal(
      jsonRequest("/api/dotcast/settlement-rail/withdrawals/devnet", {
        userId: "user-gateway",
        amount: 250_000,
        destination: "11111111111111111111111111111111",
        idempotencyKey: "gateway-withdrawal",
        now: "2099-06-25T17:01:00.000Z"
      }),
      env
    );
    const replayResponse = await requestDotCastDevnetWithdrawal(
      jsonRequest("/api/dotcast/settlement-rail/withdrawals/devnet", {
        userId: "user-gateway",
        amount: 250_000,
        destination: "11111111111111111111111111111111",
        idempotencyKey: "gateway-withdrawal",
        now: "2099-06-25T17:01:01.000Z"
      }),
      env
    );

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      ok: true,
      milestone: "E5",
      rail: { ready: true, signerMode: "mock" },
      safeguards: {
        privateKeysInRepo: false,
        mainnetWithdrawals: "blocked-until-operator-approval"
      }
    });
    expect(depositResponse.status).toBe(200);
    expect(await depositResponse.json()).toMatchObject({
      ok: true,
      milestone: "E5",
      status: "credited",
      balance: { availableUsdc: 1_000_000 }
    });
    expect(balanceResponse.status).toBe(200);
    expect(await balanceResponse.json()).toMatchObject({
      ok: true,
      balance: { userId: "user-gateway", availableUsdc: 1_000_000 }
    });
    expect(withdrawalResponse.status).toBe(200);
    const withdrawalBody = (await withdrawalResponse.json()) as {
      transfer?: { mockSignature?: unknown };
    };
    expect(withdrawalBody).toMatchObject({
      ok: true,
      status: "signed",
      broadcast: false,
      idempotent: false,
      transfer: {
        signerMode: "mock"
      },
      balance: { availableUsdc: 750_000, pendingWithdrawalUsdc: 250_000 }
    });
    expect(withdrawalBody.transfer?.mockSignature).toEqual(
      expect.stringMatching(/^mock-solana-devnet-/)
    );
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      ok: true,
      idempotent: true,
      balance: { availableUsdc: 750_000, pendingWithdrawalUsdc: 250_000 }
    });
  });

  it("proxies entry placement with gateway-generated entry ids", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "GET") {
        return Response.json({ ok: true, snapshot: { pool: { unit: "points" } } });
      }

      const body = await request.json<Record<string, unknown>>();
      return Response.json({ ok: true, entry: body });
    });
    const response = await placeDotCastPoolEntry(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/entries", {
        userId: "user-1",
        side: "yes",
        amount: 25,
        now: "2026-06-25T17:00:00.000Z"
      }),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual(["GET /", "POST /entries"]);
    expect(body.entry).toMatchObject({
      userId: "user-1",
      side: "yes",
      amount: 25
    });
    expect((body.entry as Record<string, unknown>).entryId).toEqual(
      expect.stringMatching(/^entry:/)
    );
  });

  it("reserves E6 USDC pool funding before forwarding entries", async () => {
    const calls: { route: string; body: Record<string, unknown> | null }[] = [];
    const env = envWithDotCastPoolAndSettlementRail(async (request) => {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      if (request.method === "GET") {
        calls.push({ route, body: null });
        return Response.json({ ok: true, snapshot: { pool: { unit: "usdc" } } });
      }

      const body = await request.json<Record<string, unknown>>();
      calls.push({ route, body });
      return Response.json({
        ok: true,
        entry: body,
        balance: { available: 0, locked: body.amount },
        snapshot: { pool: { unit: "usdc" } }
      });
    });

    await recordDotCastDevnetDeposit(
      jsonRequest("/api/dotcast/settlement-rail/deposits/devnet", {
        userId: "user-usdc-entry",
        amount: 1_000,
        txRef: "gateway-e6-deposit",
        confirmations: 1,
        now: "2099-06-25T17:00:00.000Z"
      }),
      env
    );
    const response = await placeDotCastPoolEntry(
      "pool-usdc-gateway",
      jsonRequest("/api/dotcast/pools/pool-usdc-gateway/entries", {
        userId: "user-usdc-entry",
        side: "yes",
        amount: 250,
        entryId: "entry-usdc-gateway",
        now: "2099-06-25T17:01:00.000Z"
      }),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ route: "GET /", body: null });
    expect(calls[1]?.route).toBe("POST /entries");
    expect(calls[1]?.body).toMatchObject({
      userId: "user-usdc-entry",
      amount: 250,
      entryId: "entry-usdc-gateway",
      settlementFunding: {
        rail: "solana-usdc-devnet",
        lockId: "dotcast:e6:pool-lock:pool-usdc-gateway:entry-usdc-gateway",
        reservedAmount: 250
      }
    });
    expect(body).toMatchObject({
      ok: true,
      settlementFunding: {
        milestone: "E6",
        status: "locked",
        balance: {
          availableUsdc: 750,
          lockedPoolUsdc: 250
        }
      }
    });
  });

  it("proxies settlement and admin void requests through the pool object", async () => {
    const calls: { route: string; body: Record<string, unknown> }[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true });
    });

    const settled = await settleDotCastPool(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/settle", {
        outcome: "yes",
        now: "2026-06-25T17:06:00.000Z"
      }),
      env
    );
    const voided = await voidDotCastPool(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/void", {
        reason: "ADMIN_VOID",
        now: "2026-06-25T17:07:00.000Z"
      }),
      env
    );

    expect(settled.status).toBe(200);
    expect(voided.status).toBe(200);
    expect(calls).toEqual([
      {
        route: "POST /settle",
        body: {
          outcome: "yes",
          now: "2026-06-25T17:06:00.000Z"
        }
      },
      {
        route: "POST /void",
        body: {
          reason: "ADMIN_VOID",
          now: "2026-06-25T17:07:00.000Z"
        }
      }
    ]);
  });

  it("proxies E2 router resolution intake through the pool object", async () => {
    const calls: { route: string; body: Record<string, unknown> }[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true, action: "settled" });
    });

    const response = await applyDotCastPoolResolution(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/resolution", {
        marketId: "kalshi:gateway",
        outcome: "yes",
        resolvedAt: "2026-06-25T17:06:00.000Z",
        fetchedAt: "2026-06-25T17:06:01.000Z",
        stale: false,
        source: "kalshi",
        now: "2026-06-25T17:06:01.000Z",
        maxGraceMs: 60000
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        route: "POST /resolution",
        body: {
          marketId: "kalshi:gateway",
          outcome: "yes",
          resolvedAt: "2026-06-25T17:06:00.000Z",
          fetchedAt: "2026-06-25T17:06:01.000Z",
          stale: false,
          source: "kalshi",
          now: "2026-06-25T17:06:01.000Z",
          maxGraceMs: 60000
        }
      }
    ]);
  });

  it("proxies E2 router polling through the pool object", async () => {
    const calls: { route: string; body: Record<string, unknown> }[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true, poll: { kind: "pending" } });
    });

    const response = await pollDotCastPoolResolution(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/poll-resolution", {
        now: "2026-06-25T17:06:01.000Z"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        route: "POST /poll-resolution",
        body: {
          now: "2026-06-25T17:06:01.000Z"
        }
      }
    ]);
  });

  it("reads E3 live odds and enriches them with router reference price", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(
        `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`
      );
      return Response.json({
        ok: true,
        liveOdds: {
          poolId: "pool-gateway",
          marketId: "kalshi:gateway",
          status: "open",
          unit: "points",
          odds: { yes: 0.7, no: 0.3 },
          pools: { yes: 700, no: 300 },
          totalStaked: 1000,
          entryCount: 2,
          updatedAt: "2026-06-25T17:02:00.000Z",
          previews: {
            yes: { "25": 34 },
            no: { "25": 76 }
          },
          hypothetical: {
            amount: 25,
            payout: { yes: 34, no: 76 }
          }
        },
        snapshot: {
          pool: {
            marketId: "kalshi:gateway"
          }
        }
      });
    }) as Env & {
      DOTCAST_ROUTER_REFERENCE_PRICE_URL: string;
      DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN: string;
    };
    env.DOTCAST_ROUTER_REFERENCE_PRICE_URL = "https://router.test/markets/{marketId}";
    env.DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN = "token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          market: {
            id: "kalshi:gateway",
            venue: "kalshi",
            price: { yes: 0.62, no: 0.41 },
            lastUpdated: "2026-06-25T17:02:01.000Z",
            stale: false,
            referenceUrl: "https://kalshi.example/markets/gateway"
          }
        })
      )
    );

    const response = await readDotCastPoolLiveOdds(
      "pool-gateway",
      new Request("https://api.test/api/dotcast/pools/pool-gateway/odds?amount=25"),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual(["GET /odds?amount=25"]);
    expect(body).toMatchObject({
      ok: true,
      liveOdds: {
        marketId: "kalshi:gateway",
        entryCount: 2,
        hypothetical: {
          amount: 25
        }
      },
      referencePrice: {
        available: true,
        kind: "reference",
        marketId: "kalshi:gateway",
        venue: "kalshi",
        price: { yes: 0.62, no: 0.41 },
        stale: false,
        referenceUrl: "https://kalshi.example/markets/gateway"
      }
    });
  });

  it("keeps E3 live odds available when router reference price is not configured", async () => {
    const env = envWithDotCastPool(async () =>
      Response.json({
        ok: true,
        liveOdds: {
          poolId: "pool-gateway",
          marketId: "kalshi:gateway",
          status: "open",
          unit: "points",
          odds: { yes: 0.5, no: 0.5 },
          pools: { yes: 0, no: 0 },
          totalStaked: 0,
          entryCount: 0,
          updatedAt: "2026-06-25T17:02:00.000Z",
          previews: { yes: {}, no: {} },
          hypothetical: null
        }
      })
    );

    const response = await readDotCastPoolLiveOdds(
      "pool-gateway",
      new Request("https://api.test/api/dotcast/pools/pool-gateway/odds"),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      referencePrice: {
        available: false,
        kind: "not_configured"
      }
    });
  });
});

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function envWithDotCastPool(handler: (request: Request) => Promise<Response> | Response): Env {
  return {
    DOTCAST_POOL: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: handler }) as unknown as DurableObjectStub
    } as unknown as DurableObjectNamespace
  } as Env;
}

function envWithDotCastPoolAndSettlementRail(
  handler: (request: Request) => Promise<Response> | Response
): Env {
  return {
    ...envWithSettlementRailDb(),
    DOTCAST_POOL: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: handler }) as unknown as DurableObjectStub
    } as unknown as DurableObjectNamespace
  } as Env;
}

function envWithDotCastLivestream(
  handler: (request: Request) => Promise<Response> | Response
): Env {
  return {
    DOTCAST_LIVESTREAM: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: handler }) as unknown as DurableObjectStub
    } as unknown as DurableObjectNamespace
  } as Env;
}

function envWithMuxLivestream(
  d1: FakeLivestreamD1,
  handler: (request: Request) => Promise<Response> | Response
): Env {
  return {
    TRADING_DB: d1 as unknown as D1Database,
    DOTCAST_LIVESTREAM: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: handler }) as unknown as DurableObjectStub
    } as unknown as DurableObjectNamespace,
    LIVESTREAM_PROVIDER: "mux",
    LIVESTREAM_CONTROL_LAYER: "livewire",
    MUX_TOKEN_ID: "mux-token-id",
    MUX_TOKEN_SECRET: "mux-token-secret",
    MUX_WEBHOOK_SECRET: "mux-webhook-secret",
    MUX_PLAYBACK_POLICY: "public",
    MUX_LOW_LATENCY: "true",
    MUX_RECORDING_ENABLED: "true",
    MUX_RECONNECT_WINDOW_SECONDS: "60"
  } as Env;
}

async function muxWebhookRequest(rawBody: string): Promise<Request> {
  return new Request("https://api.test/api/dotcast/livestreams/webhooks/mux", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mux-signature": await muxSignature(rawBody, "mux-webhook-secret")
    },
    body: rawBody
  });
}

async function muxSignature(rawBody: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `t=${timestamp},v1=${hex}`;
}

function envWithSettlementRailDb(): Env {
  const d1 = new FakeSettlementRailD1();

  return {
    TRADING_DB: d1 as unknown as D1Database,
    DOTCAST_SETTLEMENT_RAIL_MODE: "devnet",
    DOTCAST_SOLANA_CLUSTER: "devnet",
    DOTCAST_SETTLEMENT_SIGNER_MODE: "mock",
    DOTCAST_DEPOSIT_CONFIRMATIONS_REQUIRED: "1",
    DOTCAST_WITHDRAWAL_MAX_MINOR_UNITS: "1000000",
    DOTCAST_USDC_POOLS_ENABLED: "true"
  } as Env;
}

function livestreamRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stream_id: "stream-webhook",
    provider: "mux",
    control_layer: "livewire",
    mux_live_stream_id: "mux-live-1",
    playback_id: "mux-playback-1",
    playback_policy: "public",
    host_id: "host-1",
    title: "Webhook stream",
    status: "idle",
    mux_status: "idle",
    recording_asset_id: null,
    recording_playback_id: null,
    low_latency: 1,
    recording_enabled: 1,
    reconnect_window_seconds: 60,
    ingest_rtmp_url: "rtmp://global-live.mux.com:5222/app",
    created_at: "2099-06-25T17:00:00.000Z",
    updated_at: "2099-06-25T17:00:00.000Z",
    started_at: null,
    stopped_at: null,
    archived_at: null,
    last_webhook_event_id: null,
    metadata_json: "{}",
    ...overrides
  };
}

class FakeLivestreamD1 {
  readonly livestreams = new Map<string, Record<string, unknown>>();
  readonly events = new Map<string, Record<string, unknown>>();
  readonly poolLinks = new Map<string, Record<string, unknown>>();

  prepare(query: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async () => this.first(query, params),
        all: async () => ({ results: this.all(query, params) }),
        run: async () => {
          this.run(query, params);
          return { success: true };
        }
      })
    };
  }

  private first(query: string, params: unknown[]): Record<string, unknown> | null {
    if (query.includes("FROM dotcast_livestreams") && query.includes("WHERE stream_id = ?")) {
      return this.livestreams.get(String(params[0])) ?? null;
    }

    if (
      query.includes("FROM dotcast_livestreams") &&
      query.includes("WHERE mux_live_stream_id = ?")
    ) {
      return (
        [...this.livestreams.values()].find((record) => record.mux_live_stream_id === params[0]) ??
        null
      );
    }

    return null;
  }

  private all(query: string, params: unknown[]): Record<string, unknown>[] {
    if (query.includes("FROM dotcast_livestream_pool_links")) {
      return [...this.poolLinks.values()].filter((link) => link.stream_id === params[0]);
    }

    return [];
  }

  private run(query: string, params: unknown[]): void {
    if (query.includes("INSERT INTO dotcast_livestreams")) {
      this.livestreams.set(String(params[0]), {
        stream_id: params[0],
        provider: params[1],
        control_layer: params[2],
        mux_live_stream_id: params[3],
        playback_id: params[4],
        playback_policy: params[5],
        host_id: params[6],
        title: params[7],
        status: params[8],
        mux_status: params[9],
        recording_asset_id: params[10],
        recording_playback_id: params[11],
        low_latency: params[12],
        recording_enabled: params[13],
        reconnect_window_seconds: params[14],
        ingest_rtmp_url: params[15],
        created_at: params[16],
        updated_at: params[17],
        started_at: params[18],
        stopped_at: params[19],
        archived_at: params[20],
        last_webhook_event_id: params[21],
        metadata_json: params[22]
      });
      return;
    }

    if (query.includes("INSERT INTO dotcast_livestream_pool_links")) {
      this.poolLinks.set(`${String(params[0])}:${String(params[1])}`, {
        stream_id: params[0],
        pool_id: params[1],
        market_id: params[2],
        question: params[3],
        unit: params[4],
        status: params[5],
        pinned: params[6],
        attached_at: params[7],
        updated_at: params[8]
      });
      return;
    }

    if (query.includes("INSERT OR IGNORE INTO dotcast_livestream_events")) {
      if (!this.events.has(String(params[0]))) {
        this.events.set(String(params[0]), {
          event_id: params[0],
          stream_id: params[1],
          mux_live_stream_id: params[2],
          event_type: params[3],
          status: params[4],
          payload_json: params[5],
          created_at: params[6]
        });
      }
    }
  }
}

class FakeSettlementRailD1 {
  readonly balances = new Map<string, Record<string, unknown>>();
  readonly transfers = new Map<string, Record<string, unknown>>();
  readonly events = new Map<string, Record<string, unknown>>();
  readonly poolLocks = new Map<string, Record<string, unknown>>();
  readonly poolEvents = new Map<string, Record<string, unknown>>();

  prepare(query: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async () => this.first(query, params),
        all: async () => ({ results: this.all(query) }),
        run: async () => {
          this.run(query, params);
          return { success: true };
        }
      })
    };
  }

  private first(query: string, params: unknown[]): Record<string, unknown> | null {
    if (query.includes("FROM dotcast_settlement_balances")) {
      return this.balances.get(String(params[0])) ?? null;
    }

    if (query.includes("WHERE transfer_id = ?")) {
      return this.transfers.get(String(params[0])) ?? null;
    }

    if (query.includes("FROM dotcast_usdc_pool_locks")) {
      return this.poolLocks.get(String(params[0])) ?? null;
    }

    if (query.includes("WHERE tx_ref = ?")) {
      return (
        [...this.transfers.values()].find(
          (transfer) => transfer.kind === "deposit" && transfer.tx_ref === params[0]
        ) ?? null
      );
    }

    return null;
  }

  private all(query: string): Record<string, unknown>[] {
    if (query.includes("FROM dotcast_settlement_balances")) {
      return [...this.balances.values()];
    }

    return [];
  }

  private run(query: string, params: unknown[]): void {
    if (query.includes("INSERT INTO dotcast_settlement_balances")) {
      this.balances.set(String(params[0]), {
        user_id: params[0],
        available_usdc: params[1],
        pending_deposit_usdc: params[2],
        pending_withdrawal_usdc: params[3],
        locked_pool_usdc: params[4],
        updated_at: params[5]
      });
      return;
    }

    if (query.includes("INSERT INTO dotcast_settlement_transfers")) {
      this.transfers.set(String(params[0]), {
        transfer_id: params[0],
        user_id: params[1],
        kind: params[2],
        status: params[3],
        network: params[4],
        cluster: params[5],
        mint: params[6],
        amount: params[7],
        tx_ref: params[8],
        destination: params[9],
        signer_mode: params[10],
        mock_signature: params[11],
        requested_at: params[12],
        updated_at: params[13],
        event_json: params[14]
      });
      return;
    }

    if (query.includes("UPDATE dotcast_settlement_transfers")) {
      const transferId = String(params[7]);
      const existing = this.transfers.get(transferId) ?? {};
      this.transfers.set(transferId, {
        ...existing,
        status: params[0],
        tx_ref: params[1],
        destination: params[2],
        signer_mode: params[3],
        mock_signature: params[4],
        updated_at: params[5],
        event_json: params[6]
      });
      return;
    }

    if (query.includes("INSERT OR IGNORE INTO dotcast_settlement_rail_events")) {
      this.events.set(String(params[0]), {
        event_id: params[0],
        user_id: params[1],
        event_type: params[2],
        network: params[3],
        cluster: params[4],
        mint: params[5],
        amount: params[6],
        tx_ref: params[7],
        withdrawal_id: params[8],
        status: params[9],
        reason: params[10],
        event_json: params[11],
        created_at: params[12]
      });
      return;
    }

    if (query.includes("INSERT INTO dotcast_usdc_pool_locks")) {
      this.poolLocks.set(String(params[0]), {
        lock_id: params[0],
        pool_id: params[1],
        entry_id: params[2],
        user_id: params[3],
        amount: params[4],
        status: params[5],
        payout: params[6],
        created_at: params[7],
        updated_at: params[8],
        event_json: params[9]
      });
      return;
    }

    if (query.includes("UPDATE dotcast_usdc_pool_locks")) {
      const lockId = String(params[4]);
      const existing = this.poolLocks.get(lockId) ?? {};
      this.poolLocks.set(lockId, {
        ...existing,
        status: params[0],
        payout: params[1],
        updated_at: params[2],
        event_json: params[3]
      });
      return;
    }

    if (query.includes("INSERT OR IGNORE INTO dotcast_usdc_pool_events")) {
      this.poolEvents.set(String(params[0]), {
        event_id: params[0],
        lock_id: params[1],
        pool_id: params[2],
        entry_id: params[3],
        user_id: params[4],
        event_type: params[5],
        amount: params[6],
        payout: params[7],
        status: params[8],
        event_json: params[9],
        created_at: params[10]
      });
    }
  }
}

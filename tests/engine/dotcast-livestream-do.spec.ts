import { describe, expect, it } from "vitest";
import { DotCastLivestream } from "../../src/engine/dotcast";

const streamId = "stream-live-test";
const now = "2099-06-25T17:00:00.000Z";

describe("dotCast livestream durable object", () => {
  it("starts and reads a persistent livestream session", async () => {
    const object = createObject();
    const response = await object.fetch(
      jsonRequest("/start", {
        hostId: "host-1",
        title: "Orbital nails the next on-air call?",
        now
      })
    );
    const created = await jsonBody(response);

    expect(response.status).toBe(201);
    expect(created).toMatchObject({
      ok: true,
      created: true,
      livestream: {
        session: {
          id: streamId,
          hostId: "host-1",
          title: "Orbital nails the next on-air call?",
          status: "live",
          viewerCount: 0,
          poolCount: 0,
          startedAt: now
        },
        events: [{ id: 1, eventType: "STREAM_STARTED" }]
      }
    });

    const read = await jsonBody(await object.fetch(getRequest("/")));
    expect(read).toMatchObject({
      ok: true,
      livestream: {
        session: {
          id: streamId,
          status: "live"
        }
      }
    });
  });

  it("attaches pools, pins ordering, and changes the featured pool", async () => {
    const object = createObject();
    await startLivestream(object);

    await object.fetch(
      jsonRequest("/pools", {
        poolId: "pool-b",
        marketId: "polymarket:orbital-b",
        question: "Will Orbital get the next recap right?",
        unit: "points",
        status: "open",
        pinned: false,
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/pools", {
        poolId: "pool-a",
        marketId: "kalshi:orbital-a",
        question: "Will Orbital nail the next on-air call?",
        unit: "usdc",
        status: "open",
        pinned: true,
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    const featured = await jsonBody(
      await object.fetch(
        jsonRequest("/featured", {
          poolId: "pool-b",
          now: "2099-06-25T17:03:00.000Z"
        })
      )
    );

    expect(featured).toMatchObject({
      ok: true,
      featuredPoolId: "pool-b",
      livestream: {
        session: {
          featuredPoolId: "pool-b",
          poolCount: 2
        },
        pools: [
          { poolId: "pool-a", pinned: true, unit: "usdc" },
          { poolId: "pool-b", pinned: false, unit: "points" }
        ]
      }
    });
    expect(eventTypes(featured)).toEqual(
      expect.arrayContaining(["POOL_ATTACHED", "FEATURED_POOL_CHANGED"])
    );
  });

  it("records viewer presence and compacts stale heartbeats", async () => {
    const object = createObject();
    await startLivestream(object);

    await object.fetch(
      jsonRequest("/presence", {
        viewerId: "viewer-old",
        role: "viewer",
        now: "2099-06-25T17:00:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/presence", {
        viewerId: "viewer-active",
        role: "moderator",
        now: "2099-06-25T17:01:00.000Z"
      })
    );

    const liveRead = await jsonBody(
      await object.fetch(getRequest("/?now=2099-06-25T17:00:50.000Z"))
    );
    const compacted = await jsonBody(
      await object.fetch(getRequest("/?now=2099-06-25T17:01:45.000Z"))
    );

    expect(liveRead).toMatchObject({
      livestream: {
        session: { viewerCount: 2 }
      }
    });
    expect(compacted).toMatchObject({
      livestream: {
        session: { viewerCount: 1 },
        viewers: [{ viewerId: "viewer-active", role: "moderator" }]
      }
    });
  });

  it("pauses, resumes, ends, and blocks ended-stream mutations", async () => {
    const object = createObject();
    await startLivestream(object);

    const paused = await jsonBody(
      await object.fetch(jsonRequest("/pause", { now: "2099-06-25T17:02:00.000Z" }))
    );
    const resumed = await jsonBody(
      await object.fetch(jsonRequest("/resume", { now: "2099-06-25T17:03:00.000Z" }))
    );
    const ended = await jsonBody(
      await object.fetch(jsonRequest("/end", { now: "2099-06-25T17:04:00.000Z" }))
    );
    const mutation = await object.fetch(
      jsonRequest("/presence", {
        viewerId: "viewer-late",
        role: "viewer",
        now: "2099-06-25T17:05:00.000Z"
      })
    );

    expect(paused).toMatchObject({ livestream: { session: { status: "paused" } } });
    expect(resumed).toMatchObject({ livestream: { session: { status: "live" } } });
    expect(ended).toMatchObject({ livestream: { session: { status: "ended" } } });
    expect(mutation.status).toBe(400);
    expect(await jsonBody(mutation)).toMatchObject({
      ok: false,
      error: "ended livestreams cannot be mutated"
    });
  });

  it("serves cursor-based livestream events", async () => {
    const object = createObject();
    await startLivestream(object);
    await object.fetch(
      jsonRequest("/pools", {
        poolId: "pool-cursor",
        marketId: "kalshi:cursor",
        question: "Will the event cursor advance?",
        unit: "points",
        status: "open",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/presence", {
        viewerId: "viewer-cursor",
        role: "viewer",
        now: "2099-06-25T17:01:30.000Z"
      })
    );

    const response = await jsonBody(await object.fetch(getRequest("/events?after=1&limit=1")));

    expect(response).toMatchObject({
      ok: true,
      streamId,
      cursor: 2,
      latestEventId: 3,
      events: [{ id: 2, eventType: "POOL_ATTACHED", poolId: "pool-cursor" }]
    });
  });
});

function createObject() {
  return new DotCastLivestream(fakeState());
}

async function startLivestream(object: DotCastLivestream): Promise<void> {
  await object.fetch(
    jsonRequest("/start", {
      hostId: "host-1",
      title: "Orbital nails the next on-air call?",
      now
    })
  );
}

function fakeState(): DurableObjectState {
  const values = new Map<string, unknown>();

  return {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      }
    },
    blockConcurrencyWhile: async <T>(callback: () => T | Promise<T>) => callback()
  } as unknown as DurableObjectState;
}

function jsonRequest(pathname: string, body: unknown): Request {
  return new Request(`https://dotcast.livestream${withStreamId(pathname)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function getRequest(pathname: string): Request {
  return new Request(`https://dotcast.livestream${withStreamId(pathname)}`);
}

function withStreamId(pathname: string): string {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}streamId=${encodeURIComponent(streamId)}`;
}

async function jsonBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function eventTypes(body: Record<string, unknown>): string[] {
  const livestream = body.livestream as { events?: { eventType?: string }[] } | undefined;
  return livestream?.events?.map((event) => event.eventType ?? "") ?? [];
}

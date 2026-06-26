import { describe, expect, it } from "vitest";
import {
  completeDotCastRewardedStreamSession,
  readDotCastRewardedStreamStatus,
  readDotCastRewardedStreamUserSummary,
  startDotCastRewardedStreamSession,
  type DotCastGamificationProfile,
  type DotCastLivestreamMetadata,
  type DotCastRewardedStreamCompletionPlan,
  type DotCastRewardedStreamProgress,
  type DotCastRewardedStreamReward,
  type DotCastRewardedStreamSession,
  type FreeEntryCredit,
  type PointsLedgerEntry
} from "../../src/engine/dotcast";

describe("dotCast E9 rewarded-stream onramp", () => {
  it("reports readiness from config and database availability", () => {
    expect(readDotCastRewardedStreamStatus({}, true)).toMatchObject({
      enabled: true,
      ready: true,
      requiredCompletions: 3,
      pointsReward: 100,
      freeEntryReward: 1,
      startGraceSeconds: 120,
      finishGraceSeconds: 300,
      minWatchSeconds: 60,
      guards: []
    });
    expect(readDotCastRewardedStreamStatus({}, false)).toMatchObject({
      ready: false,
      guards: ["rewarded stream database not configured"]
    });
  });

  it("blocks sessions that miss the beginning of the livestream", async () => {
    await expect(
      startDotCastRewardedStreamSession(
        new InMemoryRewardedStreamStore(),
        {},
        {
          userId: "viewer-late",
          stream: livestream({ status: "live", startedAt: "2099-06-25T17:00:00.000Z" }),
          now: "2099-06-25T17:03:00.000Z"
        }
      )
    ).rejects.toMatchObject({
      name: "DotCastRewardedStreamError",
      code: "REWARDED_STREAM_START_WINDOW_MISSED",
      status: 409
    });
  });

  it("requires completion after the livestream finishes with enough watched seconds", async () => {
    const store = new InMemoryRewardedStreamStore();
    const started = await startDotCastRewardedStreamSession(
      store,
      {},
      {
        userId: "viewer-watch",
        stream: livestream({ status: "live", startedAt: "2099-06-25T17:00:00.000Z" }),
        now: "2099-06-25T17:00:15.000Z"
      }
    );

    await expect(
      completeDotCastRewardedStreamSession(
        store,
        {},
        {
          session: started.session,
          stream: livestream({ status: "live", startedAt: "2099-06-25T17:00:00.000Z" }),
          watchedSeconds: 120,
          now: "2099-06-25T17:02:00.000Z"
        }
      )
    ).rejects.toMatchObject({
      code: "REWARDED_STREAM_NOT_FINISHED",
      status: 409
    });

    await expect(
      completeDotCastRewardedStreamSession(
        store,
        {},
        {
          session: started.session,
          stream: livestream({
            status: "idle",
            startedAt: "2099-06-25T17:00:00.000Z",
            stoppedAt: "2099-06-25T17:02:00.000Z"
          }),
          watchedSeconds: 30,
          now: "2099-06-25T17:02:20.000Z"
        }
      )
    ).rejects.toMatchObject({
      code: "REWARDED_STREAM_WATCH_REQUIREMENT_NOT_MET",
      status: 409
    });
  });

  it("grants points and free entries after the preset number of completed streams", async () => {
    const store = new InMemoryRewardedStreamStore();
    const userId = "viewer-rewarded";

    for (let index = 1; index <= 3; index += 1) {
      const streamId = `stream-${index}`;
      const started = await startDotCastRewardedStreamSession(
        store,
        {},
        {
          userId,
          stream: livestream({
            streamId,
            status: "live",
            startedAt: `2099-06-25T17:0${index}:00.000Z`
          }),
          now: `2099-06-25T17:0${index}:20.000Z`
        }
      );
      const completed = await completeDotCastRewardedStreamSession(
        store,
        {},
        {
          session: started.session,
          stream: livestream({
            streamId,
            status: "idle",
            startedAt: `2099-06-25T17:0${index}:00.000Z`,
            stoppedAt: `2099-06-25T17:0${index + 1}:30.000Z`
          }),
          watchedSeconds: 90,
          now: `2099-06-25T17:0${index + 1}:45.000Z`
        }
      );

      expect(completed.session).toMatchObject({
        status: "completed",
        watchedSeconds: 90,
        requiredWatchSeconds: 60
      });
    }

    const summary = await readDotCastRewardedStreamUserSummary(
      store,
      {},
      userId,
      true,
      "2099-06-25T17:05:00.000Z"
    );
    const replaySession = await store.getSession(`dotcast:e9:session:stream-3:${userId}`);

    if (!replaySession) {
      throw new Error("expected completed rewarded-stream session to exist");
    }

    const replayed = await completeDotCastRewardedStreamSession(
      store,
      {},
      {
        session: replaySession,
        stream: livestream({
          streamId: "stream-3",
          status: "idle",
          startedAt: "2099-06-25T17:03:00.000Z",
          stoppedAt: "2099-06-25T17:04:30.000Z"
        }),
        watchedSeconds: 90,
        now: "2099-06-25T17:04:50.000Z"
      }
    );

    expect(summary.progress).toMatchObject({
      completedStreams: 3,
      cycleCompletedStreams: 0,
      rewardCycles: 1,
      pointsEarned: 100,
      freeEntriesEarned: 1
    });
    expect(store.profiles.get(userId)).toMatchObject({
      pointsBalance: 100,
      freeEntriesGranted: 1
    });
    expect([...store.ledger.values()]).toEqual([
      expect.objectContaining({
        userId,
        reason: "rewarded_stream",
        delta: 100
      })
    ]);
    expect([...store.freeEntries.values()]).toEqual([
      expect.objectContaining({
        userId,
        grantReason: "rewarded_stream",
        consumedAt: null
      })
    ]);
    expect(replayed).toMatchObject({
      idempotent: true,
      ledger: [],
      freeEntries: []
    });
    expect(replayed.reward).toMatchObject({
      userId,
      pointsGranted: 100,
      freeEntriesGranted: 1
    });
  });
});

class InMemoryRewardedStreamStore {
  readonly profiles = new Map<string, DotCastGamificationProfile>();
  readonly progress = new Map<string, DotCastRewardedStreamProgress>();
  readonly sessions = new Map<string, DotCastRewardedStreamSession>();
  readonly rewards = new Map<string, DotCastRewardedStreamReward>();
  readonly ledger = new Map<string, PointsLedgerEntry>();
  readonly freeEntries = new Map<string, FreeEntryCredit>();
  readonly events = new Map<string, unknown>();

  async getProfile(userId: string): Promise<DotCastGamificationProfile | null> {
    const profile = this.profiles.get(userId);
    return profile ? clone(profile) : null;
  }

  async getProgress(userId: string): Promise<DotCastRewardedStreamProgress | null> {
    const progress = this.progress.get(userId);
    return progress ? clone(progress) : null;
  }

  async getSession(sessionId: string): Promise<DotCastRewardedStreamSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  async getSessionByUserStream(
    userId: string,
    streamId: string
  ): Promise<DotCastRewardedStreamSession | null> {
    const session =
      [...this.sessions.values()].find(
        (candidate) => candidate.userId === userId && candidate.streamId === streamId
      ) ?? null;

    return session ? clone(session) : null;
  }

  async getRewardBySession(sessionId: string): Promise<DotCastRewardedStreamReward | null> {
    const reward =
      [...this.rewards.values()].find((candidate) => candidate.completedSessionId === sessionId) ??
      null;

    return reward ? clone(reward) : null;
  }

  async listSessions(userId: string, limit: number): Promise<DotCastRewardedStreamSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map(clone);
  }

  async listRewards(userId: string, limit: number): Promise<DotCastRewardedStreamReward[]> {
    return [...this.rewards.values()]
      .filter((reward) => reward.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async insertSession(session: DotCastRewardedStreamSession, event: { eventId: string }) {
    this.sessions.set(session.sessionId, clone(session));
    this.events.set(event.eventId, clone(event));
  }

  async applyCompletionPlan(plan: DotCastRewardedStreamCompletionPlan): Promise<void> {
    this.sessions.set(plan.session.sessionId, clone(plan.session));
    this.progress.set(plan.progress.userId, clone(plan.progress));

    if (plan.profile) {
      this.profiles.set(plan.profile.userId, clone(plan.profile));
    }

    if (plan.reward && !this.rewards.has(plan.reward.rewardId)) {
      this.rewards.set(plan.reward.rewardId, clone(plan.reward));
    }

    for (const entry of plan.ledger) {
      if (!this.ledger.has(entry.id)) {
        this.ledger.set(entry.id, clone(entry));
      }
    }

    for (const credit of plan.freeEntries) {
      if (!this.freeEntries.has(credit.id)) {
        this.freeEntries.set(credit.id, clone(credit));
      }
    }

    for (const event of plan.events) {
      this.events.set(event.eventId, clone(event));
    }
  }
}

function livestream(overrides: Partial<DotCastLivestreamMetadata> = {}): DotCastLivestreamMetadata {
  return {
    streamId: "stream-e9",
    provider: "mux",
    controlLayer: "livewire",
    muxLiveStreamId: "mux-live-e9",
    playbackId: "mux-playback-e9",
    playbackPolicy: "public",
    hostId: "host-e9",
    title: "E9 rewarded stream",
    status: "idle",
    muxStatus: "idle",
    recordingAssetId: null,
    recordingPlaybackId: null,
    lowLatency: true,
    recordingEnabled: true,
    reconnectWindowSeconds: 60,
    ingestRtmpUrl: "rtmp://global-live.mux.com:5222/app",
    createdAt: "2099-06-25T17:00:00.000Z",
    updatedAt: "2099-06-25T17:00:00.000Z",
    startedAt: null,
    stoppedAt: null,
    archivedAt: null,
    lastWebhookEventId: null,
    metadata: {},
    ...overrides
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

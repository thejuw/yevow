import type {
  DotCastGamificationProfile,
  DotCastLivestreamMetadata,
  DotCastRewardedStreamProgress,
  DotCastRewardedStreamReward,
  DotCastRewardedStreamSession,
  FreeEntryCredit,
  PointsLedgerEntry
} from "./types";

export interface DotCastRewardedStreamEnv {
  DOTCAST_REWARDED_STREAM_ENABLED?: string;
  DOTCAST_REWARDED_STREAM_REQUIRED_COMPLETIONS?: string;
  DOTCAST_REWARDED_STREAM_POINTS_REWARD?: string;
  DOTCAST_REWARDED_STREAM_FREE_ENTRY_REWARD?: string;
  DOTCAST_REWARDED_STREAM_START_GRACE_SECONDS?: string;
  DOTCAST_REWARDED_STREAM_FINISH_GRACE_SECONDS?: string;
  DOTCAST_REWARDED_STREAM_MIN_WATCH_SECONDS?: string;
}

export interface DotCastRewardedStreamStatus {
  enabled: boolean;
  ready: boolean;
  requiredCompletions: number;
  pointsReward: number;
  freeEntryReward: number;
  startGraceSeconds: number;
  finishGraceSeconds: number;
  minWatchSeconds: number;
  guards: string[];
}

export interface StartRewardedStreamInput {
  userId: string;
  stream: DotCastLivestreamMetadata;
  sessionId?: string;
  now?: string;
}

export interface CompleteRewardedStreamInput {
  session: DotCastRewardedStreamSession;
  stream: DotCastLivestreamMetadata;
  watchedSeconds?: number;
  now?: string;
}

export interface DotCastRewardedStreamStartResult {
  idempotent: boolean;
  session: DotCastRewardedStreamSession;
  status: DotCastRewardedStreamStatus;
}

export interface DotCastRewardedStreamCompletionResult {
  idempotent: boolean;
  session: DotCastRewardedStreamSession;
  progress: DotCastRewardedStreamProgress;
  profile: DotCastGamificationProfile | null;
  reward: DotCastRewardedStreamReward | null;
  ledger: PointsLedgerEntry[];
  freeEntries: FreeEntryCredit[];
  status: DotCastRewardedStreamStatus;
}

export interface DotCastRewardedStreamUserSummary {
  progress: DotCastRewardedStreamProgress;
  sessions: DotCastRewardedStreamSession[];
  rewards: DotCastRewardedStreamReward[];
  status: DotCastRewardedStreamStatus;
}

interface DotCastRewardedStreamEvent {
  eventId: string;
  userId: string;
  streamId: string;
  sessionId: string;
  eventType: "SESSION_STARTED" | "SESSION_COMPLETED" | "REWARD_GRANTED";
  rewardId: string | null;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface DotCastRewardedStreamCompletionPlan {
  session: DotCastRewardedStreamSession;
  progress: DotCastRewardedStreamProgress;
  profile: DotCastGamificationProfile | null;
  reward: DotCastRewardedStreamReward | null;
  ledger: PointsLedgerEntry[];
  freeEntries: FreeEntryCredit[];
  events: DotCastRewardedStreamEvent[];
}

export interface DotCastRewardedStreamStore {
  getProfile(userId: string): Promise<DotCastGamificationProfile | null>;
  getProgress(userId: string): Promise<DotCastRewardedStreamProgress | null>;
  getSession(sessionId: string): Promise<DotCastRewardedStreamSession | null>;
  getSessionByUserStream(
    userId: string,
    streamId: string
  ): Promise<DotCastRewardedStreamSession | null>;
  getRewardBySession(sessionId: string): Promise<DotCastRewardedStreamReward | null>;
  listSessions(userId: string, limit: number): Promise<DotCastRewardedStreamSession[]>;
  listRewards(userId: string, limit: number): Promise<DotCastRewardedStreamReward[]>;
  insertSession(
    session: DotCastRewardedStreamSession,
    event: DotCastRewardedStreamEvent
  ): Promise<void>;
  applyCompletionPlan(plan: DotCastRewardedStreamCompletionPlan): Promise<void>;
}

const DEFAULT_REQUIRED_COMPLETIONS = 3;
const DEFAULT_POINTS_REWARD = 100;
const DEFAULT_FREE_ENTRY_REWARD = 1;
const DEFAULT_START_GRACE_SECONDS = 120;
const DEFAULT_FINISH_GRACE_SECONDS = 300;
const DEFAULT_MIN_WATCH_SECONDS = 60;

type RewardedStreamRow = Record<string, unknown>;

export class DotCastRewardedStreamError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastRewardedStreamError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastRewardedStreamStore implements DotCastRewardedStreamStore {
  constructor(private readonly db: D1Database) {}

  async getProfile(userId: string): Promise<DotCastGamificationProfile | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, points_balance, current_streak, longest_streak,
                settled_predictions, correct_predictions, incorrect_predictions,
                free_entries_granted, free_entries_consumed, last_settled_pool_id,
                last_settled_at, updated_at
         FROM dotcast_gamification_profiles
         WHERE user_id = ?`
      )
      .bind(userId)
      .first<RewardedStreamRow>();

    return row ? profileFromRow(row) : null;
  }

  async getProgress(userId: string): Promise<DotCastRewardedStreamProgress | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, completed_streams, cycle_completed_streams, reward_cycles,
                points_earned, free_entries_earned, updated_at
         FROM dotcast_rewarded_stream_progress
         WHERE user_id = ?`
      )
      .bind(userId)
      .first<RewardedStreamRow>();

    return row ? progressFromRow(row) : null;
  }

  async getSession(sessionId: string): Promise<DotCastRewardedStreamSession | null> {
    const row = await this.db
      .prepare(sessionSelectSql("session_id = ?"))
      .bind(sessionId)
      .first<RewardedStreamRow>();

    return row ? sessionFromRow(row) : null;
  }

  async getSessionByUserStream(
    userId: string,
    streamId: string
  ): Promise<DotCastRewardedStreamSession | null> {
    const row = await this.db
      .prepare(sessionSelectSql("user_id = ? AND stream_id = ?"))
      .bind(userId, streamId)
      .first<RewardedStreamRow>();

    return row ? sessionFromRow(row) : null;
  }

  async getRewardBySession(sessionId: string): Promise<DotCastRewardedStreamReward | null> {
    const row = await this.db
      .prepare(
        `SELECT reward_id, user_id, cycle_number, completed_session_id, completed_streams,
                points_granted, free_entries_granted, idempotency_key, event_json, created_at
         FROM dotcast_rewarded_stream_rewards
         WHERE completed_session_id = ?`
      )
      .bind(sessionId)
      .first<RewardedStreamRow>();

    return row ? rewardFromRow(row) : null;
  }

  async listSessions(userId: string, limit: number): Promise<DotCastRewardedStreamSession[]> {
    const result = await this.db
      .prepare(`${sessionSelectSql("user_id = ?")} ORDER BY started_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<RewardedStreamRow>();

    return (result.results ?? []).map(sessionFromRow);
  }

  async listRewards(userId: string, limit: number): Promise<DotCastRewardedStreamReward[]> {
    const result = await this.db
      .prepare(
        `SELECT reward_id, user_id, cycle_number, completed_session_id, completed_streams,
                points_granted, free_entries_granted, idempotency_key, event_json, created_at
         FROM dotcast_rewarded_stream_rewards
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(userId, limit)
      .all<RewardedStreamRow>();

    return (result.results ?? []).map(rewardFromRow);
  }

  async insertSession(
    session: DotCastRewardedStreamSession,
    event: DotCastRewardedStreamEvent
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(sessionInsertSql()).bind(...sessionParams(session)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }

  async applyCompletionPlan(plan: DotCastRewardedStreamCompletionPlan): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(sessionUpdateSql()).bind(...sessionUpdateParams(plan.session)),
      this.db.prepare(progressUpsertSql()).bind(...progressParams(plan.progress))
    ];

    if (plan.profile) {
      statements.push(this.db.prepare(profileUpsertSql()).bind(...profileParams(plan.profile)));
    }

    if (plan.reward) {
      statements.push(this.db.prepare(rewardInsertSql()).bind(...rewardParams(plan.reward)));
    }

    for (const entry of plan.ledger) {
      statements.push(this.db.prepare(ledgerInsertSql()).bind(...ledgerParams(entry)));
    }

    for (const credit of plan.freeEntries) {
      statements.push(this.db.prepare(freeEntryInsertSql()).bind(...freeEntryParams(credit)));
    }

    for (const event of plan.events) {
      statements.push(this.db.prepare(eventInsertSql()).bind(...eventParams(event)));
    }

    await this.db.batch(statements);
  }
}

export function readDotCastRewardedStreamStatus(
  env: DotCastRewardedStreamEnv,
  hasDatabase = false
): DotCastRewardedStreamStatus {
  const enabled = env.DOTCAST_REWARDED_STREAM_ENABLED !== "false";
  const requiredCompletions = parsePositiveInt(
    env.DOTCAST_REWARDED_STREAM_REQUIRED_COMPLETIONS,
    DEFAULT_REQUIRED_COMPLETIONS,
    "DOTCAST_REWARDED_STREAM_REQUIRED_COMPLETIONS"
  );
  const pointsReward = parseNonNegativeInt(
    env.DOTCAST_REWARDED_STREAM_POINTS_REWARD,
    DEFAULT_POINTS_REWARD,
    "DOTCAST_REWARDED_STREAM_POINTS_REWARD"
  );
  const freeEntryReward = parseNonNegativeInt(
    env.DOTCAST_REWARDED_STREAM_FREE_ENTRY_REWARD,
    DEFAULT_FREE_ENTRY_REWARD,
    "DOTCAST_REWARDED_STREAM_FREE_ENTRY_REWARD"
  );
  const startGraceSeconds = parseNonNegativeInt(
    env.DOTCAST_REWARDED_STREAM_START_GRACE_SECONDS,
    DEFAULT_START_GRACE_SECONDS,
    "DOTCAST_REWARDED_STREAM_START_GRACE_SECONDS"
  );
  const finishGraceSeconds = parseNonNegativeInt(
    env.DOTCAST_REWARDED_STREAM_FINISH_GRACE_SECONDS,
    DEFAULT_FINISH_GRACE_SECONDS,
    "DOTCAST_REWARDED_STREAM_FINISH_GRACE_SECONDS"
  );
  const minWatchSeconds = parseNonNegativeInt(
    env.DOTCAST_REWARDED_STREAM_MIN_WATCH_SECONDS,
    DEFAULT_MIN_WATCH_SECONDS,
    "DOTCAST_REWARDED_STREAM_MIN_WATCH_SECONDS"
  );
  const guards: string[] = [];

  if (!enabled) {
    guards.push("rewarded stream onramp disabled");
  }

  if (!hasDatabase) {
    guards.push("rewarded stream database not configured");
  }

  if (pointsReward === 0 && freeEntryReward === 0) {
    guards.push("rewarded stream reward grants neither points nor free entries");
  }

  return {
    enabled,
    ready: enabled && hasDatabase && guards.length === 0,
    requiredCompletions,
    pointsReward,
    freeEntryReward,
    startGraceSeconds,
    finishGraceSeconds,
    minWatchSeconds,
    guards
  };
}

export async function startDotCastRewardedStreamSession(
  store: DotCastRewardedStreamStore,
  env: DotCastRewardedStreamEnv,
  input: StartRewardedStreamInput,
  hasDatabase = true
): Promise<DotCastRewardedStreamStartResult> {
  const status = assertRewardedStreamReady(env, hasDatabase);
  const userId = requireText(input.userId, "userId");
  const now = input.now ?? new Date().toISOString();
  const stream = input.stream;
  const existing = await store.getSessionByUserStream(userId, stream.streamId);

  if (existing) {
    return { idempotent: true, session: existing, status };
  }

  assertStartEligible(stream, now, status);

  const session: DotCastRewardedStreamSession = {
    sessionId: input.sessionId ?? `dotcast:e9:session:${stream.streamId}:${userId}`,
    userId,
    streamId: stream.streamId,
    status: "started",
    startedAt: now,
    completedAt: null,
    watchedSeconds: 0,
    requiredWatchSeconds: status.minWatchSeconds,
    streamStartedAt: stream.startedAt ?? now,
    streamStoppedAt: null,
    rewardId: null,
    eventJson: {
      streamTitle: stream.title,
      hostId: stream.hostId,
      muxLiveStreamId: stream.muxLiveStreamId,
      source: "rewarded_stream"
    }
  };
  const event = buildRewardedStreamEvent("SESSION_STARTED", session, null, now, session.eventJson);

  await store.insertSession(session, event);
  return { idempotent: false, session, status };
}

export async function completeDotCastRewardedStreamSession(
  store: DotCastRewardedStreamStore,
  env: DotCastRewardedStreamEnv,
  input: CompleteRewardedStreamInput,
  hasDatabase = true
): Promise<DotCastRewardedStreamCompletionResult> {
  const status = assertRewardedStreamReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const session = input.session;

  if (session.status === "completed") {
    return {
      idempotent: true,
      session,
      progress: (await store.getProgress(session.userId)) ?? emptyProgress(session.userId, now),
      profile: await store.getProfile(session.userId),
      reward: await store.getRewardBySession(session.sessionId),
      ledger: [],
      freeEntries: [],
      status
    };
  }

  if (session.status !== "started") {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_SESSION_NOT_ACTIVE",
      "rewarded stream session is not active",
      409
    );
  }

  const streamStoppedAt = input.stream.stoppedAt ?? input.stream.archivedAt;
  if (!streamStoppedAt || input.stream.status === "live") {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_NOT_FINISHED",
      "rewarded stream can only complete after the livestream finishes",
      409
    );
  }

  if (input.stream.streamId !== session.streamId) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_MISMATCH",
      "rewarded stream session does not belong to this livestream",
      409
    );
  }

  const requiredWatchSeconds = requiredWatchSecondsForSession(session, streamStoppedAt, status);
  const watchedSeconds =
    input.watchedSeconds ??
    Math.max(0, Math.floor((Date.parse(streamStoppedAt) - Date.parse(session.startedAt)) / 1000));

  assertCompletionEligible(
    session,
    now,
    streamStoppedAt,
    watchedSeconds,
    requiredWatchSeconds,
    status
  );

  const currentProgress =
    (await store.getProgress(session.userId)) ?? emptyProgress(session.userId, now);
  const nextCompletedStreams = currentProgress.completedStreams + 1;
  const nextCycleCompletedStreams = currentProgress.cycleCompletedStreams + 1;
  const rewardEarned = nextCycleCompletedStreams >= status.requiredCompletions;
  const nextRewardCycles = currentProgress.rewardCycles + (rewardEarned ? 1 : 0);
  const nextProgress: DotCastRewardedStreamProgress = {
    userId: session.userId,
    completedStreams: nextCompletedStreams,
    cycleCompletedStreams: rewardEarned ? 0 : nextCycleCompletedStreams,
    rewardCycles: nextRewardCycles,
    pointsEarned: currentProgress.pointsEarned + (rewardEarned ? status.pointsReward : 0),
    freeEntriesEarned:
      currentProgress.freeEntriesEarned + (rewardEarned ? status.freeEntryReward : 0),
    updatedAt: now
  };
  const rewardId = rewardEarned ? `dotcast:e9:reward:${session.userId}:${nextRewardCycles}` : null;
  const completedSession: DotCastRewardedStreamSession = {
    ...session,
    status: "completed",
    completedAt: now,
    watchedSeconds,
    requiredWatchSeconds,
    streamStoppedAt,
    rewardId
  };
  const completionEvent = buildRewardedStreamEvent(
    "SESSION_COMPLETED",
    completedSession,
    rewardId,
    now,
    {
      watchedSeconds,
      requiredWatchSeconds,
      streamStoppedAt,
      rewardEarned
    }
  );

  let profile: DotCastGamificationProfile | null = null;
  let reward: DotCastRewardedStreamReward | null = null;
  const ledger: PointsLedgerEntry[] = [];
  const freeEntries: FreeEntryCredit[] = [];
  const events: DotCastRewardedStreamEvent[] = [completionEvent];

  if (rewardEarned && rewardId) {
    const currentProfile =
      (await store.getProfile(session.userId)) ?? emptyProfile(session.userId, now);
    profile = {
      ...currentProfile,
      pointsBalance: currentProfile.pointsBalance + status.pointsReward,
      freeEntriesGranted: currentProfile.freeEntriesGranted + status.freeEntryReward,
      updatedAt: now
    };
    reward = {
      rewardId,
      userId: session.userId,
      cycleNumber: nextRewardCycles,
      completedSessionId: session.sessionId,
      completedStreams: nextCompletedStreams,
      pointsGranted: status.pointsReward,
      freeEntriesGranted: status.freeEntryReward,
      idempotencyKey: `dotcast:e9:reward:${session.sessionId}`,
      eventJson: {
        source: "rewarded_stream",
        requiredCompletions: status.requiredCompletions,
        streamId: session.streamId
      },
      createdAt: now
    };

    if (status.pointsReward > 0) {
      ledger.push({
        id: `dotcast:e9:points:${rewardId}`,
        userId: session.userId,
        delta: status.pointsReward,
        reason: "rewarded_stream",
        poolId: null,
        entryId: session.sessionId,
        createdAt: now,
        balanceAfter: profile.pointsBalance,
        eventJson: reward.eventJson
      });
    }

    for (let index = 0; index < status.freeEntryReward; index += 1) {
      freeEntries.push({
        id: `dotcast:e9:free-entry:${rewardId}:${index + 1}`,
        userId: session.userId,
        grantReason: "rewarded_stream",
        poolId: null,
        grantedAt: now,
        expiresAt: null,
        consumedAt: null,
        consumedByEntryId: null,
        eventJson: reward.eventJson
      });
    }

    events.push(
      buildRewardedStreamEvent("REWARD_GRANTED", completedSession, rewardId, now, reward.eventJson)
    );
  }

  await store.applyCompletionPlan({
    session: completedSession,
    progress: nextProgress,
    profile,
    reward,
    ledger,
    freeEntries,
    events
  });

  return {
    idempotent: false,
    session: completedSession,
    progress: nextProgress,
    profile,
    reward,
    ledger,
    freeEntries,
    status
  };
}

export async function readDotCastRewardedStreamUserSummary(
  store: DotCastRewardedStreamStore,
  env: DotCastRewardedStreamEnv,
  userId: string,
  hasDatabase = true,
  now = new Date().toISOString()
): Promise<DotCastRewardedStreamUserSummary> {
  const status = assertRewardedStreamReady(env, hasDatabase);
  const [progress, sessions, rewards] = await Promise.all([
    store.getProgress(userId),
    store.listSessions(userId, 25),
    store.listRewards(userId, 25)
  ]);

  return {
    progress: progress ?? emptyProgress(userId, now),
    sessions,
    rewards,
    status
  };
}

function assertRewardedStreamReady(
  env: DotCastRewardedStreamEnv,
  hasDatabase: boolean
): DotCastRewardedStreamStatus {
  const status = readDotCastRewardedStreamStatus(env, hasDatabase);

  if (!status.ready) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_NOT_READY",
      status.guards.join("; ") || "E9 rewarded stream onramp is not ready",
      503
    );
  }

  return status;
}

function assertStartEligible(
  stream: DotCastLivestreamMetadata,
  now: string,
  status: DotCastRewardedStreamStatus
): void {
  if (stream.status !== "live" || !stream.startedAt) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_NOT_LIVE",
      "rewarded stream sessions must start while the livestream is live",
      409
    );
  }

  const startedMs = requireTimestamp(stream.startedAt, "stream.startedAt");
  const nowMs = requireTimestamp(now, "now");

  if (nowMs < startedMs) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_NOT_STARTED",
      "rewarded stream cannot start before the livestream starts",
      409
    );
  }

  if (nowMs - startedMs > status.startGraceSeconds * 1000) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_START_WINDOW_MISSED",
      "rewarded stream session must start near the beginning of the livestream",
      409
    );
  }
}

function assertCompletionEligible(
  session: DotCastRewardedStreamSession,
  now: string,
  streamStoppedAt: string,
  watchedSeconds: number,
  requiredWatchSeconds: number,
  status: DotCastRewardedStreamStatus
): void {
  const nowMs = requireTimestamp(now, "now");
  const stoppedMs = requireTimestamp(streamStoppedAt, "streamStoppedAt");

  if (nowMs < stoppedMs) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_COMPLETED_BEFORE_FINISH",
      "rewarded stream completion cannot be recorded before the livestream finishes",
      409
    );
  }

  if (nowMs - stoppedMs > status.finishGraceSeconds * 1000) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_FINISH_WINDOW_MISSED",
      "rewarded stream completion must be recorded near livestream finish",
      409
    );
  }

  if (!Number.isSafeInteger(watchedSeconds) || watchedSeconds < requiredWatchSeconds) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_WATCH_REQUIREMENT_NOT_MET",
      `rewarded stream requires at least ${requiredWatchSeconds} watched seconds`,
      409
    );
  }

  if (session.streamStoppedAt && session.streamStoppedAt !== streamStoppedAt) {
    throw new DotCastRewardedStreamError(
      "REWARDED_STREAM_STOP_CONFLICT",
      "rewarded stream stop timestamp changed after completion",
      409
    );
  }
}

function requiredWatchSecondsForSession(
  session: DotCastRewardedStreamSession,
  streamStoppedAt: string,
  status: DotCastRewardedStreamStatus
): number {
  const durationSeconds = Math.max(
    0,
    Math.floor(
      (requireTimestamp(streamStoppedAt, "streamStoppedAt") -
        requireTimestamp(session.streamStartedAt, "session.streamStartedAt")) /
        1000
    )
  );

  return Math.max(status.minWatchSeconds, durationSeconds - status.finishGraceSeconds);
}

function emptyProgress(userId: string, now: string): DotCastRewardedStreamProgress {
  return {
    userId,
    completedStreams: 0,
    cycleCompletedStreams: 0,
    rewardCycles: 0,
    pointsEarned: 0,
    freeEntriesEarned: 0,
    updatedAt: now
  };
}

function emptyProfile(userId: string, now: string): DotCastGamificationProfile {
  return {
    userId,
    pointsBalance: 0,
    currentStreak: 0,
    longestStreak: 0,
    settledPredictions: 0,
    correctPredictions: 0,
    incorrectPredictions: 0,
    freeEntriesGranted: 0,
    freeEntriesConsumed: 0,
    lastSettledPoolId: null,
    lastSettledAt: null,
    updatedAt: now
  };
}

function buildRewardedStreamEvent(
  eventType: DotCastRewardedStreamEvent["eventType"],
  session: DotCastRewardedStreamSession,
  rewardId: string | null,
  now: string,
  eventJson: Record<string, unknown>
): DotCastRewardedStreamEvent {
  return {
    eventId: `dotcast:e9:event:${session.sessionId}:${eventType}:${Date.parse(now)}`,
    userId: session.userId,
    streamId: session.streamId,
    sessionId: session.sessionId,
    eventType,
    rewardId,
    eventJson,
    createdAt: now
  };
}

function sessionSelectSql(where: string): string {
  return `SELECT session_id, user_id, stream_id, status, started_at, completed_at,
                 watched_seconds, required_watch_seconds, stream_started_at, stream_stopped_at,
                 reward_id, event_json
          FROM dotcast_rewarded_stream_sessions
          WHERE ${where}`;
}

function sessionInsertSql(): string {
  return `INSERT INTO dotcast_rewarded_stream_sessions (
            session_id, user_id, stream_id, status, started_at, completed_at, watched_seconds,
            required_watch_seconds, stream_started_at, stream_stopped_at, reward_id, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function sessionUpdateSql(): string {
  return `UPDATE dotcast_rewarded_stream_sessions
          SET status = ?, completed_at = ?, watched_seconds = ?, required_watch_seconds = ?,
              stream_stopped_at = ?, reward_id = ?, event_json = ?
          WHERE session_id = ?`;
}

function progressUpsertSql(): string {
  return `INSERT INTO dotcast_rewarded_stream_progress (
            user_id, completed_streams, cycle_completed_streams, reward_cycles, points_earned,
            free_entries_earned, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            completed_streams = excluded.completed_streams,
            cycle_completed_streams = excluded.cycle_completed_streams,
            reward_cycles = excluded.reward_cycles,
            points_earned = excluded.points_earned,
            free_entries_earned = excluded.free_entries_earned,
            updated_at = excluded.updated_at`;
}

function profileUpsertSql(): string {
  return `INSERT INTO dotcast_gamification_profiles (
            user_id, points_balance, current_streak, longest_streak,
            settled_predictions, correct_predictions, incorrect_predictions,
            free_entries_granted, free_entries_consumed, last_settled_pool_id,
            last_settled_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            points_balance = excluded.points_balance,
            current_streak = excluded.current_streak,
            longest_streak = excluded.longest_streak,
            settled_predictions = excluded.settled_predictions,
            correct_predictions = excluded.correct_predictions,
            incorrect_predictions = excluded.incorrect_predictions,
            free_entries_granted = excluded.free_entries_granted,
            free_entries_consumed = excluded.free_entries_consumed,
            last_settled_pool_id = excluded.last_settled_pool_id,
            last_settled_at = excluded.last_settled_at,
            updated_at = excluded.updated_at`;
}

function rewardInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_rewarded_stream_rewards (
            reward_id, user_id, cycle_number, completed_session_id, completed_streams,
            points_granted, free_entries_granted, idempotency_key, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function ledgerInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_points_ledger (
            ledger_id, user_id, delta, reason, pool_id, entry_id, balance_after,
            event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function freeEntryInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_free_entry_credits (
            credit_id, user_id, grant_reason, pool_id, granted_at, expires_at,
            consumed_at, consumed_by_entry_id, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function eventInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_rewarded_stream_events (
            event_id, user_id, stream_id, session_id, event_type, reward_id, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
}

function sessionParams(session: DotCastRewardedStreamSession): unknown[] {
  return [
    session.sessionId,
    session.userId,
    session.streamId,
    session.status,
    session.startedAt,
    session.completedAt,
    session.watchedSeconds,
    session.requiredWatchSeconds,
    session.streamStartedAt,
    session.streamStoppedAt,
    session.rewardId,
    JSON.stringify(session.eventJson)
  ];
}

function sessionUpdateParams(session: DotCastRewardedStreamSession): unknown[] {
  return [
    session.status,
    session.completedAt,
    session.watchedSeconds,
    session.requiredWatchSeconds,
    session.streamStoppedAt,
    session.rewardId,
    JSON.stringify(session.eventJson),
    session.sessionId
  ];
}

function progressParams(progress: DotCastRewardedStreamProgress): unknown[] {
  return [
    progress.userId,
    progress.completedStreams,
    progress.cycleCompletedStreams,
    progress.rewardCycles,
    progress.pointsEarned,
    progress.freeEntriesEarned,
    progress.updatedAt
  ];
}

function profileParams(profile: DotCastGamificationProfile): unknown[] {
  return [
    profile.userId,
    profile.pointsBalance,
    profile.currentStreak,
    profile.longestStreak,
    profile.settledPredictions,
    profile.correctPredictions,
    profile.incorrectPredictions,
    profile.freeEntriesGranted,
    profile.freeEntriesConsumed,
    profile.lastSettledPoolId,
    profile.lastSettledAt,
    profile.updatedAt
  ];
}

function rewardParams(reward: DotCastRewardedStreamReward): unknown[] {
  return [
    reward.rewardId,
    reward.userId,
    reward.cycleNumber,
    reward.completedSessionId,
    reward.completedStreams,
    reward.pointsGranted,
    reward.freeEntriesGranted,
    reward.idempotencyKey,
    JSON.stringify(reward.eventJson),
    reward.createdAt
  ];
}

function ledgerParams(entry: PointsLedgerEntry): unknown[] {
  return [
    entry.id,
    entry.userId,
    entry.delta,
    entry.reason,
    entry.poolId,
    entry.entryId,
    entry.balanceAfter,
    JSON.stringify(entry.eventJson),
    entry.createdAt
  ];
}

function freeEntryParams(credit: FreeEntryCredit): unknown[] {
  return [
    credit.id,
    credit.userId,
    credit.grantReason,
    credit.poolId,
    credit.grantedAt,
    credit.expiresAt,
    credit.consumedAt,
    credit.consumedByEntryId,
    JSON.stringify(credit.eventJson)
  ];
}

function eventParams(event: DotCastRewardedStreamEvent): unknown[] {
  return [
    event.eventId,
    event.userId,
    event.streamId,
    event.sessionId,
    event.eventType,
    event.rewardId,
    JSON.stringify(event.eventJson),
    event.createdAt
  ];
}

function profileFromRow(row: RewardedStreamRow): DotCastGamificationProfile {
  return {
    userId: requireText(row.user_id, "user_id"),
    pointsBalance: requireInt(row.points_balance, "points_balance"),
    currentStreak: requireInt(row.current_streak, "current_streak"),
    longestStreak: requireInt(row.longest_streak, "longest_streak"),
    settledPredictions: requireInt(row.settled_predictions, "settled_predictions"),
    correctPredictions: requireInt(row.correct_predictions, "correct_predictions"),
    incorrectPredictions: requireInt(row.incorrect_predictions, "incorrect_predictions"),
    freeEntriesGranted: requireInt(row.free_entries_granted, "free_entries_granted"),
    freeEntriesConsumed: requireInt(row.free_entries_consumed, "free_entries_consumed"),
    lastSettledPoolId: nullableText(row.last_settled_pool_id),
    lastSettledAt: nullableText(row.last_settled_at),
    updatedAt: requireText(row.updated_at, "updated_at")
  };
}

function progressFromRow(row: RewardedStreamRow): DotCastRewardedStreamProgress {
  return {
    userId: requireText(row.user_id, "user_id"),
    completedStreams: requireInt(row.completed_streams, "completed_streams"),
    cycleCompletedStreams: requireInt(row.cycle_completed_streams, "cycle_completed_streams"),
    rewardCycles: requireInt(row.reward_cycles, "reward_cycles"),
    pointsEarned: requireInt(row.points_earned, "points_earned"),
    freeEntriesEarned: requireInt(row.free_entries_earned, "free_entries_earned"),
    updatedAt: requireText(row.updated_at, "updated_at")
  };
}

function sessionFromRow(row: RewardedStreamRow): DotCastRewardedStreamSession {
  return {
    sessionId: requireText(row.session_id, "session_id"),
    userId: requireText(row.user_id, "user_id"),
    streamId: requireText(row.stream_id, "stream_id"),
    status: parseSessionStatus(row.status),
    startedAt: requireText(row.started_at, "started_at"),
    completedAt: nullableText(row.completed_at),
    watchedSeconds: requireInt(row.watched_seconds, "watched_seconds"),
    requiredWatchSeconds: requireInt(row.required_watch_seconds, "required_watch_seconds"),
    streamStartedAt: requireText(row.stream_started_at, "stream_started_at"),
    streamStoppedAt: nullableText(row.stream_stopped_at),
    rewardId: nullableText(row.reward_id),
    eventJson: parseJsonObject(row.event_json)
  };
}

function rewardFromRow(row: RewardedStreamRow): DotCastRewardedStreamReward {
  return {
    rewardId: requireText(row.reward_id, "reward_id"),
    userId: requireText(row.user_id, "user_id"),
    cycleNumber: requireInt(row.cycle_number, "cycle_number"),
    completedSessionId: requireText(row.completed_session_id, "completed_session_id"),
    completedStreams: requireInt(row.completed_streams, "completed_streams"),
    pointsGranted: requireInt(row.points_granted, "points_granted"),
    freeEntriesGranted: requireInt(row.free_entries_granted, "free_entries_granted"),
    idempotencyKey: requireText(row.idempotency_key, "idempotency_key"),
    eventJson: parseJsonObject(row.event_json),
    createdAt: requireText(row.created_at, "created_at")
  };
}

function parseSessionStatus(value: unknown): DotCastRewardedStreamSession["status"] {
  if (value === "started" || value === "completed" || value === "invalidated") {
    return value;
  }

  throw new DotCastRewardedStreamError(
    "INVALID_REWARDED_STREAM_ROW",
    "invalid rewarded stream session status",
    500
  );
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed <= 0) {
    throw new DotCastRewardedStreamError(
      "INVALID_REWARDED_STREAM_CONFIG",
      `${label} must be positive`,
      500
    );
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed < 0) {
    throw new DotCastRewardedStreamError(
      "INVALID_REWARDED_STREAM_CONFIG",
      `${label} must be non-negative`,
      500
    );
  }

  return parsed;
}

function parseOptionalInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new DotCastRewardedStreamError(
      "INVALID_REWARDED_STREAM_CONFIG",
      `${label} must be a safe integer`,
      500
    );
  }

  return parsed;
}

function requireTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new DotCastRewardedStreamError(
      "INVALID_REWARDED_STREAM_TIMESTAMP",
      `${label} must be an ISO timestamp`,
      400
    );
  }

  return parsed;
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastRewardedStreamError("INVALID_REWARDED_STREAM_ROW", `${label} is required`, 500);
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireInt(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  throw new DotCastRewardedStreamError(
    "INVALID_REWARDED_STREAM_ROW",
    `${label} must be a safe integer`,
    500
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

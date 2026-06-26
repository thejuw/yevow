import type {
  DotCastLivestreamControlLayer,
  DotCastLivestreamMetadata,
  DotCastLivestreamMetadataEvent,
  DotCastLivestreamMetadataStatus,
  DotCastLivestreamPoolLink,
  DotCastLivestreamProvider,
  DotCastMuxPlaybackPolicy,
  PoolStatus,
  StakeUnit
} from "./types";

export const DOTCAST_MUX_RTMP_URL = "rtmp://global-live.mux.com:5222/app";
export const DOTCAST_MUX_PLAYBACK_BASE_URL = "https://stream.mux.com";

const MUX_API_BASE_URL = "https://api.mux.com/video/v1";
const DEFAULT_RECONNECT_WINDOW_SECONDS = 60;
const DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS = 15 * 60;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface DotCastMuxLivestreamEnv {
  MUX_TOKEN_ID?: string;
  MUX_TOKEN_SECRET?: string;
  MUX_WEBHOOK_SECRET?: string;
  MUX_PLAYBACK_POLICY?: string;
  MUX_LOW_LATENCY?: string;
  MUX_RECORDING_ENABLED?: string;
  MUX_RECONNECT_WINDOW_SECONDS?: string;
  MUX_SIGNING_KEY_ID?: string;
  MUX_SIGNING_PRIVATE_KEY?: string;
  MUX_PLAYBACK_TOKEN_TTL_SECONDS?: string;
  LIVESTREAM_PROVIDER?: string;
  LIVESTREAM_CONTROL_LAYER?: string;
}

export interface DotCastMuxLivestreamConfig {
  provider: DotCastLivestreamProvider;
  controlLayer: DotCastLivestreamControlLayer;
  ready: boolean;
  playbackPolicy: DotCastMuxPlaybackPolicy;
  lowLatency: boolean;
  recordingEnabled: boolean;
  reconnectWindowSeconds: number;
  tokenConfigured: boolean;
  guards: string[];
}

export interface DotCastCreateMuxLivestreamInput {
  streamId: string;
  passthrough?: string;
  metadata?: Record<string, unknown>;
}

export interface DotCastMuxPlaybackDescriptor {
  playbackId: string;
  playbackPolicy: DotCastMuxPlaybackPolicy;
  playbackUrl: string;
  token: string | null;
  tokenExpiresAt: string | null;
}

export interface DotCastMuxLiveStreamData {
  id: string;
  streamKey: string;
  status: string;
  playbackId: string;
  playbackPolicy: DotCastMuxPlaybackPolicy;
  reconnectWindowSeconds: number;
  createdAt: string;
  raw: Record<string, unknown>;
}

export interface DotCastMuxWebhookEvent {
  eventId: string;
  eventType: string;
  muxLiveStreamId: string | null;
  recordingAssetId: string | null;
  recordingPlaybackId: string | null;
  metadataStatus: DotCastLivestreamMetadataStatus | null;
  muxStatus: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface MuxCreateLiveStreamResponse {
  data?: Record<string, unknown>;
}

interface D1LivestreamRow {
  stream_id: string;
  provider: string;
  control_layer: string;
  mux_live_stream_id: string;
  playback_id: string;
  playback_policy: string;
  host_id: string;
  title: string;
  status: string;
  mux_status: string;
  recording_asset_id: string | null;
  recording_playback_id: string | null;
  low_latency: number;
  recording_enabled: number;
  reconnect_window_seconds: number;
  ingest_rtmp_url: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  stopped_at: string | null;
  archived_at: string | null;
  last_webhook_event_id: string | null;
  metadata_json: string;
}

interface D1PoolLinkRow {
  stream_id: string;
  pool_id: string;
  market_id: string;
  question: string;
  unit: string;
  status: string;
  pinned: number;
  attached_at: string;
  updated_at: string;
}

export class DotCastLivestreamError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastLivestreamError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastLivestreamStore {
  constructor(private readonly db: D1Database) {}

  async getLivestream(streamId: string): Promise<DotCastLivestreamMetadata | null> {
    const row = await this.db
      .prepare(
        `SELECT stream_id, provider, control_layer, mux_live_stream_id, playback_id,
                playback_policy, host_id, title, status, mux_status, recording_asset_id,
                recording_playback_id, low_latency, recording_enabled, reconnect_window_seconds,
                ingest_rtmp_url, created_at, updated_at, started_at, stopped_at, archived_at,
                last_webhook_event_id, metadata_json
         FROM dotcast_livestreams
         WHERE stream_id = ?`
      )
      .bind(streamId)
      .first();

    return row ? livestreamFromRow(row as unknown as D1LivestreamRow) : null;
  }

  async getLivestreamByMuxId(muxLiveStreamId: string): Promise<DotCastLivestreamMetadata | null> {
    const row = await this.db
      .prepare(
        `SELECT stream_id, provider, control_layer, mux_live_stream_id, playback_id,
                playback_policy, host_id, title, status, mux_status, recording_asset_id,
                recording_playback_id, low_latency, recording_enabled, reconnect_window_seconds,
                ingest_rtmp_url, created_at, updated_at, started_at, stopped_at, archived_at,
                last_webhook_event_id, metadata_json
         FROM dotcast_livestreams
         WHERE mux_live_stream_id = ?`
      )
      .bind(muxLiveStreamId)
      .first();

    return row ? livestreamFromRow(row as unknown as D1LivestreamRow) : null;
  }

  async upsertLivestream(record: DotCastLivestreamMetadata): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_livestreams (
           stream_id, provider, control_layer, mux_live_stream_id, playback_id, playback_policy,
           host_id, title, status, mux_status, recording_asset_id, recording_playback_id,
           low_latency, recording_enabled, reconnect_window_seconds, ingest_rtmp_url, created_at,
           updated_at, started_at, stopped_at, archived_at, last_webhook_event_id, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stream_id) DO UPDATE SET
           provider = excluded.provider,
           control_layer = excluded.control_layer,
           mux_live_stream_id = excluded.mux_live_stream_id,
           playback_id = excluded.playback_id,
           playback_policy = excluded.playback_policy,
           host_id = excluded.host_id,
           title = excluded.title,
           status = excluded.status,
           mux_status = excluded.mux_status,
           recording_asset_id = excluded.recording_asset_id,
           recording_playback_id = excluded.recording_playback_id,
           low_latency = excluded.low_latency,
           recording_enabled = excluded.recording_enabled,
           reconnect_window_seconds = excluded.reconnect_window_seconds,
           ingest_rtmp_url = excluded.ingest_rtmp_url,
           updated_at = excluded.updated_at,
           started_at = excluded.started_at,
           stopped_at = excluded.stopped_at,
           archived_at = excluded.archived_at,
           last_webhook_event_id = excluded.last_webhook_event_id,
           metadata_json = excluded.metadata_json`
      )
      .bind(...livestreamParams(record))
      .run();
  }

  async updateLivestreamFromWebhook(
    streamId: string,
    event: DotCastMuxWebhookEvent,
    now: string
  ): Promise<DotCastLivestreamMetadata | null> {
    const current = await this.getLivestream(streamId);

    if (!current) {
      return null;
    }

    const status = event.metadataStatus ?? current.status;
    const next: DotCastLivestreamMetadata = {
      ...current,
      status,
      muxStatus: event.muxStatus ?? current.muxStatus,
      recordingAssetId: event.recordingAssetId ?? current.recordingAssetId,
      recordingPlaybackId: event.recordingPlaybackId ?? current.recordingPlaybackId,
      startedAt: status === "live" ? (current.startedAt ?? now) : current.startedAt,
      stoppedAt: status === "idle" ? now : current.stoppedAt,
      updatedAt: now,
      lastWebhookEventId: event.eventId
    };

    await this.upsertLivestream(next);
    await this.appendEvent({
      eventId: event.eventId,
      streamId,
      muxLiveStreamId: current.muxLiveStreamId,
      eventType: event.eventType,
      status: event.metadataStatus,
      payload: event.payload,
      createdAt: event.createdAt
    });

    return next;
  }

  async archiveLivestream(
    streamId: string,
    now: string
  ): Promise<DotCastLivestreamMetadata | null> {
    const current = await this.getLivestream(streamId);

    if (!current) {
      return null;
    }

    const next: DotCastLivestreamMetadata = {
      ...current,
      status: "archived",
      archivedAt: now,
      updatedAt: now
    };

    await this.upsertLivestream(next);
    await this.appendEvent({
      eventId: `dotcast:livestream:${streamId}:archived:${Date.parse(now)}`,
      streamId,
      muxLiveStreamId: current.muxLiveStreamId,
      eventType: "DOTCAST_LIVESTREAM_ARCHIVED",
      status: "archived",
      payload: { streamId },
      createdAt: now
    });

    return next;
  }

  async attachPool(link: DotCastLivestreamPoolLink): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_livestream_pool_links (
           stream_id, pool_id, market_id, question, unit, status, pinned, attached_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stream_id, pool_id) DO UPDATE SET
           market_id = excluded.market_id,
           question = excluded.question,
           unit = excluded.unit,
           status = excluded.status,
           pinned = excluded.pinned,
           updated_at = excluded.updated_at`
      )
      .bind(
        link.streamId,
        link.poolId,
        link.marketId,
        link.question,
        link.unit,
        link.status,
        link.pinned ? 1 : 0,
        link.attachedAt,
        link.updatedAt
      )
      .run();
  }

  async listPools(streamId: string): Promise<DotCastLivestreamPoolLink[]> {
    const result = await this.db
      .prepare(
        `SELECT stream_id, pool_id, market_id, question, unit, status, pinned, attached_at,
                updated_at
         FROM dotcast_livestream_pool_links
         WHERE stream_id = ?
         ORDER BY pinned DESC, attached_at ASC`
      )
      .bind(streamId)
      .all();

    return (result.results ?? []).map((row) => poolLinkFromRow(row as unknown as D1PoolLinkRow));
  }

  async appendEvent(event: DotCastLivestreamMetadataEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_livestream_events (
           event_id, stream_id, mux_live_stream_id, event_type, status, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.streamId,
        event.muxLiveStreamId,
        event.eventType,
        event.status,
        JSON.stringify(event.payload),
        event.createdAt
      )
      .run();
  }
}

export function readMuxLivestreamConfig(env: DotCastMuxLivestreamEnv): DotCastMuxLivestreamConfig {
  const guards: string[] = [];
  const provider = parseProvider(env.LIVESTREAM_PROVIDER);
  const controlLayer = parseControlLayer(env.LIVESTREAM_CONTROL_LAYER);
  const playbackPolicy = parsePlaybackPolicy(env.MUX_PLAYBACK_POLICY);
  const lowLatency = parseBooleanEnv(env.MUX_LOW_LATENCY, true);
  const recordingEnabled = parseBooleanEnv(env.MUX_RECORDING_ENABLED, true);
  const reconnectWindowSeconds = parseIntegerEnv(
    env.MUX_RECONNECT_WINDOW_SECONDS,
    DEFAULT_RECONNECT_WINDOW_SECONDS
  );
  const tokenConfigured = Boolean(env.MUX_SIGNING_KEY_ID && env.MUX_SIGNING_PRIVATE_KEY);

  if (env.LIVESTREAM_PROVIDER && env.LIVESTREAM_PROVIDER !== "mux") {
    guards.push("livestream provider must be mux");
  }

  if (env.LIVESTREAM_CONTROL_LAYER && env.LIVESTREAM_CONTROL_LAYER !== "livewire") {
    guards.push("livestream control layer must be livewire");
  }

  if (!env.MUX_TOKEN_ID || !env.MUX_TOKEN_SECRET) {
    guards.push("Mux API token is not configured");
  }

  if (playbackPolicy === "signed" && !tokenConfigured) {
    guards.push("Mux signing key is required for signed playback URLs");
  }

  return {
    provider,
    controlLayer,
    ready: guards.length === 0,
    playbackPolicy,
    lowLatency,
    recordingEnabled,
    reconnectWindowSeconds,
    tokenConfigured,
    guards
  };
}

export async function createMuxLiveStream(
  env: DotCastMuxLivestreamEnv,
  input: DotCastCreateMuxLivestreamInput,
  fetcher: typeof fetch = fetch
): Promise<DotCastMuxLiveStreamData> {
  const config = readMuxLivestreamConfig(env);

  if (!config.ready) {
    throw new DotCastLivestreamError("MUX_NOT_CONFIGURED", config.guards.join("; "), 503);
  }

  const body: Record<string, unknown> = {
    playback_policies: [config.playbackPolicy],
    reconnect_window: config.reconnectWindowSeconds,
    latency_mode: config.lowLatency ? "low" : "standard",
    passthrough: input.passthrough ?? input.streamId,
    meta: {
      dotcast_stream_id: input.streamId,
      ...(input.metadata ?? {})
    }
  };

  if (config.recordingEnabled) {
    body.new_asset_settings = {
      playback_policies: [config.playbackPolicy]
    };
  }

  const response = await fetcher(`${MUX_API_BASE_URL}/live-streams`, {
    method: "POST",
    headers: {
      authorization: `Basic ${base64Encode(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`)}`,
      "content-type": "application/json;charset=UTF-8"
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => ({}))) as MuxCreateLiveStreamResponse;

  if (!response.ok || !payload.data) {
    throw new DotCastLivestreamError(
      "MUX_CREATE_FAILED",
      `Mux live stream creation failed with status ${response.status}`,
      502
    );
  }

  return muxLiveStreamFromPayload(payload.data, config.playbackPolicy);
}

export function buildMuxLivestreamRecord(input: {
  streamId: string;
  hostId: string;
  title: string;
  mux: DotCastMuxLiveStreamData;
  config: DotCastMuxLivestreamConfig;
  now: string;
  metadata?: Record<string, unknown>;
}): DotCastLivestreamMetadata {
  return {
    streamId: input.streamId,
    provider: input.config.provider,
    controlLayer: input.config.controlLayer,
    muxLiveStreamId: input.mux.id,
    playbackId: input.mux.playbackId,
    playbackPolicy: input.mux.playbackPolicy,
    hostId: input.hostId,
    title: input.title,
    status: muxStatusToMetadataStatus(input.mux.status),
    muxStatus: input.mux.status,
    recordingAssetId: null,
    recordingPlaybackId: null,
    lowLatency: input.config.lowLatency,
    recordingEnabled: input.config.recordingEnabled,
    reconnectWindowSeconds: input.config.reconnectWindowSeconds,
    ingestRtmpUrl: DOTCAST_MUX_RTMP_URL,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: input.mux.status === "active" ? input.now : null,
    stoppedAt: null,
    archivedAt: null,
    lastWebhookEventId: null,
    metadata: input.metadata ?? {}
  };
}

export async function buildMuxPlaybackDescriptor(
  record: DotCastLivestreamMetadata,
  env: DotCastMuxLivestreamEnv,
  now = new Date()
): Promise<DotCastMuxPlaybackDescriptor> {
  const baseUrl = `${DOTCAST_MUX_PLAYBACK_BASE_URL}/${record.playbackId}.m3u8`;

  if (record.playbackPolicy === "public") {
    return {
      playbackId: record.playbackId,
      playbackPolicy: record.playbackPolicy,
      playbackUrl: baseUrl,
      token: null,
      tokenExpiresAt: null
    };
  }

  const token = await signMuxPlaybackToken(record.playbackId, env, now);
  const tokenExpiresAt = new Date(
    now.getTime() + playbackTokenTtlSeconds(env) * 1000
  ).toISOString();

  return {
    playbackId: record.playbackId,
    playbackPolicy: record.playbackPolicy,
    playbackUrl: `${baseUrl}?token=${token}`,
    token,
    tokenExpiresAt
  };
}

export async function parseVerifiedMuxWebhook(
  request: Request,
  env: DotCastMuxLivestreamEnv,
  now = new Date()
): Promise<DotCastMuxWebhookEvent> {
  if (!env.MUX_WEBHOOK_SECRET) {
    throw new DotCastLivestreamError(
      "MUX_WEBHOOK_SECRET_MISSING",
      "Mux webhook secret is not configured",
      503
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("mux-signature") ?? request.headers.get("Mux-Signature");

  if (
    !signature ||
    !(await verifyMuxWebhookSignature(signature, rawBody, env.MUX_WEBHOOK_SECRET, now))
  ) {
    throw new DotCastLivestreamError(
      "MUX_WEBHOOK_SIGNATURE_INVALID",
      "Invalid Mux webhook signature",
      401
    );
  }

  const payload = parseJsonRecord(rawBody, "Mux webhook body must be JSON");
  return muxWebhookEventFromPayload(payload);
}

export async function verifyMuxWebhookSignature(
  header: string,
  rawBody: string,
  secret: string,
  now = new Date()
): Promise<boolean> {
  const parsed = parseMuxSignatureHeader(header);

  if (!parsed.timestamp || !parsed.signature) {
    return false;
  }

  const timestampSeconds = Number(parsed.timestamp);

  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds);

  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = await hmacSha256Hex(`${parsed.timestamp}.${rawBody}`, secret);
  return constantTimeEqual(expected, parsed.signature);
}

export function muxWebhookEventFromPayload(
  payload: Record<string, unknown>
): DotCastMuxWebhookEvent {
  const eventType = parseRequiredString(payload.type, "Mux webhook type");
  const data = parseRecord(payload.data);
  const muxLiveStreamId = eventType.startsWith("video.asset.")
    ? parseOptionalString(data.live_stream_id)
    : parseOptionalString(data.id) ?? parseOptionalString(data.live_stream_id);
  const recordingAssetId =
    parseOptionalString(data.active_asset_id) ?? parseOptionalString(data.id);
  const playbackId = firstPlaybackId(data.playback_ids);
  const eventId =
    parseOptionalString(payload.id) ??
    `mux:${eventType}:${muxLiveStreamId ?? recordingAssetId ?? Date.now()}`;
  const createdAt = muxTimestampToIso(payload.created_at) ?? new Date().toISOString();
  const metadataStatus = eventTypeToMetadataStatus(eventType);
  const muxStatus = eventTypeToMuxStatus(eventType) ?? parseOptionalString(data.status);

  return {
    eventId,
    eventType,
    muxLiveStreamId,
    recordingAssetId: eventType.startsWith("video.asset.") ? recordingAssetId : null,
    recordingPlaybackId: eventType === "video.asset.ready" ? playbackId : null,
    metadataStatus,
    muxStatus,
    createdAt,
    payload
  };
}

export function muxStatusToMetadataStatus(status: string): DotCastLivestreamMetadataStatus {
  if (status === "active" || status === "live") {
    return "live";
  }

  if (status === "errored") {
    return "errored";
  }

  return "idle";
}

function livestreamFromRow(row: D1LivestreamRow): DotCastLivestreamMetadata {
  return {
    streamId: row.stream_id,
    provider: "mux",
    controlLayer: "livewire",
    muxLiveStreamId: row.mux_live_stream_id,
    playbackId: row.playback_id,
    playbackPolicy: parsePlaybackPolicy(row.playback_policy),
    hostId: row.host_id,
    title: row.title,
    status: parseMetadataStatus(row.status),
    muxStatus: row.mux_status,
    recordingAssetId: row.recording_asset_id,
    recordingPlaybackId: row.recording_playback_id,
    lowLatency: row.low_latency === 1,
    recordingEnabled: row.recording_enabled === 1,
    reconnectWindowSeconds: row.reconnect_window_seconds,
    ingestRtmpUrl: row.ingest_rtmp_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    archivedAt: row.archived_at,
    lastWebhookEventId: row.last_webhook_event_id,
    metadata: parseJsonRecord(row.metadata_json || "{}", "metadata_json must be JSON")
  };
}

function livestreamParams(record: DotCastLivestreamMetadata): unknown[] {
  return [
    record.streamId,
    record.provider,
    record.controlLayer,
    record.muxLiveStreamId,
    record.playbackId,
    record.playbackPolicy,
    record.hostId,
    record.title,
    record.status,
    record.muxStatus,
    record.recordingAssetId,
    record.recordingPlaybackId,
    record.lowLatency ? 1 : 0,
    record.recordingEnabled ? 1 : 0,
    record.reconnectWindowSeconds,
    record.ingestRtmpUrl,
    record.createdAt,
    record.updatedAt,
    record.startedAt,
    record.stoppedAt,
    record.archivedAt,
    record.lastWebhookEventId,
    JSON.stringify(record.metadata)
  ];
}

function poolLinkFromRow(row: D1PoolLinkRow): DotCastLivestreamPoolLink {
  return {
    streamId: row.stream_id,
    poolId: row.pool_id,
    marketId: row.market_id,
    question: row.question,
    unit: parseStakeUnit(row.unit),
    status: parsePoolStatus(row.status),
    pinned: row.pinned === 1,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at
  };
}

function muxLiveStreamFromPayload(
  data: Record<string, unknown>,
  fallbackPolicy: DotCastMuxPlaybackPolicy
): DotCastMuxLiveStreamData {
  const playback = parsePlaybackId(data.playback_ids, fallbackPolicy);

  return {
    id: parseRequiredString(data.id, "Mux live stream id"),
    streamKey: parseRequiredString(data.stream_key, "Mux stream key"),
    status: parseOptionalString(data.status) ?? "idle",
    playbackId: playback.id,
    playbackPolicy: playback.policy,
    reconnectWindowSeconds:
      parseOptionalInteger(data.reconnect_window) ?? DEFAULT_RECONNECT_WINDOW_SECONDS,
    createdAt: muxTimestampToIso(data.created_at) ?? new Date().toISOString(),
    raw: data
  };
}

function parsePlaybackId(
  value: unknown,
  fallbackPolicy: DotCastMuxPlaybackPolicy
): { id: string; policy: DotCastMuxPlaybackPolicy } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DotCastLivestreamError(
      "MUX_PLAYBACK_ID_MISSING",
      "Mux did not return a playback id",
      502
    );
  }

  const first = parseRecord(value[0]);
  return {
    id: parseRequiredString(first.id, "Mux playback id"),
    policy: parsePlaybackPolicy(first.policy ?? fallbackPolicy)
  };
}

function firstPlaybackId(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const first = parseRecord(value[0]);
  return parseOptionalString(first.id) ?? null;
}

function eventTypeToMetadataStatus(eventType: string): DotCastLivestreamMetadataStatus | null {
  if (eventType === "video.live_stream.active") {
    return "live";
  }

  if (eventType === "video.live_stream.idle") {
    return "idle";
  }

  if (eventType === "video.live_stream.errored" || eventType === "video.asset.errored") {
    return "errored";
  }

  return null;
}

function eventTypeToMuxStatus(eventType: string): string | null {
  if (eventType === "video.live_stream.active") {
    return "active";
  }

  if (eventType === "video.live_stream.idle") {
    return "idle";
  }

  if (eventType === "video.live_stream.errored" || eventType === "video.asset.errored") {
    return "errored";
  }

  if (eventType === "video.asset.ready") {
    return "recording.ready";
  }

  return null;
}

async function signMuxPlaybackToken(
  playbackId: string,
  env: DotCastMuxLivestreamEnv,
  now: Date
): Promise<string> {
  if (!env.MUX_SIGNING_KEY_ID || !env.MUX_SIGNING_PRIVATE_KEY) {
    throw new DotCastLivestreamError(
      "MUX_SIGNING_KEY_MISSING",
      "Mux signing key is required for signed playback",
      503
    );
  }

  const expiresAt = Math.floor(now.getTime() / 1000) + playbackTokenTtlSeconds(env);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: env.MUX_SIGNING_KEY_ID
  };
  const claims = {
    sub: playbackId,
    aud: "v",
    exp: expiresAt
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const privateKey = await importRsaPrivateKey(env.MUX_SIGNING_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64Url(signature)}`;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = Uint8Array.from(globalThis.atob(clean), (char) => char.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function parseMuxSignatureHeader(header: string): {
  timestamp: string | null;
  signature: string | null;
} {
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key?.trim(), value?.trim()];
    })
  );

  return {
    timestamp: parts.t ?? null,
    signature: parts.v1 ?? null
  };
}

async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}

function playbackTokenTtlSeconds(env: DotCastMuxLivestreamEnv): number {
  return parseIntegerEnv(env.MUX_PLAYBACK_TOKEN_TTL_SECONDS, DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS);
}

function base64Encode(value: string): string {
  return globalThis.btoa(value);
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function muxTimestampToIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number(value);

    if (Number.isFinite(asNumber)) {
      return new Date(asNumber * 1000).toISOString();
    }

    const asDate = Date.parse(value);

    if (Number.isFinite(asDate)) {
      return new Date(asDate).toISOString();
    }
  }

  return null;
}

function parseJsonRecord(value: string, error: string): Record<string, unknown> {
  try {
    return parseRecord(JSON.parse(value));
  } catch {
    throw new DotCastLivestreamError("INVALID_JSON", error, 400);
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseRequiredString(value: unknown, label: string): string {
  const parsed = parseOptionalString(value);

  if (parsed) {
    return parsed;
  }

  throw new DotCastLivestreamError("INVALID_LIVESTREAM_FIELD", `${label} is required`, 400);
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalInteger(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) ? (parsed as number) : null;
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === "true";
}

function parseProvider(value: string | undefined): DotCastLivestreamProvider {
  return value === undefined || value === "mux" ? "mux" : "mux";
}

function parseControlLayer(value: string | undefined): DotCastLivestreamControlLayer {
  return value === undefined || value === "livewire" ? "livewire" : "livewire";
}

function parsePlaybackPolicy(value: unknown): DotCastMuxPlaybackPolicy {
  if (value === "signed") {
    return "signed";
  }

  return "public";
}

function parseMetadataStatus(value: unknown): DotCastLivestreamMetadataStatus {
  if (value === "live" || value === "errored" || value === "archived") {
    return value;
  }

  return "idle";
}

function parseStakeUnit(value: unknown): StakeUnit {
  return value === "usdc" ? "usdc" : "points";
}

function parsePoolStatus(value: unknown): PoolStatus {
  if (value === "locked" || value === "resolving" || value === "settled" || value === "voided") {
    return value;
  }

  return "open";
}

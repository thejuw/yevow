import { Logger } from "./Logger";
import { parseLiquidationWallets } from "./agents/HeatmapAgent";
import {
  DwellirHyperliquidGrpcClient,
  type DwellirGrpcPayload,
  type DwellirGrpcStreamKind
} from "./grpc/DwellirHyperliquidGrpcClient";
import {
  HyperliquidGrpcClient,
  type HyperliquidGrpcUpdate
} from "./grpc/HyperliquidGrpcClient";
import { Notifier } from "./utils/Notifier";
import {
  durableObjectLocationOptions,
  getTradingEngineStub
} from "./utils/TradingEngineStub";
import type {
  Env,
  AgentSignal,
  ExchangeStreamConfig,
  ExchangeStreamHealth,
  IngestHealth,
  JsonRecord,
  MarketDataSubscriptionProfile,
  MarketDataSubscriptionTier,
  MarketDataSource,
  MarketTick,
  OrderBookSnapshot,
  OrderBookSnapshotLevel,
  OrderBookResetRequest
} from "./types";

const DEFAULT_INGEST_COORDINATOR_NAME = "sovereign-sigma:singleton:ingest-coordinator:v3:apac-tokyo";
const DEFAULT_AUTH_HEADER = "X-Api-Key";
const DEFAULT_GRPC_AUTH_HEADER = "x-token";
const DWELLIR_GRPC_ENDPOINT = "https://api-hyperliquid-mainnet-grpc.n.dwellir.com";
const DWELLIR_ORDERBOOK_WS_ENDPOINT = "wss://api-hyperliquid-mainnet-orderbook.n.dwellir.com";
const DWELLIR_GRPC_SERVICE = "hyperliquid_l1_gateway.v2.HyperliquidL1Gateway";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WATCHDOG_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_GRPC_BACKOFF_BASE_MS = 50;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_GRPC_FATAL_DROP_MS = 200;
const DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS = 60_000;
const DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS = 1_000;
const DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS = 5_000;
const NORMAL_RECYCLE_LOG_THROTTLE_MS = 60_000;
const DEFAULT_HAWKES_BASELINE_MU = 0.1;
const DEFAULT_HAWKES_JUMP_BETA = 0.9;
const DEFAULT_HAWKES_DECAY_ALPHA = 2.2;
const DEFAULT_HAWKES_THRESHOLD_QUANTILE = 0.95;
const DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS = 60_000;
const HAWKES_WINDOW_SECONDS = 3_600;
const SNAPSHOT_SEQUENCE_FALLBACK_SEED = "snapshot";
const DEFAULT_SOURCE_WEIGHT = 1;
const DEFAULT_CLOCK_SYNC_ALPHA = 0.1;
const DEFAULT_CLOCK_SYNC_MAX_OFFSET_MS = 10_000;
const DEFAULT_STALE_TICK_DROP_MS = 1_000;
const PRE_SNAPSHOT_BUFFER_LIMIT = 1_000;
const HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT = 20;
const DWELLIR_MAX_L2_DEPTH_LIMIT = 100;
const DEFAULT_HYPERLIQUID_ASSET_MATRIX = ["BTC", "ETH", "HYPE", "SOL"] as const;

type ResolvedExchangeStreamConfig = Required<
  Pick<
    ExchangeStreamConfig,
    "id" | "source" | "source_exchange" | "streamUrl" | "authHeader" | "weight"
  >
> &
  Pick<
    ExchangeStreamConfig,
    | "transport"
    | "clusterUrls"
    | "snapshotUrl"
    | "subscription"
    | "subscriptions"
    | "apiKeyEnv"
    | "instrumentCode"
    | "exchangeCode"
    | "grpcEndpoint"
    | "grpcService"
    | "grpcStreamMethod"
    | "grpcPingMethod"
    | "grpcSubscribeType"
    | "grpcUpdateType"
    | "grpcPingRequestType"
    | "grpcPingResponseType"
    | "grpcStreamTypes"
    | "subscriptionProfile"
  > & {
    transport: "websocket" | "grpc";
    heartbeatIntervalMs: number;
    watchdogTimeoutMs: number;
    maxBackoffMs: number;
    backoffBaseMs: number;
    grpcFatalDropMs: number;
  };

interface EngineTickResponse {
  accepted?: boolean;
  acceptedCount?: number;
  processedCount?: number;
  status?: string;
  reason?: string;
}

interface NewsFeedConfig {
  url: string;
  source?: string;
}

interface NewsItem {
  id: string;
  headline: string;
  source: string;
  url: string | null;
  publishedAt: string | null;
}

interface BinanceSequenceWindow {
  firstUpdateId: number;
  finalUpdateId: number;
}

interface HyperliquidBookLevelSet {
  bids: Set<string>;
  asks: Set<string>;
}

interface DwellirL4OrderState {
  side: "buy" | "sell";
  price: string;
  size: number;
  updatedAt: string;
}

type HawkesFlowSide = "BUY" | "SELL" | "UNKNOWN";

interface HawkesFlowObservation {
  triggered: boolean;
  instrumentCode: string;
  side: HawkesFlowSide;
  pullSide: "BID" | "ASK" | "BOTH";
  size: number;
  intensity: number;
  threshold: number;
  confidence: number;
  baselineMu: number;
  jumpBeta: number;
  decayAlpha: number;
  observedAtMs: number;
  receivedAt: string;
  cooldownMs: number;
}

interface HawkesFlowTrackerConfig {
  baselineMu: number;
  jumpBeta: number;
  decayAlpha: number;
  thresholdQuantile: number;
  signalCooldownMs: number;
}

interface HawkesInstrumentState {
  excitation: number;
  lastEventMs: number | null;
  sampleValues: Float32Array;
  sampleTimes: Float64Array;
  scratch: Float32Array;
  sampleIndex: number;
  sampleCount: number;
  lastSampleSecond: number;
  lastThreshold: number;
  lastSignalMs: number;
}

const seenNewsItems = new Map<string, number>();

class HawkesFlowTracker {
  private readonly states = new Map<string, HawkesInstrumentState>();
  private readonly baselineMu: number;
  private readonly jumpBeta: number;
  private readonly decayAlpha: number;
  private readonly thresholdQuantile: number;
  private readonly signalCooldownMs: number;

  constructor(config: HawkesFlowTrackerConfig) {
    this.baselineMu = positiveConfigNumber(config.baselineMu, DEFAULT_HAWKES_BASELINE_MU);
    this.jumpBeta = positiveConfigNumber(config.jumpBeta, DEFAULT_HAWKES_JUMP_BETA);
    this.decayAlpha = positiveConfigNumber(config.decayAlpha, DEFAULT_HAWKES_DECAY_ALPHA);
    this.thresholdQuantile = clampNumber(
      config.thresholdQuantile,
      0.5,
      0.999,
      DEFAULT_HAWKES_THRESHOLD_QUANTILE
    );
    this.signalCooldownMs = positiveConfigNumber(
      config.signalCooldownMs,
      DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS
    );
  }

  observe(input: {
    instrumentCode: string;
    side: HawkesFlowSide;
    size: number;
    observedAtMs: number;
    receivedAt: string;
  }): HawkesFlowObservation {
    const observedAtMs = Number.isFinite(input.observedAtMs)
      ? input.observedAtMs
      : Date.parse(input.receivedAt);
    const state = this.stateFor(input.instrumentCode);
    const dtSeconds = state.lastEventMs === null
      ? 0
      : Math.max(0, (observedAtMs - state.lastEventMs) / 1_000);
    const decay = Math.exp(-this.decayAlpha * dtSeconds);
    const sizeScale = Math.max(1, Math.log1p(Math.max(0, input.size)));

    state.excitation = state.excitation * decay + this.jumpBeta * sizeScale;
    state.lastEventMs = observedAtMs;
    const intensity = this.baselineMu + state.excitation;
    const second = Math.floor(observedAtMs / 1_000);

    if (second !== state.lastSampleSecond) {
      this.recordSample(state, intensity, observedAtMs);
      state.lastSampleSecond = second;
      state.lastThreshold = this.quantile(state);
    }

    const threshold = Math.max(state.lastThreshold, this.baselineMu + this.jumpBeta);
    const cooldownOpen = observedAtMs - state.lastSignalMs >= this.signalCooldownMs;
    const triggered =
      state.sampleCount >= 30 &&
      cooldownOpen &&
      input.side !== "UNKNOWN" &&
      intensity > threshold;

    if (triggered) {
      state.lastSignalMs = observedAtMs;
    }

    return {
      triggered,
      instrumentCode: input.instrumentCode,
      side: input.side,
      pullSide: input.side === "BUY" ? "ASK" : input.side === "SELL" ? "BID" : "BOTH",
      size: input.size,
      intensity,
      threshold,
      confidence: clampNumber(intensity / Math.max(threshold, 1e-9) - 1, 0, 1, 0),
      baselineMu: this.baselineMu,
      jumpBeta: this.jumpBeta,
      decayAlpha: this.decayAlpha,
      observedAtMs,
      receivedAt: input.receivedAt,
      cooldownMs: this.signalCooldownMs
    };
  }

  private stateFor(instrumentCode: string): HawkesInstrumentState {
    const existing = this.states.get(instrumentCode);
    if (existing) {
      return existing;
    }

    const created: HawkesInstrumentState = {
      excitation: 0,
      lastEventMs: null,
      sampleValues: new Float32Array(HAWKES_WINDOW_SECONDS),
      sampleTimes: new Float64Array(HAWKES_WINDOW_SECONDS),
      scratch: new Float32Array(HAWKES_WINDOW_SECONDS),
      sampleIndex: 0,
      sampleCount: 0,
      lastSampleSecond: -1,
      lastThreshold: 0,
      lastSignalMs: 0
    };
    this.states.set(instrumentCode, created);
    return created;
  }

  private recordSample(state: HawkesInstrumentState, intensity: number, observedAtMs: number): void {
    state.sampleValues[state.sampleIndex] = intensity;
    state.sampleTimes[state.sampleIndex] = observedAtMs;
    state.sampleIndex = (state.sampleIndex + 1) % HAWKES_WINDOW_SECONDS;
    state.sampleCount = Math.min(HAWKES_WINDOW_SECONDS, state.sampleCount + 1);
  }

  private quantile(state: HawkesInstrumentState): number {
    const cutoffMs = (state.lastEventMs ?? Date.now()) - 3_600_000;
    let count = 0;

    for (let index = 0; index < state.sampleCount; index += 1) {
      if (state.sampleTimes[index] >= cutoffMs) {
        state.scratch[count] = state.sampleValues[index];
        count += 1;
      }
    }

    if (count === 0) {
      return this.baselineMu + this.jumpBeta;
    }

    const targetIndex = Math.min(
      count - 1,
      Math.floor((count - 1) * this.thresholdQuantile)
    );
    return quickSelect(state.scratch, 0, count - 1, targetIndex);
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "IngestWorker"
    );

    if (request.method === "GET" && url.pathname === "/health") {
      return routeToIngestCoordinator(request, env);
    }

    if (request.method === "POST" && url.pathname === "/stream/start") {
      if (!isAuthorizedControlRequest(request, env)) {
        logger.warn("INGEST_CONTROL_REJECTED", "Rejected stream start request");
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      return routeToIngestCoordinator(request, env);
    }

    if (request.method === "POST" && url.pathname === "/stream/stop") {
      if (!isAuthorizedControlRequest(request, env)) {
        logger.warn("INGEST_CONTROL_REJECTED", "Rejected stream stop request");
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      return routeToIngestCoordinator(request, env);
    }

    return json({
      ok: true,
      service: "sovereign-sigma-ingest",
      routes: ["GET /health", "POST /stream/start", "POST /stream/stop"]
    });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      routeToIngestCoordinator(
        new Request("https://sovereign-sigma-ingest.internal/scheduled", {
          method: "POST",
          headers: { "x-sovereign-scheduled": "1" }
        }),
        env
      )
    );
  }
} satisfies ExportedHandler<Env>;

function routeToIngestCoordinator(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_COORDINATOR) {
    return Promise.resolve(
      json({ ok: false, error: "INGEST_COORDINATOR_NOT_BOUND" }, 503)
    );
  }

  const url = new URL(request.url);
  const coordinatorUrl = new URL(
    `${url.pathname}${url.search}`,
    "https://sovereign-sigma-ingest-coordinator.internal"
  );
  const coordinatorName =
    env.INGEST_COORDINATOR_OBJECT_NAME?.trim() || DEFAULT_INGEST_COORDINATOR_NAME;
  const id = env.INGEST_COORDINATOR.idFromName(coordinatorName);
  const coordinator = env.INGEST_COORDINATOR.get(
    id,
    durableObjectLocationOptions(env.INGEST_COORDINATOR_LOCATION_HINT)
  );

  return coordinator.fetch(new Request(coordinatorUrl, request));
}

export class IngestCoordinator {
  private readonly activeStreams = new Map<string, ExchangeStreamController>();
  private readonly logger: Logger;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    this.logger = new Logger(
      env.TRADING_DB,
      (promise) => this.state.waitUntil(promise),
      "IngestCoordinator"
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(getHealth(this.activeStreams));
    }

    if (request.method === "POST" && url.pathname === "/stream/start") {
      this.ensureStreams();
      return json({ ok: true, health: getHealth(this.activeStreams) });
    }

    if (request.method === "POST" && url.pathname === "/stream/stop") {
      stopAllStreams(this.activeStreams, "CONTROL_STOP");
      return json({ ok: true, health: getHealth(this.activeStreams) });
    }

    if (request.method === "POST" && url.pathname === "/scheduled") {
      this.ensureStreams();
      this.state.waitUntil(ingestNewsFeeds(this.env, this.logger));
      return json({ ok: true, health: getHealth(this.activeStreams) });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }

  private ensureStreams(): void {
    ensureStreams(
      this.env,
      (promise) => this.state.waitUntil(promise),
      this.logger,
      this.activeStreams
    );
  }
}

function ensureStreams(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  logger: Logger,
  activeStreams: Map<string, ExchangeStreamController>
): void {
  const configs = loadStreamConfigs(env);
  const configuredIds = new Set(configs.map((config) => config.id));

  for (const [streamId, stream] of activeStreams) {
    if (!configuredIds.has(streamId)) {
      stream.stop("STREAM_CONFIG_REMOVED");
      activeStreams.delete(streamId);
    }
  }

  for (const config of configs) {
    const active = activeStreams.get(config.id);

    if (active?.isRunning()) {
      continue;
    }

    const controller = new ExchangeStreamController(env, logger, config, waitUntil);
    activeStreams.set(config.id, controller);
    waitUntil(controller.run());
  }
}

function stopAllStreams(
  activeStreams: Map<string, ExchangeStreamController>,
  reason: string
): void {
  for (const stream of activeStreams.values()) {
    stream.stop(reason);
  }

  activeStreams.clear();
}

async function ingestNewsFeeds(env: Env, logger: Logger): Promise<void> {
  const feeds = loadNewsFeedConfigs(env);

  if (feeds.length === 0) {
    return;
  }

  pruneSeenNewsItems();

  for (const feed of feeds) {
    try {
      const response = await fetch(feed.url, { headers: { accept: "application/rss+xml, application/xml, text/xml" } });

      if (!response.ok) {
        logger.warn("NEWS_FEED_FETCH_FAILED", "News feed returned non-2xx status", {
          source: feed.source ?? feed.url,
          url: feed.url,
          status: response.status
        });
        continue;
      }

      const items = parseRssItems(await response.text(), feed);

      for (const item of items) {
        if (seenNewsItems.has(item.id)) {
          continue;
        }

        seenNewsItems.set(item.id, Date.now());
        await forwardNewsItem(env, item);
        logger.info("NEWS_ITEM_FORWARDED", "Forwarded attributed news item to sentiment agent", {
          source: item.source,
          headline: item.headline,
          url: item.url,
          publishedAt: item.publishedAt
        });
      }
    } catch (error) {
      logger.warn("NEWS_FEED_INGEST_FAILED", "Failed to ingest configured news feed", {
        source: feed.source ?? feed.url,
        url: feed.url,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }
}

async function forwardNewsItem(env: Env, item: NewsItem): Promise<void> {
  const engine = getTradingEngineStub(env);

  await engine.fetch(
    new Request("https://trading-engine.internal/news/sentiment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-source": "sovereign-sigma-ingest-news"
      },
      body: JSON.stringify(item)
    })
  );
}

function loadNewsFeedConfigs(env: Env): NewsFeedConfig[] {
  const parsed = env.NEWS_FEEDS ? parseJson<Array<string | NewsFeedConfig>>(env.NEWS_FEEDS) : null;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (typeof entry === "string" && entry.startsWith("http")) {
      return [{ url: entry }];
    }

    if (isRecord(entry) && typeof entry.url === "string" && entry.url.startsWith("http")) {
      return [{ url: entry.url, source: typeof entry.source === "string" ? entry.source : undefined }];
    }

    return [];
  });
}

function parseRssItems(xml: string, feed: NewsFeedConfig): NewsItem[] {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 25).flatMap((match) => {
    const itemXml = match[0];
    const headline = decodeXml(readXmlTag(itemXml, "title") ?? "");

    if (!headline) {
      return [];
    }

    const url = decodeXml(readXmlTag(itemXml, "link") ?? "") || null;
    const guid = decodeXml(readXmlTag(itemXml, "guid") ?? "") || url || headline;
    const publishedAt = coerceTimestamp(readXmlTag(itemXml, "pubDate")) ?? null;

    return [{
      id: hashNewsId(`${feed.url}:${guid}`),
      headline,
      source: feed.source ?? hostnameOf(feed.url),
      url,
      publishedAt
    }];
  });
}

function readXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() ?? null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function hashNewsId(value: string): string {
  return `news:${hashSequenceId(value)}`;
}

function pruneSeenNewsItems(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;

  for (const [id, observedAtMs] of seenNewsItems.entries()) {
    if (observedAtMs < cutoff) {
      seenNewsItems.delete(id);
    }
  }
}

class ExchangeStreamController {
  private socket: WebSocket | null = null;
  private grpcAbort: AbortController | null = null;
  private snapshotSync: Promise<void> | null = null;
  private readonly clockSync: ClockSyncTracker;
  private readonly clusterPool: ClusterPool;
  private readonly notifier: Notifier;
  private messageQueue: Promise<void> = Promise.resolve();
  private syntheticSequence = Date.now() * 1_000;
  private status: IngestHealth["status"] = "IDLE";
  private stopped = false;
  private connectionId: string | null = null;
  private attempts = 0;
  private backoffCounter = 0;
  private messagesReceived = 0;
  private ticksForwarded = 0;
  private ticksDropped = 0;
  private lastMessageAt: string | null = null;
  private lastForwardAt: string | null = null;
  private lastDisconnectAt: string | null = null;
  private blackoutStartedAt: string | null = null;
  private lastRecoveredAt: string | null = null;
  private lastRecoveryDurationMs: number | null = null;
  private lastFatalDropAt: string | null = null;
  private lastError: string | null = null;
  private providerSequence: number | null = null;
  private awaitingProviderBridge = false;
  private readonly hyperliquidBookLevels = new Map<string, HyperliquidBookLevelSet>();
  private readonly dwellirL4Orders = new Map<string, DwellirL4OrderState>();
  private readonly hawkesTracker: HawkesFlowTracker;
  private streamReady = false;
  private hasConnectedOnce = false;
  private preSnapshotBuffer: Array<string | ArrayBuffer> = [];
  private normalRecycleLogAt = new Map<string, number>();

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly config: ResolvedExchangeStreamConfig,
    private readonly waitUntil: (promise: Promise<unknown>) => void
  ) {
    this.clockSync = new ClockSyncTracker(
      readNumber(env.CLOCK_SYNC_ALPHA, DEFAULT_CLOCK_SYNC_ALPHA),
      readNumber(env.CLOCK_SYNC_MAX_OFFSET_MS, DEFAULT_CLOCK_SYNC_MAX_OFFSET_MS)
    );
    this.clusterPool = new ClusterPool([config.streamUrl, ...(config.clusterUrls ?? [])]);
    this.notifier = new Notifier(env, (promise) => {
      void promise;
    });
    this.hawkesTracker = new HawkesFlowTracker({
      baselineMu: readNumber(env.HAWKES_BASELINE_MU, DEFAULT_HAWKES_BASELINE_MU),
      jumpBeta: readNumber(env.HAWKES_JUMP_BETA, DEFAULT_HAWKES_JUMP_BETA),
      decayAlpha: readNumber(env.HAWKES_DECAY_ALPHA, DEFAULT_HAWKES_DECAY_ALPHA),
      thresholdQuantile: readNumber(
        env.HAWKES_THRESHOLD_QUANTILE,
        DEFAULT_HAWKES_THRESHOLD_QUANTILE
      ),
      signalCooldownMs: readNumber(
        env.HAWKES_SIGNAL_COOLDOWN_MS,
        DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS
      )
    });
  }

  isRunning(): boolean {
    return !this.stopped && this.status !== "IDLE" && this.status !== "STOPPED";
  }

  snapshot(): ExchangeStreamHealth {
    return {
      ok: this.status === "CONNECTED",
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      transport: this.config.transport,
      streamHost: hostnameOf(this.clusterPool.activeUrl()),
      activeClusterUrl: redactEndpoint(this.clusterPool.activeUrl()),
      subscriptionProfile: this.config.subscriptionProfile,
      heartbeatLatencyMs: this.clusterPool.activeHeartbeatLatencyMs(),
      packetLossPct: this.packetLossPct(),
      sourceWeight: this.config.weight,
      clockOffsetMs: this.clockSync.currentOffsetMs(),
      status: this.status,
      connectionId: this.connectionId,
      attempts: this.attempts,
      backoffCounter: this.backoffCounter,
      messagesReceived: this.messagesReceived,
      ticksForwarded: this.ticksForwarded,
      ticksDropped: this.ticksDropped,
      lastMessageAt: this.lastMessageAt,
      lastForwardAt: this.lastForwardAt,
      lastDisconnectAt: this.lastDisconnectAt,
      blackoutStartedAt: this.blackoutStartedAt,
      lastRecoveredAt: this.lastRecoveredAt,
      lastRecoveryDurationMs: this.lastRecoveryDurationMs,
      lastError: this.lastError,
      lastFatalDropAt: this.lastFatalDropAt
    };
  }

  private packetLossPct(): number {
    const totalPackets = this.messagesReceived + this.ticksDropped;
    return totalPackets > 0 ? Math.round((this.ticksDropped / totalPackets) * 10_000) / 100 : 0;
  }

  stop(reason: string): void {
    this.stopped = true;
    this.status = "STOPPED";
    this.streamReady = false;
    this.preSnapshotBuffer = [];
    this.grpcAbort?.abort(reason);
    this.grpcAbort = null;
    closeSocket(this.socket, 1000, reason);
    this.socket = null;
  }

  async run(): Promise<void> {
    assertIngestEnv(this.env, this.config);
    await this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<void> {
    while (!this.stopped) {
      this.attempts += 1;
      this.status = "CONNECTING";
      this.connectionId = crypto.randomUUID();

      try {
        await this.connectOnce();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        this.startBlackout();
        this.logger.error("STREAM_ERROR", "Market stream connection failed", {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          attempts: this.attempts,
          backoffCounter: this.backoffCounter,
          error: this.lastError
        });
        if (this.config.transport === "grpc") {
          await this.emitGrpcFatalDropIfNeeded("GRPC_CONNECT_OR_STREAM_FAILURE");
        }
      }

      if (this.stopped) {
        return;
      }

      this.status = "BACKING_OFF";
      this.backoffCounter += 1;
      const maxBackoffMs = Math.min(
        this.config.maxBackoffMs,
        DEFAULT_MAX_BACKOFF_MS
      );
      const backoffMs = calculateBackoffMs(
        this.backoffCounter,
        this.config.backoffBaseMs,
        maxBackoffMs
      );

      const reconnectMetadata = {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        attempts: this.attempts,
        backoffCounter: this.backoffCounter,
        backoffMs,
        blackoutDurationMs: this.currentBlackoutDurationMs(),
        maxBackoffMs
      };

      if (this.isNormalProviderRecycle()) {
        this.logNormalProviderRecycle(
          "STREAM_RECYCLE_RECONNECT",
          "Scheduling normal provider stream recycle",
          reconnectMetadata
        );
      } else {
        this.logger.warn(
          "STREAM_RECONNECT_ATTEMPT",
          "Scheduling market stream reconnect",
          reconnectMetadata
        );
        this.notifier.notify({
          priority: "HIGH",
          title: "Sovereign-Sigma stream reconnect",
          message: `${this.config.source_exchange} reconnect attempt ${this.attempts}; blackout ${this.currentBlackoutDurationMs()}ms, retrying in ${backoffMs}ms.`,
          dedupeKey: `stream-reconnect:${this.config.id}`,
          metadata: {
            ...reconnectMetadata
          }
        });
      }

      await sleep(backoffMs);
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.config.transport === "grpc") {
      await this.connectGrpcOnce();
      return;
    }

    const streamUrl = this.clusterPool.activeUrl();
    const fetchUrl = websocketFetchUrl(streamUrl);
    const authHeader = this.config.authHeader;
    const apiKey = this.config.apiKeyEnv
      ? readEnvSecret(this.env, this.config.apiKeyEnv)
      : null;
    const heartbeatIntervalMs = this.config.heartbeatIntervalMs;
    const watchdogTimeoutMs = this.config.watchdogTimeoutMs;
    const pingIntervalMs = Math.min(
      heartbeatIntervalMs,
      Math.max(1_000, Math.floor(watchdogTimeoutMs / 2))
    );

    const headers: Record<string, string> = { Upgrade: "websocket" };

    if (apiKey) {
      headers[authHeader] = apiKey;
    }

    const response = await fetch(fetchUrl, { headers });

    if (!response.webSocket) {
      this.clusterPool.recordFailure(streamUrl);
      throw new Error(`${this.config.source}_WS_UPGRADE_FAILED_${response.status}`);
    }

    const socket = response.webSocket;
    socket.accept();

    this.socket = socket;
    this.status = "CONNECTED";
    this.streamReady = false;
    this.preSnapshotBuffer = [];
    this.backoffCounter = 0;
    const recoveredAt = new Date().toISOString();
    const blackoutDurationMs = this.currentBlackoutDurationMs(recoveredAt);
    const previousDisconnectReason = this.lastError;
    this.lastMessageAt = recoveredAt;
    this.lastRecoveredAt = recoveredAt;
    this.lastRecoveryDurationMs = blackoutDurationMs;
    this.lastError = null;

    const connectMetadata = {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      sourceWeight: this.config.weight,
      connectionId: this.connectionId,
      streamHost: new URL(streamUrl).host,
      watchdogTimeoutMs,
      pingIntervalMs
    };
    if (this.isNormalProviderRecycle(previousDisconnectReason)) {
      this.logNormalProviderRecycle(
        "STREAM_CONNECT",
        "Market stream connected after normal recycle",
        connectMetadata
      );
    } else {
      this.logger.info("STREAM_CONNECT", "Market stream connected", connectMetadata);
    }
    this.clusterPool.recordHeartbeat(streamUrl, 0);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const heartbeat =
        this.config.source === "BINANCE"
          ? null
          : setInterval(() => {
              try {
                socket.send(JSON.stringify(heartbeatPayload(this.config.source)));
              } catch {
                fail("PING_SEND_FAILED");
              }
            }, pingIntervalMs);

      const cleanup = () => {
        if (heartbeat !== null) {
          clearInterval(heartbeat);
        }
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };

      const resetWatchdog = () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
        }

        watchdog = setTimeout(() => {
          const staleForMs = this.lastMessageAt
            ? Date.now() - Date.parse(this.lastMessageAt)
            : Number.POSITIVE_INFINITY;

          this.logger.warn("STREAM_DISCONNECT", "Market stream watchdog timeout", {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            staleForMs,
            watchdogTimeoutMs
          });

          fail("WATCHDOG_TIMEOUT");
        }, watchdogTimeoutMs);
      };

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      const fail = (reason: string) => {
        const previousClusterUrl = this.clusterPool.activeUrl();
        this.clusterPool.recordFailure(streamUrl);
        const nextClusterUrl = this.clusterPool.activeUrl();
        if (nextClusterUrl !== previousClusterUrl) {
          this.logger.warn("STREAM_CLUSTER_HOT_SWAP", "Market stream cluster hot-swapped after health degradation", {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            previousClusterUrl: redactEndpoint(previousClusterUrl) ?? null,
            nextClusterUrl: redactEndpoint(nextClusterUrl) ?? null,
            reason
          });
        }
        this.markDisconnected(reason);
        closeSocket(socket, 1011, reason);
        finish(new Error(reason));
      };

      socket.addEventListener("message", (event) => {
        resetWatchdog();
        this.lastMessageAt = new Date().toISOString();
        this.messageQueue = this.messageQueue
          .then(() => this.handleMessage(event.data))
          .catch((error) => {
            this.ticksDropped += 1;
            this.logger.error("STREAM_MESSAGE_QUEUE_ERROR", "Market message queue failed", {
              streamId: this.config.id,
              source: this.config.source,
              source_exchange: this.config.source_exchange,
              connectionId: this.connectionId,
              reason: error instanceof Error ? error.message : "UNKNOWN_ERROR"
            });
          });
      });

      socket.addEventListener("close", (event) => {
        if (settled) {
          return;
        }

        this.markDisconnected(`CLOSE_${event.code}`);
        finish();
      });

      socket.addEventListener("error", () => {
        if (settled) {
          return;
        }

        this.markDisconnected("SOCKET_ERROR");
        finish(new Error("SOCKET_ERROR"));
      });

      resetWatchdog();

      void (async () => {
        try {
          if (this.shouldResetBookOnConnect(blackoutDurationMs, previousDisconnectReason)) {
            await this.resetEngineBook(blackoutDurationMs, recoveredAt);
          } else {
            await this.registerEngineConnection("STREAM_RECYCLED_NO_RESET", recoveredAt);
            this.logNormalProviderRecycle(
              "STREAM_RECOVERED_NO_RESET",
              "Provider stream recycled without book reset",
              {
                streamId: this.config.id,
                source: this.config.source,
                source_exchange: this.config.source_exchange,
                connectionId: this.connectionId,
                attempts: this.attempts,
                blackoutDurationMs,
                recoveredAt,
                previousDisconnectReason
              }
            );
          }
          if (this.config.snapshotUrl) {
            await this.syncEngineSnapshot("STREAM_CONNECTED", recoveredAt);
          }
          this.blackoutStartedAt = null;
          this.streamReady = true;
          this.hasConnectedOnce = true;
          this.sendSubscription(socket);
          await this.flushPreSnapshotBuffer();
        } catch (error) {
          this.lastError =
            error instanceof Error ? error.message : "SNAPSHOT_SYNC_FAILED";
          closeSocket(socket, 1011, "SNAPSHOT_SYNC_FAILED");
          this.markDisconnected("SNAPSHOT_SYNC_FAILED");
          finish(
            new Error(error instanceof Error ? error.message : "SNAPSHOT_SYNC_FAILED")
          );
        }
      })();
    });
  }

  private async connectGrpcOnce(): Promise<void> {
    if (isDwellirGrpcConfig(this.config)) {
      await this.connectDwellirGrpcOnce();
      return;
    }

    const endpoint = this.config.grpcEndpoint ?? this.clusterPool.activeUrl();
    const token = await this.resolveGrpcAuthToken();
    const heartbeatIntervalMs = this.config.heartbeatIntervalMs;
    const watchdogTimeoutMs = this.config.watchdogTimeoutMs;

    if (!token) {
      throw new Error("RPC_AUTH_TOKEN_MISSING");
    }

    const client = new HyperliquidGrpcClient({
      endpoint,
      token,
      authHeader:
        this.env.RPC_AUTH_HEADER ??
        (this.config.authHeader === DEFAULT_AUTH_HEADER
          ? DEFAULT_GRPC_AUTH_HEADER
          : this.config.authHeader),
      service: requireString(
        this.config.grpcService ?? this.env.RPC_GRPC_SERVICE,
        "RPC_GRPC_SERVICE"
      ),
      streamMethod: requireString(
        this.config.grpcStreamMethod ?? this.env.RPC_GRPC_STREAM_METHOD,
        "RPC_GRPC_STREAM_METHOD"
      ),
      pingMethod: this.config.grpcPingMethod ?? this.env.RPC_GRPC_PING_METHOD,
      subscribeType: requireString(
        this.config.grpcSubscribeType ?? this.env.RPC_GRPC_SUBSCRIBE_TYPE,
        "RPC_GRPC_SUBSCRIBE_TYPE"
      ),
      updateType: requireString(
        this.config.grpcUpdateType ?? this.env.RPC_GRPC_UPDATE_TYPE,
        "RPC_GRPC_UPDATE_TYPE"
      ),
      pingRequestType:
        this.config.grpcPingRequestType ?? this.env.RPC_GRPC_PING_REQUEST_TYPE,
      pingResponseType:
        this.config.grpcPingResponseType ?? this.env.RPC_GRPC_PING_RESPONSE_TYPE,
      streamTypes:
        this.config.grpcStreamTypes ??
        parseCsvList(this.env.RPC_GRPC_STREAM_TYPES, ["TRADES", "BOOK_UPDATES"]),
      coins: streamCoins(this.config),
      heartbeatIntervalMs
    });

    this.status = "CONNECTED";
    this.streamReady = true;
    this.preSnapshotBuffer = [];
    this.backoffCounter = 0;
    const recoveredAt = new Date().toISOString();
    const blackoutDurationMs = this.currentBlackoutDurationMs(recoveredAt);
    this.lastMessageAt = recoveredAt;
    this.lastRecoveredAt = recoveredAt;
    this.lastRecoveryDurationMs = blackoutDurationMs;
    this.lastError = null;

    this.logger.info("GRPC_STREAM_CONNECT", "Hyperliquid gRPC stream connected", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      sourceWeight: this.config.weight,
      connectionId: this.connectionId,
      streamHost: new URL(endpoint).host,
      watchdogTimeoutMs,
      heartbeatIntervalMs,
      descriptor: client.descriptorInfo()
    });
    this.clusterPool.recordHeartbeat(endpoint, 0);

    await this.resetEngineBook(blackoutDurationMs, recoveredAt);
    this.blackoutStartedAt = null;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const controller = new AbortController();
      this.grpcAbort = controller;

      const cleanup = () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        controller.abort("GRPC_STREAM_CLEANUP");
        if (this.grpcAbort === controller) {
          this.grpcAbort = null;
        }
      };

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      const fail = (reason: string, error?: unknown) => {
        this.markDisconnected(reason);
        this.clusterPool.recordFailure(endpoint);
        finish(
          error instanceof Error
            ? error
            : new Error(error === undefined ? reason : `${reason}:${String(error)}`)
        );
      };

      const resetWatchdog = () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
        }
        watchdog = setTimeout(() => {
          const staleForMs = this.lastMessageAt
            ? Date.now() - Date.parse(this.lastMessageAt)
            : Number.POSITIVE_INFINITY;

          this.logger.warn("STREAM_DISCONNECT", "gRPC stream watchdog timeout", {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            staleForMs,
            watchdogTimeoutMs
          });

          fail("GRPC_WATCHDOG_TIMEOUT");
        }, watchdogTimeoutMs);
      };

      resetWatchdog();

      void client
        .ping(controller.signal)
        .catch((error) => {
          this.logger.warn("GRPC_PING_FAILED", "Hyperliquid gRPC ping failed before stream read", {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            reason: error instanceof Error ? error.message : "UNKNOWN_ERROR"
          });
        })
        .then(() =>
          client.stream(async (update) => {
            resetWatchdog();
            await this.handleGrpcUpdate(update);
          }, controller.signal)
        )
        .then(() => finish())
        .catch((error) => fail("GRPC_STREAM_ERROR", error));
    });
  }

  private async connectDwellirGrpcOnce(): Promise<void> {
    const endpoint = resolveDwellirGrpcUrl(this.env, this.config);
    const apiKey = await this.resolveDwellirApiKey();
    const routeTokenConfigured = hasEndpointPath(endpoint);
    const streams = dwellirGrpcStreams(this.env, this.config);
    const watchdogTimeoutMs = dwellirGrpcWatchdogTimeoutMs(
      this.env,
      this.config,
      streams
    );
    const emitFatalDropOnWatchdog = shouldEmitDwellirGrpcFatalDrop(
      streams,
      this.env
    );
    const startTimestampMs = resolveDwellirStartTimestampMs(this.env);
    const startBlockHeight = readOptionalNumber(this.env.DWELLIR_GRPC_START_BLOCK_HEIGHT);

    if (!apiKey && !routeTokenConfigured) {
      throw new Error("DWELLIR_AUTH_MISSING");
    }

    const client = new DwellirHyperliquidGrpcClient({
      endpoint,
      apiKey,
      service: this.config.grpcService ?? DWELLIR_GRPC_SERVICE,
      startTimestampMs,
      startBlockHeight
    });
    this.status = "CONNECTED";
    this.streamReady = true;
    this.preSnapshotBuffer = [];
    this.backoffCounter = 0;
    const recoveredAt = new Date().toISOString();
    const blackoutDurationMs = this.currentBlackoutDurationMs(recoveredAt);
    this.lastMessageAt = recoveredAt;
    this.lastRecoveredAt = recoveredAt;
    this.lastRecoveryDurationMs = blackoutDurationMs;
    this.lastError = null;

    this.logger.info("DWELLIR_GRPC_STREAM_CONNECT", "Dwellir Hyperliquid gRPC stream connected", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      sourceWeight: this.config.weight,
      connectionId: this.connectionId,
      streamHost: new URL(endpoint).host,
      grpcPathConfigured: routeTokenConfigured,
      authMode: apiKey ? "api-key" : "route-token",
      watchdogTimeoutMs,
      emitFatalDropOnWatchdog,
      startTimestampMs,
      startBlockHeight,
      startLookbackMs:
        this.env.DWELLIR_GRPC_START_TIMESTAMP_MS || this.env.DWELLIR_GRPC_START_BLOCK_HEIGHT
          ? null
          : readNumber(
              this.env.DWELLIR_GRPC_START_LOOKBACK_MS,
              DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS
            ),
      streams: [...streams],
      descriptor: client.descriptorInfo()
    });
    this.clusterPool.recordHeartbeat(endpoint, 0);

    if (streams.has("ORDERBOOK_SNAPSHOT")) {
      await this.resetEngineBook(blackoutDurationMs, recoveredAt);
    } else {
      this.logger.info("STREAM_RECOVERED", "Market stream recovered", {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        attempts: this.attempts,
        blackoutDurationMs,
        recoveredAt,
        recoveryReason: this.blackoutStartedAt ? "STREAM_RECONNECTED" : "STREAM_CONNECTED"
      });
    }
    this.blackoutStartedAt = null;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const controller = new AbortController();
      this.grpcAbort = controller;

      const cleanup = () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        controller.abort("DWELLIR_GRPC_STREAM_CLEANUP");
        if (this.grpcAbort === controller) {
          this.grpcAbort = null;
        }
      };

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const fail = (reason: string, error?: unknown) => {
        this.markDisconnected(reason);
        this.clusterPool.recordFailure(endpoint);
        finish(
          error instanceof Error
            ? error
            : new Error(error === undefined ? reason : `${reason}:${String(error)}`)
        );
      };

      const resetWatchdog = () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
        }
        watchdog = setTimeout(() => {
          const staleForMs = this.lastMessageAt
            ? Date.now() - Date.parse(this.lastMessageAt)
            : Number.POSITIVE_INFINITY;

          this.logger.warn("STREAM_DISCONNECT", "Dwellir gRPC stream watchdog timeout", {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            staleForMs,
            watchdogTimeoutMs
          });

          if (emitFatalDropOnWatchdog) {
            void this.emitGrpcFatalDropIfNeeded(
              "DWELLIR_GRPC_WATCHDOG_TIMEOUT",
              staleForMs
            );
          } else {
            this.logger.info(
              "DWELLIR_GRPC_FILLS_IDLE_RECYCLE",
              "Dwellir fills stream idle watchdog recycled without quote evacuation",
              {
                streamId: this.config.id,
                source: this.config.source,
                source_exchange: this.config.source_exchange,
                connectionId: this.connectionId,
                staleForMs,
                watchdogTimeoutMs,
                streams: [...streams]
              }
            );
          }
          fail("DWELLIR_GRPC_WATCHDOG_TIMEOUT");
        }, watchdogTimeoutMs);
      };

      const onUpdate = async (update: DwellirGrpcPayload) => {
        resetWatchdog();
        await this.handleDwellirGrpcPayload(update);
      };

      resetWatchdog();

      const streamTasks: Promise<void>[] = [];
      if (streams.has("ORDERBOOK_SNAPSHOT")) {
        streamTasks.push(client.streamOrderbookSnapshots(onUpdate, controller.signal));
        streamTasks.push(
          this.pollDwellirGrpcOrderbookSnapshots(
            client,
            onUpdate,
            controller.signal
          )
        );
      }
      if (streams.has("FILLS")) {
        streamTasks.push(client.streamFills(onUpdate, controller.signal));
      }
      if (streams.has("BLOCK")) {
        streamTasks.push(client.streamBlocks(onUpdate, controller.signal));
      }

      // Snapshot streams may complete after a fresh book frame. Keep the
      // long-lived fills/block stream alive instead of recycling the whole
      // coordinator and repeatedly resetting the engine book.
      Promise.all(streamTasks.length > 0 ? streamTasks : [Promise.reject(new Error("DWELLIR_NO_STREAMS_CONFIGURED"))])
        .then(() => finish())
        .catch((error) => fail("DWELLIR_GRPC_STREAM_ERROR", error));
    });
  }

  private sendSubscription(socket: WebSocket): void {
    const subscriptions = [
      ...(this.config.subscriptions ?? []),
      ...(this.config.subscription ? [this.config.subscription] : [])
    ];

    if (subscriptions.length === 0) {
      return;
    }

    for (const subscription of subscriptions) {
      socket.send(
        typeof subscription === "string"
          ? subscription
          : JSON.stringify(subscription)
      );
    }
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (!this.streamReady) {
      this.bufferPreSnapshotMessage(data);
      return;
    }

    await this.processMessage(data);
  }

  private bufferPreSnapshotMessage(data: string | ArrayBuffer): void {
    if (this.preSnapshotBuffer.length >= PRE_SNAPSHOT_BUFFER_LIMIT) {
      this.preSnapshotBuffer.shift();
      this.ticksDropped += 1;

      if (this.ticksDropped <= 5 || this.ticksDropped % 100 === 0) {
        this.logger.warn("PRE_SNAPSHOT_BUFFER_OVERFLOW", "Dropped buffered stream packet before snapshot bridge", {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          bufferLimit: PRE_SNAPSHOT_BUFFER_LIMIT
        });
      }
    }

    this.preSnapshotBuffer.push(data);
  }

  private async flushPreSnapshotBuffer(): Promise<void> {
    const buffered = this.preSnapshotBuffer.splice(0);

    for (const message of buffered) {
      await this.processMessage(message);
    }
  }

  private async processMessage(data: string | ArrayBuffer): Promise<void> {
    this.messagesReceived += 1;
    this.lastMessageAt = new Date().toISOString();

    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const raw = parseJson<unknown>(text);

    if (!raw) {
      this.ticksDropped += 1;
      this.logger.warn("STREAM_PACKET_DROPPED", "Dropped malformed market packet", {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        reason: "INVALID_JSON"
      });
      return;
    }

    if (isPong(raw)) {
      this.clusterPool.recordHeartbeat(
        this.clusterPool.activeUrl(),
        extractHeartbeatLatencyMs(raw)
      );
      return;
    }

    if (this.config.source === "HYPERLIQUID") {
      const receivedAt = this.lastMessageAt ?? new Date().toISOString();
      const normalizedRaw = this.normalizeHyperliquidRawForEngine(raw, receivedAt);

      if (!normalizedRaw) {
        return;
      }

      this.observeHawkesFlow(normalizedRaw, receivedAt);
      await this.forwardHyperliquidRaw(normalizedRaw, receivedAt);
      return;
    }

    const events = extractMarketEvents(raw, this.config.source);

    const batch: MarketTick[] = [];

    for (const event of events) {
      try {
        const sequenceDecision = await this.evaluateProviderSequence(event);

        if (sequenceDecision === "SKIP") {
          continue;
        }

        if (sequenceDecision === "RESYNC") {
          return;
        }

        const ticks = this.expandSnapshotDeletes(
          normalizeMarketData(event, this.config, this.clockSync)
        );

        for (const tick of ticks) {
          const sequenced = this.sequenceTick(tick);

          if (this.shouldDropStaleTick(sequenced)) {
            continue;
          }

          batch.push(sequenced);
        }
      } catch (error) {
        this.ticksDropped += 1;
        this.logger.warn("STREAM_PACKET_DROPPED", "Dropped unnormalizable market packet", {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          reason: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        });
      }
    }

    if (batch.length > 0) {
      await this.forwardTicks(batch);
    }
  }

  private async handleGrpcUpdate(update: HyperliquidGrpcUpdate): Promise<void> {
    this.messagesReceived += 1;
    this.lastMessageAt = update.receivedAt;

    const raw = isRecord(update.providerData)
      ? update.providerData
      : isRecord(update.decoded)
        ? update.decoded
        : null;

    if (!raw) {
      this.ticksDropped += 1;
      this.logger.warn("GRPC_PACKET_DROPPED", "Dropped undecodable gRPC market packet", {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        streamType: update.streamType,
        reason: "UNSUPPORTED_PROVIDER_PAYLOAD"
      });
      return;
    }

    if (this.config.source === "HYPERLIQUID") {
      const normalizedRaw = this.normalizeHyperliquidRawForEngine(raw, update.receivedAt);

      if (!normalizedRaw) {
        return;
      }

      this.observeHawkesFlow(normalizedRaw, update.receivedAt);
      await this.forwardHyperliquidRaw(normalizedRaw, update.receivedAt);
      return;
    }

    await this.processMessage(JSON.stringify(raw));
  }

  private async handleDwellirGrpcPayload(update: DwellirGrpcPayload): Promise<void> {
    this.messagesReceived += 1;
    this.lastMessageAt = update.receivedAt;

    const maxBytes = readNumber(this.env.DWELLIR_MAX_PAYLOAD_BYTES, 160_000_000);
    if (update.data.byteLength > maxBytes) {
      this.ticksDropped += 1;
      this.logger.warn("DWELLIR_GRPC_PAYLOAD_DROPPED", "Dropped oversized Dwellir gRPC payload", {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        kind: update.kind,
        payloadBytes: update.data.byteLength,
        maxBytes
      });
      return;
    }

    const rawMessages = dwellirPayloadToHyperliquidRawMessages(
      update,
      this.config,
      streamCoins(this.config),
      readNumber(
        this.env.DWELLIR_GRPC_FORWARD_MAX_AGE_MS,
        DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS
      )
    );

    if (rawMessages.length === 0) {
      const malformedReason = classifyDwellirMalformedPayload(update);
      if (malformedReason) {
        this.ticksDropped += 1;
        this.logger.warn("DWELLIR_GRPC_PAYLOAD_DROPPED", "Dropped malformed Dwellir gRPC payload", {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          kind: update.kind,
          reason: malformedReason,
          payloadBytes: update.data.byteLength
        });
      }
      return;
    }

    for (const raw of rawMessages) {
      const normalizedRaw = this.normalizeHyperliquidRawForEngine(raw, update.receivedAt);

      if (!normalizedRaw) {
        continue;
      }

      this.observeHawkesFlow(normalizedRaw, update.receivedAt);
      await this.forwardHyperliquidRaw(normalizedRaw, update.receivedAt, "grpc");
    }
  }

  private normalizeHyperliquidRawForEngine(raw: unknown, receivedAt: string): unknown | null {
    if (!isRecord(raw) || normalizeString(raw.channel) !== "L4BOOK") {
      return raw;
    }

    const normalized = normalizeDwellirL4BookForEngine(
      raw,
      this.config,
      this.dwellirL4Orders,
      receivedAt,
      readNumber(this.env.DWELLIR_L4_ORDER_CACHE_LIMIT, 10_000)
    );

    if (!normalized) {
      this.ticksDropped += 1;

      if (this.ticksDropped <= 5 || this.ticksDropped % 100 === 0) {
        this.logger.warn("DWELLIR_L4_PACKET_DROPPED", "Dropped unsupported Dwellir L4 book packet", {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          reason: "UNSUPPORTED_L4BOOK_PAYLOAD"
        });
      }
    }

    return normalized;
  }

  private async pollDwellirGrpcOrderbookSnapshots(
    client: DwellirHyperliquidGrpcClient,
    onUpdate: (update: DwellirGrpcPayload) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    const pollIntervalMs = Math.max(
      250,
      readNumber(this.env.DWELLIR_GRPC_SNAPSHOT_POLL_MS, 1_000)
    );
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const snapshot = await client.getOrderBookSnapshot(Date.now(), signal);
        await onUpdate(snapshot);
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        consecutiveFailures += 1;
        this.logger.warn(
          "DWELLIR_GRPC_SNAPSHOT_POLL_FAILED",
          "Dwellir gRPC order-book snapshot poll failed",
          {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            consecutiveFailures,
            reason: error instanceof Error ? error.message : "UNKNOWN_ERROR"
          }
        );

        if (consecutiveFailures >= 3) {
          throw error instanceof Error
            ? error
            : new Error("DWELLIR_GRPC_SNAPSHOT_POLL_FAILED");
        }
      }

      await delay(pollIntervalMs, signal);
    }
  }

  private shouldDropStaleTick(tick: MarketTick): boolean {
    const maxAgeMs = readNumber(this.env.HL_STALE_AFTER_MS, DEFAULT_STALE_TICK_DROP_MS);
    const exchangeMs = Date.parse(tick.synchronizedExchangeTimestamp ?? tick.exchangeTimestamp);
    const receivedMs = Date.parse(tick.receivedAt);

    if (!Number.isFinite(exchangeMs) || !Number.isFinite(receivedMs)) {
      return false;
    }

    const ageMs = Math.max(0, receivedMs - exchangeMs);

    if (ageMs <= maxAgeMs) {
      return false;
    }

    this.ticksDropped += 1;

    if (this.ticksDropped <= 5 || this.ticksDropped % 100 === 0) {
      this.logger.warn("STALE_TICK_DROPPED", "Dropped stale market tick before engine forwarding", {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        instrumentCode: tick.instrumentCode,
        sequence: tick.sequence,
        ageMs,
        maxAgeMs,
        exchangeTimestamp: tick.exchangeTimestamp,
        receivedAt: tick.receivedAt
      });
    }

    return true;
  }

  private async syncEngineSnapshot(reason: string, observedAt: string): Promise<void> {
    if (this.snapshotSync) {
      await this.snapshotSync;
      return;
    }

    this.snapshotSync = (async () => {
      const snapshot = await this.fetchSnapshot(observedAt);
      await this.forwardSnapshot(snapshot);
      this.providerSequence = snapshot.sequence;
      this.awaitingProviderBridge = this.config.source === "BINANCE";
      this.logger.info("ORDER_BOOK_SNAPSHOT_SYNCED", "Market REST snapshot applied", {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        connectionId: this.connectionId,
        reason,
        exchangeCode: snapshot.exchangeCode,
        instrumentCode: snapshot.instrumentCode,
        sequence: snapshot.sequence,
        bidLevels: snapshot.bids.length,
        askLevels: snapshot.asks.length
      });
    })();

    try {
      await this.snapshotSync;
    } finally {
      this.snapshotSync = null;
    }
  }

  private sequenceTick(tick: MarketTick): MarketTick {
    this.syntheticSequence += 1;

    return {
      ...tick,
      sequence: this.syntheticSequence,
      raw: {
        ...(tick.raw ?? {}),
        providerSequence: String(tick.sequence),
        sequenceMode: "ingest-local"
      }
    };
  }

  private expandSnapshotDeletes(ticks: MarketTick[]): MarketTick[] {
    if (
      this.config.source !== "HYPERLIQUID" ||
      ticks.length === 0 ||
      ticks[0]?.raw?.eventType !== "l2Book"
    ) {
      return ticks;
    }

    const byMarket = new Map<string, {
      template: MarketTick;
      bids: Set<string>;
      asks: Set<string>;
    }>();

    for (const tick of ticks) {
      const marketKey = buildMarketKey(tick.source_exchange, tick.instrumentCode);
      const entry = byMarket.get(marketKey) ?? {
        template: tick,
        bids: new Set<string>(),
        asks: new Set<string>()
      };
      const priceKey = formatPriceKey(tick.price);

      if (tick.side === "buy") {
        entry.bids.add(priceKey);
      } else if (tick.side === "sell") {
        entry.asks.add(priceKey);
      }

      byMarket.set(marketKey, entry);
    }

    const deletes: MarketTick[] = [];

    for (const [marketKey, current] of byMarket) {
      const previous = this.hyperliquidBookLevels.get(marketKey);

      if (previous) {
        for (const price of previous.bids) {
          if (!current.bids.has(price)) {
            deletes.push(createDeleteTick(current.template, "buy", Number(price)));
          }
        }

        for (const price of previous.asks) {
          if (!current.asks.has(price)) {
            deletes.push(createDeleteTick(current.template, "sell", Number(price)));
          }
        }
      }

      this.hyperliquidBookLevels.set(marketKey, {
        bids: current.bids,
        asks: current.asks
      });
    }

    return [...ticks, ...deletes];
  }

  private async evaluateProviderSequence(
    event: unknown
  ): Promise<"PROCESS" | "SKIP" | "RESYNC"> {
    if (this.config.source !== "BINANCE") {
      return "PROCESS";
    }

    const window = readBinanceSequenceWindow(event);

    if (!window || this.providerSequence === null) {
      return "PROCESS";
    }

    if (window.finalUpdateId <= this.providerSequence) {
      return "SKIP";
    }

    const expectedNextUpdateId = this.providerSequence + 1;

    if (this.awaitingProviderBridge) {
      if (
        window.firstUpdateId <= expectedNextUpdateId &&
        expectedNextUpdateId <= window.finalUpdateId
      ) {
        this.providerSequence = window.finalUpdateId;
        this.awaitingProviderBridge = false;
        return "PROCESS";
      }

      await this.handleProviderSequenceGap(
        "BINANCE_SNAPSHOT_BRIDGE_GAP",
        window,
        expectedNextUpdateId
      );
      return "RESYNC";
    }

    if (window.firstUpdateId > expectedNextUpdateId) {
      await this.handleProviderSequenceGap(
        "BINANCE_DIFF_SEQUENCE_GAP",
        window,
        expectedNextUpdateId
      );
      return "RESYNC";
    }

    this.providerSequence = window.finalUpdateId;
    return "PROCESS";
  }

  private async handleProviderSequenceGap(
    reason: string,
    window: BinanceSequenceWindow,
    expectedNextUpdateId: number
  ): Promise<void> {
    this.ticksDropped += 1;
    this.logger.warn("PROVIDER_SEQUENCE_GAP", "Provider sequence gap detected; resyncing book", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      reason,
      expectedNextUpdateId,
      firstUpdateId: window.firstUpdateId,
      finalUpdateId: window.finalUpdateId,
      providerSequence: this.providerSequence
    });

    await this.recoverFromEngineDesync(reason);
  }

  private async fetchSnapshot(receivedAt: string): Promise<OrderBookSnapshot> {
    const snapshotUrl = requireString(this.config.snapshotUrl, "SNAPSHOT_URL");
    const apiKey = this.config.apiKeyEnv
      ? readEnvSecret(this.env, this.config.apiKeyEnv)
      : null;
    const headers: Record<string, string> = { accept: "application/json" };

    if (apiKey) {
      headers[this.config.authHeader] = apiKey;
    }

    const response = await fetch(snapshotUrl, { headers });

    if (!response.ok) {
      throw new Error(`${this.config.source}_SNAPSHOT_FETCH_FAILED_${response.status}`);
    }

    const snapshot = normalizeRestOrderBookSnapshot(
      await response.json<unknown>(),
      receivedAt,
      this.config
    );

    return this.config.source === "BINANCE"
      ? snapshot
      : {
          ...snapshot,
          sequence: this.syntheticSequence
        };
  }

  private async forwardSnapshot(snapshot: OrderBookSnapshot): Promise<void> {
    const engine = getTradingEngineStub(this.env);
    const response = await engine.fetch(
      new Request("https://trading-engine.internal/book/snapshot", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "sovereign-sigma-ingest"
        },
        body: JSON.stringify(snapshot)
      })
    );

    if (!response.ok) {
      throw new Error(`ENGINE_SNAPSHOT_APPLY_FAILED_${response.status}`);
    }
  }

  private async forwardTick(tick: MarketTick): Promise<void> {
    await this.forwardTicks([tick]);
  }

  private async forwardTicks(ticks: MarketTick[]): Promise<void> {
    const engine = getTradingEngineStub(this.env);
    const response = await engine.fetch(
      new Request("https://trading-engine.internal/ticks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "sovereign-sigma-ingest"
        },
        body: JSON.stringify({ ticks })
      })
    );
    const payload = await readResponseJson<EngineTickResponse>(response);

    if (payload?.status === "DESYNC" || response.status === 409) {
      await this.recoverFromEngineDesync(payload?.reason ?? "DESYNC");
      this.ticksForwarded += payload?.processedCount ?? 0;
      this.lastForwardAt = new Date().toISOString();
      return;
    }

    if (!response.ok) {
      throw new Error(`ENGINE_FORWARD_FAILED_${response.status}`);
    }

    this.ticksForwarded += payload?.processedCount ?? ticks.length;
    this.lastForwardAt = new Date().toISOString();
  }

  private async forwardHyperliquidRaw(
    raw: unknown,
    receivedAt: string,
    transport: "websocket" | "grpc" = this.config.transport
  ): Promise<void> {
    if (isHyperliquidControlMessage(raw)) {
      return;
    }

    const engine = getTradingEngineStub(this.env);
    const response = await engine.fetch(
      new Request("https://trading-engine.internal/hyperliquid/raw", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "sovereign-sigma-ingest"
        },
        body: JSON.stringify({
          streamId: this.config.id,
          source: "HYPERLIQUID",
          source_exchange: this.config.source_exchange,
          exchangeCode: this.config.exchangeCode,
          instrumentCode: this.config.instrumentCode,
          sourceWeight: this.config.weight,
          transport,
          connectionId: this.connectionId,
          receivedAt,
          raw
        })
      })
    );
    const payload = await readResponseJson<EngineTickResponse>(response);

    if (payload?.status === "DESYNC" || response.status === 409) {
      await this.recoverFromEngineDesync(payload?.reason ?? "DESYNC");
      this.ticksForwarded += payload?.processedCount ?? 0;
      this.lastForwardAt = new Date().toISOString();
      return;
    }

    if (!response.ok) {
      throw new Error(`ENGINE_RAW_FORWARD_FAILED_${response.status}`);
    }

    this.ticksForwarded += payload?.processedCount ?? 1;
    this.lastForwardAt = new Date().toISOString();
  }

  private observeHawkesFlow(raw: unknown, receivedAt: string): void {
    if (!isRecord(raw) || normalizeString(raw.channel) !== "TRADES") {
      return;
    }

    const data = Array.isArray(raw.data)
      ? raw.data
      : isRecord(raw.data) && Array.isArray(raw.data.trades)
        ? raw.data.trades
        : [];

    for (const item of data) {
      if (!isRecord(item)) {
        continue;
      }

      const coin = stringifyOrNull(item.coin) ?? this.config.instrumentCode?.replace(/-usd$/i, "");
      const normalizedCoin = coin?.toUpperCase();
      if (!normalizedCoin) {
        continue;
      }

      const instrumentCode = hyperliquidInstrumentCode(normalizedCoin, this.config.instrumentCode);
      const tradeMs =
        Date.parse(coerceExchangeTime(item.time ?? item.timestamp) ?? receivedAt);
      const side = hawkesTradeSide(item);
      const size = Number(item.sz ?? item.size);
      const observation = this.hawkesTracker.observe({
        instrumentCode,
        side,
        size: Number.isFinite(size) ? size : 0,
        observedAtMs: Number.isFinite(tradeMs) ? tradeMs : Date.parse(receivedAt),
        receivedAt
      });

      if (!observation.triggered) {
        continue;
      }

      this.waitUntil(this.forwardHawkesSignal(observation));
    }
  }

  private async forwardHawkesSignal(observation: HawkesFlowObservation): Promise<void> {
    const observedAt = observation.receivedAt;
    const signal: AgentSignal = {
      signalId: crypto.randomUUID(),
      traceId: `ingest:hawkes:${this.config.id}:${observation.instrumentCode}:${observation.observedAtMs}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: observation.instrumentCode,
      action: "PAUSE",
      confidence: observation.confidence,
      horizonMs: observation.cooldownMs,
      expectedValue: -observation.intensity,
      maxSlippageBps: 100,
      rationale:
        `Hawkes trade-arrival intensity ${observation.intensity.toFixed(4)} exceeded rolling p95 ` +
        `${observation.threshold.toFixed(4)}; pull ${observation.pullSide} quotes.`,
      featureVector: {
        signalType: "HAWKES_FLOW_CLUSTER",
        lambda: observation.intensity,
        p95: observation.threshold,
        flowSide: observation.side,
        pullSide: observation.pullSide,
        size: observation.size,
        baselineMu: observation.baselineMu,
        jumpBeta: observation.jumpBeta,
        decayAlpha: observation.decayAlpha
      },
      riskContext: {
        recommendation: "CANCEL_OPPOSITE_SIDE_RESTING_QUOTES_AND_HALT_60S",
        inventoryProtocol: "POST_ONLY_SKEW",
        sourceStream: this.config.id,
        transport: this.config.transport
      },
      createdAt: observedAt
    };

    try {
      const engine = getTradingEngineStub(this.env);
      const response = await engine.fetch(
        new Request("https://trading-engine.internal/agent/signal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-source": "sovereign-sigma-ingest"
          },
          body: JSON.stringify(signal)
        })
      );

      if (!response.ok) {
        this.logger.warn("HAWKES_SIGNAL_FORWARD_FAILED", "Engine rejected Hawkes evacuation signal", {
          streamId: this.config.id,
          instrumentCode: observation.instrumentCode,
          status: response.status,
          intensity: observation.intensity,
          threshold: observation.threshold
        });
      }
    } catch (error) {
      this.logger.warn("HAWKES_SIGNAL_FORWARD_FAILED", "Failed to forward Hawkes evacuation signal", {
        streamId: this.config.id,
        instrumentCode: observation.instrumentCode,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }

  private async resolveGrpcAuthToken(): Promise<string | null> {
    const direct = this.env.RPC_AUTH_TOKEN?.trim();
    if (direct) {
      return direct;
    }

    const key = (this.env.RPC_AUTH_TOKEN_KV_KEY ?? "RPC_AUTH_TOKEN").trim();
    const vault = this.env.SECRET_VAULT ?? this.env.RISK_VAULT;
    const vaulted = await vault.get(key);
    const token = vaulted?.trim();
    return token && token.length > 0 ? token : null;
  }

  private async resolveDwellirApiKey(): Promise<string | null> {
    const direct = this.env.DWELLIR_API_KEY?.trim();
    if (direct) {
      return direct;
    }

    const token = await this.resolveGrpcAuthToken();
    if (token) {
      return token;
    }

    const vaulted = await (this.env.SECRET_VAULT ?? this.env.RISK_VAULT).get("DWELLIR_API_KEY");
    const key = vaulted?.trim();
    return key && key.length > 0 ? key : null;
  }

  private async recoverFromEngineDesync(reason: string): Promise<void> {
    const observedAt = new Date().toISOString();

    this.logger.warn("ENGINE_DESYNC_RESYNC", "Engine requested snapshot resync", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      reason,
      observedAt
    });

    try {
      if (!this.config.snapshotUrl) {
        await this.resetEngineBook(0, observedAt);
        return;
      }

      await this.syncEngineSnapshot("ENGINE_DESYNC", observedAt);
    } catch (error) {
      closeSocket(this.socket, 1011, "SNAPSHOT_RESYNC_FAILED");
      this.markDisconnected("SNAPSHOT_RESYNC_FAILED");
      throw error;
    }
  }

  private async emitGrpcFatalDropIfNeeded(
    reason: string,
    observedDisconnectedForMs = this.currentBlackoutDurationMs()
  ): Promise<void> {
    if (this.config.transport !== "grpc") {
      return;
    }

    const disconnectedForMs = Math.max(0, observedDisconnectedForMs);
    const thresholdMs = this.config.grpcFatalDropMs;

    if (disconnectedForMs < thresholdMs) {
      return;
    }

    const observedAt = new Date().toISOString();
    if (
      this.lastFatalDropAt &&
      this.blackoutStartedAt &&
      Date.parse(this.lastFatalDropAt) >= Date.parse(this.blackoutStartedAt)
    ) {
      return;
    }

    this.lastFatalDropAt = observedAt;
    this.logger.error("GRPC_FATAL_DROP", "Dwellir gRPC stream blackout exceeded fatal threshold", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      reason,
      disconnectedForMs,
      thresholdMs
    });
    this.notifier.notify({
      priority: "CRITICAL",
      title: "Sovereign-Sigma gRPC fatal drop",
      message: `${this.config.source_exchange} gRPC disconnected for ${disconnectedForMs}ms; forcing quote evacuation.`,
      dedupeKey: `grpc-fatal-drop:${this.config.id}`,
      metadata: {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        reason,
        disconnectedForMs,
        thresholdMs
      }
    });

    try {
      const engine = getTradingEngineStub(this.env);
      const response = await engine.fetch(
        new Request("https://trading-engine.internal/ingest/grpc-fatal-drop", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-source": "sovereign-sigma-ingest"
          },
          body: JSON.stringify({
            streamId: this.config.id,
            source: "DWELLIR_GRPC",
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            reason,
            disconnectedForMs,
            thresholdMs,
            observedAt
          })
        })
      );

      if (!response.ok) {
        this.logger.error("GRPC_FATAL_DROP_FORWARD_FAILED", "Engine rejected fatal gRPC drop signal", {
          streamId: this.config.id,
          status: response.status,
          reason
        });
      }
    } catch (error) {
      this.logger.error("GRPC_FATAL_DROP_FORWARD_FAILED", "Failed to forward fatal gRPC drop signal", {
        streamId: this.config.id,
        reason,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }

  private async resetEngineBook(
    blackoutDurationMs: number,
    recoveredAt: string
  ): Promise<void> {
    const engine = getTradingEngineStub(this.env);
    const payload: OrderBookResetRequest = {
      source: "INGEST_WORKER",
      reason: this.blackoutStartedAt ? "STREAM_RECONNECTED" : "STREAM_CONNECTED",
      streamId: this.config.id,
      instrumentCode: resetInstrumentForStream(this.config),
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      blackoutDurationMs,
      recoveredAt
    };
    const response = await engine.fetch(
      new Request("https://trading-engine.internal/reset-book", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "sovereign-sigma-ingest"
        },
        body: JSON.stringify(payload)
      })
    );

    if (!response.ok) {
      throw new Error(`ENGINE_RESET_BOOK_FAILED_${response.status}`);
    }

    this.logger.info("STREAM_RECOVERED", "Market stream recovered and book reset", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      attempts: this.attempts,
      blackoutDurationMs,
      recoveredAt,
      recoveryReason: payload.reason
    });
    this.notifier.notify({
      priority: blackoutDurationMs > 0 ? "MEDIUM" : "LOW",
      title: "Sovereign-Sigma stream recovered",
      message: `${this.config.source_exchange} stream recovered; order book reset complete after ${blackoutDurationMs}ms blackout.`,
      dedupeKey: `stream-recovered:${this.config.id}`,
      metadata: {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        blackoutDurationMs,
        recoveredAt,
        recoveryReason: payload.reason
      }
    });
  }

  private async registerEngineConnection(reason: string, observedAt: string): Promise<void> {
    if (!this.connectionId) {
      return;
    }

    const engine = getTradingEngineStub(this.env);
    const response = await engine.fetch(
      new Request("https://trading-engine.internal/ingest/connection", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "sovereign-sigma-ingest"
        },
        body: JSON.stringify({
          source: "INGEST_WORKER",
          reason,
          streamId: this.config.id,
          instrumentCode: resetInstrumentForStream(this.config),
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          recoveredAt: observedAt
        })
      })
    );

    if (!response.ok) {
      throw new Error(`ENGINE_REGISTER_CONNECTION_FAILED_${response.status}`);
    }
  }

  private markDisconnected(reason: string): void {
    this.status = this.stopped ? "STOPPED" : "ERROR";
    this.lastDisconnectAt = new Date().toISOString();
    this.lastError = reason;
    this.socket = null;
    this.startBlackout(this.lastDisconnectAt);

    const metadata = {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      reason,
      messagesReceived: this.messagesReceived,
      ticksForwarded: this.ticksForwarded,
      ticksDropped: this.ticksDropped
    };

    if (this.isNormalProviderRecycle(reason)) {
      this.logNormalProviderRecycle(
        "STREAM_RECYCLE",
        "Provider closed stream normally; fast recycle active",
        metadata
      );
      return;
    }

    this.logger.warn("STREAM_DISCONNECT", "Market stream disconnected", metadata);
    this.notifier.notify({
      priority: "HIGH",
      title: "Sovereign-Sigma stream disconnected",
      message: `${this.config.source_exchange} stream disconnected: ${reason}. Recovery state machine is active.`,
      dedupeKey: `stream-disconnect:${this.config.id}`,
      metadata
    });
  }

  private shouldResetBookOnConnect(
    blackoutDurationMs: number,
    previousDisconnectReason: string | null
  ): boolean {
    if (!this.hasConnectedOnce) {
      return true;
    }
    if (!this.isNormalProviderRecycle(previousDisconnectReason)) {
      return true;
    }

    return blackoutDurationMs > Math.max(
      1_000,
      readNumber(this.env.DWELLIR_GRPC_FATAL_DROP_MS, DEFAULT_GRPC_FATAL_DROP_MS)
    );
  }

  private isNormalProviderRecycle(reason = this.lastError): boolean {
    return (
      this.config.source === "HYPERLIQUID" &&
      this.config.transport === "websocket" &&
      this.config.id.startsWith("dwellir-hyperliquid-orderbook") &&
      reason === "CLOSE_1000"
    );
  }

  private logNormalProviderRecycle(
    eventType: string,
    message: string,
    metadata: Record<string, unknown>
  ): void {
    const now = Date.now();
    const previous = this.normalRecycleLogAt.get(eventType) ?? 0;

    if (now - previous < NORMAL_RECYCLE_LOG_THROTTLE_MS) {
      return;
    }

    this.normalRecycleLogAt.set(eventType, now);
    this.logger.info(eventType, message, metadata as JsonRecord);
  }

  private startBlackout(startedAt: string = new Date().toISOString()): void {
    if (!this.blackoutStartedAt) {
      this.blackoutStartedAt = startedAt;
    }

    this.lastDisconnectAt = startedAt;
  }

  private currentBlackoutDurationMs(at: string = new Date().toISOString()): number {
    if (!this.blackoutStartedAt) {
      return 0;
    }

    return Math.max(0, Date.parse(at) - Date.parse(this.blackoutStartedAt));
  }
}

function getHealth(activeStreams: Map<string, ExchangeStreamController>): IngestHealth {
  const streams = Array.from(activeStreams.values()).map((stream) => stream.snapshot());

  if (streams.length === 0) {
    return {
      ok: false,
      status: "IDLE",
      connectionId: null,
      attempts: 0,
      backoffCounter: 0,
      messagesReceived: 0,
      ticksForwarded: 0,
      ticksDropped: 0,
      lastMessageAt: null,
      lastForwardAt: null,
      lastDisconnectAt: null,
      blackoutStartedAt: null,
      lastRecoveredAt: null,
      lastRecoveryDurationMs: null,
      lastError: null,
      subscriptionProfile: undefined,
      streams: []
    };
  }

  const primary = streams.find((stream) => stream.ok) ?? streams[0];

  return {
    ...primary,
    ok: streams.every((stream) => stream.ok),
    status: streams.every((stream) => stream.ok) ? "CONNECTED" : primary.status,
    subscriptionProfile: aggregateSubscriptionProfile(streams),
    streams
  };
}

function aggregateSubscriptionProfile(
  streams: ExchangeStreamHealth[]
): MarketDataSubscriptionProfile | undefined {
  const profiles = streams
    .map((stream) => stream.subscriptionProfile)
    .filter((profile): profile is MarketDataSubscriptionProfile => Boolean(profile));

  if (profiles.length === 0) {
    return undefined;
  }

  const primary = profiles.find((profile) => profile.provider === "DWELLIR") ?? profiles[0];
  const maxBookDepth = Math.max(...profiles.map((profile) => profile.maxBookDepth));
  const bookDepth = Math.max(...profiles.map((profile) => profile.bookDepth));
  const l4BookEnabled = profiles.some((profile) => profile.l4BookEnabled);
  const assetCount = Math.max(...profiles.map((profile) => profile.assetCount));
  const reasons = [...new Set(profiles.map((profile) => profile.reason).filter(Boolean))];

  return {
    ...primary,
    readMode: l4BookEnabled
      ? primary.readMode === "DWELLIR_GRPC_FILLS_L2_BOOK_GRPC" ||
        primary.readMode === "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
        ? "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
        : "DWELLIR_GRPC_FILLS_L4_BOOK_WS"
      : primary.readMode,
    bookDepth,
    maxBookDepth,
    l4BookEnabled,
    assetCount,
    optimization:
      bookDepth >= maxBookDepth && !profiles.some((profile) => profile.optimization === "CONSERVATIVE")
        ? "MAXIMIZED"
        : primary.optimization,
    normalMode: profiles.every((profile) => profile.normalMode),
    reason: reasons.join("; ")
  };
}

function normalizeMarketData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  switch (config.source) {
    case "BINANCE":
      return normalizeBinanceData(raw, config, clockSync);
    case "HYPERLIQUID":
      return normalizeHyperliquidData(raw, config, clockSync);
    case "COINBASE":
      return normalizeCoinbaseData(raw, config, clockSync);
    default:
      return [normalizeGenericExchangeData(raw, config, clockSync)];
  }
}

function normalizeRestOrderBookSnapshot(
  raw: unknown,
  receivedAt: string,
  config: ResolvedExchangeStreamConfig
): OrderBookSnapshot {
  if (!isRecord(raw)) {
    throw new Error("INVALID_REST_SNAPSHOT");
  }

  const instrumentCode = (
    readStringField(raw, ["instrumentCode", "instrument_code", "instrument", "symbol"]) ??
    config.instrumentCode
  )?.toLowerCase();
  const exchangeCode = (
    readStringField(raw, ["exchange", "exchangeCode", "exchange_code"]) ??
    config.exchangeCode ??
    config.source_exchange
  )?.toLowerCase();

  if (!instrumentCode) {
    throw new Error("MISSING_SNAPSHOT_INSTRUMENT");
  }

  if (!exchangeCode) {
    throw new Error("MISSING_SNAPSHOT_EXCHANGE");
  }

  const exchangeTimestamp =
    coerceTimestamp(readField(raw, ["timestamp", "time", "ts", "tsExchange"])) ??
    receivedAt;

  return {
    schemaVersion: "order-book.snapshot.v1",
    source: config.source,
    source_exchange: normalizeSourceExchange(config.source_exchange, exchangeCode),
    exchangeCode,
    instrumentCode,
    marketKey: buildMarketKey(config.source_exchange, instrumentCode),
    sourceWeight: normalizeWeight(config.weight),
    sequence: coerceSnapshotSequence(raw),
    exchangeTimestamp,
    receivedAt,
    bids: normalizeSnapshotLevels(readSnapshotLevels(raw, "bid"), receivedAt),
    asks: normalizeSnapshotLevels(readSnapshotLevels(raw, "ask"), receivedAt)
  };
}

function normalizeHyperliquidData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  if (!isRecord(raw)) {
    throw new Error("INVALID_HYPERLIQUID_PAYLOAD");
  }

  const channel = normalizeString(readField(raw, ["channel"]));

  if (channel === "SUBSCRIPTIONRESPONSE" || channel === "POST" || channel === "PONG") {
    return [];
  }

  if (channel === "L2BOOK") {
    return normalizeHyperliquidL2Book(raw, config, clockSync);
  }

  if (channel === "TRADES") {
    return normalizeHyperliquidTrades(raw, config, clockSync);
  }

  if (channel === "ACTIVEASSETCTX" || channel === "ALLDEXSASSETCTXS") {
    return normalizeHyperliquidAssetContext(raw, config, clockSync);
  }

  return [];
}

function normalizeHyperliquidL2Book(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  const data = readHyperliquidObject(raw);
  const receivedAt = new Date().toISOString();
  const coin = requireString(readField(data, ["coin"]) ?? config.instrumentCode, "coin");
  const instrumentCode = hyperliquidInstrumentCode(coin, config.instrumentCode);
  const exchangeTimestamp =
    coerceExchangeTime(readField(data, ["time", "timestamp"])) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const sequenceSeed = coerceGenericSequence(readField(data, ["time", "sequence", "seq"]));
  const [bidLevels, askLevels] = normalizeHyperliquidBookSides(
    readField(data, ["levels"]),
    resolveBookDepthLimit(config)
  );
  const ticks: MarketTick[] = [];

  for (const [price, size, orderCount] of bidLevels) {
    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size,
        side: "buy",
        sequence: sequenceSeed + ticks.length,
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "l2Book",
          commodity: "ORDER_BOOK",
          depthSide: "bid",
          orderCount,
          coin
        }
      })
    );
  }

  for (const [price, size, orderCount] of askLevels) {
    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size,
        side: "sell",
        sequence: sequenceSeed + ticks.length,
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "l2Book",
          commodity: "ORDER_BOOK",
          depthSide: "ask",
          orderCount,
          coin
        }
      })
    );
  }

  if (ticks.length === 0) {
    throw new Error("EMPTY_HYPERLIQUID_L2BOOK");
  }

  return ticks;
}

function normalizeHyperliquidTrades(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  const payload = readHyperliquidData(raw);
  const trades = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.trades)
      ? payload.trades
      : [payload];
  const receivedAt = new Date().toISOString();
  const ticks: MarketTick[] = [];

  for (const trade of trades) {
    if (!isRecord(trade)) {
      continue;
    }

    const coin = requireString(readField(trade, ["coin"]) ?? config.instrumentCode, "coin");
    const instrumentCode = hyperliquidInstrumentCode(coin, config.instrumentCode);
    const price = requireFiniteNumber(readField(trade, ["px", "price", "p"]), "price");
    const size = requireFiniteNumber(readField(trade, ["sz", "size", "q"]), "size");
    const exchangeTimestamp =
      coerceExchangeTime(readField(trade, ["time", "timestamp", "ts"])) ?? receivedAt;
    const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
    const side = hyperliquidTradeSide(readField(trade, ["side"]));

    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size,
        side,
        sequence: coerceGenericSequence(readField(trade, ["tid", "id", "hash", "time"])) + ticks.length,
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "trade",
          commodity: "TRADE",
          coin,
          tradeId: stringifyOrNull(readField(trade, ["tid", "id"])),
          tradeHash: stringifyOrNull(readField(trade, ["hash"])),
          aggressorSide: stringifyOrNull(readField(trade, ["side"]))
        }
      })
    );
  }

  return ticks;
}

function normalizeHyperliquidAssetContext(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  const payload = readHyperliquidData(raw);
  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.ctxs)
      ? payload.ctxs
      : [payload];
  const receivedAt = new Date().toISOString();
  const ticks: MarketTick[] = [];

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }

    const ctx = isRecord(item.ctx) ? item.ctx : item;
    const coin = requireString(readField(item, ["coin"]) ?? config.instrumentCode, "coin");
    const instrumentCode = hyperliquidInstrumentCode(coin, config.instrumentCode);
    const markPrice = finiteOrNull(readField(ctx, ["markPx", "markPrice"]));
    const oraclePrice = finiteOrNull(readField(ctx, ["oraclePx", "oraclePrice"]));
    const midPrice = finiteOrNull(readField(ctx, ["midPx", "midPrice"]));
    const price = midPrice ?? markPrice ?? oraclePrice ?? 0;
    const fundingRateHourly = finiteOrNull(readField(ctx, ["funding", "fundingRate"])) ?? 0;
    const exchangeTimestamp =
      coerceExchangeTime(readField(item, ["time", "timestamp"])) ?? receivedAt;
    const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);

    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size: 0,
        side: "unknown",
        sequence: coerceGenericSequence(`${coin}:${exchangeTimestamp}:funding`),
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "funding",
          commodity: "FUNDING",
          coin,
          fundingRateHourly,
          markPrice,
          oraclePrice,
          openInterest: finiteOrNull(readField(ctx, ["openInterest"])),
          dayNtlVlm: finiteOrNull(readField(ctx, ["dayNtlVlm"]))
        }
      })
    );
  }

  return ticks;
}

function normalizeBinanceData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  if (!isRecord(raw)) {
    throw new Error("INVALID_BINANCE_PAYLOAD");
  }

  const receivedAt = new Date().toISOString();
  const eventType = normalizeString(readField(raw, ["e", "eventType", "type"]));
  const symbol = String(
    readField(raw, ["s", "symbol", "instrument", "instrumentCode"]) ??
      config.instrumentCode ??
      ""
  ).toLowerCase();
  const instrumentCode = normalizeInstrumentCode(symbol);
  const eventTime = readField(raw, ["E", "eventTime", "time", "timestamp"]);
  const exchangeTimestamp = coerceExchangeTime(eventTime) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const sequence = coerceGenericSequence(readField(raw, ["u", "U", "t", "sequence", "seq"]));

  const bidUpdates = readField(raw, ["b", "bids"]);
  const askUpdates = readField(raw, ["a", "asks"]);

  if (
    eventType === "DEPTHUPDATE" ||
    Array.isArray(bidUpdates) ||
    Array.isArray(askUpdates)
  ) {
    const ticks: MarketTick[] = [];

    for (const [price, size] of normalizeDepthLevels(bidUpdates)) {
      ticks.push(
        createUniversalTick({
          config,
          instrumentCode,
          price,
          size,
          side: "buy",
          sequence: sequence + ticks.length,
          exchangeTimestamp,
          synchronized,
          receivedAt,
          rawMetadata: {
            eventType: eventType ?? "DEPTHUPDATE",
            depthSide: "bid",
            ...(readBinanceSequenceWindow(raw) ?? {})
          }
        })
      );
    }

    for (const [price, size] of normalizeDepthLevels(askUpdates)) {
      ticks.push(
        createUniversalTick({
          config,
          instrumentCode,
          price,
          size,
          side: "sell",
          sequence: sequence + ticks.length,
          exchangeTimestamp,
          synchronized,
          receivedAt,
          rawMetadata: {
            eventType: eventType ?? "DEPTHUPDATE",
            depthSide: "ask",
            ...(readBinanceSequenceWindow(raw) ?? {})
          }
        })
      );
    }

    if (ticks.length === 0) {
      throw new Error("EMPTY_BINANCE_DEPTH_UPDATE");
    }

    return ticks;
  }

  const price = requireFiniteNumber(readField(raw, ["p", "price"]), "price");
  const size = requireFiniteNumber(readField(raw, ["q", "quantity", "size"]), "size");
  const isBuyerMaker = Boolean(readField(raw, ["m", "buyerMaker"]));

  return [
    createUniversalTick({
      config,
      instrumentCode,
      price,
      size,
      side: isBuyerMaker ? "sell" : "buy",
      sequence,
      exchangeTimestamp,
      synchronized,
      receivedAt,
      rawMetadata: { eventType: eventType ?? "TRADE" }
    })
  ];
}

function readBinanceSequenceWindow(raw: unknown): BinanceSequenceWindow | null {
  if (!isRecord(raw)) {
    return null;
  }

  const firstUpdateId = Number(readField(raw, ["U", "firstUpdateId"]));
  const finalUpdateId = Number(readField(raw, ["u", "lastUpdateId", "finalUpdateId"]));

  if (
    Number.isSafeInteger(firstUpdateId) &&
    firstUpdateId >= 0 &&
    Number.isSafeInteger(finalUpdateId) &&
    finalUpdateId >= firstUpdateId
  ) {
    return { firstUpdateId, finalUpdateId };
  }

  return null;
}

function normalizeCoinbaseData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  if (!isRecord(raw)) {
    throw new Error("INVALID_COINBASE_PAYLOAD");
  }

  const receivedAt = new Date().toISOString();
  const instrumentCode = normalizeInstrumentCode(
    String(
      readField(raw, ["product_id", "productId", "instrument", "instrumentCode"]) ??
        config.instrumentCode ??
        ""
    )
  );
  const exchangeTimestamp = coerceTimestamp(readField(raw, ["time", "timestamp"])) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const changes = readField(raw, ["changes", "updates"]);

  if (Array.isArray(changes)) {
    const ticks: MarketTick[] = [];

    for (const change of changes) {
      const normalized = normalizeCoinbaseChange(change);

      if (!normalized) {
        continue;
      }

      ticks.push(
        createUniversalTick({
          config,
          instrumentCode,
          price: normalized.price,
          size: normalized.size,
          side: normalized.side,
          sequence: coerceGenericSequence(readField(raw, ["sequence", "sequence_num"])) + ticks.length,
          exchangeTimestamp,
          synchronized,
          receivedAt,
          rawMetadata: { eventType: stringifyOrNull(readField(raw, ["type"])) ?? "l2update" }
        })
      );
    }

    if (ticks.length > 0) {
      return ticks;
    }
  }

  return [normalizeGenericExchangeData(raw, config, clockSync)];
}

function normalizeGenericExchangeData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick {
  if (!isRecord(raw)) {
    throw new Error("INVALID_MARKET_PAYLOAD");
  }

  const receivedAt = new Date().toISOString();
  const instrumentCode = normalizeInstrumentCode(
    String(
      readField(raw, ["instrumentCode", "instrument", "symbol", "product_id", "code"]) ??
        config.instrumentCode ??
        ""
    )
  );
  const price = requireFiniteNumber(readField(raw, ["price", "p", "px"]), "price");
  const size = requireFiniteNumber(
    readField(raw, ["size", "amount", "quantity", "qty", "q"]),
    "size"
  );
  const exchangeTimestamp =
    coerceTimestamp(readField(raw, ["exchangeTimestamp", "timestamp", "time", "ts"])) ??
    receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const side = normalizeUniversalSide(
    readField(raw, ["side", "orderSide", "liquiditySide", "updateType"])
  );

  return createUniversalTick({
    config,
    instrumentCode,
    price,
    size,
    side,
    sequence: coerceGenericSequence(readField(raw, ["sequence", "seq", "sequenceId", "id"])),
    exchangeTimestamp,
    synchronized,
    receivedAt,
    rawMetadata: sanitizeGenericMetadata(raw)
  });
}

function extractMarketEvents(raw: unknown, source: MarketDataSource): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!isRecord(raw)) {
    return [raw];
  }

  if (source === "HYPERLIQUID") {
    return [raw];
  }

  if (Array.isArray(raw.data)) {
    return raw.data;
  }

  if (Array.isArray(raw.events)) {
    return raw.events;
  }

  if (Array.isArray(raw.result)) {
    return raw.result;
  }

  if (isRecord(raw.data)) {
    return [raw.data];
  }

  if (isRecord(raw.result)) {
    return [raw.result];
  }

  return [raw];
}

function readSnapshotLevels(
  snapshot: Record<string, unknown>,
  side: "bid" | "ask"
): unknown {
  const plural = side === "bid" ? "bids" : "asks";
  const singular = side;
  const direct = readField(snapshot, [
    plural,
    `${singular}Levels`,
    `${plural}Levels`,
    `${singular}_levels`,
    `${plural}_levels`
  ]);

  if (direct !== undefined) {
    return unwrapLevelsContainer(direct);
  }

  const levels = unwrapLevelsContainer(readField(snapshot, ["levels", "book", "orderBook"]));

  if (isRecord(levels)) {
    return unwrapLevelsContainer(levels[plural] ?? levels[singular]);
  }

  return [];
}

function unwrapLevelsContainer(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.levels)) {
    return value.levels;
  }

  return value;
}

function normalizeSnapshotLevels(
  value: unknown,
  observedAt: string
): OrderBookSnapshotLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const levels: OrderBookSnapshotLevel[] = [];

  for (const level of value) {
    const normalized = normalizeSnapshotLevel(level, observedAt);

    if (normalized) {
      levels.push(normalized);
    }
  }

  return levels;
}

function normalizeSnapshotLevel(
  level: unknown,
  observedAt: string
): OrderBookSnapshotLevel | null {
  let price: unknown;
  let size: unknown;
  let updatedAt: string | null = null;

  if (Array.isArray(level)) {
    [price, size] = level;
    updatedAt = coerceTimestamp(level[2]);
  } else if (isRecord(level)) {
    price = readField(level, ["price", "px", "p"]);
    size = readField(level, ["size", "amount", "quantity", "qty", "volume"]);
    updatedAt = coerceTimestamp(readField(level, ["updatedAt", "updated_at", "ts"]));
  } else {
    return null;
  }

  const parsedPrice = Number(price);
  const parsedSize = Number(size);

  if (
    !Number.isFinite(parsedPrice) ||
    !Number.isFinite(parsedSize) ||
    parsedPrice < 0 ||
    parsedSize < 0
  ) {
    return null;
  }

  return {
    price: parsedPrice,
    size: parsedSize,
    updatedAt: updatedAt ?? observedAt
  };
}

function coerceSnapshotSequence(snapshot: Record<string, unknown>): number {
  const sequence = readField(snapshot, [
    "sequence",
    "sequenceId",
    "sequence_id",
    "seq",
    "lastUpdateId",
    "lastSequence",
    "last_sequence"
  ]);
  const parsed = Number(sequence);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return hashSequenceId(
    `${SNAPSHOT_SEQUENCE_FALLBACK_SEED}:${JSON.stringify({
      bids: readSnapshotLevels(snapshot, "bid"),
      asks: readSnapshotLevels(snapshot, "ask")
    })}`
  );
}

function readField(
  record: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  const value = readField(record, keys);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function inferSubscriptionField(
  subscription: string | undefined,
  field: "code" | "exchange"
): string | null {
  if (!subscription) {
    return null;
  }

  const parsed = parseJson<{ instrumentCriteria?: Record<string, unknown> }>(subscription);
  const value = parsed?.instrumentCriteria?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeSide(
  side: string | undefined,
  updateType: string | null
): MarketTick["side"] {
  const normalizedSide = normalizeString(side);

  if (normalizedSide === "BUY") {
    return "buy";
  }

  if (normalizedSide === "SELL") {
    return "sell";
  }

  if (updateType === "BEST_BID") {
    return "buy";
  }

  if (updateType === "BEST_ASK") {
    return "sell";
  }

  return "unknown";
}

function splitInstrumentCode(instrumentCode: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  const [baseAsset, ...quoteParts] = instrumentCode.split("-");

  return {
    baseAsset: baseAsset || "unknown",
    quoteAsset: quoteParts.join("-") || "unknown"
  };
}

function coerceSequence(
  sequenceId: string | undefined,
  additionalProperties: Record<string, unknown> | null | undefined
): number {
  const additionalSequence = additionalProperties?.sequence;
  const numericSequence = Number(additionalSequence ?? sequenceId);

  if (Number.isSafeInteger(numericSequence) && numericSequence >= 0) {
    return numericSequence;
  }

  return hashSequenceId(sequenceId ?? JSON.stringify(additionalProperties ?? {}));
}

function hashSequenceId(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function coerceTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }

  return null;
}

function isPong(raw: unknown): boolean {
  if (Array.isArray(raw)) {
    return false;
  }

  if (!isRecord(raw)) {
    return false;
  }

  const eventType = normalizeString(raw.type ?? raw.event);
  const channel = normalizeString(raw.channel);
  return eventType === "PONG" || eventType === "HEARTBEAT" || channel === "PONG";
}

function isHyperliquidControlMessage(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }

  const channel = normalizeString(raw.channel);
  return channel === "SUBSCRIPTIONRESPONSE" || channel === "PONG";
}

function extractHeartbeatLatencyMs(raw: unknown): number {
  if (!isRecord(raw)) {
    return 0;
  }

  const sentAt = coerceTimestamp(raw.ts ?? raw.sentAt ?? raw.pingTs);
  if (!sentAt) {
    return 0;
  }

  const parsed = Date.parse(sentAt);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0;
}

function loadStreamConfigs(env: Env): ResolvedExchangeStreamConfig[] {
  const configured = env.MARKET_STREAMS
    ? parseJson<ExchangeStreamConfig[]>(env.MARKET_STREAMS)
    : null;
  const weights = parseWeightMap(env.EXCHANGE_WEIGHTS);
  const rawConfigs =
    configured && Array.isArray(configured) && configured.length > 0
      ? configured
      : defaultHyperliquidStreamConfig(env);

  return withLiquidationWatchlistSubscriptions(
    augmentDwellirHyperliquidReadStreams(rawConfigs, env),
    env
  )
    .filter((config) => config.enabled !== false)
    .map((config, index) => resolveStreamConfig(env, config, weights, index));
}

function augmentDwellirHyperliquidReadStreams(
  configs: ExchangeStreamConfig[],
  env: Env
): ExchangeStreamConfig[] {
  const hasDwellirGrpc = configs.some((config) => isDwellirGrpcRawConfig(config, env));
  const hasHyperliquidBookSocket = configs.some(
    (config) =>
      normalizeSource(config.source) === "HYPERLIQUID" &&
      normalizeTransport(config.transport) === "websocket" &&
      (config.subscriptions ?? [config.subscription])
        .filter(Boolean)
        .some((subscription) => isL2BookSubscription(subscription))
  );

  if (!hasDwellirGrpc || hasHyperliquidBookSocket) {
    return configs;
  }

  const coins = parseAssetList(env.HL_ASSETS ?? env.HL_ASSET);
  const activeCoins = coins.length > 0 ? coins : [...DEFAULT_HYPERLIQUID_ASSET_MATRIX];
  const subscriptionProfile = resolveDwellirSubscriptionProfile(env, activeCoins.length);
  const orderbookTransport = dwellirOrderbookTransport(env);

  if (orderbookTransport === "grpc") {
    return configs.map((config) =>
      isDwellirGrpcRawConfig(config, env)
        ? {
            ...config,
            subscriptionProfile,
            grpcStreamTypes: mergeGrpcStreamTypes(config.grpcStreamTypes, [
              "ORDERBOOK_SNAPSHOT",
              "FILLS"
            ])
          }
        : config
    );
  }

  const orderbookUrl = resolveDwellirOrderbookWsUrl(env);
  const normalized = configs.map((config) =>
    isDwellirGrpcRawConfig(config, env)
      ? (() => {
          const grpcStreamTypes = (config.grpcStreamTypes ?? ["FILLS"]).filter(
            (entry) => !isOrderbookStreamKind(entry)
          );
          return {
            ...config,
            subscriptionProfile,
            // Dwellir's gRPC gateway is excellent for fills/blocks. The order-book
            // server is the authoritative low-latency L2 feed, so keep gRPC off
            // the book hot path to avoid snapshot-file churn resetting the engine.
            grpcStreamTypes: grpcStreamTypes.length > 0 ? grpcStreamTypes : ["FILLS"]
          };
        })()
      : config
  );

  const orderbookStreams = activeCoins.map((coin) => ({
    id: `dwellir-hyperliquid-orderbook-${coin.toLowerCase()}`,
    source: "HYPERLIQUID" as const,
    source_exchange: "hyperliquid",
    transport: "websocket" as const,
    streamUrl: orderbookUrl,
    weight: 1,
    exchangeCode: "hyperliquid",
    instrumentCode: `${coin.toLowerCase()}-usd`,
    subscriptionProfile,
    subscriptions: [
      {
        method: "subscribe",
        subscription: {
          type: subscriptionProfile.l4BookEnabled ? "l4Book" : "l2Book",
          coin,
          nLevels: subscriptionProfile.bookDepth
        }
      }
    ]
  }));

  return [...normalized, ...orderbookStreams];
}

function defaultHyperliquidStreamConfig(env: Env): ExchangeStreamConfig[] {
  const coins = parseAssetList(env.HL_ASSETS ?? env.HL_ASSET).slice(0, 12);
  const activeCoins = coins.length > 0 ? coins : [...DEFAULT_HYPERLIQUID_ASSET_MATRIX];
  const transport = normalizeTransport(env.INGEST_TRANSPORT ?? "grpc");
  const grpcEndpoint = resolveDwellirGrpcUrl(env);

  return [
    {
      id:
        activeCoins.length === 1
          ? `hyperliquid-${activeCoins[0].toLowerCase()}-perp`
          : "dwellir-hyperliquid-grpc",
      source: "HYPERLIQUID",
      source_exchange: "hyperliquid",
      transport,
      streamUrl:
        transport === "grpc"
          ? requireString(grpcEndpoint, "RPC_GRPC_ENDPOINT")
          : requireString(env.HL_WS_URL, "HL_WS_URL"),
      grpcEndpoint,
      grpcService: env.RPC_GRPC_SERVICE ?? DWELLIR_GRPC_SERVICE,
      grpcStreamMethod: env.RPC_GRPC_STREAM_METHOD ?? "StreamOrderbookSnapshots",
      grpcPingMethod: env.RPC_GRPC_PING_METHOD,
      grpcSubscribeType: env.RPC_GRPC_SUBSCRIBE_TYPE ?? "hyperliquid_l1_gateway.v2.Position",
      grpcUpdateType: env.RPC_GRPC_UPDATE_TYPE ?? "hyperliquid_l1_gateway.v2.OrderBookSnapshot",
      grpcPingRequestType: env.RPC_GRPC_PING_REQUEST_TYPE,
      grpcPingResponseType: env.RPC_GRPC_PING_RESPONSE_TYPE,
      grpcStreamTypes: parseCsvList(
        env.RPC_GRPC_STREAM_TYPES ?? env.DWELLIR_GRPC_STREAMS,
        ["ORDERBOOK_SNAPSHOT", "FILLS"]
      ),
      subscriptions: activeCoins.flatMap((coin) => [
        { method: "subscribe", subscription: { type: "l2Book", coin } },
        { method: "subscribe", subscription: { type: "trades", coin } },
        { method: "subscribe", subscription: { type: "activeAssetCtx", coin } }
      ]),
      instrumentCode:
        activeCoins.length === 1 ? `${activeCoins[0].toLowerCase()}-usd` : undefined,
      exchangeCode: "hyperliquid"
    }
  ];
}

function resolveDwellirGrpcUrl(
  env: Env,
  config?: Pick<ExchangeStreamConfig, "grpcEndpoint" | "streamUrl"> | null
): string {
  return (
    env.DWELLIR_GRPC_URL ??
    config?.grpcEndpoint ??
    config?.streamUrl ??
    env.DWELLIR_GRPC_ENDPOINT ??
    env.RPC_GRPC_ENDPOINT ??
    DWELLIR_GRPC_ENDPOINT
  );
}

function resolveDwellirOrderbookWsUrl(env: Env): string {
  const explicit = env.DWELLIR_ORDERBOOK_WS_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const token =
    env.DWELLIR_API_KEY?.trim() ??
    env.RPC_AUTH_TOKEN?.trim() ??
    dwellirRouteTokenFromUrl(env.DWELLIR_GRPC_URL) ??
    dwellirRouteTokenFromUrl(env.RPC_GRPC_ENDPOINT) ??
    dwellirRouteTokenFromUrl(env.DWELLIR_GRPC_ENDPOINT);

  if (!token) {
    return requireString(env.HL_WS_URL, "DWELLIR_ORDERBOOK_WS_URL");
  }

  const endpoint = (env.DWELLIR_ORDERBOOK_WS_ENDPOINT ?? DWELLIR_ORDERBOOK_WS_ENDPOINT).replace(
    /\/+$/,
    ""
  );
  return `${endpoint}/${token}/ws`;
}

function resolveDwellirSubscriptionProfile(
  env: Env,
  assetCount: number
): MarketDataSubscriptionProfile {
  const tier = normalizeDwellirSubscriptionTier(env.DWELLIR_SUBSCRIPTION_TIER);
  const orderbookTransport = dwellirOrderbookTransport(env);
  const maxBookDepth = tier === "PUBLIC" ? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT : DWELLIR_MAX_L2_DEPTH_LIMIT;
  const bookDepth = readPositiveInteger(
    env.DWELLIR_ORDERBOOK_DEPTH,
    maxBookDepth,
    1,
    maxBookDepth
  );
  const l4Requested = booleanEnv(env.DWELLIR_ENABLE_L4_BOOK);
  const l4BookEnabled = l4Requested && tier !== "PUBLIC";
  const optimization =
    bookDepth >= maxBookDepth && !l4Requested
      ? "MAXIMIZED"
      : bookDepth >= maxBookDepth
        ? "CUSTOM"
        : "CONSERVATIVE";

  return {
    provider: "DWELLIR",
    tier,
    readMode:
      orderbookTransport === "grpc"
        ? l4BookEnabled
          ? "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
          : "DWELLIR_GRPC_FILLS_L2_BOOK_GRPC"
        : l4BookEnabled
          ? "DWELLIR_GRPC_FILLS_L4_BOOK_WS"
          : "DWELLIR_GRPC_FILLS_L2_BOOK_WS",
    bookDepth,
    maxBookDepth,
    l4BookEnabled,
    assetCount,
    optimization,
    normalMode: true,
    reason: l4BookEnabled
      ? orderbookTransport === "grpc"
        ? `Dwellir ${tier} detected; L4 depth is enabled and carried through gRPC order-book snapshots before aggregation into the engine book.`
        : `Dwellir ${tier} detected; L4 depth is enabled on the Dwellir order-book WebSocket.`
      : l4Requested
        ? `Dwellir ${tier} detected; L4 was requested but is unavailable on the public tier, so the engine is using ${bookDepth}/${maxBookDepth} L2 levels.`
        : orderbookTransport === "grpc"
          ? `Dwellir ${tier} detected; normal mode is maximized at ${bookDepth}/${maxBookDepth} L2 levels with gRPC fills plus gRPC order-book snapshots.`
          : `Dwellir ${tier} detected; normal mode is maximized at ${bookDepth}/${maxBookDepth} L2 levels with gRPC fills plus order-book WebSocket.`
  };
}

function dwellirOrderbookTransport(env: Env): "grpc" | "websocket" {
  const normalized = normalizeString(env.DWELLIR_ORDERBOOK_TRANSPORT);
  const tier = normalizeDwellirSubscriptionTier(env.DWELLIR_SUBSCRIPTION_TIER);
  return normalized === "GRPC" && tier === "DEDICATED" ? "grpc" : "websocket";
}

function mergeGrpcStreamTypes(
  current: string[] | undefined,
  required: string[]
): string[] {
  const merged: string[] = [];

  for (const entry of [...(current ?? []), ...required]) {
    const normalized = entry.trim().toUpperCase();
    if (normalized && !merged.includes(normalized)) {
      merged.push(normalized);
    }
  }

  return merged;
}

function normalizeDwellirSubscriptionTier(
  value: string | undefined
): MarketDataSubscriptionTier {
  const normalized = normalizeString(value);

  if (
    normalized === "PUBLIC" ||
    normalized === "STANDARD" ||
    normalized === "ENTERPRISE" ||
    normalized === "DEDICATED"
  ) {
    return normalized;
  }

  return "ENTERPRISE";
}

function dwellirRouteTokenFromUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const token = url.pathname.split("/").filter(Boolean)[0];
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function resolveDwellirStartTimestampMs(env: Env): number | null {
  const explicitTimestamp = readOptionalNumber(env.DWELLIR_GRPC_START_TIMESTAMP_MS);
  if (explicitTimestamp !== null) {
    return explicitTimestamp;
  }

  if (readOptionalNumber(env.DWELLIR_GRPC_START_BLOCK_HEIGHT) !== null) {
    return null;
  }

  const lookbackMs = Math.min(
    60_000,
    readNumber(
      env.DWELLIR_GRPC_START_LOOKBACK_MS,
      DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS
    )
  );

  return Math.max(1, Date.now() - lookbackMs);
}

function hasEndpointPath(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.pathname.replace(/\//g, "").length > 0;
  } catch {
    return false;
  }
}

function redactEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }

  try {
    const url = new URL(endpoint);
    const hasSecretPath = url.pathname.replace(/\//g, "").length > 0;
    return hasSecretPath ? `${url.origin}/<dwellir-route>` : url.origin;
  } catch {
    return "<invalid-endpoint>";
  }
}

function withLiquidationWatchlistSubscriptions(
  configs: ExchangeStreamConfig[],
  env: Env
): ExchangeStreamConfig[] {
  const wallets = parseLiquidationWallets(env.HL_LIQUIDATION_WALLETS);

  if (wallets.length === 0) {
    return configs;
  }

  return configs.map((config) => {
    if (config.source !== "HYPERLIQUID") {
      return config;
    }

    const existing = new Set(
      (config.subscriptions ?? [])
        .filter((subscription): subscription is JsonRecord => typeof subscription !== "string")
        .flatMap((subscription) => {
          const payload = subscription.subscription;
          return isRecord(payload) && typeof payload.user === "string"
            ? [`${payload.type ?? ""}:${payload.user.toLowerCase()}`]
            : [];
        })
    );
    const liquidationSubscriptions = wallets.flatMap((wallet) => {
      const userEventsKey = `userEvents:${wallet}`;
      const ledgerKey = `userNonFundingLedgerUpdates:${wallet}`;
      const additions: JsonRecord[] = [];

      if (!existing.has(userEventsKey)) {
        additions.push({
          method: "subscribe",
          subscription: { type: "userEvents", user: wallet }
        });
      }

      if (!existing.has(ledgerKey)) {
        additions.push({
          method: "subscribe",
          subscription: { type: "userNonFundingLedgerUpdates", user: wallet }
        });
      }

      return additions;
    });

    if (liquidationSubscriptions.length === 0) {
      return config;
    }

    return {
      ...config,
      subscriptions: [...(config.subscriptions ?? []), ...liquidationSubscriptions]
    };
  });
}

function parseAssetList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim().replace(/-perp$/i, "").toUpperCase())
        .filter((entry) => /^[A-Z0-9]+$/.test(entry))
    )
  ];
}

function isDwellirGrpcConfig(config: ResolvedExchangeStreamConfig): boolean {
  return (
    config.transport === "grpc" &&
    ((config.grpcEndpoint ?? config.streamUrl).includes("dwellir.com") ||
      (config.grpcService ?? "").startsWith("hyperliquid_l1_gateway."))
  );
}

function isDwellirGrpcRawConfig(config: ExchangeStreamConfig, env: Env): boolean {
  const transport = normalizeTransport(config.transport ?? env.INGEST_TRANSPORT);
  if (transport !== "grpc" || normalizeSource(config.source) !== "HYPERLIQUID") {
    return false;
  }

  const endpoint = config.grpcEndpoint ?? config.streamUrl ?? env.DWELLIR_GRPC_URL ?? env.RPC_GRPC_ENDPOINT;
  return (
    typeof endpoint === "string" &&
    endpoint.includes("dwellir.com")
  ) || (config.grpcService ?? env.RPC_GRPC_SERVICE ?? "").startsWith("hyperliquid_l1_gateway.");
}

function isOrderbookStreamKind(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return (
    normalized === "ORDERBOOK" ||
    normalized === "ORDERBOOK_SNAPSHOT" ||
    normalized === "ORDERBOOK_UPDATE" ||
    normalized === "BOOK_UPDATES" ||
    normalized === "SNAPSHOTS"
  );
}

function isL2BookSubscription(subscription: string | JsonRecord | undefined): boolean {
  if (!subscription) {
    return false;
  }

  if (typeof subscription === "string") {
    const normalized = subscription.toLowerCase();
    return normalized.includes("l2book") || normalized.includes("l4book");
  }

  const payload = subscription.subscription;
  const type = isRecord(payload) ? normalizeString(payload.type) : null;
  return type === "L2BOOK" || type === "L4BOOK";
}

function dwellirGrpcStreams(
  env: Env,
  config?: Pick<ResolvedExchangeStreamConfig, "grpcStreamTypes">
): Set<DwellirGrpcStreamKind> {
  const configured = config?.grpcStreamTypes?.length
    ? config.grpcStreamTypes
    : parseCsvList(env.DWELLIR_GRPC_STREAMS, [
        "ORDERBOOK_SNAPSHOT",
        "FILLS"
      ]);
  const streams = new Set<DwellirGrpcStreamKind>();

  for (const entry of configured) {
    const normalized = entry.trim().toUpperCase();
    if (
      normalized === "ORDERBOOK" ||
      normalized === "ORDERBOOK_SNAPSHOT" ||
      normalized === "ORDERBOOK_UPDATE" ||
      normalized === "BOOK_UPDATES" ||
      normalized === "SNAPSHOTS"
    ) {
      streams.add("ORDERBOOK_SNAPSHOT");
    } else if (
      normalized === "FILL" ||
      normalized === "FILLS" ||
      normalized === "TRADE" ||
      normalized === "TRADES"
    ) {
      streams.add("FILLS");
    } else if (normalized === "BLOCK" || normalized === "BLOCKS") {
      streams.add("BLOCK");
    }
  }

  return streams.size > 0 ? streams : new Set(["ORDERBOOK_SNAPSHOT", "FILLS"]);
}

function dwellirGrpcWatchdogTimeoutMs(
  env: Env,
  config: Pick<ResolvedExchangeStreamConfig, "watchdogTimeoutMs">,
  streams: Set<DwellirGrpcStreamKind>
): number {
  if (streams.has("ORDERBOOK_SNAPSHOT") || streams.has("BLOCK")) {
    return config.watchdogTimeoutMs;
  }

  if (streams.has("FILLS")) {
    return Math.max(
      config.watchdogTimeoutMs,
      readNumber(
        env.DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS,
        DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS
      )
    );
  }

  return config.watchdogTimeoutMs;
}

function shouldEmitDwellirGrpcFatalDrop(
  streams: Set<DwellirGrpcStreamKind>,
  env: Env
): boolean {
  if (streams.has("ORDERBOOK_SNAPSHOT") || streams.has("BLOCK")) {
    return true;
  }

  return booleanEnv(env.DWELLIR_GRPC_FATAL_ON_FILLS_ONLY);
}

function dwellirPayloadToHyperliquidRawMessages(
  update: DwellirGrpcPayload,
  config: ResolvedExchangeStreamConfig,
  coins: string[],
  maxAgeMs: number
): Record<string, unknown>[] {
  if (update.kind === "BLOCK") {
    return [];
  }

  if (update.kind === "ORDERBOOK_SNAPSHOT") {
    return dwellirOrderbookSnapshotMessagesFromBytes(
      update.data,
      coins,
      update.receivedAt,
      maxAgeMs
    );
  }

  const decoded = decodeDwellirJsonBytes(update.data);
  if (decoded === null) {
    return [];
  }

  if (update.kind === "FILLS") {
    return dwellirFillMessages(decoded, config, coins, update.receivedAt, maxAgeMs);
  }

  return [];
}

function classifyDwellirMalformedPayload(update: DwellirGrpcPayload): string | null {
  if (update.kind === "BLOCK") {
    return null;
  }

  const text = new TextDecoder().decode(update.data);
  const decoded = parseJson<unknown>(text);

  if (decoded === null) {
    return "INVALID_DWELLIR_PROTO_JSON_PAYLOAD";
  }

  if (update.kind === "FILLS") {
    const hasFillContainer =
      Array.isArray(decoded) ||
      (isRecord(decoded) &&
        (Array.isArray(decoded.data) ||
          Array.isArray(decoded.fills) ||
          Array.isArray(decoded.events) ||
          typeof decoded.channel === "string"));
    return hasFillContainer ? null : "UNSUPPORTED_DWELLIR_FILLS_PAYLOAD";
  }

  if (update.kind === "ORDERBOOK_SNAPSHOT") {
    const hasBookContainer =
      isRecord(decoded) &&
      (Array.isArray(decoded.data) ||
        Array.isArray(decoded.levels) ||
        Array.isArray(decoded.bids) ||
        typeof decoded.channel === "string");
    return hasBookContainer ? null : "UNSUPPORTED_DWELLIR_ORDERBOOK_PAYLOAD";
  }

  return null;
}

function dwellirOrderbookSnapshotMessagesFromBytes(
  bytes: Uint8Array,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  const text = new TextDecoder().decode(bytes);
  const timestamp = extractDwellirTopLevelField(text, "timestamp") ?? receivedAt;
  const block = extractDwellirTopLevelField(text, "block");
  const messages: Record<string, unknown>[] = [];

  if (!isDwellirPacketFresh(timestamp, receivedAt, maxAgeMs)) {
    return [];
  }

  for (const coin of coins) {
    const tupleJson = extractDwellirMarketTupleJson(text, coin.toUpperCase());
    if (!tupleJson) {
      continue;
    }

    const market = parseJson<unknown[]>(tupleJson);
    if (
      !Array.isArray(market) ||
      typeof market[0] !== "string" ||
      !Array.isArray(market[1])
    ) {
      continue;
    }

    messages.push({
      channel: "l2Book",
      data: {
        coin: market[0].toUpperCase(),
        time: timestamp,
        sequence: block,
        levels: [
          aggregateDwellirOrders(market[1][0], receivedAt),
          aggregateDwellirOrders(market[1][1], receivedAt)
        ]
      }
    });
  }

  if (messages.length > 0) {
    return messages;
  }

  const decoded = parseJson<unknown>(text);
  return decoded === null
    ? []
    : dwellirOrderbookSnapshotMessages(decoded, coins, receivedAt, maxAgeMs);
}

function extractDwellirMarketTupleJson(text: string, coin: string): string | null {
  const compactNeedle = `["${coin}",`;
  let start = text.indexOf(compactNeedle);

  if (start < 0) {
    const looseNeedle = `"${coin}"`;
    const coinAt = text.indexOf(looseNeedle);
    if (coinAt < 0) {
      return null;
    }
    start = text.lastIndexOf("[", coinAt);
  }

  if (start < 0 || text[start] !== "[") {
    return null;
  }

  return extractJsonArrayAt(text, start);
}

function extractJsonArrayAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractDwellirTopLevelField(text: string, field: string): string | number | null {
  const match = new RegExp(`"${field}"\\s*:\\s*("([^"]+)"|[0-9]+)`).exec(text.slice(0, 512));
  if (!match) {
    return null;
  }

  if (match[2] !== undefined) {
    return match[2];
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function dwellirOrderbookSnapshotMessages(
  decoded: unknown,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  if (isRecord(decoded) && typeof decoded.channel === "string") {
    return [decoded];
  }

  if (isRecord(decoded) && Array.isArray(decoded.data)) {
    const targets = new Set(coins.map((coin) => coin.toUpperCase()));
    const messages: Record<string, unknown>[] = [];
    const timestamp = decoded.timestamp ?? receivedAt;
    const block = decoded.block;

    if (!isDwellirPacketFresh(timestamp, receivedAt, maxAgeMs)) {
      return [];
    }

    for (const market of decoded.data) {
      if (!Array.isArray(market) || typeof market[0] !== "string" || !Array.isArray(market[1])) {
        continue;
      }

      const coin = market[0].toUpperCase();
      if (!targets.has(coin)) {
        continue;
      }

      messages.push({
        channel: "l2Book",
        data: {
          coin,
          time: timestamp,
          sequence: block,
          levels: [
            aggregateDwellirOrders(market[1][0], receivedAt),
            aggregateDwellirOrders(market[1][1], receivedAt)
          ]
        }
      });
    }

    return messages;
  }

  if (isRecord(decoded) && (Array.isArray(decoded.levels) || Array.isArray(decoded.bids))) {
    return [
      {
        channel: "l2Book",
        data: decoded
      }
    ];
  }

  return [];
}

function dwellirFillMessages(
  decoded: unknown,
  config: ResolvedExchangeStreamConfig,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  if (isRecord(decoded) && typeof decoded.channel === "string") {
    return [decoded];
  }

  const targetCoins = new Set(coins.map((coin) => coin.toUpperCase()));
  const fills =
    Array.isArray(decoded)
      ? decoded
      : isRecord(decoded) && Array.isArray(decoded.data)
        ? decoded.data
        : isRecord(decoded) && Array.isArray(decoded.fills)
          ? decoded.fills
          : isRecord(decoded) && Array.isArray(decoded.events)
            ? decoded.events
            : [];
  const byTradeId = new Map<string, Record<string, unknown>>();

  for (const entry of fills) {
    const fill =
      Array.isArray(entry) && isRecord(entry[1])
        ? entry[1]
        : isRecord(entry)
          ? entry
          : null;

    if (!fill) {
      continue;
    }

    const coin = stringifyOrNull(fill.coin) ?? config.instrumentCode?.replace(/-usd$/i, "").toUpperCase();
    const normalizedCoin = coin?.toUpperCase();
    if (!normalizedCoin || (targetCoins.size > 0 && !targetCoins.has(normalizedCoin))) {
      continue;
    }

    if (!isDwellirPacketFresh(fill.time ?? fill.timestamp, receivedAt, maxAgeMs)) {
      continue;
    }

    const tradeId = stringifyOrNull(fill.tid ?? fill.id ?? fill.hash ?? fill.oid) ??
      `${normalizedCoin}:${fill.time ?? fill.timestamp ?? ""}:${fill.px ?? fill.price ?? fill.limitPx ?? ""}:${fill.sz ?? fill.size ?? ""}`;
    const normalized: Record<string, unknown> = {
      coin: normalizedCoin,
      px: fill.px ?? fill.price ?? fill.limitPx,
      sz: fill.sz ?? fill.size,
      side: fill.side,
      isBuy:
        typeof fill.isBuy === "boolean"
          ? fill.isBuy
          : typeof fill.side === "string"
            ? fill.side.toUpperCase() === "B" || fill.side.toLowerCase() === "buy"
            : undefined,
      time: fill.time ?? fill.timestamp,
      tid: fill.tid ?? fill.id ?? fill.hash ?? fill.oid,
      hash: fill.hash,
      crossed: fill.crossed,
      liquidation: fill.liquidation ?? null
    };
    const existing = byTradeId.get(tradeId);

    if (!existing || fill.crossed === true) {
      byTradeId.set(tradeId, normalized);
    }
  }

  const normalized = [...byTradeId.values()].filter((fill) => (
    fill.coin &&
    fill.px !== undefined &&
    fill.sz !== undefined
  ));

  return normalized.length > 0 ? [{ channel: "trades", data: normalized }] : [];
}

function normalizeDwellirL4BookForEngine(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  maxCacheOrders: number
): Record<string, unknown> | null {
  const envelope = isRecord(raw.data) ? raw.data : raw;
  const data =
    isRecord(envelope.Snapshot)
      ? envelope.Snapshot
      : isRecord(envelope.Updates)
        ? envelope.Updates
        : envelope;
  const coin =
    readDwellirL4Coin(data) ??
    config.instrumentCode?.replace(/-usd$/i, "").toUpperCase();

  if (!coin) {
    return null;
  }

  const exchangeTime =
    coerceExchangeTime(readField(data, ["time", "timestamp", "ts", "blockTime"])) ??
    receivedAt;
  const sequence =
    readField(data, ["sequence", "seq", "block", "height", "time"]) ?? Date.parse(exchangeTime);

  let mutated = applyDwellirL4Snapshot(data, orderCache, receivedAt, maxCacheOrders);
  mutated = applyDwellirL4Deltas(data, orderCache, receivedAt) || mutated;

  if (!mutated && orderCache.size === 0) {
    return null;
  }

  pruneDwellirL4Cache(orderCache, Math.max(100, maxCacheOrders));

  const depthLimit = resolveBookDepthLimit(config);
  const bidLevels = buildDwellirL4AggregatedLevels(orderCache, "buy", depthLimit);
  const askLevels = buildDwellirL4AggregatedLevels(orderCache, "sell", depthLimit);

  if (bidLevels.length === 0 && askLevels.length === 0) {
    return null;
  }

  return {
    channel: "l2Book",
    data: {
      coin: coin.toUpperCase(),
      time: exchangeTime,
      sequence,
      levels: [bidLevels, askLevels],
      sourceChannel: "l4Book"
    }
  };
}

function applyDwellirL4Snapshot(
  data: Record<string, unknown>,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  maxCacheOrders: number
): boolean {
  const levels = readField(data, ["levels", "book", "orderBook"]);
  const bids =
    isRecord(levels)
      ? readField(levels, ["bids", "bid", "buy"])
      : readField(data, ["bids", "bidOrders", "buy"]);
  const asks =
    isRecord(levels)
      ? readField(levels, ["asks", "ask", "sell"])
      : readField(data, ["asks", "askOrders", "sell"]);

  if (Array.isArray(levels) && (Array.isArray(levels[0]) || Array.isArray(levels[1]))) {
    orderCache.clear();
    const sideLimit = Math.max(1, Math.floor(maxCacheOrders / 2));
    applyDwellirL4OrderList(levels[0], "buy", orderCache, receivedAt, "snapshot:bid", sideLimit);
    applyDwellirL4OrderList(levels[1], "sell", orderCache, receivedAt, "snapshot:ask", sideLimit);
    return true;
  }

  if (Array.isArray(bids) || Array.isArray(asks)) {
    orderCache.clear();
    const sideLimit = Math.max(1, Math.floor(maxCacheOrders / 2));
    applyDwellirL4OrderList(bids, "buy", orderCache, receivedAt, "snapshot:bid", sideLimit);
    applyDwellirL4OrderList(asks, "sell", orderCache, receivedAt, "snapshot:ask", sideLimit);
    return true;
  }

  return false;
}

function applyDwellirL4Deltas(
  data: Record<string, unknown>,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string
): boolean {
  let mutated = false;
  const deltaContainers = [
    readField(data, ["book_diffs", "bookDiffs"]),
    readField(data, ["diffs", "deltas", "updates", "changes", "orders", "orderUpdates"])
  ];

  for (const container of deltaContainers) {
    if (!Array.isArray(container)) {
      continue;
    }

    for (let index = 0; index < container.length; index += 1) {
      if (
        applyDwellirL4OrderMutation(
          container[index],
          null,
          orderCache,
          receivedAt,
          `delta:${index}`
        )
      ) {
        mutated = true;
      }
    }
  }

  const statusContainers = [
    readField(data, ["order_statuses", "orderStatuses", "statuses", "events"])
  ];

  for (const container of statusContainers) {
    if (!Array.isArray(container)) {
      continue;
    }

    for (let index = 0; index < container.length; index += 1) {
      const source = normalizeDwellirL4OrderSource(container[index], null);

      if (!source || !isDwellirL4Delete(source, readDwellirL4Size(source))) {
        continue;
      }

      if (
        applyDwellirL4OrderMutation(
          container[index],
          null,
          orderCache,
          receivedAt,
          `status:${index}`
        )
      ) {
        mutated = true;
      }
    }
  }

  return mutated;
}

function applyDwellirL4OrderList(
  value: unknown,
  side: "buy" | "sell",
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  fallbackPrefix: string,
  limit = Number.POSITIVE_INFINITY
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (let index = 0; index < value.length && index < limit; index += 1) {
    applyDwellirL4OrderMutation(
      value[index],
      side,
      orderCache,
      receivedAt,
      `${fallbackPrefix}:${index}`
    );
  }
}

function applyDwellirL4OrderMutation(
  value: unknown,
  sideHint: "buy" | "sell" | null,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  fallbackId: string
): boolean {
  const source = normalizeDwellirL4OrderSource(value, sideHint);

  if (!source) {
    return false;
  }

  const orderId = readDwellirL4OrderId(source, fallbackId);
  const existing = orderCache.get(orderId);
  const side = readDwellirL4Side(source, sideHint ?? existing?.side ?? null);
  const price = readDwellirL4Price(source) ?? existing?.price ?? null;
  const size = readDwellirL4Size(source);

  if (isDwellirL4Delete(source, size)) {
    return orderCache.delete(orderId);
  }

  if (!side || !price || size === null || size < 0) {
    return false;
  }

  orderCache.set(orderId, {
    side,
    price,
    size,
    updatedAt: receivedAt
  });
  return true;
}

function normalizeDwellirL4OrderSource(
  value: unknown,
  sideHint: "buy" | "sell" | null
): Record<string, unknown> | null {
  if (isRecord(value)) {
    const nested = readField(value, ["order", "restingOrder", "bookOrder", "data"]);

    if (isRecord(nested)) {
      return {
        ...value,
        ...nested,
        status: readField(value, ["status", "type", "event", "state"]) ?? readField(nested, ["status"])
      };
    }

    return value;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  if (isRecord(value[1])) {
    return {
      oid: value[0],
      ...value[1]
    };
  }

  if (sideHint) {
    return {
      side: sideHint,
      px: value[0],
      sz: value[1],
      oid: value[2]
    };
  }

  return {
    side: value[0],
    px: value[1],
    sz: value[2],
    oid: value[3]
  };
}

function readDwellirL4OrderId(
  source: Record<string, unknown>,
  fallbackId: string
): string {
  const id = readField(source, [
    "oid",
    "orderId",
    "order_id",
    "id",
    "hash",
    "tid",
    "cloid",
    "clientOrderId"
  ]);

  return stringifyOrNull(id) ?? `${fallbackId}:${readDwellirL4Price(source) ?? "unknown"}`;
}

function readDwellirL4Coin(source: Record<string, unknown>): string | null {
  const direct = stringifyOrNull(readField(source, ["coin", "asset", "symbol"]));

  if (direct) {
    return direct.toUpperCase();
  }

  const bookDiffs = readField(source, ["book_diffs", "bookDiffs", "diffs", "updates"]);
  if (Array.isArray(bookDiffs)) {
    for (const item of bookDiffs) {
      const record = normalizeDwellirL4OrderSource(item, null);
      const coin = record ? stringifyOrNull(readField(record, ["coin", "asset", "symbol"])) : null;

      if (coin) {
        return coin.toUpperCase();
      }
    }
  }

  const statuses = readField(source, ["order_statuses", "orderStatuses", "statuses"]);
  if (Array.isArray(statuses)) {
    for (const item of statuses) {
      const record = normalizeDwellirL4OrderSource(item, null);
      const coin = record ? stringifyOrNull(readField(record, ["coin", "asset", "symbol"])) : null;

      if (coin) {
        return coin.toUpperCase();
      }
    }
  }

  return null;
}

function readDwellirL4Price(source: Record<string, unknown>): string | null {
  const rawPrice = readField(source, ["limitPx", "px", "price", "p"]);
  const price = Number(rawPrice);

  if (!Number.isFinite(price) || price < 0) {
    return null;
  }

  return formatPriceKey(price);
}

function readDwellirL4Size(source: Record<string, unknown>): number | null {
  const rawBookDiff = readField(source, ["raw_book_diff", "rawBookDiff", "bookDiff"]);
  const newDiff = isRecord(rawBookDiff) && isRecord(rawBookDiff.new) ? rawBookDiff.new : null;
  const rawSize =
    readField(source, ["sz", "size", "qty", "quantity", "q", "remainingSize"]) ??
    (newDiff ? readField(newDiff, ["sz", "size", "qty", "quantity", "q"]) : undefined);
  const size = Number(rawSize);
  return Number.isFinite(size) ? size : null;
}

function readDwellirL4Side(
  source: Record<string, unknown>,
  fallback: "buy" | "sell" | null
): "buy" | "sell" | null {
  if (typeof source.isBuy === "boolean") {
    return source.isBuy ? "buy" : "sell";
  }

  if (typeof source.isBid === "boolean") {
    return source.isBid ? "buy" : "sell";
  }

  if (typeof source.isAsk === "boolean") {
    return source.isAsk ? "sell" : "buy";
  }

  const side = normalizeString(readField(source, ["side", "s", "bookSide", "dir", "direction"]));

  if (side === "B" || side === "BUY" || side === "BID" || side === "LONG") {
    return "buy";
  }

  if (side === "A" || side === "ASK" || side === "SELL" || side === "S" || side === "SHORT") {
    return "sell";
  }

  return fallback;
}

function isDwellirL4Delete(
  source: Record<string, unknown>,
  size: number | null
): boolean {
  const status = normalizeString(readField(source, ["status", "type", "event", "state", "action"]));
  const rawBookDiff = readField(source, ["raw_book_diff", "rawBookDiff", "bookDiff"]);
  const rawBookDiffStatus = normalizeString(rawBookDiff);
  const rawBookDiffNew = isRecord(rawBookDiff) ? rawBookDiff.new : undefined;

  return (
    size === 0 ||
    rawBookDiffNew === null ||
    rawBookDiffStatus === "DELETE" ||
    rawBookDiffStatus === "DELETED" ||
    rawBookDiffStatus === "REMOVE" ||
    rawBookDiffStatus === "REMOVED" ||
    status === "CANCEL" ||
    status === "CANCELED" ||
    status === "CANCELLED" ||
    status === "DELETE" ||
    status === "DELETED" ||
    status === "REMOVE" ||
    status === "REMOVED" ||
    status === "FILL" ||
    status === "FILLED" ||
    status === "EXPIRE" ||
    status === "EXPIRED"
  );
}

function buildDwellirL4AggregatedLevels(
  orderCache: Map<string, DwellirL4OrderState>,
  side: "buy" | "sell",
  depthLimit: number
): Array<{ px: string; sz: string; n: number; updatedAt: string }> {
  const byPrice = new Map<string, { price: number; size: number; count: number; updatedAt: string }>();

  for (const order of orderCache.values()) {
    if (order.side !== side || order.size <= 0) {
      continue;
    }

    const price = Number(order.price);
    if (!Number.isFinite(price)) {
      continue;
    }

    const aggregate = byPrice.get(order.price) ?? {
      price,
      size: 0,
      count: 0,
      updatedAt: order.updatedAt
    };
    aggregate.size += order.size;
    aggregate.count += 1;
    aggregate.updatedAt = order.updatedAt > aggregate.updatedAt ? order.updatedAt : aggregate.updatedAt;
    byPrice.set(order.price, aggregate);
  }

  const sorted = Array.from(byPrice.entries());
  sorted.sort((left, right) =>
    side === "buy" ? right[1].price - left[1].price : left[1].price - right[1].price
  );

  const levels: Array<{ px: string; sz: string; n: number; updatedAt: string }> = [];
  const cappedDepth = Math.max(1, depthLimit);

  for (let index = 0; index < sorted.length && levels.length < cappedDepth; index += 1) {
    const [price, aggregate] = sorted[index];
    levels.push({
      px: price,
      sz: String(roundTo(aggregate.size, 8)),
      n: aggregate.count,
      updatedAt: aggregate.updatedAt
    });
  }

  return levels;
}

function pruneDwellirL4Cache(
  orderCache: Map<string, DwellirL4OrderState>,
  maxCacheOrders: number
): void {
  if (orderCache.size <= maxCacheOrders) {
    return;
  }

  const bids: Array<[string, DwellirL4OrderState]> = [];
  const asks: Array<[string, DwellirL4OrderState]> = [];

  for (const entry of orderCache.entries()) {
    if (entry[1].side === "buy") {
      bids.push(entry);
    } else {
      asks.push(entry);
    }
  }

  bids.sort((left, right) => Number(right[1].price) - Number(left[1].price));
  asks.sort((left, right) => Number(left[1].price) - Number(right[1].price));

  orderCache.clear();
  const sideLimit = Math.max(1, Math.floor(maxCacheOrders / 2));

  for (let index = 0; index < bids.length && index < sideLimit; index += 1) {
    orderCache.set(bids[index][0], bids[index][1]);
  }

  for (let index = 0; index < asks.length && index < sideLimit; index += 1) {
    orderCache.set(asks[index][0], asks[index][1]);
  }
}

function isDwellirPacketFresh(
  timestampValue: unknown,
  receivedAt: string,
  maxAgeMs: number
): boolean {
  const exchangeTimestamp = coerceExchangeTime(timestampValue);
  if (!exchangeTimestamp) {
    return true;
  }

  const exchangeMs = Date.parse(exchangeTimestamp);
  const receivedMs = Date.parse(receivedAt);

  if (!Number.isFinite(exchangeMs) || !Number.isFinite(receivedMs)) {
    return true;
  }

  return Math.max(0, receivedMs - exchangeMs) <= maxAgeMs;
}

function aggregateDwellirOrders(value: unknown, receivedAt: string): Array<{ px: string; sz: string; n: number; updatedAt: string }> {
  const orders = Array.isArray(value) ? value : [];
  const byPrice = new Map<string, { size: number; count: number }>();

  for (const order of orders) {
    if (!isRecord(order)) {
      continue;
    }

    const rawPrice = order.limitPx ?? order.px ?? order.price;
    const rawSize = order.sz ?? order.size;
    const price = typeof rawPrice === "string" ? rawPrice : String(rawPrice ?? "");
    const size = Number(rawSize);

    if (!price || !Number.isFinite(size) || size < 0) {
      continue;
    }

    const current = byPrice.get(price) ?? { size: 0, count: 0 };
    current.size += size;
    current.count += 1;
    byPrice.set(price, current);
  }

  return [...byPrice.entries()].map(([price, aggregate]) => ({
    px: price,
    sz: String(roundTo(aggregate.size, 8)),
    n: aggregate.count,
    updatedAt: receivedAt
  }));
}

function decodeDwellirJsonBytes(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function parseCsvList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return [...fallback];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : [...fallback];
}

function normalizeTransport(value: string | undefined): "websocket" | "grpc" {
  return value?.trim().toLowerCase() === "grpc" ? "grpc" : "websocket";
}

function streamCoins(config: ResolvedExchangeStreamConfig): string[] {
  const coins = new Set<string>();

  for (const subscription of config.subscriptions ?? []) {
    if (typeof subscription === "string") {
      continue;
    }

    const payload = subscription.subscription;
    if (isRecord(payload) && typeof payload.coin === "string") {
      coins.add(payload.coin.trim().toUpperCase());
    }
  }

  if (config.instrumentCode) {
    coins.add(config.instrumentCode.replace(/-usd$/i, "").replace(/-perp$/i, "").toUpperCase());
  }

  return coins.size > 0 ? [...coins] : [...DEFAULT_HYPERLIQUID_ASSET_MATRIX];
}

function resetInstrumentForStream(
  config: ResolvedExchangeStreamConfig
): string | null {
  const coins = new Set<string>();

  for (const subscription of config.subscriptions ?? []) {
    if (typeof subscription === "string") {
      continue;
    }
    const payload = subscription.subscription;
    if (isRecord(payload) && typeof payload.coin === "string") {
      coins.add(payload.coin.trim().toUpperCase());
    }
  }

  if (coins.size > 1) {
    return null;
  }

  return config.instrumentCode ?? null;
}

function resolveStreamConfig(
  env: Env,
  config: ExchangeStreamConfig,
  weights: Record<string, number>,
  index: number
): ResolvedExchangeStreamConfig {
  const source = normalizeSource(config.source);
  const sourceExchange = normalizeSourceExchange(config.source_exchange, config.exchangeCode);
  const transport = normalizeTransport(config.transport ?? env.INGEST_TRANSPORT);
  const dwellirGrpcUrl = resolveDwellirGrpcUrl(env, config);
  const configuredWeight = Number(config.weight);
  const weight =
    Number.isFinite(configuredWeight) && configuredWeight > 0
      ? configuredWeight
      : weights[sourceExchange] ??
        weights[`${source.toLowerCase()}:${sourceExchange}`] ??
        DEFAULT_SOURCE_WEIGHT;

  return {
    id: config.id || `${source.toLowerCase()}-${sourceExchange}-${index}`,
    source,
    source_exchange: sourceExchange,
    transport,
    streamUrl: requireString(
      transport === "grpc"
        ? config.grpcEndpoint ?? dwellirGrpcUrl ?? config.streamUrl
        : config.streamUrl,
      transport === "grpc" ? "RPC_GRPC_ENDPOINT" : "STREAM_URL"
    ),
    snapshotUrl: config.snapshotUrl,
    clusterUrls: config.clusterUrls,
    subscription: config.subscription,
    subscriptions: config.subscriptions,
    authHeader: config.authHeader ?? DEFAULT_AUTH_HEADER,
    apiKeyEnv: config.apiKeyEnv,
    grpcEndpoint: config.grpcEndpoint ?? dwellirGrpcUrl ?? env.RPC_GRPC_ENDPOINT,
    grpcService: config.grpcService ?? env.RPC_GRPC_SERVICE,
    grpcStreamMethod: config.grpcStreamMethod ?? env.RPC_GRPC_STREAM_METHOD,
    grpcPingMethod: config.grpcPingMethod ?? env.RPC_GRPC_PING_METHOD,
    grpcSubscribeType: config.grpcSubscribeType ?? env.RPC_GRPC_SUBSCRIBE_TYPE,
    grpcUpdateType: config.grpcUpdateType ?? env.RPC_GRPC_UPDATE_TYPE,
    grpcPingRequestType:
      config.grpcPingRequestType ?? env.RPC_GRPC_PING_REQUEST_TYPE,
    grpcPingResponseType:
      config.grpcPingResponseType ?? env.RPC_GRPC_PING_RESPONSE_TYPE,
    grpcStreamTypes:
      config.grpcStreamTypes ??
      parseCsvList(env.RPC_GRPC_STREAM_TYPES ?? env.DWELLIR_GRPC_STREAMS, [
        "ORDERBOOK_SNAPSHOT",
        "FILLS"
      ]),
    weight,
    instrumentCode: config.instrumentCode?.toLowerCase(),
    exchangeCode: (config.exchangeCode ?? sourceExchange).toLowerCase(),
    subscriptionProfile: config.subscriptionProfile,
    heartbeatIntervalMs: readNumber(env.HL_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS),
    watchdogTimeoutMs: readNumber(
      env.HL_WATCHDOG_TIMEOUT_MS ?? env.HL_STALE_AFTER_MS,
      DEFAULT_WATCHDOG_TIMEOUT_MS
    ),
    maxBackoffMs: readNumber(env.HL_MAX_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS),
    backoffBaseMs: readNumber(
      env.HL_GRPC_BACKOFF_BASE_MS,
      transport === "grpc" ? DEFAULT_GRPC_BACKOFF_BASE_MS : DEFAULT_BACKOFF_BASE_MS
    ),
    grpcFatalDropMs: readNumber(env.DWELLIR_GRPC_FATAL_DROP_MS, DEFAULT_GRPC_FATAL_DROP_MS)
  };
}

function assertIngestEnv(env: Env, config: ResolvedExchangeStreamConfig): void {
  requireString(config.streamUrl, "STREAM_URL");

  if (config.transport === "grpc") {
    requireString(config.grpcEndpoint ?? config.streamUrl, "RPC_GRPC_ENDPOINT");
    requireString(config.grpcService ?? env.RPC_GRPC_SERVICE, "RPC_GRPC_SERVICE");
    requireString(
      config.grpcStreamMethod ?? env.RPC_GRPC_STREAM_METHOD,
      "RPC_GRPC_STREAM_METHOD"
    );
    requireString(
      config.grpcSubscribeType ?? env.RPC_GRPC_SUBSCRIBE_TYPE,
      "RPC_GRPC_SUBSCRIBE_TYPE"
    );
    requireString(
      config.grpcUpdateType ?? env.RPC_GRPC_UPDATE_TYPE,
      "RPC_GRPC_UPDATE_TYPE"
    );
  }

  if (config.apiKeyEnv) {
    requireString(readEnvSecret(env, config.apiKeyEnv), config.apiKeyEnv);
  }
}

class ClockSyncTracker {
  private offsetMs: number | null = null;

  constructor(
    private readonly alpha = DEFAULT_CLOCK_SYNC_ALPHA,
    private readonly maxOffsetMs = DEFAULT_CLOCK_SYNC_MAX_OFFSET_MS
  ) {}

  observe(
    exchangeTimestamp: string,
    receivedAt: string
  ): { timestamp: string; offsetMs: number } {
    const exchangeMs = Date.parse(exchangeTimestamp);
    const receivedMs = Date.parse(receivedAt);

    if (!Number.isFinite(exchangeMs) || !Number.isFinite(receivedMs)) {
      return { timestamp: receivedAt, offsetMs: this.currentOffsetMs() ?? 0 };
    }

    const observedOffset = clampNumber(
      receivedMs - exchangeMs,
      -this.maxOffsetMs,
      this.maxOffsetMs
    );
    this.offsetMs =
      this.offsetMs === null
        ? observedOffset
        : this.offsetMs + this.alpha * (observedOffset - this.offsetMs);

    return {
      timestamp: new Date(exchangeMs + this.offsetMs).toISOString(),
      offsetMs: Math.round(this.offsetMs)
    };
  }

  currentOffsetMs(): number | null {
    return this.offsetMs === null ? null : Math.round(this.offsetMs);
  }
}

class ClusterPool {
  private activeIndex = 0;
  private readonly health = new Map<
    string,
    { score: number; failures: number; heartbeatLatencyMs: number | null; cooldownUntilMs: number }
  >();

  constructor(private readonly urls: string[]) {
    for (const url of urls) {
      this.health.set(url, {
        score: 1,
        failures: 0,
        heartbeatLatencyMs: null,
        cooldownUntilMs: 0
      });
    }
  }

  activeUrl(): string {
    return this.urls[this.activeIndex] ?? this.urls[0];
  }

  recordHeartbeat(url: string, latencyMs: number): void {
    const entry = this.health.get(url) ?? {
      score: 1,
      failures: 0,
      heartbeatLatencyMs: null,
      cooldownUntilMs: 0
    };
    const latencyPenalty = Math.min(0.5, latencyMs / 10_000);
    entry.score = Math.min(1, entry.score * 0.9 + (1 - latencyPenalty) * 0.1);
    entry.failures = 0;
    entry.heartbeatLatencyMs = latencyMs;
    entry.cooldownUntilMs = 0;
    this.health.set(url, entry);
  }

  recordFailure(url: string): void {
    const entry = this.health.get(url) ?? {
      score: 1,
      failures: 0,
      heartbeatLatencyMs: null,
      cooldownUntilMs: 0
    };
    entry.failures += 1;
    entry.score = Math.max(0, entry.score - 0.25);
    if (entry.failures >= 2) {
      entry.cooldownUntilMs = Date.now() + Math.min(60_000, entry.failures * 5_000);
    }
    this.health.set(url, entry);
    this.maybePromote();
  }

  activeHeartbeatLatencyMs(): number | null {
    return this.health.get(this.activeUrl())?.heartbeatLatencyMs ?? null;
  }

  private maybePromote(): void {
    const activeUrl = this.activeUrl();
    const activeScore = this.health.get(activeUrl)?.score ?? 0;
    const best = this.urls
      .map((url, index) => {
        const health = this.health.get(url);
        const coolingDown = (health?.cooldownUntilMs ?? 0) > Date.now();
        return {
          url,
          index,
          score: coolingDown ? -1 : health?.score ?? 0
        };
      })
      .sort((left, right) => right.score - left.score)[0];

    if (best && best.index !== this.activeIndex && best.score > activeScore + 0.2) {
      this.activeIndex = best.index;
    }
  }
}

function createUniversalTick(input: {
  config: ResolvedExchangeStreamConfig;
  instrumentCode: string;
  price: number;
  size: number;
  side: MarketTick["side"];
  sequence: number;
  exchangeTimestamp: string;
  synchronized: { timestamp: string; offsetMs: number };
  receivedAt: string;
  rawMetadata: JsonRecord;
}): MarketTick {
  const instrumentCode = normalizeInstrumentCode(input.instrumentCode);
  const { baseAsset, quoteAsset } = splitInstrumentCode(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: input.config.source,
    source_exchange: input.config.source_exchange,
    transport: "websocket",
    exchangeCode: (input.config.exchangeCode ?? input.config.source_exchange).toLowerCase(),
    instrumentCode,
    baseAsset,
    quoteAsset,
    price: input.price,
    size: input.size,
    side: input.side,
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    exchangeTimestamp: input.exchangeTimestamp,
    synchronizedExchangeTimestamp: input.synchronized.timestamp,
    clockOffsetMs: input.synchronized.offsetMs,
    receivedAt: input.receivedAt,
    sourceWeight: input.config.weight,
    fundingRateHourly: finiteOrUndefined(input.rawMetadata.fundingRateHourly),
    markPrice: finiteOrUndefined(input.rawMetadata.markPrice),
    oraclePrice: finiteOrUndefined(input.rawMetadata.oraclePrice),
    openInterest: finiteOrUndefined(input.rawMetadata.openInterest),
    raw: input.rawMetadata
  };
}

function parseWeightMap(value: string | undefined): Record<string, number> {
  const parsed = value ? parseJson<Record<string, unknown>>(value) : null;

  if (!parsed) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, weight]) => [key.toLowerCase(), Number(weight)] as const)
      .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
  );
}

function readEnvSecret(env: Env, key: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[key];
}

function normalizeSource(value: unknown): MarketDataSource {
  const source = normalizeString(value);

  switch (source) {
    case "BINANCE":
    case "HYPERLIQUID":
    case "COINBASE":
    case "KRAKEN":
    case "OKX":
    case "BYBIT":
    case "SYSTEM":
      return source;
    default:
      return "SYSTEM";
  }
}

function normalizeSourceExchange(value: unknown, fallback: unknown): string {
  const sourceExchange =
    typeof value === "string" && value.trim() !== ""
      ? value
      : typeof fallback === "string" && fallback.trim() !== ""
        ? fallback
        : "unknown";

  return sourceExchange.toLowerCase();
}

function normalizeWeight(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOURCE_WEIGHT;
}

function buildMarketKey(sourceExchange: string, instrumentCode: string): string {
  return `${sourceExchange.toLowerCase()}:${instrumentCode.toLowerCase()}`;
}

function normalizeInstrumentCode(value: string): string {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.includes("-")) {
    return trimmed;
  }

  const compact = trimmed.replace("/", "");
  const quote = ["usdt", "usdc", "usd", "btc", "eth"].find((candidate) =>
    compact.endsWith(candidate)
  );

  if (!quote || compact.length <= quote.length) {
    return compact || "unknown";
  }

  return `${compact.slice(0, -quote.length)}-${quote}`;
}

function coerceExchangeTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(millis).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return coerceExchangeTime(numeric);
    }
  }

  return coerceTimestamp(value);
}

function coerceGenericSequence(value: unknown): number {
  const parsed = Number(value);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return hashSequenceId(JSON.stringify(value ?? crypto.randomUUID()));
}

function normalizeDepthLevels(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((level) => {
      if (!Array.isArray(level)) {
        return null;
      }

      const price = Number(level[0]);
      const size = Number(level[1]);
      return Number.isFinite(price) && Number.isFinite(size) && price >= 0 && size >= 0
        ? ([price, size] as [number, number])
        : null;
    })
    .filter((level): level is [number, number] => level !== null);
}

function readHyperliquidData(raw: Record<string, unknown>): unknown {
  return raw.data ?? raw.result ?? raw;
}

function readHyperliquidObject(raw: Record<string, unknown>): Record<string, unknown> {
  const data = readHyperliquidData(raw);
  if (!isRecord(data)) {
    throw new Error("INVALID_HYPERLIQUID_DATA");
  }
  return data;
}

function normalizeHyperliquidBookSides(
  levels: unknown,
  depthLimit = HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT
): [Array<[number, number, number | null]>, Array<[number, number, number | null]>] {
  if (!Array.isArray(levels)) {
    return [[], []];
  }

  const bidLevels = Array.isArray(levels[0]) ? levels[0] : [];
  const askLevels = Array.isArray(levels[1]) ? levels[1] : [];
  return [
    normalizeHyperliquidBookLevels(bidLevels).slice(0, depthLimit),
    normalizeHyperliquidBookLevels(askLevels).slice(0, depthLimit)
  ];
}

function resolveBookDepthLimit(config: ResolvedExchangeStreamConfig): number {
  return Math.max(
    1,
    Math.min(
      config.subscriptionProfile?.maxBookDepth ?? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
      config.subscriptionProfile?.bookDepth ?? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT
    )
  );
}

function normalizeHyperliquidBookLevels(value: unknown): Array<[number, number, number | null]> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((level) => {
      const record = Array.isArray(level) ? null : isRecord(level) ? level : null;
      const price = Number(record ? readField(record, ["px", "price", "p"]) : Array.isArray(level) ? level[0] : null);
      const size = Number(record ? readField(record, ["sz", "size", "q"]) : Array.isArray(level) ? level[1] : null);
      const orderCount = finiteOrNull(record ? readField(record, ["n", "count", "orders"]) : Array.isArray(level) ? level[2] : null);

      return Number.isFinite(price) && Number.isFinite(size) && price >= 0 && size >= 0
        ? ([price, size, orderCount] as [number, number, number | null])
        : null;
    })
    .filter((level): level is [number, number, number | null] => level !== null);
}

function hyperliquidTradeSide(value: unknown): MarketTick["side"] {
  const side = normalizeString(value);

  if (side === "B" || side === "BUY" || side === "BID") {
    return "buy";
  }

  if (side === "A" || side === "SELL" || side === "ASK") {
    return "sell";
  }

  return "unknown";
}

function hawkesTradeSide(fill: Record<string, unknown>): HawkesFlowSide {
  if (typeof fill.isBuy === "boolean") {
    return fill.isBuy ? "BUY" : "SELL";
  }

  const side = normalizeString(fill.side);

  if (side === "B" || side === "BUY" || side === "BID") {
    return "BUY";
  }

  if (side === "A" || side === "SELL" || side === "ASK") {
    return "SELL";
  }

  return "UNKNOWN";
}

function hyperliquidInstrumentCode(coin: string, fallback?: string): string {
  const normalizedCoin = coin.trim().toLowerCase();
  if (!normalizedCoin && fallback) {
    return normalizeInstrumentCode(fallback);
  }

  if (normalizedCoin.includes("-") || normalizedCoin.includes("/")) {
    return normalizeInstrumentCode(normalizedCoin.replace("/", "-"));
  }

  return `${normalizedCoin}-usd`;
}

function createDeleteTick(
  template: MarketTick,
  side: MarketTick["side"],
  price: number
): MarketTick {
  return {
    ...template,
    price,
    size: 0,
    side,
    raw: {
      ...(template.raw ?? {}),
      eventType: "l2Book",
      commodity: "ORDER_BOOK",
      depthSide: side === "buy" ? "bid" : "ask",
      deleteReason: "missing-from-hyperliquid-snapshot"
    }
  };
}

function formatPriceKey(value: number): string {
  return Number(value).toFixed(8).replace(/\.?0+$/, "");
}

function normalizeCoinbaseChange(
  change: unknown
): { side: MarketTick["side"]; price: number; size: number } | null {
  if (!Array.isArray(change) || change.length < 3) {
    return null;
  }

  const side = normalizeUniversalSide(change[0]);
  const price = Number(change[1]);
  const size = Number(change[2]);

  if (!Number.isFinite(price) || !Number.isFinite(size) || price < 0 || size < 0) {
    return null;
  }

  return { side, price, size };
}

function normalizeUniversalSide(value: unknown): MarketTick["side"] {
  const side = normalizeString(value);

  if (side === "BUY" || side === "BID" || side === "BEST_BID") {
    return "buy";
  }

  if (side === "SELL" || side === "ASK" || side === "BEST_ASK") {
    return "sell";
  }

  return "unknown";
}

function heartbeatPayload(source: MarketDataSource): JsonRecord {
  if (source === "HYPERLIQUID") {
    return { method: "ping" };
  }

  return { type: "ping", ts: new Date().toISOString() };
}

function sanitizeGenericMetadata(raw: Record<string, unknown>): JsonRecord {
  return {
    eventType: stringifyOrNull(readField(raw, ["e", "type", "event"])),
    rawSequence: stringifyOrNull(readField(raw, ["sequence", "seq", "u", "id"]))
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function websocketFetchUrl(url: string): string {
  if (url.startsWith("wss://")) {
    return `https://${url.slice("wss://".length)}`;
  }

  if (url.startsWith("ws://")) {
    return `http://${url.slice("ws://".length)}`;
  }

  return url;
}

function clampNumber(value: number, min: number, max: number, fallback = min): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function positiveConfigNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function quickSelect(values: Float32Array, left: number, right: number, target: number): number {
  let low = left;
  let high = right;

  while (low < high) {
    const pivotIndex = partition(values, low, high, Math.floor((low + high) / 2));
    if (target === pivotIndex) {
      return values[target];
    }
    if (target < pivotIndex) {
      high = pivotIndex - 1;
    } else {
      low = pivotIndex + 1;
    }
  }

  return values[target];
}

function partition(values: Float32Array, left: number, right: number, pivotIndex: number): number {
  const pivotValue = values[pivotIndex];
  swapFloat32(values, pivotIndex, right);
  let storeIndex = left;

  for (let index = left; index < right; index += 1) {
    if (values[index] < pivotValue) {
      swapFloat32(values, storeIndex, index);
      storeIndex += 1;
    }
  }

  swapFloat32(values, right, storeIndex);
  return storeIndex;
}

function swapFloat32(values: Float32Array, left: number, right: number): void {
  const temp = values[left];
  values[left] = values[right];
  values[right] = temp;
}

function isAuthorizedControlRequest(request: Request, env: Env): boolean {
  if (!env.INGESTOR_CONTROL_TOKEN) {
    return false;
  }

  const header = request.headers.get("authorization");
  return header === `Bearer ${env.INGESTOR_CONTROL_TOKEN}`;
}

function calculateBackoffMs(
  backoffCounter: number,
  baseBackoffMs: number,
  maxBackoffMs: number
): number {
  const exponential = Math.min(
    maxBackoffMs,
    baseBackoffMs * 2 ** Math.max(0, backoffCounter)
  );
  const jitter = Math.floor(Math.random() * Math.min(baseBackoffMs, exponential));
  return Math.min(maxBackoffMs, exponential + jitter);
}

function closeSocket(socket: WebSocket | null, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    // Closing is best-effort in Workers; stale sockets are discarded by the runtime.
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function readOptionalNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function booleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`MISSING_${field}`);
  }

  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }

  return parsed;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

function stringifyOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function readResponseJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json<T>()) ?? null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8"
    }
  });
}

export const __test__ = {
  classifyDwellirMalformedPayload,
  dwellirPayloadToHyperliquidRawMessages,
  loadStreamConfigs,
  normalizeDwellirL4BookForEngine,
  resolveDwellirOrderbookWsUrl
};

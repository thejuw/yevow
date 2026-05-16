import { Logger } from "./Logger";
import { Notifier } from "./utils/Notifier";
import type {
  Env,
  ExchangeStreamConfig,
  ExchangeStreamHealth,
  IngestHealth,
  JsonRecord,
  MarketDataSource,
  MarketTick,
  OrderBookSnapshot,
  OrderBookSnapshotLevel,
  OrderBookResetRequest
} from "./types";

const SINGLETON_ENGINE_NAME = "sovereign-sigma:singleton:trading-engine:v1";
const SINGLETON_INGEST_COORDINATOR_NAME = "sovereign-sigma:singleton:ingest-coordinator:v1";
const DEFAULT_AUTH_HEADER = "X-Api-Key";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WATCHDOG_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const SNAPSHOT_SEQUENCE_FALLBACK_SEED = "snapshot";
const DEFAULT_SOURCE_WEIGHT = 1;
const DEFAULT_CLOCK_SYNC_ALPHA = 0.1;
const DEFAULT_CLOCK_SYNC_MAX_OFFSET_MS = 10_000;
const DEFAULT_STALE_TICK_DROP_MS = 1_000;
const PRE_SNAPSHOT_BUFFER_LIMIT = 1_000;
const HYPERLIQUID_L2_DEPTH_LIMIT = 20;

type ResolvedExchangeStreamConfig = Required<
  Pick<
    ExchangeStreamConfig,
    "id" | "source" | "source_exchange" | "streamUrl" | "authHeader" | "weight"
  >
> &
  Pick<
    ExchangeStreamConfig,
    | "clusterUrls"
    | "snapshotUrl"
    | "subscription"
    | "subscriptions"
    | "apiKeyEnv"
    | "instrumentCode"
    | "exchangeCode"
  > & {
    heartbeatIntervalMs: number;
    watchdogTimeoutMs: number;
    maxBackoffMs: number;
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

const seenNewsItems = new Map<string, number>();

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
  const id = env.INGEST_COORDINATOR.idFromName(SINGLETON_INGEST_COORDINATOR_NAME);
  const coordinator = env.INGEST_COORDINATOR.get(id);

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

    const controller = new ExchangeStreamController(env, logger, config);
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
  const id = env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
  const engine = env.TRADING_ENGINE.get(id);

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
  private lastError: string | null = null;
  private providerSequence: number | null = null;
  private awaitingProviderBridge = false;
  private readonly hyperliquidBookLevels = new Map<string, HyperliquidBookLevelSet>();
  private streamReady = false;
  private preSnapshotBuffer: Array<string | ArrayBuffer> = [];

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly config: ResolvedExchangeStreamConfig
  ) {
    this.clockSync = new ClockSyncTracker(
      readNumber(env.CLOCK_SYNC_ALPHA, DEFAULT_CLOCK_SYNC_ALPHA),
      readNumber(env.CLOCK_SYNC_MAX_OFFSET_MS, DEFAULT_CLOCK_SYNC_MAX_OFFSET_MS)
    );
    this.clusterPool = new ClusterPool([config.streamUrl, ...(config.clusterUrls ?? [])]);
    this.notifier = new Notifier(env, (promise) => {
      void promise;
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
      streamHost: hostnameOf(this.clusterPool.activeUrl()),
      activeClusterUrl: this.clusterPool.activeUrl(),
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
      lastError: this.lastError
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
        DEFAULT_BACKOFF_BASE_MS,
        maxBackoffMs
      );

      this.logger.warn(
        "STREAM_RECONNECT_ATTEMPT",
        "Scheduling market stream reconnect",
        {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          connectionId: this.connectionId,
          attempts: this.attempts,
          backoffCounter: this.backoffCounter,
          backoffMs,
          blackoutDurationMs: this.currentBlackoutDurationMs(),
          maxBackoffMs
        }
      );
      this.notifier.notify({
        priority: "HIGH",
        title: "Sovereign-Sigma stream reconnect",
        message: `${this.config.source_exchange} reconnect attempt ${this.attempts}; blackout ${this.currentBlackoutDurationMs()}ms, retrying in ${backoffMs}ms.`,
        dedupeKey: `stream-reconnect:${this.config.id}`,
        metadata: {
          streamId: this.config.id,
          source: this.config.source,
          source_exchange: this.config.source_exchange,
          attempts: this.attempts,
          backoffMs,
          blackoutDurationMs: this.currentBlackoutDurationMs()
        }
      });

      await sleep(backoffMs);
    }
  }

  private async connectOnce(): Promise<void> {
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
    this.lastMessageAt = recoveredAt;
    this.lastRecoveredAt = recoveredAt;
    this.lastRecoveryDurationMs = blackoutDurationMs;
    this.lastError = null;

    this.logger.info("STREAM_CONNECT", "Market stream connected", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      sourceWeight: this.config.weight,
      connectionId: this.connectionId,
      streamHost: new URL(streamUrl).host,
      watchdogTimeoutMs,
      pingIntervalMs
    });
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
            previousClusterUrl,
            nextClusterUrl,
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
          await this.resetEngineBook(blackoutDurationMs, recoveredAt);
          if (this.config.snapshotUrl) {
            await this.syncEngineSnapshot("STREAM_CONNECTED", recoveredAt);
          }
          this.blackoutStartedAt = null;
          this.streamReady = true;
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
      await this.forwardHyperliquidRaw(raw, this.lastMessageAt ?? new Date().toISOString());
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
    const id = this.env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
    const engine = this.env.TRADING_ENGINE.get(id);
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
    const id = this.env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
    const engine = this.env.TRADING_ENGINE.get(id);
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

  private async forwardHyperliquidRaw(raw: unknown, receivedAt: string): Promise<void> {
    if (isHyperliquidControlMessage(raw)) {
      return;
    }

    const id = this.env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
    const engine = this.env.TRADING_ENGINE.get(id);
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

  private async resetEngineBook(
    blackoutDurationMs: number,
    recoveredAt: string
  ): Promise<void> {
    const id = this.env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
    const engine = this.env.TRADING_ENGINE.get(id);
    const payload: OrderBookResetRequest = {
      source: "INGEST_WORKER",
      reason: this.blackoutStartedAt ? "STREAM_RECONNECTED" : "STREAM_CONNECTED",
      instrumentCode: this.config.instrumentCode ?? null,
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

  private markDisconnected(reason: string): void {
    this.status = this.stopped ? "STOPPED" : "ERROR";
    this.lastDisconnectAt = new Date().toISOString();
    this.lastError = reason;
    this.socket = null;
    this.startBlackout(this.lastDisconnectAt);

    this.logger.warn("STREAM_DISCONNECT", "Market stream disconnected", {
      streamId: this.config.id,
      source: this.config.source,
      source_exchange: this.config.source_exchange,
      connectionId: this.connectionId,
      reason,
      messagesReceived: this.messagesReceived,
      ticksForwarded: this.ticksForwarded,
      ticksDropped: this.ticksDropped
    });
    this.notifier.notify({
      priority: "HIGH",
      title: "Sovereign-Sigma stream disconnected",
      message: `${this.config.source_exchange} stream disconnected: ${reason}. Recovery state machine is active.`,
      dedupeKey: `stream-disconnect:${this.config.id}`,
      metadata: {
        streamId: this.config.id,
        source: this.config.source,
        source_exchange: this.config.source_exchange,
        reason,
        messagesReceived: this.messagesReceived,
        ticksForwarded: this.ticksForwarded,
        ticksDropped: this.ticksDropped
      }
    });
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
      streams: []
    };
  }

  const primary = streams.find((stream) => stream.ok) ?? streams[0];

  return {
    ...primary,
    ok: streams.every((stream) => stream.ok),
    status: streams.every((stream) => stream.ok) ? "CONNECTED" : primary.status,
    streams
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
  const [bidLevels, askLevels] = normalizeHyperliquidBookSides(readField(data, ["levels"]));
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

  return rawConfigs
    .filter((config) => config.enabled !== false)
    .map((config, index) => resolveStreamConfig(env, config, weights, index));
}

function defaultHyperliquidStreamConfig(env: Env): ExchangeStreamConfig[] {
  const coin = env.HL_ASSET ?? "BTC";
  return [
    {
      id: `hyperliquid-${coin.toLowerCase()}-perp`,
      source: "HYPERLIQUID",
      source_exchange: "hyperliquid",
      streamUrl: env.HL_WS_URL ?? "wss://api.hyperliquid.xyz/ws",
      subscriptions: [
        { method: "subscribe", subscription: { type: "l2Book", coin } },
        { method: "subscribe", subscription: { type: "trades", coin } },
        { method: "subscribe", subscription: { type: "activeAssetCtx", coin } }
      ],
      instrumentCode: `${coin.toLowerCase()}-usd`,
      exchangeCode: "hyperliquid"
    }
  ];
}

function resolveStreamConfig(
  env: Env,
  config: ExchangeStreamConfig,
  weights: Record<string, number>,
  index: number
): ResolvedExchangeStreamConfig {
  const source = normalizeSource(config.source);
  const sourceExchange = normalizeSourceExchange(config.source_exchange, config.exchangeCode);
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
    streamUrl: requireString(config.streamUrl, "STREAM_URL"),
    snapshotUrl: config.snapshotUrl,
    clusterUrls: config.clusterUrls,
    subscription: config.subscription,
    subscriptions: config.subscriptions,
    authHeader: config.authHeader ?? DEFAULT_AUTH_HEADER,
    apiKeyEnv: config.apiKeyEnv,
    weight,
    instrumentCode: config.instrumentCode?.toLowerCase(),
    exchangeCode: (config.exchangeCode ?? sourceExchange).toLowerCase(),
    heartbeatIntervalMs: readNumber(env.HL_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS),
    watchdogTimeoutMs: readNumber(
      env.HL_WATCHDOG_TIMEOUT_MS ?? env.HL_STALE_AFTER_MS,
      DEFAULT_WATCHDOG_TIMEOUT_MS
    ),
    maxBackoffMs: readNumber(env.HL_MAX_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS)
  };
}

function assertIngestEnv(env: Env, config: ResolvedExchangeStreamConfig): void {
  requireString(config.streamUrl, "STREAM_URL");

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
  levels: unknown
): [Array<[number, number, number | null]>, Array<[number, number, number | null]>] {
  if (!Array.isArray(levels)) {
    return [[], []];
  }

  const bidLevels = Array.isArray(levels[0]) ? levels[0] : [];
  const askLevels = Array.isArray(levels[1]) ? levels[1] : [];
  return [
    normalizeHyperliquidBookLevels(bidLevels).slice(0, HYPERLIQUID_L2_DEPTH_LIMIT),
    normalizeHyperliquidBookLevels(askLevels).slice(0, HYPERLIQUID_L2_DEPTH_LIMIT)
  ];
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

import { Logger, createLogSink, structuredConsoleLogsEnabled } from "./Logger";
import { durableObjectLocationOptions } from "./utils/TradingEngineStub";
import { ingestNewsFeeds } from "./ingest/NewsIngestor";
import { ExchangeStreamController } from "./ingest/ExchangeStreamController";
import { isAuthorizedControlRequest, json, loadStreamConfigs } from "./ingest/IngestProtocol";
import type {
  Env,
  ExchangeStreamHealth,
  IngestHealth,
  MarketDataSubscriptionProfile
} from "./types";

export { __test__ } from "./ingest/IngestProtocol";

const DEFAULT_INGEST_COORDINATOR_NAME =
  "sovereign-sigma:singleton:ingest-coordinator:v3:apac-tokyo";
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "IngestWorker",
      undefined,
      createLogSink(env),
      structuredConsoleLogsEnabled(env)
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
    return Promise.resolve(json({ ok: false, error: "INGEST_COORDINATOR_NOT_BOUND" }, 503));
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
      "IngestCoordinator",
      undefined,
      createLogSink(env),
      structuredConsoleLogsEnabled(env)
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      this.ensureStreams();
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
      bookDepth >= maxBookDepth &&
      !profiles.some((profile) => profile.optimization === "CONSERVATIVE")
        ? "MAXIMIZED"
        : primary.optimization,
    normalMode: profiles.every((profile) => profile.normalMode),
    reason: reasons.join("; ")
  };
}

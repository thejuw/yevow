import { Logger } from "../Logger";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  DwellirHyperliquidGrpcClient,
  type DwellirGrpcPayload,
  type DwellirGrpcStreamKind
} from "../grpc/DwellirHyperliquidGrpcClient";
import { HyperliquidGrpcClient, type HyperliquidGrpcUpdate } from "../grpc/HyperliquidGrpcClient";
import { Notifier } from "../utils/Notifier";
import { getTradingEngineStub } from "../utils/TradingEngineStub";
import { isHyperliquidLiquidationMessage } from "../strategy/cascade/LiquidationStream";
import {
  DEFAULT_HAWKES_BASELINE_MU,
  DEFAULT_HAWKES_DECAY_ALPHA,
  DEFAULT_HAWKES_JUMP_BETA,
  DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS,
  DEFAULT_HAWKES_THRESHOLD_QUANTILE,
  HawkesFlowTracker,
  clampNumber,
  type HawkesFlowObservation,
  type HawkesFlowSide
} from "./HawkesFlowTracker";
import { buildExchangeStreamHealth } from "./ExchangeStreamHealth";
import {
  currentBlackoutDurationMs,
  isNormalProviderRecycle,
  shouldResetBookOnConnect,
  shouldThrottleNormalRecycleLog
} from "./ExchangeStreamLifecycle";
import { ClockSyncTracker, ClusterPool } from "./StreamRuntime";
import {
  DEFAULT_AUTH_HEADER,
  DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS,
  DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS,
  DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS,
  DEFAULT_GRPC_AUTH_HEADER,
  DEFAULT_GRPC_FATAL_DROP_MS,
  DEFAULT_MAX_BACKOFF_MS,
  aggregateDwellirOrders,
  applyDwellirL4Deltas,
  applyDwellirL4OrderList,
  applyDwellirL4OrderMutation,
  applyDwellirL4Snapshot,
  assertIngestEnv,
  buildMarketKey,
  buildDwellirL4AggregatedLevels,
  calculateBackoffMs,
  classifyDwellirMalformedPayload,
  closeSocket,
  coerceExchangeTime,
  coerceSequence,
  createDeleteTick,
  decodeDwellirJsonBytes,
  delay,
  dwellirFillMessages,
  dwellirGrpcStreams,
  dwellirGrpcWatchdogTimeoutMs,
  dwellirOrderbookSnapshotMessages,
  dwellirOrderbookSnapshotMessagesFromBytes,
  dwellirPayloadToHyperliquidRawMessages,
  DWELLIR_GRPC_SERVICE,
  extractDwellirMarketTupleJson,
  extractDwellirTopLevelField,
  extractHeartbeatLatencyMs,
  extractJsonArrayAt,
  extractMarketEvents,
  finiteOrNull,
  finiteOrUndefined,
  formatPriceKey,
  hawkesTradeSide,
  heartbeatPayload,
  hyperliquidInstrumentCode,
  hasEndpointPath,
  isDwellirGrpcConfig,
  isDwellirL4Delete,
  isDwellirPacketFresh,
  isHyperliquidControlMessage,
  isPong,
  isRecord,
  json,
  normalizeDwellirL4BookForEngine,
  normalizeDwellirL4OrderSource,
  normalizeHyperliquidData,
  normalizeMarketData,
  normalizeRestOrderBookSnapshot,
  normalizeString,
  parseCsvList,
  parseJson,
  pruneDwellirL4Cache,
  readBinanceSequenceWindow,
  readDwellirL4Coin,
  readDwellirL4OrderId,
  readDwellirL4Price,
  readDwellirL4Side,
  readDwellirL4Size,
  readEnvSecret,
  readNumber,
  readOptionalNumber,
  readResponseJson,
  redactEndpoint,
  requireString,
  resetInstrumentForStream,
  resolveDwellirGrpcUrl,
  resolveDwellirStartTimestampMs,
  shouldEmitDwellirGrpcFatalDrop,
  shouldSendApplicationHeartbeat,
  sleep,
  streamCoins,
  stringifyOrNull,
  websocketFetchUrl,
  type BinanceSequenceWindow,
  type DwellirL4OrderState,
  type HyperliquidBookLevelSet,
  type ResolvedExchangeStreamConfig
} from "./IngestProtocol";
import type {
  AgentSignal,
  Env,
  ExchangeStreamHealth,
  IngestHealth,
  JsonRecord,
  MarketTick,
  OrderBookResetRequest,
  OrderBookSnapshot
} from "../types";

const DEFAULT_CLOCK_SYNC_ALPHA = 0.1;
const DEFAULT_CLOCK_SYNC_MAX_OFFSET_MS = 10_000;
const DEFAULT_STALE_TICK_DROP_MS = 1_000;
const PRE_SNAPSHOT_BUFFER_LIMIT = 1_000;
interface EngineTickResponse {
  accepted?: boolean;
  acceptedCount?: number;
  processedCount?: number;
  status?: string;
  reason?: string;
}

export class ExchangeStreamController {
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
      signalCooldownMs: readNumber(env.HAWKES_SIGNAL_COOLDOWN_MS, DEFAULT_HAWKES_SIGNAL_COOLDOWN_MS)
    });
  }

  isRunning(): boolean {
    return !this.stopped && this.status !== "IDLE" && this.status !== "STOPPED";
  }

  snapshot(): ExchangeStreamHealth {
    return buildExchangeStreamHealth({
      config: this.config,
      clusterPool: this.clusterPool,
      clockSync: this.clockSync,
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
    });
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
      const maxBackoffMs = Math.min(this.config.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS);
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
    const apiKey = this.config.apiKeyEnv ? readEnvSecret(this.env, this.config.apiKeyEnv) : null;
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
      const heartbeat = !shouldSendApplicationHeartbeat(this.config)
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
          this.logger.warn(
            "STREAM_CLUSTER_HOT_SWAP",
            "Market stream cluster hot-swapped after health degradation",
            {
              streamId: this.config.id,
              source: this.config.source,
              source_exchange: this.config.source_exchange,
              previousClusterUrl: redactEndpoint(previousClusterUrl) ?? null,
              nextClusterUrl: redactEndpoint(nextClusterUrl) ?? null,
              reason
            }
          );
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
          this.lastError = error instanceof Error ? error.message : "SNAPSHOT_SYNC_FAILED";
          closeSocket(socket, 1011, "SNAPSHOT_SYNC_FAILED");
          this.markDisconnected("SNAPSHOT_SYNC_FAILED");
          finish(new Error(error instanceof Error ? error.message : "SNAPSHOT_SYNC_FAILED"));
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
      pingRequestType: this.config.grpcPingRequestType ?? this.env.RPC_GRPC_PING_REQUEST_TYPE,
      pingResponseType: this.config.grpcPingResponseType ?? this.env.RPC_GRPC_PING_RESPONSE_TYPE,
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
    const watchdogTimeoutMs = dwellirGrpcWatchdogTimeoutMs(this.env, this.config, streams);
    const emitFatalDropOnWatchdog = shouldEmitDwellirGrpcFatalDrop(streams, this.env);
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
            void this.emitGrpcFatalDropIfNeeded("DWELLIR_GRPC_WATCHDOG_TIMEOUT", staleForMs);
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
          this.pollDwellirGrpcOrderbookSnapshots(client, onUpdate, controller.signal)
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
      Promise.all(
        streamTasks.length > 0
          ? streamTasks
          : [Promise.reject(new Error("DWELLIR_NO_STREAMS_CONFIGURED"))]
      )
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
      socket.send(typeof subscription === "string" ? subscription : JSON.stringify(subscription));
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
        this.logger.warn(
          "PRE_SNAPSHOT_BUFFER_OVERFLOW",
          "Dropped buffered stream packet before snapshot bridge",
          {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            bufferLimit: PRE_SNAPSHOT_BUFFER_LIMIT
          }
        );
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
      readNumber(this.env.DWELLIR_GRPC_FORWARD_MAX_AGE_MS, DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS)
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
        this.logger.warn(
          "DWELLIR_L4_PACKET_DROPPED",
          "Dropped unsupported Dwellir L4 book packet",
          {
            streamId: this.config.id,
            source: this.config.source,
            source_exchange: this.config.source_exchange,
            connectionId: this.connectionId,
            reason: "UNSUPPORTED_L4BOOK_PAYLOAD"
          }
        );
      }
    }

    return normalized;
  }

  private async pollDwellirGrpcOrderbookSnapshots(
    client: DwellirHyperliquidGrpcClient,
    onUpdate: (update: DwellirGrpcPayload) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    const pollIntervalMs = Math.max(250, readNumber(this.env.DWELLIR_GRPC_SNAPSHOT_POLL_MS, 1_000));
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
          throw error instanceof Error ? error : new Error("DWELLIR_GRPC_SNAPSHOT_POLL_FAILED");
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

    const byMarket = new Map<
      string,
      {
        template: MarketTick;
        bids: Set<string>;
        asks: Set<string>;
      }
    >();

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

  private async evaluateProviderSequence(event: unknown): Promise<"PROCESS" | "SKIP" | "RESYNC"> {
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
    const apiKey = this.config.apiKeyEnv ? readEnvSecret(this.env, this.config.apiKeyEnv) : null;
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
    const responsePayload = await readResponseJson<EngineTickResponse>(response);

    if (responsePayload?.status === "DESYNC" || response.status === 409) {
      await this.recoverFromEngineDesync(responsePayload?.reason ?? "DESYNC");
      this.ticksForwarded += responsePayload?.processedCount ?? 0;
      this.lastForwardAt = new Date().toISOString();
      return;
    }

    if (!response.ok) {
      throw new Error(`ENGINE_FORWARD_FAILED_${response.status}`);
    }

    this.ticksForwarded += responsePayload?.processedCount ?? ticks.length;
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
    const payload = {
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
    };
    const forwardEncoding = (this.env.INGEST_FORWARD_ENCODING ?? "msgpack").toLowerCase();
    const useMsgpack = transport === "grpc" && forwardEncoding !== "json";
    const encoded = useMsgpack ? msgpackEncode(payload) : null;
    const body =
      encoded === null
        ? JSON.stringify(payload)
        : encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const endpoint = isHyperliquidLiquidationMessage(raw) ? "/liquidation" : "/hyperliquid/raw";
    const response = await engine.fetch(
      new Request(`https://trading-engine.internal${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": useMsgpack ? "application/x-msgpack" : "application/json",
          "x-source": "sovereign-sigma-ingest"
        },
        body
      })
    );
    const responsePayload = await readResponseJson<EngineTickResponse>(response);

    if (responsePayload?.status === "DESYNC" || response.status === 409) {
      await this.recoverFromEngineDesync(responsePayload?.reason ?? "DESYNC");
      this.ticksForwarded += responsePayload?.processedCount ?? 0;
      this.lastForwardAt = new Date().toISOString();
      return;
    }

    if (!response.ok) {
      throw new Error(`ENGINE_RAW_FORWARD_FAILED_${response.status}`);
    }

    this.ticksForwarded += responsePayload?.processedCount ?? 1;
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
      const tradeMs = Date.parse(coerceExchangeTime(item.time ?? item.timestamp) ?? receivedAt);
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
        this.logger.warn(
          "HAWKES_SIGNAL_FORWARD_FAILED",
          "Engine rejected Hawkes evacuation signal",
          {
            streamId: this.config.id,
            instrumentCode: observation.instrumentCode,
            status: response.status,
            intensity: observation.intensity,
            threshold: observation.threshold
          }
        );
      }
    } catch (error) {
      this.logger.warn(
        "HAWKES_SIGNAL_FORWARD_FAILED",
        "Failed to forward Hawkes evacuation signal",
        {
          streamId: this.config.id,
          instrumentCode: observation.instrumentCode,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        }
      );
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
        this.logger.error(
          "GRPC_FATAL_DROP_FORWARD_FAILED",
          "Engine rejected fatal gRPC drop signal",
          {
            streamId: this.config.id,
            status: response.status,
            reason
          }
        );
      }
    } catch (error) {
      this.logger.error(
        "GRPC_FATAL_DROP_FORWARD_FAILED",
        "Failed to forward fatal gRPC drop signal",
        {
          streamId: this.config.id,
          reason,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        }
      );
    }
  }

  private async resetEngineBook(blackoutDurationMs: number, recoveredAt: string): Promise<void> {
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
    return shouldResetBookOnConnect({
      hasConnectedOnce: this.hasConnectedOnce,
      previousDisconnectReason,
      config: this.config,
      blackoutDurationMs,
      fatalDropMs: readNumber(this.env.DWELLIR_GRPC_FATAL_DROP_MS, DEFAULT_GRPC_FATAL_DROP_MS)
    });
  }

  private isNormalProviderRecycle(reason = this.lastError): boolean {
    return isNormalProviderRecycle(this.config, reason);
  }

  private logNormalProviderRecycle(
    eventType: string,
    message: string,
    metadata: Record<string, unknown>
  ): void {
    const now = Date.now();
    const previous = this.normalRecycleLogAt.get(eventType) ?? 0;

    if (shouldThrottleNormalRecycleLog(previous, now)) {
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
    return currentBlackoutDurationMs(this.blackoutStartedAt, at);
  }
}

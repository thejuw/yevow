import { ConfigManager } from "../ConfigManager";
import { readNotificationSettings } from "../NotificationSettings";
import { StrategyVault } from "../StrategyVault";
import { Notifier } from "../utils/Notifier";
import type { Env, JsonRecord } from "../types";
import { CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS } from "./GatewayConstants";
import { evaluateHyperliquidSecrets } from "./HyperliquidSecretDiagnostics";
import { readCostBudgetSettings } from "./CostDashboard";
import { json } from "./ResponseHelpers";
import { parseJsonValue, stringNumber } from "./ValueCodecs";

export async function readAdminSettings(env: Env, configManager: ConfigManager): Promise<Response> {
  const notifier = new Notifier(env, () => undefined);
  const strategyVault = new StrategyVault(env.TRADING_DB, env.CONFIG_STORE);
  const [
    config,
    alerting,
    vault,
    notifications,
    hyperliquidSecrets,
    strategies,
    activeStrategy,
    costBudgets
  ] = await Promise.all([
    configManager.fetchConfig(),
    notifier.statusAsync(),
    vaultStatus(env),
    readNotificationSettings(env),
    evaluateHyperliquidSecrets(env),
    strategyVault.listVersions(20).catch(() => []),
    strategyVault.activeVersion().catch(() => null),
    readCostBudgetSettings(env)
  ]);

  return json({
    ok: true,
    config,
    notifications,
    alerting: {
      ...alerting,
      configured: alerting.channels.some((channel) => channel.configured)
    },
    vault: {
      ...vault,
      executionerHyperliquid: {
        ok: hyperliquidSecrets.ok,
        detail: hyperliquidSecrets.detail,
        metadata: hyperliquidSecrets.metadata
      }
    },
    backend: backendSettings(env),
    strategyVault: {
      active: activeStrategy,
      versions: strategies
    },
    costBudgets
  });
}

function backendSettings(env: Env): JsonRecord {
  const dwellirTier = env.DWELLIR_SUBSCRIPTION_TIER ?? null;
  const requestedOrderbookTransport = env.DWELLIR_ORDERBOOK_TRANSPORT ?? "websocket";
  const normalizedDwellirTier = String(dwellirTier ?? "ENTERPRISE").toUpperCase();
  const grpcOrderbookEligible = normalizedDwellirTier !== "PUBLIC";
  const effectiveOrderbookTransport =
    requestedOrderbookTransport.toLowerCase() === "grpc" && grpcOrderbookEligible
      ? "grpc"
      : "websocket";
  const l4Enabled = String(env.DWELLIR_ENABLE_L4_BOOK ?? "true").toLowerCase() !== "false";
  const readMode =
    effectiveOrderbookTransport === "grpc"
      ? l4Enabled
        ? "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
        : "DWELLIR_GRPC_FILLS_L2_BOOK_GRPC"
      : l4Enabled
        ? "DWELLIR_GRPC_FILLS_L4_BOOK_WS"
        : "DWELLIR_GRPC_FILLS_L2_BOOK_WS";

  return {
    api: {
      gatewayRoute: "https://api.yevow.co",
      adminStreamPath: "/admin/stream",
      healthPath: "/health",
      executionerBound: Boolean(env.EXECUTIONER),
      aiBound: Boolean(env.AI),
      structuredConsoleLogs: env.STRUCTURED_CONSOLE_LOGS ?? "false",
      logSinkProvider: env.LOG_SINK_PROVIDER ?? "disabled",
      logSinkConfigured: Boolean(
        env.LOG_SINK_PROVIDER &&
        env.LOG_SINK_PROVIDER !== "disabled" &&
        (env.LOG_SINK_TOKEN || env.LOG_SINK_URL)
      ),
      logSinkDataset: env.LOG_SINK_DATASET ?? env.AXIOM_DATASET ?? env.HONEYCOMB_DATASET ?? null
    },
    ingest: {
      nativeSource: "DWELLIR_HYPERLIQUID_GRPC",
      transport: env.INGEST_TRANSPORT ?? "grpc",
      readMode,
      readArchitecture:
        effectiveOrderbookTransport === "grpc"
          ? "Dwellir gRPC fills plus Dwellir gRPC order-book snapshots"
          : "Dwellir gRPC fills plus Dwellir L4 order-book WebSocket",
      providerRecommendedBookTransport:
        effectiveOrderbookTransport === "grpc"
          ? "dwellir-grpc-orderbook-snapshots"
          : "dwellir-orderbook-websocket",
      pureGrpcOrderbookActive: effectiveOrderbookTransport === "grpc",
      pureGrpcOrderbookRequirement:
        effectiveOrderbookTransport === "grpc"
          ? "Active: non-public Dwellir gRPC tier with DWELLIR_ORDERBOOK_TRANSPORT=grpc."
          : "Inactive: set DWELLIR_ORDERBOOK_TRANSPORT=grpc on a non-public Dwellir gRPC tier; public or unauthenticated routes stay on the Orderbook WebSocket.",
      dwellirGrpcUrl: redactedEndpoint(
        env.DWELLIR_GRPC_URL ?? env.DWELLIR_GRPC_ENDPOINT ?? env.RPC_GRPC_ENDPOINT
      ),
      dwellirGrpcPathConfigured: hasEndpointPath(
        env.DWELLIR_GRPC_URL ?? env.DWELLIR_GRPC_ENDPOINT ?? env.RPC_GRPC_ENDPOINT
      ),
      dwellirGrpcService: env.RPC_GRPC_SERVICE ?? null,
      dwellirGrpcStreams: env.DWELLIR_GRPC_STREAMS ?? env.RPC_GRPC_STREAM_TYPES ?? null,
      dwellirSubscriptionTier: dwellirTier,
      dwellirOrderbookDepth: stringNumber(env.DWELLIR_ORDERBOOK_DEPTH),
      dwellirOrderbookTransportRequested: requestedOrderbookTransport,
      dwellirOrderbookTransportEffective: effectiveOrderbookTransport,
      dwellirL4BookEnabled: env.DWELLIR_ENABLE_L4_BOOK ?? "true",
      hyperliquidWsUrl: env.HL_WS_URL ?? null,
      heartbeatIntervalMs: stringNumber(env.HL_HEARTBEAT_INTERVAL_MS),
      staleAfterMs: stringNumber(env.HL_STALE_AFTER_MS),
      watchdogTimeoutMs: stringNumber(env.HL_WATCHDOG_TIMEOUT_MS),
      maxBackoffMs: stringNumber(env.HL_MAX_BACKOFF_MS),
      sequenceGapMs: stringNumber(env.HL_SEQUENCE_GAP_MS),
      marketStreams: parseJsonValue(env.MARKET_STREAMS)
    },
    execution: {
      adapter: env.EXCHANGE_ADAPTER ?? null,
      baseUrl: env.EXCHANGE_BASE_URL ?? null,
      orderTestMode: env.EXCHANGE_ORDER_TEST_MODE ?? "true",
      shadowMode: env.SHADOW_MODE ?? "false",
      recvWindowMs: stringNumber(env.EXCHANGE_RECV_WINDOW_MS),
      orderAckTimeoutMs: stringNumber(env.ORDER_ACK_TIMEOUT_MS),
      slippageGuardTicks: stringNumber(env.SLIPPAGE_GUARD_TICKS),
      paperFillParticipationRate: stringNumber(env.PAPER_FILL_PARTICIPATION_RATE),
      paperFillAdverseBps: stringNumber(env.PAPER_FILL_ADVERSE_BPS),
      paperMakerFeeBps: stringNumber(env.PAPER_MAKER_FEE_BPS),
      quoteRefreshMinIntervalMs: stringNumber(env.QUOTE_REFRESH_MIN_INTERVAL_MS),
      quoteRefreshMinPriceTicks: stringNumber(env.QUOTE_REFRESH_MIN_PRICE_TICKS),
      liveReadinessMinPaperTrades: stringNumber(env.LIVE_READINESS_MIN_PAPER_TRADES),
      liveReadinessMinPaperPnlUsd: stringNumber(env.LIVE_READINESS_MIN_PAPER_PNL_USD),
      liveReadinessRequireSingleAsset: env.LIVE_READINESS_REQUIRE_SINGLE_ASSET ?? "true",
      liveReadinessAllowHype: env.LIVE_READINESS_ALLOW_HYPE ?? "false",
      cascadeLiveReadinessMinPaperTrades: stringNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_TRADES),
      cascadeLiveReadinessMinPaperPnlR: stringNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_PNL_R),
      cascadeLiveReadinessMinDaysPaper: stringNumber(env.CASCADE_LIVE_READINESS_MIN_DAYS_PAPER),
      cascadeTwoPersonApprovalWindowMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS,
      signatureAlgorithm: env.SIGNATURE_ALGORITHM ?? null
    },
    riskAndStrategy: {
      exchangeWeights: parseJsonValue(env.EXCHANGE_WEIGHTS),
      clockSyncAlpha: stringNumber(env.CLOCK_SYNC_ALPHA),
      clockSyncMaxOffsetMs: stringNumber(env.CLOCK_SYNC_MAX_OFFSET_MS),
      goldenColos: env.GOLDEN_COLOS ?? null,
      highLatencyColoRiskMultiplier: stringNumber(env.HIGH_LATENCY_COLO_RISK_MULTIPLIER),
      profilerBucketVolume: stringNumber(env.PROFILER_BUCKET_VOLUME),
      profilerRollingWindow: stringNumber(env.PROFILER_ROLLING_WINDOW),
      profilerAlertThreshold: stringNumber(env.PROFILER_ALERT_THRESHOLD),
      jitterThresholdMs: stringNumber(env.JITTER_THRESHOLD_MS),
      jitterSampleWindow: stringNumber(env.JITTER_SAMPLE_WINDOW),
      jitterComputeIntervalTicks: stringNumber(env.JITTER_COMPUTE_INTERVAL_TICKS)
    },
    bookAndAnomalies: {
      orderBookTickSizeDefault: stringNumber(env.ORDER_BOOK_TICK_SIZE_DEFAULT),
      orderBookTickSizes: parseJsonValue(env.ORDER_BOOK_TICK_SIZES),
      domPriceBinSizeDefault: stringNumber(env.DOM_PRICE_BIN_SIZE_DEFAULT),
      domPriceBinSizes: parseJsonValue(env.DOM_PRICE_BIN_SIZES),
      domScanRangePct: stringNumber(env.DOM_SCAN_RANGE_PCT),
      domWallHistoryLimit: stringNumber(env.DOM_WALL_HISTORY_LIMIT),
      domSpoofProximityBps: stringNumber(env.DOM_SPOOF_PROXIMITY_BPS),
      anomalyPriceZThreshold: stringNumber(env.ANOMALY_PRICE_Z_THRESHOLD),
      anomalyVolumeZThreshold: stringNumber(env.ANOMALY_VOLUME_Z_THRESHOLD),
      anomalyCancelExecRatioThreshold: stringNumber(env.ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD),
      anomalyPriceWindowMs: stringNumber(env.ANOMALY_PRICE_WINDOW_MS),
      anomalyVolumeWindowMs: stringNumber(env.ANOMALY_VOLUME_WINDOW_MS),
      anomalyTopOfBookWindowMs: stringNumber(env.ANOMALY_TOP_OF_BOOK_WINDOW_MS)
    },
    operations: {
      notifierDebounceMs: stringNumber(env.NOTIFIER_DEBOUNCE_MS),
      janitorIntervalMs: stringNumber(env.JANITOR_INTERVAL_MS),
      janitorLogRetentionDays: stringNumber(env.JANITOR_LOG_RETENTION_DAYS),
      janitorTelemetryMaxRows: stringNumber(env.JANITOR_TELEMETRY_MAX_ROWS),
      marketTickJournalInterval: stringNumber(env.MARKET_TICK_JOURNAL_INTERVAL),
      marketTickMaxRows: stringNumber(env.MARKET_TICK_MAX_ROWS),
      newsFeeds: parseJsonValue(env.NEWS_FEEDS)
    }
  };
}

function hasEndpointPath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.pathname.replace(/\//g, "").length > 0;
  } catch {
    return false;
  }
}

function redactedEndpoint(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return hasEndpointPath(value) ? `${url.origin}/<dwellir-route>` : url.origin;
  } catch {
    return "<invalid-endpoint>";
  }
}

export async function vaultStatus(env: Env): Promise<JsonRecord> {
  const keys = [
    "EXCHANGE_API_KEY",
    "EXCHANGE_API_SECRET",
    "HL_AGENT_ADDRESS",
    "HL_AGENT_SECRET",
    "JWT_SECRET",
    "ADMIN_PASSWORD",
    "DISCORD_WEBHOOK_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "ALERT_WEBHOOK_URL"
  ];
  const entries: JsonRecord = {};

  for (const keyName of keys) {
    const metadata = await env.RISK_VAULT.get<JsonRecord>(`vault:metadata:${keyName}`, "json");
    entries[keyName] = {
      envConfigured: Boolean((env as unknown as Record<string, string | undefined>)[keyName]),
      vaultConfigured: Boolean(metadata),
      masked: Boolean((env as unknown as Record<string, string | undefined>)[keyName] ?? metadata)
        ? "********"
        : null,
      updatedAt: typeof metadata?.updatedAt === "string" ? metadata.updatedAt : null,
      updatedBy: typeof metadata?.updatedBy === "string" ? metadata.updatedBy : null
    };
  }

  return {
    entries,
    rotationPolicy:
      "Use encrypted RISK_VAULT requests for short-lived rotation workflow; promote durable credentials with wrangler secret in production."
  };
}

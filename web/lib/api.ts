import type {
  AdminSettingsResponse,
  AdminStateResponse,
  AlertingResponse,
  AlertPriority,
  AlertTestResponse,
  AttributionResponse,
  CascadeActiveResponse,
  CascadeHeatResponse,
  CascadeLiveApprovalResponse,
  CascadePositionsResponse,
  CascadeSignalsResponse,
  CostBudgetSettings,
  CostDashboardResponse,
  CascadeBacktestResponse,
  CongressPnlRefreshResponse,
  CongressAlphaBotResponse,
  CongressAlphaSettings,
  CongressMacroHeatmapResponse,
  CongressPeriod,
  CongressRunsResponse,
  CongressRunTriggerResponse,
  CongressStatusResponse,
  CongressTickerHierarchyResponse,
  CongressTransactionsResponse,
  DiagnosticsResponse,
  DotCastGenericStatusResponse,
  DotCastHealthResponse,
  DotCastLivestreamCreateResponse,
  DotCastLivestreamReadResponse,
  DotCastResolutionChallengeResponse,
  DotCastResolutionChallengesResponse,
  DotCastResolutionReviewQueueResponse,
  DotCastResolutionReviewsResponse,
  DotCastResolutionRouterStatusResponse,
  DotCastSettlementRailStatusResponse,
  ExecutionQualityResponse,
  GlobalRiskConfig,
  JsonRecord,
  LiveReadinessResponse,
  LoginResponse,
  MacroBiasDirection,
  NotificationSettingsUpdate,
  PrivateEquityDealsResponse,
  ReplayResponse,
  ReplayStatusResponse,
  StrategyVaultResponse,
  TemporaryGovernanceOverride,
  TradeHistoryResponse,
  TraceResponse,
  VaultKeyName,
  VaultStatusResponse
} from "./types";

export const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_SOVEREIGN_API_BASE ?? "https://api.yevow.co";

export class SovereignApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

type ApiFetchInit = RequestInit & { allowErrorBody?: boolean };

export function normalizeApiBase(value: string): string {
  return value.replace(/\/+$/, "");
}

export function toWebSocketUrl(apiBase: string, token: string): string {
  const base = normalizeApiBase(apiBase);
  const url = new URL(`${base}/admin/stream`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("access_token", token);
  return url.toString();
}

export async function login(apiBase: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>(apiBase, "/login", "", {
    method: "POST",
    body: JSON.stringify({
      password,
      subject: "command-center",
      scopes: ["READ", "WRITE"]
    })
  });
}

export async function readState(apiBase: string, token: string): Promise<AdminStateResponse> {
  return apiFetch<AdminStateResponse>(apiBase, "/admin/state", token);
}

export async function readPrivateEquityDeals(
  apiBase = DEFAULT_API_BASE
): Promise<PrivateEquityDealsResponse> {
  return apiFetch<PrivateEquityDealsResponse>(apiBase, "/api/equity-deals", "");
}

export async function readDotCastHealth(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastHealthResponse> {
  return apiFetch<DotCastHealthResponse>(apiBase, "/api/dotcast/health", "", {
    allowErrorBody: true
  });
}

export async function readDotCastSettlementRailStatus(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastSettlementRailStatusResponse> {
  return apiFetch<DotCastSettlementRailStatusResponse>(
    apiBase,
    "/api/dotcast/settlement-rail/status",
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function readDotCastRewardedStreamStatus(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(
    apiBase,
    "/api/dotcast/rewarded-streams/status",
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function readDotCastSponsoredQuestionsStatus(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(
    apiBase,
    "/api/dotcast/sponsored-questions/status",
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function readDotCastCreatorEconomyStatus(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(apiBase, "/api/dotcast/creators/status", "", {
    allowErrorBody: true
  });
}

export async function readDotCastReferralStatus(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(apiBase, "/api/dotcast/referrals/status", "", {
    allowErrorBody: true
  });
}

export async function readDotCastResolutionRouterStatus(
  apiBase = DEFAULT_API_BASE
): Promise<DotCastResolutionRouterStatusResponse> {
  return apiFetch<DotCastResolutionRouterStatusResponse>(
    apiBase,
    "/api/dotcast/resolution-router/status",
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function readDotCastResolutionReviewQueue(
  apiBase = DEFAULT_API_BASE,
  limit = 10,
  status?: string
): Promise<DotCastResolutionReviewQueueResponse> {
  const search = new URLSearchParams({ limit: String(limit) });
  if (status) {
    search.set("status", status);
  }

  return apiFetch<DotCastResolutionReviewQueueResponse>(
    apiBase,
    `/api/dotcast/resolution-router/reviews/queue?${search.toString()}`,
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function readDotCastResolutionReviews(
  apiBase = DEFAULT_API_BASE,
  limit = 10,
  status?: string
): Promise<DotCastResolutionReviewsResponse> {
  const search = new URLSearchParams({ limit: String(limit) });
  if (status) {
    search.set("status", status);
  }

  return apiFetch<DotCastResolutionReviewsResponse>(
    apiBase,
    `/api/dotcast/resolution-router/reviews?${search.toString()}`,
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function applyDotCastResolutionReviewDecision(
  apiBase: string,
  payload: {
    routeId: string;
    action: "approve" | "deny" | "reshape";
    reviewerId?: string;
    resolutionStatement?: string;
    blockedReason?: string;
    steeringPrompt?: string;
    sourceBindings?: JsonRecord[];
    metadata?: JsonRecord;
  }
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(
    apiBase,
    "/api/dotcast/resolution-router/reviews/decision",
    "",
    {
      method: "POST",
      body: JSON.stringify(payload),
      allowErrorBody: true
    }
  );
}

export async function readDotCastResolutionChallenges(
  apiBase = DEFAULT_API_BASE,
  limit = 10,
  status?: string
): Promise<DotCastResolutionChallengesResponse> {
  const search = new URLSearchParams({ limit: String(limit) });
  if (status) {
    search.set("status", status);
  }

  return apiFetch<DotCastResolutionChallengesResponse>(
    apiBase,
    `/api/dotcast/resolution-router/challenges?${search.toString()}`,
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function openDotCastResolutionChallenge(
  apiBase: string,
  payload: {
    routeId: string;
    route?: JsonRecord;
    challengerId: string;
    reason: string;
    evidenceRefs?: string[];
    bondMinorUnits?: number;
    challengeId?: string;
    windowSeconds?: number;
    metadata?: JsonRecord;
    now?: string;
  }
): Promise<DotCastResolutionChallengeResponse> {
  return apiFetch<DotCastResolutionChallengeResponse>(
    apiBase,
    "/api/dotcast/resolution-router/challenges",
    "",
    {
      method: "POST",
      body: JSON.stringify(payload),
      allowErrorBody: true
    }
  );
}

export async function decideDotCastResolutionChallenge(
  apiBase: string,
  challengeId: string,
  payload: {
    action: "accept" | "reject" | "expire";
    decisionBy?: string;
    reason?: string;
    metadata?: JsonRecord;
  }
): Promise<DotCastResolutionChallengeResponse> {
  return apiFetch<DotCastResolutionChallengeResponse>(
    apiBase,
    `/api/dotcast/resolution-router/challenges/${encodeURIComponent(challengeId)}/decision`,
    "",
    {
      method: "POST",
      body: JSON.stringify(payload),
      allowErrorBody: true
    }
  );
}

export async function createDotCastLivestream(
  apiBase: string,
  payload: { streamId?: string; hostId: string; title: string; metadata?: JsonRecord }
): Promise<DotCastLivestreamCreateResponse> {
  return apiFetch<DotCastLivestreamCreateResponse>(apiBase, "/api/dotcast/livestreams", "", {
    method: "POST",
    body: JSON.stringify(payload),
    allowErrorBody: true
  });
}

export async function readDotCastLivestream(
  apiBase: string,
  streamId: string
): Promise<DotCastLivestreamReadResponse> {
  return apiFetch<DotCastLivestreamReadResponse>(
    apiBase,
    `/api/dotcast/livestreams/${encodeURIComponent(streamId)}`,
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function readDotCastLivestreamPlayback(
  apiBase: string,
  streamId: string
): Promise<DotCastLivestreamCreateResponse> {
  return apiFetch<DotCastLivestreamCreateResponse>(
    apiBase,
    `/api/dotcast/livestreams/${encodeURIComponent(streamId)}/playback`,
    "",
    {
      allowErrorBody: true
    }
  );
}

export async function updateDotCastLivestreamState(
  apiBase: string,
  streamId: string,
  action: "start" | "pause" | "resume" | "end" | "archive"
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(
    apiBase,
    `/api/dotcast/livestreams/${encodeURIComponent(streamId)}/${action}`,
    "",
    {
      method: "POST",
      body: JSON.stringify({ now: new Date().toISOString() }),
      allowErrorBody: true
    }
  );
}

export async function attachDotCastLivestreamPool(
  apiBase: string,
  streamId: string,
  payload: {
    poolId: string;
    marketId: string;
    question: string;
    unit: "cash" | "points";
    status?: string;
    pinned?: boolean;
  }
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(
    apiBase,
    `/api/dotcast/livestreams/${encodeURIComponent(streamId)}/pools`,
    "",
    {
      method: "POST",
      body: JSON.stringify(payload),
      allowErrorBody: true
    }
  );
}

export async function applyDotCastResolverAdminAction(
  apiBase: string,
  resolverId: string,
  payload: {
    action: "activate" | "suspend" | "archive" | "adjust_bond" | "adjust_reputation";
    adminId?: string;
    bondDeltaMinorUnits?: number;
    reputationDeltaBps?: number;
    reason?: string;
    metadata?: JsonRecord;
  }
): Promise<DotCastGenericStatusResponse> {
  return apiFetch<DotCastGenericStatusResponse>(
    apiBase,
    `/api/dotcast/resolution-router/resolvers/profiles/${encodeURIComponent(resolverId)}/admin`,
    "",
    {
      method: "POST",
      body: JSON.stringify(payload),
      allowErrorBody: true
    }
  );
}

export async function readConfig(
  apiBase: string,
  token: string
): Promise<{ ok: true; config: GlobalRiskConfig }> {
  return apiFetch<{ ok: true; config: GlobalRiskConfig }>(apiBase, "/admin/config", token);
}

export async function readTrace(apiBase: string, token: string): Promise<TraceResponse> {
  return apiFetch<TraceResponse>(apiBase, "/admin/trace?limit=50", token);
}

export async function readAttribution(
  apiBase: string,
  token: string
): Promise<AttributionResponse> {
  return apiFetch<AttributionResponse>(apiBase, "/admin/attribution?limit=1000", token);
}

export async function readTradeHistory(
  apiBase: string,
  token: string
): Promise<TradeHistoryResponse> {
  return apiFetch<TradeHistoryResponse>(apiBase, "/admin/history?status=ALL&limit=250", token);
}

export async function readCongressStatus(
  apiBase: string,
  token: string
): Promise<CongressStatusResponse> {
  return apiFetch<CongressStatusResponse>(apiBase, "/admin/congress/status", token, {
    allowErrorBody: true
  });
}

export async function readCongressRuns(
  apiBase: string,
  token: string,
  limit = 10
): Promise<CongressRunsResponse> {
  return apiFetch<CongressRunsResponse>(apiBase, `/admin/congress/runs?limit=${limit}`, token, {
    allowErrorBody: true
  });
}

export async function readCongressTransactions(
  apiBase: string,
  token: string,
  limit = 100,
  offset = 0
): Promise<CongressTransactionsResponse> {
  return apiFetch<CongressTransactionsResponse>(
    apiBase,
    `/admin/congress/transactions?limit=${limit}&offset=${offset}`,
    token,
    {
      allowErrorBody: true
    }
  );
}

export async function readCongressTickerHierarchy(
  apiBase: string,
  token: string,
  period: CongressPeriod = "24h"
): Promise<CongressTickerHierarchyResponse> {
  return apiFetch<CongressTickerHierarchyResponse>(
    apiBase,
    `/admin/congress/tickers?period=${encodeURIComponent(period)}&basis=created_at`,
    token,
    {
      allowErrorBody: true
    }
  );
}

export async function readCongressMacroHeatmap(
  apiBase: string,
  token: string,
  limit = 14
): Promise<CongressMacroHeatmapResponse> {
  return apiFetch<CongressMacroHeatmapResponse>(
    apiBase,
    `/admin/congress/macro?limit=${limit}`,
    token,
    {
      allowErrorBody: true
    }
  );
}

export async function triggerCongressRun(
  apiBase: string,
  token: string,
  source: "all" | "house" | "senate" = "all",
  options: { filingYear?: number; maxDownloadsPerSource?: number; reason?: string } = {}
): Promise<CongressRunTriggerResponse> {
  return apiFetch<CongressRunTriggerResponse>(apiBase, "/admin/congress/run", token, {
    method: "POST",
    body: JSON.stringify({
      source,
      filingYear: options.filingYear,
      maxDownloadsPerSource: options.maxDownloadsPerSource,
      reason: options.reason ?? "command-center-manual-run"
    })
  });
}

export async function refreshCongressPnl(
  apiBase: string,
  token: string,
  limit = 100
): Promise<CongressPnlRefreshResponse> {
  return apiFetch<CongressPnlRefreshResponse>(apiBase, "/admin/congress/pnl/refresh", token, {
    method: "POST",
    body: JSON.stringify({ limit })
  });
}

export async function backfillCongressOptions(
  apiBase: string,
  token: string,
  limit = 500
): Promise<JsonRecord> {
  return apiFetch<JsonRecord>(apiBase, "/admin/congress/options/backfill", token, {
    method: "POST",
    body: JSON.stringify({ limit })
  });
}

export async function readCongressAlphaBot(
  apiBase: string,
  token: string
): Promise<CongressAlphaBotResponse> {
  return apiFetch<CongressAlphaBotResponse>(apiBase, "/admin/congress/alpha", token, {
    allowErrorBody: true
  });
}

export async function runCongressAlphaBot(
  apiBase: string,
  token: string,
  options: {
    bankroll?: number;
    maxPositions?: number;
    minScore?: number;
    maxWeightPct?: number;
    lookbackDays?: number;
    reason?: string;
  } = {}
): Promise<CongressAlphaBotResponse> {
  return apiFetch<CongressAlphaBotResponse>(apiBase, "/admin/congress/alpha/run", token, {
    method: "POST",
    body: JSON.stringify(options),
    allowErrorBody: true
  });
}

export async function updateCongressAlphaSettings(
  apiBase: string,
  token: string,
  settings: Partial<CongressAlphaSettings>
): Promise<CongressAlphaBotResponse> {
  return apiFetch<CongressAlphaBotResponse>(apiBase, "/admin/congress/alpha/settings", token, {
    method: "POST",
    body: JSON.stringify(settings),
    allowErrorBody: true
  });
}

export async function enrichCongressAlphaUniverse(
  apiBase: string,
  token: string
): Promise<{ ok: boolean; enriched: number; sources: JsonRecord; error?: string }> {
  return apiFetch(apiBase, "/admin/congress/alpha/enrich", token, {
    method: "POST",
    body: JSON.stringify({}),
    allowErrorBody: true
  });
}

export async function runCongressAlphaBacktest(
  apiBase: string,
  token: string
): Promise<{
  ok: boolean;
  backtestId: string;
  settings: JsonRecord;
  result: JsonRecord;
  error?: string;
}> {
  return apiFetch(apiBase, "/admin/congress/alpha/backtest", token, {
    method: "POST",
    body: JSON.stringify({}),
    allowErrorBody: true
  });
}

export async function readCascadeActive(
  apiBase: string,
  token: string
): Promise<CascadeActiveResponse> {
  return apiFetch<CascadeActiveResponse>(apiBase, "/admin/cascade/active", token);
}

export async function readCascadeSignals(
  apiBase: string,
  token: string,
  limit = 50
): Promise<CascadeSignalsResponse> {
  return apiFetch<CascadeSignalsResponse>(apiBase, `/admin/cascade/signals?limit=${limit}`, token);
}

export async function readCascadePositions(
  apiBase: string,
  token: string
): Promise<CascadePositionsResponse> {
  return apiFetch<CascadePositionsResponse>(apiBase, "/admin/cascade/positions", token);
}

export async function readCascadeHeat(
  apiBase: string,
  token: string
): Promise<CascadeHeatResponse> {
  return apiFetch<CascadeHeatResponse>(apiBase, "/admin/cascade/heat", token);
}

export async function runCascadeBacktest(
  apiBase: string,
  token: string,
  payload: {
    fromDate: string;
    toDate: string;
    instruments: string[];
    startingEquity: number;
  }
): Promise<CascadeBacktestResponse> {
  return apiFetch<CascadeBacktestResponse>(apiBase, "/admin/backtest/cascade", token, {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      config: {
        strategyMode: "CASCADE_RECOVERY"
      }
    })
  });
}

export async function closeCascadePosition(
  apiBase: string,
  token: string,
  positionId: string,
  reason = "operator-request"
): Promise<unknown> {
  return apiFetch(
    apiBase,
    `/admin/cascade/positions/${encodeURIComponent(positionId)}/close`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ actor: "command-center", reason })
    }
  );
}

export async function addCascadeBlackout(
  apiBase: string,
  token: string,
  payload: { title: string; startsAt: string; endsAt: string; assets: string[] }
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/cascade/blackout", token, {
    method: "POST",
    body: JSON.stringify({ ...payload, createdBy: "command-center" })
  });
}

export async function readExecutionQuality(
  apiBase: string,
  token: string
): Promise<ExecutionQualityResponse> {
  return apiFetch<ExecutionQualityResponse>(apiBase, "/admin/execution-quality", token);
}

export async function readCostDashboard(
  apiBase: string,
  token: string
): Promise<CostDashboardResponse> {
  return apiFetch<CostDashboardResponse>(apiBase, "/admin/costs", token, {
    allowErrorBody: true
  });
}

export async function updateCostBudgets(
  apiBase: string,
  token: string,
  budgets: Partial<CostBudgetSettings>
): Promise<{ ok: boolean; budgets: CostBudgetSettings }> {
  return apiFetch<{ ok: boolean; budgets: CostBudgetSettings }>(
    apiBase,
    "/admin/costs/budgets",
    token,
    {
      method: "POST",
      body: JSON.stringify(budgets)
    }
  );
}

export async function startReplay(
  apiBase: string,
  token: string,
  payload: {
    limit?: number;
    shadowBankroll?: number;
    speedMultiplier?: number;
    scenario?: "BASELINE" | "FLASH_CRASH" | "DELEVERAGING_2022" | "LATENCY_SHOCK";
    latencyMs?: number;
    slippageBps?: number;
    feeBps?: number;
    exitAfterTicks?: number;
    walkForward?: boolean;
    sentimentAblation?: boolean;
    strategyVersionId?: string | null;
  } = {}
): Promise<ReplayResponse> {
  return apiFetch<ReplayResponse>(apiBase, "/admin/replay", token, {
    method: "POST",
    body: JSON.stringify({
      actor: "command-center",
      limit: 1000,
      shadowBankroll: 5000,
      speedMultiplier: 100,
      scenario: "BASELINE",
      latencyMs: 10,
      slippageBps: 1,
      feeBps: 0,
      exitAfterTicks: 10,
      walkForward: true,
      sentimentAblation: true,
      ...payload
    })
  });
}

export async function readReplayStatus(
  apiBase: string,
  token: string
): Promise<ReplayStatusResponse> {
  return apiFetch<ReplayStatusResponse>(apiBase, "/admin/replay/status", token);
}

export async function readStrategyVault(
  apiBase: string,
  token: string
): Promise<StrategyVaultResponse> {
  return apiFetch<StrategyVaultResponse>(apiBase, "/admin/strategy", token);
}

export async function createStrategyVersion(
  apiBase: string,
  token: string,
  payload: {
    name: string;
    description?: string;
    config?: GlobalRiskConfig;
  }
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/strategy", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function activateStrategyVersion(
  apiBase: string,
  token: string,
  versionId: string
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/strategy/activate", token, {
    method: "POST",
    body: JSON.stringify({ versionId })
  });
}

export async function readAlerts(apiBase: string, token: string): Promise<AlertingResponse> {
  return apiFetch<AlertingResponse>(apiBase, "/admin/alerts", token);
}

export async function readDiagnostics(
  apiBase: string,
  token: string
): Promise<DiagnosticsResponse> {
  return apiFetch<DiagnosticsResponse>(apiBase, "/admin/diagnostics", token);
}

export async function readLiveReadiness(
  apiBase: string,
  token: string
): Promise<LiveReadinessResponse> {
  return apiFetch<LiveReadinessResponse>(apiBase, "/admin/live-readiness", token, {
    allowErrorBody: true
  });
}

export async function approveCascadeLiveReadiness(
  apiBase: string,
  token: string
): Promise<CascadeLiveApprovalResponse> {
  return apiFetch<CascadeLiveApprovalResponse>(apiBase, "/admin/live-readiness/approve", token, {
    method: "POST"
  });
}

export async function readSettings(apiBase: string, token: string): Promise<AdminSettingsResponse> {
  return apiFetch<AdminSettingsResponse>(apiBase, "/admin/settings", token);
}

export async function updateNotificationSettings(
  apiBase: string,
  token: string,
  notifications: NotificationSettingsUpdate
): Promise<Pick<AdminSettingsResponse, "ok" | "notifications" | "alerting">> {
  return apiFetch<Pick<AdminSettingsResponse, "ok" | "notifications" | "alerting">>(
    apiBase,
    "/admin/settings/notifications",
    token,
    {
      method: "POST",
      body: JSON.stringify({ notifications })
    }
  );
}

export async function readVaultStatus(
  apiBase: string,
  token: string
): Promise<VaultStatusResponse> {
  return apiFetch<VaultStatusResponse>(apiBase, "/admin/vault", token);
}

export async function rotateVaultSecret(
  apiBase: string,
  token: string,
  payload: {
    keyName: VaultKeyName;
    secret: string;
    rotationReason: string;
  }
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/vault", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function testVaultConnection(apiBase: string, token: string): Promise<unknown> {
  return apiFetch(apiBase, "/admin/vault/test", token, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function sendTestAlert(
  apiBase: string,
  token: string,
  priority: AlertPriority = "HIGH"
): Promise<AlertTestResponse> {
  return apiFetch<AlertTestResponse>(apiBase, "/admin/alerts/test", token, {
    method: "POST",
    body: JSON.stringify({
      priority,
      title: "Sovereign-Sigma alert route test",
      message: "Manual Command Center alert-route verification.",
      metadata: {
        source: "command-center",
        requestedAt: new Date().toISOString()
      }
    })
  });
}

export async function updateConfig(
  apiBase: string,
  token: string,
  config: Partial<GlobalRiskConfig>
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      confirmHighImpact: true,
      config
    })
  });
}

export async function updateTradingMode(
  apiBase: string,
  token: string,
  mode: "OBSERVE" | "PAPER" | "LIVE"
): Promise<unknown> {
  const live = mode === "LIVE";
  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      actor: "command-center",
      confirmHighImpact: true,
      confirmLive: live,
      mode: live ? "LIVE" : "PAPER",
      config: {
        TRADING_ENABLED: mode !== "OBSERVE"
      }
    })
  });
}

export async function injectMoltworkerIntent(
  apiBase: string,
  token: string,
  payload: {
    direction: MacroBiasDirection;
    intensity: number;
    confidence: number;
    reason: string;
    durationMinutes: number;
    governanceMode: "MANUAL" | "AUTONOMOUS" | "HYBRID";
    manualSkepticism: number;
    maxSkepticism: number;
  }
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      actor: "moltworker",
      macroBias: {
        direction: payload.direction,
        intensity: payload.intensity,
        confidence: payload.confidence,
        reason: payload.reason,
        durationMinutes: payload.durationMinutes,
        source: "MOLTWORKER"
      },
      temporaryOverride: {
        source: "MOLTWORKER",
        reason: payload.reason,
        durationMinutes: payload.durationMinutes,
        ORACLE_GOVERNANCE_MODE: payload.governanceMode,
        ORACLE_MANUAL_SKEPTICISM: payload.manualSkepticism,
        ORACLE_MAX_SKEPTICISM: payload.maxSkepticism
      }
    })
  });
}

export async function clearOverride(
  apiBase: string,
  token: string,
  override: TemporaryGovernanceOverride | null
): Promise<unknown> {
  if (!override) {
    return null;
  }

  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      actor: "command-center",
      clearTemporaryOverride: true
    })
  });
}

export async function resetLatencyBaseline(apiBase: string, token: string): Promise<unknown> {
  return apiFetch(apiBase, "/admin/maintenance/reset-latency", token, {
    method: "POST",
    body: JSON.stringify({})
  });
}

async function apiFetch<T>(
  apiBase: string,
  path: string,
  token: string,
  init: ApiFetchInit = {}
): Promise<T> {
  const { allowErrorBody, ...fetchInit } = init;
  const response = await fetch(`${normalizeApiBase(apiBase)}${path}`, {
    ...fetchInit,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...fetchInit.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok && (response.status === 401 || response.status === 403)) {
    throw new SovereignApiError(body?.error ?? `HTTP_${response.status}`, response.status);
  }

  if (!response.ok && !allowErrorBody) {
    throw new SovereignApiError(body?.error ?? `HTTP_${response.status}`, response.status);
  }

  return body as T;
}

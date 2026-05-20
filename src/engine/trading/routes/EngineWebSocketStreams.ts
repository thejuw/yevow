import type {
  AgentSignal,
  EngineState,
  LatencyMetrics,
  MacroBias,
  MarketTick,
  TemporaryGovernanceOverride
} from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import {
  ADMIN_STREAM_PULSE_INTERVAL_MS,
  PERFORMANCE_HISTORY_LIMIT,
  SIGNAL_BUFFER_LIMIT
} from "../../../TradingEngineConstants";
import {
  assertMarketTick,
  decodeWebSocketMessage,
  parseJson
} from "../helpers/RuntimeHelpers";

export interface EngineStreamContext {
  adminSockets: Set<WebSocket>;
  getEngineState(): EngineState;
  getSignals(): AgentSignal[];
  getLatencyHistory(): LatencyMetrics[];
  getMacroBias(): MacroBias;
  getTemporaryOverride(): TemporaryGovernanceOverride | null;
  enqueueTick(tick: MarketTick): Promise<TickIngestResult>;
  waitUntil(promise: Promise<unknown>): void;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  nextBusSequence(): number;
}

export function acceptMarketStream(context: EngineStreamContext): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  const state = context.getEngineState();

  server.accept();
  server.send(
    JSON.stringify({
      type: "SYSTEM_INIT",
      engineId: state.engineId,
      heartbeatAt: state.heartbeatAt
    })
  );

  server.addEventListener("message", (event) => {
    const payload = decodeSocketEventData(event.data);
    const tick = payload ? parseJson<MarketTick>(payload) : null;

    if (!tick) {
      server.send(JSON.stringify({ type: "ERROR", reason: "INVALID_JSON" }));
      return;
    }

    let marketTick: MarketTick;

    try {
      marketTick = assertMarketTick(tick);
    } catch (error) {
      server.send(
        JSON.stringify({
          type: "ERROR",
          reason: error instanceof Error ? error.message : "INVALID_MARKET_TICK"
        })
      );
      return;
    }

    const queued = context
      .enqueueTick(marketTick)
      .then((result) => {
        server.send(
          JSON.stringify({
            type: "ACK",
            accepted: result.accepted,
            status: result.status,
            reason: result.reason,
            instrumentCode: result.metrics?.instrumentCode ?? null,
            sequence: result.metrics?.sequence ?? null,
            totalLatencyMs: result.metrics?.totalLatencyMs ?? null
          })
        );
      })
      .catch((error: unknown) => {
        server.send(
          JSON.stringify({
            type: "ERROR",
            reason: error instanceof Error ? error.message : "UNKNOWN"
          })
        );
      });

    context.waitUntil(queued);
  });

  return new Response(null, { status: 101, webSocket: client });
}

export function acceptTelemetryStream(context: EngineStreamContext): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  const state = context.getEngineState();

  server.accept();
  context.adminSockets.add(server);
  sendSocketMessage(server, {
    type: "TELEMETRY_SNAPSHOT",
    sequence: context.nextBusSequence(),
    emittedAt: new Date().toISOString(),
    payload: {
      state,
      recentSignals: context.getSignals().slice(-SIGNAL_BUFFER_LIMIT),
      recentLatency: context.getLatencyHistory().slice(-PERFORMANCE_HISTORY_LIMIT),
      connectedAdminStreams: context.adminSockets.size
    }
  });
  const pulseInterval = setInterval(() => {
    sendSocketMessage(server, {
      type: "DASHBOARD_PULSE",
      sequence: context.nextBusSequence(),
      emittedAt: new Date().toISOString(),
      payload: dashboardPulsePayload(context)
    });
  }, ADMIN_STREAM_PULSE_INTERVAL_MS);

  server.addEventListener("message", (event) => {
    const payload = decodeSocketEventData(event.data);
    const message = payload ? parseJson<{ type?: string; sentAt?: string }>(payload) : null;

    if (message?.type?.toUpperCase() === "PING") {
      sendSocketMessage(server, {
        type: "PONG",
        sequence: context.nextBusSequence(),
        emittedAt: new Date().toISOString(),
        payload: {
          sentAt: message.sentAt ?? null
        }
      });
    }
  });

  const cleanup = () => {
    clearInterval(pulseInterval);
    context.adminSockets.delete(server);
  };

  server.addEventListener("close", cleanup);
  server.addEventListener("error", cleanup);

  context.publish("ADMIN_STREAM_CONNECTED", {
    connectedAdminStreams: context.adminSockets.size,
    engineId: state.engineId
  });

  return new Response(null, { status: 101, webSocket: client });
}

export function dashboardPulsePayload(context: EngineStreamContext): Record<string, unknown> {
  const state = context.getEngineState();
  const latencyHistory = context.getLatencyHistory();
  const equity = state.bankroll.equity;
  const unrealizedPnl = Object.values(state.openPositions).reduce(
    (sum, position) => sum + position.unrealizedPnl,
    0
  );
  const latestSignals = context
    .getSignals()
    .slice(-10)
    .map((signal) => ({
      signalId: signal.signalId,
      traceId: signal.traceId,
      agent: signal.sourceAgent,
      target: signal.targetAgent,
      action: signal.action,
      confidence: signal.confidence,
      expectedValue: signal.expectedValue,
      rationale: signal.rationale,
      createdAt: signal.createdAt
    }));
  const latestLatency = latencyHistory.at(-1) ?? null;

  return {
    schemaVersion: "admin.dashboard-pulse.v1",
    total_equity: equity,
    unrealized_pnl: unrealizedPnl,
    active_drawdown: state.riskMetrics.rollingDrawdownPct,
    current_imbalance: state.microstructure.weightedImbalance,
    processed_ticks: state.processedTicks,
    mode: state.mode,
    quote_state: state.quoteState.status,
    shadow_queue: state.shadowQueue,
    toxicity_score: state.toxicityScore,
    latency_ms: state.averageLatency,
    exchange_to_receipt_ms: latestLatency?.networkLatencyMs ?? state.averageLatency,
    jitter_ms: state.executionProfile.jitterMs,
    regime: state.oracle.regime,
    regimeCoefficient: state.oracle.skepticismMultiplier,
    macroBias: context.getMacroBias(),
    temporaryOverride: context.getTemporaryOverride(),
    liquidationHeatmap: {
      totalEstimatedNotionalUsd: state.liquidationHeatmap.totalEstimatedNotionalUsd,
      clusterCount: state.liquidationHeatmap.clusters.length,
      nearestCascade: state.liquidationHeatmap.nearestCascade,
      providerEventCount: state.liquidationHeatmap.recentEvents.length,
      updatedAt: state.liquidationHeatmap.updatedAt
    },
    AgentLogicTrace: latestSignals,
    sparkline: latencyHistory.slice(-60).map((metric) => ({
      t: metric.brainTimestamp,
      latency: metric.totalLatencyMs,
      imbalance: metric.status === "FRESH" ? state.microstructure.weightedImbalance : null
    })),
    location: state.location.colo,
    connectedAdminStreams: context.adminSockets.size,
    heartbeatAt: state.heartbeatAt
  };
}

function sendSocketMessage(socket: WebSocket, message: unknown): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    socket.close(1011, "send_failed");
  }
}

function decodeSocketEventData(data: unknown): string | null {
  if (typeof data === "string" || data instanceof ArrayBuffer) {
    return decodeWebSocketMessage(data);
  }

  return null;
}

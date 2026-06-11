import { hostnameOf, redactEndpoint, type ResolvedExchangeStreamConfig } from "./IngestProtocol";
import type { ClockSyncTracker, ClusterPool } from "./StreamRuntime";
import type { ExchangeStreamHealth, IngestHealth } from "../types";

interface ExchangeStreamHealthInput {
  config: ResolvedExchangeStreamConfig;
  clusterPool: ClusterPool;
  clockSync: ClockSyncTracker;
  status: IngestHealth["status"];
  connectionId: string | null;
  attempts: number;
  backoffCounter: number;
  messagesReceived: number;
  ticksForwarded: number;
  ticksDropped: number;
  lastMessageAt: string | null;
  lastForwardAt: string | null;
  lastDisconnectAt: string | null;
  blackoutStartedAt: string | null;
  lastRecoveredAt: string | null;
  lastRecoveryDurationMs: number | null;
  lastError: string | null;
  lastFatalDropAt: string | null;
}

export function packetLossPct(messagesReceived: number, ticksDropped: number): number {
  const totalPackets = messagesReceived + ticksDropped;
  return totalPackets > 0 ? Math.round((ticksDropped / totalPackets) * 10_000) / 100 : 0;
}

export function buildExchangeStreamHealth(input: ExchangeStreamHealthInput): ExchangeStreamHealth {
  return {
    ok: input.status === "CONNECTED",
    streamId: input.config.id,
    source: input.config.source,
    source_exchange: input.config.source_exchange,
    transport: input.config.transport,
    streamHost: hostnameOf(input.clusterPool.activeUrl()),
    activeClusterUrl: redactEndpoint(input.clusterPool.activeUrl()),
    subscriptionProfile: input.config.subscriptionProfile,
    heartbeatLatencyMs: input.clusterPool.activeHeartbeatLatencyMs(),
    packetLossPct: packetLossPct(input.messagesReceived, input.ticksDropped),
    sourceWeight: input.config.weight,
    clockOffsetMs: input.clockSync.currentOffsetMs(),
    status: input.status,
    connectionId: input.connectionId,
    attempts: input.attempts,
    backoffCounter: input.backoffCounter,
    messagesReceived: input.messagesReceived,
    ticksForwarded: input.ticksForwarded,
    ticksDropped: input.ticksDropped,
    lastMessageAt: input.lastMessageAt,
    lastForwardAt: input.lastForwardAt,
    lastDisconnectAt: input.lastDisconnectAt,
    blackoutStartedAt: input.blackoutStartedAt,
    lastRecoveredAt: input.lastRecoveredAt,
    lastRecoveryDurationMs: input.lastRecoveryDurationMs,
    lastError: input.lastError,
    lastFatalDropAt: input.lastFatalDropAt
  };
}

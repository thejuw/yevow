import type { ResolvedExchangeStreamConfig } from "./IngestProtocol";

export const NORMAL_RECYCLE_LOG_THROTTLE_MS = 60_000;

interface ResetDecisionInput {
  hasConnectedOnce: boolean;
  previousDisconnectReason: string | null;
  config: ResolvedExchangeStreamConfig;
  blackoutDurationMs: number;
  fatalDropMs: number;
}

export function shouldResetBookOnConnect(input: ResetDecisionInput): boolean {
  if (!input.hasConnectedOnce) {
    return true;
  }
  if (!isNormalProviderRecycle(input.config, input.previousDisconnectReason)) {
    return true;
  }

  return input.blackoutDurationMs > Math.max(1_000, input.fatalDropMs);
}

export function isNormalProviderRecycle(
  config: ResolvedExchangeStreamConfig,
  reason: string | null
): boolean {
  return (
    config.source === "HYPERLIQUID" &&
    config.transport === "websocket" &&
    config.id.startsWith("dwellir-hyperliquid-orderbook") &&
    reason === "CLOSE_1000"
  );
}

export function currentBlackoutDurationMs(
  blackoutStartedAt: string | null,
  at: string = new Date().toISOString()
): number {
  if (!blackoutStartedAt) {
    return 0;
  }

  return Math.max(0, Date.parse(at) - Date.parse(blackoutStartedAt));
}

export function shouldThrottleNormalRecycleLog(
  previousLogAt: number,
  now: number,
  throttleMs = NORMAL_RECYCLE_LOG_THROTTLE_MS
): boolean {
  return now - previousLogAt < throttleMs;
}

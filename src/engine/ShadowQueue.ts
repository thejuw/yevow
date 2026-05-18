import type { Env } from "../types";
import { GhostBook, type GhostBookConfig } from "../utils/GhostBook";

const DEFAULT_SHADOW_VLO_CAPACITY = 512;
const DEFAULT_SHADOW_VLO_DRIFT_TRADES = 3;
const DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER = 1;
const DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS = 1;
const DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS = 5;
const DEFAULT_SHADOW_VLO_MIN_SIZE = 0.00000001;

export function createShadowQueue(env: Env): GhostBook {
  return new GhostBook(resolveShadowQueueConfig(env));
}

export function resolveShadowQueueConfig(env: Env): GhostBookConfig {
  return {
    capacity: readPositiveInteger(
      env.SHADOW_VLO_CAPACITY,
      DEFAULT_SHADOW_VLO_CAPACITY,
      128,
      16_384
    ),
    driftTradeDelay: readPositiveInteger(
      env.SHADOW_VLO_DRIFT_TRADES,
      DEFAULT_SHADOW_VLO_DRIFT_TRADES,
      1,
      100
    ),
    queueDepthMultiplier: readBoundedNumber(
      env.SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
      DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
      0,
      10
    ),
    baseSpreadBps: readPositiveNumber(
      env.SHADOW_VLO_BASE_SPREAD_BPS,
      DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS
    ),
    latencyBudgetMs: readPositiveNumber(
      env.SHADOW_VLO_LATENCY_BUDGET_MS,
      DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS
    ),
    minSize: readPositiveNumber(env.SHADOW_VLO_MIN_SIZE, DEFAULT_SHADOW_VLO_MIN_SIZE)
  };
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

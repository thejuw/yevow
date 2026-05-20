import {
  DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
  DEFAULT_SHADOW_VLO_CAPACITY,
  DEFAULT_SHADOW_VLO_DRIFT_TRADES,
  DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
  DEFAULT_SHADOW_VLO_MIN_SIZE,
  DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER
} from "../../../TradingEngineConstants";
import type { GhostBookConfig } from "../../../utils/GhostBook";
import type { Env } from "../../../types";
import {
  readBoundedNumber,
  readPositiveInteger,
  readPositiveNumber
} from "../helpers/RuntimeParsing";

export function resolveGhostBookConfig(env: Env): GhostBookConfig {
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

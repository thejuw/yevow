import type { EdgeTopology, EngineState, Env, GlobalRiskConfig, JsonRecord } from "../../../types";
import { ENGINE_STATE_KEY, WARM_UP_INTERVAL_MS } from "../../../TradingEngineConstants";
import {
  applyTopologyObservationSideEffects,
  stateAfterLocationLatency,
  stateAfterTopologyObservation
} from "./PlacementResolver";
import { applyTopologyWarmUpRuntime } from "./TopologyWarmUpRuntime";

export interface TradingTopologyTarget {
  engineState: EngineState;
  warmedColo: string | null;
  warmedAt: number;
  readonly env: Pick<
    Env,
    "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS" | "HIGH_LATENCY_COLO_RISK_MULTIPLIER"
  >;
  readonly cachedConfig: Pick<
    GlobalRiskConfig,
    "version" | "TRADING_ENABLED" | "MAX_POSITION_SIZE" | "MAX_DRAWDOWN_PCT" | "GOLDEN_COLOS"
  >;
  readonly configManager: {
    fetchConfig(): Promise<GlobalRiskConfig>;
  };
  readonly state: {
    readonly storage: {
      get<T = unknown>(key: string): Promise<T | undefined>;
    };
    waitUntil(work: Promise<unknown>): void;
  };
  readonly logger: {
    info(eventType: string, message: string, telemetry?: JsonRecord): void;
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
    error(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  waitUntilStoragePut(key: string, value: unknown, reason: string): void;
}

export function observeTradingTopologyForTarget(
  topology: EdgeTopology,
  target: TradingTopologyTarget
): void {
  const observation = stateAfterTopologyObservation({
    state: target.engineState,
    topology,
    env: target.env,
    config: target.cachedConfig
  });

  applyTopologyObservationSideEffects(
    {
      observation,
      maxOrderNotional: observation.state.risk.maxOrderNotional,
      baseMaxPositionSize: target.cachedConfig.MAX_POSITION_SIZE
    },
    {
      applyState: (state) => {
        target.engineState = state;
      },
      persistState: () => {
        target.waitUntilStoragePut(ENGINE_STATE_KEY, target.engineState, "COLO_TOPOLOGY_CHANGED");
      },
      warn: (event) => {
        target.logger.warn(event.eventType, event.message, event.metadata);
      }
    }
  );
}

export function applyTradingLocationLatencyForTarget(
  totalLatencyMs: number,
  observedAt: string,
  target: TradingTopologyTarget
): void {
  target.engineState = stateAfterLocationLatency({
    state: target.engineState,
    totalLatencyMs,
    observedAt,
    config: target.cachedConfig
  });
}

export function warmUpTradingTopologyForTarget(
  topology: EdgeTopology,
  target: TradingTopologyTarget
): void {
  applyTopologyWarmUpRuntime(
    {
      topology,
      warmedColo: target.warmedColo,
      warmedAt: target.warmedAt,
      intervalMs: WARM_UP_INTERVAL_MS,
      nowMs: Date.now()
    },
    {
      markWarmUp: (colo, warmedAtMs) => {
        target.warmedColo = colo;
        target.warmedAt = warmedAtMs;
      },
      readEngineState: () => target.state.storage.get(ENGINE_STATE_KEY),
      fetchConfig: () => target.configManager.fetchConfig(),
      info: (eventType, message, metadata) => {
        target.logger.info(eventType, message, metadata);
      },
      error: (eventType, message, metadata) => {
        target.logger.error(eventType, message, metadata);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      }
    }
  );
}

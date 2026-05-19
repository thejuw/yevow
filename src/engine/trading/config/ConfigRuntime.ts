import type {
  AdminConfigUpdate,
  EngineLocation,
  EngineState,
  GlobalRiskConfig,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import { mergeRiskLimits, resolveMaxLatencyMs } from "../../../TradingEngineRuntimeHelpers";
import { applyLocationRisk } from "../helpers/PlacementResolver";

export interface RuntimeConfigUpdateInput {
  readonly currentState: EngineState;
  readonly update: AdminConfigUpdate;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly currentMaxLatencyMs: number;
  readonly observedAt: string;
}

export interface RuntimeConfigUpdateResult {
  readonly state: EngineState;
  readonly maxLatencyMs: number;
}

export interface ConfigRefreshStateInput {
  readonly currentState: EngineState;
  readonly nextConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly nextAssetQuoteStates: EngineState["assetQuoteStates"];
  readonly nextQuoteState: EngineState["quoteState"];
  readonly assetMatrix: EngineState["assetMatrix"];
  readonly profilerStates: EngineState["profilerStates"];
  readonly refreshedLocation: EngineLocation;
  readonly observedAt: string;
}

export function stateAfterRuntimeConfigUpdate(
  input: RuntimeConfigUpdateInput
): RuntimeConfigUpdateResult {
  const maxLatencyMs = resolveMaxLatencyMs(input.update, input.currentMaxLatencyMs);
  const nextRisk = input.update.risk
    ? mergeRiskLimits(input.currentState.risk, {
        ...input.update.risk,
        updatedAt: input.observedAt
      })
    : input.currentState.risk;

  return {
    maxLatencyMs,
    state: {
      ...input.currentState,
      mode: input.update.mode ?? input.currentState.mode,
      bankroll: {
        ...input.currentState.bankroll,
        ...input.update.bankroll,
        updatedAt: input.observedAt
      },
      risk: applyLocationRisk(
        nextRisk,
        input.cachedConfig,
        input.currentState.location,
        input.observedAt
      ),
      maxLatencyMs,
      cachedConfig: input.cachedConfig,
      macroBias: input.macroBias,
      temporaryOverride: input.temporaryOverride,
      heartbeatAt: input.observedAt,
      updatedAt: input.observedAt
    }
  };
}

export function stateAfterConfigRefresh(input: ConfigRefreshStateInput): EngineState {
  return {
    ...input.currentState,
    cachedConfig: input.nextConfig,
    macroBias: input.macroBias,
    temporaryOverride: input.temporaryOverride,
    assetQuoteStates: input.nextAssetQuoteStates,
    quoteState: input.nextQuoteState,
    assetMatrix: input.assetMatrix,
    profilerStates: input.profilerStates,
    maxLatencyMs: input.nextConfig.LATENCY_THRESHOLD_MS,
    location: input.refreshedLocation,
    risk: applyLocationRisk(
      {
        ...input.currentState.risk,
        configVersion: input.nextConfig.version,
        killSwitch: !input.nextConfig.TRADING_ENABLED,
        maxOrderNotional: input.nextConfig.MAX_POSITION_SIZE,
        maxDrawdownPct: input.nextConfig.MAX_DRAWDOWN_PCT,
        updatedAt: input.observedAt
      },
      input.nextConfig,
      input.refreshedLocation,
      input.observedAt
    ),
    updatedAt: input.observedAt
  };
}

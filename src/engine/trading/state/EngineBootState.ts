import { defaultOracleState } from "../../../agents/OracleAgent";
import { defaultSentimentState } from "../../../agents/SentimentAgent";
import {
  DEFAULT_MAX_INVENTORY_DELTA,
  DEFAULT_MAX_INVENTORY_UNITS
} from "../../../TradingEngineConstants";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import { applyLocationRisk, defaultEngineLocation } from "../helpers/PlacementResolver";
import { countBookLevels } from "../book/BookReconstruction";
import { hydrateOrderBooks } from "../book/BookRuntimeHelpers";
import { calculateOrderBookPriceDiscovery } from "../book/BookViews";
import { sanitizeWallHistory } from "../book/DomRuntimeHelpers";
import type { SortedBookSide } from "../book/SortedBookSide";
import type {
  AdminConfigUpdate,
  AnomalyStatus,
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  LatencyMetrics,
  LiquidationHeatmapState,
  LiquidityWall,
  MacroBias,
  ProfilerState,
  RiskLimits,
  ShadowQueueState,
  TemporaryGovernanceOverride
} from "../../../types";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import {
  defaultQuoteState,
  normalizeAssetMatrix,
  normalizeAssetQuoteStates
} from "./AssetStateRuntime";
import {
  defaultCitadelState,
  defaultEngineState,
  defaultEnsembleState,
  defaultInventoryGuardState,
  defaultJanitorState,
  defaultLeadLagMetrics,
  defaultMicrostructure,
  defaultRiskMetrics,
  defaultSlippageAnalytics,
  mergeRiskLimits,
  normalizeExecutionProfile,
  normalizeInventoryState,
  normalizePaperBankroll
} from "./EngineStateDefaults";

export interface HydratedEngineStateInput {
  readonly baseState: EngineState;
  readonly env: Env;
  readonly now: string;
  readonly kvConfig: AdminConfigUpdate | null;
  readonly kvRiskLimits: Partial<RiskLimits> | null;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly liquidationHeatmap: LiquidationHeatmapState;
  readonly profilerStates: Record<string, ProfilerState>;
  readonly shadowQueue: ShadowQueueState;
  readonly anomaly: AnomalyStatus;
  readonly maxLatencyMs: number;
  readonly jitterThresholdMs: number;
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly processingLatencySampleCount: number;
}

export interface EngineBootCollectionsInput {
  readonly persistedBooks: Map<string, InternalOrderBook>;
  readonly persistedLatencyHistory: LatencyMetrics[] | undefined;
  readonly persistedProcessingLatencySamples: number[] | undefined;
  readonly persistedDomWallHistory: LiquidityWall[] | undefined;
  readonly performanceHistoryLimit: number;
  readonly jitterSampleWindow: number;
  readonly domWallHistoryLimit: number;
  readonly filterTargetOrderBooks: (
    records: Map<string, InternalOrderBook>
  ) => Map<string, InternalOrderBook>;
}

export interface EngineBootCollections {
  readonly hydratedBooks: ReturnType<typeof hydrateOrderBooks>;
  readonly latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: number[];
  readonly domWallHistory: LiquidityWall[];
}

export function hydrateEngineBootCollections(
  input: EngineBootCollectionsInput
): EngineBootCollections {
  return {
    hydratedBooks: hydrateOrderBooks(input.filterTargetOrderBooks(input.persistedBooks)),
    latencyHistory: (input.persistedLatencyHistory ?? []).slice(-input.performanceHistoryLimit),
    processingLatencySamples: (input.persistedProcessingLatencySamples ?? [])
      .filter((sample) => Number.isFinite(sample) && sample >= 0)
      .slice(-input.jitterSampleWindow),
    domWallHistory: sanitizeWallHistory(input.persistedDomWallHistory).slice(
      -input.domWallHistoryLimit
    )
  };
}

export function buildHydratedEngineState(input: HydratedEngineStateInput): EngineState {
  const location = input.baseState.location ?? defaultEngineLocation();
  const risk = applyLocationRisk(
    mergeRiskLimits(
      mergeRiskLimits(input.baseState.risk, input.kvRiskLimits),
      input.kvConfig?.risk
    ),
    input.cachedConfig,
    location,
    input.now
  );
  const bankroll = normalizePaperBankroll(
    {
      ...input.baseState.bankroll,
      ...input.kvConfig?.bankroll,
      updatedAt: input.now
    },
    input.env,
    input.now
  );

  return {
    ...input.baseState,
    mode: input.kvConfig?.mode ?? input.baseState.mode,
    bankroll,
    agentHealth: {
      ...defaultEngineState(input.baseState.engineId).agentHealth,
      ...input.baseState.agentHealth
    },
    risk,
    internalOrderBookDepth: countBookLevels(input.bids, input.asks),
    averageLatency: input.baseState.averageLatency ?? 0,
    latencySampleCount: input.baseState.latencySampleCount ?? 0,
    staleTickCount: input.baseState.staleTickCount ?? 0,
    toxicityScore: input.baseState.toxicityScore ?? maxProfilerToxicity(input.profilerStates),
    current_inventory_delta:
      input.baseState.current_inventory_delta ??
      input.baseState.inventory?.current_inventory_delta ??
      input.baseState.inventory?.netDelta ??
      0,
    liquidationHeatmap: input.liquidationHeatmap,
    maxLatencyMs: input.maxLatencyMs,
    cachedConfig: input.cachedConfig,
    macroBias: input.macroBias,
    temporaryOverride: input.temporaryOverride,
    assetMatrix: normalizeAssetMatrix(
      input.baseState.assetMatrix,
      input.cachedConfig,
      input.macroBias,
      input.now
    ),
    assetQuoteStates: normalizeAssetQuoteStates(
      input.baseState.assetQuoteStates,
      input.cachedConfig,
      input.macroBias,
      input.now
    ),
    profilerStates: input.profilerStates,
    location,
    fundingRates: input.baseState.fundingRates ?? {},
    microstructure: input.baseState.microstructure ?? defaultMicrostructure(),
    priceDiscovery:
      input.baseState.priceDiscovery ??
      calculateOrderBookPriceDiscovery(
        input.orderBook,
        input.baseState.microstructure?.instrumentCode,
        input.now
      ),
    oracle: input.baseState.oracle ?? defaultOracleState(),
    sentiment: input.baseState.sentiment ?? defaultSentimentState(),
    ensemble: input.baseState.ensemble ?? defaultEnsembleState(input.now),
    leadLag: input.baseState.leadLag ?? defaultLeadLagMetrics(),
    inventory: normalizeInventoryState(
      input.baseState.inventory,
      readPositiveNumber(input.env.MAX_INVENTORY_UNITS, DEFAULT_MAX_INVENTORY_UNITS),
      readPositiveNumber(input.env.MAX_INVENTORY_DELTA, DEFAULT_MAX_INVENTORY_DELTA)
    ),
    riskMetrics: input.baseState.riskMetrics ?? defaultRiskMetrics(bankroll.equity, input.now),
    quoteState: input.baseState.quoteState ?? defaultQuoteState(),
    shadowQueue: input.shadowQueue,
    lastTradeIntent: input.baseState.lastTradeIntent ?? null,
    inventoryGuard:
      input.baseState.inventoryGuard ??
      (input.baseState as EngineState & { hedge?: EngineState["inventoryGuard"] }).hedge ??
      defaultInventoryGuardState(),
    janitor: input.baseState.janitor ?? defaultJanitorState(),
    slippage: input.baseState.slippage ?? defaultSlippageAnalytics(),
    orderMap: input.baseState.orderMap ?? {},
    executionProfile: normalizeExecutionProfile(
      input.baseState.executionProfile,
      input.jitterThresholdMs,
      input.jitterSampleWindow,
      input.jitterComputeIntervalTicks,
      input.processingLatencySampleCount,
      input.now
    ),
    citadel: {
      ...(input.baseState.citadel ?? defaultCitadelState(input.now)),
      shadowMode: isShadowMode(input.env),
      updatedAt: input.now
    },
    dom: input.baseState.dom ?? null,
    anomaly: input.baseState.anomaly ?? input.anomaly,
    heartbeatAt: input.now,
    updatedAt: input.now
  };
}

function maxProfilerToxicity(profilerStates: Record<string, ProfilerState>): number {
  let maxToxicity = 0;

  for (const state of Object.values(profilerStates)) {
    maxToxicity = Math.max(maxToxicity, state.toxicityScore);
  }

  return maxToxicity;
}

import type { ProfilerAgent } from "../../../agents/ProfilerAgent";
import { countBookLevels, microstructureFromBook } from "../book/BookReconstruction";
import type { BookSyncState } from "../book/BookTypes";
import type { SortedBookSide } from "../book/SortedBookSide";
import { TARGET_ASSET_MATRIX } from "../../../TradingEngineConstants";
import type {
  AssetRuntimeState,
  EngineState,
  HealthReport,
  InternalOrderBook,
  JsonRecord,
  JsonValue,
  PriceDiscoveryMetrics,
  ProfilerState
} from "../../../types";

type RuntimeWithMemory = typeof globalThis & {
  performance?: Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  };
};

export interface MicrostructureSyncContext {
  engineState: EngineState;
  orderBook: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  calculatePriceDiscovery(
    instrumentCode: string | undefined,
    observedAt: string
  ): PriceDiscoveryMetrics;
  calculateAssetMatrix(
    observedAt: string,
    latestInstrumentCode: string | undefined,
    latestOracle: EngineState["oracle"],
    profilerStates: Record<string, ProfilerState>,
    assetQuoteStates: EngineState["assetQuoteStates"]
  ): Record<string, AssetRuntimeState>;
  profilerStateSnapshot(): Record<string, ProfilerState>;
}

export interface EngineDiagnosticsContext {
  engineState: EngineState;
  bookSync: Map<string, BookSyncState>;
  profilerAgents: Map<string, ProfilerAgent>;
}

export interface HealthReportInput {
  readonly engineState: EngineState;
  readonly uptimeMs: number;
}

export function syncStateMicrostructureFromBook(
  context: MicrostructureSyncContext
): EngineState | null {
  if (context.orderBook.size === 0) {
    return null;
  }

  const currentKey = context.engineState.microstructure.marketKey;
  const currentBook = currentKey ? context.orderBook.get(currentKey) : undefined;
  const bestBook =
    currentBook ??
    [...context.orderBook.values()].sort((left, right) => {
      const leftScore =
        (left.isSynced ? 10 : 0) + (left.midPrice === null ? 0 : 1) + left.sourceWeight;
      const rightScore =
        (right.isSynced ? 10 : 0) + (right.midPrice === null ? 0 : 1) + right.sourceWeight;
      return rightScore - leftScore;
    })[0];

  if (!bestBook) {
    return null;
  }

  const microstructure = microstructureFromBook(bestBook);
  const updatedAt = microstructure.updatedAt ?? new Date().toISOString();

  return {
    ...context.engineState,
    internalOrderBookDepth: countBookLevels(context.bids, context.asks),
    microstructure,
    priceDiscovery: context.calculatePriceDiscovery(bestBook.instrumentCode, updatedAt),
    assetMatrix: context.calculateAssetMatrix(
      updatedAt,
      bestBook.instrumentCode,
      context.engineState.oracle,
      context.profilerStateSnapshot(),
      context.engineState.assetQuoteStates
    ),
    updatedAt
  };
}

export function stateAfterHealthHeartbeat(
  engineState: EngineState,
  observedAt: string
): EngineState {
  return {
    ...engineState,
    heartbeatAt: observedAt,
    updatedAt: observedAt
  };
}

export function buildHealthReport(input: HealthReportInput): HealthReport {
  const memory = (globalThis as RuntimeWithMemory).performance?.memory;

  return {
    ok: input.engineState.mode !== "HALTED",
    engineId: input.engineState.engineId,
    mode: input.engineState.mode,
    heartbeatAt: input.engineState.heartbeatAt,
    uptimeMs: input.uptimeMs,
    processedTicks: input.engineState.processedTicks,
    acceptedSignals: input.engineState.acceptedSignals,
    internalOrderBookDepth: input.engineState.internalOrderBookDepth,
    averageLatency: input.engineState.averageLatency,
    staleTickCount: input.engineState.staleTickCount,
    toxicityScore: input.engineState.toxicityScore,
    current_inventory_delta: input.engineState.current_inventory_delta,
    location: input.engineState.location,
    microstructure: input.engineState.microstructure,
    quoteState: input.engineState.quoteState,
    executionProfile: input.engineState.executionProfile,
    anomaly: input.engineState.anomaly,
    memoryUsage: {
      available: Boolean(memory),
      usedJSHeapSize: memory?.usedJSHeapSize ?? null,
      totalJSHeapSize: memory?.totalJSHeapSize ?? null,
      jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
      stateBytesEstimate: JSON.stringify({
        mode: input.engineState.mode,
        processedTicks: input.engineState.processedTicks,
        orderMapSize: Object.keys(input.engineState.orderMap).length,
        orderBookDepth: input.engineState.internalOrderBookDepth
      }).length
    }
  };
}

export function engineDiagnostics(context: EngineDiagnosticsContext): JsonRecord {
  const memory = (globalThis as RuntimeWithMemory).performance?.memory;
  const marketSync = [...context.bookSync.entries()].map(([marketKey, sync]) => ({
    marketKey,
    instrumentCode: sync.instrumentCode,
    isSynced: sync.isSynced,
    lastSequence: sync.lastSequence,
    expectedNextSequence: sync.lastSequence === null ? null : sync.lastSequence + 1,
    desyncReason: sync.desyncReason ?? null,
    lastDesyncAt: sync.lastDesyncAt ?? null
  }));
  const desynced = marketSync.filter((entry) => !entry.isSynced);
  const profilerBuffers = Object.fromEntries(
    [...context.profilerAgents.entries()].map(([instrumentCode, agent]) => [
      instrumentCode,
      agent.diagnostics()
    ])
  );
  const allBuffersFlat = Object.values(profilerBuffers).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { flatMemory?: boolean }).flatMemory === true
  );
  const heapRatio =
    memory?.jsHeapSizeLimit && memory.usedJSHeapSize
      ? memory.usedJSHeapSize / memory.jsHeapSizeLimit
      : null;

  return {
    ok: desynced.length === 0 && allBuffersFlat && (heapRatio === null || heapRatio < 0.8),
    observedAt: new Date().toISOString(),
    l1Sync: {
      ok: desynced.length === 0,
      desyncCount: desynced.length,
      markets: marketSync,
      expectedAssets: TARGET_ASSET_MATRIX.map((asset) => asset.instrumentCode)
    },
    v8Memory: {
      ok: allBuffersFlat && (heapRatio === null || heapRatio < 0.8),
      profilerBuffers,
      heap: {
        available: Boolean(memory),
        usedJSHeapSize: memory?.usedJSHeapSize ?? null,
        totalJSHeapSize: memory?.totalJSHeapSize ?? null,
        jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
        heapRatio
      }
    },
    shadowQueue: context.engineState.shadowQueue as unknown as JsonValue,
    assetMatrix: context.engineState.assetMatrix as unknown as JsonValue
  };
}

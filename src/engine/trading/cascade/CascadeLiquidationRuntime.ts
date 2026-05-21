import { LIQUIDATION_HEATMAP_STORAGE_KEY } from "../../../agents/HeatmapAgent";
import { ENGINE_STATE_KEY } from "../../../TradingEngineConstants";
import { normalizeSourceExchange } from "../helpers/NativeMarketIdentityRuntime";
import { nativeIso } from "../helpers/NativeValueRuntime";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  LiquidationHeatmapState
} from "../../../types";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type {
  AbsorptionAnalyzerConfig,
  CascadeDetectorConfig,
  CascadeEvent,
  LiquidationEvent
} from "../../../strategy/cascade/types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import { isCascadeInstrumentEnabledForConfig } from "./CascadeSelectionRuntime";
import { buildCascadeDetectedArtifacts } from "./CascadeDetectedArtifactsRuntime";
import {
  absorptionAnalyzerConfigForTarget,
  cascadeAssetProfileForTarget,
  cascadeDetectorConfigForTarget,
  resolveCascadeAtr1h,
  type TradingCascadeRuntimeConfigTarget
} from "./CascadeConfigRuntime";
import { persistCascadeLiquidationEventsSafely } from "./CascadeLiquidationJournalRuntime";
import {
  emitTradingCascadeOperationalAlertForTarget,
  type TradingSignalBusTarget
} from "../telemetry/TradingSignalBusRuntime";
export {
  buildCascadeDetectedArtifacts,
  cascadeDetectedAlertMetadata,
  cascadeDetectedLogMetadata,
  cascadeDetectedTelemetryPayload,
  type CascadeDetectedArtifacts
} from "./CascadeDetectedArtifactsRuntime";
export {
  cascadeLiquidationInsertStatements,
  persistCascadeLiquidationEvents,
  persistCascadeLiquidationEventsSafely,
  type CascadeLiquidationJournalDb,
  type CascadeLiquidationJournalFailureHandlers
} from "./CascadeLiquidationJournalRuntime";

export interface LiquidationEventContextInput {
  readonly payload: {
    readonly receivedAt?: string;
    readonly instrumentCode?: string;
    readonly source_exchange?: string;
  };
  readonly currentInstrumentCode: string | null | undefined;
  readonly defaultAsset: string | undefined;
  readonly midPrice: number | null;
  readonly fallbackObservedAt?: string;
}

export interface LiquidationEventContext {
  readonly observedAt: string;
  readonly instrumentCode: string;
  readonly sourceExchange: string;
  readonly midPrice: number | null;
}

export interface LiquidationHeatmapStateInput {
  readonly currentState: EngineState;
  readonly heatmap: LiquidationHeatmapState;
  readonly observedAt: string;
}

export interface LiquidationEventTelemetryInput {
  readonly instrumentCode: string;
  readonly heatmap: LiquidationHeatmapState;
  readonly cascadeEventCount: number;
  readonly observedAt: string;
}

export interface LiquidationEventProcessedCountInput {
  readonly previousEventCount: number;
  readonly nextEventCount: number;
  readonly cascadeLiquidationCount: number;
  readonly cascadeEventCount: number;
}

export interface LiquidationHeatmapStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly liquidationHeatmapKey: string;
  readonly heatmap: LiquidationHeatmapState;
}

export interface LiquidationEventProcessingInput {
  readonly currentState: EngineState;
  readonly context: LiquidationEventContext;
  readonly heatmap: LiquidationHeatmapState;
  readonly previousEventCount: number;
  readonly cascadeLiquidationCount: number;
  readonly cascadeEventCount: number;
  readonly engineStateKey: string;
  readonly liquidationHeatmapKey: string;
}

export interface LiquidationEventProcessingResult {
  readonly state: EngineState;
  readonly storageWrites: Record<string, unknown>;
  readonly shouldPublishTelemetry: boolean;
  readonly telemetryPayload: JsonRecord;
  readonly processedCount: number;
  readonly ingestResult: TickIngestResult;
}

export interface LiquidationIngestSideEffectHandlers {
  readonly recordHeatmap: (
    raw: Record<string, unknown>,
    context: LiquidationEventContext
  ) => LiquidationHeatmapState;
  readonly ingestCascadeLiquidations: (
    raw: Record<string, unknown>,
    context: LiquidationEventContext
  ) => LiquidationEvent[];
  readonly recordCascadeLiquidations: (
    events: LiquidationEvent[],
    observedAt: string
  ) => CascadeEvent[];
  readonly scheduleCascadeLiquidationJournal: (events: LiquidationEvent[]) => void;
  readonly scheduleStorageWrites: (storageWrites: Record<string, unknown>) => void;
  readonly publish: (type: "LIQUIDATION_EVENT", payload: JsonRecord) => void;
}

export interface LiquidationIngestRuntimeInput {
  readonly raw: Record<string, unknown>;
  readonly payload: {
    readonly receivedAt?: string;
    readonly instrumentCode?: string;
    readonly source_exchange?: string;
  };
  readonly currentState: EngineState;
  readonly currentInstrumentCode: string | null | undefined;
  readonly defaultAsset: string | undefined;
  readonly midPrice: number | null;
  readonly engineStateKey: string;
  readonly liquidationHeatmapKey: string;
  readonly handlers: LiquidationIngestSideEffectHandlers;
}

export interface LiquidationIngestRuntimeResult {
  readonly state: EngineState;
  readonly ingestResult: TickIngestResult;
}

export interface TradingLiquidationIngestInput {
  readonly raw: Record<string, unknown>;
  readonly payload: {
    readonly receivedAt?: string;
    readonly instrumentCode?: string;
    readonly source_exchange?: string;
  };
  readonly currentState: EngineState;
  readonly defaultAsset: string | undefined;
}

export interface TradingLiquidationIngestHandlers extends LiquidationIngestSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
}

export interface TradingLiquidationIngestTarget {
  engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Pick<
    Env,
    | "HL_ASSET"
    | "TRADING_DB"
    | "CASCADE_ATR_FALLBACK_USD"
    | "CASCADE_ATR_FALLBACK_PCT"
    | "CASCADE_MIN_BASELINE_WINDOWS"
    | "CASCADE_MIN_SEPARATION_MS"
    | "CASCADE_MAX_EVENTS_PER_INSTRUMENT"
    | "ABSORPTION_OI_STABILITY_BPS"
    | "ABSORPTION_MAX_ACTIVE_CASCADES"
  >;
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  readonly heatmapAgent: {
    recordLiquidationEvent(
      raw: Record<string, unknown>,
      context: {
        readonly instrumentCode: string;
        readonly sourceExchange: string;
        readonly midPrice: number | null;
        readonly observedAt: string;
      }
    ): LiquidationHeatmapState;
  };
  readonly cascadeLiquidationStream: {
    ingest(
      raw: Record<string, unknown>,
      context: {
        readonly instrumentCode: string;
        readonly sourceExchange: string;
        readonly observedAt: string;
        readonly fallbackPrice: number | null;
      }
    ): LiquidationEvent[];
  };
  readonly absorptionAnalyzer: {
    configure(config: AbsorptionAnalyzerConfig): void;
    trackCascade(cascade: CascadeEvent): void;
  };
  readonly cascadeDetector: {
    configure(config: CascadeDetectorConfig): void;
    observe(
      event: LiquidationEvent,
      context: { readonly observedAt: string; readonly atr1h: number | null }
    ): CascadeEvent | null;
  };
  readonly cascadeEventsById: Pick<Map<string, CascadeEvent>, "set">;
  readonly logger: {
    warn(eventType: string, message: string, metadata?: JsonRecord): void;
  };
  safeStoragePut(entries: Record<string, unknown>, reason: string): Promise<void>;
  handleStorageWriteFailure(reason: string, error: unknown): void;
  publish(type: string, payload: JsonRecord): void;
  emitCascadeOperationalAlert?(
    eventType: "CASCADE_DETECTED",
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void;
}

export interface TradingCascadeLiquidationDetectionInput {
  readonly events: readonly LiquidationEvent[];
  readonly observedAt: string;
  readonly config: Pick<GlobalRiskConfig, "CASCADE_INSTRUMENTS">;
  readonly midPrice: number | null;
  readonly env: Pick<Env, "CASCADE_ATR_FALLBACK_USD" | "CASCADE_ATR_FALLBACK_PCT">;
}

export interface TradingCascadeLiquidationDetectionHandlers {
  readonly configureAbsorptionAnalyzer: () => void;
  readonly configureDetector: (instrumentCode: string) => void;
  readonly observeCascade: (
    event: LiquidationEvent,
    observedAt: string,
    atr1h: number | null
  ) => CascadeEvent | null;
  readonly rememberCascade: (cascade: CascadeEvent) => void;
  readonly trackCascadeAbsorption: (cascade: CascadeEvent) => void;
  readonly assetProfile: (instrumentCode: string) => CascadeAssetProfile;
  readonly logDetected: (metadata: JsonRecord) => void;
  readonly publishDetected: (payload: JsonRecord) => void;
  readonly alertDetected: (cascade: CascadeEvent, metadata: JsonRecord) => void;
}

export interface TradingCascadeLiquidationDetectionTarget {
  readonly cachedConfig: Pick<GlobalRiskConfig, "CASCADE_INSTRUMENTS">;
  readonly engineState: Pick<EngineState, "microstructure">;
  readonly env: Pick<Env, "CASCADE_ATR_FALLBACK_USD" | "CASCADE_ATR_FALLBACK_PCT">;
  readonly absorptionAnalyzer: {
    configure(config: AbsorptionAnalyzerConfig): void;
    trackCascade(cascade: CascadeEvent): void;
  };
  readonly cascadeDetector: {
    configure(config: CascadeDetectorConfig): void;
    observe(
      event: LiquidationEvent,
      context: { readonly observedAt: string; readonly atr1h: number | null }
    ): CascadeEvent | null;
  };
  readonly cascadeEventsById: Pick<Map<string, CascadeEvent>, "set">;
  readonly logger: {
    warn(eventType: string, message: string, metadata?: JsonRecord): void;
  };
  publish(type: string, payload: JsonRecord): void;
  emitCascadeOperationalAlert?(
    eventType: "CASCADE_DETECTED",
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void;
}

export interface CascadeLiquidationDetectionHandlers {
  readonly configureAbsorptionAnalyzer: () => void;
  readonly isInstrumentEnabled: (instrumentCode: string) => boolean;
  readonly configureDetector: (instrumentCode: string) => void;
  readonly observeCascade: (event: LiquidationEvent, observedAt: string) => CascadeEvent | null;
  readonly rememberCascade: (cascade: CascadeEvent) => void;
  readonly trackCascadeAbsorption: (cascade: CascadeEvent) => void;
  readonly assetProfile: (instrumentCode: string) => CascadeAssetProfile;
  readonly logDetected: (metadata: JsonRecord) => void;
  readonly publishDetected: (payload: JsonRecord) => void;
  readonly alertDetected: (cascade: CascadeEvent, metadata: JsonRecord) => void;
}

export function resolveLiquidationEventContext(
  input: LiquidationEventContextInput
): LiquidationEventContext {
  const observedAt =
    nativeIso(input.payload.receivedAt) ?? input.fallbackObservedAt ?? new Date().toISOString();
  const defaultAsset = input.defaultAsset ?? "BTC";

  return {
    observedAt,
    instrumentCode:
      input.payload.instrumentCode?.toLowerCase() ??
      input.currentInstrumentCode ??
      `${defaultAsset.toLowerCase()}-usd`,
    sourceExchange: normalizeSourceExchange(input.payload.source_exchange ?? "hyperliquid"),
    midPrice: input.midPrice
  };
}

export function stateAfterLiquidationHeatmap(input: LiquidationHeatmapStateInput): EngineState {
  return {
    ...input.currentState,
    liquidationHeatmap: input.heatmap,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

export function liquidationHeatmapStorageWrites(
  input: LiquidationHeatmapStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [input.liquidationHeatmapKey]: input.heatmap
  };
}

export function liquidationEventTelemetry(input: LiquidationEventTelemetryInput): JsonRecord {
  return {
    instrumentCode: input.instrumentCode,
    clusterCount: input.heatmap.clusters.length,
    nearestCascade: input.heatmap.nearestCascade
      ? (input.heatmap.nearestCascade as unknown as JsonRecord)
      : null,
    totalEstimatedNotionalUsd: input.heatmap.totalEstimatedNotionalUsd,
    cascadeEventCount: input.cascadeEventCount,
    observedAt: input.observedAt
  };
}

export function liquidationEventProcessedCount(input: LiquidationEventProcessedCountInput): number {
  return Math.max(
    input.nextEventCount > input.previousEventCount ? 1 : 0,
    input.cascadeLiquidationCount,
    input.cascadeEventCount
  );
}

export function liquidationEventProcessingResult(
  input: LiquidationEventProcessingInput
): LiquidationEventProcessingResult {
  const nextEventCount = input.heatmap.recentEvents.length;
  const processedCount = liquidationEventProcessedCount({
    previousEventCount: input.previousEventCount,
    nextEventCount,
    cascadeLiquidationCount: input.cascadeLiquidationCount,
    cascadeEventCount: input.cascadeEventCount
  });
  const state = stateAfterLiquidationHeatmap({
    currentState: input.currentState,
    heatmap: input.heatmap,
    observedAt: input.context.observedAt
  });

  return {
    state,
    storageWrites: liquidationHeatmapStorageWrites({
      engineStateKey: input.engineStateKey,
      state,
      liquidationHeatmapKey: input.liquidationHeatmapKey,
      heatmap: input.heatmap
    }),
    shouldPublishTelemetry: nextEventCount > input.previousEventCount,
    telemetryPayload: liquidationEventTelemetry({
      instrumentCode: input.context.instrumentCode,
      heatmap: input.heatmap,
      cascadeEventCount: input.cascadeEventCount,
      observedAt: input.context.observedAt
    }),
    processedCount,
    ingestResult: {
      accepted: true,
      status: "FRESH",
      processedCount
    }
  };
}

export function processLiquidationIngestRuntime(
  input: LiquidationIngestRuntimeInput
): LiquidationIngestRuntimeResult {
  const context = resolveLiquidationEventContext({
    payload: input.payload,
    currentInstrumentCode: input.currentInstrumentCode,
    defaultAsset: input.defaultAsset,
    midPrice: input.midPrice
  });
  const previousEventCount = input.currentState.liquidationHeatmap.recentEvents.length;
  const heatmap = input.handlers.recordHeatmap(input.raw, context);
  const cascadeLiquidations = input.handlers.ingestCascadeLiquidations(input.raw, context);

  if (cascadeLiquidations.length > 0) {
    input.handlers.scheduleCascadeLiquidationJournal(cascadeLiquidations);
  }

  const cascadeEvents = input.handlers.recordCascadeLiquidations(
    cascadeLiquidations,
    context.observedAt
  );
  const processed = liquidationEventProcessingResult({
    currentState: input.currentState,
    context,
    heatmap,
    previousEventCount,
    cascadeLiquidationCount: cascadeLiquidations.length,
    cascadeEventCount: cascadeEvents.length,
    engineStateKey: input.engineStateKey,
    liquidationHeatmapKey: input.liquidationHeatmapKey
  });

  input.handlers.scheduleStorageWrites(processed.storageWrites);

  if (processed.shouldPublishTelemetry) {
    input.handlers.publish("LIQUIDATION_EVENT", processed.telemetryPayload);
  }

  return {
    state: processed.state,
    ingestResult: processed.ingestResult
  };
}

export function processTradingLiquidationIngestRuntime(
  input: TradingLiquidationIngestInput,
  handlers: TradingLiquidationIngestHandlers
): TickIngestResult {
  const liquidationResult = processLiquidationIngestRuntime({
    raw: input.raw,
    payload: input.payload,
    currentState: input.currentState,
    currentInstrumentCode: input.currentState.microstructure.instrumentCode,
    defaultAsset: input.defaultAsset,
    midPrice: input.currentState.microstructure.midPrice,
    engineStateKey: ENGINE_STATE_KEY,
    liquidationHeatmapKey: LIQUIDATION_HEATMAP_STORAGE_KEY,
    handlers
  });

  handlers.applyState(liquidationResult.state);
  return liquidationResult.ingestResult;
}

export function handleTradingEngineLiquidationEvents(
  raw: Record<string, unknown>,
  payload: TradingLiquidationIngestInput["payload"],
  target: TradingLiquidationIngestTarget
): TickIngestResult {
  return processTradingLiquidationIngestRuntime(
    {
      raw,
      payload,
      currentState: target.engineState,
      defaultAsset: target.env.HL_ASSET
    },
    {
      recordHeatmap: (eventRaw, context) =>
        target.heatmapAgent.recordLiquidationEvent(eventRaw, {
          instrumentCode: context.instrumentCode,
          sourceExchange: context.sourceExchange,
          midPrice: context.midPrice,
          observedAt: context.observedAt
        }),
      ingestCascadeLiquidations: (eventRaw, context) =>
        target.cascadeLiquidationStream.ingest(eventRaw, {
          instrumentCode: context.instrumentCode,
          sourceExchange: context.sourceExchange,
          observedAt: context.observedAt,
          fallbackPrice: context.midPrice
        }),
      recordCascadeLiquidations: (events, observedAt) =>
        recordTradingEngineCascadeLiquidations(events, observedAt, target),
      scheduleCascadeLiquidationJournal: (events) => {
        target.state.waitUntil(
          persistCascadeLiquidationEventsSafely(target.env.TRADING_DB, events, {
            handleFailure: (reason, error) => {
              target.handleStorageWriteFailure(reason, error);
            }
          })
        );
      },
      scheduleStorageWrites: (storageWrites) => {
        target.state.waitUntil(target.safeStoragePut(storageWrites, "LIQUIDATION_EVENT"));
      },
      publish: (type, publishPayload) => {
        target.publish(type, publishPayload);
      },
      applyState: (state) => {
        target.engineState = state;
      }
    }
  );
}

export function recordTradingCascadeLiquidationDetections(
  input: TradingCascadeLiquidationDetectionInput,
  handlers: TradingCascadeLiquidationDetectionHandlers
): CascadeEvent[] {
  return recordCascadeLiquidationDetections(input.events, input.observedAt, {
    configureAbsorptionAnalyzer: handlers.configureAbsorptionAnalyzer,
    isInstrumentEnabled: (instrumentCode) =>
      isCascadeInstrumentEnabledForConfig(input.config.CASCADE_INSTRUMENTS, instrumentCode),
    configureDetector: handlers.configureDetector,
    observeCascade: (event, detectedAt) =>
      handlers.observeCascade(
        event,
        detectedAt,
        resolveCascadeAtr1h({
          event,
          midPrice: input.midPrice,
          fallbackUsdValue: input.env.CASCADE_ATR_FALLBACK_USD,
          fallbackPctValue: input.env.CASCADE_ATR_FALLBACK_PCT
        })
      ),
    rememberCascade: handlers.rememberCascade,
    trackCascadeAbsorption: handlers.trackCascadeAbsorption,
    assetProfile: handlers.assetProfile,
    logDetected: handlers.logDetected,
    publishDetected: handlers.publishDetected,
    alertDetected: handlers.alertDetected
  });
}

export function recordTradingEngineCascadeLiquidations(
  events: LiquidationEvent[],
  observedAt: string,
  target: TradingCascadeLiquidationDetectionTarget
): CascadeEvent[] {
  return recordTradingCascadeLiquidationDetections(
    {
      events,
      observedAt,
      config: target.cachedConfig,
      midPrice: target.engineState.microstructure.midPrice,
      env: target.env
    },
    {
      configureAbsorptionAnalyzer: () => {
        target.absorptionAnalyzer.configure(
          absorptionAnalyzerConfigForTarget(target as unknown as TradingCascadeRuntimeConfigTarget)
        );
      },
      configureDetector: (instrumentCode) => {
        target.cascadeDetector.configure(
          cascadeDetectorConfigForTarget(
            target as unknown as TradingCascadeRuntimeConfigTarget,
            instrumentCode
          )
        );
      },
      observeCascade: (event, detectedAt, atr1h) =>
        target.cascadeDetector.observe(event, {
          observedAt: detectedAt,
          atr1h
        }),
      rememberCascade: (cascade) => {
        target.cascadeEventsById.set(cascade.cascadeId, cascade);
      },
      trackCascadeAbsorption: (cascade) => {
        target.absorptionAnalyzer.trackCascade(cascade);
      },
      assetProfile: (instrumentCode) =>
        cascadeAssetProfileForTarget(
          target as unknown as TradingCascadeRuntimeConfigTarget,
          instrumentCode
        ),
      logDetected: (metadata) => {
        target.logger.warn("CASCADE_DETECTED", "Liquidation cascade detected", metadata);
      },
      publishDetected: (payload) => {
        target.publish("CASCADE_DETECTED", payload);
      },
      alertDetected: (cascade, metadata) => {
        if (target.emitCascadeOperationalAlert) {
          target.emitCascadeOperationalAlert(
            "CASCADE_DETECTED",
            "Cascade detected",
            `${cascade.instrumentCode} ${cascade.direction} liquidation cascade detected.`,
            metadata,
            cascade.cascadeId
          );
          return;
        }

        emitTradingCascadeOperationalAlertForTarget(
          "CASCADE_DETECTED",
          "Cascade detected",
          `${cascade.instrumentCode} ${cascade.direction} liquidation cascade detected.`,
          metadata,
          cascade.cascadeId,
          target as unknown as TradingSignalBusTarget
        );
      }
    }
  );
}

export function recordCascadeLiquidationDetections(
  events: readonly LiquidationEvent[],
  observedAt: string,
  handlers: CascadeLiquidationDetectionHandlers
): CascadeEvent[] {
  const cascades: CascadeEvent[] = [];
  handlers.configureAbsorptionAnalyzer();

  for (const event of events) {
    if (!handlers.isInstrumentEnabled(event.instrumentCode)) {
      continue;
    }

    handlers.configureDetector(event.instrumentCode);
    const cascade = handlers.observeCascade(event, observedAt);

    if (!cascade) {
      continue;
    }

    cascades.push(cascade);
    handlers.rememberCascade(cascade);
    handlers.trackCascadeAbsorption(cascade);

    const artifacts = buildCascadeDetectedArtifacts(
      cascade,
      handlers.assetProfile(cascade.instrumentCode)
    );
    handlers.logDetected(artifacts.logMetadata);
    handlers.publishDetected(artifacts.telemetryPayload);
    handlers.alertDetected(cascade, artifacts.alertMetadata);
  }

  return cascades;
}

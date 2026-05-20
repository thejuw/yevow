import { ConfigManager, configDefaultsFromEnv } from "../../../ConfigManager";
import { Governor } from "../../../Governor";
import { Logger, createLogSink, structuredConsoleLogsEnabled } from "../../../Logger";
import { Notifier } from "../../../utils/Notifier";
import { ReplayJournal } from "../replay/ReplayJournal";
import { StorageWriteGuard } from "./StorageWriteGuard";
import { TradingTelemetryBus } from "../telemetry/TelemetryBus";
import { STORAGE_WRITE_BACKOFF_MS } from "../../../TradingEngineConstants";
import { Backtester } from "../../../strategy/cascade/Backtester";
import { NewsCalendar } from "../../../strategy/cascade/NewsCalendar";
import { createShadowQueue } from "../../ShadowQueue";
import type { GhostBook } from "../../../utils/GhostBook";
import type { AuditContext, EngineState, Env } from "../../../types";

export type EngineLoggerRuntimeContext = AuditContext;

export interface TradingEngineBootServicesInput {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly adminSockets: Set<WebSocket>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly runtimeContext: () => EngineLoggerRuntimeContext;
  readonly readStorage: <T>(key: string) => Promise<T | undefined>;
  readonly writeStorage: (key: string, value: unknown, reason: string) => Promise<void>;
  readonly publish: (
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ) => void;
  readonly onStorageReadFailure: (reason: string, error: unknown) => void;
}

export interface TradingEngineBootServices {
  readonly configManager: ConfigManager;
  readonly governor: Governor;
  readonly cascadeNewsCalendar: NewsCalendar;
  readonly cascadeBacktester: Backtester;
  readonly ghostBook: GhostBook;
  readonly storageGuard: StorageWriteGuard;
  readonly telemetryBus: TradingTelemetryBus;
  readonly logger: Logger;
  readonly notifier: Notifier;
  readonly replayJournal: ReplayJournal;
}

export function createTradingEngineBootServices(
  input: TradingEngineBootServicesInput
): TradingEngineBootServices {
  const logger = createEngineLogger({
    env: input.env,
    waitUntil: input.waitUntil,
    runtimeContext: input.runtimeContext
  });

  return {
    configManager: new ConfigManager(input.env.CONFIG_STORE, configDefaultsFromEnv(input.env)),
    governor: new Governor(input.env.CONFIG_STORE),
    cascadeNewsCalendar: new NewsCalendar(input.env.CONFIG_STORE),
    cascadeBacktester: new Backtester(input.env.TRADING_DB),
    ghostBook: createShadowQueue(input.env),
    storageGuard: createEngineStorageGuard(input.storage),
    telemetryBus: createEngineTelemetryBus({
      env: input.env,
      adminSockets: input.adminSockets,
      waitUntil: input.waitUntil
    }),
    logger,
    notifier: createEngineNotifier({
      env: input.env,
      waitUntil: input.waitUntil
    }),
    replayJournal: createEngineReplayJournal({
      env: input.env,
      logger,
      readStorage: input.readStorage,
      writeStorage: input.writeStorage,
      publish: input.publish,
      onStorageReadFailure: input.onStorageReadFailure
    })
  };
}

export function createEngineLogger(input: {
  readonly env: Env;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly runtimeContext: () => EngineLoggerRuntimeContext;
}): Logger {
  return new Logger(
    input.env.TRADING_DB,
    input.waitUntil,
    "TradingEngine",
    input.runtimeContext,
    createLogSink(input.env),
    structuredConsoleLogsEnabled(input.env)
  );
}

export function createEngineNotifier(input: {
  readonly env: Env;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}): Notifier {
  return new Notifier(input.env, input.waitUntil);
}

export function createEngineTelemetryBus(input: {
  readonly env: Env;
  readonly adminSockets: Set<WebSocket>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}): TradingTelemetryBus {
  return new TradingTelemetryBus(input);
}

export function createEngineStorageGuard(storage: DurableObjectStorage): StorageWriteGuard {
  return new StorageWriteGuard(storage, STORAGE_WRITE_BACKOFF_MS);
}

export function createEngineReplayJournal(input: {
  readonly env: Env;
  readonly logger: Logger;
  readonly readStorage: <T>(key: string) => Promise<T | undefined>;
  readonly writeStorage: (key: string, value: unknown, reason: string) => Promise<void>;
  readonly publish: (
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ) => void;
  readonly onStorageReadFailure: (reason: string, error: unknown) => void;
}): ReplayJournal {
  return new ReplayJournal({
    env: input.env,
    logger: input.logger,
    readStorage: input.readStorage,
    writeStorage: input.writeStorage,
    publish: input.publish,
    onStorageReadFailure: input.onStorageReadFailure
  });
}

export function tradingEngineLoggerRuntimeContext(input: {
  readonly lastTickTimestamp: string | null;
  readonly engineState: EngineState;
}): EngineLoggerRuntimeContext {
  return {
    lastTickTimestamp: input.lastTickTimestamp,
    orderBookImbalance: input.engineState.microstructure.weightedImbalance,
    colo: input.engineState.location.colo,
    placement: input.engineState.location.placement,
    latencyRiskMultiplier: input.engineState.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.engineState.location.positionSizeMultiplier
  };
}

import {
  Logger,
  createLogSink,
  structuredConsoleLogsEnabled
} from "../../../Logger";
import { Notifier } from "../../../utils/Notifier";
import { ReplayJournal } from "../replay/ReplayJournal";
import { StorageWriteGuard } from "./StorageWriteGuard";
import { TradingTelemetryBus } from "../telemetry/TelemetryBus";
import { STORAGE_WRITE_BACKOFF_MS } from "../../../TradingEngineConstants";
import type { AuditContext, EngineState, Env } from "../../../types";

export type EngineLoggerRuntimeContext = AuditContext;

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
  readonly publish: (type: string, payload: Record<string, unknown>, correlationId?: string) => void;
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

import {
  DEFAULT_HOT_STORAGE_SNAPSHOT_INTERVAL_MS,
  DEFAULT_HOT_STORAGE_SNAPSHOT_TICK_INTERVAL
} from "../../../TradingEngineConstants";
import { readPositiveInteger } from "../helpers/RuntimeParsing";

export interface HotStorageSnapshotDecisionInput {
  readonly lastSnapshotAtMs: number;
  readonly lastSnapshotTick: number;
  readonly nowMs: number;
  readonly tickCount: number;
  readonly intervalMs: number;
  readonly tickInterval: number;
}

export interface HotStorageSnapshotSideEffectsInput extends HotStorageSnapshotDecisionInput {
  readonly entries: Record<string, unknown>;
  readonly reason: string;
}

export interface HotStorageSnapshotSideEffectHandlers {
  readonly markSnapshot: (snapshotAtMs: number, snapshotTick: number) => void;
  readonly persistSnapshot: (entries: Record<string, unknown>, reason: string) => Promise<void>;
}

export interface TradingHotStorageSnapshotTarget {
  lastHotStorageSnapshotAt: number;
  lastHotStorageSnapshotTick: number;
  readonly engineState: {
    readonly processedTicks: number;
  };
  readonly env: {
    readonly HOT_STORAGE_SNAPSHOT_INTERVAL_MS?: string;
    readonly HOT_STORAGE_SNAPSHOT_TICK_INTERVAL?: string;
  };
  safeStoragePut(entries: Record<string, unknown>, reason: string): Promise<void>;
}

export interface TradingStorageGuardTarget {
  readonly storageGuard: StorageWriteGuard;
  readonly state: Pick<DurableObjectState, "waitUntil">;
}

export interface TradingStoragePutSchedulerTarget {
  readonly storageGuard?: StorageWriteGuard;
  readonly state?: Pick<DurableObjectState, "waitUntil">;
  waitUntilStoragePut?(key: string, value: unknown, reason: string): void;
}

export interface TradingStorageDeleteSchedulerTarget {
  readonly storageGuard?: StorageWriteGuard;
  safeStorageDelete?(keys: string[], reason: string): Promise<void>;
}

export interface TradingStorageAlarmSchedulerTarget {
  readonly storageGuard?: StorageWriteGuard;
  safeSetAlarm?(timestamp: number, reason: string): Promise<void>;
}

export interface TradingStorageFailureHandlerTarget {
  readonly storageGuard?: StorageWriteGuard;
  handleStorageWriteFailure?(reason: string, error: unknown): void;
}

export type HotStorageSnapshotDecision =
  | {
      readonly shouldPersist: true;
      readonly nextSnapshotAtMs: number;
      readonly nextSnapshotTick: number;
    }
  | {
      readonly shouldPersist: false;
      readonly nextSnapshotAtMs: number;
      readonly nextSnapshotTick: number;
    };

export function evaluateHotStorageSnapshotDecision(
  input: HotStorageSnapshotDecisionInput
): HotStorageSnapshotDecision {
  const dueByTime = input.nowMs - input.lastSnapshotAtMs >= input.intervalMs;
  const dueByTicks = input.tickCount - input.lastSnapshotTick >= input.tickInterval;

  if (!dueByTime && !dueByTicks) {
    return {
      shouldPersist: false,
      nextSnapshotAtMs: input.lastSnapshotAtMs,
      nextSnapshotTick: input.lastSnapshotTick
    };
  }

  return {
    shouldPersist: true,
    nextSnapshotAtMs: input.nowMs,
    nextSnapshotTick: input.tickCount
  };
}

export function resolveHotStorageSnapshotIntervalMs(envValue?: string): number {
  return readPositiveInteger(envValue, DEFAULT_HOT_STORAGE_SNAPSHOT_INTERVAL_MS, 1_000, 300_000);
}

export function resolveHotStorageSnapshotTickInterval(envValue?: string): number {
  return readPositiveInteger(envValue, DEFAULT_HOT_STORAGE_SNAPSHOT_TICK_INTERVAL, 1, 100_000);
}

export async function applyHotStorageSnapshotSideEffects(
  input: HotStorageSnapshotSideEffectsInput,
  handlers: HotStorageSnapshotSideEffectHandlers
): Promise<HotStorageSnapshotDecision> {
  const decision = evaluateHotStorageSnapshotDecision(input);
  if (!decision.shouldPersist) {
    return decision;
  }

  handlers.markSnapshot(decision.nextSnapshotAtMs, decision.nextSnapshotTick);
  await handlers.persistSnapshot(input.entries, input.reason);

  return decision;
}

export async function applyHotStorageSnapshotForTarget(
  entries: Record<string, unknown>,
  reason: string,
  target: TradingHotStorageSnapshotTarget,
  nowMs = Date.now()
): Promise<HotStorageSnapshotDecision> {
  return applyHotStorageSnapshotSideEffects(
    {
      entries,
      reason,
      lastSnapshotAtMs: target.lastHotStorageSnapshotAt,
      lastSnapshotTick: target.lastHotStorageSnapshotTick,
      nowMs,
      tickCount: target.engineState.processedTicks,
      intervalMs: resolveHotStorageSnapshotIntervalMs(target.env.HOT_STORAGE_SNAPSHOT_INTERVAL_MS),
      tickInterval: resolveHotStorageSnapshotTickInterval(
        target.env.HOT_STORAGE_SNAPSHOT_TICK_INTERVAL
      )
    },
    {
      markSnapshot: (snapshotAtMs, snapshotTick) => {
        target.lastHotStorageSnapshotAt = snapshotAtMs;
        target.lastHotStorageSnapshotTick = snapshotTick;
      },
      persistSnapshot: (snapshotEntries, snapshotReason) =>
        target.safeStoragePut(snapshotEntries, snapshotReason)
    }
  );
}

export async function putTradingStorageForTarget(
  target: TradingStorageGuardTarget,
  keyOrEntries: string | Record<string, unknown>,
  valueOrReason: unknown,
  maybeReason?: string
): Promise<void> {
  if (typeof keyOrEntries === "string") {
    await target.storageGuard.put(keyOrEntries, valueOrReason, maybeReason ?? "STORAGE_WRITE");
    return;
  }

  await target.storageGuard.put(
    keyOrEntries,
    typeof valueOrReason === "string" ? valueOrReason : "STORAGE_WRITE"
  );
}

export function waitUntilTradingStoragePutForTarget(
  target: TradingStorageGuardTarget,
  key: string,
  value: unknown,
  reason: string
): void {
  target.state.waitUntil(putTradingStorageForTarget(target, key, value, reason));
}

export function scheduleTradingStoragePutForTarget(
  target: TradingStoragePutSchedulerTarget,
  key: string,
  value: unknown,
  reason: string
): void {
  if (target.waitUntilStoragePut) {
    target.waitUntilStoragePut(key, value, reason);
    return;
  }

  if (!target.storageGuard || !target.state) {
    throw new Error("Trading storage scheduler requires storageGuard and state bindings");
  }

  waitUntilTradingStoragePutForTarget(target as TradingStorageGuardTarget, key, value, reason);
}

export async function deleteTradingStorageForTarget(
  target: TradingStorageGuardTarget,
  keys: string[],
  reason: string
): Promise<void> {
  await target.storageGuard.delete(keys, reason);
}

export async function deleteTradingStorageKeysForTarget(
  target: TradingStorageDeleteSchedulerTarget,
  keys: string[],
  reason: string
): Promise<void> {
  if (target.safeStorageDelete) {
    await target.safeStorageDelete(keys, reason);
    return;
  }

  if (!target.storageGuard) {
    throw new Error("Trading storage delete requires storageGuard binding");
  }

  await deleteTradingStorageForTarget(target as TradingStorageGuardTarget, keys, reason);
}

export async function setTradingStorageAlarmForTarget(
  target: TradingStorageGuardTarget,
  timestamp: number,
  reason: string
): Promise<void> {
  await target.storageGuard.setAlarm(timestamp, reason);
}

export async function setTradingStorageAlarmForTargetOrScheduler(
  target: TradingStorageAlarmSchedulerTarget,
  timestamp: number,
  reason: string
): Promise<void> {
  if (target.safeSetAlarm) {
    await target.safeSetAlarm(timestamp, reason);
    return;
  }

  if (!target.storageGuard) {
    throw new Error("Trading storage alarm scheduler requires storageGuard binding");
  }

  await setTradingStorageAlarmForTarget(target as TradingStorageGuardTarget, timestamp, reason);
}

export function recordTradingStorageWriteFailureForTarget(
  target: TradingStorageGuardTarget,
  reason: string,
  error: unknown
): void {
  target.storageGuard.recordFailure(reason, error);
}

export function recordTradingStorageWriteFailureForTargetOrHandler(
  target: TradingStorageFailureHandlerTarget,
  reason: string,
  error: unknown
): void {
  if (target.handleStorageWriteFailure) {
    target.handleStorageWriteFailure(reason, error);
    return;
  }

  if (!target.storageGuard) {
    throw new Error("Trading storage failure handler requires storageGuard binding");
  }

  recordTradingStorageWriteFailureForTarget(target as TradingStorageGuardTarget, reason, error);
}

export class StorageWriteGuard {
  private disabledUntil = 0;
  private failures = 0;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly backoffMs: number
  ) {}

  async put(key: string, value: unknown, reason: string): Promise<void>;
  async put(entries: Record<string, unknown>, reason: string): Promise<void>;
  async put(
    keyOrEntries: string | Record<string, unknown>,
    valueOrReason: unknown,
    maybeReason?: string
  ): Promise<void> {
    if (this.disabledUntil > Date.now()) {
      return;
    }

    const reason =
      typeof keyOrEntries === "string"
        ? (maybeReason ?? "STORAGE_WRITE")
        : typeof valueOrReason === "string"
          ? valueOrReason
          : "STORAGE_WRITE";

    try {
      if (typeof keyOrEntries === "string") {
        await this.storage.put(keyOrEntries, valueOrReason);
      } else {
        await this.storage.put(keyOrEntries);
      }
      this.failures = 0;
    } catch (error) {
      this.recordFailure(reason, error);
    }
  }

  async delete(keys: string[], reason: string): Promise<void> {
    if (keys.length === 0 || this.disabledUntil > Date.now()) {
      return;
    }

    try {
      await this.storage.delete(keys);
      this.failures = 0;
    } catch (error) {
      this.recordFailure(reason, error);
    }
  }

  async setAlarm(timestamp: number, reason: string): Promise<void> {
    if (this.disabledUntil > Date.now()) {
      return;
    }

    try {
      await this.storage.setAlarm(timestamp);
      this.failures = 0;
    } catch (error) {
      this.recordFailure(reason, error);
    }
  }

  recordFailure(reason: string, error: unknown): void {
    this.failures += 1;
    const message = error instanceof Error ? error.message : "UNKNOWN_STORAGE_ERROR";
    const lowered = message.toLowerCase();
    const isQuota =
      message.includes("Exceeded allowed rows written") ||
      lowered.includes("quota") ||
      lowered.includes("limit");
    const backoffMs = isQuota ? this.backoffMs : Math.min(this.backoffMs, this.failures * 5_000);

    this.disabledUntil = Date.now() + backoffMs;
    console.error(
      JSON.stringify({
        event: "DO_STORAGE_WRITE_FAILED",
        reason,
        message,
        backoffMs,
        failures: this.failures
      })
    );
  }
}

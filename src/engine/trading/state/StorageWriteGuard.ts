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

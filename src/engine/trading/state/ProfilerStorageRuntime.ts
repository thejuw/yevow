import type { ProfilerRegistry } from "../../../agents/ProfilerRegistry";
import { recordTradingStorageWriteFailureForTargetOrHandler } from "./StorageWriteGuard";

export interface TradingRetiredProfilerStorageTarget {
  readonly profilerRegistry: Pick<ProfilerRegistry, "deleteRetiredStorage">;
  readonly state: {
    readonly storage: DurableObjectStorage;
  };
  handleStorageWriteFailure?(reason: string, error: unknown): void;
}

export function deleteRetiredProfilerStorageForTarget(
  target: TradingRetiredProfilerStorageTarget
): Promise<string[]> {
  return target.profilerRegistry.deleteRetiredStorage(target.state.storage, (reason, error) => {
    recordTradingStorageWriteFailureForTargetOrHandler(target, reason, error);
  });
}

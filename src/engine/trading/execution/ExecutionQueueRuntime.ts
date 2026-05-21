import {
  CONFIG_ALARM_INTERVAL_MS,
  EXECUTION_QUEUE_KEY,
  HOT_PATH_LOG_THROTTLE_MS
} from "../../../TradingEngineConstants";
import type { JsonRecord, TradeIntent } from "../../../types";
import {
  dispatchTradingExecutionIntentForTarget,
  type TradingExecutionDispatchTarget
} from "./TradingExecutionDispatchRuntime";
import {
  putTradingStorageForTargetOrHandler,
  recordTradingStorageWriteFailureForTargetOrHandler,
  setTradingStorageAlarmForTargetOrScheduler
} from "../state/StorageWriteGuard";

export type ExecutionQueuePriority = "CANCEL" | "NEW";

export interface QueuedExecutionIntent {
  readonly intent: TradeIntent;
  readonly priority: ExecutionQueuePriority;
  readonly runAfterMs: number;
  readonly enqueuedAt: string;
}

export interface ExecutionQueueEnqueueInput {
  readonly queue: readonly QueuedExecutionIntent[];
  readonly intent: TradeIntent;
  readonly priority: ExecutionQueuePriority;
  readonly waitMs: number;
  readonly nowMs: number;
  readonly enqueuedAtIso: string;
  readonly maxQueueSize?: number;
}

export interface ExecutionQueueEnqueuePlan {
  readonly queue: QueuedExecutionIntent[];
  readonly runAfterMs: number;
  readonly queuedCount: number;
}

export interface ExecutionQueueDrainInput {
  readonly queue: readonly QueuedExecutionIntent[];
  readonly nowMs: number;
}

export interface ExecutionQueueDrainPlan {
  readonly due: QueuedExecutionIntent[];
  readonly pending: QueuedExecutionIntent[];
  readonly nextWakeMs: number | null;
}

export interface ExecutionQueueDrainSideEffectsInput {
  readonly nowMs: number;
  readonly alarmCapMs: number;
}

export interface ExecutionQueueDrainSideEffectHandlers {
  readonly readQueue: () => Promise<QueuedExecutionIntent[]>;
  readonly persistQueue: (queue: readonly QueuedExecutionIntent[]) => Promise<void>;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<void>;
  readonly setAlarm: (timestampMs: number) => Promise<void>;
}

export interface ExecutionQueueDeferralLogInput {
  readonly nowMs: number;
  readonly lastLoggedAtMs: number;
  readonly throttleMs: number;
}

export interface ExecutionQueueDeferralLogMetadataInput {
  readonly intent: TradeIntent;
  readonly priority: ExecutionQueuePriority;
  readonly waitMs: number;
  readonly queuedCount: number;
}

export interface ExecutionQueueEnqueueSideEffectsInput {
  readonly intent: TradeIntent;
  readonly priority: ExecutionQueuePriority;
  readonly waitMs: number;
  readonly nowMs: number;
  readonly enqueuedAtIso: string;
  readonly alarmCapMs: number;
  readonly lastDeferralLoggedAtMs: number;
  readonly throttleMs: number;
}

export interface ExecutionQueueEnqueueSideEffectHandlers {
  readonly readQueue: () => Promise<QueuedExecutionIntent[]>;
  readonly persistQueue: (queue: readonly QueuedExecutionIntent[]) => Promise<void>;
  readonly setAlarm: (timestampMs: number) => Promise<void>;
  readonly markDeferralLogged: (loggedAtMs: number) => void;
  readonly warnDeferral: (metadata: JsonRecord) => void;
}

export interface TradingExecutionQueueReadHandlers {
  readonly readStoredQueue: () => Promise<QueuedExecutionIntent[] | undefined>;
  readonly handleStorageFailure: (reason: string, error: unknown) => void;
}

export interface TradingExecutionQueueStorageHandlers extends TradingExecutionQueueReadHandlers {
  readonly persistQueue: (
    key: string,
    queue: readonly QueuedExecutionIntent[],
    reason: string
  ) => Promise<void>;
  readonly setAlarm: (timestampMs: number, reason: string) => Promise<void>;
}

export interface TradingExecutionQueueEnqueueInput {
  readonly intent: TradeIntent;
  readonly priority: ExecutionQueuePriority;
  readonly waitMs: number;
  readonly nowMs: number;
  readonly lastDeferralLoggedAtMs: number;
}

export interface TradingExecutionQueueEnqueueHandlers extends TradingExecutionQueueStorageHandlers {
  readonly markDeferralLogged: (loggedAtMs: number) => void;
  readonly warnDeferral: (metadata: JsonRecord) => void;
}

export interface TradingExecutionQueueDrainInput {
  readonly nowMs: number;
}

export interface TradingExecutionQueueDrainHandlers extends TradingExecutionQueueStorageHandlers {
  readonly dispatchExecution: (intent: TradeIntent) => Promise<void>;
}

export interface TradingExecutionQueueTarget {
  rateLimitDeferralLogAt: number;
  readonly state: {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
    };
  };
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  handleStorageWriteFailure?(reason: string, error: unknown): void;
  safeStoragePut?(key: string, value: unknown, reason: string): Promise<void>;
  safeSetAlarm?(timestampMs: number, reason: string): Promise<void>;
  dispatchExecution?(intent: TradeIntent): Promise<void>;
}

const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const PRIORITY_WEIGHT: Record<ExecutionQueuePriority, number> = {
  CANCEL: 0,
  NEW: 1
};

export function compareExecutionQueueItems(
  left: QueuedExecutionIntent,
  right: QueuedExecutionIntent
): number {
  const priorityDelta = PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority];

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.runAfterMs - right.runAfterMs;
}

export function buildExecutionQueueEnqueuePlan(
  input: ExecutionQueueEnqueueInput
): ExecutionQueueEnqueuePlan {
  const maxQueueSize = Math.max(0, Math.trunc(input.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE));
  const runAfterMs = input.nowMs + Math.max(0, input.waitMs);
  const queue = [
    ...input.queue,
    {
      intent: input.intent,
      priority: input.priority,
      runAfterMs,
      enqueuedAt: input.enqueuedAtIso
    }
  ]
    .sort(compareExecutionQueueItems)
    .slice(0, maxQueueSize);

  return {
    queue,
    runAfterMs,
    queuedCount: queue.length
  };
}

export function splitExecutionQueueForDrain(
  input: ExecutionQueueDrainInput
): ExecutionQueueDrainPlan {
  const due: QueuedExecutionIntent[] = [];
  const pending: QueuedExecutionIntent[] = [];

  for (const item of input.queue) {
    if (item.runAfterMs <= input.nowMs) {
      due.push(item);
      continue;
    }

    pending.push(item);
  }

  due.sort(compareExecutionQueueItems);
  pending.sort(compareExecutionQueueItems);

  return {
    due,
    pending,
    nextWakeMs: pending[0]?.runAfterMs ?? null
  };
}

export function shouldLogExecutionQueueDeferral(input: ExecutionQueueDeferralLogInput): boolean {
  return input.nowMs - input.lastLoggedAtMs >= input.throttleMs;
}

export function executionQueueDeferralLogMetadata(
  input: ExecutionQueueDeferralLogMetadataInput
): JsonRecord {
  return {
    intentId: input.intent.intentId,
    priority: input.priority,
    waitMs: input.waitMs,
    queuedCount: input.queuedCount
  };
}

export async function applyExecutionQueueEnqueueSideEffects(
  input: ExecutionQueueEnqueueSideEffectsInput,
  handlers: ExecutionQueueEnqueueSideEffectHandlers
): Promise<ExecutionQueueEnqueuePlan> {
  const queue = await handlers.readQueue();
  const plan = buildExecutionQueueEnqueuePlan({
    queue,
    intent: input.intent,
    priority: input.priority,
    waitMs: input.waitMs,
    nowMs: input.nowMs,
    enqueuedAtIso: input.enqueuedAtIso
  });

  await handlers.persistQueue(plan.queue);
  await handlers.setAlarm(Math.min(plan.runAfterMs, input.nowMs + input.alarmCapMs));

  if (
    shouldLogExecutionQueueDeferral({
      nowMs: input.nowMs,
      lastLoggedAtMs: input.lastDeferralLoggedAtMs,
      throttleMs: input.throttleMs
    })
  ) {
    handlers.markDeferralLogged(input.nowMs);
    handlers.warnDeferral(
      executionQueueDeferralLogMetadata({
        intent: input.intent,
        priority: input.priority,
        waitMs: input.waitMs,
        queuedCount: plan.queuedCount
      })
    );
  }

  return plan;
}

export async function applyExecutionQueueDrainSideEffects(
  input: ExecutionQueueDrainSideEffectsInput,
  handlers: ExecutionQueueDrainSideEffectHandlers
): Promise<ExecutionQueueDrainPlan | null> {
  const queue = await handlers.readQueue();

  if (queue.length === 0) {
    return null;
  }

  const plan = splitExecutionQueueForDrain({ queue, nowMs: input.nowMs });

  await handlers.persistQueue(plan.pending);

  for (const item of plan.due) {
    await handlers.dispatchExecution(item.intent);
  }

  if (plan.nextWakeMs) {
    await handlers.setAlarm(Math.min(plan.nextWakeMs, input.nowMs + input.alarmCapMs));
  }

  return plan;
}

export async function readTradingExecutionQueue(
  reason: string,
  handlers: TradingExecutionQueueReadHandlers
): Promise<QueuedExecutionIntent[]> {
  try {
    return (await handlers.readStoredQueue()) ?? [];
  } catch (error) {
    handlers.handleStorageFailure(reason, error);
    return [];
  }
}

export async function enqueueTradingExecutionIntent(
  input: TradingExecutionQueueEnqueueInput,
  handlers: TradingExecutionQueueEnqueueHandlers
): Promise<ExecutionQueueEnqueuePlan> {
  return applyExecutionQueueEnqueueSideEffects(
    {
      intent: input.intent,
      priority: input.priority,
      waitMs: input.waitMs,
      nowMs: input.nowMs,
      enqueuedAtIso: new Date(input.nowMs).toISOString(),
      alarmCapMs: CONFIG_ALARM_INTERVAL_MS,
      lastDeferralLoggedAtMs: input.lastDeferralLoggedAtMs,
      throttleMs: HOT_PATH_LOG_THROTTLE_MS
    },
    {
      readQueue: () => readTradingExecutionQueue("EXECUTION_QUEUE_ENQUEUE_READ", handlers),
      persistQueue: (queue) =>
        handlers.persistQueue(EXECUTION_QUEUE_KEY, queue, "EXECUTION_QUEUE_ENQUEUE"),
      setAlarm: (timestampMs) => handlers.setAlarm(timestampMs, "EXECUTION_QUEUE_ALARM"),
      markDeferralLogged: handlers.markDeferralLogged,
      warnDeferral: handlers.warnDeferral
    }
  );
}

export async function drainTradingExecutionQueue(
  input: TradingExecutionQueueDrainInput,
  handlers: TradingExecutionQueueDrainHandlers
): Promise<ExecutionQueueDrainPlan | null> {
  return applyExecutionQueueDrainSideEffects(
    {
      nowMs: input.nowMs,
      alarmCapMs: CONFIG_ALARM_INTERVAL_MS
    },
    {
      readQueue: () => readTradingExecutionQueue("EXECUTION_QUEUE_DRAIN_READ", handlers),
      persistQueue: (queue) =>
        handlers.persistQueue(EXECUTION_QUEUE_KEY, queue, "EXECUTION_QUEUE_DRAIN"),
      dispatchExecution: handlers.dispatchExecution,
      setAlarm: (timestampMs) => handlers.setAlarm(timestampMs, "EXECUTION_QUEUE_NEXT_WAKE")
    }
  );
}

export function enqueueTradingExecutionIntentForTarget(
  intent: TradeIntent,
  priority: ExecutionQueuePriority,
  waitMs: number,
  target: TradingExecutionQueueTarget
): Promise<ExecutionQueueEnqueuePlan> {
  return enqueueTradingExecutionIntent(
    {
      intent,
      priority,
      waitMs,
      nowMs: Date.now(),
      lastDeferralLoggedAtMs: target.rateLimitDeferralLogAt
    },
    {
      readStoredQueue: () => target.state.storage.get<QueuedExecutionIntent[]>(EXECUTION_QUEUE_KEY),
      handleStorageFailure: (reason, error) => {
        recordTradingStorageWriteFailureForTargetOrHandler(target, reason, error);
      },
      persistQueue: (key, queue, reason) =>
        putTradingStorageForTargetOrHandler(target, key, queue, reason),
      setAlarm: (timestampMs, reason) =>
        setTradingStorageAlarmForTargetOrScheduler(target, timestampMs, reason),
      markDeferralLogged: (loggedAtMs) => {
        target.rateLimitDeferralLogAt = loggedAtMs;
      },
      warnDeferral: (metadata) => {
        target.logger.warn(
          "EXECUTION_DEFERRED_BY_RATE_LIMIT",
          "Execution intent deferred by durable rate limiter",
          metadata
        );
      }
    }
  );
}

export function drainTradingExecutionQueueForTarget(
  target: TradingExecutionQueueTarget
): Promise<ExecutionQueueDrainPlan | null> {
  return drainTradingExecutionQueue(
    {
      nowMs: Date.now()
    },
    {
      readStoredQueue: () => target.state.storage.get<QueuedExecutionIntent[]>(EXECUTION_QUEUE_KEY),
      handleStorageFailure: (reason, error) => {
        recordTradingStorageWriteFailureForTargetOrHandler(target, reason, error);
      },
      persistQueue: (key, queue, reason) =>
        putTradingStorageForTargetOrHandler(target, key, queue, reason),
      dispatchExecution: (intent) =>
        target.dispatchExecution
          ? target.dispatchExecution(intent)
          : dispatchTradingExecutionIntentForTarget(
              intent,
              0,
              target as unknown as TradingExecutionDispatchTarget
            ),
      setAlarm: (timestampMs, reason) =>
        setTradingStorageAlarmForTargetOrScheduler(target, timestampMs, reason)
    }
  );
}

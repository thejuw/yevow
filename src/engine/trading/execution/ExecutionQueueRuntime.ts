import type { TradeIntent } from "../../../types";

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

export interface ExecutionQueueDeferralLogInput {
  readonly nowMs: number;
  readonly lastLoggedAtMs: number;
  readonly throttleMs: number;
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

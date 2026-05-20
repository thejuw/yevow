import type { JsonRecord, TradeIntent } from "../../../types";

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

import { describe, expect, it } from "vitest";
import {
  applyExecutionQueueDrainSideEffects,
  applyExecutionQueueEnqueueSideEffects,
  buildExecutionQueueEnqueuePlan,
  compareExecutionQueueItems,
  drainTradingExecutionQueue,
  enqueueTradingExecutionIntent,
  type ExecutionQueueDrainSideEffectHandlers,
  executionQueueDeferralLogMetadata,
  type ExecutionQueueEnqueueSideEffectHandlers,
  readTradingExecutionQueue,
  shouldLogExecutionQueueDeferral,
  splitExecutionQueueForDrain,
  type ExecutionQueuePriority,
  type QueuedExecutionIntent
} from "../../src/engine/trading/execution/ExecutionQueueRuntime";
import type { TradeIntent } from "../../src/types";

describe("ExecutionQueueRuntime", () => {
  it("prioritizes cancels ahead of new orders and then earlier wake times", () => {
    const newSoon = queuedIntent({ id: "new-soon", priority: "NEW", runAfterMs: 1_010 });
    const cancelLater = queuedIntent({ id: "cancel-later", priority: "CANCEL", runAfterMs: 1_500 });
    const newLater = queuedIntent({ id: "new-later", priority: "NEW", runAfterMs: 1_500 });

    const sorted = [newLater, newSoon, cancelLater].sort(compareExecutionQueueItems);

    expect(sorted.map((item) => item.intent.intentId)).toEqual([
      "cancel-later",
      "new-soon",
      "new-later"
    ]);
  });

  it("clamps negative waits, sorts the next queue, and reports the queued count", () => {
    const plan = buildExecutionQueueEnqueuePlan({
      queue: [queuedIntent({ id: "new-later", priority: "NEW", runAfterMs: 1_200 })],
      intent: tradeIntent({ intentId: "cancel-now" }),
      priority: "CANCEL",
      waitMs: -50,
      nowMs: 1_000,
      enqueuedAtIso: "2026-05-19T12:00:00.000Z"
    });

    expect(plan.runAfterMs).toBe(1_000);
    expect(plan.queuedCount).toBe(2);
    expect(plan.queue.map((item) => item.intent.intentId)).toEqual(["cancel-now", "new-later"]);
    expect(plan.queue[0]).toMatchObject({
      priority: "CANCEL",
      runAfterMs: 1_000,
      enqueuedAt: "2026-05-19T12:00:00.000Z"
    });
  });

  it("caps the queue after priority sorting", () => {
    const plan = buildExecutionQueueEnqueuePlan({
      queue: [
        queuedIntent({ id: "new-later", priority: "NEW", runAfterMs: 2_000 }),
        queuedIntent({ id: "new-soon", priority: "NEW", runAfterMs: 1_000 })
      ],
      intent: tradeIntent({ intentId: "cancel" }),
      priority: "CANCEL",
      waitMs: 1_500,
      nowMs: 0,
      enqueuedAtIso: "2026-05-19T12:00:00.000Z",
      maxQueueSize: 2
    });

    expect(plan.queue.map((item) => item.intent.intentId)).toEqual(["cancel", "new-soon"]);
  });

  it("splits due and pending items without losing priority ordering", () => {
    const plan = splitExecutionQueueForDrain({
      nowMs: 1_000,
      queue: [
        queuedIntent({ id: "pending", priority: "CANCEL", runAfterMs: 1_001 }),
        queuedIntent({ id: "new-due", priority: "NEW", runAfterMs: 900 }),
        queuedIntent({ id: "cancel-due", priority: "CANCEL", runAfterMs: 1_000 })
      ]
    });

    expect(plan.due.map((item) => item.intent.intentId)).toEqual(["cancel-due", "new-due"]);
    expect(plan.pending.map((item) => item.intent.intentId)).toEqual(["pending"]);
    expect(plan.nextWakeMs).toBe(1_001);
  });

  it("throttles queue deferral log emission", () => {
    expect(
      shouldLogExecutionQueueDeferral({
        nowMs: 10_000,
        lastLoggedAtMs: 1_000,
        throttleMs: 5_000
      })
    ).toBe(true);
    expect(
      shouldLogExecutionQueueDeferral({
        nowMs: 10_000,
        lastLoggedAtMs: 7_000,
        throttleMs: 5_000
      })
    ).toBe(false);
  });

  it("builds execution queue deferral log metadata", () => {
    expect(
      executionQueueDeferralLogMetadata({
        intent: tradeIntent({ intentId: "intent-queued" }),
        priority: "NEW",
        waitMs: 250,
        queuedCount: 3
      })
    ).toEqual({
      intentId: "intent-queued",
      priority: "NEW",
      waitMs: 250,
      queuedCount: 3
    });
  });

  it("runs enqueue side effects and emits throttled deferral telemetry", async () => {
    const sideEffects = enqueueSideEffectSpy({
      queue: [queuedIntent({ id: "existing", priority: "NEW", runAfterMs: 1_050 })]
    });

    const plan = await applyExecutionQueueEnqueueSideEffects(
      {
        intent: tradeIntent({ intentId: "queued-now" }),
        priority: "NEW",
        waitMs: 750,
        nowMs: 1_000,
        enqueuedAtIso: "2026-05-19T12:00:00.000Z",
        alarmCapMs: 500,
        lastDeferralLoggedAtMs: 0,
        throttleMs: 250
      },
      sideEffects.handlers
    );

    expect(plan.runAfterMs).toBe(1_750);
    expect(sideEffects.events).toEqual([
      "read",
      "persist:existing,queued-now",
      "alarm:1500",
      "mark:1000",
      "warn:queued-now:2"
    ]);
  });

  it("suppresses enqueue deferral telemetry inside the throttle window", async () => {
    const sideEffects = enqueueSideEffectSpy({ queue: [] });

    await applyExecutionQueueEnqueueSideEffects(
      {
        intent: tradeIntent({ intentId: "queued-now" }),
        priority: "NEW",
        waitMs: 100,
        nowMs: 1_000,
        enqueuedAtIso: "2026-05-19T12:00:00.000Z",
        alarmCapMs: 500,
        lastDeferralLoggedAtMs: 900,
        throttleMs: 250
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual(["read", "persist:queued-now", "alarm:1100"]);
  });

  it("runs drain side effects for due intents and caps the next wake alarm", async () => {
    const sideEffects = drainSideEffectSpy({
      queue: [
        queuedIntent({ id: "pending", priority: "NEW", runAfterMs: 2_000 }),
        queuedIntent({ id: "due", priority: "NEW", runAfterMs: 900 })
      ]
    });

    const plan = await applyExecutionQueueDrainSideEffects(
      {
        nowMs: 1_000,
        alarmCapMs: 500
      },
      sideEffects.handlers
    );

    expect(plan?.due.map((item) => item.intent.intentId)).toEqual(["due"]);
    expect(sideEffects.events).toEqual(["read", "persist:pending", "dispatch:due", "alarm:1500"]);
  });

  it("skips drain side effects when the execution queue is empty", async () => {
    const sideEffects = drainSideEffectSpy({ queue: [] });

    await expect(
      applyExecutionQueueDrainSideEffects(
        {
          nowMs: 1_000,
          alarmCapMs: 500
        },
        sideEffects.handlers
      )
    ).resolves.toBeNull();

    expect(sideEffects.events).toEqual(["read"]);
  });

  it("reads the trading execution queue through durable storage handlers", async () => {
    const storedQueue = [queuedIntent({ id: "stored", priority: "NEW", runAfterMs: 2_000 })];
    const failures: string[] = [];

    await expect(
      readTradingExecutionQueue("TEST_READ", {
        readStoredQueue: () => Promise.resolve(storedQueue),
        handleStorageFailure: (reason) => failures.push(reason)
      })
    ).resolves.toBe(storedQueue);

    expect(failures).toEqual([]);
  });

  it("fails closed to an empty execution queue when durable storage read fails", async () => {
    const failures: string[] = [];

    await expect(
      readTradingExecutionQueue("TEST_READ_FAILURE", {
        readStoredQueue: () => Promise.reject(new Error("d1 storage unavailable")),
        handleStorageFailure: (reason, error) => {
          failures.push(`${reason}:${error instanceof Error ? error.message : "unknown"}`);
        }
      })
    ).resolves.toEqual([]);

    expect(failures).toEqual(["TEST_READ_FAILURE:d1 storage unavailable"]);
  });

  it("enqueues trading execution intents with canonical storage and alarm reasons", async () => {
    const events: string[] = [];

    const plan = await enqueueTradingExecutionIntent(
      {
        intent: tradeIntent({ intentId: "adapter-queued" }),
        priority: "NEW",
        waitMs: 7_500,
        nowMs: 1_000,
        lastDeferralLoggedAtMs: -60_000
      },
      {
        readStoredQueue: () => {
          events.push("read");
          return Promise.resolve([]);
        },
        handleStorageFailure: (reason) => events.push(`failure:${reason}`),
        persistQueue: (key, queue, reason) => {
          events.push(
            `persist:${key}:${reason}:${queue.map((item) => item.intent.intentId).join(",")}`
          );
          return Promise.resolve();
        },
        setAlarm: (timestampMs, reason) => {
          events.push(`alarm:${reason}:${timestampMs}`);
          return Promise.resolve();
        },
        markDeferralLogged: (loggedAtMs) => events.push(`mark:${loggedAtMs}`),
        warnDeferral: (metadata) =>
          events.push(`warn:${String(metadata.intentId)}:${String(metadata.waitMs)}`)
      }
    );

    expect(plan.runAfterMs).toBe(8_500);
    expect(events).toEqual([
      "read",
      "persist:execution:deferred-queue:EXECUTION_QUEUE_ENQUEUE:adapter-queued",
      "alarm:EXECUTION_QUEUE_ALARM:6000",
      "mark:1000",
      "warn:adapter-queued:7500"
    ]);
  });

  it("drains trading execution queues and schedules the next durable wake", async () => {
    const events: string[] = [];

    const plan = await drainTradingExecutionQueue(
      {
        nowMs: 1_000
      },
      {
        readStoredQueue: () => {
          events.push("read");
          return Promise.resolve([
            queuedIntent({ id: "due", priority: "NEW", runAfterMs: 500 }),
            queuedIntent({ id: "pending", priority: "NEW", runAfterMs: 9_000 })
          ]);
        },
        handleStorageFailure: (reason) => events.push(`failure:${reason}`),
        persistQueue: (key, queue, reason) => {
          events.push(
            `persist:${key}:${reason}:${queue.map((item) => item.intent.intentId).join(",")}`
          );
          return Promise.resolve();
        },
        dispatchExecution: (intent) => {
          events.push(`dispatch:${intent.intentId}`);
          return Promise.resolve();
        },
        setAlarm: (timestampMs, reason) => {
          events.push(`alarm:${reason}:${timestampMs}`);
          return Promise.resolve();
        }
      }
    );

    expect(plan?.due.map((item) => item.intent.intentId)).toEqual(["due"]);
    expect(events).toEqual([
      "read",
      "persist:execution:deferred-queue:EXECUTION_QUEUE_DRAIN:pending",
      "dispatch:due",
      "alarm:EXECUTION_QUEUE_NEXT_WAKE:6000"
    ]);
  });
});

function enqueueSideEffectSpy(input: { queue: QueuedExecutionIntent[] }): {
  events: string[];
  handlers: ExecutionQueueEnqueueSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      readQueue() {
        events.push("read");
        return Promise.resolve(input.queue);
      },
      persistQueue(queue) {
        events.push(`persist:${queue.map((item) => item.intent.intentId).join(",")}`);
        return Promise.resolve();
      },
      setAlarm(timestampMs) {
        events.push(`alarm:${timestampMs}`);
        return Promise.resolve();
      },
      markDeferralLogged(loggedAtMs) {
        events.push(`mark:${loggedAtMs}`);
      },
      warnDeferral(metadata) {
        events.push(`warn:${String(metadata.intentId)}:${String(metadata.queuedCount)}`);
      }
    }
  };
}

function drainSideEffectSpy(input: { queue: QueuedExecutionIntent[] }): {
  events: string[];
  handlers: ExecutionQueueDrainSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      readQueue() {
        events.push("read");
        return Promise.resolve(input.queue);
      },
      persistQueue(queue) {
        events.push(`persist:${queue.map((item) => item.intent.intentId).join(",")}`);
        return Promise.resolve();
      },
      dispatchExecution(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      },
      setAlarm(timestampMs) {
        events.push(`alarm:${timestampMs}`);
        return Promise.resolve();
      }
    }
  };
}

function queuedIntent(input: {
  id: string;
  priority: ExecutionQueuePriority;
  runAfterMs: number;
}): QueuedExecutionIntent {
  return {
    intent: tradeIntent({ intentId: input.id }),
    priority: input.priority,
    runAfterMs: input.runAfterMs,
    enqueuedAt: "2026-05-19T12:00:00.000Z"
  };
}

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    action: "BUY",
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "ALO",
    intendedPrice: 100,
    expectedPrice: 100,
    requestedSize: 1,
    approvedSize: 1,
    probabilityWin: 0.5,
    probabilityLoss: 0.5,
    profit: 1,
    loss: 1,
    executionCosts: 0,
    adverseSelectionCost: 0,
    expectedValue: 0,
    minEvThreshold: 0,
    maxSlippageBps: 5,
    confidence: 0.5,
    rationale: "test",
    createdAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}

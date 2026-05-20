import { describe, expect, it } from "vitest";
import {
  applyExecutionQueueEnqueueSideEffects,
  buildExecutionQueueEnqueuePlan,
  compareExecutionQueueItems,
  executionQueueDeferralLogMetadata,
  type ExecutionQueueEnqueueSideEffectHandlers,
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

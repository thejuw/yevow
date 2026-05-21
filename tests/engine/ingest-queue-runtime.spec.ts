import { describe, expect, it } from "vitest";
import { enqueueTradingIngestJob } from "../../src/engine/trading/ingest/IngestQueueRuntime";

describe("IngestQueueRuntime", () => {
  it("serializes ingest work and keeps the queue alive after failures", async () => {
    const target = {
      ingestQueue: Promise.resolve()
    };
    const events: string[] = [];

    const first = enqueueTradingIngestJob(target, async () => {
      events.push("first");
      return 1;
    });
    const second = enqueueTradingIngestJob(target, async () => {
      events.push("second");
      throw new Error("boom");
    });
    const third = enqueueTradingIngestJob(target, async () => {
      events.push("third");
      return 3;
    });

    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("boom");
    await expect(third).resolves.toBe(3);
    await expect(target.ingestQueue).resolves.toBeUndefined();
    expect(events).toEqual(["first", "second", "third"]);
  });
});

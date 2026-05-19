import { describe, expect, it } from "vitest";
import {
  DurableObjectEngineStateStore,
  MemoryEngineStateStore
} from "../../src/engine/trading/state/EngineStateStore";

describe("engine state store abstraction", () => {
  it("roundtrips a single value", async () => {
    const store = new MemoryEngineStateStore();
    await store.put("engine:state", { mode: "PAPER" });

    expect(await store.get("engine:state")).toEqual({ mode: "PAPER" });
  });

  it("roundtrips multiple values and snapshots by prefix", async () => {
    const store = new MemoryEngineStateStore();
    await store.putMany({ "book:btc": { depth: 20 }, "book:hype": { depth: 10 }, other: true });

    expect(await store.snapshot("book:")).toEqual({
      "book:btc": { depth: 20 },
      "book:hype": { depth: 10 }
    });
  });

  it("deletes values", async () => {
    const store = new MemoryEngineStateStore();
    await store.put("key", "value");
    await store.delete("key");

    expect(await store.get("key")).toBeUndefined();
  });

  it("wraps Durable Object storage with the same contract", async () => {
    const durableStorage = new FakeDurableObjectStorage();
    const store = new DurableObjectEngineStateStore(
      durableStorage as unknown as DurableObjectStorage
    );

    await store.put("state:one", { value: 1 });
    await store.putMany({ "state:two": { value: 2 }, other: { value: 3 } });
    expect(await store.get("state:one")).toEqual({ value: 1 });
    expect(await store.snapshot("state:")).toEqual({
      "state:one": { value: 1 },
      "state:two": { value: 2 }
    });

    await store.delete("state:one");
    expect(await store.get("state:one")).toBeUndefined();
  });
});

class FakeDurableObjectStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, value);
      return;
    }

    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.values.set(key, entry);
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const prefix = options?.prefix ?? "";

    for (const [key, value] of this.values.entries()) {
      if (key.startsWith(prefix)) {
        out.set(key, value as T);
      }
    }

    return out;
  }
}

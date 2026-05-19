export interface EngineStateStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  putMany(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  snapshot(prefix?: string): Promise<Record<string, unknown>>;
}

export class DurableObjectEngineStateStore implements EngineStateStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get(key: string): Promise<unknown> {
    return this.storage.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.storage.put(key, value);
  }

  async putMany(entries: Record<string, unknown>): Promise<void> {
    await this.storage.put(entries);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  async snapshot(prefix?: string): Promise<Record<string, unknown>> {
    const listed = await this.storage.list({ prefix });
    return Object.fromEntries(listed.entries());
  }
}

export class MemoryEngineStateStore implements EngineStateStore {
  private readonly values = new Map<string, unknown>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key));
  }

  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  putMany(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  snapshot(prefix = ""): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};

    for (const [key, value] of this.values.entries()) {
      if (key.startsWith(prefix)) {
        out[key] = value;
      }
    }

    return Promise.resolve(out);
  }
}

export class TestKvNamespace {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const record = this.values.get(key);

    if (!record) {
      return null;
    }

    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }

    return record.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown }
  ): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + Math.max(1, options.expirationTtl) * 1_000
      : null;
    this.values.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1_000;
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name })),
      list_complete: true,
      cursor: ""
    };
  }
}

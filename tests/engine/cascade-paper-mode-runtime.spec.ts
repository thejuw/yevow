import { describe, expect, it } from "vitest";
import {
  ensureCascadePaperModeArmedForTarget,
  ensureCascadePaperModeArmedRuntime,
  type CascadePaperModeArmingTarget,
  type CascadePaperModeArmingHandlers
} from "../../src/engine/trading/cascade/CascadePaperModeRuntime";
import { defaultConfig } from "../../src/ConfigManager";

const OBSERVED_AT = "2026-05-20T06:00:00.000Z";

describe("CascadePaperModeRuntime", () => {
  it("arms the cascade paper-mode clock when missing", async () => {
    const sideEffects = armingSideEffectSpy({ existing: null });

    await expect(
      ensureCascadePaperModeArmedRuntime(
        {
          observedAt: OBSERVED_AT,
          cachedConfig: {
            ...defaultConfig,
            STRATEGY_MODE: "CASCADE_RECOVERY",
            TRADING_ENABLED: false
          },
          shadowMode: true
        },
        sideEffects.handlers
      )
    ).resolves.toBe(true);

    expect(sideEffects.events).toEqual([
      "get",
      "put:2026-05-20T06:00:00.000Z",
      "warn:CASCADE_RECOVERY:false:true"
    ]);
  });

  it("does not re-arm an existing cascade paper-mode clock", async () => {
    const sideEffects = armingSideEffectSpy({ existing: OBSERVED_AT });

    await expect(
      ensureCascadePaperModeArmedRuntime(
        {
          observedAt: OBSERVED_AT,
          cachedConfig: defaultConfig,
          shadowMode: false
        },
        sideEffects.handlers
      )
    ).resolves.toBe(false);

    expect(sideEffects.events).toEqual(["get"]);
  });

  it("routes KV failures to the engine storage error handler", async () => {
    const sideEffects = armingSideEffectSpy({
      existing: null,
      getError: new Error("kv unavailable")
    });

    await expect(
      ensureCascadePaperModeArmedRuntime(
        {
          observedAt: OBSERVED_AT,
          cachedConfig: defaultConfig,
          shadowMode: false
        },
        sideEffects.handlers
      )
    ).resolves.toBe(false);

    expect(sideEffects.events).toEqual(["get", "error:kv unavailable"]);
  });

  it("arms cascade paper mode through the trading target adapter", async () => {
    const events: string[] = [];
    const store = new Map<string, string>();
    const target: CascadePaperModeArmingTarget = {
      cachedConfig: {
        ...defaultConfig,
        STRATEGY_MODE: "CASCADE_RECOVERY",
        TRADING_ENABLED: false
      },
      env: {
        SHADOW_MODE: "true",
        CONFIG_STORE: {
          get(key: string) {
            events.push(`get:${key}`);
            return Promise.resolve(store.get(key) ?? null);
          },
          put(key: string, value: string) {
            events.push(`put:${key}:${value}`);
            store.set(key, value);
            return Promise.resolve();
          }
        } as unknown as KVNamespace
      },
      logger: {
        warn(eventType, _message, metadata) {
          events.push(
            `warn:${eventType}:${String(metadata?.strategyMode)}:${String(metadata?.shadowMode)}`
          );
        }
      },
      handleStorageWriteFailure(reason, error) {
        events.push(`error:${reason}:${error instanceof Error ? error.message : "UNKNOWN"}`);
      }
    };

    await expect(ensureCascadePaperModeArmedForTarget(OBSERVED_AT, target)).resolves.toBe(true);

    expect(events).toEqual([
      "get:cascade:paper_armed_at",
      "put:cascade:paper_armed_at:2026-05-20T06:00:00.000Z",
      "warn:CASCADE_PAPER_MODE_ARMED:CASCADE_RECOVERY:true"
    ]);
  });
});

function armingSideEffectSpy(options: { existing: string | null; getError?: Error }): {
  events: string[];
  handlers: CascadePaperModeArmingHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      getArmedAt() {
        events.push("get");
        if (options.getError) {
          throw options.getError;
        }
        return Promise.resolve(options.existing);
      },
      putArmedAt(observedAt) {
        events.push(`put:${observedAt}`);
        return Promise.resolve();
      },
      warnArmed(metadata) {
        events.push(
          `warn:${String(metadata.strategyMode)}:${String(metadata.tradingEnabled)}:${String(
            metadata.shadowMode
          )}`
        );
      },
      handleError(error) {
        events.push(`error:${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`);
      }
    }
  };
}

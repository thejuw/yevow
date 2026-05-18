import { describe, expect, it } from "vitest";
import { ConfigManager, configDefaultsFromEnv } from "../../src/ConfigManager";
import type { Env } from "../../src/types";

describe("ConfigManager environment defaults", () => {
  it("seeds cascade recovery paper posture from Worker env when KV is empty", async () => {
    const config = await new ConfigManager(
      mockKv(null),
      configDefaultsFromEnv({
        STRATEGY_MODE: "CASCADE_RECOVERY",
        CASCADE_TAKER_ENABLED: "false",
        CASCADE_INSTRUMENTS: "BTC,ETH,SOL",
        RISK_PER_TRADE_PCT: "1.0",
        HEAT_CAP_PCT: "5.0",
        MAX_DRAWDOWN_PCT: "15.0"
      } as Env)
    ).fetchConfig();

    expect(config.STRATEGY_MODE).toBe("CASCADE_RECOVERY");
    expect(config.CASCADE_TAKER_ENABLED).toBe(false);
    expect(config.CASCADE_INSTRUMENTS).toBe("BTC,ETH,SOL");
    expect(config.TRADING_ENABLED).toBe(false);
    expect(config.RISK_PER_TRADE_PCT).toBe(0.01);
    expect(config.HEAT_CAP_PCT).toBe(0.05);
    expect(config.MAX_DRAWDOWN_PCT).toBe(0.15);
  });

  it("keeps KV as the runtime source of truth over Worker env defaults", async () => {
    const config = await new ConfigManager(
      mockKv({
        STRATEGY_MODE: "OFF",
        CASCADE_TAKER_ENABLED: true,
        CASCADE_INSTRUMENTS: "BTC,HYPE",
        RISK_PER_TRADE_PCT: 0.005
      }),
      configDefaultsFromEnv({
        STRATEGY_MODE: "CASCADE_RECOVERY",
        CASCADE_TAKER_ENABLED: "false",
        CASCADE_INSTRUMENTS: "BTC,ETH,SOL",
        RISK_PER_TRADE_PCT: "1.0"
      } as Env)
    ).fetchConfig();

    expect(config.STRATEGY_MODE).toBe("OFF");
    expect(config.CASCADE_TAKER_ENABLED).toBe(true);
    expect(config.CASCADE_INSTRUMENTS).toBe("BTC,HYPE");
    expect(config.RISK_PER_TRADE_PCT).toBe(0.005);
  });
});

function mockKv(value: Record<string, unknown> | null): KVNamespace {
  return {
    get: async (_key: string, type?: "text" | "json") => {
      if (value === null) {
        return null;
      }

      return type === "json" ? value : JSON.stringify(value);
    },
    put: async () => undefined
  } as unknown as KVNamespace;
}

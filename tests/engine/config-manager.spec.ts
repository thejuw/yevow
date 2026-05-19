import { describe, expect, it } from "vitest";
import {
  ConfigManager,
  configDefaultsFromEnv,
  configFromAdminSnapshot,
  defaultConfig
} from "../../src/ConfigManager";
import {
  assetFromInstrument,
  cascadeAssetProfilesToJsonRecord,
  defaultCascadeAssetProfiles,
  parseCascadeAssetProfiles,
  resolveCascadeAssetProfile,
  serializedDefaultCascadeAssetProfiles
} from "../../src/strategy/cascade/AssetProfiles";
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
    expect(parseCascadeAssetProfiles(config.CASCADE_ASSET_PROFILES).HYPE).toMatchObject({
      notionalThresholdUsd: 2_500_000,
      zScoreThreshold: 3.5,
      maxPositionNotionalPct: 0.08
    });
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

  it("sanitizes per-asset cascade profile overrides from KV", async () => {
    const config = await new ConfigManager(
      mockKv({
        CASCADE_ASSET_PROFILES: JSON.stringify({
          HYPE: {
            notionalThresholdUsd: 1_000_000,
            zScoreThreshold: 4,
            minPriceMoveAtr: 2.5,
            maxPositionNotionalPct: 0.05,
            assetLiquidityCapUsd: 2_000,
            maxSlippageBps: 20,
            rationale: "manual stress profile"
          }
        })
      })
    ).fetchConfig();

    expect(parseCascadeAssetProfiles(config.CASCADE_ASSET_PROFILES).HYPE).toMatchObject({
      notionalThresholdUsd: 1_000_000,
      zScoreThreshold: 4,
      minPriceMoveAtr: 2.5,
      maxPositionNotionalPct: 0.05,
      assetLiquidityCapUsd: 2_000,
      maxSlippageBps: 20
    });
  });

  it("builds direct admin config snapshots with deterministic metadata fallbacks", () => {
    const config = configFromAdminSnapshot({
      currentConfig: {
        ...defaultConfig,
        TRADING_ENABLED: false,
        MAX_POSITION_SIZE: 10,
        updatedBy: "previous-admin",
        version: "previous-version"
      },
      snapshot: {
        TRADING_ENABLED: true,
        MAX_POSITION_SIZE: 25
      },
      observedAt: "2026-05-19T12:00:00.000Z",
      version: "version-1"
    });

    expect(config).toMatchObject({
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 25,
      updatedAt: "2026-05-19T12:00:00.000Z",
      updatedBy: "admin",
      version: "version-1"
    });
  });
});

describe("cascade asset profile parsing", () => {
  it("resolves default and malformed profile payloads fail-safe", () => {
    expect(defaultCascadeAssetProfiles().HYPE.asset).toBe("HYPE");
    expect(parseCascadeAssetProfiles("").BTC.notionalThresholdUsd).toBe(50_000_000);
    expect(parseCascadeAssetProfiles("not-json").SOL.zScoreThreshold).toBe(3.25);
    expect(parseCascadeAssetProfiles("[]").ETH.notionalThresholdUsd).toBe(25_000_000);
    expect(serializedDefaultCascadeAssetProfiles()).toContain('"HYPE"');
  });

  it("normalizes operator overrides, unknown assets, and instrument selectors", () => {
    const serialized = JSON.stringify({
      hype: {
        notionalThresholdUsd: -1,
        zScoreThreshold: 100,
        minPriceMoveAtr: -1,
        maxPositionNotionalPct: 3,
        assetLiquidityCapUsd: -10,
        maxSlippageBps: 0,
        rationale: " ".repeat(2)
      },
      DOGE: {
        asset: "doge",
        notionalThresholdUsd: 750_000,
        zScoreThreshold: 4.2,
        minPriceMoveAtr: 3,
        maxPositionNotionalPct: 0.03,
        assetLiquidityCapUsd: 1_500,
        maxSlippageBps: 25,
        rationale: "operator-added"
      }
    });

    const hype = resolveCascadeAssetProfile("HYPE-PERP", serialized);
    const doge = resolveCascadeAssetProfile("doge/usd", serialized);
    const json = cascadeAssetProfilesToJsonRecord(serialized);

    expect(assetFromInstrument("hype-usd")).toBe("HYPE");
    expect(assetFromInstrument("")).toBe("UNKNOWN");
    expect(hype).toMatchObject({
      notionalThresholdUsd: 2_500_000,
      zScoreThreshold: 20,
      minPriceMoveAtr: 0,
      maxPositionNotionalPct: 1,
      assetLiquidityCapUsd: 3_000,
      maxSlippageBps: 15
    });
    expect(doge).toMatchObject({
      asset: "DOGE",
      notionalThresholdUsd: 750_000,
      rationale: "operator-added"
    });
    expect(json.DOGE).toMatchObject({ asset: "DOGE" });
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

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { neutralMacroBias } from "../../src/Governor";
import {
  applyAdminConfigUpdateFlow,
  applyConfigRefreshFlow,
  applyConfigRefreshSideEffects,
  applyRuntimeConfigUpdateSideEffects,
  buildConfigRefreshRuntimeState,
  buildConfigRefreshLog,
  buildRuntimeConfigAppliedLog,
  configRefreshQuoteState,
  configRefreshTopologyFromLocation,
  shouldLogConfigRefresh,
  stateAfterConfigRefresh,
  stateAfterRuntimeConfigUpdate,
  type ConfigRefreshFlowHandlers,
  type ConfigRefreshSideEffectHandlers,
  type AdminConfigUpdateFlowHandlers,
  type RuntimeConfigUpdateSideEffectHandlers
} from "../../src/engine/trading/config/ConfigRuntime";
import {
  refreshTradingEngineConfig,
  type TradingEngineConfigRefreshHandlers
} from "../../src/engine/trading/config/TradingConfigControlRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { AdminConfigUpdate } from "../../src/types";

describe("ConfigRuntime", () => {
  it("applies runtime admin updates while preserving config and governance context", () => {
    const currentState = defaultEngineState("config-runtime");
    currentState.mode = "PAPER";
    currentState.bankroll = {
      currency: "USD",
      cash: 300,
      equity: 300,
      realizedPnl: 0,
      updatedAt: "2026-05-18T14:00:00.000Z"
    };
    currentState.location = {
      ...currentState.location,
      positionSizeMultiplier: 0.5
    };
    currentState.risk = {
      ...currentState.risk,
      perAssetMaxPosition: {
        "btc-usd": 50
      }
    };

    const cachedConfig = {
      ...defaultConfig,
      TRADING_ENABLED: false,
      MAX_POSITION_SIZE: 200,
      MAX_DRAWDOWN_PCT: 0.04,
      version: "config-v2"
    };
    const update: AdminConfigUpdate = {
      mode: "HALTED",
      maxLatencyMs: 175,
      bankroll: {
        equity: 325
      },
      risk: {
        perAssetMaxPosition: {
          "eth-usd": 25
        }
      }
    };

    const result = stateAfterRuntimeConfigUpdate({
      currentState,
      update,
      cachedConfig,
      macroBias: neutralMacroBias(),
      temporaryOverride: null,
      currentMaxLatencyMs: 250,
      observedAt: "2026-05-18T15:00:00.000Z"
    });

    expect(result.maxLatencyMs).toBe(175);
    expect(result.state).toMatchObject({
      mode: "HALTED",
      bankroll: {
        currency: "USD",
        cash: 300,
        equity: 325,
        realizedPnl: 0,
        updatedAt: "2026-05-18T15:00:00.000Z"
      },
      maxLatencyMs: 175,
      cachedConfig,
      temporaryOverride: null,
      heartbeatAt: "2026-05-18T15:00:00.000Z",
      updatedAt: "2026-05-18T15:00:00.000Z",
      risk: {
        configVersion: "config-v2",
        killSwitch: true,
        maxOrderNotional: 100,
        maxDrawdownPct: 0.04,
        updatedAt: "2026-05-18T15:00:00.000Z",
        perAssetMaxPosition: {
          "btc-usd": 50,
          "eth-usd": 25
        }
      }
    });
  });

  it("assembles refreshed config state with location-adjusted risk", () => {
    const currentState = defaultEngineState("config-refresh");
    const cachedConfig = {
      ...defaultConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 250,
      MAX_DRAWDOWN_PCT: 0.03,
      LATENCY_THRESHOLD_MS: 150,
      version: "config-refresh-v1"
    };
    const refreshedLocation = {
      ...currentState.location,
      colo: "NRT",
      positionSizeMultiplier: 0.7,
      latencyRiskMultiplier: 1.2
    };
    const nextQuoteState = {
      ...currentState.quoteState,
      status: "ACTIVE" as const,
      updatedAt: "2026-05-18T15:00:00.000Z"
    };
    const nextAssetQuoteStates = {
      "btc-usd": nextQuoteState
    };
    const assetMatrix = {
      "btc-usd": {
        ...currentState.assetMatrix["btc-usd"],
        selected: true
      }
    };
    const profilerStates = {
      "btc-usd": {
        ...currentState.profilerStates["btc-usd"],
        toxicityScore: 0.25
      }
    };

    const result = stateAfterConfigRefresh({
      currentState,
      nextConfig: cachedConfig,
      macroBias: neutralMacroBias(),
      temporaryOverride: null,
      nextAssetQuoteStates,
      nextQuoteState,
      assetMatrix,
      profilerStates,
      refreshedLocation,
      observedAt: "2026-05-18T15:00:00.000Z"
    });

    expect(result).toMatchObject({
      cachedConfig,
      assetQuoteStates: nextAssetQuoteStates,
      quoteState: nextQuoteState,
      assetMatrix,
      profilerStates,
      maxLatencyMs: 150,
      location: refreshedLocation,
      updatedAt: "2026-05-18T15:00:00.000Z",
      risk: {
        configVersion: "config-refresh-v1",
        killSwitch: false,
        maxDrawdownPct: 0.03,
        updatedAt: "2026-05-18T15:00:00.000Z"
      }
    });
    expect(result.risk.maxOrderNotional).toBe(175);
  });

  it("derives config refresh quote state and topology from runtime state", () => {
    const currentState = defaultEngineState("config-refresh-derivatives");
    const macroBias = neutralMacroBias();
    const quoteState = configRefreshQuoteState({
      assetQuoteStates: currentState.assetQuoteStates,
      quoteState: currentState.quoteState,
      nextConfig: {
        ...defaultConfig,
        TRADING_ENABLED: false
      },
      macroBias,
      observedAt: "2026-05-18T15:00:00.000Z"
    });

    expect(quoteState.quoteState).toMatchObject({
      status: "SUSPENDED",
      reason: "TRADING_DISABLED",
      updatedAt: "2026-05-18T15:00:00.000Z"
    });
    expect(
      configRefreshTopologyFromLocation(
        {
          ...currentState.location,
          colo: "NRT",
          placement: "remote-nrt"
        },
        "2026-05-18T15:00:00.000Z",
        "request-1"
      )
    ).toMatchObject({
      colo: "NRT",
      placement: "remote-nrt",
      requestId: "request-1",
      observedAt: "2026-05-18T15:00:00.000Z"
    });
  });

  it("builds full config refresh runtime state from injected collaborators", () => {
    const currentState = defaultEngineState("config-refresh-runtime-state");
    currentState.location = {
      ...currentState.location,
      colo: null,
      placement: "remote-nrt",
      observedLatencyMs: 37
    };
    currentState.microstructure = {
      ...currentState.microstructure,
      instrumentCode: "BTC-PERP"
    };
    const nextConfig = {
      ...defaultConfig,
      TRADING_ENABLED: false,
      MAX_POSITION_SIZE: 250,
      LATENCY_THRESHOLD_MS: 125,
      GOLDEN_COLOS: "NRT,HND",
      version: "config-refresh-runtime-v1"
    };
    const profilerStates = {
      ...currentState.profilerStates,
      "btc-usd": {
        ...currentState.profilerStates["btc-usd"],
        toxicityScore: 0.42
      }
    };
    const matrixInputs: {
      observedAt: string | null;
      latestInstrumentCode: string | undefined;
      oracleRegime: string | null;
      profilerToxicity: number;
      quoteStatus: string;
    } = {
      observedAt: null,
      latestInstrumentCode: undefined,
      oracleRegime: null,
      profilerToxicity: 0,
      quoteStatus: "UNKNOWN"
    };

    const result = buildConfigRefreshRuntimeState(
      {
        currentState,
        nextConfig,
        macroBias: neutralMacroBias(),
        temporaryOverride: null,
        observedAt: "2026-05-18T15:00:00.000Z",
        requestId: "config-refresh-request-1",
        env: {
          PLACEMENT_TARGET_COLO: "NRT",
          GOLDEN_COLOS: "NRT,HND",
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.25"
        }
      },
      {
        snapshotProfilers: () => profilerStates,
        calculateAssetMatrix: (
          observedAt,
          latestInstrumentCode,
          latestOracle,
          nextProfilerStates,
          assetQuoteStates
        ) => {
          matrixInputs.observedAt = observedAt;
          matrixInputs.latestInstrumentCode = latestInstrumentCode;
          matrixInputs.oracleRegime = latestOracle.regime;
          matrixInputs.profilerToxicity = nextProfilerStates["btc-usd"]?.toxicityScore ?? 0;
          matrixInputs.quoteStatus = assetQuoteStates["btc-usd"]?.status ?? "UNKNOWN";

          return {
            "btc-usd": {
              ...currentState.assetMatrix["btc-usd"],
              selectedByMoltworker: true,
              quoteStatus: "SUSPENDED",
              updatedAt: observedAt
            }
          };
        }
      }
    );

    expect(result.cachedConfig.version).toBe("config-refresh-runtime-v1");
    expect(result.location).toMatchObject({
      colo: "NRT",
      isGoldenRegion: true,
      observedLatencyMs: 37
    });
    expect(result.quoteState).toMatchObject({
      status: "SUSPENDED",
      reason: "TRADING_DISABLED",
      updatedAt: "2026-05-18T15:00:00.000Z"
    });
    expect(result.assetMatrix["btc-usd"]).toMatchObject({
      selectedByMoltworker: true,
      quoteStatus: "SUSPENDED",
      updatedAt: "2026-05-18T15:00:00.000Z"
    });
    expect(matrixInputs).toMatchObject({
      observedAt: "2026-05-18T15:00:00.000Z",
      latestInstrumentCode: "BTC-PERP",
      profilerToxicity: 0.42,
      quoteStatus: "SUSPENDED"
    });
  });

  it("builds config refresh audit metadata only when meaningful", () => {
    const nextConfig = {
      ...defaultConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 250,
      MAX_DRAWDOWN_PCT: 0.03,
      LATENCY_THRESHOLD_MS: 150,
      GOLDEN_COLOS: ["NRT", "HND"],
      version: "config-v2"
    };
    const input = {
      source: "ALARM" as const,
      previousVersion: "config-v1",
      nextConfig,
      macroBias: neutralMacroBias(),
      temporaryOverride: null
    };

    expect(shouldLogConfigRefresh(input)).toBe(true);
    expect(
      shouldLogConfigRefresh({
        ...input,
        previousVersion: "config-v2"
      })
    ).toBe(false);
    expect(
      shouldLogConfigRefresh({
        ...input,
        source: "ADMIN_SIGNAL",
        previousVersion: "config-v2"
      })
    ).toBe(true);
    expect(buildConfigRefreshLog(input)).toMatchObject({
      source: "ALARM",
      tradingEnabled: true,
      maxPositionSize: 250,
      maxDrawdownPct: 0.03,
      latencyThresholdMs: 150,
      goldenColos: ["NRT", "HND"],
      configVersion: "config-v2",
      macroBias: {
        schemaVersion: "macro-bias.v1"
      },
      temporaryOverride: null
    });
  });

  it("builds runtime config applied audit metadata from state", () => {
    const state = defaultEngineState("config-audit");
    state.mode = "PAPER";
    state.risk = {
      ...state.risk,
      configVersion: "risk-v3",
      killSwitch: true
    };

    expect(buildRuntimeConfigAppliedLog({ state, maxLatencyMs: 175 })).toEqual({
      mode: "PAPER",
      riskConfigVersion: "risk-v3",
      maxLatencyMs: 175,
      killSwitch: true
    });
  });

  it("applies config refresh side effects and emits meaningful audit logs", async () => {
    const nextConfig = {
      ...defaultConfig,
      TRADING_ENABLED: true,
      LATENCY_THRESHOLD_MS: 125,
      version: "config-v2"
    };
    const refreshedState = defaultEngineState("config-side-effects");
    refreshedState.cachedConfig = nextConfig;
    const sideEffects = configRefreshSideEffectSpy();

    await applyConfigRefreshSideEffects(
      {
        source: "ALARM",
        previousVersion: "config-v1",
        nextConfig,
        macroBias: neutralMacroBias(),
        temporaryOverride: null,
        refreshedState
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "cache:config-v2",
      "profilers:config-v2",
      "latency:125",
      "kill-switch-log-clear",
      "state:config-v2",
      "persist",
      "warn:config-v2"
    ]);
  });

  it("orchestrates config refresh flow through fetch, governance, state build, and side effects", async () => {
    const currentState = defaultEngineState("config-refresh-flow");
    currentState.location = {
      ...currentState.location,
      placement: "remote-nrt"
    };
    const flow = configRefreshFlowSpy();

    const result = await applyConfigRefreshFlow(
      {
        source: "ALARM",
        previousVersion: "config-v1",
        currentState,
        observedAt: "2026-05-18T15:00:00.000Z",
        requestId: "config-refresh-flow-request",
        env: {
          PLACEMENT_TARGET_COLO: "NRT",
          GOLDEN_COLOS: "NRT,HND",
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.25"
        }
      },
      flow.handlers
    );

    expect(result.config.version).toBe("config-fetched-effective");
    expect(result.refreshedState.cachedConfig.version).toBe("config-fetched-effective");
    expect(result.refreshedState.location.colo).toBe("NRT");
    expect(flow.events).toEqual([
      "fetch",
      "effective:config-fetched",
      "snapshot-profilers",
      "matrix:2026-05-18T15:00:00.000Z",
      "apply:config-fetched-effective:config-v1"
    ]);
  });

  it("wraps engine config refresh with generated request context", async () => {
    const currentState = defaultEngineState("trading-config-refresh-flow");
    currentState.location = {
      ...currentState.location,
      placement: "remote-nrt"
    };
    const flow = tradingEngineConfigRefreshSpy();

    await refreshTradingEngineConfig(
      {
        source: "ADMIN_SIGNAL",
        cachedConfig: {
          ...defaultConfig,
          version: "config-v1"
        },
        configSnapshot: {
          ...defaultConfig,
          TRADING_ENABLED: true,
          LATENCY_THRESHOLD_MS: 123,
          GOLDEN_COLOS: "NRT,HND",
          version: "config-v2"
        },
        currentState,
        env: {
          PLACEMENT_TARGET_COLO: "NRT",
          GOLDEN_COLOS: "NRT,HND",
          HIGH_LATENCY_COLO_RISK_MULTIPLIER: "0.25"
        }
      },
      flow.handlers
    );

    expect(flow.events).toEqual([
      "now",
      "request-id",
      "effective:config-v2",
      "snapshot-profilers",
      "matrix:2026-05-18T16:00:00.000Z",
      "cache:config-v2-effective",
      "profilers:config-v2-effective",
      "latency:123",
      "kill-switch-log-clear",
      "state:config-v2-effective:NRT",
      "persist",
      "warn:config-v2-effective"
    ]);
  });

  it("applies runtime config update side effects in persistence order", async () => {
    const state = defaultEngineState("runtime-config-side-effects");
    state.mode = "PAPER";
    state.risk = {
      ...state.risk,
      configVersion: "risk-v3",
      killSwitch: true
    };
    const sideEffects = runtimeConfigUpdateSideEffectSpy();

    await applyRuntimeConfigUpdateSideEffects(
      {
        state,
        maxLatencyMs: 175
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual(["latency:175", "state:PAPER", "persist", "warn:risk-v3"]);
  });

  it("orchestrates refresh-only admin config updates without applying runtime state", async () => {
    const sideEffects = adminConfigUpdateFlowSpy();

    const result = await applyAdminConfigUpdateFlow(
      {
        update: {
          signal: "REFRESH_CONFIG",
          config: {
            TRADING_ENABLED: false,
            MAX_POSITION_SIZE: 125,
            LATENCY_THRESHOLD_MS: 175
          }
        },
        currentState: defaultEngineState("refresh-only-flow"),
        cachedConfig: {
          ...defaultConfig,
          TRADING_ENABLED: true,
          MAX_POSITION_SIZE: 200,
          version: "config-current"
        },
        macroBias: neutralMacroBias(),
        temporaryOverride: null,
        currentMaxLatencyMs: 250,
        observedAt: "2026-05-18T15:00:00.000Z"
      },
      sideEffects.handlers
    );

    expect(result).toBeNull();
    expect(sideEffects.events).toEqual(["refresh:false:125:175", "schedule"]);
  });

  it("orchestrates admin config refresh before runtime state application", async () => {
    const sideEffects = adminConfigUpdateFlowSpy();

    const result = await applyAdminConfigUpdateFlow(
      {
        update: {
          config: {
            TRADING_ENABLED: true,
            LATENCY_THRESHOLD_MS: 150
          },
          mode: "PAPER",
          maxLatencyMs: 150
        },
        currentState: defaultEngineState("refresh-runtime-flow"),
        cachedConfig: {
          ...defaultConfig,
          TRADING_ENABLED: false,
          LATENCY_THRESHOLD_MS: 250,
          version: "config-current"
        },
        macroBias: neutralMacroBias(),
        temporaryOverride: null,
        currentMaxLatencyMs: 250,
        observedAt: "2026-05-18T15:00:00.000Z"
      },
      sideEffects.handlers
    );

    expect(result?.state.mode).toBe("PAPER");
    expect(result?.maxLatencyMs).toBe(150);
    expect(sideEffects.events).toEqual(["refresh:true:0:150", "schedule", "runtime:PAPER:150"]);
  });

  it("orchestrates runtime-only admin updates without refreshing config", async () => {
    const sideEffects = adminConfigUpdateFlowSpy();

    const result = await applyAdminConfigUpdateFlow(
      {
        update: {
          mode: "HALTED",
          bankroll: {
            equity: 275
          }
        },
        currentState: defaultEngineState("runtime-only-flow"),
        cachedConfig: {
          ...defaultConfig,
          version: "config-current"
        },
        macroBias: neutralMacroBias(),
        temporaryOverride: null,
        currentMaxLatencyMs: 250,
        observedAt: "2026-05-18T15:00:00.000Z"
      },
      sideEffects.handlers
    );

    expect(result?.state.mode).toBe("HALTED");
    expect(result?.state.bankroll.equity).toBe(275);
    expect(sideEffects.events).toEqual(["runtime:HALTED:250"]);
  });
});

function configRefreshSideEffectSpy(): {
  events: string[];
  handlers: ConfigRefreshSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyConfigCache(config) {
        events.push(`cache:${config.version}`);
      },
      configureProfilers(config) {
        events.push(`profilers:${config.version}`);
      },
      setMaxLatencyMs(maxLatencyMs) {
        events.push(`latency:${maxLatencyMs}`);
      },
      clearKillSwitchLog() {
        events.push("kill-switch-log-clear");
      },
      applyState(state) {
        events.push(`state:${state.cachedConfig.version}`);
      },
      persistState() {
        events.push("persist");
        return Promise.resolve();
      },
      warnRefresh(metadata) {
        events.push(`warn:${String(metadata.configVersion)}`);
      }
    }
  };
}

function configRefreshFlowSpy(): {
  events: string[];
  handlers: ConfigRefreshFlowHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      fetchConfig() {
        events.push("fetch");
        return Promise.resolve({
          ...defaultConfig,
          TRADING_ENABLED: true,
          GOLDEN_COLOS: "NRT,HND",
          version: "config-fetched"
        });
      },
      readEffectiveConfig(config) {
        events.push(`effective:${config.version}`);
        return Promise.resolve({
          config: {
            ...config,
            LATENCY_THRESHOLD_MS: 125,
            version: `${config.version}-effective`
          },
          macroBias: neutralMacroBias(),
          temporaryOverride: null
        });
      },
      snapshotProfilers() {
        events.push("snapshot-profilers");
        return defaultEngineState("config-refresh-flow-profilers").profilerStates;
      },
      calculateAssetMatrix(observedAt) {
        events.push(`matrix:${observedAt}`);
        return defaultEngineState("config-refresh-flow-matrix").assetMatrix;
      },
      applyRefreshSideEffects(input) {
        events.push(`apply:${input.nextConfig.version}:${input.previousVersion}`);
        return Promise.resolve();
      }
    }
  };
}

function tradingEngineConfigRefreshSpy(): {
  events: string[];
  handlers: TradingEngineConfigRefreshHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      nowIso() {
        events.push("now");
        return "2026-05-18T16:00:00.000Z";
      },
      createRequestId() {
        events.push("request-id");
        return "trading-config-refresh-request";
      },
      fetchConfig() {
        events.push("fetch");
        return Promise.resolve(defaultConfig);
      },
      readEffectiveConfig(config) {
        events.push(`effective:${config.version}`);
        return Promise.resolve({
          config: {
            ...config,
            version: `${config.version}-effective`
          },
          macroBias: neutralMacroBias(),
          temporaryOverride: null
        });
      },
      snapshotProfilers() {
        events.push("snapshot-profilers");
        return defaultEngineState("trading-config-refresh-profilers").profilerStates;
      },
      calculateAssetMatrix(observedAt) {
        events.push(`matrix:${observedAt}`);
        return defaultEngineState("trading-config-refresh-matrix").assetMatrix;
      },
      applyConfigCache(config) {
        events.push(`cache:${config.version}`);
      },
      configureProfilers(config) {
        events.push(`profilers:${config.version}`);
      },
      setMaxLatencyMs(maxLatencyMs) {
        events.push(`latency:${maxLatencyMs}`);
      },
      clearKillSwitchLog() {
        events.push("kill-switch-log-clear");
      },
      applyState(state) {
        events.push(`state:${state.cachedConfig.version}:${state.location.colo}`);
      },
      persistRefreshState() {
        events.push("persist");
        return Promise.resolve();
      },
      warnRefresh(metadata) {
        events.push(`warn:${String(metadata.configVersion)}`);
      }
    }
  };
}

function runtimeConfigUpdateSideEffectSpy(): {
  events: string[];
  handlers: RuntimeConfigUpdateSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      setMaxLatencyMs(maxLatencyMs) {
        events.push(`latency:${maxLatencyMs}`);
      },
      applyState(state) {
        events.push(`state:${state.mode}`);
      },
      persistState() {
        events.push("persist");
        return Promise.resolve();
      },
      warnApplied(metadata) {
        events.push(`warn:${String(metadata.riskConfigVersion)}`);
      }
    }
  };
}

function adminConfigUpdateFlowSpy(): {
  events: string[];
  handlers: AdminConfigUpdateFlowHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      refreshConfig(config) {
        events.push(
          `refresh:${String(config?.TRADING_ENABLED)}:${String(config?.MAX_POSITION_SIZE)}:${String(config?.LATENCY_THRESHOLD_MS)}`
        );
        return Promise.resolve();
      },
      scheduleConfigRefresh() {
        events.push("schedule");
        return Promise.resolve();
      },
      applyRuntimeUpdate(update) {
        events.push(`runtime:${update.state.mode}:${update.maxLatencyMs}`);
        return Promise.resolve();
      }
    }
  };
}

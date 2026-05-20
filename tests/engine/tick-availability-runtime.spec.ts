import { describe, expect, it } from "vitest";
import { evaluateTickAvailability } from "../../src/engine/trading/state/TickAvailabilityRuntime";
import type { MarketTick } from "../../src/types";

describe("TickAvailabilityRuntime", () => {
  it("blocks halted live trading and emits one kill-switch log", () => {
    const decision = evaluateTickAvailability({
      tick: tick(),
      shadowReplay: false,
      shadowMode: false,
      tradingEnabled: true,
      mode: "HALTED",
      configVersion: "risk-v1",
      killSwitchLogged: false
    });

    expect(decision.result).toEqual({
      accepted: false,
      status: "DISABLED",
      reason: "TRADING_DISABLED"
    });
    expect(decision.log).toMatchObject({
      eventType: "KILL_SWITCH_ACTIVE",
      message: "Trading halted by cached config",
      metadata: {
        configVersion: "risk-v1",
        tradingEnabled: true,
        mode: "HALTED"
      }
    });
    expect(decision.nextKillSwitchLogged).toBe(true);
  });

  it("logs disabled paper market data without blocking the tick", () => {
    const decision = evaluateTickAvailability({
      tick: tick(),
      shadowReplay: false,
      shadowMode: true,
      tradingEnabled: false,
      mode: "PAPER",
      configVersion: "risk-v2",
      killSwitchLogged: false
    });

    expect(decision.result).toBeNull();
    expect(decision.log?.message).toBe("Trading disabled; market data remains enabled");
    expect(decision.nextKillSwitchLogged).toBe(true);
  });

  it("allows active trading without changing the log latch", () => {
    const decision = evaluateTickAvailability({
      tick: tick(),
      shadowReplay: false,
      shadowMode: false,
      tradingEnabled: true,
      mode: "LIVE",
      configVersion: "risk-v3",
      killSwitchLogged: true
    });

    expect(decision).toEqual({
      result: null,
      log: null,
      nextKillSwitchLogged: true
    });
  });
});

function tick(): MarketTick {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "HL",
    source_exchange: "hyperliquid",
    sequence: 12
  } as unknown as MarketTick;
}

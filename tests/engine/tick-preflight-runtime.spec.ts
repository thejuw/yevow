import { describe, expect, it } from "vitest";
import { evaluateTickTargetPreflight } from "../../src/engine/trading/state/TickPreflightRuntime";
import type { MarketTick } from "../../src/types";

describe("TickPreflightRuntime", () => {
  it("rejects non-target instruments outside replay mode", () => {
    expect(
      evaluateTickTargetPreflight({
        tick: tick("doge-usd"),
        shadowReplay: false
      })
    ).toEqual({
      normalizedInstrument: "doge-usd",
      rejection: {
        accepted: false,
        status: "IGNORED",
        reason: "NON_TARGET_ASSET",
        processedCount: 0
      }
    });
  });

  it("allows target instruments and shadow replay ticks", () => {
    expect(
      evaluateTickTargetPreflight({
        tick: tick("BTC-USD"),
        shadowReplay: false
      })
    ).toMatchObject({
      normalizedInstrument: "btc-usd",
      rejection: null
    });
    expect(
      evaluateTickTargetPreflight({
        tick: tick("DOGE-USD"),
        shadowReplay: true
      })
    ).toMatchObject({
      normalizedInstrument: "doge-usd",
      rejection: null
    });
  });
});

function tick(instrumentCode: string): MarketTick {
  return {
    instrumentCode
  } as MarketTick;
}

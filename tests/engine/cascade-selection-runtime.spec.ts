import { describe, expect, it } from "vitest";
import {
  cascadeInstrumentSet,
  isCascadeInstrumentEnabledForConfig
} from "../../src/engine/trading/cascade/CascadeSelectionRuntime";

describe("CascadeSelectionRuntime", () => {
  it("normalizes enabled cascade instruments from config strings", () => {
    expect([...cascadeInstrumentSet(" btc, HYPE , invalid-symbol, eth ")]).toEqual([
      "BTC",
      "HYPE",
      "ETH"
    ]);
  });

  it("checks instrument enablement by base asset", () => {
    expect(isCascadeInstrumentEnabledForConfig("BTC,HYPE", "btc-usd")).toBe(true);
    expect(isCascadeInstrumentEnabledForConfig("BTC,HYPE", "HYPE-PERP")).toBe(true);
    expect(isCascadeInstrumentEnabledForConfig("BTC,HYPE", "sol-usd")).toBe(false);
    expect(isCascadeInstrumentEnabledForConfig("", "btc-usd")).toBe(false);
  });
});

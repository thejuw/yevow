import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/ExecutionerWorker";

describe("ExecutionerWorker Hyperliquid serialization", () => {
  it("snaps large perp prices and sizes to Hyperliquid wire constraints", () => {
    const wire = __test__.hyperliquidOrderWire(
      100000.123456789,
      0.00123456789,
      "BUY",
      {
        coin: "BTC",
        assetIndex: 0,
        szDecimals: 5,
        loadedAt: 1778888000000
      }
    );

    expect(wire.price).toBe("100000");
    expect(wire.size).toBe("0.00123");
    expect(wire.priceRounded).toBe(true);
    expect(wire.sizeRounded).toBe(true);
  });

  it("preserves small prices within the perp decimal cap", () => {
    const wire = __test__.hyperliquidOrderWire(
      0.00123456,
      12.3456,
      "SELL",
      {
        coin: "TEST",
        assetIndex: 999,
        szDecimals: 1,
        loadedAt: 1778888000000
      }
    );

    expect(wire.price).toBe("0.00124");
    expect(wire.size).toBe("12.3");
  });
});

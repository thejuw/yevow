import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { __test__ } from "../../src/index";
import type { GlobalRiskConfig } from "../../src/types";

describe("gateway cascade live-readiness triggers", () => {
  it("requires readiness for cascade taker, both-live, and cascade trading enablement", () => {
    const current = config({
      STRATEGY_MODE: "CASCADE_RECOVERY",
      TRADING_ENABLED: false,
      CASCADE_TAKER_ENABLED: false
    });

    expect(
      __test__.requestsCascadeLivePromotion(
        current,
        config({ ...current, CASCADE_TAKER_ENABLED: true })
      )
    ).toBe(true);
    expect(
      __test__.requestsCascadeLivePromotion(
        current,
        config({ ...current, STRATEGY_MODE: "BOTH_LIVE" })
      )
    ).toBe(true);
    expect(
      __test__.requestsCascadeLivePromotion(
        current,
        config({ ...current, TRADING_ENABLED: true, STRATEGY_MODE: "CASCADE_RECOVERY" })
      )
    ).toBe(true);
    expect(
      __test__.requestsCascadeLivePromotion(
        current,
        config({ ...current, TRADING_ENABLED: true, STRATEGY_MODE: "MARKET_MAKING" })
      )
    ).toBe(false);
  });
});

function config(overrides: Partial<GlobalRiskConfig>): GlobalRiskConfig {
  return {
    ...defaultConfig,
    ...overrides
  };
}

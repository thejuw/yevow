import type { EngineState, Env, GlobalRiskConfig, MarketTick } from "../../../types";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import {
  applyTickAvailabilitySideEffects,
  evaluateTickAvailability,
  type TickAvailabilityLog
} from "./TickAvailabilityRuntime";

export interface TradingAvailabilityInput {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
  readonly env: Env;
  readonly config: GlobalRiskConfig;
  readonly mode: EngineState["mode"];
  readonly killSwitchLogged: boolean;
}

export interface TradingAvailabilityHandlers {
  readonly warn: (event: TickAvailabilityLog) => void;
  readonly setKillSwitchLogged: (logged: boolean) => void;
}

export function resolveTradingTickAvailability(
  input: TradingAvailabilityInput,
  handlers: TradingAvailabilityHandlers
): TickIngestResult | null {
  return applyTickAvailabilitySideEffects(
    evaluateTickAvailability({
      tick: input.tick,
      shadowReplay: input.shadowReplay,
      shadowMode: isShadowMode(input.env),
      tradingEnabled: input.config.TRADING_ENABLED,
      mode: input.mode,
      configVersion: input.config.version,
      killSwitchLogged: input.killSwitchLogged
    }),
    handlers
  );
}

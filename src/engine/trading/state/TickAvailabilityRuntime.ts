import type { EngineState, JsonRecord, MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import {
  killSwitchActiveLogMetadata,
  shouldBlockHaltedTrading,
  shouldLogDisabledTrading
} from "./TickStateRuntime";

export interface TickAvailabilityInput {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
  readonly shadowMode: boolean;
  readonly tradingEnabled: boolean;
  readonly mode: EngineState["mode"];
  readonly configVersion: string;
  readonly killSwitchLogged: boolean;
}

export interface TickAvailabilityLog {
  readonly eventType: "KILL_SWITCH_ACTIVE";
  readonly message: string;
  readonly metadata: JsonRecord;
}

export interface TickAvailabilityDecision {
  readonly result: TickIngestResult | null;
  readonly log: TickAvailabilityLog | null;
  readonly nextKillSwitchLogged: boolean;
}

export function evaluateTickAvailability(input: TickAvailabilityInput): TickAvailabilityDecision {
  const logMetadata = () =>
    killSwitchActiveLogMetadata({
      tick: input.tick,
      configVersion: input.configVersion,
      tradingEnabled: input.tradingEnabled,
      mode: input.mode
    });

  if (
    shouldBlockHaltedTrading({
      shadowReplay: input.shadowReplay,
      shadowMode: input.shadowMode,
      tradingEnabled: input.tradingEnabled,
      mode: input.mode
    })
  ) {
    return {
      result: {
        accepted: false,
        status: "DISABLED",
        reason: "TRADING_DISABLED"
      },
      log: input.killSwitchLogged
        ? null
        : {
            eventType: "KILL_SWITCH_ACTIVE",
            message: "Trading halted by cached config",
            metadata: logMetadata()
          },
      nextKillSwitchLogged: true
    };
  }

  if (
    shouldLogDisabledTrading({
      shadowReplay: input.shadowReplay,
      tradingEnabled: input.tradingEnabled,
      killSwitchLogged: input.killSwitchLogged
    })
  ) {
    return {
      result: null,
      log: {
        eventType: "KILL_SWITCH_ACTIVE",
        message: "Trading disabled; market data remains enabled",
        metadata: logMetadata()
      },
      nextKillSwitchLogged: true
    };
  }

  return {
    result: null,
    log: null,
    nextKillSwitchLogged: input.killSwitchLogged
  };
}

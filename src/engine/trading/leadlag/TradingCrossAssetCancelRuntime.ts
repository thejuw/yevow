import type { Env, GlobalRiskConfig, JsonRecord, MarketTick } from "../../../types";
import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";
import type { TickHandlingOptions } from "../pipelines/TickPipelineTypes";
import { applyCrossAssetHypeQuoteCancelFlow } from "./LeadLagRuntime";

export interface TradingCrossAssetCancelInput {
  readonly tick: MarketTick;
  readonly volatility: MultiScaleVolatilitySnapshot | null;
  readonly observedAt: string;
  readonly options: TickHandlingOptions;
  readonly config: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly env: Pick<Env, "CROSS_ASSET_CANCEL_LEAD_BPS" | "CROSS_ASSET_CANCEL_COOLDOWN_MS">;
  readonly lastHypeCancelAtMs: number;
  readonly fallbackNowMs: number;
}

export interface TradingCrossAssetCancelHandlers {
  readonly markCooldown: (instrumentCode: "hype-usd", nowMs: number) => void;
  readonly warn: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publishSuspend: (payload: JsonRecord) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (
    instrumentCode: "hype-usd",
    reason: "BTC_LEAD_MOVE"
  ) => Promise<unknown>;
}

export function cancelLaggingHypeQuotesForTrading(
  input: TradingCrossAssetCancelInput,
  handlers: TradingCrossAssetCancelHandlers
): void {
  applyCrossAssetHypeQuoteCancelFlow(
    {
      shadowReplay: input.options.shadowReplay,
      tradingEnabled: input.config.TRADING_ENABLED,
      tickInstrumentCode: input.tick.instrumentCode,
      volatility: input.volatility,
      observedAt: input.observedAt,
      leadThresholdBpsValue: input.env.CROSS_ASSET_CANCEL_LEAD_BPS,
      cooldownMsValue: input.env.CROSS_ASSET_CANCEL_COOLDOWN_MS,
      lastCancelAtMs: input.lastHypeCancelAtMs,
      fallbackNowMs: input.fallbackNowMs
    },
    handlers
  );
}

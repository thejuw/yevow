import type { EngineState, GlobalRiskConfig, TradeIntent } from "../types";
import { applyCvarSizing } from "../engine/CvarSizer";

export interface PitBossDecision {
  approved: boolean;
  intent: TradeIntent;
  kellyFraction: number;
  cappedFraction: number;
  capitalAllocationPct: number;
  assetMaxNotional: number;
  reason: string;
}

export class PitBossAgent {
  constructor(private readonly fractionalKelly = 0.5) {}

  approve(
    intent: TradeIntent,
    engineState: EngineState,
    config: GlobalRiskConfig,
    maxPositionPct: number,
    kellyFractionOverride = this.fractionalKelly
  ): PitBossDecision {
    const bankroll = Math.max(engineState.bankroll.equity, engineState.bankroll.cash, 0);
    const b = intent.loss > 0 ? intent.profit / intent.loss : 0;
    const rawKelly =
      b > 0 ? (intent.probabilityWin * (b + 1) - 1) / b : 0;
    const effectiveKelly = Math.min(1, Math.max(0, kellyFractionOverride));
    const kellyFraction = Math.max(0, rawKelly * effectiveKelly);
    const allocation =
      engineState.assetMatrix?.[intent.instrumentCode]?.capitalAllocationPct ?? 1;
    const safeAllocation = Math.min(1, Math.max(0, allocation));
    const assetMaxFraction = Math.max(0, maxPositionPct * safeAllocation);
    const preCvarFraction = Math.min(kellyFraction, assetMaxFraction, 0.05);
    const cvar = applyCvarSizing({
      baseFraction: preCvarFraction,
      slippage: engineState.slippage,
      confidence: config.CVAR_CONFIDENCE,
      maxTailLossBps: config.CVAR_MAX_TAIL_LOSS_BPS,
      lookbackTrades: config.CVAR_LOOKBACK_TRADES
    });
    const cappedFraction = cvar.cappedFraction;
    const maxNotional = Math.min(
      config.MAX_POSITION_SIZE > 0 ? config.MAX_POSITION_SIZE : Number.POSITIVE_INFINITY,
      bankroll * cappedFraction
    );
    const approvedSize =
      intent.expectedPrice > 0 ? Math.min(intent.requestedSize, maxNotional / intent.expectedPrice) : 0;
    const approved = approvedSize > 0 && intent.expectedValue > intent.minEvThreshold;

    return {
      approved,
      intent: {
        ...intent,
        approvedSize
      },
      kellyFraction,
      cappedFraction,
      capitalAllocationPct: safeAllocation,
      assetMaxNotional: Number.isFinite(maxNotional) ? maxNotional : bankroll * cappedFraction,
      reason: approved
        ? `APPROVED_FRACTIONAL_KELLY_VOL_WEIGHTED_ASSET_BUDGET_${cvar.reason}`
        : "REJECTED_BY_KELLY_OR_EV"
    };
  }
}

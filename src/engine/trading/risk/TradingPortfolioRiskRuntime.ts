import { DEFAULT_VAR_CONFIDENCE_Z } from "../../../TradingEngineConstants";
import type { EngineState, Env, GlobalRiskConfig } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import { applyPortfolioRiskFlow, resolveVarConfidenceZ } from "./PortfolioRiskRuntime";

export interface TradingPortfolioRiskInput {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: Pick<EngineState, "mode" | "bankroll" | "riskMetrics" | "openPositions">;
  readonly oracle: EngineState["oracle"];
  readonly env: Env;
  readonly observedAt: string;
}

export interface TradingPortfolioRiskHandlers {
  readonly applyConfig: (config: GlobalRiskConfig) => void;
  readonly writeConfig: (config: GlobalRiskConfig) => Promise<unknown>;
  readonly cancelAllQuotes: (
    instrumentCode: "ALL",
    reason: "MAX_DRAWDOWN_BREACH"
  ) => Promise<unknown>;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly notify: (notification: NotifierEvent) => void;
}

export function updateTradingPortfolioRisk(
  input: TradingPortfolioRiskInput,
  handlers: TradingPortfolioRiskHandlers
): EngineState["riskMetrics"] {
  return applyPortfolioRiskFlow(
    {
      cachedConfig: input.cachedConfig,
      mode: input.engineState.mode,
      equity: input.engineState.bankroll.equity,
      priorHighWaterMark: input.engineState.riskMetrics.highWaterMark,
      positions: input.engineState.openPositions,
      oracleVolatility: input.oracle.volatility,
      varConfidenceZ: resolveVarConfidenceZ(
        input.cachedConfig,
        input.env.VAR_CONFIDENCE_Z,
        DEFAULT_VAR_CONFIDENCE_Z
      ),
      maxDrawdownPct: input.cachedConfig.MAX_DRAWDOWN_PCT,
      tradingEnabled: input.cachedConfig.TRADING_ENABLED,
      observedAt: input.observedAt
    },
    handlers
  );
}

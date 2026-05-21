import { DEFAULT_VAR_CONFIDENCE_Z } from "../../../TradingEngineConstants";
import type { EngineState, Env, GlobalRiskConfig } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import { applyPortfolioRiskFlow, resolveVarConfidenceZ } from "./PortfolioRiskRuntime";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "../quotes/QuoteCancelRuntime";

export interface TradingPortfolioRiskInput {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: Pick<EngineState, "mode" | "bankroll" | "riskMetrics" | "openPositions">;
  readonly oracle: EngineState["oracle"];
  readonly env: Pick<Env, "VAR_CONFIDENCE_Z">;
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

export interface TradingPortfolioRiskTarget {
  cachedConfig: GlobalRiskConfig;
  readonly engineState: TradingPortfolioRiskInput["engineState"];
  readonly env: Pick<Env, "VAR_CONFIDENCE_Z">;
  readonly configManager: {
    writeConfig(config: GlobalRiskConfig): Promise<unknown>;
  };
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  readonly notifier: {
    notify(notification: NotifierEvent): void;
  };
  cancelAllQuotes?(instrumentCode: "ALL", reason: "MAX_DRAWDOWN_BREACH"): Promise<unknown>;
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

export function updateTradingPortfolioRiskForTarget(
  input: {
    readonly oracle: EngineState["oracle"];
    readonly observedAt: string;
  },
  target: TradingPortfolioRiskTarget
): EngineState["riskMetrics"] {
  return updateTradingPortfolioRisk(
    {
      cachedConfig: target.cachedConfig,
      engineState: target.engineState,
      oracle: input.oracle,
      env: target.env,
      observedAt: input.observedAt
    },
    {
      applyConfig: (config) => {
        target.cachedConfig = config;
      },
      writeConfig: (config) => target.configManager.writeConfig(config),
      cancelAllQuotes: (instrumentCode, reason) =>
        target.cancelAllQuotes
          ? target.cancelAllQuotes(instrumentCode, reason)
          : cancelAllTradingQuotesForTarget(
              instrumentCode,
              reason,
              target as unknown as TradingQuoteCancelAllTarget
            ),
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      notify: (notification) => {
        target.notifier.notify(notification);
      }
    }
  );
}

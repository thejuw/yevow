import type { PitBossAgent } from "../../../agents/PitBossAgent";
import {
  DEFAULT_MAX_POSITION_PCT,
  DEFAULT_ORDER_ACK_TIMEOUT_MS
} from "../../../TradingEngineConstants";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  TradeIntent
} from "../../../types";
import { readPositiveInteger } from "../helpers/RuntimeParsing";
import { resolveMaxPositionPct } from "../risk/PortfolioRiskRuntime";
import { prepareApprovedExecutionPlan, type ApprovedExecutionPlan } from "./ExecutionPlanRuntime";

export interface TradingExecutionPlanOptions {
  readonly bypassQuoteSuspension?: boolean;
  readonly stateOverride?: EngineState;
  readonly kellyFractionOverride?: number;
}

export interface TradingExecutionPlanInput {
  readonly intent: TradeIntent | null;
  readonly observedAt: string;
  readonly options?: TradingExecutionPlanOptions;
  readonly engineState: EngineState;
  readonly config: GlobalRiskConfig;
  readonly env: Env;
  readonly orderBooks: Iterable<InternalOrderBook>;
  readonly pitBossAgent: PitBossAgent;
}

export interface TradingExecutionPlanHandlers {
  readonly logResidualLiquidityShortfall: (metadata: JsonRecord) => void;
}

export function prepareTradingExecutionPlan(
  input: TradingExecutionPlanInput,
  handlers: TradingExecutionPlanHandlers
): ApprovedExecutionPlan | null {
  const riskState = input.options?.stateOverride ?? input.engineState;

  return prepareApprovedExecutionPlan(
    {
      intent: input.intent,
      riskState,
      config: input.config,
      observedAt: input.observedAt,
      bypassQuoteSuspension: input.options?.bypassQuoteSuspension,
      maxPositionPct: resolveMaxPositionPct(
        input.config,
        input.env.MAX_POSITION_PCT,
        DEFAULT_MAX_POSITION_PCT
      ),
      kellyFraction: input.options?.kellyFractionOverride ?? input.config.KELLY_FRACTION,
      orderBooks: input.orderBooks,
      ackTimeoutMs: readPositiveInteger(
        input.env.ORDER_ACK_TIMEOUT_MS,
        DEFAULT_ORDER_ACK_TIMEOUT_MS,
        100,
        60_000
      )
    },
    {
      approveIntent: (intent, candidateRiskState, config, maxPositionPct, kelly) =>
        input.pitBossAgent.approve(intent, candidateRiskState, config, maxPositionPct, kelly),
      logResidualLiquidityShortfall: handlers.logResidualLiquidityShortfall
    }
  );
}

import type { EngineState, GlobalRiskConfig, Position } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import { readPositiveNumber } from "../helpers/RuntimeParsing";

export interface PortfolioRiskInput {
  readonly mode: EngineState["mode"];
  readonly equity: number;
  readonly priorHighWaterMark: number;
  readonly positions: Record<string, Position>;
  readonly oracleVolatility: number;
  readonly varConfidenceZ: number;
  readonly maxDrawdownPct: number;
  readonly tradingEnabled: boolean;
  readonly observedAt: string;
}

export interface PortfolioRiskResult {
  readonly metrics: EngineState["riskMetrics"];
  readonly drawdownBreached: boolean;
}

export interface DrawdownKillSwitchInput {
  readonly cachedConfig: GlobalRiskConfig;
  readonly metrics: EngineState["riskMetrics"];
  readonly equity: number;
  readonly observedAt: string;
}

export interface DrawdownKillSwitchTransition {
  readonly config: GlobalRiskConfig;
  readonly cancelReason: "MAX_DRAWDOWN_BREACH";
  readonly notification: NotifierEvent;
}

export interface DrawdownKillSwitchSideEffectHandlers {
  readonly applyConfig: (config: GlobalRiskConfig) => void;
  readonly writeConfig: (config: GlobalRiskConfig) => Promise<unknown>;
  readonly cancelAllQuotes: (
    instrumentCode: "ALL",
    reason: "MAX_DRAWDOWN_BREACH"
  ) => Promise<unknown>;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly notify: (notification: NotifierEvent) => void;
}

export interface PortfolioRiskFlowInput extends PortfolioRiskInput {
  readonly cachedConfig: GlobalRiskConfig;
}

export function resolveMaxPositionPct(
  config: Pick<GlobalRiskConfig, "MAX_POSITION_PCT">,
  envValue: string | undefined,
  fallback: number
): number {
  return config.MAX_POSITION_PCT > 0
    ? config.MAX_POSITION_PCT
    : readPositiveNumber(envValue, fallback);
}

export function resolveVarConfidenceZ(
  config: Pick<GlobalRiskConfig, "VAR_CONFIDENCE_Z">,
  envValue: string | undefined,
  fallback: number
): number {
  return config.VAR_CONFIDENCE_Z > 0
    ? config.VAR_CONFIDENCE_Z
    : readPositiveNumber(envValue, fallback);
}

export function calculatePortfolioRisk(input: PortfolioRiskInput): PortfolioRiskResult {
  const equity = Math.max(input.equity, 0);
  const priorHighWaterMark = Math.max(input.priorHighWaterMark, equity);
  const highWaterMark =
    input.mode === "PAPER" && priorHighWaterMark > Math.max(equity * 1.5, equity + 1_000)
      ? equity
      : Math.max(priorHighWaterMark, equity);
  const rollingDrawdownPct =
    highWaterMark > 0 ? Math.max(0, (highWaterMark - equity) / highWaterMark) : 0;
  const notional = Object.values(input.positions).reduce(
    (sum, position) => sum + Math.abs(position.quantity * position.markPrice),
    0
  );
  const oneHourVolatilityScale = Math.sqrt(60);
  const var99OneHour =
    notional * input.oracleVolatility * oneHourVolatilityScale * input.varConfidenceZ;
  const drawdownBreached = rollingDrawdownPct > input.maxDrawdownPct;

  return {
    drawdownBreached,
    metrics: {
      highWaterMark,
      rollingDrawdownPct,
      var99OneHour,
      isTradingEnabled: !drawdownBreached && input.tradingEnabled,
      updatedAt: input.observedAt
    }
  };
}

export function buildDrawdownKillSwitchTransition(
  input: DrawdownKillSwitchInput
): DrawdownKillSwitchTransition {
  const config = {
    ...input.cachedConfig,
    TRADING_ENABLED: false,
    updatedAt: input.observedAt,
    updatedBy: "risk:drawdown",
    version: `${input.cachedConfig.version}:drawdown`
  };

  return {
    config,
    cancelReason: "MAX_DRAWDOWN_BREACH",
    notification: {
      priority: "CRITICAL",
      title: "Sovereign-Sigma drawdown kill switch",
      message: `Drawdown ${(input.metrics.rollingDrawdownPct * 100).toFixed(
        2
      )}% breached configured limit ${(config.MAX_DRAWDOWN_PCT * 100).toFixed(
        2
      )}%. Trading disabled.`,
      dedupeKey: "risk:max-drawdown",
      metadata: {
        rollingDrawdownPct: input.metrics.rollingDrawdownPct,
        maxDrawdownPct: config.MAX_DRAWDOWN_PCT,
        highWaterMark: input.metrics.highWaterMark,
        equity: Math.max(input.equity, 0)
      }
    }
  };
}

export function applyDrawdownKillSwitchSideEffects(
  transition: DrawdownKillSwitchTransition,
  handlers: DrawdownKillSwitchSideEffectHandlers
): void {
  handlers.applyConfig(transition.config);
  handlers.schedule(handlers.writeConfig(transition.config));
  handlers.schedule(handlers.cancelAllQuotes("ALL", transition.cancelReason));
  handlers.notify(transition.notification);
}

export function applyPortfolioRiskFlow(
  input: PortfolioRiskFlowInput,
  handlers: DrawdownKillSwitchSideEffectHandlers
): EngineState["riskMetrics"] {
  const { drawdownBreached, metrics } = calculatePortfolioRisk(input);

  if (drawdownBreached && input.tradingEnabled) {
    applyDrawdownKillSwitchSideEffects(
      buildDrawdownKillSwitchTransition({
        cachedConfig: input.cachedConfig,
        metrics,
        equity: input.equity,
        observedAt: input.observedAt
      }),
      handlers
    );
  }

  return metrics;
}

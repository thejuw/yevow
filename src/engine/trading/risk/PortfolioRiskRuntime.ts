import type { EngineState, Position } from "../../../types";

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

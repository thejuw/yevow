import type { EngineState, GlobalRiskConfig, ProfilerState, TradeIntent } from "../../../types";
import { roundMetric } from "../book/SortedBookSide";

export interface EnsembleStateInput {
  readonly intent: TradeIntent | null;
  readonly profilerState: ProfilerState;
  readonly oracleState: EngineState["oracle"];
  readonly sentimentState: EngineState["sentiment"];
  readonly anomalyStatus: EngineState["anomaly"];
  readonly config: GlobalRiskConfig;
  readonly observedAt: string;
}

export function calculateEnsembleState(input: EnsembleStateInput): EngineState["ensemble"] {
  const anomalyScore = Math.max(
    input.anomalyStatus.status === "ANOMALY" ? 1 : 0,
    Math.min(1, Math.abs(input.anomalyStatus.priceZScore ?? 0) / 8),
    Math.min(1, Math.abs(input.anomalyStatus.volumeZScore ?? 0) / 8),
    Math.min(1, input.anomalyStatus.cancellationToExecutionRatio / 12)
  );
  const anomalyCircuitBreaker =
    anomalyScore >= 0.85 || input.profilerState.toxicityState === "CRITICAL";
  const profilerConfidence = profilerConfidenceFor(input.config, input.profilerState);
  const oracleConfidence = oracleConfidenceFor(input.config, input.oracleState);
  const sentimentConfidence = sentimentConfidenceFor(
    input.config,
    input.intent,
    input.sentimentState
  );
  const croupierConfidence = croupierConfidenceFor(input.config, input.intent);
  const votes: EngineState["ensemble"]["votes"] = [
    {
      agent: "ORACLE",
      confidence: roundMetric(oracleConfidence, 6),
      weight: 0.3,
      contribution: roundMetric(oracleConfidence * 0.3, 6),
      rationale: input.config.ORACLE_ENABLED ? input.oracleState.regime : "DISABLED"
    },
    {
      agent: "PROFILER",
      confidence: roundMetric(profilerConfidence, 6),
      weight: 0.3,
      contribution: roundMetric(profilerConfidence * 0.3, 6),
      rationale: input.config.PROFILER_ENABLED
        ? (input.profilerState.toxicityState ?? "NORMAL")
        : "DISABLED"
    },
    {
      agent: "CROUPIER",
      confidence: roundMetric(croupierConfidence, 6),
      weight: 0.25,
      contribution: roundMetric(croupierConfidence * 0.25, 6),
      rationale: input.config.CROUPIER_ENABLED
        ? input.intent
          ? `EV=${roundMetric(input.intent.expectedValue, 8)}`
          : "NO_INTENT"
        : "DISABLED"
    },
    {
      agent: "SENTIMENT",
      confidence: roundMetric(sentimentConfidence, 6),
      weight: 0.15,
      contribution: roundMetric(sentimentConfidence * 0.15, 6),
      rationale: input.config.SENTIMENT_ENABLED
        ? `${input.sentimentState.provider ?? "LEXICAL"}:${input.sentimentState.bias}`
        : "DISABLED"
    }
  ];
  const weightedConfidence = votes.reduce((sum, vote) => sum + vote.contribution, 0);
  const regimeMultiplier =
    input.oracleState.regime === "REGIME_CRISIS"
      ? 0.25
      : input.oracleState.regime === "REGIME_TREND"
        ? 0.8
        : 1;
  const confidence = anomalyCircuitBreaker
    ? 0
    : Math.min(1, Math.max(0, weightedConfidence * (1 - anomalyScore * 0.75)));
  const kellyMultiplier = anomalyCircuitBreaker
    ? 0
    : Math.min(1, Math.max(0, confidence * regimeMultiplier));

  return {
    schemaVersion: "ensemble.v1",
    confidence: roundMetric(confidence, 6),
    kellyMultiplier: roundMetric(kellyMultiplier, 6),
    regimeMultiplier,
    anomalyCircuitBreaker,
    votes,
    rationale: anomalyCircuitBreaker
      ? "ANOMALY_CIRCUIT_BREAKER"
      : `ENSEMBLE_WEIGHTED_CONFIDENCE:${roundMetric(confidence, 6)}`,
    updatedAt: input.observedAt
  };
}

function profilerConfidenceFor(config: GlobalRiskConfig, profilerState: ProfilerState): number {
  if (!config.PROFILER_ENABLED) {
    return 0;
  }

  if (profilerState.toxicityState === "CRITICAL") {
    return 0;
  }

  if (profilerState.toxicityState === "TOXIC") {
    return 0.15;
  }

  return profilerState.toxicityState === "CONTESTED" ? 0.55 : 0.85;
}

function oracleConfidenceFor(config: GlobalRiskConfig, oracleState: EngineState["oracle"]): number {
  if (!config.ORACLE_ENABLED) {
    return 0;
  }

  if (oracleState.regime === "REGIME_CRISIS") {
    return 0.25;
  }

  return oracleState.regime === "REGIME_TREND" ? 0.7 : 0.62;
}

function sentimentConfidenceFor(
  config: GlobalRiskConfig,
  intent: TradeIntent | null,
  sentimentState: EngineState["sentiment"]
): number {
  if (!config.SENTIMENT_ENABLED) {
    return 0;
  }

  const sentimentDirectionMatches =
    !intent ||
    sentimentState.bias === "NEUTRAL" ||
    (intent.direction === "LONG" && sentimentState.bias === "BULLISH") ||
    (intent.direction === "SHORT" && sentimentState.bias === "BEARISH");

  return sentimentDirectionMatches
    ? Math.max(0.35, sentimentState.confidence)
    : Math.max(0.1, 1 - sentimentState.confidence);
}

function croupierConfidenceFor(config: GlobalRiskConfig, intent: TradeIntent | null): number {
  if (!config.CROUPIER_ENABLED || !intent) {
    return 0;
  }

  const evRatio = Math.min(
    1,
    Math.max(
      0,
      intent.expectedValue / Math.max(1, intent.executionCosts + intent.adverseSelectionCost)
    )
  );

  return Math.min(1, Math.max(0, (intent.confidence + evRatio) / 2));
}

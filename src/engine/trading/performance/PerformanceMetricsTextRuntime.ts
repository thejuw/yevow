import type { ExecutionProfile } from "../../../types";
import { prometheusMetric } from "../helpers/RuntimeMetrics";

export interface PerformanceMetricsTextInput {
  readonly engineId: string;
  readonly profile: ExecutionProfile;
  readonly processedTicks: number;
  readonly toxicityScore: number;
}

export function buildPerformanceMetricsText(input: PerformanceMetricsTextInput): string {
  const labels = {
    engine_id: input.engineId,
    status: input.profile.status
  };
  const lines = [
    prometheusMetric(
      "sovereign_sigma_processing_latency_jitter_ms",
      "Standard deviation of processing latency over the configured rolling sample window.",
      "gauge",
      input.profile.jitterMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processing_latency_average_ms",
      "Average processing latency over the configured rolling sample window.",
      "gauge",
      input.profile.averageProcessingLatencyMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processing_latency_last_ms",
      "Most recent tick processing latency.",
      "gauge",
      input.profile.lastProcessingLatencyMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processing_latency_max_ms",
      "Maximum processing latency in the configured rolling sample window.",
      "gauge",
      input.profile.maxProcessingLatencyMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_wakeup_time_ms",
      "Time spent awaiting Durable Object initialization before request logic.",
      "gauge",
      input.profile.wakeUpTimeMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_order_book_update_ms",
      "High-resolution duration of the latest order book update block.",
      "gauge",
      input.profile.orderBookUpdateMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_agent_logic_ms",
      "High-resolution duration of the latest agent logic block.",
      "gauge",
      input.profile.agentLogicMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_hot_path_ms",
      "High-resolution duration of the latest tick hot path.",
      "gauge",
      input.profile.totalHotPathMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_execution_unstable",
      "Execution stability flag; 1 when jitter exceeds threshold.",
      "gauge",
      input.profile.status === "UNSTABLE" ? 1 : 0,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_cold_start_suspected",
      "Cold-start or eviction suspicion flag based on Durable Object wake-up time.",
      "gauge",
      input.profile.coldStartSuspected ? 1 : 0,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_execution_profile_samples",
      "Number of processing latency samples currently retained.",
      "gauge",
      input.profile.sampleCount,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processed_ticks_total",
      "Total market ticks processed by the engine.",
      "counter",
      input.processedTicks,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_toxicity_score",
      "Current VPIN toxicity score from the Profiler agent.",
      "gauge",
      input.toxicityScore,
      labels
    )
  ];

  return `${lines.join("\n")}\n`;
}

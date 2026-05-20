import { roundLatency } from "./RuntimeClock";

export function processingLatencyStats(samples: number[]): {
  jitterMs: number;
  averageMs: number | null;
  maxMs: number | null;
} {
  if (samples.length === 0) {
    return {
      jitterMs: 0,
      averageMs: null,
      maxMs: null
    };
  }

  const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - average) ** 2, 0) / samples.length;
  const max = samples.reduce(
    (currentMax, sample) => Math.max(currentMax, sample),
    Number.NEGATIVE_INFINITY
  );

  return {
    jitterMs: roundLatency(Math.sqrt(variance)),
    averageMs: roundLatency(average),
    maxMs: roundLatency(max)
  };
}

export function prometheusMetric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  value: number | null,
  labels: Record<string, string | number | boolean | null>
): string {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : 0;

  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name}${prometheusLabels(labels)} ${safeValue}`
  ].join("\n");
}

export function prometheusLabels(labels: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== null);

  if (entries.length === 0) {
    return "";
  }

  return `{${entries
    .map(([key, value]) => `${key}="${escapePrometheusLabel(String(value))}"`)
    .join(",")}}`;
}

export function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function finiteMetric(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function nullableFiniteMetric(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

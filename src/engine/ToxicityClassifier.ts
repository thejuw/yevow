import type { ProfilerState } from "../types";

export interface ToxicityClassifierInput {
  profiler: ProfilerState;
  spreadBps: number | null;
  jumpDetected: boolean;
}

export interface ToxicityClassifierResult {
  probability: number;
  threshold: number;
  triggered: boolean;
}

export function classifyLearnedToxicity(
  input: ToxicityClassifierInput,
  threshold: number
): ToxicityClassifierResult {
  const obiAbs = Math.abs(input.profiler.obi ?? 0);
  const signedAgreement =
    Math.sign(input.profiler.latestDirectionalImbalance) === Math.sign(input.profiler.obi ?? 0)
      ? 1
      : 0;
  const spreadStress = Math.min(1, Math.max(0, (input.spreadBps ?? 0) / 25));
  const jumpStress = input.jumpDetected ? 1 : 0;
  const bucketCompletions = Math.min(1, input.profiler.amVpinBucketCompletions / 25);
  const score =
    -2.2 +
    input.profiler.amVpinScore * 3.25 +
    obiAbs * 1.25 +
    signedAgreement * 0.85 +
    spreadStress * 0.4 +
    jumpStress * 0.75 +
    bucketCompletions * 0.3;
  const probability = roundMetric(1 / (1 + Math.exp(-score)), 6);
  const safeThreshold = Math.min(1, Math.max(0, threshold));

  return {
    probability,
    threshold: safeThreshold,
    triggered: probability >= safeThreshold
  };
}

function roundMetric(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

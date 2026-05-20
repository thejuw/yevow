import { parseTimestampMs, roundLatency } from "../helpers/RuntimeClock";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { extractTickStreamId } from "../state/TickClassification";
import {
  DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS,
  DEFAULT_NATIVE_HL_MAX_LATENCY_MS
} from "../../../TradingEngineConstants";
import type { EngineState, LatencyMetrics, MarketTransport, MarketTick } from "../../../types";

export interface TickLatencyInput {
  readonly tick: MarketTick;
  readonly brainTimestamp: string;
  readonly maxLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly sampleCount: number;
  readonly location: EngineState["location"];
}

export interface TickLatencyPreparationInput extends TickLatencyInput {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
  readonly dwellirMaxLatencyMs?: string;
  readonly hlStaleAfterMs?: string;
  readonly currentMaxLatencyMs: number;
}

export interface TickLatencyPreparationResult {
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
  readonly isHardStale: boolean;
  readonly shouldResetLatencyBaseline: boolean;
  readonly shouldUpdateLatencyAverage: boolean;
}

export interface PreparedTickLatencySideEffectsInput {
  readonly latency: TickLatencyPreparationResult;
  readonly history: readonly LatencyMetrics[];
  readonly historyLimit: number;
}

export interface TickLatencyFlowInput extends TickLatencyPreparationInput {
  readonly history: readonly LatencyMetrics[];
  readonly historyLimit: number;
}

export interface PreparedTickLatencySideEffectHandlers {
  readonly resetLatencyBaseline: (observedAt: string, reason: string) => void;
  readonly updateLatencyAverage: (totalLatencyMs: number) => void;
  readonly hydrateMetrics: (metrics: LatencyMetrics) => LatencyMetrics;
  readonly applyLocationLatency: (totalLatencyMs: number, observedAt: string) => void;
  readonly setLatencyHistory: (history: LatencyMetrics[]) => void;
}

export interface NativeHyperliquidMaxLatencyInput {
  readonly transport?: MarketTransport;
  readonly streamId?: string | null;
  readonly dwellirMaxLatencyMs?: string;
  readonly hlStaleAfterMs?: string;
  readonly currentMaxLatencyMs: number;
}

export interface LatencyAverageState {
  readonly averageLatency: number;
  readonly latencySampleCount: number;
}

export function resolveNativeHyperliquidMaxLatencyMs(
  input: NativeHyperliquidMaxLatencyInput
): number {
  const streamKey = input.streamId?.toLowerCase() ?? "";

  if (input.transport === "grpc" || streamKey.startsWith("dwellir-")) {
    return readPositiveNumber(
      input.dwellirMaxLatencyMs ?? input.hlStaleAfterMs,
      DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS
    );
  }

  return readPositiveNumber(
    input.hlStaleAfterMs,
    Math.min(input.currentMaxLatencyMs, DEFAULT_NATIVE_HL_MAX_LATENCY_MS)
  );
}

export function calculateTickLatency(input: TickLatencyInput): LatencyMetrics {
  const sourceTimestamp =
    input.tick.synchronizedExchangeTimestamp ??
    input.tick.providerTimestamp ??
    input.tick.exchangeTimestamp;
  const providerTimestamp = input.tick.providerTimestamp ?? sourceTimestamp;
  const sourceTime = parseTimestampMs(sourceTimestamp, "source_timestamp");
  const rawIngestTime = parseTimestampMs(input.tick.receivedAt, "ingest_timestamp");
  const brainTime = parseTimestampMs(input.brainTimestamp, "brain_timestamp");
  const ingestClockSkewMs = Math.max(0, rawIngestTime - brainTime);
  const ingestTime = ingestClockSkewMs > 0 ? brainTime : rawIngestTime;
  const ingestTimestamp = ingestClockSkewMs > 0 ? input.brainTimestamp : input.tick.receivedAt;
  const networkLatencyMs = Math.max(0, ingestTime - sourceTime);
  const processingLatencyMs = Math.max(0, brainTime - ingestTime);

  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source: input.tick.source,
    sourceExchange: input.tick.source_exchange,
    sourceWeight: input.tick.sourceWeight,
    sequence: input.tick.sequence,
    providerTimestamp,
    sourceTimestamp,
    ingestTimestamp,
    brainTimestamp: input.brainTimestamp,
    clockOffsetMs: input.tick.clockOffsetMs + ingestClockSkewMs,
    networkLatencyMs,
    processingLatencyMs,
    totalLatencyMs: networkLatencyMs + processingLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    status: "FRESH",
    colo: input.location.colo,
    placement: input.location.placement,
    latencyRiskMultiplier: input.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.location.positionSizeMultiplier
  };
}

export function prepareTickLatencyRuntime(
  input: TickLatencyPreparationInput
): TickLatencyPreparationResult {
  const metrics = calculateTickLatency(input);
  const streamId = extractTickStreamId(input.tick);
  const hardStaleDropMs = resolveNativeHyperliquidMaxLatencyMs({
    transport: input.tick.transport,
    streamId,
    dwellirMaxLatencyMs: input.dwellirMaxLatencyMs,
    hlStaleAfterMs: input.hlStaleAfterMs,
    currentMaxLatencyMs: input.currentMaxLatencyMs
  });
  const isHardStale = !input.shadowReplay && metrics.totalLatencyMs > hardStaleDropMs;

  if (isHardStale) {
    return {
      metrics,
      streamId,
      hardStaleDropMs,
      isHardStale,
      shouldResetLatencyBaseline: false,
      shouldUpdateLatencyAverage: false
    };
  }

  const nextMetrics: LatencyMetrics = {
    ...metrics,
    maxLatencyMs: input.currentMaxLatencyMs,
    status:
      !input.shadowReplay && metrics.totalLatencyMs > input.currentMaxLatencyMs ? "STALE" : "FRESH"
  };

  return {
    metrics: nextMetrics,
    streamId,
    hardStaleDropMs,
    isHardStale,
    shouldResetLatencyBaseline:
      !input.shadowReplay &&
      input.averageLatencyMs > hardStaleDropMs &&
      metrics.totalLatencyMs <= hardStaleDropMs,
    shouldUpdateLatencyAverage: nextMetrics.status === "FRESH"
  };
}

export function hydrateLatencyMetricsFromState(
  metrics: LatencyMetrics,
  state: Pick<EngineState, "averageLatency" | "latencySampleCount" | "location">
): LatencyMetrics {
  return {
    ...metrics,
    averageLatencyMs: state.averageLatency,
    sampleCount: state.latencySampleCount,
    latencyRiskMultiplier: state.location.latencyRiskMultiplier,
    positionSizeMultiplier: state.location.positionSizeMultiplier
  };
}

export function appendLatencyHistory(
  history: readonly LatencyMetrics[],
  metrics: LatencyMetrics,
  limit: number
): LatencyMetrics[] {
  return [...history, metrics].slice(-Math.max(1, limit));
}

export function applyPreparedTickLatencySideEffects(
  input: PreparedTickLatencySideEffectsInput,
  handlers: PreparedTickLatencySideEffectHandlers
): TickLatencyPreparationResult {
  if (input.latency.isHardStale) {
    return input.latency;
  }

  if (input.latency.shouldResetLatencyBaseline) {
    handlers.resetLatencyBaseline(
      input.latency.metrics.brainTimestamp,
      "FRESH_SAMPLE_AFTER_BACKLOG"
    );
  }

  if (input.latency.shouldUpdateLatencyAverage) {
    handlers.updateLatencyAverage(input.latency.metrics.totalLatencyMs);
  }

  let metrics = handlers.hydrateMetrics(input.latency.metrics);
  handlers.applyLocationLatency(metrics.totalLatencyMs, metrics.brainTimestamp);
  metrics = handlers.hydrateMetrics(metrics);
  handlers.setLatencyHistory(appendLatencyHistory(input.history, metrics, input.historyLimit));

  return { ...input.latency, metrics };
}

export function prepareTickLatencyFlow(
  input: TickLatencyFlowInput,
  handlers: PreparedTickLatencySideEffectHandlers
): TickLatencyPreparationResult {
  const latency = prepareTickLatencyRuntime(input);

  if (latency.isHardStale) {
    return latency;
  }

  return applyPreparedTickLatencySideEffects(
    {
      latency,
      history: input.history,
      historyLimit: input.historyLimit
    },
    handlers
  );
}

export function nextLatencyAverage(
  previous: LatencyAverageState,
  totalLatencyMs: number
): LatencyAverageState {
  const latencySampleCount = previous.latencySampleCount + 1;
  const nextMean =
    previous.averageLatency + (totalLatencyMs - previous.averageLatency) / latencySampleCount;

  return {
    averageLatency: roundLatency(nextMean),
    latencySampleCount
  };
}

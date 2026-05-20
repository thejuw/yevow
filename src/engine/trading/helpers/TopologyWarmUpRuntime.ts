import type { EdgeTopology, JsonRecord } from "../../../types";

export interface TopologyWarmUpDecisionInput {
  readonly topology: EdgeTopology;
  readonly warmedColo: string | null;
  readonly warmedAt: number;
  readonly intervalMs: number;
  readonly nowMs: number;
}

export interface TopologyWarmUpDecision {
  readonly shouldWarmUp: boolean;
  readonly colo: string;
  readonly warmedAt: number;
}

export interface TopologyWarmUpSideEffectHandlers {
  readonly readEngineState: () => Promise<unknown>;
  readonly fetchConfig: () => Promise<unknown>;
  readonly info: (eventType: "ENGINE_WARMUP", message: string, metadata: JsonRecord) => void;
  readonly error: (
    eventType: "ENGINE_WARMUP_FAILED",
    message: string,
    metadata: JsonRecord
  ) => void;
  readonly schedule: (work: Promise<void>) => void;
}

export interface TopologyWarmUpSideEffectInput {
  readonly topology: EdgeTopology;
  readonly decision: TopologyWarmUpDecision;
}

export interface TopologyWarmUpRuntimeHandlers extends TopologyWarmUpSideEffectHandlers {
  readonly markWarmUp: (colo: string, warmedAtMs: number) => void;
}

export function topologyWarmUpDecision(input: TopologyWarmUpDecisionInput): TopologyWarmUpDecision {
  const colo = input.topology.colo ?? "UNKNOWN";

  return {
    colo,
    warmedAt: input.nowMs,
    shouldWarmUp: input.warmedColo !== colo || input.nowMs - input.warmedAt >= input.intervalMs
  };
}

export function scheduleTopologyWarmUpSideEffects(
  input: TopologyWarmUpSideEffectInput,
  handlers: TopologyWarmUpSideEffectHandlers
): void {
  if (!input.decision.shouldWarmUp) {
    return;
  }

  const warmUp = Promise.all([handlers.readEngineState(), handlers.fetchConfig()])
    .then(() => {
      handlers.info("ENGINE_WARMUP", "Trading engine warm-up completed", {
        colo: input.topology.colo,
        placement: input.topology.placement,
        observedAt: input.topology.observedAt
      });
    })
    .catch((error: unknown) => {
      handlers.error("ENGINE_WARMUP_FAILED", "Trading engine warm-up failed", {
        colo: input.topology.colo,
        placement: input.topology.placement,
        message: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    });

  handlers.schedule(warmUp);
}

export function applyTopologyWarmUpRuntime(
  input: TopologyWarmUpDecisionInput,
  handlers: TopologyWarmUpRuntimeHandlers
): TopologyWarmUpDecision {
  const decision = topologyWarmUpDecision(input);

  if (!decision.shouldWarmUp) {
    return decision;
  }

  handlers.markWarmUp(decision.colo, decision.warmedAt);
  scheduleTopologyWarmUpSideEffects({ topology: input.topology, decision }, handlers);

  return decision;
}

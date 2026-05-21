import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MacroBias,
  MarketTick
} from "../../../types";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import {
  handleTradingEngineAnomalyEmergencyPause,
  type TradingAnomalyEmergencyTarget
} from "../anomaly/TradingAnomalyEmergencyRuntime";
import {
  resolveTradingTickBookForTarget,
  type TradingTickBookTarget
} from "../book/TradingTickBookRuntime";
import {
  observeTradingEngineCascadeAbsorption,
  type TradingCascadeAbsorptionTarget
} from "../cascade/CascadeAbsorptionRuntime";
import { stateAfterFundingTick } from "../funding/FundingRuntime";
import { highResolutionNow } from "../helpers/RuntimeClock";
import {
  handleTradingHardStaleTickDrop,
  handleTradingSoftStaleTick,
  type TradingStaleLatencyTarget
} from "../performance/TradingStaleLatencyRuntime";
import {
  prepareTradingTickLatencyForTarget,
  type TradingTickLatencyTarget
} from "../performance/TradingTickLatencyRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import { evaluateTickTargetPreflight } from "../state/TickPreflightRuntime";
import { resolveTradingTickAvailability } from "../state/TradingAvailabilityRuntime";
import { maybeResumeTradingShadowMode } from "../state/TradingShadowModeAutoResumeRuntime";
import {
  applyAcceptedDecisionPipelineForTarget,
  type AcceptedDecisionPipelineTarget
} from "./AcceptedTickLifecycleRuntime";
import {
  prepareTradingPostBookTickRuntimeForTarget,
  type TradingPostBookTickRuntimeTarget
} from "./PostBookTickRuntime";
import type {
  AcceptedDecisionPipelineInput,
  PostBookTickContext,
  TickBookResolution,
  TickHandlingOptions
} from "./TickPipelineTypes";

export interface PreparedTickLatencyDecision {
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
  readonly isHardStale: boolean;
}

export interface TickHandlingRuntimeInput {
  readonly tick: MarketTick;
  readonly wakeUpTimeMs: number | null;
  readonly options: TickHandlingOptions;
  readonly hotPathStartedAt: number;
  readonly tradingEnabled: boolean;
  readonly shadowModeActive: boolean;
}

export interface TickHandlingRuntimeHandlers {
  readonly maybeAutoResumeShadowMode: (tick: MarketTick, shadowReplay: boolean) => void;
  readonly resolveTradingAvailability: (
    tick: MarketTick,
    shadowReplay: boolean
  ) => TickIngestResult | null;
  readonly rememberLastTickTimestamp: (receivedAt: string) => void;
  readonly observeCascadeAbsorption: (tick: MarketTick) => void;
  readonly prepareTickLatency: (
    tick: MarketTick,
    shadowReplay: boolean
  ) => PreparedTickLatencyDecision;
  readonly handleHardStaleTickDrop: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    streamId: string | null,
    hardStaleDropMs: number
  ) => Promise<TickIngestResult>;
  readonly handleSoftStaleTick: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ) => Promise<TickIngestResult>;
  readonly applyFundingTick: (tick: MarketTick, observedAt: string) => void;
  readonly resolveTickBook: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ) => Promise<TickBookResolution>;
  readonly preparePostBookTickContext: (
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ) => Promise<PostBookTickContext>;
  readonly evaluateAnomaly: (
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: PostBookTickContext["domSnapshot"],
    observedAt: string
  ) => AnomalyDetectionResult;
  readonly nowMs: () => number;
  readonly handleAnomalyEmergencyPause: (
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: PostBookTickContext["domSnapshot"],
    anomalyResult: AnomalyDetectionResult,
    anomalyLogicStartedAt: number,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ) => Promise<TickIngestResult>;
  readonly processAcceptedDecisionPipeline: (input: AcceptedDecisionPipelineInput) => Promise<void>;
}

export interface TradingTickHandlingTarget extends Omit<
  TickHandlingRuntimeHandlers,
  | "rememberLastTickTimestamp"
  | "applyFundingTick"
  | "evaluateAnomaly"
  | "nowMs"
  | "prepareTickLatency"
  | "handleHardStaleTickDrop"
  | "handleSoftStaleTick"
  | "maybeAutoResumeShadowMode"
  | "resolveTradingAvailability"
  | "observeCascadeAbsorption"
  | "resolveTickBook"
  | "preparePostBookTickContext"
  | "handleAnomalyEmergencyPause"
  | "processAcceptedDecisionPipeline"
> {
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly env: Pick<Env, "SHADOW_MODE">;
  engineState: EngineState;
  lastTickTimestamp: string | null;
  readonly anomalyDetector: {
    evaluate(input: {
      readonly tick: MarketTick;
      readonly book: InternalOrderBook;
      readonly dom: PostBookTickContext["domSnapshot"];
      readonly observedAt: string;
    }): AnomalyDetectionResult;
  };
  readonly prepareTickLatency?: TickHandlingRuntimeHandlers["prepareTickLatency"];
  readonly handleHardStaleTickDrop?: TickHandlingRuntimeHandlers["handleHardStaleTickDrop"];
  readonly handleSoftStaleTick?: TickHandlingRuntimeHandlers["handleSoftStaleTick"];
  readonly maybeAutoResumeShadowMode?: TickHandlingRuntimeHandlers["maybeAutoResumeShadowMode"];
  readonly resolveTradingAvailability?: TickHandlingRuntimeHandlers["resolveTradingAvailability"];
  readonly observeCascadeAbsorption?: TickHandlingRuntimeHandlers["observeCascadeAbsorption"];
  readonly resolveTickBook?: TickHandlingRuntimeHandlers["resolveTickBook"];
  readonly preparePostBookTickContext?: TickHandlingRuntimeHandlers["preparePostBookTickContext"];
  readonly handleAnomalyEmergencyPause?: TickHandlingRuntimeHandlers["handleAnomalyEmergencyPause"];
  readonly processAcceptedDecisionPipeline?: TickHandlingRuntimeHandlers["processAcceptedDecisionPipeline"];
}

export async function handleTickRuntime(
  input: TickHandlingRuntimeInput,
  handlers: TickHandlingRuntimeHandlers
): Promise<TickIngestResult> {
  const shadowReplay = input.options.shadowReplay === true;
  const targetPreflight = evaluateTickTargetPreflight({ tick: input.tick, shadowReplay });

  if (targetPreflight.rejection) {
    return targetPreflight.rejection;
  }

  handlers.maybeAutoResumeShadowMode(input.tick, shadowReplay);
  const tradingAvailability = handlers.resolveTradingAvailability(input.tick, shadowReplay);
  if (tradingAvailability) {
    return tradingAvailability;
  }

  handlers.rememberLastTickTimestamp(input.tick.receivedAt);
  handlers.observeCascadeAbsorption(input.tick);

  const { metrics, streamId, hardStaleDropMs, isHardStale } = handlers.prepareTickLatency(
    input.tick,
    shadowReplay
  );

  if (isHardStale) {
    return handlers.handleHardStaleTickDrop(input.tick, metrics, streamId, hardStaleDropMs);
  }

  if (metrics.status === "STALE" && !shadowReplay && input.tradingEnabled) {
    return handlers.handleSoftStaleTick(
      input.tick,
      metrics,
      input.wakeUpTimeMs,
      input.hotPathStartedAt
    );
  }

  handlers.applyFundingTick(input.tick, metrics.brainTimestamp);

  const bookResolution = await handlers.resolveTickBook(
    input.tick,
    metrics,
    input.wakeUpTimeMs,
    input.hotPathStartedAt
  );
  if (bookResolution.kind === "EARLY_RETURN") {
    return bookResolution.result;
  }
  const { book, orderBookUpdateMs } = bookResolution;

  const { volatilitySnapshot, shadowQueueState, domSnapshot } =
    await handlers.preparePostBookTickContext(
      input.tick,
      book,
      metrics.brainTimestamp,
      input.options
    );
  const anomalyLogicStartedAt = handlers.nowMs();
  const anomalyResult = handlers.evaluateAnomaly(
    input.tick,
    book,
    domSnapshot,
    metrics.brainTimestamp
  );

  if (
    anomalyResult.emergencyPause &&
    input.tradingEnabled &&
    !shadowReplay &&
    !input.shadowModeActive
  ) {
    return handlers.handleAnomalyEmergencyPause(
      input.tick,
      book,
      domSnapshot,
      anomalyResult,
      anomalyLogicStartedAt,
      metrics,
      input.wakeUpTimeMs,
      orderBookUpdateMs,
      input.hotPathStartedAt
    );
  }

  await handlers.processAcceptedDecisionPipeline({
    tick: input.tick,
    metrics,
    book,
    domSnapshot,
    volatilitySnapshot,
    shadowQueueState,
    anomalyResult,
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs,
    hotPathStartedAt: input.hotPathStartedAt,
    shadowReplay
  });

  return {
    accepted: true,
    status: metrics.status,
    metrics,
    book
  };
}

export function handleTickForTarget(
  tick: MarketTick,
  wakeUpTimeMs: number | null,
  options: TickHandlingOptions,
  target: TradingTickHandlingTarget
): Promise<TickIngestResult> {
  const hotPathStartedAt = highResolutionNow();
  const latencyOverrides: Partial<
    Pick<
      TickHandlingRuntimeHandlers,
      | "prepareTickLatency"
      | "handleHardStaleTickDrop"
      | "handleSoftStaleTick"
      | "maybeAutoResumeShadowMode"
      | "resolveTradingAvailability"
      | "observeCascadeAbsorption"
      | "resolveTickBook"
      | "preparePostBookTickContext"
      | "handleAnomalyEmergencyPause"
      | "processAcceptedDecisionPipeline"
    >
  > = target;

  return handleTickRuntime(
    {
      tick,
      wakeUpTimeMs,
      options,
      hotPathStartedAt,
      tradingEnabled: target.cachedConfig.TRADING_ENABLED,
      shadowModeActive: isShadowMode(target.env)
    },
    {
      maybeAutoResumeShadowMode: (currentTick, shadowReplay) => {
        if (latencyOverrides.maybeAutoResumeShadowMode) {
          latencyOverrides.maybeAutoResumeShadowMode(currentTick, shadowReplay);
          return;
        }
        maybeAutoResumeShadowModeForTarget(currentTick, shadowReplay, target);
      },
      resolveTradingAvailability: (currentTick, shadowReplay) =>
        latencyOverrides.resolveTradingAvailability
          ? latencyOverrides.resolveTradingAvailability(currentTick, shadowReplay)
          : resolveTradingAvailabilityForTarget(currentTick, shadowReplay, target),
      rememberLastTickTimestamp: (receivedAt) => {
        target.lastTickTimestamp = receivedAt;
      },
      observeCascadeAbsorption: (currentTick) => {
        if (latencyOverrides.observeCascadeAbsorption) {
          latencyOverrides.observeCascadeAbsorption(currentTick);
          return;
        }
        observeTradingEngineCascadeAbsorption(
          currentTick,
          target as unknown as TradingCascadeAbsorptionTarget
        );
      },
      prepareTickLatency: (currentTick, shadowReplay) =>
        latencyOverrides.prepareTickLatency
          ? latencyOverrides.prepareTickLatency(currentTick, shadowReplay)
          : prepareTradingTickLatencyForTarget(
              { tick: currentTick, shadowReplay },
              target as unknown as TradingTickLatencyTarget
            ),
      handleHardStaleTickDrop: (currentTick, metrics, streamId, hardStaleDropMs) =>
        latencyOverrides.handleHardStaleTickDrop
          ? latencyOverrides.handleHardStaleTickDrop(
              currentTick,
              metrics,
              streamId,
              hardStaleDropMs
            )
          : handleTradingHardStaleTickDrop(
              currentTick,
              metrics,
              streamId,
              hardStaleDropMs,
              target as unknown as TradingStaleLatencyTarget
            ),
      handleSoftStaleTick: (currentTick, metrics, wakeUp, startedAt) =>
        latencyOverrides.handleSoftStaleTick
          ? latencyOverrides.handleSoftStaleTick(currentTick, metrics, wakeUp, startedAt)
          : handleTradingSoftStaleTick(
              currentTick,
              metrics,
              wakeUp,
              startedAt,
              target as unknown as TradingStaleLatencyTarget
            ),
      applyFundingTick: (currentTick, observedAt) => {
        const fundingState = stateAfterFundingTick(target.engineState, currentTick, observedAt);
        if (fundingState.changed) {
          target.engineState = fundingState.state;
        }
      },
      resolveTickBook: (currentTick, metrics, wakeUp, startedAt) =>
        latencyOverrides.resolveTickBook
          ? latencyOverrides.resolveTickBook(currentTick, metrics, wakeUp, startedAt)
          : resolveTradingTickBookForTarget(
              {
                tick: currentTick,
                metrics,
                wakeUpTimeMs: wakeUp,
                hotPathStartedAt: startedAt
              },
              target as unknown as TradingTickBookTarget
            ),
      preparePostBookTickContext: (currentTick, book, observedAt, tickOptions) =>
        latencyOverrides.preparePostBookTickContext
          ? latencyOverrides.preparePostBookTickContext(currentTick, book, observedAt, tickOptions)
          : prepareTradingPostBookTickRuntimeForTarget(
              {
                tick: currentTick,
                book,
                observedAt,
                options: tickOptions
              },
              target as unknown as TradingPostBookTickRuntimeTarget
            ),
      evaluateAnomaly: (currentTick, book, domSnapshot, observedAt) =>
        target.anomalyDetector.evaluate({
          tick: currentTick,
          book,
          dom: domSnapshot,
          observedAt
        }),
      nowMs: () => highResolutionNow(),
      handleAnomalyEmergencyPause: (
        currentTick,
        book,
        domSnapshot,
        anomalyResult,
        anomalyStartedAt,
        metrics,
        wakeUp,
        orderBookUpdateMs,
        startedAt
      ) =>
        latencyOverrides.handleAnomalyEmergencyPause
          ? latencyOverrides.handleAnomalyEmergencyPause(
              currentTick,
              book,
              domSnapshot,
              anomalyResult,
              anomalyStartedAt,
              metrics,
              wakeUp,
              orderBookUpdateMs,
              startedAt
            )
          : handleTradingEngineAnomalyEmergencyPause(
              currentTick,
              book,
              domSnapshot,
              anomalyResult,
              anomalyStartedAt,
              metrics,
              wakeUp,
              orderBookUpdateMs,
              startedAt,
              target as unknown as TradingAnomalyEmergencyTarget
            ),
      processAcceptedDecisionPipeline: (pipeline) =>
        latencyOverrides.processAcceptedDecisionPipeline
          ? latencyOverrides.processAcceptedDecisionPipeline(pipeline)
          : applyAcceptedDecisionPipelineForTarget(
              pipeline,
              target as unknown as AcceptedDecisionPipelineTarget
            ).then(() => undefined)
    }
  );
}

type ShadowModeResumeTarget = TradingTickHandlingTarget & {
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Env;
  killSwitchLogged: boolean;
  readonly macroBias: MacroBias;
  readonly logger: {
    warn(eventType: string, message: string, metadata: JsonRecord): void;
  };
  publish(type: "RESUME_QUOTES", payload: JsonRecord): void;
};

type AvailabilityTarget = TradingTickHandlingTarget & {
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Env;
  killSwitchLogged: boolean;
  readonly logger: {
    warn(eventType: string, message: string, metadata: JsonRecord): void;
  };
};

function maybeAutoResumeShadowModeForTarget(
  tick: MarketTick,
  shadowReplay: boolean,
  target: TradingTickHandlingTarget
): void {
  const runtimeTarget = target as unknown as ShadowModeResumeTarget;

  maybeResumeTradingShadowMode(
    {
      tick,
      shadowReplay,
      env: runtimeTarget.env,
      config: runtimeTarget.cachedConfig,
      macroBias: runtimeTarget.macroBias,
      currentState: runtimeTarget.engineState
    },
    {
      applyState: (state) => {
        runtimeTarget.engineState = state;
      },
      clearKillSwitchLogged: () => {
        runtimeTarget.killSwitchLogged = false;
      },
      warnResume: (metadata) => {
        runtimeTarget.logger.warn(
          "SHADOW_MODE_AUTO_RESUME",
          "Shadow mode resumed paper trading after a stale halt",
          metadata
        );
      },
      publishResume: (payload) => {
        runtimeTarget.publish("RESUME_QUOTES", payload);
      }
    }
  );
}

function resolveTradingAvailabilityForTarget(
  tick: MarketTick,
  shadowReplay: boolean,
  target: TradingTickHandlingTarget
): TickIngestResult | null {
  const runtimeTarget = target as unknown as AvailabilityTarget;

  return resolveTradingTickAvailability(
    {
      tick,
      shadowReplay,
      env: runtimeTarget.env,
      config: runtimeTarget.cachedConfig,
      mode: runtimeTarget.engineState.mode,
      killSwitchLogged: runtimeTarget.killSwitchLogged
    },
    {
      warn: (event) => {
        runtimeTarget.logger.warn(event.eventType, event.message, event.metadata);
      },
      setKillSwitchLogged: (logged) => {
        runtimeTarget.killSwitchLogged = logged;
      }
    }
  );
}

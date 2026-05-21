import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { AgentSignal, GlobalRiskConfig, ProfilerState } from "../../../types";
import {
  applyProfilerSignalSideEffects,
  emitAmVpinTelemetry,
  emitProfilerAlertTelemetry,
  type ProfilerTelemetryEvent
} from "./ProfilerTelemetryRuntime";
import {
  acceptTradingAgentSignalForTarget,
  type TradingSignalBusTarget
} from "./TradingSignalBusRuntime";

export interface TradingProfilerTelemetryHandlers {
  readonly publish: (
    type: ProfilerTelemetryEvent["telemetryType"],
    payload: ProfilerTelemetryEvent["payload"],
    correlationId: string
  ) => void;
}

export interface TradingProfilerSignalTarget {
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  acceptAgentSignal?(signal: AgentSignal, latencyMs: number): Promise<void>;
  cancelAllQuotes(instrumentCode: string, reason: "PROFILER_ALERT"): Promise<void>;
}

export function publishTradingProfilerAlert(
  signal: AgentSignal,
  profilerState: ProfilerState,
  handlers: TradingProfilerTelemetryHandlers
): void {
  emitProfilerAlertTelemetry(signal, profilerState, handlers);
}

export function publishTradingAmVpinTelemetry(
  profilerState: ProfilerState,
  instrumentCode: string,
  observedAt: string,
  handlers: TradingProfilerTelemetryHandlers
): void {
  emitAmVpinTelemetry(profilerState, instrumentCode, observedAt, handlers);
}

export async function handleTradingProfilerSignal(
  instrumentCode: string,
  profilerResult: ProfilerEvaluation,
  profilerLatencyMs: number,
  isProfilerQuoteHalt: boolean,
  shadowReplay: boolean,
  croupierHasQuote: boolean,
  target: TradingProfilerSignalTarget
): Promise<void> {
  if (!profilerResult.signal) {
    return;
  }

  await applyProfilerSignalSideEffects(
    {
      signal: profilerResult.signal,
      profilerState: profilerResult.state,
      latencyMs: profilerLatencyMs,
      instrumentCode,
      profilerQuoteHalt: isProfilerQuoteHalt,
      shadowReplay,
      tradingEnabled: target.cachedConfig.TRADING_ENABLED,
      croupierHasQuote
    },
    {
      publishAlert: (signal, profilerState) => {
        publishTradingProfilerAlert(signal, profilerState, {
          publish: (type, payload, correlationId) => {
            target.publish(type, payload, correlationId);
          }
        });
      },
      acceptSignal: (signal, latencyMs) =>
        target.acceptAgentSignal
          ? target.acceptAgentSignal(signal, latencyMs)
          : acceptTradingAgentSignalForTarget(
              signal,
              latencyMs,
              target as unknown as TradingSignalBusTarget
            ),
      cancelQuotes: (code, reason) => {
        target.state.waitUntil(target.cancelAllQuotes(code, reason));
      }
    }
  );
}

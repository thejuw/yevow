import type { EngineState } from "../../../types";
import { aggregateQuoteState, resumeExpiredAssetQuoteStates } from "../state/AssetStateRuntime";

export interface ResumeExpiredQuoteStatesInput {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly observedAt: string;
}

export interface ResumeExpiredQuoteStatesResult {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly changed: boolean;
}

export interface ResumeExpiredQuoteStatesSideEffectInput {
  readonly currentState: EngineState;
  readonly observedAt: string;
}

export interface ResumeExpiredQuoteStatesSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly publishResume: (payload: Record<string, unknown>) => void;
}

export function resumeExpiredQuoteStates(
  input: ResumeExpiredQuoteStatesInput
): ResumeExpiredQuoteStatesResult {
  const nextAssetQuoteStates = resumeExpiredAssetQuoteStates(
    input.assetQuoteStates,
    input.observedAt
  );
  const nextAggregate = aggregateQuoteState(
    nextAssetQuoteStates,
    input.quoteState,
    input.observedAt
  );
  const assetStatesChanged = quoteAssetStatesChanged(input.assetQuoteStates, nextAssetQuoteStates);
  const aggregateExpired =
    input.quoteState.status === "SUSPENDED" &&
    Boolean(input.quoteState.suspendedUntil) &&
    Date.parse(input.quoteState.suspendedUntil ?? "") <= Date.parse(input.observedAt);
  const changed =
    assetStatesChanged ||
    nextAggregate.status !== input.quoteState.status ||
    nextAggregate.reason !== input.quoteState.reason ||
    aggregateExpired;

  return {
    assetQuoteStates: nextAssetQuoteStates,
    quoteState: nextAggregate,
    changed
  };
}

export function applyResumeExpiredQuoteStatesSideEffects(
  input: ResumeExpiredQuoteStatesSideEffectInput,
  handlers: ResumeExpiredQuoteStatesSideEffectHandlers
): ResumeExpiredQuoteStatesResult {
  const next = resumeExpiredQuoteStates({
    assetQuoteStates: input.currentState.assetQuoteStates,
    quoteState: input.currentState.quoteState,
    observedAt: input.observedAt
  });

  if (next.changed) {
    handlers.applyState({
      ...input.currentState,
      quoteState: next.quoteState,
      assetQuoteStates: next.assetQuoteStates
    });
    handlers.publishResume({ observedAt: input.observedAt });
  }

  return next;
}

function quoteAssetStatesChanged(
  previous: EngineState["assetQuoteStates"],
  next: EngineState["assetQuoteStates"]
): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const key of keys) {
    if (
      previous[key]?.status !== next[key]?.status ||
      previous[key]?.reason !== next[key]?.reason ||
      previous[key]?.suspendedUntil !== next[key]?.suspendedUntil
    ) {
      return true;
    }
  }

  return false;
}

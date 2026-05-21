import type { QuoteSignal } from "../../../types";
import { quoteToTelemetry } from "../execution/ExecutionRuntimeHelpers";
import {
  dispatchTradingQuoteForTarget,
  type TradingQuoteDispatchTarget
} from "./TradingQuoteDispatchRuntime";

export interface CroupierQuoteActionInput {
  readonly instrumentCode: string;
  readonly pullAllQuotes: boolean;
  readonly quote: QuoteSignal | null;
  readonly strategyQuoteDisableReason: string | null;
  readonly adverseSelectionCost: number;
  readonly minEvThreshold: number;
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
  readonly profilerQuoteHalt: boolean;
  readonly cascadeShield: boolean;
}

export type CroupierQuoteAction =
  | {
      readonly kind: "PULL_ALL_QUOTES";
      readonly publish: {
        readonly type: "PULL_ALL_QUOTES";
        readonly payload: Record<string, unknown>;
      };
      readonly cancelReason: "ADVERSE_SELECTION_CRITICAL" | null;
    }
  | {
      readonly kind: "POST_QUOTE";
      readonly quote: QuoteSignal;
      readonly publish: {
        readonly type: "POST_QUOTE";
        readonly payload: Record<string, unknown>;
        readonly correlationId: string;
      };
      readonly shouldDispatch: boolean;
      readonly cascadeShieldCancelReason: "CASCADE_SHIELD" | null;
    }
  | {
      readonly kind: "NONE";
    };

export interface CroupierQuoteActionSideEffectHandlers {
  readonly publish: (
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ) => void;
  readonly schedule: (work: Promise<void>) => void;
  readonly cancelAllQuotes: (instrumentCode: string, reason: string) => Promise<void>;
  readonly dispatchQuote: (quote: QuoteSignal) => Promise<void>;
}

export interface TradingCroupierQuoteActionTarget {
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  cancelAllQuotes(instrumentCode: string, reason: string): Promise<void>;
  dispatchQuote?(quote: QuoteSignal): Promise<void>;
}

export function buildCroupierQuoteAction(input: CroupierQuoteActionInput): CroupierQuoteAction {
  if (input.pullAllQuotes) {
    return {
      kind: "PULL_ALL_QUOTES",
      publish: {
        type: "PULL_ALL_QUOTES",
        payload: {
          instrumentCode: input.instrumentCode,
          adverseSelectionCost: input.adverseSelectionCost,
          minEvThreshold: input.minEvThreshold
        }
      },
      cancelReason:
        !input.shadowReplay && input.tradingEnabled ? "ADVERSE_SELECTION_CRITICAL" : null
    };
  }

  if (!input.quote || input.strategyQuoteDisableReason) {
    return { kind: "NONE" };
  }

  return {
    kind: "POST_QUOTE",
    quote: input.quote,
    publish: {
      type: "POST_QUOTE",
      payload: quoteToTelemetry(input.quote),
      correlationId: input.quote.signalId
    },
    shouldDispatch: !input.shadowReplay && input.tradingEnabled && !input.profilerQuoteHalt,
    cascadeShieldCancelReason: input.cascadeShield ? "CASCADE_SHIELD" : null
  };
}

export function dispatchCroupierQuoteActionSideEffects(
  instrumentCode: string,
  action: CroupierQuoteAction,
  handlers: CroupierQuoteActionSideEffectHandlers
): void {
  if (action.kind === "PULL_ALL_QUOTES") {
    handlers.publish(action.publish.type, action.publish.payload);
    if (action.cancelReason) {
      handlers.schedule(handlers.cancelAllQuotes(instrumentCode, action.cancelReason));
    }
    return;
  }

  if (action.kind !== "POST_QUOTE") {
    return;
  }

  handlers.publish(action.publish.type, action.publish.payload, action.publish.correlationId);

  if (!action.shouldDispatch) {
    return;
  }

  handlers.schedule(
    action.cascadeShieldCancelReason
      ? handlers
          .cancelAllQuotes(instrumentCode, action.cascadeShieldCancelReason)
          .then(() => handlers.dispatchQuote(action.quote))
      : handlers.dispatchQuote(action.quote)
  );
}

export function dispatchTradingCroupierQuoteAction(
  instrumentCode: string,
  croupierQuoteAction: CroupierQuoteAction,
  target: TradingCroupierQuoteActionTarget
): void {
  dispatchCroupierQuoteActionSideEffects(instrumentCode, croupierQuoteAction, {
    publish: (type, payload, correlationId) => {
      target.publish(type, payload, correlationId);
    },
    schedule: (work) => {
      target.state.waitUntil(work);
    },
    cancelAllQuotes: (code, reason) => target.cancelAllQuotes(code, reason),
    dispatchQuote: (quote) =>
      target.dispatchQuote
        ? target.dispatchQuote(quote)
        : dispatchTradingQuoteForTarget(quote, target as unknown as TradingQuoteDispatchTarget)
  });
}

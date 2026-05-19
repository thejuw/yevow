import type {
  DomAnalysisSnapshot,
  EngineMode,
  EngineState,
  InternalOrderBook,
  GlobalRiskConfig,
  LatencyStatus,
  ManagedOrder
} from "../../../types";
import { microstructureFromBook } from "../book/BookReconstruction";

export interface TickPreflightModeInput {
  readonly shadowReplay: boolean;
  readonly shadowMode: boolean;
  readonly tradingEnabled: boolean;
  readonly mode: EngineMode;
}

export interface ShadowModeAutoResumeInput {
  readonly currentState: EngineState;
  readonly normalizedBankroll: EngineState["bankroll"];
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly observedAt: string;
}

export interface AcceptedTickStateInput {
  readonly currentState: EngineState;
  readonly tradingEnabled: boolean;
  readonly shadowReplay: boolean;
  readonly latencyStatus: LatencyStatus;
  readonly internalOrderBookDepth: number;
  readonly book: InternalOrderBook;
  readonly oracle: EngineState["oracle"];
  readonly sentiment: EngineState["sentiment"];
  readonly ensemble: EngineState["ensemble"];
  readonly leadLag: EngineState["leadLag"];
  readonly inventory: EngineState["inventory"];
  readonly riskMetrics: EngineState["riskMetrics"];
  readonly quoteState: EngineState["quoteState"];
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly shadowQueue: EngineState["shadowQueue"];
  readonly lastTradeIntent: EngineState["lastTradeIntent"];
  readonly inventoryGuard: EngineState["inventoryGuard"];
  readonly ordersToTrack: ManagedOrder[];
  readonly shouldTrackOrders: boolean;
  readonly dom: DomAnalysisSnapshot;
  readonly anomaly: EngineState["anomaly"];
  readonly assetMatrix: EngineState["assetMatrix"];
  readonly profilerStates: EngineState["profilerStates"];
  readonly toxicityScore: number;
  readonly agentHealth: EngineState["agentHealth"];
  readonly maxLatencyMs: number;
  readonly observedAt: string;
}

export function shouldAutoResumeShadowMode(input: TickPreflightModeInput): boolean {
  return !input.shadowReplay && input.shadowMode && input.tradingEnabled && input.mode === "HALTED";
}

export function shouldBlockHaltedTrading(input: TickPreflightModeInput): boolean {
  return !input.shadowReplay && input.mode === "HALTED" && input.tradingEnabled;
}

export function shouldLogDisabledTrading(input: {
  readonly shadowReplay: boolean;
  readonly tradingEnabled: GlobalRiskConfig["TRADING_ENABLED"];
  readonly killSwitchLogged: boolean;
}): boolean {
  return !input.shadowReplay && !input.tradingEnabled && !input.killSwitchLogged;
}

export function stateAfterShadowModeAutoResume(input: ShadowModeAutoResumeInput): EngineState {
  return {
    ...input.currentState,
    mode: "PAPER",
    bankroll: input.normalizedBankroll,
    risk: {
      ...input.currentState.risk,
      killSwitch: false,
      updatedAt: input.observedAt
    },
    quoteState: input.quoteState,
    assetQuoteStates: input.assetQuoteStates,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

export function stateAfterAcceptedTick(input: AcceptedTickStateInput): EngineState {
  return {
    ...input.currentState,
    mode:
      !input.tradingEnabled && input.currentState.mode === "HALTED"
        ? "PAPER"
        : input.currentState.mode,
    processedTicks: input.currentState.processedTicks + 1,
    staleTickCount:
      input.latencyStatus === "STALE" && !input.shadowReplay
        ? input.currentState.staleTickCount + 1
        : input.currentState.staleTickCount,
    internalOrderBookDepth: input.internalOrderBookDepth,
    microstructure: microstructureFromBook(input.book),
    oracle: input.oracle,
    sentiment: input.sentiment,
    ensemble: input.ensemble,
    leadLag: input.leadLag,
    inventory: input.inventory,
    current_inventory_delta: input.inventory.current_inventory_delta,
    riskMetrics: input.riskMetrics,
    risk: {
      ...input.currentState.risk,
      killSwitch: !input.riskMetrics.isTradingEnabled,
      updatedAt: input.observedAt
    },
    quoteState: input.quoteState,
    assetQuoteStates: input.assetQuoteStates,
    shadowQueue: input.shadowQueue,
    lastTradeIntent: input.lastTradeIntent,
    inventoryGuard: input.inventoryGuard,
    orderMap: input.shouldTrackOrders
      ? {
          ...input.currentState.orderMap,
          ...Object.fromEntries(input.ordersToTrack.map((order) => [order.clientId, order]))
        }
      : input.currentState.orderMap,
    dom: input.dom,
    anomaly: input.anomaly,
    liquidationHeatmap: input.currentState.liquidationHeatmap,
    assetMatrix: input.assetMatrix,
    profilerStates: input.profilerStates,
    toxicityScore: input.toxicityScore,
    agentHealth: input.agentHealth,
    maxLatencyMs: input.maxLatencyMs,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

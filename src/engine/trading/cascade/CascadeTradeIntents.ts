import type { EngineState, GlobalRiskConfig, TradeIntent } from "../../../types";
import type { CascadePositionIntent, CascadeRecoverySignal } from "../../../strategy/cascade/types";
import { cascadeAssetProfileFromConfig } from "./CascadeConfigRuntime";

export interface CascadeEntryTradeIntentInput {
  readonly signal: CascadeRecoverySignal;
  readonly size: number;
  readonly observedAt: string;
  readonly engineId: string;
  readonly exchangeFeeBps: number;
  readonly sliceNotionalThresholdUsd: number;
  readonly maxSlippageBps: number;
}

export function buildCascadeEntryTradeIntent(input: CascadeEntryTradeIntentInput): TradeIntent {
  const action = input.signal.direction === "LONG" ? "BUY" : "SELL";
  const notional = input.size * input.signal.entryPrice;
  const executionStyle = notional > input.sliceNotionalThresholdUsd ? "SLICED_TWAP" : "TAKER_IOC";

  return {
    schemaVersion: "trade-intent.v1",
    intentId: `cascade-entry-${input.signal.signalId}`,
    traceId: `${input.engineId}:cascade-entry:${input.signal.signalId}`,
    instrumentCode: input.signal.instrumentCode,
    marketKey: `hyperliquid:${input.signal.instrumentCode}`,
    source_exchange: "hyperliquid",
    direction: input.signal.direction,
    executionStyle,
    action,
    orderType: "IOC",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: input.signal.entryPrice,
    expectedPrice: input.signal.entryPrice,
    requestedSize: input.size,
    approvedSize: input.size,
    probabilityWin: input.signal.confidence,
    probabilityLoss: Math.max(0, 1 - input.signal.confidence),
    profit: input.signal.rDistance * 2,
    loss: input.signal.rDistance,
    executionCosts: input.exchangeFeeBps / 10_000,
    adverseSelectionCost: 0,
    expectedValue:
      input.signal.confidence * input.signal.rDistance * 2 -
      (1 - input.signal.confidence) * input.signal.rDistance,
    minEvThreshold: 0,
    maxSlippageBps: input.maxSlippageBps,
    confidence: input.signal.confidence,
    rationale: `cascade recovery ${input.signal.triggerType} ${input.signal.cascadeId}`,
    createdAt: input.observedAt
  };
}

export interface TradingCascadeTradeIntentTarget {
  readonly engineState: Pick<EngineState, "engineId">;
  readonly cachedConfig: GlobalRiskConfig;
}

export function buildCascadeEntryTradeIntentForTarget(
  target: TradingCascadeTradeIntentTarget,
  signal: CascadeRecoverySignal,
  size: number,
  observedAt: string
): TradeIntent {
  return buildCascadeEntryTradeIntent({
    signal,
    size,
    observedAt,
    engineId: target.engineState.engineId,
    exchangeFeeBps: target.cachedConfig.EXCHANGE_FEE_BPS,
    sliceNotionalThresholdUsd: target.cachedConfig.SLICE_NOTIONAL_THRESHOLD_USD,
    maxSlippageBps: cascadeAssetProfileFromConfig(signal.instrumentCode, target.cachedConfig)
      .maxSlippageBps
  });
}

export interface CascadeExitTradeIntentInput {
  readonly intent: CascadePositionIntent;
  readonly observedAt: string;
  readonly engineId: string;
  readonly exchangeFeeBps: number;
  readonly maxSlippageBps: number;
}

export function buildCascadeExitTradeIntent(input: CascadeExitTradeIntentInput): TradeIntent {
  const isStop = input.intent.executionStyle === "TAKER_MARKET";

  return {
    schemaVersion: "trade-intent.v1",
    intentId: `cascade-exit-${input.intent.intentId}`,
    traceId: `${input.engineId}:cascade-exit:${input.intent.positionId}`,
    instrumentCode: input.intent.instrumentCode,
    marketKey: `hyperliquid:${input.intent.instrumentCode}`,
    source_exchange: "hyperliquid",
    direction: input.intent.action === "BUY" ? "LONG" : "SHORT",
    executionStyle: input.intent.executionStyle,
    action: input.intent.action,
    orderType: isStop ? "MARKET" : "IOC",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: input.intent.referencePrice,
    expectedPrice: input.intent.referencePrice,
    requestedSize: input.intent.size,
    approvedSize: input.intent.size,
    probabilityWin: 1,
    probabilityLoss: 0,
    profit: 0,
    loss: 0,
    executionCosts: input.exchangeFeeBps / 10_000,
    adverseSelectionCost: 0,
    expectedValue: 0,
    minEvThreshold: 0,
    maxSlippageBps: input.maxSlippageBps,
    confidence: 1,
    rationale: `cascade ${input.intent.closeReason ?? "close"} ${
      isStop ? "stop_loss" : "partial"
    } reduce-only`,
    createdAt: input.observedAt
  };
}

export function buildCascadeExitTradeIntentForTarget(
  target: TradingCascadeTradeIntentTarget,
  intent: CascadePositionIntent,
  observedAt: string
): TradeIntent {
  return buildCascadeExitTradeIntent({
    intent,
    observedAt,
    engineId: target.engineState.engineId,
    exchangeFeeBps: target.cachedConfig.EXCHANGE_FEE_BPS,
    maxSlippageBps: cascadeAssetProfileFromConfig(intent.instrumentCode, target.cachedConfig)
      .maxSlippageBps
  });
}

import type { CamouflageResult } from "../../../utils/Camouflage";
import type { SorPlan } from "../../../utils/SOR";
import {
  isQuoteSuspendedAt,
  quoteStateForInstrumentState
} from "../../../TradingEngineRuntimeHelpers";
import type { EngineState, JsonRecord, ManagedOrder, TradeIntent } from "../../../types";

export interface ExecutionPlanArtifactsInput {
  readonly camouflage: CamouflageResult;
  readonly sorPlan: SorPlan;
  readonly observedAt: string;
  readonly ackTimeoutMs: number;
}

export interface ExecutionPlanArtifacts {
  readonly camouflage: CamouflageResult;
  readonly orders: ManagedOrder[];
}

export interface ExecutionPlanQuoteGateInput {
  readonly intent: TradeIntent | null;
  readonly riskState: EngineState;
  readonly observedAt: string;
  readonly bypassQuoteSuspension?: boolean;
}

export interface SorResidualLogInput {
  readonly intent: TradeIntent;
  readonly unfilledSize: number;
}

export function buildExecutionPlanArtifacts(
  input: ExecutionPlanArtifactsInput
): ExecutionPlanArtifacts {
  const executionChildren = executionChildrenFromRoutePlan(input.camouflage, input.sorPlan);
  const routedCamouflage: CamouflageResult = {
    ...input.camouflage,
    icebergChunks: executionChildren
  };
  const ackDeadlineAt = executionAckDeadline(input.observedAt, input.ackTimeoutMs);

  return {
    camouflage: routedCamouflage,
    orders: buildManagedOrders({
      parentIntentId: input.camouflage.intent.intentId,
      chunks: routedCamouflage.icebergChunks,
      observedAt: input.observedAt,
      ackDeadlineAt
    })
  };
}

export function shouldSkipExecutionPlanForQuoteSuspension(
  input: ExecutionPlanQuoteGateInput
): boolean {
  if (!input.intent || input.bypassQuoteSuspension) {
    return false;
  }

  return isQuoteSuspendedAt(
    quoteStateForInstrumentState(
      input.riskState.assetQuoteStates,
      input.intent.instrumentCode,
      input.riskState.quoteState
    ),
    input.observedAt
  );
}

export function sorResidualLiquidityShortfallLogMetadata(input: SorResidualLogInput): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    approvedSize: input.intent.approvedSize ?? input.intent.requestedSize,
    unfilledSize: input.unfilledSize
  };
}

export function executionChildrenFromRoutePlan(
  camouflage: CamouflageResult,
  sorPlan: SorPlan
): TradeIntent[] {
  if (sorPlan.routes.length === 0) {
    return camouflage.icebergChunks;
  }

  return sorPlan.routes.map((route, index) => ({
    ...camouflage.intent,
    intentId: `${camouflage.intent.intentId}:sor:${index + 1}`,
    marketKey: route.marketKey,
    source_exchange: route.source_exchange,
    intendedPrice: route.expectedPrice,
    expectedPrice: route.expectedPrice,
    requestedSize: route.size,
    approvedSize: route.size,
    rationale: `${camouflage.intent.rationale}; SOR child ${index + 1}/${sorPlan.routes.length}`
  }));
}

export interface ManagedOrdersInput {
  readonly parentIntentId: string;
  readonly chunks: readonly TradeIntent[];
  readonly observedAt: string;
  readonly ackDeadlineAt: string;
}

export function buildManagedOrders(input: ManagedOrdersInput): ManagedOrder[] {
  return input.chunks.map((chunk) => ({
    clientId: chunk.intentId,
    exchangeOrderId: null,
    intentId: input.parentIntentId,
    instrumentCode: chunk.instrumentCode,
    side: chunk.action,
    price: chunk.expectedPrice,
    size: chunk.approvedSize ?? chunk.requestedSize,
    filledSize: 0,
    status: "PENDING",
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
    ackDeadlineAt: input.ackDeadlineAt
  }));
}

export function executionAckDeadline(observedAt: string, ackTimeoutMs: number): string {
  return new Date(Date.parse(observedAt) + ackTimeoutMs).toISOString();
}

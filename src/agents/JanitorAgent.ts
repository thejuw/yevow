import type { JanitorState, ManagedOrder, Position } from "../types";

export interface JanitorInput {
  orderMap: Record<string, ManagedOrder>;
  positions: Record<string, Position>;
  observedAt: string;
  ackTimeoutMs: number;
  dustThreshold: number;
}

export class JanitorAgent {
  run(input: JanitorInput): JanitorState {
    const nowMs = Date.parse(input.observedAt);
    const zombieOrders = Object.values(input.orderMap)
      .filter(
        (order) =>
          order.status === "PENDING" &&
          nowMs - Date.parse(order.createdAt) > input.ackTimeoutMs
      )
      .map((order) => order.clientId);
    const dustPositions = Object.values(input.positions)
      .filter((position) => Math.abs(position.quantity) > 0 && Math.abs(position.quantity) < input.dustThreshold)
      .map((position) => position.instrumentCode);

    return {
      lastRunAt: input.observedAt,
      zombieOrders,
      orphanExchangeOrders: [],
      reconciledOrders: [],
      cancelledOrders: [],
      dustPositions,
      dustCloseIntents: [],
      prunedTelemetryCount: 0,
      updatedAt: input.observedAt
    };
  }
}

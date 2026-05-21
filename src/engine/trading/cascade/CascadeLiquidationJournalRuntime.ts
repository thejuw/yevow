import type { LiquidationEvent } from "../../../strategy/cascade/types";

export interface CascadeLiquidationJournalDb {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface CascadeLiquidationJournalFailureHandlers {
  readonly handleFailure: (reason: "CASCADE_LIQUIDATION_JOURNAL", error: unknown) => void;
}

export function cascadeLiquidationInsertStatements(
  db: CascadeLiquidationJournalDb,
  events: readonly LiquidationEvent[]
): D1PreparedStatement[] {
  return events.map((event) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO cascade_liquidations (
           event_id, instrument_code, source_exchange, side, forced_flow_side, price,
           notional_usd, base_size, exchange_timestamp, observed_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.instrumentCode,
        event.sourceExchange,
        event.side,
        event.forcedFlowSide,
        event.price,
        event.notionalUsd,
        event.baseSize,
        event.exchangeTimestamp,
        event.observedAt,
        JSON.stringify(event.raw)
      )
  );
}

export async function persistCascadeLiquidationEvents(
  db: CascadeLiquidationJournalDb,
  events: readonly LiquidationEvent[]
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await db.batch(cascadeLiquidationInsertStatements(db, events));
}

export async function persistCascadeLiquidationEventsSafely(
  db: CascadeLiquidationJournalDb,
  events: readonly LiquidationEvent[],
  handlers: CascadeLiquidationJournalFailureHandlers
): Promise<void> {
  try {
    await persistCascadeLiquidationEvents(db, events);
  } catch (error) {
    handlers.handleFailure("CASCADE_LIQUIDATION_JOURNAL", error);
  }
}

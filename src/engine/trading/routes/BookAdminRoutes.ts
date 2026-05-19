import type {
  BookSnapshotResponse,
  DomAnalysisSnapshot,
  EngineState,
  LiquidationHeatmapState,
  OrderBookDelta,
  OrderBookResetRequest,
  OrderBookSnapshot,
  OrderBookSnapshotLevel
} from "../../../types";
import type { AppliedBookUpdate } from "../book/BookTypes";
import { clampInteger, json, readJsonOrNull } from "./RouteUtils";

export interface BookAdminRouteContext {
  maxSnapshotDepth: number;
  getEngineState(): EngineState;
  currentBookSnapshot(instrumentCode: string | undefined, depth: number): BookSnapshotResponse;
  currentDomHeatmap(instrumentCode: string | undefined): DomAnalysisSnapshot;
  currentLiquidationHeatmap(): LiquidationHeatmapState;
  applySnapshot(snapshot: OrderBookSnapshot): Promise<unknown>;
  applyDelta(delta: OrderBookDelta, observedAt: string): Promise<AppliedBookUpdate>;
  enqueueOrderBookReset(payload: Partial<OrderBookResetRequest>): Promise<unknown>;
  registerIngestConnection(payload: Partial<OrderBookResetRequest>): unknown;
}

export async function handleBookAdminRoute(
  request: Request,
  url: URL,
  context: BookAdminRouteContext
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/book/snapshot") {
    const instrumentCode =
      url.searchParams.get("instrumentCode") ?? url.searchParams.get("instrument") ?? undefined;
    const depth = clampInteger(
      url.searchParams.get("depth"),
      context.maxSnapshotDepth,
      1,
      context.maxSnapshotDepth
    );

    return json(context.currentBookSnapshot(instrumentCode, depth));
  }

  if (request.method === "GET" && url.pathname === "/dom/heatmap") {
    const instrumentCode =
      url.searchParams.get("instrumentCode") ?? url.searchParams.get("instrument") ?? undefined;

    return json(context.currentDomHeatmap(instrumentCode));
  }

  if (request.method === "GET" && url.pathname === "/liquidations/heatmap") {
    return json({
      ok: true,
      heatmap: context.currentLiquidationHeatmap()
    });
  }

  if (request.method === "POST" && url.pathname === "/book/snapshot") {
    const snapshot = assertOrderBookSnapshot(await request.json<OrderBookSnapshot>());
    await context.applySnapshot(snapshot);
    return json({
      ok: true,
      snapshot: context.currentBookSnapshot(snapshot.instrumentCode, context.maxSnapshotDepth)
    });
  }

  if (request.method === "POST" && url.pathname === "/book/delta") {
    const delta = assertOrderBookDelta(await request.json<OrderBookDelta>());
    const applied = await context.applyDelta(delta, new Date().toISOString());

    return json(
      {
        ok: applied.accepted,
        accepted: applied.accepted,
        reason: applied.reason,
        timeToBookMs: applied.timeToBookMs,
        book: applied.book ?? null
      },
      applied.accepted ? 200 : 409
    );
  }

  if (request.method === "POST" && url.pathname === "/reset-book") {
    const payload = (await readJsonOrNull<Partial<OrderBookResetRequest>>(request)) ?? {};
    await context.enqueueOrderBookReset(payload);
    return json({ ok: true, state: context.getEngineState() });
  }

  if (request.method === "POST" && url.pathname === "/ingest/connection") {
    const payload = (await readJsonOrNull<Partial<OrderBookResetRequest>>(request)) ?? {};
    const registration = context.registerIngestConnection(payload);
    return json({ ok: true, registration, state: context.getEngineState() });
  }

  return null;
}

export function assertOrderBookSnapshot(value: OrderBookSnapshot): OrderBookSnapshot {
  if (
    typeof value?.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Array.isArray(value.bids) ||
    !Array.isArray(value.asks) ||
    !value.bids.every(isValidSnapshotLevel) ||
    !value.asks.every(isValidSnapshotLevel)
  ) {
    throw new Error("INVALID_ORDER_BOOK_SNAPSHOT");
  }

  return value;
}

export function assertOrderBookDelta(value: OrderBookDelta): OrderBookDelta {
  if (
    typeof value?.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.exchangeTimestamp !== "string" ||
    typeof value.receivedAt !== "string" ||
    (value.side !== "bid" && value.side !== "ask") ||
    typeof value.price !== "number" ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0
  ) {
    throw new Error("INVALID_ORDER_BOOK_DELTA");
  }

  return value;
}

function isValidSnapshotLevel(level: OrderBookSnapshotLevel): boolean {
  return (
    typeof level?.price === "number" &&
    Number.isFinite(level.price) &&
    level.price >= 0 &&
    typeof level.size === "number" &&
    Number.isFinite(level.size) &&
    level.size >= 0
  );
}

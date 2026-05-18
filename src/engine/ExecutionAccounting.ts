import type {
  AgentName,
  EngineState,
  ExecutionReport,
  JsonRecord,
  JsonValue,
  ManagedOrder,
  Position,
  SlippagePoint,
  TradeExecution,
  TradeIntent
} from "../types";

export interface ExecutionAccountingInput {
  state: EngineState;
  report: ExecutionReport;
  markPrice: (instrumentCode: string, fallback: number) => number;
  observedAt?: string;
}

export interface ExecutionAccountingResult {
  bankroll: EngineState["bankroll"];
  openPositions: EngineState["openPositions"];
  orderMap: EngineState["orderMap"];
  slippage: EngineState["slippage"];
  order: ManagedOrder;
  slippagePoint: SlippagePoint;
  tradeExecution: TradeExecution;
  fillIncrementSize: number;
  realizedPnlDelta: number;
  observedAt: string;
}

export function applyExecutionAccounting(
  input: ExecutionAccountingInput
): ExecutionAccountingResult {
  const { state, report, markPrice } = input;
  const observedAt = input.observedAt ?? report.observedAt ?? new Date().toISOString();
  const existing =
    state.orderMap[report.clientId] ??
    Object.values(state.orderMap).find(
      (order) => report.exchangeOrderId && order.exchangeOrderId === report.exchangeOrderId
    );
  const previousFilledSize = existing?.filledSize ?? 0;
  const cumulativeFilledSize =
    typeof report.filledSize === "number" && Number.isFinite(report.filledSize)
      ? Math.max(0, report.filledSize)
      : previousFilledSize;
  const fillIncrementSize =
    typeof report.fillIncrementSize === "number" && Number.isFinite(report.fillIncrementSize)
      ? Math.max(0, report.fillIncrementSize)
      : Math.max(0, cumulativeFilledSize - previousFilledSize);
  const order: ManagedOrder = {
    ...(existing ?? {
      clientId: report.clientId,
      exchangeOrderId: report.exchangeOrderId ?? null,
      intentId: report.clientId,
      instrumentCode: report.instrumentCode ?? state.lastTradeIntent?.instrumentCode ?? "unknown",
      side: report.side ?? state.lastTradeIntent?.action ?? "BUY",
      price: report.expectedPrice ?? report.achievedPrice ?? 0,
      size: report.orderSize ?? report.filledSize ?? 0,
      filledSize: 0,
      status: "PENDING",
      createdAt: observedAt,
      updatedAt: observedAt,
      ackDeadlineAt: observedAt
    }),
    exchangeOrderId: report.exchangeOrderId ?? existing?.exchangeOrderId ?? null,
    status: report.status,
    filledSize: cumulativeFilledSize,
    updatedAt: observedAt
  };
  const slippagePoint = buildSlippagePoint(report, order);
  const portfolio =
    isPortfolioFillStatus(report.status) && fillIncrementSize > 0
      ? applyFillToPortfolio({
          state,
          order,
          fillSize: fillIncrementSize,
          fillPrice: report.achievedPrice ?? report.expectedPrice ?? order.price,
          fees: report.fees ?? 0,
          observedAt,
          markPrice
        })
      : {
          bankroll: markBankrollToMarket(
            state,
            state.bankroll.cash,
            state.bankroll.realizedPnl,
            state.openPositions,
            observedAt,
            markPrice
          ),
          openPositions: state.openPositions
        };
  const orderMap = { ...state.orderMap };
  delete orderMap[existing?.clientId ?? report.clientId];
  orderMap[order.clientId] = order;
  const realizedPnlDelta = roundCrypto(portfolio.bankroll.realizedPnl - state.bankroll.realizedPnl);
  const tradeExecution = executionReportToTrade({
    state,
    report,
    order,
    slippagePoint,
    resultingPnl: realizedPnlDelta,
    observedAt,
    markPrice
  });

  return {
    bankroll: portfolio.bankroll,
    openPositions: portfolio.openPositions,
    orderMap,
    slippage: appendSlippagePoint(state.slippage, slippagePoint),
    order,
    slippagePoint,
    tradeExecution,
    fillIncrementSize,
    realizedPnlDelta,
    observedAt
  };
}

export function buildSlippagePoint(report: ExecutionReport, order: ManagedOrder): SlippagePoint {
  const expectedPrice = report.expectedPrice ?? order.price;
  const achievedPrice = report.achievedPrice ?? expectedPrice;
  const sideMultiplier = order.side === "BUY" ? 1 : -1;
  const slippageBps =
    expectedPrice > 0
      ? ((achievedPrice - expectedPrice) / expectedPrice) * 10_000 * sideMultiplier
      : 0;
  const fees = report.fees ?? 0;
  const implementationShortfall =
    Math.abs(achievedPrice - expectedPrice) * Math.max(order.filledSize, order.size) + fees;

  return {
    expectedPrice,
    achievedPrice,
    slippageBps,
    implementationShortfall,
    latencyMs: report.latencyMs ?? 0,
    observedAt: report.observedAt
  };
}

export function mapManagedStatusToTradeStatus(
  status: ManagedOrder["status"]
): TradeExecution["status"] {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIAL_FILL":
      return "PARTIAL";
    case "GHOST_FILL":
      return "GHOST_FILL";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    case "PENDING":
    case "OPEN":
    default:
      return "ACCEPTED";
  }
}

function applyFillToPortfolio(input: {
  state: EngineState;
  order: ManagedOrder;
  fillSize: number;
  fillPrice: number;
  fees: number;
  observedAt: string;
  markPrice: (instrumentCode: string, fallback: number) => number;
}): Pick<EngineState, "bankroll" | "openPositions"> {
  const { state, order, fillSize, fillPrice, fees, observedAt, markPrice } = input;
  if (
    !Number.isFinite(fillSize) ||
    fillSize <= 0 ||
    !Number.isFinite(fillPrice) ||
    fillPrice <= 0
  ) {
    return {
      bankroll: state.bankroll,
      openPositions: state.openPositions
    };
  }

  const positions = { ...state.openPositions };
  const existing = positions[order.instrumentCode];
  const existingSigned = signedPosition(existing);
  const fillSigned = order.side === "BUY" ? fillSize : -fillSize;
  const nextSigned = roundCrypto(existingSigned + fillSigned);
  const oldAverage = existing?.averageEntryPrice ?? fillPrice;
  const closingSize =
    existingSigned !== 0 && Math.sign(existingSigned) !== Math.sign(fillSigned)
      ? Math.min(Math.abs(existingSigned), Math.abs(fillSigned))
      : 0;
  const realizedFromClose =
    closingSize > 0 ? (fillPrice - oldAverage) * closingSize * (existingSigned > 0 ? 1 : -1) : 0;
  const realizedPnl = roundCrypto((existing?.realizedPnl ?? 0) + realizedFromClose - fees);
  const currentMark = markPrice(order.instrumentCode, fillPrice);

  if (Math.abs(nextSigned) <= 0.00000001) {
    delete positions[order.instrumentCode];
  } else {
    const sameDirection =
      existingSigned === 0 || Math.sign(existingSigned) === Math.sign(fillSigned);
    const averageEntryPrice = sameDirection
      ? roundCrypto(
          (Math.abs(existingSigned) * oldAverage + Math.abs(fillSigned) * fillPrice) /
            Math.max(0.00000001, Math.abs(existingSigned) + Math.abs(fillSigned))
        )
      : Math.sign(nextSigned) === Math.sign(existingSigned)
        ? oldAverage
        : fillPrice;

    positions[order.instrumentCode] = {
      instrumentCode: order.instrumentCode,
      side: nextSigned > 0 ? "LONG" : "SHORT",
      quantity: Math.abs(nextSigned),
      averageEntryPrice,
      markPrice: currentMark,
      unrealizedPnl: roundCrypto(
        (currentMark - averageEntryPrice) * Math.abs(nextSigned) * (nextSigned > 0 ? 1 : -1)
      ),
      realizedPnl,
      updatedAt: observedAt
    };
  }

  const cashDelta =
    order.side === "BUY" ? -(fillPrice * fillSize + fees) : fillPrice * fillSize - fees;
  const cash = roundCrypto(state.bankroll.cash + cashDelta);
  const bankroll = markBankrollToMarket(
    state,
    cash,
    roundCrypto(state.bankroll.realizedPnl + realizedFromClose - fees),
    positions,
    observedAt,
    markPrice
  );

  return { bankroll, openPositions: positions };
}

function executionReportToTrade(input: {
  state: EngineState;
  report: ExecutionReport;
  order: ManagedOrder;
  slippagePoint: SlippagePoint;
  resultingPnl: number;
  observedAt: string;
  markPrice: (instrumentCode: string, fallback: number) => number;
}): TradeExecution {
  const { state, report, order, slippagePoint, resultingPnl, observedAt, markPrice } = input;
  const matchedIntent =
    state.lastTradeIntent &&
    (state.lastTradeIntent.intentId === order.intentId ||
      report.clientId.startsWith(`${state.lastTradeIntent.intentId}:`))
      ? state.lastTradeIntent
      : null;
  const status = mapManagedStatusToTradeStatus(report.status);
  const price = positiveNumber(
    report.achievedPrice ?? report.expectedPrice ?? order.price,
    markPrice(order.instrumentCode, order.price)
  );
  const size = positiveNumber(
    executionReportSize(report, order, status),
    order.size > 0 ? order.size : 0.00000001
  );
  const primaryDriver = inferExecutionPrimaryDriver(matchedIntent, order);

  return {
    tradeId: executionTradeId(report, status, observedAt),
    orderId: report.clientId,
    venue: matchedIntent?.source_exchange ?? state.microstructure.source_exchange ?? "unknown",
    asset: order.instrumentCode,
    side: report.side ?? order.side,
    orderType: matchedIntent?.orderType ?? "LIMIT",
    price,
    size,
    evAtExecution: matchedIntent?.expectedValue ?? 0,
    slippageBps: slippagePoint.slippageBps,
    resultingPnl:
      status === "FILLED" || status === "PARTIAL" || status === "GHOST_FILL" ? resultingPnl : 0,
    primaryDriver,
    fees: report.fees ?? 0,
    status,
    exchangeTradeId: report.exchangeOrderId,
    metadata: toJsonValue({
      report,
      order,
      fillIncrementSize: report.fillIncrementSize ?? null,
      cumulativeFilledSize: report.filledSize ?? order.filledSize,
      reason: report.reason ?? null,
      rawStatus: report.rawStatus ?? null,
      implementationShortfall: slippagePoint.implementationShortfall,
      latencyMs: slippagePoint.latencyMs
    }) as JsonRecord,
    executedAt: observedAt
  };
}

function markBankrollToMarket(
  state: EngineState,
  cash: number,
  realizedPnl: number,
  positions: Record<string, Position>,
  observedAt: string,
  markPrice: (instrumentCode: string, fallback: number) => number
): EngineState["bankroll"] {
  const positionValue = Object.values(positions).reduce((sum, position) => {
    const mark = markPrice(position.instrumentCode, position.markPrice);
    return sum + (position.side === "LONG" ? 1 : -1) * position.quantity * mark;
  }, 0);

  return {
    ...state.bankroll,
    cash: roundCrypto(cash),
    equity: roundCrypto(cash + positionValue),
    realizedPnl: roundCrypto(realizedPnl),
    updatedAt: observedAt
  };
}

function appendSlippagePoint(
  current: EngineState["slippage"],
  point: SlippagePoint
): EngineState["slippage"] {
  const points = [...current.points, point].slice(-500);
  const averageSlippageBps =
    points.reduce((sum, item) => sum + item.slippageBps, 0) / Math.max(1, points.length);
  const latencyCorrelation = pearson(
    points.map((item) => item.latencyMs),
    points.map((item) => Math.abs(item.slippageBps))
  );
  const executionCostBufferBps =
    averageSlippageBps > current.executionCostBufferBps
      ? averageSlippageBps
      : current.executionCostBufferBps;

  return {
    schemaVersion: "slippage.v1",
    points,
    averageSlippageBps,
    latencyCorrelation,
    executionCostBufferBps,
    updatedAt: point.observedAt
  };
}

function isPortfolioFillStatus(status: ManagedOrder["status"]): boolean {
  return status === "FILLED" || status === "PARTIAL_FILL" || status === "GHOST_FILL";
}

function executionReportSize(
  report: ExecutionReport,
  order: ManagedOrder,
  status: TradeExecution["status"]
): number {
  if (status === "FILLED" || status === "PARTIAL" || status === "GHOST_FILL") {
    return report.fillIncrementSize ?? report.filledSize ?? order.filledSize ?? order.size;
  }

  return report.orderSize ?? order.size;
}

function signedPosition(position: Position | undefined): number {
  if (!position) {
    return 0;
  }
  return position.side === "LONG" ? position.quantity : -position.quantity;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isFinite(parsed) && parsed > 0) {
    return roundCrypto(parsed);
  }

  return Number.isFinite(fallback) && fallback > 0 ? roundCrypto(fallback) : 0.00000001;
}

function executionTradeId(
  report: ExecutionReport,
  status: TradeExecution["status"],
  observedAt: string
): string {
  const exchangeId = report.exchangeOrderId ?? "local";
  return `execution:${report.clientId}:${exchangeId}:${status}:${Date.parse(observedAt) || observedAt}`;
}

function inferExecutionPrimaryDriver(intent: TradeIntent | null, order: ManagedOrder): AgentName {
  const rationale = intent?.rationale.toLowerCase() ?? "";

  if (rationale.includes("hedge") || order.clientId.includes(":hedge")) {
    return "RISK";
  }

  if (intent?.traceId.includes("profiler")) {
    return "PROFILER";
  }

  return intent ? "CROUPIER" : "EXECUTIONER";
}

function roundCrypto(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function pearson(left: number[], right: number[]): number | null {
  const count = Math.min(left.length, right.length);

  if (count < 2) {
    return null;
  }

  const x = left.slice(-count);
  const y = right.slice(-count);
  const meanX = x.reduce((sum, value) => sum + value, 0) / count;
  const meanY = y.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let index = 0; index < count; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? roundCrypto(numerator / denominator) : null;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonValue(item)
      ])
    );
  }

  return String(value);
}

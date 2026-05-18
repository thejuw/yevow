import type {
  Candle,
  CascadeCloseReason,
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoveryDirection,
  CascadeRecoverySignal,
  PositionManagerTick,
  PositionManagerUpdate,
  PositionSizeDecision
} from "./types";

const POSITION_PRECISION = 8;
const EPSILON = 1e-9;

export class PositionManager {
  private readonly positions = new Map<string, CascadeOpenPosition>();

  registerFromSignal(
    signal: CascadeRecoverySignal,
    sizeDecision: PositionSizeDecision,
    enteredAt = signal.emittedAt
  ): CascadeOpenPosition {
    if (!sizeDecision.approved || sizeDecision.units <= 0) {
      throw new Error(
        `Cannot register cascade position from rejected size decision: ${signal.signalId}`
      );
    }

    const position: CascadeOpenPosition = {
      positionId: `cascade-position-${signal.signalId}`,
      signalId: signal.signalId,
      cascadeId: signal.cascadeId,
      instrumentCode: signal.instrumentCode,
      direction: signal.direction,
      status: "ENTERED",
      entryPrice: signal.entryPrice,
      currentStopPrice: signal.stopPrice,
      initialStopPrice: signal.stopPrice,
      totalSize: sizeDecision.units,
      remainingSize: sizeDecision.units,
      initialRiskPct: sizeDecision.riskPct,
      rDistance: signal.rDistance,
      targets: signal.targets,
      timeStopAt: signal.timeStopAt,
      firstTargetTaken: false,
      secondTargetTaken: false,
      enteredAt,
      updatedAt: enteredAt
    };

    this.positions.set(position.positionId, position);
    return position;
  }

  hydrate(positions: readonly CascadeOpenPosition[]): void {
    this.positions.clear();
    for (const position of positions) {
      this.positions.set(position.positionId, { ...position });
    }
  }

  snapshot(): CascadeOpenPosition[] {
    return Array.from(this.positions.values(), (position) => ({ ...position }));
  }

  requestManualClose(
    positionId: string,
    observedAt: string,
    referencePrice: number
  ): PositionManagerUpdate | null {
    const position = this.positions.get(positionId);

    if (!position || !isOpen(position)) {
      return null;
    }

    const tick: PositionManagerTick = {
      instrumentCode: position.instrumentCode,
      price: referencePrice,
      observedAt
    };
    const intent = this.closeIntent(position, tick, position.remainingSize, "MANUAL", "TAKER_IOC");
    closePosition(position, "CLOSED", observedAt);

    return {
      position: { ...position },
      intents: [intent]
    };
  }

  onTick(tick: PositionManagerTick): PositionManagerUpdate[] {
    const updates: PositionManagerUpdate[] = [];

    for (const position of this.positions.values()) {
      if (position.instrumentCode !== tick.instrumentCode || !isOpen(position)) {
        continue;
      }

      const update = this.updatePosition(position, tick);
      if (update.intents.length > 0) {
        updates.push(update);
      }
    }

    return updates;
  }

  updatePosition(position: CascadeOpenPosition, tick: PositionManagerTick): PositionManagerUpdate {
    const intents: CascadePositionIntent[] = [];

    if (!isOpen(position)) {
      return { position, intents };
    }

    if (stopHit(position, tick.price)) {
      intents.push(
        this.closeIntent(position, tick, position.remainingSize, "STOP_LOSS", "TAKER_MARKET")
      );
      closePosition(position, "STOPPED_OUT", tick.observedAt);
      return { position, intents };
    }

    if (
      !position.firstTargetTaken &&
      targetHit(position.direction, tick.price, position.targets.partial1.price)
    ) {
      const closeSize = closeSizeFor(position, position.targets.partial1.sizePct);
      if (closeSize > 0) {
        intents.push(this.closeIntent(position, tick, closeSize, "FIRST_TARGET", "TAKER_IOC"));
        position.remainingSize = roundSize(position.remainingSize - closeSize);
      }
      position.firstTargetTaken = true;
      position.status = "FIRST_TARGET_HIT";
      this.moveStop(position, position.entryPrice, tick, intents);
    }

    if (
      !position.secondTargetTaken &&
      targetHit(position.direction, tick.price, position.targets.partial2.price)
    ) {
      const closeSize = closeSizeFor(position, position.targets.partial2.sizePct);
      if (closeSize > 0) {
        intents.push(this.closeIntent(position, tick, closeSize, "SECOND_TARGET", "TAKER_IOC"));
        position.remainingSize = roundSize(position.remainingSize - closeSize);
      }
      position.secondTargetTaken = true;
      position.status = "SECOND_TARGET_HIT";
      this.moveStop(position, position.targets.partial1.price, tick, intents);
    }

    const trailingStop = calculateTrailingStop(position, tick);
    if (trailingStop !== null) {
      this.moveStop(position, trailingStop, tick, intents);
    }

    if (
      Date.parse(tick.observedAt) >= Date.parse(position.timeStopAt) &&
      !hasReachedOneR(position, tick.price)
    ) {
      intents.push(
        this.closeIntent(position, tick, position.remainingSize, "TIME_STOP", "TAKER_MARKET")
      );
      closePosition(position, "TIME_STOPPED", tick.observedAt);
      return { position, intents };
    }

    if (position.remainingSize <= EPSILON) {
      closePosition(position, "CLOSED", tick.observedAt);
    } else {
      position.updatedAt = tick.observedAt;
    }

    return { position, intents };
  }

  private moveStop(
    position: CascadeOpenPosition,
    newStopPrice: number,
    tick: PositionManagerTick,
    intents: CascadePositionIntent[]
  ): void {
    if (!isBetterStop(position.direction, position.currentStopPrice, newStopPrice)) {
      return;
    }

    position.currentStopPrice = roundPrice(newStopPrice);
    intents.push({
      intentId: newIntentId(position.positionId, "move-stop", tick.observedAt),
      positionId: position.positionId,
      signalId: position.signalId,
      instrumentCode: position.instrumentCode,
      kind: "MOVE_STOP",
      action: closeAction(position.direction),
      orderType: "IOC",
      executionStyle: "TAKER_IOC",
      size: 0,
      referencePrice: tick.price,
      newStopPrice: position.currentStopPrice,
      createdAt: tick.observedAt
    });
  }

  private closeIntent(
    position: CascadeOpenPosition,
    tick: PositionManagerTick,
    size: number,
    closeReason: CascadeCloseReason,
    executionStyle: CascadePositionIntent["executionStyle"]
  ): CascadePositionIntent {
    return {
      intentId: newIntentId(position.positionId, closeReason.toLowerCase(), tick.observedAt),
      positionId: position.positionId,
      signalId: position.signalId,
      instrumentCode: position.instrumentCode,
      kind: "CLOSE",
      closeReason,
      action: closeAction(position.direction),
      orderType: "IOC",
      executionStyle,
      size: roundSize(Math.min(size, position.remainingSize)),
      referencePrice: tick.price,
      createdAt: tick.observedAt
    };
  }
}

function isOpen(position: CascadeOpenPosition): boolean {
  return (
    position.remainingSize > EPSILON &&
    position.status !== "CLOSED" &&
    position.status !== "STOPPED_OUT" &&
    position.status !== "TIME_STOPPED"
  );
}

function stopHit(position: CascadeOpenPosition, price: number): boolean {
  return position.direction === "LONG"
    ? price <= position.currentStopPrice
    : price >= position.currentStopPrice;
}

function targetHit(
  direction: CascadeRecoveryDirection,
  price: number,
  targetPrice: number
): boolean {
  return direction === "LONG" ? price >= targetPrice : price <= targetPrice;
}

function hasReachedOneR(position: CascadeOpenPosition, price: number): boolean {
  const oneR =
    position.direction === "LONG"
      ? position.entryPrice + position.rDistance
      : position.entryPrice - position.rDistance;
  return targetHit(position.direction, price, oneR);
}

function closeSizeFor(position: CascadeOpenPosition, sizePct: number): number {
  return roundSize(Math.min(position.remainingSize, position.totalSize * (sizePct / 100)));
}

function closePosition(
  position: CascadeOpenPosition,
  status: Extract<CascadeOpenPosition["status"], "CLOSED" | "STOPPED_OUT" | "TIME_STOPPED">,
  observedAt: string
): void {
  position.status = status;
  position.remainingSize = 0;
  position.updatedAt = observedAt;
}

function calculateTrailingStop(
  position: CascadeOpenPosition,
  tick: PositionManagerTick
): number | null {
  if (!position.firstTargetTaken) {
    return null;
  }

  if (position.targets.runner.trailingType === "ATR") {
    const atr = tick.atr ?? null;
    if (atr === null || atr <= 0) {
      return null;
    }

    return position.direction === "LONG"
      ? tick.price - position.targets.runner.trailingParam * atr
      : tick.price + position.targets.runner.trailingParam * atr;
  }

  return emaTrail(position, tick.candles ?? []);
}

function emaTrail(position: CascadeOpenPosition, candles: readonly Candle[]): number | null {
  if (candles.length === 0) {
    return null;
  }

  const period = Math.max(2, Math.round(position.targets.runner.trailingParam));
  const smoothing = 2 / (period + 1);
  let ema = candles[0].close;
  for (let index = 1; index < candles.length; index += 1) {
    ema = candles[index].close * smoothing + ema * (1 - smoothing);
  }

  return ema;
}

function isBetterStop(
  direction: CascadeRecoveryDirection,
  currentStop: number,
  candidateStop: number
): boolean {
  return direction === "LONG" ? candidateStop > currentStop : candidateStop < currentStop;
}

function closeAction(direction: CascadeRecoveryDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "SELL" : "BUY";
}

function newIntentId(positionId: string, suffix: string, observedAt: string): string {
  return `${positionId}-${suffix}-${Date.parse(observedAt)}`;
}

function roundPrice(value: number): number {
  return Number(value.toFixed(POSITION_PRECISION));
}

function roundSize(value: number): number {
  return Number(Math.max(0, value).toFixed(POSITION_PRECISION));
}

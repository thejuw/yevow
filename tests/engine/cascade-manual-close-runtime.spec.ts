import { describe, expect, it } from "vitest";
import {
  cascadeManualCloseArtifacts,
  cascadeManualCloseResponse,
  cascadePositionNotOpenResponse,
  executableManualCloseIntents,
  openCascadePositionById
} from "../../src/engine/trading/cascade/CascadeManualCloseRuntime";
import type { CascadeOpenPosition, CascadePositionIntent } from "../../src/strategy/cascade/types";

const OBSERVED_AT = "2026-05-18T19:00:00.000Z";

describe("CascadeManualCloseRuntime", () => {
  it("finds only open cascade positions by id", () => {
    const open = position("position-open", "OPEN");
    const closed = position("position-closed", "CLOSED");

    expect(openCascadePositionById([closed, open], "position-open")).toBe(open);
    expect(openCascadePositionById([closed, open], "position-closed")).toBeNull();
    expect(openCascadePositionById([closed, open], "missing")).toBeNull();
  });

  it("filters executable manual close intents", () => {
    const close = intent("close", "CLOSE", 1);
    const zeroSize = intent("zero", "CLOSE", 0);
    const stopUpdate = intent("stop", "STOP_UPDATE", 1);

    expect(executableManualCloseIntents([zeroSize, stopUpdate, close])).toEqual([close]);
  });

  it("builds not-open and successful response payloads", () => {
    const closed = position("position-1", "OPEN");
    const intents = [intent("close", "CLOSE", 1)];

    expect(cascadePositionNotOpenResponse()).toEqual({
      ok: false,
      error: "CASCADE_POSITION_NOT_OPEN"
    });
    expect(cascadeManualCloseResponse({ position: closed, intents })).toEqual({
      ok: true,
      position: closed,
      intents
    });
  });

  it("assembles manual close execution, log, telemetry, and response artifacts", () => {
    const open = position("position-1", "OPEN");
    const close = intent("close", "CLOSE", 1);
    const zeroSize = intent("zero", "CLOSE", 0);
    const artifacts = cascadeManualCloseArtifacts({
      position: open,
      intents: [zeroSize, close],
      actor: "operator",
      reason: "manual-risk-off",
      markPrice: 101,
      observedAt: OBSERVED_AT
    });

    expect(artifacts.executableIntents).toEqual([close]);
    expect(artifacts.logMetadata).toMatchObject({
      positionId: "position-1",
      actor: "operator",
      reason: "manual-risk-off",
      markPrice: 101
    });
    expect(artifacts.telemetryPayload).toMatchObject({
      positionId: "position-1",
      actor: "operator",
      reason: "manual-risk-off"
    });
    expect(artifacts.response).toEqual({
      ok: true,
      position: open,
      intents: [zeroSize, close]
    });
  });
});

function position(positionId: string, status: CascadeOpenPosition["status"]): CascadeOpenPosition {
  return {
    positionId,
    signalId: "signal-1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG",
    status,
    entryPrice: 100,
    currentStopPrice: 95,
    initialStopPrice: 95,
    totalSize: 1,
    remainingSize: 1,
    initialRiskPct: 0.01,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2, sizePct: 0.5 },
      partial2: { price: 115, rMultiple: 3, sizePct: 0.25 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.25 }
    },
    timeStopAt: OBSERVED_AT,
    firstTargetTaken: false,
    secondTargetTaken: false,
    enteredAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT
  };
}

function intent(
  intentId: string,
  kind: CascadePositionIntent["kind"],
  size: number
): CascadePositionIntent {
  return {
    intentId,
    positionId: "position-1",
    signalId: "signal-1",
    instrumentCode: "btc-usd",
    kind,
    closeReason: kind === "CLOSE" ? "MANUAL" : undefined,
    action: "SELL",
    orderType: "IOC",
    executionStyle: "TAKER_IOC",
    size,
    referencePrice: 100,
    createdAt: OBSERVED_AT
  };
}

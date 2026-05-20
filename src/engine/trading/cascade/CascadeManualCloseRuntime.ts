import type { JsonRecord } from "../../../types";
import type { CascadeOpenPosition, CascadePositionIntent } from "../../../strategy/cascade/types";
import { isOpenCascadePosition } from "./CascadeSelectionRuntime";
import {
  cascadeManualCloseLogMetadata,
  cascadeManualCloseTelemetryPayload
} from "../telemetry/CascadeSignalTelemetryRuntime";

export interface CascadeManualCloseResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly position?: JsonRecord;
  readonly intents?: JsonRecord[];
}

export interface CascadeManualCloseArtifactsInput {
  readonly position: CascadeOpenPosition;
  readonly intents: readonly CascadePositionIntent[];
  readonly actor: string;
  readonly reason: string;
  readonly markPrice: number;
  readonly observedAt: string;
}

export interface CascadeManualCloseArtifacts {
  readonly executableIntents: CascadePositionIntent[];
  readonly logMetadata: JsonRecord;
  readonly telemetryPayload: JsonRecord;
  readonly response: CascadeManualCloseResponse;
}

export interface CascadeManualCloseUpdate {
  readonly intents: readonly CascadePositionIntent[];
}

export interface CascadeManualCloseRuntimeInput {
  readonly positions: readonly CascadeOpenPosition[];
  readonly positionId: string;
  readonly actor: string;
  readonly reason: string;
  readonly observedAt: string;
  readonly markPriceForInstrument: (instrumentCode: string) => number | null;
  readonly requestManualClose: (
    positionId: string,
    observedAt: string,
    markPrice: number
  ) => CascadeManualCloseUpdate | null;
}

export type CascadeManualCloseRuntimeResult =
  | {
      readonly ok: false;
      readonly response: CascadeManualCloseResponse;
    }
  | {
      readonly ok: true;
      readonly position: CascadeOpenPosition;
      readonly artifacts: CascadeManualCloseArtifacts;
    };

export function openCascadePositionById(
  positions: readonly CascadeOpenPosition[],
  positionId: string
): CascadeOpenPosition | null {
  return (
    positions.find(
      (candidate) => candidate.positionId === positionId && isOpenCascadePosition(candidate)
    ) ?? null
  );
}

export function executableManualCloseIntents(
  intents: readonly CascadePositionIntent[]
): CascadePositionIntent[] {
  return intents.filter((intent) => intent.kind === "CLOSE" && intent.size > 0);
}

export function cascadePositionNotOpenResponse(): CascadeManualCloseResponse {
  return { ok: false, error: "CASCADE_POSITION_NOT_OPEN" };
}

export function cascadeManualCloseResponse(input: {
  readonly position: CascadeOpenPosition;
  readonly intents: readonly CascadePositionIntent[];
}): CascadeManualCloseResponse {
  return {
    ok: true,
    position: input.position as unknown as JsonRecord,
    intents: input.intents as unknown as JsonRecord[]
  };
}

export function buildCascadeManualCloseRuntimeResult(
  input: CascadeManualCloseRuntimeInput
): CascadeManualCloseRuntimeResult {
  const position = openCascadePositionById(input.positions, input.positionId);

  if (!position) {
    return { ok: false, response: cascadePositionNotOpenResponse() };
  }

  const markPrice = input.markPriceForInstrument(position.instrumentCode) ?? position.entryPrice;
  const update = input.requestManualClose(input.positionId, input.observedAt, markPrice);

  if (!update) {
    return { ok: false, response: cascadePositionNotOpenResponse() };
  }

  return {
    ok: true,
    position,
    artifacts: cascadeManualCloseArtifacts({
      position,
      intents: update.intents,
      actor: input.actor,
      reason: input.reason,
      markPrice,
      observedAt: input.observedAt
    })
  };
}

export function cascadeManualCloseArtifacts(
  input: CascadeManualCloseArtifactsInput
): CascadeManualCloseArtifacts {
  const executableIntents = executableManualCloseIntents(input.intents);

  return {
    executableIntents,
    logMetadata: cascadeManualCloseLogMetadata({
      position: input.position,
      actor: input.actor,
      reason: input.reason,
      markPrice: input.markPrice,
      observedAt: input.observedAt
    }),
    telemetryPayload: cascadeManualCloseTelemetryPayload({
      position: input.position,
      actor: input.actor,
      reason: input.reason,
      markPrice: input.markPrice,
      observedAt: input.observedAt
    }),
    response: cascadeManualCloseResponse(input)
  };
}

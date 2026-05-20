import type { JsonRecord } from "../../../types";
import type { CascadeOpenPosition, CascadePositionIntent } from "../../../strategy/cascade/types";
import { isOpenCascadePosition } from "./CascadeSelectionRuntime";

export interface CascadeManualCloseResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly position?: JsonRecord;
  readonly intents?: JsonRecord[];
}

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

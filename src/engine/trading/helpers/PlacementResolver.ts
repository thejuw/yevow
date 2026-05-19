import type { EdgeTopology, Env } from "../../../types";

export function placementColo(topology?: Partial<EdgeTopology> | null): string {
  const raw = topology?.placement ?? topology?.colo ?? "UNKNOWN";
  return normalizeColo(raw);
}

export function configuredPlacementColo(
  env: Pick<Env, "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS">
): string {
  const [firstGolden] = (env.GOLDEN_COLOS ?? "")
    .split(",")
    .map((colo) => normalizeColo(colo))
    .filter((colo) => colo !== "UNKNOWN");
  return normalizeColo(env.PLACEMENT_TARGET_COLO ?? firstGolden ?? "UNKNOWN");
}

export function isGoldenColo(
  topology: Partial<EdgeTopology> | null | undefined,
  env: Pick<Env, "GOLDEN_COLOS">
): boolean {
  const current = placementColo(topology);
  const golden = (env.GOLDEN_COLOS ?? "").split(",").map((colo) => normalizeColo(colo));
  return golden.includes(current);
}

function normalizeColo(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) {
    return "UNKNOWN";
  }

  return raw.includes("-") ? (raw.split("-").pop()?.toUpperCase() ?? "UNKNOWN") : raw.toUpperCase();
}

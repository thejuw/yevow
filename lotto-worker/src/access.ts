import { serviceAuthorized } from "./delivery";
import type { Env } from "./env";

const DASHBOARD_AUTH_CHECK = "https://api.yevow.co/admin/state";

export type DashboardAccess = "authorized" | "denied" | "unavailable";

function bearerHeader(request: Request): string | null {
  const value = request.headers.get("Authorization") ?? "";
  return /^Bearer [^\s]+$/.test(value) ? value : null;
}

/**
 * Validate exact-pick readers against the existing Yevow session authority.
 * The scoped service token remains valid for non-browser operations. No JWT or
 * response body is persisted, logged, cached, or returned by this Worker.
 */
export async function dashboardAccess(request: Request, env: Env): Promise<DashboardAccess> {
  if (await serviceAuthorized(request, env)) return "authorized";
  const authorization = bearerHeader(request);
  if (!authorization) return "denied";
  try {
    const response = await fetch(DASHBOARD_AUTH_CHECK, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: authorization }
    });
    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      // Authentication depends only on the status; a synthetic/test stream may
      // already be consumed or non-cancellable.
    }
    if (status === 200) return "authorized";
    return status === 401 || status === 403 ? "denied" : "unavailable";
  } catch {
    return "unavailable";
  }
}

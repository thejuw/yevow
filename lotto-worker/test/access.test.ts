import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { dashboardAccess } from "../src/access";
import { network } from "./network";

describe("exact-pick dashboard access", () => {
  it("accepts an active Yevow dashboard bearer without exposing it", async () => {
    let observedAuthorization = "";
    network.use(
      http.get("https://api.yevow.co/admin/state", ({ request }) => {
        observedAuthorization = request.headers.get("Authorization") ?? "";
        return HttpResponse.json({ ok: true });
      })
    );
    const access = await dashboardAccess(
      new Request("https://lotto-api.yevow.co/api/lotto/v1/picks/today", {
        headers: { Authorization: "Bearer yevow-test-session" }
      }),
      env
    );
    expect(access).toBe("authorized");
    expect(observedAuthorization).toBe("Bearer yevow-test-session");
  });

  it("rejects a missing or rejected dashboard bearer", async () => {
    expect(
      await dashboardAccess(new Request("https://lotto-api.yevow.co/api/lotto/v1/picks/today"), env)
    ).toBe("denied");
    network.use(
      http.get("https://api.yevow.co/admin/state", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 })
      )
    );
    expect(
      await dashboardAccess(
        new Request("https://lotto-api.yevow.co/api/lotto/v1/picks/today", {
          headers: { Authorization: "Bearer expired-session" }
        }),
        env
      )
    ).toBe("denied");
  });

  it("fails closed when the Yevow session authority is unavailable", async () => {
    network.use(
      http.get("https://api.yevow.co/admin/state", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 })
      )
    );
    expect(
      await dashboardAccess(
        new Request("https://lotto-api.yevow.co/api/lotto/v1/picks/today", {
          headers: { Authorization: "Bearer yevow-test-session" }
        }),
        env
      )
    ).toBe("unavailable");
  });
});

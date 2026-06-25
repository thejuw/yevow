import { describe, expect, it } from "vitest";
import { buildResolutionUrl, fetchDotCastRouterResolution } from "../../src/engine/dotcast";

describe("dotCast router resolution client", () => {
  it("builds configured resolution URLs with marketId templates or query params", () => {
    expect(
      buildResolutionUrl("https://router.test/markets/{marketId}/resolution", "kalshi:A/B")
    ).toBe("https://router.test/markets/kalshi%3AA%2FB/resolution");
    expect(buildResolutionUrl("https://router.test/resolution", "kalshi:A/B")).toBe(
      "https://router.test/resolution?marketId=kalshi%3AA%2FB"
    );
  });

  it("normalizes wrapped router resolution responses", async () => {
    const result = await fetchDotCastRouterResolution(
      {
        DOTCAST_ROUTER_RESOLUTION_URL: "https://router.test/markets/{marketId}/resolution",
        DOTCAST_ROUTER_RESOLUTION_TOKEN: "token"
      },
      "kalshi:demo",
      "2099-06-25T17:06:00.000Z",
      async (input, init) => {
        expect(String(input)).toBe("https://router.test/markets/kalshi%3Ademo/resolution");
        expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
        return Response.json({
          ok: true,
          resolution: {
            outcome: "yes",
            resolved_at: "2099-06-25T17:05:30.000Z",
            fetched_at: "2099-06-25T17:06:00.000Z",
            stale: false,
            venue: "kalshi"
          }
        });
      }
    );

    expect(result).toEqual({
      kind: "resolution",
      resolution: {
        marketId: "kalshi:demo",
        outcome: "yes",
        resolvedAt: "2099-06-25T17:05:30.000Z",
        fetchedAt: "2099-06-25T17:06:00.000Z",
        stale: false,
        source: "kalshi"
      }
    });
  });

  it("treats router null resolution as pending instead of fabricating an outcome", async () => {
    const result = await fetchDotCastRouterResolution(
      { DOTCAST_ROUTER_RESOLUTION_URL: "https://router.test/resolution" },
      "polymarket:demo",
      "2099-06-25T17:06:00.000Z",
      async () => Response.json({ ok: true, resolution: null })
    );

    expect(result).toEqual({
      kind: "pending",
      resolution: {
        marketId: "polymarket:demo",
        outcome: "pending",
        resolvedAt: null,
        fetchedAt: "2099-06-25T17:06:00.000Z",
        stale: false
      }
    });
  });

  it("reports not configured when the router endpoint is absent", async () => {
    await expect(
      fetchDotCastRouterResolution({}, "kalshi:demo", "2099-06-25T17:06:00.000Z")
    ).resolves.toMatchObject({
      kind: "not_configured"
    });
  });
});

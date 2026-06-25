import { describe, expect, it } from "vitest";
import { buildReferencePriceUrl, fetchDotCastReferencePrice } from "../../src/engine/dotcast";

describe("dotCast E3 router reference price client", () => {
  it("normalizes router market prices into canonical reference prices", async () => {
    const result = await fetchDotCastReferencePrice(
      {
        DOTCAST_ROUTER_REFERENCE_PRICE_URL: "https://router.test/markets/{marketId}",
        DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN: "token"
      },
      "kalshi:demo",
      "2099-06-25T17:02:00.000Z",
      async (url, init) => {
        expect(url).toBe("https://router.test/markets/kalshi%3Ademo");
        expect(init?.headers).toMatchObject({
          accept: "application/json",
          authorization: "Bearer token",
          "x-api-key": "token"
        });

        return Response.json({
          market: {
            id: "kalshi:demo",
            venue: "kalshi",
            price: {
              yes: "0.64",
              no: 0.38
            },
            lastUpdated: "2099-06-25T17:01:59.000Z",
            stale: false,
            referenceUrl: "https://kalshi.example/markets/demo"
          }
        });
      }
    );

    expect(result).toEqual({
      kind: "reference",
      referencePrice: {
        marketId: "kalshi:demo",
        venue: "kalshi",
        price: {
          yes: 0.64,
          no: 0.38
        },
        lastUpdated: "2099-06-25T17:01:59.000Z",
        stale: false,
        sourceLabel: "kalshi",
        referenceUrl: "https://kalshi.example/markets/demo",
        fetchedAt: "2099-06-25T17:02:00.000Z"
      }
    });
  });

  it("marks reference prices stale from router flags or local age threshold", async () => {
    const result = await fetchDotCastReferencePrice(
      {
        DOTCAST_ROUTER_REFERENCE_PRICE_URL: "https://router.test/markets",
        DOTCAST_ROUTER_REFERENCE_PRICE_STALE_MS: "1000"
      },
      "polymarket:demo",
      "2099-06-25T17:02:00.500Z",
      async () =>
        Response.json({
          data: {
            id: "polymarket:demo",
            venue: "polymarket",
            price: { yes: 0.51, no: 0.5 },
            lastUpdated: "2099-06-25T17:01:59.000Z",
            stale: false,
            url: "https://polymarket.example/event/demo"
          }
        })
    );

    expect(result).toMatchObject({
      kind: "reference",
      referencePrice: {
        stale: true,
        sourceLabel: "polymarket"
      }
    });
  });

  it("reports not_configured without guessing a reference price", async () => {
    const result = await fetchDotCastReferencePrice({}, "kalshi:demo", "2099-06-25T17:02:00.000Z");

    expect(result).toEqual({
      kind: "not_configured",
      error: "DOTCAST_ROUTER_REFERENCE_PRICE_URL is not configured"
    });
  });

  it("builds query-string reference URLs when no market placeholder is present", () => {
    expect(buildReferencePriceUrl("https://router.test/markets/current", "kalshi:demo")).toBe(
      "https://router.test/markets/current?marketId=kalshi%3Ademo"
    );
  });
});

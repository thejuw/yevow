import { describe, expect, it } from "vitest";

import { handleRequest } from "../src/api";
import type { Env } from "../src/env";

function inaccessibleBinding<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get() {
      throw new Error(`${name} must not be accessed while validating this request`);
    }
  });
}

const VALIDATION_ENV: Env = {
  LOTTO_DB: inaccessibleBinding<D1Database>("LOTTO_DB"),
  LOTTO_RAW: inaccessibleBinding<R2Bucket>("LOTTO_RAW")
};

async function request(
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; body: unknown }> {
  const response = await handleRequest(
    new Request(`https://lotto-api.yevow.co${path}`, init),
    VALIDATION_ENV
  );
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

describe("API request validation", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])(
    "rejects the %s method before touching storage",
    async (method) => {
      const { response, body } = await request("/api/lotto/v1/manifest", { method });

      expect(response.status).toBe(405);
      expect(body).toEqual({
        schemaVersion: 1,
        error: { code: "method_not_allowed", message: "Only GET is supported" }
      });
    }
  );

  it("returns structured 404 responses for unknown paths and games", async () => {
    const missing = await request("/api/lotto/v1/nope");
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({
      schemaVersion: 1,
      error: { code: "not_found", message: "Route not found" }
    });

    const unknownGame = await request("/api/lotto/v1/games/LOTTO/draws");
    expect(unknownGame.response.status).toBe(404);
    expect(unknownGame.body).toEqual({
      schemaVersion: 1,
      error: { code: "unknown_game", message: 'Unknown lottery game "LOTTO"' }
    });
  });

  it.each(["", "0", "201", "-1", "1.5", "1e2", " 1", "Infinity"])(
    "rejects invalid page limit %j before issuing a D1 query",
    async (limit) => {
      const { response, body } = await request(
        `/api/lotto/v1/games/lotto/draws?limit=${encodeURIComponent(limit)}`
      );

      expect(response.status).toBe(400);
      expect(body).toEqual({
        schemaVersion: 1,
        error: {
          code: "invalid_limit",
          message: "limit must be an integer from 1 through 200"
        }
      });
    }
  );

  it.each(["not_base64", "eA", "A".repeat(101)])(
    "rejects malformed cursor %j before issuing a D1 query",
    async (cursor) => {
      const { response, body } = await request(
        `/api/lotto/v1/games/cash5/draws?cursor=${encodeURIComponent(cursor)}`
      );

      expect(response.status).toBe(400);
      expect(body).toEqual({
        schemaVersion: 1,
        error: { code: "invalid_cursor", message: "cursor is malformed" }
      });
    }
  );

  it("normalizes trailing slashes on public routes", async () => {
    const { response, body } = await request("/api/lotto/v1/manifest///");

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ schemaVersion: 1, data: { games: expect.any(Array) } });
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("sets JSON and browser-hardening response headers", async () => {
    const { response } = await request("/not-found");

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("CORS policy", () => {
  it.each([
    "https://yevow.co",
    "https://www.yevow.co",
    "https://app.yevow.co",
    "https://sovereign-sigma-command-center.pages.dev",
    "https://lotto-preview.sovereign-sigma-command-center.pages.dev"
  ])("permits the configured dashboard origin %s", async (origin) => {
    const { response, body } = await request("/api/lotto/v1/manifest", {
      method: "OPTIONS",
      headers: { Origin: origin }
    });

    expect(response.status).toBe(204);
    expect(body).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("Accept, Content-Type");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
  });

  it.each([
    "http://yevow.co",
    "https://yevow.co:444",
    "https://yevow.co.evil.example",
    "https://sovereign-sigma-command-center.pages.dev.evil.example",
    "not an origin"
  ])("rejects untrusted origin %s", async (origin) => {
    const { response, body } = await request("/api/lotto/v1/manifest", {
      method: "OPTIONS",
      headers: { Origin: origin }
    });

    expect(response.status).toBe(403);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(body).toEqual({
      schemaVersion: 1,
      error: { code: "origin_denied", message: "Origin is not permitted" }
    });
  });

  it("allows a non-CORS OPTIONS probe without reflecting an origin", async () => {
    const { response } = await request("/api/lotto/v1/manifest", { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});

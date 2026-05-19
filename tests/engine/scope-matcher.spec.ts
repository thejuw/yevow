import { describe, expect, it } from "vitest";
import {
  MissingScopeError,
  expandLegacyScopes,
  hasScope,
  normalizeScope,
  requireScopes
} from "../../src/auth/ScopeMatcher";

describe("scope matcher", () => {
  it("normalizes legacy scopes without lowercasing them", () => {
    expect(normalizeScope("write")).toBe("WRITE");
    expect(normalizeScope("TELEMETRY:READ")).toBe("TELEMETRY:READ");
  });

  it("normalizes resource-action scopes to lowercase", () => {
    expect(normalizeScope("Config:Write")).toBe("config:write");
  });

  it("matches exact resource-action scopes", () => {
    expect(hasScope({ subject: "a", scopes: ["config:read"] }, "config:read")).toBe(true);
  });

  it("rejects missing resource-action scopes", () => {
    expect(hasScope({ subject: "a", scopes: ["config:read"] }, "config:write")).toBe(false);
  });

  it("expands READ to all read scopes by default", () => {
    const expanded = expandLegacyScopes(["READ"]);
    expect(expanded).toContain("telemetry:read");
    expect(expanded).toContain("config:read");
  });

  it("expands WRITE to super-admin behavior by default", () => {
    expect(hasScope({ subject: "a", scopes: ["WRITE"] }, "system:kill-switch")).toBe(true);
  });

  it("can disable legacy expansion", () => {
    expect(
      hasScope({ subject: "a", scopes: ["WRITE"] }, "config:write", {
        migrateLegacyScopes: false
      })
    ).toBe(false);
  });

  it("maps legacy CONFIG:WRITE to config:write", () => {
    expect(hasScope({ subject: "a", scopes: ["CONFIG:WRITE"] }, "config:write")).toBe(true);
  });

  it("throws with all missing scopes", () => {
    expect(() => {
      requireScopes({ subject: "a", scopes: ["config:read"] }, ["config:read", "auth:revoke"]);
    }).toThrow(MissingScopeError);
  });

  it("accepts multiple present scopes", () => {
    expect(() => {
      requireScopes({ subject: "a", scopes: ["config:read", "auth:revoke"] }, [
        "config:read",
        "auth:revoke"
      ]);
    }).not.toThrow();
  });
});

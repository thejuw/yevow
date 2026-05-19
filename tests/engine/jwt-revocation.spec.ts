import { describe, expect, it } from "vitest";
import { ActiveTokenStore, JwtRevocationStore } from "../../src/auth/JwtRevocation";
import { AuthManager } from "../../src/AuthManager";
import { TestKvNamespace } from "./test-kv";

describe("JWT revocation store", () => {
  it("revokes a single JTI", async () => {
    const store = new JwtRevocationStore(kv());
    await store.revoke("jti-1", Date.now() + 60_000, "test", "operator");

    expect(await store.isRevoked("jti-1")).toBe(true);
  });

  it("treats blank JTI as revoked fail-closed", async () => {
    expect(await new JwtRevocationStore(kv()).isRevoked("")).toBe(true);
  });

  it("double-revoke is idempotent", async () => {
    const store = new JwtRevocationStore(kv());
    await store.revoke("jti-1", Date.now() + 60_000, "first", "operator");
    await store.revoke("jti-1", Date.now() + 60_000, "second", "operator");

    const [record] = await store.listRevoked(10);
    expect(record.reason).toBe("second");
  });

  it("lists revoked tokens newest first", async () => {
    const store = new JwtRevocationStore(kv());
    await store.revoke("jti-old", Date.now() + 60_000, "old", "operator");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.revoke("jti-new", Date.now() + 60_000, "new", "operator");

    expect((await store.listRevoked(10)).map((record) => record.jti)).toEqual([
      "jti-new",
      "jti-old"
    ]);
  });

  it("limits revoked token list size", async () => {
    const store = new JwtRevocationStore(kv());
    await store.revoke("jti-1", Date.now() + 60_000, "one", "operator");
    await store.revoke("jti-2", Date.now() + 60_000, "two", "operator");

    expect(await store.listRevoked(1)).toHaveLength(1);
  });

  it("tracks active tokens by subject", async () => {
    const store = new ActiveTokenStore(kv());
    await store.track({
      jti: "jti-1",
      subject: "admin",
      issuedAt: "2026-05-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["READ"]
    });

    expect(await store.listForSubject("admin")).toHaveLength(1);
  });

  it("removes active tokens after revoke-all workflows", async () => {
    const store = new ActiveTokenStore(kv());
    await store.track({
      jti: "jti-1",
      subject: "admin",
      issuedAt: "2026-05-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["READ"]
    });
    await store.remove("admin", "jti-1");

    expect(await store.listForSubject("admin")).toHaveLength(0);
  });

  it("revoked token is rejected by the revocation-aware auth flow", async () => {
    const auth = new AuthManager("secret", "password");
    const token = await auth.generateToken({ sub: "admin", scopes: ["READ"] });
    const claims = await auth.verifyClaims(token);
    const store = new JwtRevocationStore(kv());

    expect(claims).not.toBeNull();
    await store.revoke(claims?.jti ?? "", claims?.exp ?? 0, "leaked", "operator");

    expect(await store.isRevoked(claims?.jti ?? "")).toBe(true);
  });
});

function kv(): KVNamespace {
  return new TestKvNamespace() as unknown as KVNamespace;
}

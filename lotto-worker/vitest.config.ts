import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    decodeURIComponent(new URL("./migrations", import.meta.url).pathname)
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            RABBITHOLETX_SERVICE_TOKEN: "test-service-token",
            RABBITHOLETX_SEED_SALT: "test-only-seed-salt-at-least-32-bytes"
          }
        }
      })
    ],
    test: {
      include: ["test/**/*.test.ts"],
      mockReset: true,
      restoreMocks: true,
      setupFiles: ["./test/setup.ts"]
    }
  };
});

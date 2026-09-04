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
          bindings: { TEST_MIGRATIONS: migrations }
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

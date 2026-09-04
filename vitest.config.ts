import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/engine/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/strategy/cascade/**/*.ts", "src/engine/**/*.ts", "src/execution/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        // Ratchet from the measured full-suite baseline; do not permit branch
        // coverage to regress while the legacy engine climbs back toward 80%.
        branches: 69,
        statements: 80
      }
    },
    pool: "threads",
    reporters: ["default"]
  }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/engine/**/*.spec.ts"],
    pool: "threads",
    reporters: ["default"]
  }
});

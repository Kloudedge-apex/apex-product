import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: "./src",
    environment: "node",
    include: ["**/*.spec.ts"],
    setupFiles: ["../vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["**/*.service.ts", "**/*.controller.ts"],
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    environment: "node",
    include: ["src/**/*.spec.ts", "datasets/**/*.spec.ts"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.service.ts", "src/**/*.controller.ts"],
    },
  },
});

import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@tests": path.resolve(__dirname, "tests"),
      "server-only": path.resolve(__dirname, "tests/server-only.ts")
    }
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    clearMocks: true,
    restoreMocks: true
  }
});

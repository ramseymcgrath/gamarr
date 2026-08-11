import { defineConfig, devices } from "@playwright/test";

const databasePath = `${process.cwd()}/test-results/e2e/gamarr.db`;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"] }
  }],
  webServer: [{
    command: "pnpm exec tsx tests/provider-server/server.ts",
    url: "http://127.0.0.1:4100/health",
    reuseExistingServer: false,
    timeout: 30_000
  }, {
    command: "pnpm dev --hostname 127.0.0.1 --port 3200",
    url: "http://127.0.0.1:3200/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      GAMARR_DATABASE_PATH: databasePath,
      GAMARR_ALLOWED_ORIGINS: "http://127.0.0.1:3200",
      GAMARR_E2E: "true",
      GAMARR_TWITCH_TOKEN_URL: "http://127.0.0.1:4100/oauth2/token",
      GAMARR_IGDB_BASE_URL: "http://127.0.0.1:4100/v4",
      GAMARR_PROWLARR_BASE_URL: "http://127.0.0.1:4100"
    }
  }]
});

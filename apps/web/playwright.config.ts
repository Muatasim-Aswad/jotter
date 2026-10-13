import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  reporter: "line",
  outputDir: process.env.JOTTER_PLAYWRIGHT_OUTPUT ?? ".verify/playwright",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      'JOTTER_LISTEN_ADDR=127.0.0.1:4173 JOTTER_PUBLIC_ORIGIN=http://127.0.0.1:4173 AUTH_DISABLED=true JOTTER_DATA_DIR="$PWD/${JOTTER_PLAYWRIGHT_OUTPUT:-.verify/D1-results}/data" ../../.build/jotter',
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

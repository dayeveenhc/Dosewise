import { defineConfig, devices } from "@playwright/test";

// E2E against the already-running Vite dev server on :5173 (started outside
// Playwright per the repo's dev/POST workflow — we don't manage it here).
// Headless Chromium; screenshots are captured explicitly in-test so a passing
// run still leaves evidence under e2e/artifacts.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "./e2e/artifacts",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    viewport: { width: 430, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

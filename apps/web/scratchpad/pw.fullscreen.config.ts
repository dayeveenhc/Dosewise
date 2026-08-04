import { defineConfig, devices } from "@playwright/test";

// Same manual-test setup as pw.config.ts, but the browser window itself is
// maximized (viewport: null so Playwright doesn't clip to a fixed phone size —
// the app's own phone-frame chrome still centers itself inside the window).
export default defineConfig({
  testDir: ".",
  testMatch: /(shot|undo|doctorq|nextdose|navshot|chatshot|refill|supply|walkshot|setshot|bubbleshot|homeshot|rxshot|gateshot)\.spec\.ts/,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "./pw-artifacts",
  timeout: 240_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: false,
    viewport: null,
    launchOptions: { args: ["--start-maximized"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

import { defineConfig, devices } from "@playwright/test";

// Scratch config for visual sweeps only (not part of the e2e gate).
export default defineConfig({
  testDir: ".",
  testMatch: /(shot|undo|doctorq|nextdose|navshot|chatshot|refill|supply|walkshot|setshot|bubbleshot|homeshot|rxshot)\.spec\.ts/,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "./pw-artifacts",
  timeout: 240_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    viewport: { width: 460, height: 940 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

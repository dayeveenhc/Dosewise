import { defineConfig, devices } from "@playwright/test";

// Scratch config for visual sweeps only (not part of the e2e gate).
export default defineConfig({
  testDir: ".",
  testMatch: /(shot|undo|doctorq|nextdose|navshot|chatshot|refill|supply|walkshot|setshot|bubbleshot|homeshot|rxshot|gateshot|spotlightfix|confirmphase|trustmode|item4visual|item6idle|liftdiag|presspulse|spotlight-frames|idlenav|highlight-sweep|voice-live|risk-thread|statusbar)\.spec\.ts/,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "./pw-artifacts",
  timeout: 240_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    viewport: { width: 460, height: 940 },
  },
  // viewport is repeated here on purpose. The `devices["Desktop Chrome"]`
  // spread carries its own 1280x720 viewport, and a PROJECT-level `use`
  // overrides the top-level one — so the 460x940 above was silently ignored.
  // The overlay frame is 832px tall, so every target below ~720px sat outside
  // the viewport and `document.elementFromPoint` returned null: the geometry
  // sweep's occlusion check was quietly skipped on 14 of 21 tasks (every
  // bottom-nav target) while still reporting them as findings.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 460, height: 940 } } }],
});

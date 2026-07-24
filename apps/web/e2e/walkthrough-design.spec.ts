import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough } from "./helpers";

// Design-capture: film each autonomous walkthrough step-by-step so the callout,
// spotlight, and reveal caption can be reviewed for professionalism (no overlap,
// clean alignment, readable pacing). Captures a frame every FRAME_MS while the
// walkthrough runs, into e2e/artifacts/walkthrough-design/<task>/frame-NN.png.
// Not an assertion test — it exists to produce evidence for design review.

const TASKS = ["add_prescription_auto", "edit_profile_auto", "add_condition_auto", "travel_mode_auto"];
const FRAME_MS = 1300;
const FRAMES = 22;

for (const task of TASKS) {
  test(`film ${task}`, async ({ page }) => {
    test.setTimeout(120_000);
    // Outside Playwright's outputDir (./e2e/artifacts, which it wipes each run)
    // so the filmstrip survives subsequent test runs.
    const dir = `e2e/design-shots/${task}`;
    mkdirSync(dir, { recursive: true });
    const creds = await createThrowawayElder();
    await signIn(page, creds);
    await startWalkthrough(page, task);

    for (let i = 0; i < FRAMES; i++) {
      await page.screenshot({ path: `${dir}/frame-${String(i).padStart(2, "0")}.png` });
      await page.waitForTimeout(FRAME_MS);
    }
  });
}

import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough, tapWalkthroughNext, walkthroughStep } from "../e2e/helpers";

// Diagnosis-only (no assertions): the plan requires MEASURING before fixing
// the Confirm-step callout/Save overlap, because `liftDecidedRef`'s one-shot
// is deliberate — Walkthrough.tsx:312-318 says re-deriving the lift from a
// LATER, already-lifted rect would oscillate. So the question is not "should
// it re-run" but "what did calloutHeight look like at the instant it latched,
// versus once the review card had actually rendered".
//
// Records, at ~every animation frame across the Confirm step:
//   - the callout's live offsetHeight (what calloutHeight becomes)
//   - the lifted group's inline transform (when the lift latched, and to what)
//   - the target's live rect
// so the latch-time and settled values can simply be read off the timeline.

const OUT = "scratchpad/shots/liftdiag.json";

test("diagnose: calloutHeight at lift-latch vs settled on the Confirm step", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  // Start the sampler BEFORE the walkthrough so the very first frame of every
  // step is captured — the latch happens within a frame or two of a step's
  // first successful measurement.
  await page.evaluate(() => {
    const w = window as unknown as { __samples: unknown[]; __sampling: boolean };
    w.__samples = [];
    w.__sampling = true;
    const tick = () => {
      if (!w.__sampling) return;
      const root = document.querySelector('[class*="z-[200]"]') as HTMLElement | null;
      if (root) {
        const o = root.getBoundingClientRect();
        const counter = [...root.querySelectorAll("p")]
          .find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
        const callout = counter?.closest("div[class*='rounded-2xl']") as HTMLElement | null;
        const lifted = [...document.querySelectorAll<HTMLElement>("[data-walk]")]
          .find(el => /translateY|matrix/.test(el.style.transform || ""));
        const maskRect = root.querySelector('mask rect[fill="black"]') as SVGRectElement | null;
        w.__samples.push({
          t: Math.round(performance.now()),
          step: counter?.textContent?.trim() ?? null,
          containerHeight: Math.round(o.height),
          calloutHeight: callout ? Math.round(callout.offsetHeight) : null,
          calloutTop: callout ? Math.round(callout.getBoundingClientRect().top - o.top) : null,
          liftedSelector: lifted?.dataset.walk ?? null,
          liftTransform: lifted?.style.transform ?? null,
          cutoutY: maskRect ? Math.round(Number.parseFloat(maskRect.getAttribute("y") || "0")) : null,
          cutoutH: maskRect ? Math.round(Number.parseFloat(maskRect.getAttribute("height") || "0")) : null,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await startWalkthrough(page, "add_prescription_auto", {
    name: "Lisinopril", dose: "10mg", purpose: "blood pressure",
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
    null, { timeout: 20_000 },
  );

  // Walk to the Confirm step (step 5 of add_prescription_auto: the recap).
  for (let i = 0; i < 5; i++) {
    const at = await walkthroughStep(page);
    if (!at || at.current >= 5) break;
    try { await tapWalkthroughNext(page, 30_000); } catch { break; }
  }
  await page.waitForTimeout(4_000); // let the Confirm step fully settle

  const samples = await page.evaluate(() => {
    const w = window as unknown as { __samples: unknown[]; __sampling: boolean };
    w.__sampling = false;
    return w.__samples;
  });
  writeFileSync(OUT, JSON.stringify(samples, null, 2));

  type S = {
    t: number; step: string | null; containerHeight: number; calloutHeight: number | null;
    calloutTop: number | null; liftedSelector: string | null; liftTransform: string | null;
    cutoutY: number | null; cutoutH: number | null;
  };
  const all = samples as S[];
  console.log(`[DIAG] ${all.length} frames captured -> ${OUT}`);

  // Where did the lift first appear, and what was calloutHeight at that frame?
  const firstLift = all.findIndex(s => !!s.liftTransform);
  if (firstLift < 0) {
    console.log("[DIAG] no target lift ever latched in this run");
  } else {
    const latch = all[firstLift];
    const settled = all[all.length - 1];
    console.log(`[DIAG] lift latched at t=${latch.t} on [data-walk="${latch.liftedSelector}"] -> ${latch.liftTransform}`);
    console.log(`[DIAG]   calloutHeight AT LATCH   = ${latch.calloutHeight} (step ${latch.step}, container ${latch.containerHeight})`);
    console.log(`[DIAG]   calloutHeight SETTLED    = ${settled.calloutHeight} (step ${settled.step})`);
    const maxH = Math.max(...all.filter(s => s.calloutHeight != null).map(s => s.calloutHeight!));
    console.log(`[DIAG]   calloutHeight MAX seen   = ${maxH}`);
    console.log(`[DIAG]   delta latch -> settled   = ${(settled.calloutHeight ?? 0) - (latch.calloutHeight ?? 0)}`);
  }

  // Distinct callout heights per step, so the growth is attributable.
  const byStep = new Map<string, Set<number>>();
  for (const s of all) {
    if (!s.step || s.calloutHeight == null) continue;
    if (!byStep.has(s.step)) byStep.set(s.step, new Set());
    byStep.get(s.step)!.add(s.calloutHeight);
  }
  for (const [step, heights] of byStep) {
    console.log(`[DIAG] ${step}: calloutHeight values ${[...heights].sort((a, b) => a - b).join(", ")}`);
  }
});

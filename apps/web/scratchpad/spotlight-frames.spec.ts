import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createThrowawayElder, signIn } from "../e2e/helpers";

/**
 * Per-frame spotlight sampler — the two defects `highlight-sweep.spec.ts` is
 * STRUCTURALLY unable to see.
 *
 * The sweep gates on `measureSettled` (two identical samples ≥400ms apart), so
 * by construction it only ever describes resting states. Two things the user's
 * "not accurate and very off centering" report could be are invisible to it:
 *
 *   1. GLUE LAG. Walkthrough.tsx re-measures the target every frame but pushes
 *      the result through React state before it reaches the SVG mask. If that
 *      round trip ever drops or defers an update, the hole trails the target.
 *      A settled 3.0px offset — exactly `.walk-field-prehighlight`'s
 *      translateY(-3px) — is already on record in
 *      scratchpad/shots/sweep/report.json for steps 2 and 4 of
 *      add_prescription_auto, which is what this spec exists to explain.
 *
 *   2. TRANSITION DESYNC. SpotlightCallout carries
 *      `transition-[top] duration-300`, so on every step change the card
 *      ANIMATES to its new position while the cutout JUMPS. During that window
 *      the callout can sit across the very target it is describing. A settled
 *      sampler can never catch it; what matters is how many ms it lasts.
 *
 * Runs in AUTO nav deliberately (it does NOT call helpers' startWalkthrough,
 * which forces step-by-step): tapping Next between assertions would add idle
 * gaps and, past IDLE_TIMEOUT_MS, the "still there?" popup. Auto gives one
 * continuous, uninterrupted frame series across every step.
 *
 * Reporting only — no assertions. This measures; the fix is decided from what
 * it says.
 *
 *   npx playwright test --config=scratchpad/pw.config.ts scratchpad/spotlight-frames.spec.ts
 */

const OUT = "scratchpad/shots/spotlight-frames.json";
// Same inflation Walkthrough.tsx applies to the primary mask rect. Duplicated
// on purpose (as highlight-sweep.spec.ts duplicates its own constants): an
// independent copy is what makes this a check rather than a tautology.
const PRIMARY_INFLATE = 6;
// Below this, a gap is sub-pixel layout jitter plus the component's own 0.5px
// `sameBox` epsilon, not a lag.
const LAG_TOL = 2;

interface Frame {
  t: number;
  step: string | null;
  targetTop: number;
  targetH: number;
  cutY: number | null;
  cutH: number | null;
  calloutTop: number | null;
  calloutH: number | null;
  transform: string;
  prehighlight: boolean;
}

test("spotlight: does the cutout actually stay glued, and how long does the callout sit on its target?", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  await page.evaluate(() => {
    const w = window as unknown as { __f: unknown[]; __on: boolean };
    w.__f = [];
    w.__on = true;
    // Resolve the overlay root FROM the live step counter, never the first
    // z-[200] element — both shells can carry several such layers, and picking
    // the wrong one is a documented way to manufacture a fake 300px finding.
    const counter = () =>
      [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
    const tick = () => {
      if (!w.__on) return;
      const c = counter();
      const root = c?.closest('[class*="z-[200]"]') as HTMLElement | null;
      if (root && c) {
        const o = root.getBoundingClientRect();
        const cut = root.querySelector('mask rect[fill="black"]') as SVGRectElement | null;
        const card = c.closest("div[class*='rounded-2xl']") as HTMLElement | null;
        const cardR = card?.getBoundingClientRect();
        // The lifted/pre-highlighted element, whichever the engine is touching
        // this frame — that is what has to stay under the hole.
        const marked = document.querySelector<HTMLElement>(".walk-field-prehighlight");
        const lifted = [...document.querySelectorAll<HTMLElement>("[data-walk]")]
          .find(n => n.style.transform.includes("translateY"));
        const target = marked ?? lifted;
        const tr = target?.getBoundingClientRect();
        w.__f.push({
          t: Math.round(performance.now()),
          step: c.textContent?.trim() ?? null,
          targetTop: tr ? +(tr.top - o.top).toFixed(2) : NaN,
          targetH: tr ? +tr.height.toFixed(2) : NaN,
          cutY: cut ? +Number.parseFloat(cut.getAttribute("y") || "0").toFixed(2) : null,
          cutH: cut ? +Number.parseFloat(cut.getAttribute("height") || "0").toFixed(2) : null,
          calloutTop: cardR ? +(cardR.top - o.top).toFixed(2) : null,
          calloutH: cardR ? +cardR.height.toFixed(2) : null,
          transform: target ? (target.style.transform || getComputedStyle(target).transform) : "",
          prehighlight: !!marked,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Raw dev hook, NOT helpers' startWalkthrough — that one forces step-by-step.
  await page.evaluate(() => {
    (window as unknown as { __dwStartWalkthrough: (t: string, p?: Record<string, string>) => void })
      .__dwStartWalkthrough("add_prescription_auto", {
        name: "Lisinopril", dose: "10mg", purpose: "blood pressure",
      });
  });

  // Long enough to carry the fill steps and reach the lifted Confirm step —
  // the one MEMORY records as never having been frame-sampled.
  await page.waitForTimeout(45_000);
  await page.screenshot({ path: "scratchpad/shots/spotlight-frames-end.png", fullPage: false });

  const frames = (await page.evaluate(() => {
    const w = window as unknown as { __f: unknown[]; __on: boolean };
    w.__on = false;
    return w.__f;
  })) as Frame[];
  writeFileSync(OUT, JSON.stringify(frames, null, 2));

  const usable = frames.filter(f => f.cutY != null && Number.isFinite(f.targetTop));
  console.log(`[FRAMES] ${frames.length} sampled, ${usable.length} with both a cutout and a resolvable target`);
  if (!usable.length) {
    console.log("[FRAMES] nothing to measure — the run never reached a spotlighted step");
    return;
  }

  // --- 1. Glue lag, per step -------------------------------------------------
  const byStep = new Map<string, Frame[]>();
  for (const f of usable) byStep.set(f.step ?? "?", [...(byStep.get(f.step ?? "?") ?? []), f]);

  console.log("\n[FRAMES] glue lag — |cutY - (targetTop - 6)| per step:");
  for (const [stepLabel, fs] of byStep) {
    const lags = fs.map(f => Math.abs(f.cutY! - (f.targetTop - PRIMARY_INFLATE)));
    const max = Math.max(...lags);
    const over = lags.filter(l => l > LAG_TOL).length;
    // The load-bearing number: a LONG run of frames above tolerance is a stale
    // rect. A short burst is the cutout tracking a real in-flight animation,
    // which is correct behaviour.
    let run = 0, worstRun = 0;
    for (const l of lags) { run = l > LAG_TOL ? run + 1 : 0; worstRun = Math.max(worstRun, run); }
    const settled = fs.slice(-15).map(f => Math.abs(f.cutY! - (f.targetTop - PRIMARY_INFLATE)));
    const settledMax = settled.length ? Math.max(...settled) : 0;
    console.log(
      `  ${stepLabel.padEnd(14)} frames=${String(fs.length).padStart(4)}  max=${max.toFixed(2)}px  ` +
      `over-${LAG_TOL}px=${over}  longest-run=${worstRun}  last-15-frames-max=${settledMax.toFixed(2)}px`,
    );
    if (settledMax > LAG_TOL) {
      const f = fs[fs.length - 1];
      console.log(`     ^ RESTING OFFSET — cutY=${f.cutY} targetTop=${f.targetTop} prehighlight=${f.prehighlight} transform=${f.transform}`);
    }
  }

  // --- 2. Callout sitting on its own target ----------------------------------
  const overlapping = usable.filter(f =>
    f.calloutTop != null && f.calloutH != null
    && f.calloutTop < f.targetTop + f.targetH
    && f.calloutTop + f.calloutH > f.targetTop);
  if (!overlapping.length) {
    console.log("\n[FRAMES] callout never intersected its own target");
  } else {
    // Contiguous windows, so a 300ms transition reads differently from a
    // permanent overlap.
    const windows: Array<{ from: number; to: number; step: string | null }> = [];
    for (const f of overlapping) {
      const last = windows[windows.length - 1];
      if (last && f.t - last.to < 120) last.to = f.t;
      else windows.push({ from: f.t, to: f.t, step: f.step });
    }
    console.log(`\n[FRAMES] callout intersected its target in ${windows.length} window(s):`);
    for (const wn of windows) {
      const ms = wn.to - wn.from;
      console.log(`  ${wn.step} — ${ms}ms ${ms > 600 ? "(PERSISTENT, not a transition)" : "(transient)"}`);
    }
  }
});

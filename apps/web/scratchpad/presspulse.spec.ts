import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough } from "../e2e/helpers";

// The one visual the settle-gated sweep is structurally blind to.
// actor.ts::pressPulse sets `transform: scale(0.94)` on the target for ~460ms
// around every click act. Now that the cutout follows the target every frame,
// it follows that scale too — which could read either as the spotlight
// pressing WITH the button (good) or as a pumping box (bad). measureSettled
// can never catch it, so sample every frame through step 1's click act and
// report the real amplitude, plus a screenshot at peak compression.
const OUT = "scratchpad/shots/presspulse.json";

test("press-pulse: how far does the cutout actually breathe during a click act?", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  await page.evaluate(() => {
    const w = window as unknown as { __s: unknown[]; __on: boolean };
    w.__s = []; w.__on = true;
    const tick = () => {
      if (!w.__on) return;
      const root = document.querySelector('[class*="z-[200]"]') as HTMLElement | null;
      const el = document.querySelector('[data-tour="elder-add-prescription"]') as HTMLElement | null;
      if (root && el) {
        const o = root.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const cut = root.querySelector('mask rect[fill="black"]') as SVGRectElement | null;
        w.__s.push({
          t: Math.round(performance.now()),
          targetTop: +(r.top - o.top).toFixed(2), targetH: +r.height.toFixed(2),
          cutY: cut ? +Number.parseFloat(cut.getAttribute("y") || "0").toFixed(2) : null,
          cutH: cut ? +Number.parseFloat(cut.getAttribute("height") || "0").toFixed(2) : null,
          transform: el.style.transform || getComputedStyle(el).transform,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await startWalkthrough(page, "add_prescription_auto", {
    name: "Lisinopril", dose: "10mg", purpose: "blood pressure",
  });
  // Step 1 IS a click act on the add-prescription button — pressPulse fires
  // inside it. Sample across the whole pre-click + press window.
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "scratchpad/shots/presspulse-midpress.png" });
  await page.waitForTimeout(1_500);

  const samples = await page.evaluate(() => {
    const w = window as unknown as { __s: unknown[]; __on: boolean };
    w.__on = false;
    return w.__s;
  });
  writeFileSync(OUT, JSON.stringify(samples, null, 2));

  type S = { t: number; targetTop: number; targetH: number; cutY: number | null; cutH: number | null; transform: string };
  const all = (samples as S[]).filter(s => s.cutH != null);
  if (!all.length) { console.log("[PRESS] no samples with a cutout"); return; }
  const heights = all.map(s => s.cutH!);
  const minH = Math.min(...heights), maxH = Math.max(...heights);
  const scaled = all.filter(s => /scale|matrix/.test(s.transform) && !/matrix\(1, 0, 0, 1/.test(s.transform));
  // Does the cutout stay ON the target throughout, including mid-press?
  const worst = all.reduce((w, s) => {
    const dy = Math.abs((s.targetTop - 6) - s.cutY!);
    return dy > w.dy ? { dy, s } : w;
  }, { dy: 0, s: all[0] });

  // SCOPE THE HEADLINE TO THE PRESS. This spec samples one FIXED element
  // ([data-tour="elder-add-prescription"]) for a fixed 4s, but step 1 is a
  // click act whose gate collapses into step 2 — so once the run advances, the
  // cutout is on the NAME FIELD while these frames still measure step 1's
  // button. Reporting whole-window numbers made that read as a 6.25px pump and
  // a 40.59px drift when the press itself measured 0.00px and 0.36px. The
  // question this file exists to answer is only about the press window.
  const pressFrames = scaled.length
    ? all.filter(s => s.t >= scaled[0].t && s.t <= scaled[scaled.length - 1].t)
    : [];
  const pressStats = (rows: S[]) => {
    if (!rows.length) return null;
    const hs = rows.map(r => r.cutH!);
    const dy = Math.max(...rows.map(r => Math.abs((r.targetTop - 6) - r.cutY!)));
    return { amp: Math.max(...hs) - Math.min(...hs), dy };
  };
  const press = pressStats(pressFrames);

  console.log(`[PRESS] ${all.length} frames sampled; ${scaled.length} carry a scale transform on the target`);
  if (press) {
    console.log(`[PRESS] === DURING THE PRESS (${pressFrames.length} frames) ===`);
    console.log(`[PRESS]   cutout height amplitude: ${press.amp.toFixed(2)}px   worst cutout-vs-target dy: ${press.dy.toFixed(2)}px`);
    console.log(`[PRESS]   ^ these are the numbers that answer "does pressPulse make the cutout pump?"`);
  } else {
    console.log("[PRESS] no frames carried a scale transform — the click act was missed entirely");
  }
  console.log(`[PRESS] (whole 4s window, SPANS a step advance — not a pump measurement: height ${minH} → ${maxH}, worst dy ${worst.dy.toFixed(2)}px at t=${worst.s.t} transform=${worst.s.transform})`);
});

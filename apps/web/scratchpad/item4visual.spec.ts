import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough, tapWalkthroughNext, walkthroughStep } from "../e2e/helpers";

// Item 4 (SpotlightVisual-Fix) independent live verification — Phase C evidence:
// multiple field positions on Add Medication (incl. a field near the bottom of
// the walkthrough's own scope), cutout alignment, the drop-shadow lift (vs the
// old ring, confirmed via `git show HEAD:src/styles/theme.css`), scrim opacity,
// bottom-of-viewport target repositioning, and the mid-navigate transition.
// Independent of scratchpad/spotlightfix.spec.ts (Aug 3 repro probe, only 2
// shots, no Phase C coverage) — this file supersedes it for verification
// purposes but does not delete it.

const SHOTS = "scratchpad/shots";

// Item 6 (IdleTimeout, verified separately/live this same pass) fires a
// full-screen "still there?" popup after 20s of zero interaction during a
// genuine tap-gated wait — real product behavior, not a bug (see
// trustmode.spec.ts's own copy of this same helper for the full writeup).
// Test 3 below drives 5+ sequential Next taps across a full walkthrough with
// real assertion/logging overhead between them, which is exactly the shape
// that can genuinely idle past 20s. Dismiss it the way a real person would.
function autoDismissIdlePopup(page: import("@playwright/test").Page): () => void {
  let stop = false;
  void (async () => {
    while (!stop) {
      const popup = page.locator('[data-walk="walk-idle-popup"]');
      if (await popup.isVisible().catch(() => false)) {
        await popup.getByRole("button", { name: /continue/i }).click({ timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(500).catch(() => {});
    }
  })();
  return () => { stop = true; };
}

async function measureCutout(page: import("@playwright/test").Page, targetSelector: string) {
  return page.evaluate((sel) => {
    const overlayRoot = document.querySelector('[class*="z-[200]"]') as HTMLElement | null;
    const target = document.querySelector(sel) as HTMLElement | null;
    if (!overlayRoot || !target) return null;
    const origin = overlayRoot.getBoundingClientRect();
    const real = target.getBoundingClientRect();
    const cutout = overlayRoot.querySelector('mask rect[fill="black"]') as SVGRectElement | null;
    const scrimRect = overlayRoot.querySelector('svg > rect[mask]') as SVGRectElement | null;
    const fieldGroup = target.closest("[data-walk]") as HTMLElement | null;
    const cs = getComputedStyle(target);
    const groupCs = fieldGroup ? getComputedStyle(fieldGroup) : null;
    return {
      originTop: origin.top, originLeft: origin.left,
      realTop: real.top, realLeft: real.left, realWidth: real.width, realHeight: real.height,
      cutoutX: cutout ? Number.parseFloat(cutout.getAttribute("x") || "") : null,
      cutoutY: cutout ? Number.parseFloat(cutout.getAttribute("y") || "") : null,
      scrimFill: scrimRect?.getAttribute("fill") ?? null,
      targetHasPrehighlightClass: target.classList.contains("walk-field-prehighlight"),
      targetBoxShadow: cs.boxShadow,
      targetTransform: cs.transform,
      groupInlineTransform: fieldGroup?.style.transform || null,
    };
  }, targetSelector);
}

test("Item4 1/3: field-position sweep (incl. bottom field), lift, scrim, target repositioning", async ({ page }) => {
  // Same reason test 3/3 already arms this: 5+ sequential Next taps with real
  // measurement between them genuinely idles past IDLE_TIMEOUT_MS, and the
  // popup's backdrop then intercepts the next click.
  const stopIdleWatcher1 = autoDismissIdlePopup(page);
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  await startWalkthrough(page, "add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" });

  const nextBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
  await expect(nextBtn, "step 1 (open) has a gate").toBeVisible({ timeout: 15_000 });

  // The Next/Done button renders on EVERY autonomous phase (disabled until
  // its floor elapses) — including the "navigate" phase, BEFORE the target
  // has even been measured. So "gate visible" alone races Walkthrough's own
  // measurement (found live: step1's real rect landed AFTER this button was
  // already visible, since step1 also carries onEnter -> a 900ms navigate
  // settle runs first). Wait for the mask SVG itself before measuring.
  await page.waitForFunction(
    () => !!document.querySelector('[class*="z-[200]"] svg mask rect[fill="black"]'),
    null, { timeout: 10_000 },
  );

  // ── Step 1: open (target `elder-add-prescription`, the tile that opens the
  // sheet — top-of-screen, a control the person is NOT filling text into). ──
  const m1 = await measureCutout(page, '[data-tour="elder-add-prescription"]');
  console.log("[ITEM4] step1 (open):", JSON.stringify(m1));
  expect(m1, "step1 measured").not.toBeNull();
  expect(m1!.scrimFill, "scrim is the light 0.4 opacity, not GuidedTour's heavier 0.75").toBe("rgba(0,0,0,0.4)");
  if (m1!.cutoutX !== null) {
    const dx = Math.abs((m1!.realLeft - m1!.originLeft - 6) - m1!.cutoutX!);
    const dy = Math.abs((m1!.realTop - m1!.originTop - 6) - m1!.cutoutY!);
    expect(dx, "step1 cutout X aligns with the real rect (zoom boundary OK)").toBeLessThan(2);
    expect(dy, "step1 cutout Y aligns with the real rect").toBeLessThan(2);
  }
  await page.screenshot({ path: `${SHOTS}/item4-field-1-open.png`, fullPage: true });
  await tapWalkthroughNext(page);

  // ── Step 2: name (first real fill field — top of the sheet). Capture DURING
  // the pre-highlight window (FIELD_PREHIGHLIGHT_MS=600ms) so the lift class is
  // actually applied when we screenshot/measure. ──
  await page.waitForSelector('[data-walk="rx-name"] input.walk-field-prehighlight', { timeout: 10_000 }).catch(() => {});
  const m2 = await measureCutout(page, '[data-walk="rx-name"] input');
  console.log("[ITEM4] step2 (name, fill field):", JSON.stringify(m2));
  expect(m2, "step2 measured").not.toBeNull();
  expect(m2!.targetHasPrehighlightClass, "name field carries the lift class during its pre-highlight window").toBe(true);
  // walk-lift-in's end frame is translateY(-3px) — any non-"none" 2D matrix
  // confirms the lift transform actually applied (not just the box-shadow).
  expect(m2!.targetTransform, "name field has a real transform (the lift), not 'none'").not.toBe("none");
  if (m2!.cutoutX !== null) {
    const dx = Math.abs((m2!.realLeft - m2!.originLeft - 6) - m2!.cutoutX!);
    const dy = Math.abs((m2!.realTop - m2!.originTop - 6) - m2!.cutoutY!);
    expect(dx, "step2 cutout X aligns with the real rect (outside the zoom div)").toBeLessThan(2);
    expect(dy, "step2 cutout Y aligns with the real rect").toBeLessThan(2);
  }
  await page.screenshot({ path: `${SHOTS}/item4-field-2-name-lift.png`, fullPage: true });
  await tapWalkthroughNext(page);

  // ── Step 3: dose ──
  await page.waitForSelector('[data-walk="rx-dose"].walk-field-prehighlight', { timeout: 10_000 }).catch(() => {});
  const m3 = await measureCutout(page, '[data-walk="rx-dose"]');
  console.log("[ITEM4] step3 (dose):", JSON.stringify(m3));
  await page.screenshot({ path: `${SHOTS}/item4-field-3-dose.png`, fullPage: true });
  await tapWalkthroughNext(page);

  // ── Step 4: purpose — the LAST/lowest fill field in this walkthrough's own
  // scope (name -> dose -> purpose, top to bottom of the sheet body), i.e. the
  // "field near the bottom of the form" this task asks to check specifically. ──
  await page.waitForSelector('[data-walk="rx-purpose"] input.walk-field-prehighlight', { timeout: 10_000 }).catch(() => {});
  // Unlike steps 2-3, this field is low enough in the sheet's scrollable body
  // that Mei's own scrollIntoView (actor.ts) fires to bring it into view —
  // the cutout's scroll-triggered recompute (Walkthrough.tsx) is itself
  // rAF-throttled, so measuring in the SAME instant the prehighlight class
  // lands can catch a real but MOMENTARY lag mid-scroll, not a genuine
  // misalignment. Poll briefly for the delta to settle before asserting.
  let m4 = await measureCutout(page, '[data-walk="rx-purpose"] input');
  for (let i = 0; i < 10 && m4?.cutoutX !== null; i++) {
    const dxNow = Math.abs((m4!.realLeft - m4!.originLeft - 6) - m4!.cutoutX!);
    const dyNow = Math.abs((m4!.realTop - m4!.originTop - 6) - m4!.cutoutY!);
    if (dxNow < 2 && dyNow < 2) break;
    await page.waitForTimeout(100);
    m4 = await measureCutout(page, '[data-walk="rx-purpose"] input');
  }
  console.log("[ITEM4] step4 (purpose, LOWEST field in the sheet body):", JSON.stringify(m4));
  expect(m4, "step4 measured").not.toBeNull();
  if (m4!.cutoutX !== null) {
    const dx = Math.abs((m4!.realLeft - m4!.originLeft - 6) - m4!.cutoutX!);
    const dy = Math.abs((m4!.realTop - m4!.originTop - 6) - m4!.cutoutY!);
    console.log(`[ITEM4] step4 SETTLED cutout delta: (${dx.toFixed(1)}, ${dy.toFixed(1)}) px, groupInlineTransform=${m4!.groupInlineTransform}`);
    expect(dx, "step4 (bottom field) cutout X aligns once scroll settles").toBeLessThan(2);
    expect(dy, "step4 (bottom field) cutout Y aligns once scroll settles").toBeLessThan(2);
  }
  await page.screenshot({ path: `${SHOTS}/item4-field-4-purpose-bottom.png`, fullPage: true });
  await tapWalkthroughNext(page);

  // ── Step 5: Confirm/review — tallest callout (review card), target is
  // rx-submit in the sheet's non-scrolling FOOTER (Theory B's own target).
  // This is where targetLiftPx is most likely to trigger, and where the old
  // footer/scroll-region overlap theory would show up if still broken. ──
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 15_000 });

  const measureConfirm = () => page.evaluate(() => {
    const overlayRoot = document.querySelector('[class*="z-[200]"]') as HTMLElement | null;
    const callout = overlayRoot?.querySelector(".shadow-xl") as HTMLElement | null;
    const submit = document.querySelector('[data-walk="rx-submit"]') as HTMLElement | null;
    const group = submit?.closest("[data-walk]") as HTMLElement | null;
    if (!callout || !submit) return null;
    const c = callout.getBoundingClientRect();
    const s = submit.getBoundingClientRect();
    return {
      calloutTop: c.top, calloutBottom: c.bottom, submitTop: s.top, submitBottom: s.bottom,
      overlapsSubmit: c.bottom > s.top && c.top < s.bottom,
      submitGroupInlineTransform: group?.style.transform || null,
    };
  });

  // calloutHeight (which the lift decision depends on) only stabilizes once
  // the review card has itself rendered+measured (its own live-DOM poll), so
  // the TARGET_LIFT_MS (320ms) transition can start well after "Please check
  // these details" first becomes visible. Poll on the transform STRING
  // itself staying unchanged across two reads, not a flat timeout, so this
  // doesn't depend on guessing the right number.
  let confirmMeasure = await measureConfirm();
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(150);
    const next = await measureConfirm();
    if (next?.submitGroupInlineTransform === confirmMeasure?.submitGroupInlineTransform) { confirmMeasure = next; break; }
    confirmMeasure = next;
  }
  console.log("[ITEM4] step5 SETTLED (confirm/review, footer target rx-submit):", JSON.stringify(confirmMeasure));
  expect(confirmMeasure, "confirm-step measurement present").not.toBeNull();
  await page.screenshot({ path: `${SHOTS}/item4-field-5-confirm-review.png`, fullPage: true });
  if (confirmMeasure!.overlapsSubmit) {
    console.warn(
      "[ITEM4] FINDING: even after the target-lift transition settled, the tall Confirm/review callout still " +
      "overlaps the Save button it describes (Theory B, footer/scroll-region mismatch) — see this task's report.",
    );
  }
  stopIdleWatcher1();
});

test("Item4 2/3: reduced-motion still shows a static lifted/shadowed end-state (not silently vanished)", async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });

  // Uses a fresh account+session since emulateMedia is sticky for the rest of
  // the page's life.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const creds2 = await createThrowawayElder();
  await signIn(page, creds2);
  await startWalkthrough(page, "add_prescription_auto", { name: "Metformin", dose: "500mg", purpose: "blood sugar" });
  await tapWalkthroughNext(page); // past "open"
  await page.waitForSelector('[data-walk="rx-name"] input.walk-field-prehighlight', { timeout: 10_000 }).catch(() => {});
  const reducedMotionCheck = await page.evaluate(() => {
    const el = document.querySelector('[data-walk="rx-name"] input') as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { animationDuration: cs.animationDuration, transform: cs.transform, boxShadow: cs.boxShadow };
  });
  console.log("[ITEM4] reduced-motion lift check:", JSON.stringify(reducedMotionCheck));
  await page.screenshot({ path: `${SHOTS}/item4-reduced-motion-lift.png` });
  expect(reducedMotionCheck, "reduced-motion check measured").not.toBeNull();
  // A static equivalent means the field still visibly lifts/shadows (non-empty
  // box-shadow/transform) WITHOUT relying on the animation actually running.
  expect(
    reducedMotionCheck!.boxShadow !== "none" || reducedMotionCheck!.transform !== "none",
    "reduced-motion still shows a static lifted/shadowed end-state, not a silently vanished cue",
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: null });
});

test("Item4 3/3: the Navigate phase is a visible transition, not an instant DOM swap (mid-transition screenshot)", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds3 = await createThrowawayElder();
  await signIn(page, creds3);
  const stopIdleWatcher = autoDismissIdlePopup(page);
  await startWalkthrough(page, "add_prescription_auto", { name: "Amlodipine", dose: "5mg", purpose: "blood pressure" });
  // Drive to the Submit waitFor step, tap it for real, then watch the reveal navigate.
  await tapWalkthroughNext(page); // open
  await tapWalkthroughNext(page); // name
  await tapWalkthroughNext(page); // dose
  await tapWalkthroughNext(page); // purpose
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 15_000 });
  await tapWalkthroughNext(page); // confirm recap tap (first-timer, tap-gated)
  const submitBtn = page.locator('[data-walk="rx-submit"]');
  await expect(submitBtn).toBeVisible({ timeout: 15_000 });
  await submitBtn.click();

  // Poll for the step counter to reach the reveal step (last of 6), then grab
  // a screenshot as fast as possible after — this is the mid-transition frame.
  await page.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
      const m = el?.textContent?.trim().match(/^Step (\d+) of (\d+)$/);
      return !!m && Number(m[1]) === Number(m[2]);
    },
    null, { timeout: 20_000 },
  );
  const navClassAtCapture = await page.evaluate(() => {
    const el = document.querySelector('[class*="dw-view-in"]');
    return el ? el.className : null;
  });
  await page.screenshot({ path: `${SHOTS}/item4-mid-navigate-transition.png`, fullPage: true });
  console.log("[ITEM4] mid-navigate transition — dw-view-in class present at capture:", navClassAtCapture);
  // Not a hard assert (a real animation frame is timing-sensitive to catch
  // exactly) — the screenshot + console evidence is the deliverable; log
  // loudly if the animation window was already missed so a re-run can retime.
  if (!navClassAtCapture) console.warn("[ITEM4] dw-view-in class not observed at capture time — transition may have already settled; see screenshot for the settled state instead.");
  stopIdleWatcher();
});

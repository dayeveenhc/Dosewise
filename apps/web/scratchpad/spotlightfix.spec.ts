import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";

// Item 4 (SpotlightVisual-Fix) repro-first probe — NOT a regression gate, just
// evidence-gathering for the two plausible-but-unconfirmed theories in the plan:
//   A. CSS-zoom-boundary: does the mask cutout misalign when step 1's target
//      (inside ElderlyApp's `zoom: contentZoom` div) differs from steps 2+
//      (inside AddPrescriptionSheet, a sibling OUTSIDE that div)?
//   B. Footer/scroll-region: does the confirm step's review callout overlap the
//      Save button (rx-submit, in AddPrescriptionSheet's non-scrolling footer)?
function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

// Read the mask cutout the component actually rendered vs. where its own math
// (recompute() in Walkthrough.tsx: real.rect minus overlay-root origin, minus a
// 6px pad) says it SHOULD be. A mismatch here is the zoom-boundary bug; a match
// says the theory doesn't reproduce for this target.
async function measureCutout(page: import("@playwright/test").Page, targetSelector: string) {
  return page.evaluate((sel) => {
    const overlayRoot = document.querySelector('[class*="z-[200]"]') as HTMLElement | null;
    const target = document.querySelector(sel) as HTMLElement | null;
    if (!overlayRoot || !target) return null;
    const origin = overlayRoot.getBoundingClientRect();
    const real = target.getBoundingClientRect();
    const cutout = overlayRoot.querySelector('mask rect[fill="black"]') as SVGRectElement | null;
    return {
      originTop: origin.top, originLeft: origin.left,
      realTop: real.top, realLeft: real.left, realWidth: real.width, realHeight: real.height,
      offsetWidth: target.offsetWidth, offsetHeight: target.offsetHeight,
      cutoutX: cutout ? Number.parseFloat(cutout.getAttribute("x") || "") : null,
      cutoutY: cutout ? Number.parseFloat(cutout.getAttribute("y") || "") : null,
      cutoutW: cutout ? Number.parseFloat(cutout.getAttribute("width") || "") : null,
      cutoutH: cutout ? Number.parseFloat(cutout.getAttribute("height") || "") : null,
    };
  }, targetSelector);
}

test("Item4 repro: zoom-boundary + footer/scroll-region theories", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync("scratchpad/shots", { recursive: true });

  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  await supa.from("profiles").insert({ id: data!.user!.id, role: "elder", full_name: "Zoom Test" });

  // Force the text-size setting away from default ("large"/zoom 1) BEFORE the
  // app boots, so ElderlyApp's `zoom: contentZoom` div is actually scaled
  // (xxlarge -> 1.25, the biggest signal CONTENT_ZOOM offers).
  await page.addInitScript(() => {
    window.localStorage.setItem("dosewise:accessibility", JSON.stringify({ fontSize: "xxlarge" }));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(800);

  const zoomComputed = await page.evaluate(() => {
    // ElderlyApp's screen-content div: the one wrapper the plan says carries
    // `style={{ zoom: contentZoom }}`.
    const els = Array.from(document.querySelectorAll<HTMLElement>("div"));
    const el = els.find(e => (e.style as unknown as { zoom?: string }).zoom && e.style.zoom !== "1");
    return el ? el.style.zoom : null;
  });
  console.log(`[ITEM4] contentZoom inline style found on a div: ${zoomComputed}`);
  expect(zoomComputed, "xxlarge font size actually produced a non-1 zoom").not.toBeNull();

  // ── THEORY A: zoom boundary ────────────────────────────────────────────
  await page.evaluate(
    ([t, p]) => (window as unknown as { __dwStartWalkthrough: (x: string, y?: Record<string, string>) => void }).__dwStartWalkthrough(t as string, p as Record<string, string>),
    ["add_prescription_auto", { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" }] as [string, Record<string, string>],
  );

  // Step 1 (autoRx.open) targets `elder-add-prescription`, INSIDE the zoomed
  // div. Capture during its ~PRE_CLICK_MS pre-highlight window, before the
  // actor's click fires and the sheet opens over it.
  await page.waitForSelector('[data-tour="elder-add-prescription"].walk-field-prehighlight', { timeout: 10_000 }).catch(() => {});
  const step1 = await measureCutout(page, '[data-tour="elder-add-prescription"]');
  console.log("[ITEM4] STEP 1 (target INSIDE zoomed contentZoom div):", JSON.stringify(step1));
  await page.screenshot({ path: "scratchpad/shots/item4-A-step1-zoomed-target.png" });

  if (step1 && step1.cutoutX !== null) {
    const expectedX = step1.realLeft - step1.originLeft - 6;
    const expectedY = step1.realTop - step1.originTop - 6;
    const dx = Math.abs(expectedX - step1.cutoutX);
    const dy = Math.abs(expectedY - step1.cutoutY!);
    console.log(`[ITEM4] STEP 1 expected cutout (${expectedX.toFixed(1)}, ${expectedY.toFixed(1)}) vs rendered (${step1.cutoutX}, ${step1.cutoutY}) — delta (${dx.toFixed(1)}, ${dy.toFixed(1)}) px`);
    console.log(`[ITEM4] STEP 1 zoom ratio (rect.width / offsetWidth): ${(step1.realWidth / step1.offsetWidth).toFixed(3)}`);
  }

  // Advance to step 2 (autoRx.name) — rx-name, INSIDE AddPrescriptionSheet, a
  // sibling mounted OUTSIDE the zoomed div.
  const nextBtn = page.getByRole("button", { name: /^(Next|Done)$/ });
  await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
  await nextBtn.click();
  await page.waitForSelector('[data-walk="rx-name"] input.walk-field-prehighlight', { timeout: 10_000 }).catch(() => {});
  const step2 = await measureCutout(page, '[data-walk="rx-name"] input');
  console.log("[ITEM4] STEP 2 (target OUTSIDE zoomed div, inside the sheet):", JSON.stringify(step2));
  await page.screenshot({ path: "scratchpad/shots/item4-A-step2-sheet-target.png" });

  if (step2 && step2.cutoutX !== null) {
    const expectedX = step2.realLeft - step2.originLeft - 6;
    const expectedY = step2.realTop - step2.originTop - 6;
    const dx = Math.abs(expectedX - step2.cutoutX);
    const dy = Math.abs(expectedY - step2.cutoutY!);
    console.log(`[ITEM4] STEP 2 expected cutout (${expectedX.toFixed(1)}, ${expectedY.toFixed(1)}) vs rendered (${step2.cutoutX}, ${step2.cutoutY}) — delta (${dx.toFixed(1)}, ${dy.toFixed(1)}) px`);
    console.log(`[ITEM4] STEP 2 zoom ratio (rect.width / offsetWidth): ${(step2.realWidth / step2.offsetWidth).toFixed(3)}`);
  }

  // ── THEORY B: footer/scroll-region overlap at the confirm step ─────────
  // Advance through dose + purpose fills to reach autoRx.confirm.
  await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
  await nextBtn.click(); // dose
  await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
  await nextBtn.click(); // purpose

  // autoRx.confirm is a waitFor step (no Next) — wait for its review card.
  await expect(page.getByText("Please check these details")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300); // let the callout's own layout effect settle top/height

  const overlap = await page.evaluate(() => {
    const overlayRoot = document.querySelector('[class*="z-[200]"]') as HTMLElement | null;
    const callout = overlayRoot?.querySelector(".shadow-xl") as HTMLElement | null;
    const submit = document.querySelector('[data-walk="rx-submit"]') as HTMLElement | null;
    if (!callout || !submit) return null;
    const c = callout.getBoundingClientRect();
    const s = submit.getBoundingClientRect();
    return { calloutTop: c.top, calloutBottom: c.bottom, submitTop: s.top, submitBottom: s.bottom, overlapsSubmit: c.bottom > s.top && c.top < s.bottom };
  });
  console.log("[ITEM4] THEORY B confirm-step callout vs rx-submit rects:", JSON.stringify(overlap));
  await page.screenshot({ path: "scratchpad/shots/item4-B-confirm-step.png", fullPage: true });

  expect(overlap, "could measure both the callout and rx-submit").not.toBeNull();
});

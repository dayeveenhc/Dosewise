import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn, startWalkthrough } from "./helpers";

// Bugfix-C GATE: independently verify the two highlight fixes end to end, at BOTH
// desktop widths where the frame-vs-viewport alignment bug lived (the frame is a
// 390px device mockup centered in the viewport, so at 900/1280px it is far from
// the viewport edges).
//
//  - ALIGNMENT (Bugfix-A): the caption pill positions/clamps against the PHONE
//    FRAME, not window.innerWidth. Discriminator: the caption WRAPPER's left edge
//    must sit at frameLeft+8, NOT ~8 (the viewport-clamp bug value). And the inner
//    pill must be centered over the highlighted element and stay within the frame.
//  - FORMATTING (Bugfix-B): HH:MM → 12h ("6:00 PM"), no raw snake_case, no dangling
//    "Updated:".
//
// Real data: throwaway elder + real Supabase medication row (flow 1); the real
// add_condition_auto walkthrough writing structured conditions[] (flow 2).

const SHOTS = "e2e/artifacts/bugfix-highlight";
const MARGIN = 8; // must match HighlightCaption.MARGIN

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number; cx: number; cy: number }

// Measure, in one page.evaluate for a consistent layout frame: the highlighted
// element, the visible pill (inner child of the caption wrapper), the caption
// WRAPPER, and the phone-frame div — plus the pill's text.
async function measure(page: Page, elementSelector: string) {
  return page.evaluate((sel) => {
    const r = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
    };
    const element = document.querySelector(sel);
    const wrapper = document.querySelector('[data-testid="change-highlight-caption"]');
    const pill = wrapper?.firstElementChild ?? null;
    const frame = document.querySelector(".border-stone-800");
    return {
      element: r(element),
      wrapper: r(wrapper),
      pill: r(pill),
      frame: r(frame),
      text: (pill?.textContent ?? "").trim(),
      vw: window.innerWidth,
    };
  }, elementSelector);
}

// The alignment assertions, shared by both flows. `m` is a measure() result.
function assertAlignment(m: Awaited<ReturnType<typeof measure>>, label: string) {
  const { element, wrapper, pill, frame, vw } = m;
  expect(element, `${label}: highlighted element present`).not.toBeNull();
  expect(wrapper, `${label}: caption wrapper present`).not.toBeNull();
  expect(pill, `${label}: inner pill present`).not.toBeNull();
  expect(frame, `${label}: phone frame present`).not.toBeNull();
  const el = element as Rect, wr = wrapper as Rect, pl = pill as Rect, fr = frame as Rect;

  // (1) DISCRIMINATOR — wrapper clamps to the FRAME, not the viewport. Its left
  //     edge is frameLeft+MARGIN; the viewport-clamp bug would put it at ~MARGIN.
  expect(Math.abs(wr.left - (fr.left + MARGIN)), `${label}: wrapper.left(${wr.left.toFixed(1)}) ~= frameLeft+8(${(fr.left + MARGIN).toFixed(1)})`).toBeLessThanOrEqual(3);
  expect(Math.abs(wr.right - (fr.right - MARGIN)), `${label}: wrapper.right(${wr.right.toFixed(1)}) ~= frameRight-8(${(fr.right - MARGIN).toFixed(1)})`).toBeLessThanOrEqual(3);
  // Explicit "not drifting to the viewport": at these widths the frame is far
  // from both viewport edges, so a viewport-clamped wrapper would be at ~8 / vw-8.
  expect(wr.left, `${label}: wrapper.left not at viewport margin`).toBeGreaterThan(80);
  expect(wr.right, `${label}: wrapper.right not at viewport margin`).toBeLessThan(vw - 80);

  // (2) inner pill horizontally centered over the element, clamped inside the
  //     frame — exactly clamp(elementCenter, frameLeft+8, frameRight-8).
  const expectedPillCx = Math.min(Math.max(el.cx, fr.left + MARGIN), fr.right - MARGIN);
  expect(Math.abs(pl.cx - expectedPillCx), `${label}: pill.cx(${pl.cx.toFixed(1)}) ~= clamp(elementCx)=${expectedPillCx.toFixed(1)}`).toBeLessThanOrEqual(6);
  // pill center stays within the frame bounds.
  expect(pl.cx, `${label}: pill.cx >= frameLeft`).toBeGreaterThanOrEqual(fr.left);
  expect(pl.cx, `${label}: pill.cx <= frameRight`).toBeLessThanOrEqual(fr.right);

  // (3) vertical straddle: the pill's center sits on the element's TOP edge
  //     (pill height ~30, so within 12px is unambiguously a straddle, not centered
  //     on the element body). Looser than horizontal because the transient reveal
  //     caption tracks the element while its smooth scrollIntoView is still settling.
  expect(Math.abs(pl.cy - el.top), `${label}: pill.cy(${pl.cy.toFixed(1)}) ~= elementTop(${el.top.toFixed(1)})`).toBeLessThanOrEqual(12);
}

function logRects(label: string, m: Awaited<ReturnType<typeof measure>>) {
  const f = (r: Rect | null) => r ? `left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} top=${r.top.toFixed(1)} cx=${r.cx.toFixed(1)} w=${r.width.toFixed(1)}` : "null";
  console.log(`\n[MEASURED ${label}] vw=${m.vw}`);
  console.log(`  element : ${f(m.element as Rect)}`);
  console.log(`  frame   : ${f(m.frame as Rect)}`);
  console.log(`  wrapper : ${f(m.wrapper as Rect)}`);
  console.log(`  pill    : ${f(m.pill as Rect)}`);
  console.log(`  text    : "${m.text}"`);
}

for (const width of [900, 1280]) {
  // FLOW 1 — Add Medicine (backend-fed ChangeHighlight, medication card).
  test(`[${width}] Add Medicine: caption aligned to frame + 12h formatting`, async ({ page }) => {
    test.setTimeout(90_000);
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    const creds = await createThrowawayElder();

    const supa = anonClient();
    const { error: sErr } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
    expect(sErr, sErr?.message).toBeNull();
    const { data: med, error: mErr } = await supa
      .from("medications")
      .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar", schedule: { times: ["18:00"], frequency: "daily" } })
      .select("id")
      .single();
    expect(mErr, mErr?.message).toBeNull();
    const medId: string = med!.id;

    await signIn(page, creds);
    await page.getByRole("button", { name: "Medications" }).click().catch(() => {});
    const card = page.locator(`[data-testid="medication-${medId}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    await page.evaluate(([id]) => {
      (window as unknown as { __dwHighlightChange: (a: unknown) => void }).__dwHighlightChange({
        tool: "set_medication_reminder",
        summary: "Metformin at 20:00",
        entity_type: "schedule_entry",
        entity_id: id,
        changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
      });
    }, [medId]);

    await expect(card).toHaveClass(/change-highlight/, { timeout: 10_000 });
    const caption = page.locator('[data-testid="change-highlight-caption"]');
    await expect(caption).toBeVisible();
    // let the smooth scrollIntoView settle so the tracked rect is final
    await page.waitForTimeout(600);

    const m = await measure(page, `[data-testid="medication-${medId}"]`);
    logRects(`add-medicine ${width}`, m);
    await page.screenshot({ path: `${SHOTS}/add-medicine-${width}.png` });

    // FORMATTING (Bugfix-B): 24h → 12h, verb present, no raw snake_case leak.
    expect(m.text).toContain("Updated:");
    expect(m.text).toContain("6:00 PM");
    expect(m.text).toContain("8:00 PM");
    expect(m.text).not.toContain("18:00");
    expect(m.text).not.toContain("20:00");
    expect(m.text).not.toMatch(/[a-z]+_[a-z]+/); // no snake_case tokens
    expect(m.text).not.toMatch(/Updated:\s*$/); // no dangling verb

    assertAlignment(m, `add-medicine ${width}`);
  });

  // FLOW 2 — Add Medical Condition (client walkthrough Reveal path).
  test(`[${width}] Add Condition: reveal caption aligned to frame + clean text`, async ({ page }) => {
    test.setTimeout(90_000);
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    const creds = await createThrowawayElder();

    await signIn(page, creds);
    await startWalkthrough(page, "add_condition_auto", { condition: "High blood pressure" });

    const caption = page.locator('[data-testid="change-highlight-caption"]');
    await expect(caption).toBeVisible({ timeout: 30_000 });
    // let the reveal's smooth scrollIntoView settle before measuring
    await page.waitForTimeout(500);

    const m = await measure(page, ".walk-reveal-pulse");
    logRects(`add-condition ${width}`, m);
    await page.screenshot({ path: `${SHOTS}/add-condition-${width}.png` });

    // FORMATTING: humanized, no snake_case, no dangling verb.
    expect(m.text).toContain("Added:");
    expect(m.text).toContain("High blood pressure");
    expect(m.text).not.toMatch(/[a-z]+_[a-z]+/);
    expect(m.text).not.toMatch(/Added:\s*$/);

    assertAlignment(m, `add-condition ${width}`);
  });
}

// DETACHED-NODE guard (Bugfix-A part b): if the highlighted element unmounts (tab
// switch) mid-highlight, the caption must disappear — never jump to (0,0).
test("detached node: switching tab hides the caption (no jump to 0,0)", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const creds = await createThrowawayElder();

  const supa = anonClient();
  await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  const { data: med } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar", schedule: { times: ["18:00"], frequency: "daily" } })
    .select("id")
    .single();
  const medId: string = med!.id;

  await signIn(page, creds);
  await page.getByRole("button", { name: "Medications" }).click().catch(() => {});
  await expect(page.locator(`[data-testid="medication-${medId}"]`)).toBeVisible({ timeout: 15_000 });

  await page.evaluate(([id]) => {
    (window as unknown as { __dwHighlightChange: (a: unknown) => void }).__dwHighlightChange({
      tool: "set_medication_reminder", summary: "Metformin at 20:00",
      entity_type: "schedule_entry", entity_id: id,
      changed_fields: { times: { before: ["18:00"], after: ["20:00"] } },
    });
  }, [medId]);

  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption).toBeVisible({ timeout: 10_000 });

  // Switch away from Medications so the highlighted card unmounts.
  await page.getByRole("button", { name: "Home" }).first().click().catch(() => {});

  // Caption must be gone (component returns null on disconnect) — assert it does
  // not linger, and if any node exists it is NOT parked at the top-left origin.
  await expect(caption).toHaveCount(0, { timeout: 5_000 });
  const stray = await page.evaluate(() => {
    const w = document.querySelector('[data-testid="change-highlight-caption"]');
    const pill = w?.firstElementChild;
    if (!pill) return null;
    const b = pill.getBoundingClientRect();
    return { left: b.left, top: b.top };
  });
  if (stray) {
    expect(Math.abs(stray.left) + Math.abs(stray.top), "no caption parked at (0,0)").toBeGreaterThan(20);
  }
});

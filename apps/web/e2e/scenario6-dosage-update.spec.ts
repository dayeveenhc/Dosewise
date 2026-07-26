import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { anonClient, createThrowawayElder, signIn } from "./helpers";

// Scenario 6 (Subagent 6-C VERIFICATION): "doctor changed my metformin to 1000mg"
// -> dosage updated on an EXISTING med -> elder Prescriptions card ringed with
// caption "Updated: 500mg -> 1000mg" (a CHANGE, not an Add), and the card shows
// the new dose. Real throwaway elder + real Supabase medication row; the highlight
// is fired with the REAL committed-action shape update_medication_dosage emits.

const SHOTS = "e2e/artifacts/scenario6-dosage-update";
const MARGIN = 8; // must match HighlightCaption.MARGIN

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number; cx: number; cy: number }

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

function assertGeometry(m: Awaited<ReturnType<typeof measure>>, label: string) {
  const { element, wrapper, pill, frame, vw } = m;
  expect(element, `${label}: highlighted card present`).not.toBeNull();
  expect(wrapper, `${label}: caption wrapper present`).not.toBeNull();
  expect(pill, `${label}: inner pill present`).not.toBeNull();
  expect(frame, `${label}: phone frame present`).not.toBeNull();
  const el = element as Rect, wr = wrapper as Rect, pl = pill as Rect, fr = frame as Rect;

  // wrapper clamps to the FRAME, not the viewport (frame is far from viewport edges here).
  expect(Math.abs(wr.left - (fr.left + MARGIN)), `${label}: wrapper.left(${wr.left.toFixed(1)}) ~= frameLeft+8(${(fr.left + MARGIN).toFixed(1)})`).toBeLessThanOrEqual(3);
  expect(Math.abs(wr.right - (fr.right - MARGIN)), `${label}: wrapper.right(${wr.right.toFixed(1)}) ~= frameRight-8(${(fr.right - MARGIN).toFixed(1)})`).toBeLessThanOrEqual(3);
  expect(wr.left, `${label}: wrapper.left not at viewport margin`).toBeGreaterThan(80);
  expect(wr.right, `${label}: wrapper.right not at viewport margin`).toBeLessThan(vw - 80);

  // inner pill centered over the card, clamped inside the frame.
  const expectedPillCx = Math.min(Math.max(el.cx, fr.left + MARGIN), fr.right - MARGIN);
  expect(Math.abs(pl.cx - expectedPillCx), `${label}: pill.cx(${pl.cx.toFixed(1)}) ~= clamp(cardCx)=${expectedPillCx.toFixed(1)}`).toBeLessThanOrEqual(6);
  expect(pl.cx, `${label}: pill.cx >= frameLeft`).toBeGreaterThanOrEqual(fr.left);
  expect(pl.cx, `${label}: pill.cx <= frameRight`).toBeLessThanOrEqual(fr.right);

  // pill straddles the card's top edge.
  expect(Math.abs(pl.cy - el.top), `${label}: pill.cy(${pl.cy.toFixed(1)}) ~= cardTop(${el.top.toFixed(1)})`).toBeLessThanOrEqual(12);
}

test("Scenario 6: dosage update rings the med card with 'Updated: 500mg -> 1000mg'", async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const creds = await createThrowawayElder();
  const supa = anonClient();
  const { error: sErr } = await supa.auth.signInWithPassword({ email: creds.email, password: creds.password });
  expect(sErr, sErr?.message).toBeNull();

  // Seed Metformin at 500mg (the genuine "before"), then apply the committed
  // dosage write (-> 1000mg) exactly as update_medication_dosage does, so the
  // card renders the new dose and the highlight shows the real diff.
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({ elder_id: creds.userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar", schedule: { times: ["18:00"], frequency: "daily" } })
    .select("id")
    .single();
  expect(mErr, mErr?.message).toBeNull();
  const medId: string = med!.id;

  const { error: uErr } = await supa.from("medications").update({ dosage: "1000mg" }).eq("id", medId);
  expect(uErr, uErr?.message).toBeNull();
  // Independent re-read: dosage is now 1000mg.
  const { data: reread } = await supa.from("medications").select("dosage").eq("id", medId).single();
  expect(reread!.dosage).toBe("1000mg");

  await signIn(page, creds);
  await page.getByRole("button", { name: "Medications" }).click().catch(() => {});
  const card = page.locator(`[data-testid="medication-${medId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  // Card visibly shows the NEW dose.
  await expect(card).toContainText("1000mg");

  // Fire the REAL committed-action shape update_medication_dosage emits.
  await page.evaluate(([id]) => {
    (window as unknown as { __dwHighlightChange: (a: unknown) => void }).__dwHighlightChange({
      tool: "update_medication_dosage",
      summary: "Metformin: 1000mg",
      entity_type: "medication",
      entity_id: id,
      changed_fields: { dosage: { before: "500mg", after: "1000mg" } },
      name: "Metformin",
    });
  }, [medId]);

  // The exact card is ringed.
  await expect(card).toHaveClass(/change-highlight/, { timeout: 10_000 });
  const caption = page.locator('[data-testid="change-highlight-caption"]');
  await expect(caption).toBeVisible();
  await page.waitForTimeout(600); // let smooth scrollIntoView settle

  const m = await measure(page, `[data-testid="medication-${medId}"]`);
  console.log(`\n[MEASURED scenario6] vw=${m.vw} text="${m.text}"`);
  await page.screenshot({ path: `${SHOTS}/dosage-update-highlighted.png`, fullPage: true });

  // Caption is a CHANGE with the exact dose diff — not "Added".
  expect(m.text).toBe("Updated: 500mg → 1000mg");
  expect(m.text).not.toContain("Added");

  assertGeometry(m, "scenario6");
});

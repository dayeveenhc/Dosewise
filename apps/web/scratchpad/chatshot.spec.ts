import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, signIn } from "../e2e/helpers";

// Live check for the two items whose fix is purely visual/stateful and which
// unit tests can establish the mechanism of but not the RESULT:
//   item 2 — the tappable Yes/No answers must be the same width as the reply
//            bubble they answer, not small pills.
//   item 6 — leaving the chat tab and coming back must land back in the
//            CONVERSATION, not on the "Frequently used" tiles.
const SHOTS = "e2e/design-shots/chat-confirm";

test("chat: confirm buttons match the bubble width, and the conversation survives a tab round-trip", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });

  const creds = await createThrowawayElder();
  await signIn(page, creds);

  // Into the chat, via the real composer.
  await page.locator('[data-tour="nav-ai"]').click();
  const composer = page.locator('[data-walk="elder-ai-composer"]');
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.fill("The doctor gave me a new medicine — Lisinopril, 10mg, once a day for blood pressure");
  await page.locator('[data-walk="elder-ai-send-button"]').click();

  // Mei proposes and waits on a yes/no, so Hermes sets awaiting_confirmation and
  // lib/chatChoices.ts synthesizes the localized answers.
  //
  // Routing varies turn to turn — the model may ask a clarifying question first
  // (rail 3 wants a frequency before it proposes) instead of proposing outright.
  // Answer and re-check, the same retry shape the scenario specs use, rather
  // than treating a clarifying turn as a failure.
  const yes = page.getByRole("button", { name: "Yes, please", exact: true });
  for (let i = 0; i < 3 && !(await yes.isVisible().catch(() => false)); i++) {
    await yes.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
    if (await yes.isVisible().catch(() => false)) break;
    await composer.fill("Once a day in the morning, please add it");
    await page.locator('[data-walk="elder-ai-send-button"]').click();
  }
  await expect(yes, "a tappable Yes appeared — nobody has to type it").toBeVisible({ timeout: 90_000 });

  // ITEM 2: the answer is as wide as the bubble above it. self-stretch inside
  // the items-start column is what makes this true; a flex-wrap row of pills
  // (the old behaviour) would be far narrower.
  const bubble = page.locator("div.dw-surface.rounded-2xl").last();
  const bubbleBox = (await bubble.boundingBox())!;
  const yesBox = (await yes.boundingBox())!;
  console.log(`[ITEM 2] bubble=${Math.round(bubbleBox.width)}px answer=${Math.round(yesBox.width)}px`);
  // A few px of slack, not zero: the column is sized by its widest child, and
  // the bubble's own width comes from sub-pixel text layout while the button's
  // comes from its border-box. The point of the assertion is "the same width as
  // the bubble, not a small pill" — the old flex-wrap pills were ~90px against
  // a ~330px bubble, so anything in this range proves the fix.
  expect(Math.abs(yesBox.width - bubbleBox.width), "answer button is the bubble's width").toBeLessThanOrEqual(4);
  expect(yesBox.height, "at least a 44px tap target").toBeGreaterThanOrEqual(44);

  // Being the right width is worthless if the answers land below the fold —
  // the whole point is that someone SEES they can tap instead of typing. Give
  // the auto-scroll its settle, then assert the buttons are inside the viewport.
  await page.waitForTimeout(1200);
  const settled = (await yes.boundingBox())!;
  const vp = page.viewportSize()!;
  console.log(`[ITEM 2] answer bottom=${Math.round(settled.y + settled.height)}px viewport=${vp.height}px`);
  await page.screenshot({ path: `${SHOTS}/1-confirm-buttons.png`, fullPage: true });
  expect(settled.y + settled.height, "answers are on screen without scrolling").toBeLessThanOrEqual(vp.height);

  // ITEM 6: leave the tab and come back. The screen unmounts on every switch, so
  // this is the real round-trip, not a re-render.
  await page.locator('[data-tour="nav-home"]').click();
  await expect(page.locator('[data-walk="elder-ai-composer"]')).toHaveCount(0, { timeout: 10_000 });
  await page.locator('[data-tour="nav-ai"]').click();

  await expect(
    page.getByText("Lisinopril", { exact: false }).first(),
    "back in the conversation, not on the Frequently used tiles",
  ).toBeVisible({ timeout: 20_000 });
  // The mode discriminator, not the copy: the header pill carries
  // `elder-ai-frequently-used` while in CHAT (it's the way OUT to the tiles) and
  // `elder-ai-back-to-chat` while on the tiles. Asserting on the word
  // "Frequently used" would be backwards — it is present precisely when the
  // conversation is showing.
  await expect(page.locator('[data-walk="elder-ai-frequently-used"]'), "in chat mode").toHaveCount(1);
  await expect(page.locator('[data-walk="elder-ai-back-to-chat"]'), "not on the help tiles").toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/2-chat-restored.png`, fullPage: true });
});

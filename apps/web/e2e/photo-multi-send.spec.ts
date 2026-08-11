import { expect, test } from "@playwright/test";
import { createThrowawayElder, signIn } from "./helpers";

// The multi-image WIRE, browser to Hermes. photo-staging.spec.ts proves the
// composer stages several photos; this proves the turn they produce actually
// carries all of them and comes back with a real answer.
//
// Split out from photo-staging on purpose: this one spends a live LLM turn, so
// it is worth running deliberately rather than on every staging tweak.
//
// Asserts on the REQUEST, not on what Mei says about the pictures — a vision
// model's description of two 1x1 test images is not something to hang a
// regression test on. What must hold is that two entries left the browser, and
// that what came back was a real reply rather than one of lib/hermes.ts's
// client-side fallbacks (which is what a rejected/misparsed body would produce).

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const pngFile = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(PNG_BASE64, "base64"),
});

// The class-specific fallbacks lib/hermes.ts substitutes when a turn never got
// a usable answer. Any of them here means the request didn't land.
const FALLBACKS = [
  "Sorry, something went wrong",
  "You've been signed out",
  "sending messages a little too fast",
  "can't reach the assistant",
];

test("two attached photos both reach Hermes on one turn", async ({ page }) => {
  test.setTimeout(120_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  await page.locator('[data-tour="nav-ai"]').click();

  const composer = page.locator("textarea");
  await expect(composer).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-walk="rx-attach-library"]').setInputFiles([
    pngFile("front.png"),
    pngFile("back.png"),
  ]);
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(2, { timeout: 10_000 });

  // Capture what the browser actually posts.
  const turnRequest = page.waitForRequest(
    req => req.url().includes("/agent/turn") && req.method() === "POST",
    { timeout: 30_000 },
  );

  await composer.fill("How many photos did I just send you?");
  await page.locator('[data-walk="elder-ai-send-button"]').click();

  const body = JSON.parse((await turnRequest).postData() ?? "{}");
  expect(body.images_base64, "both photos ride on the turn").toHaveLength(2);
  expect(body.images_base64[0].length, "and carry real bytes").toBeGreaterThan(0);

  // Both photos moved into the sent bubble.
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(2);

  // A real reply comes back. `rounded-tl-sm` is the agent bubble specifically —
  // the user's is rounded-tr-sm — so this can't be satisfied by the composer's
  // disclaimer or by the message just sent.
  const agentBubble = page.locator("div.rounded-tl-sm").last();
  await expect(agentBubble).toBeVisible({ timeout: 90_000 });
  const replyText = (await agentBubble.textContent()) ?? "";
  // Logged like the scenario specs log their seeds: this spec spends a real LLM
  // turn, so a passing run should still leave evidence of what came back.
  console.log(`[photo-multi-send] reply: ${replyText}`);
  expect(replyText.trim().length, "Mei actually said something").toBeGreaterThan(0);
  for (const f of FALLBACKS) expect(replyText, `not the "${f}" fallback`).not.toContain(f);
});

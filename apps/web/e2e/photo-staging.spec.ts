import { expect, test } from "@playwright/test";
import { createThrowawayElder, signIn } from "./helpers";

// A photo attached in the AI chat is STAGED (preview + "tell me what to do with
// it") so the person types their own instruction, instead of us auto-sending a
// fixed "here is my prescription". Several photos can be staged at once, each
// removable on its own, and they survive leaving the screen — this drives all
// of that deterministically (no LLM/send needed).

// A tiny 1x1 PNG, re-encoded to a data: URL by lib/images.ts on attach.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const pngFile = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(PNG_BASE64, "base64"),
});

test("attaching a photo stages it for the user to type an instruction", async ({ page }) => {
  test.setTimeout(60_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);

  // The composer is part of the Ask Mei tab itself now — no sheet to open.
  await page.locator('[data-tour="nav-ai"]').click();

  const composer = page.locator('textarea');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  const sendBtn = page.locator('[data-walk="elder-ai-send-button"]');
  await expect(sendBtn).toBeDisabled(); // nothing typed, nothing attached

  // Attach a photo via the (hidden) library input.
  await page.locator('[data-walk="rx-attach-library"]').setInputFiles(pngFile("pill.png"));

  // The staged preview appears with the "tell me what to do" hint, and Send is now
  // enabled even before typing (they can add a note or just send).
  await expect(page.getByText("tell me what to do with it", { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(1);
  await expect(sendBtn).toBeEnabled();

  // The placeholder now invites an instruction instead of the generic prompt.
  await expect(composer).toHaveAttribute("placeholder", /what should i do with this photo/i);

  // Removing the staged photo returns the composer to its empty state.
  await page.getByRole("button", { name: "Remove photo 1" }).click();
  await expect(page.getByText("tell me what to do with it", { exact: false })).toHaveCount(0);
  await expect(sendBtn).toBeDisabled();
});

test("several photos stage together and each can be removed on its own", async ({ page }) => {
  test.setTimeout(60_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-walk="rx-attach-library"]').setInputFiles([
    pngFile("front.png"),
    pngFile("back.png"),
  ]);

  // Both thumbnails stage, and the hint switches to the counted plural.
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByText("2 photos attached", { exact: false })).toBeVisible();

  // Removing one leaves the other — getting a single photo wrong must not mean
  // starting the whole attachment over.
  await page.getByRole("button", { name: "Remove photo 1" }).click();
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(1);
  await expect(page.getByText("tell me what to do with it", { exact: false })).toBeVisible();
  await expect(page.locator('[data-walk="elder-ai-send-button"]')).toBeEnabled();
});

test("a staged photo survives leaving the chat and coming back", async ({ page }) => {
  test.setTimeout(60_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  await page.locator('[data-tour="nav-ai"]').click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-walk="rx-attach-library"]').setInputFiles(pngFile("pill.png"));
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(1, { timeout: 10_000 });

  // This screen unmounts on every bottom-nav switch. The staged photo is held in
  // the same sessionStorage record as the transcript, so it has to come back.
  await page.locator('[data-tour="nav-home"]').click();
  await expect(page.locator('[data-walk="elder-ai-send-button"]')).toHaveCount(0);
  await page.locator('[data-tour="nav-ai"]').click();

  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByText("tell me what to do with it", { exact: false })).toBeVisible();
  await expect(page.locator('[data-walk="elder-ai-send-button"]')).toBeEnabled();
});

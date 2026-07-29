import { expect, test } from "@playwright/test";
import { createThrowawayElder, signIn } from "./helpers";

// A photo attached in the AI chat is now STAGED (preview + "tell me what to do
// with it") so the person types their own instruction, instead of us auto-sending
// a fixed "here is my prescription". This drives the staging UI deterministically
// (no LLM/send needed).

test("attaching a photo stages it for the user to type an instruction", async ({ page }) => {
  test.setTimeout(60_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);

  // Go to the Ask Mei tab, then open the chat sheet (the tab itself is now a
  // list of things Mei can do; the chat is one option on it).
  await page.locator('[data-tour="nav-ai"]').click();
  await page.locator('[data-walk="elder-open-chat"]').click();

  const composer = page.locator('textarea');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  // With nothing typed or attached the right-hand button is the mic; Send only
  // appears once there is something to send.
  const sendBtn = page.locator('[data-walk="elder-ai-send-button"]');
  await expect(sendBtn).toHaveCount(0);

  // Attach a photo via the (hidden) library input — a tiny 1x1 PNG.
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  await page.locator('[data-walk="rx-attach-library"]').setInputFiles({
    name: "pill.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngBase64, "base64"),
  });

  // The staged preview appears with the "tell me what to do" hint, and Send is now
  // enabled even before typing (they can add a note or just send).
  await expect(page.getByText("tell me what to do with it", { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('img[alt="Attachment"]')).toBeVisible();
  await expect(sendBtn).toBeEnabled();

  // The placeholder now invites an instruction instead of the generic prompt.
  await expect(composer).toHaveAttribute("placeholder", /what should i do with this photo/i);

  // Removing the staged photo returns the composer to its empty state.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("tell me what to do with it", { exact: false })).toHaveCount(0);
  await expect(sendBtn).toHaveCount(0);
});

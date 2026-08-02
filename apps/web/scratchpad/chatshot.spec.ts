import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function env() {
  const file = existsSync(".env") ? ".env" : ".env.local";
  const raw = readFileSync(file, "utf8").split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"));
  return Object.fromEntries(raw.map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test("chat sheet + category sub-view", async ({ page }) => {
  const e = env();
  const supa = createClient(e.VITE_SUPABASE_URL, e.VITE_SUPABASE_ANON_KEY);
  const email = `tw-elder-${Date.now()}@dosewise.test`;
  const { data } = await supa.auth.signUp({ email, password: "Throwaway!2026" });
  await supa.from("profiles").insert({ id: data!.user!.id, role: "elder", full_name: "Tan Ah Ma" });

  await page.goto("/");
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("Throwaway!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(
    () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
    null, { timeout: 40_000 },
  );
  await page.waitForTimeout(1500);

  const frame = page.locator('div[class*="w-[390px]"]').first();
  await page.locator('[data-tour="nav-ai"]').click();
  await page.waitForTimeout(600);

  await page.locator('[data-walk="elder-cat-medicines"]').click();
  await page.waitForTimeout(600);
  await frame.screenshot({ path: "scratchpad/shots/ai-category.png" });

  // Back out via the app header, then open the chat.
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(500);
  await page.waitForTimeout(500);
  await frame.screenshot({ path: "scratchpad/shots/ai-chat.png" });

  // Typing grows the field; sending flips the body to the conversation and the
  // help buttons stand down. The reply itself is irrelevant here — the mode
  // switch is synchronous, so this doesn't depend on the backend.
  await page.locator("textarea").fill("I have been feeling a bit dizzy in the mornings after I take my tablets, is that normal?");
  await page.waitForTimeout(400);
  await frame.screenshot({ path: "scratchpad/shots/ai-chat-typed.png" });

  await page.locator('[data-walk="elder-ai-send-button"]').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-walk="elder-cat-medicines"]')).toHaveCount(0);
  await expect(page.getByText("dizzy in the mornings")).toBeVisible();
  await frame.screenshot({ path: "scratchpad/shots/ai-chat-sent.png" });

  // Back to the buttons via "Frequently used" — the app header never changed,
  // and no tab strip appeared when the message was sent.
  await expect(page.getByRole("heading", { name: "Dosewise" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask Mei" })).toBeVisible();
  await page.locator('[data-walk="elder-ai-frequently-used"]').click();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-walk="elder-cat-medicines"]')).toBeVisible();
  await expect(page.locator("textarea")).toBeVisible(); // composer never leaves
  await frame.screenshot({ path: "scratchpad/shots/ai-back-to-help.png" });

  // ...and back into the conversation again.
  await page.locator('[data-walk="elder-ai-back-to-chat"]').click();
  await page.waitForTimeout(500);
  await expect(page.getByText("dizzy in the mornings")).toBeVisible();
  await expect(page.locator('[data-walk="elder-cat-medicines"]')).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Phase 1 A4 — prove the actor's DOM-driving TECHNIQUE works in a REAL browser
// against the app's REAL React-controlled inputs (the login form). Vitest
// (src/app/lib/walkthrough/actor.test.tsx) already covers actor.ts itself; this
// mirrors the exact native-setter mechanism in-page and proves React reacts —
// the Sign In button is disabled until BOTH fields carry React state, so it
// enabling is unambiguous proof onChange fired (not just a DOM value set).

const SHOTS = "e2e/artifacts/actor-smoke";

// The exact technique from lib/walkthrough/actor.ts::setInputValue — kept in
// sync intentionally; if actor.ts changes its mechanism, update this too. Takes
// a single [selector, value] tuple since page.evaluate passes one argument.
function driveFill([selector, value]: [string, string]) {
  const el = document.querySelector(selector) as HTMLInputElement | null;
  if (!el) throw new Error(`no element for ${selector}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("actor fill technique updates real React state on the login form", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });

  await page.goto("/");
  // Welcome → sign-in (default language is en).
  await page.getByRole("button", { name: "I already have an account" }).click();

  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');
  await expect(email).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-login-empty.png` });

  // Baseline: the Sign In button is disabled while React state is empty.
  const signIn = page.getByRole("button", { name: "Sign in" });
  await expect(signIn).toBeDisabled();

  // Drive BOTH fields via the actor's native-setter technique.
  await page.evaluate(driveFill, ['input[type="email"]', "throwaway.elder@dosewise.test"]);
  await page.evaluate(driveFill, ['input[type="password"]', "correct horse battery"]);

  // Proof React reacted: the controlled inputs hold the values AND the
  // state-gated button is now enabled.
  await expect(email).toHaveValue("throwaway.elder@dosewise.test");
  await expect(password).toHaveValue("correct horse battery");
  await expect(signIn).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/2-login-filled-button-enabled.png` });
});

// The engine of Guided Auto-Navigation: Mei performs a step's action herself,
// VISIBLY animated (never instant), so the elder can watch and follow. The
// Walkthrough overlay awaits performAct(), then advances to Verify/Reveal.
//
// The crux gotcha this module exists to handle: a naive `el.value = x` on a
// React-controlled input is silently dropped — React tracks the value on the
// node and ignores an assignment that didn't go through its synthetic event.
// So we call the native prototype setter and dispatch a real bubbling `input`
// event, which is what React's onChange actually listens for.

import { emitWalkthroughEvent } from "./bus";
import type { ActDirective } from "./types";

// Deliberately unhurried so an elderly user can watch each character land and
// follow along (was 55 — too fast to track). Retune here.
const DEFAULT_PACE_MS = 100;

// Native value setters, captured off the prototype so React's own descriptor
// override doesn't swallow the assignment (see file header).
const nativeInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
const nativeTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = el instanceof HTMLTextAreaElement ? nativeTextareaValue : nativeInputValue;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Poll for a target that may still be mounting (same spirit as the overlay's
// measure-retry). Returns null on timeout so a bad selector fails soft.
async function waitForEl(selector: string, shouldCancel: () => boolean, timeoutMs = 4000): Promise<HTMLElement | null> {
  let waited = 0;
  for (;;) {
    if (shouldCancel()) return null;
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    if (waited >= timeoutMs) return null;
    await sleep(60);
    waited += 60;
  }
}

async function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  paceMs: number,
  shouldCancel: () => boolean,
): Promise<void> {
  el.focus();
  for (let i = 1; i <= value.length; i++) {
    if (shouldCancel()) return;
    setInputValue(el, value.slice(0, i));
    await sleep(paceMs);
  }
  setInputValue(el, value); // ensure the full value even if a char coalesced
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
}

// A deliberate press so a programmatic tap reads as a real, watchable action —
// a clear press-in, a beat, then release (was a quick 130/80ms flash).
async function pressPulse(el: HTMLElement, shouldCancel: () => boolean): Promise<void> {
  const prevTransition = el.style.transition;
  const prevTransform = el.style.transform;
  el.style.transition = "transform 200ms ease";
  el.style.transform = "scale(0.94)";
  await sleep(280);
  if (shouldCancel()) return;
  el.style.transform = prevTransform;
  await sleep(180);
  el.style.transition = prevTransition;
}

async function driveUpload(input: HTMLInputElement, asset: string): Promise<void> {
  const resp = await fetch(asset);
  const blob = await resp.blob();
  const name = asset.split("/").pop() || "upload.jpg";
  const file = new File([blob], name, { type: blob.type || "image/jpeg" });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export interface ActContext {
  // Set true when the overlay unmounts (Exit) mid-animation, so a running act
  // bails instead of driving a torn-down screen.
  shouldCancel: () => boolean;
}

/**
 * Perform one ActDirective, visibly, resolving when it's done. Emits
 * `walk-act-start` / `walk-act-done` on the bus so instrumented code (and the
 * overlay) can sequence the phases. Fails soft: a missing target or wrong
 * element type resolves without throwing, so one bad step can't wedge the run.
 */
export async function performAct(act: ActDirective, ctx: ActContext): Promise<void> {
  emitWalkthroughEvent("walk-act-start", { kind: act.kind, selector: act.selector });
  try {
    const el = await waitForEl(act.selector, ctx.shouldCancel);
    if (!el || ctx.shouldCancel()) return;
    switch (act.kind) {
      case "fill":
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          await typeInto(el, act.value, act.paceMs ?? DEFAULT_PACE_MS, ctx.shouldCancel);
        }
        break;
      case "select":
        if (el instanceof HTMLSelectElement) {
          nativeSelectValue?.call(el, act.value);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        break;
      case "click":
        await pressPulse(el, ctx.shouldCancel);
        if (!ctx.shouldCancel()) el.click();
        break;
      case "upload":
        if (el instanceof HTMLInputElement) await driveUpload(el, act.asset);
        break;
    }
  } finally {
    emitWalkthroughEvent("walk-act-done", { kind: act.kind, selector: act.selector });
  }
}

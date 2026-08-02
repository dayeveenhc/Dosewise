import { useEffect, useState } from "react";
import { Pointer } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import type { WalkthroughStep } from "../lib/walkthrough/types";

// Re-resolve this often. Targets arrive behind Supabase round-trips (the
// caregiver-link Accept button), and some labels change mid-step — the
// add-prescription Save button reads "Add Lisinopril" then "Adding…". A
// resolve-once-on-mount would pin the generic fallback on exactly the steps
// that most need naming. Matches WalkthroughReview's polling rationale.
const POLL_MS = 300;

// Elements whose own text is a usable name. Anything else (a section card, a
// timeline, a wrapper div) would dump its whole subtree into the pill.
const INTERACTIVE = 'button, a, select, input, textarea, summary, [role="button"], [role="switch"], [role="link"]';

const MAX_LABEL = 28;

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

// The accessible name of one element, or "" — aria-label, then aria-labelledby,
// then its own text but ONLY when the element is genuinely interactive and
// isn't a <select> (whose textContent is every option concatenated).
function nameOf(el: Element): string {
  const aria = clean(el.getAttribute("aria-label") ?? "");
  if (aria) return aria;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = clean(
      labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (text) return text;
  }

  if (el.matches(INTERACTIVE) && !el.querySelector("option") && el.tagName !== "SELECT") {
    return clean(el.textContent ?? "");
  }
  return "";
}

// Resolve the control the person has to touch. Falls through to the single
// interactive descendant when the step spotlights a WRAPPER — which is the
// normal case for e.g. the language select, a <div> around a native <select>.
function resolveLabel(selector: string): string {
  const el = document.querySelector(selector);
  if (!el) return "";
  const own = nameOf(el);
  if (own) return own;
  const inner = el.querySelectorAll(INTERACTIVE);
  return inner.length === 1 ? nameOf(inner[0]) : "";
}

// Copy for a step whose target has no usable name — a bare toggle (its only
// child is the knob), the QR camera, an app-event wait with no control at all.
function fallbackKey(step: WalkthroughStep): string {
  const w = step.waitFor;
  if (!w) return "walk.waitingFor.event";
  switch (w.type) {
    case "click":
    case "acknowledge": return "walk.waitingFor.click";
    case "toggle": return "walk.waitingFor.toggle";
    case "input": return "walk.waitingFor.input";
    case "select-change": return "walk.waitingFor.selectChange";
    case "automatic-detection": return "walk.waitingFor.detection";
    default: return "walk.waitingFor.event";
  }
}

/**
 * The action-row indicator for a user-driven (`waitFor`) step.
 *
 * Autonomous steps show Next/Done; consent steps must NOT, because Mei
 * advancing past a Save or an Accept is exactly what the whole design forbids.
 * That left those steps with an empty action row and no clue what was expected.
 * This fills the same slot with a NON-INTERACTIVE pill naming the real control,
 * so the callout's shape is identical on every step and it is always obvious
 * what the app is waiting for.
 *
 * Deliberately a <div>, not a disabled <button>: `getByRole("button")` still
 * matches disabled buttons, so a button here would stay catchable forever by
 * the e2e assertions that prove consent steps render no advance control —
 * and `aria-hidden` would fix that only by hiding a visible element from
 * screen readers.
 */
export function WalkthroughWaitPill({ step }: { step: WalkthroughStep }) {
  const { language } = useLanguage();
  const selector = step.waitFor && "selector" in step.waitFor && step.waitFor.selector
    ? step.waitFor.selector
    : step.selector;
  const [label, setLabel] = useState(() => resolveLabel(selector));

  useEffect(() => {
    const sync = () => setLabel(prev => {
      const next = resolveLabel(selector);
      return next === prev ? prev : next;
    });
    sync();
    const poll = setInterval(sync, POLL_MS);
    return () => clearInterval(poll);
  }, [selector]);

  const trimmed = label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL).trimEnd()}…` : label;
  // "Waiting for you: X" rather than "Tap X" — the bare imperative reproduces
  // some steps' own instruction copy verbatim, which makes the callout body and
  // this pill collide as duplicate text.
  const text = trimmed
    ? t(language, "walk.waitingFor.named", { label: trimmed })
    : t(language, fallbackKey(step));

  return (
    <div
      className="min-h-[44px] px-5 py-2 rounded-xl bg-muted/40 border border-dashed border-border text-sm font-semibold text-muted-foreground flex items-center gap-1.5 min-w-0 max-w-[62%] select-none"
    >
      <Pointer size={14} className="shrink-0 opacity-70" />
      <span className="truncate">{text}</span>
    </div>
  );
}

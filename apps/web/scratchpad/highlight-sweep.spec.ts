import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  acquirePooledCaregiverLink, acquirePooledElder, dismissIdlePopupIfOpen, poolStats,
  signInAfterReset, startWalkthrough, tapWalkthroughNext, walkthroughStep,
} from "../e2e/helpers";
import { resolveWalkthroughSteps, walkthroughShellFor } from "../src/app/lib/walkthrough/steps";
import type { ReviewField, WalkthroughTaskName } from "../src/app/lib/walkthrough/types";
import { PACING } from "../src/app/lib/walkthrough/pacing";

// ─────────────────────────────────────────────────────────────────────────────
// The highlight-box sweep: EVERY walkthrough task, EVERY reachable step, both
// shells — the geometry check that has only ever been run on
// add_prescription_auto (elder, default text size) before now.
//
// This is a REPORTING sweep, not a fail-fast one: it collects every geometry
// violation across every task into one JSON artifact and only asserts at the
// very end. A verification pass that stops at the first bad box tells you
// about one defect per run; this tells you about all of them in one.
//
// Placement constants are duplicated from lib/walkthrough/placement.ts on
// purpose — that module does not export them, and an INDEPENDENT copy is what
// makes this a real check rather than a tautology (a spec importing the same
// constant can never catch that constant being wrong).
const GAP = 16;
// 84 -> 100 on 2026-08-08, when the iOS status bar grew 28->40px and pushed both
// shells' headers down (elder header bottom now ~99px). Leaving the mirror at 84
// did not make the sweep noisy — it made it BLIND: `callout-above-header` fires
// at `top < HEADER_RESERVE - TOL`, and placement now clamps to >= 100, so the
// check could never fire, while a callout landing at 85-99 would sit under the
// header unreported. If placement.ts's value moves again, move this one too.
const HEADER_RESERVE = 100;
const NAV_RESERVE = 110;

// Cutout inflation, from Walkthrough.tsx's mask <rect>s: the primary/change
// cutouts inflate by 6px per side, the nav cutout by 4px.
const PRIMARY_INFLATE = 6;
const NAV_INFLATE = 4;

// B1 thresholds. 12px is about half a line of body text at the app's default
// size: below it an uneven hole reads as a margin, above it the bright box is
// visibly centred on something other than the control you are told to touch.
// 1.6 = the framed group is 60% larger in area than the control inside it.
const CONTROL_OFFSET_TOL = 12;
const CONTROL_AREA_RATIO_MAX = 1.6;

// Geometry tolerance. Sub-pixel layout rounding and the SVG's own float
// attributes make an exact match unrealistic; 2px is far tighter than any
// misalignment that would read as "buggy" on screen.
const TOL = 2;

const SHOTS = "scratchpad/shots/sweep";
// Per-batch report path, so the sweep can be run in chunks (SWEEP_ONLY) and
// merged rather than re-paying 20 Supabase signups whenever one task misbehaves.
const REPORT = process.env.SWEEP_REPORT ?? "scratchpad/shots/sweep/report.json";
// Hard budget per task, covering signup + sign-in + the whole walk. One task
// that hangs (a target that never mounts, a slow signup) must not consume the
// run and take every earlier task's findings down with it — that happened on
// the first full attempt.
// 240s: travel_mode_auto (8 steps, several with date/select fields at
// FIELD_MIN_MS) genuinely needs more than the 150s first tried.
const TASK_BUDGET_MS = 240_000;

// A run token, threaded into everything the task loop drives.
//
// Promise.race CANNOT cancel the loser: when a task blows its budget the
// abandoned sweepTask keeps tapping Next and taking screenshots on the SAME
// page while the next task signs in, so the next task's findings belong to a
// run that is no longer supposed to exist (one timeout produced four
// consecutive bogus failures last pass). The hard navigation in the catch block
// tears its DOM down; this flag is what stops the loops that don't touch the
// DOM — checked at the top of every step iteration and inside the idle-popup
// poller, whose `finally` may not run for a while.
interface RunToken { cancelled: boolean }

function withTimeout<T>(p: Promise<T>, ms: number, label: string, token: RunToken): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => {
      token.cancelled = true;
      rej(new Error(`${label} exceeded ${ms}ms`));
    }, ms)),
  ]);
}

interface Box { top: number; left: number; width: number; height: number }

// How the target's own focusable content sits inside it (B1). Null when the
// target has no focusable descendants at all — i.e. the target IS the control,
// and there is nothing to say about wrapper padding.
interface ControlFit {
  count: number;
  union: Box;                // union of the focusable descendants' boxes
  padTop: number; padBottom: number; padLeft: number; padRight: number;
  areaRatio: number;         // target area / union area
}

interface StepMeasurement {
  overlayPresent: boolean;
  containerHeight: number;
  origin: Box | null;
  target: Box | null;          // spotlight target, relative to overlay origin
  navTarget: Box | null;       // nav target, relative to overlay origin
  cutouts: Box[];              // mask rects with fill=black, in DOM order
  glows: Box[];                // .dw-spotlight-glow divs, in DOM order
  callout: Box | null;
  calloutText: string;
  fallbackScrim: boolean;      // the !rect "unmeasured" dim
  exitVisible: boolean;
  zoom: number;                // computed zoom on the target's own subtree
  // Diagnostics for the cutout-vs-target drift: .walk-field-prehighlight
  // applies transform: translateY(-3px) with `both` fill, so a target carrying
  // it is rendered 3px above where an un-lifted measurement would put it.
  targetLifted: boolean;
  targetTransform: string;
  // A cutout is only meaningful if the person can actually SEE what it frames.
  // targetOccludedBy names whatever is painted on top of the target's own
  // centre point (excluding the overlay itself, which is pointer-events-none
  // and deliberately transparent there) — a non-null value means the bright
  // hole in the scrim is showing the person a covered element.
  targetOccludedBy: string | null;
  targetVisible: boolean;      // non-zero box, not display:none/visibility:hidden
  // B1: a cutout can match `target + 6` to the pixel and STILL read as
  // off-centre, because step.selector often names a field GROUP whose label
  // sits above the input. The hole is then optically centred on the label, not
  // on the thing you touch. This measures the gap between the two.
  controlFit: ControlFit | null;
  // B3: the overlay root reports whether ANY callout placement could keep the
  // card off its own target. "0" is a step-content problem (shorter copy, or a
  // smaller target), not a geometry bug — but nothing read it before.
  calloutCleared: string | null;
}

interface Finding {
  task: string;
  shell: string;
  step: number;
  stepId: string;
  kind: string;
  detail: string;
}

const findings: Finding[] = [];
function report(f: Finding) {
  findings.push(f);
  console.log(`[FINDING] ${f.task}#${f.step} (${f.kind}): ${f.detail}`);
}

// Persist the artifact by MERGING, never by overwriting.
//
// The zoom cases are their own tests, so `npx playwright test -g "Text size"`
// runs them with an EMPTY module-level `findings` — a blind write would delete
// the main sweep's whole result set and report a zoom-only run as if it were
// the sweep. Findings are keyed by their full identity (a re-run of the same
// task legitimately replaces its own rows and nothing else); log rows by
// task+shell for the same reason.
function persistReport(logEntries: Array<Record<string, unknown>>): void {
  let prior: { log?: Array<Record<string, unknown>>; findings?: Finding[] } = {};
  try {
    prior = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch { /* first write of this artifact */ }
  const fKey = (f: Finding) => `${f.task}|${f.shell}|${f.step}|${f.kind}|${f.detail}`;
  const lKey = (e: Record<string, unknown>) => `${e.task}|${e.shell}`;
  const mergedFindings = new Map<string, Finding>();
  for (const f of prior.findings ?? []) mergedFindings.set(fKey(f), f);
  for (const f of findings) mergedFindings.set(fKey(f), f);
  const mergedLog = new Map<string, Record<string, unknown>>();
  for (const e of prior.log ?? []) mergedLog.set(lKey(e), e);
  for (const e of logEntries) mergedLog.set(lKey(e), e);
  writeFileSync(REPORT, JSON.stringify({
    log: [...mergedLog.values()],
    findings: [...mergedFindings.values()],
    pool: poolStats(),
  }, null, 2));
}

// ── Item 6 is live: a spec that asserts between taps genuinely idles past
// IDLE_TIMEOUT_MS (20s) and gets its next click eaten by the popup's backdrop.
// Real product behaviour, not a regression — dismiss it the way a person
// would. Same helper trustmode.spec.ts / item4visual.spec.ts already carry.
function autoDismissIdlePopup(page: Page, token?: RunToken): () => void {
  let stop = false;
  void (async () => {
    // `token` too, not just `stop`: an abandoned task's finally may not run
    // promptly, and a poller from a dead run clicking "continue" on the LIVE
    // run's popup is exactly the cross-task contamination this pass is closing.
    while (!stop && !token?.cancelled) {
      const popup = page.locator('[data-walk="walk-idle-popup"]');
      if (await popup.isVisible().catch(() => false)) {
        await popup.getByRole("button", { name: /continue/i }).click({ timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(400).catch(() => {});
    }
  })();
  return () => { stop = true; };
}

// One full geometry read of the overlay. Everything is returned in the
// overlay root's own coordinate space (the space its inline `top`/`left`
// styles are actually interpreted in), which is the ONLY space in which
// "does the cutout sit on the target" is a meaningful question.
async function measureOverlay(
  page: Page,
  selector: string | undefined,
  navSelector: string | undefined,
): Promise<StepMeasurement> {
  return page.evaluate(([sel, navSel]) => {
    const empty = {
      overlayPresent: false, containerHeight: 0, origin: null, target: null, navTarget: null,
      cutouts: [], glows: [], callout: null, calloutText: "", fallbackScrim: false,
      exitVisible: false, zoom: 1, targetLifted: false, targetTransform: "none",
      targetOccludedBy: null, targetVisible: false, controlFit: null, calloutCleared: null,
    };
    // Resolve the overlay root FROM the live step counter, not by taking the
    // first z-[200] element in the document: both shells can have more than
    // one z-[200] layer up (GuidedTour, sheets, the change highlight), and
    // picking the wrong one silently reports "no callout" plus geometry from
    // an unrelated layer — which is what the caregiver tours first showed.
    const counterEl = [...document.querySelectorAll("p")]
      .find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
    const root = (counterEl?.closest('[class*="z-[200]"]')
      ?? document.querySelector('[class*="z-[200]"]')) as HTMLElement | null;
    if (!root) return empty;
    const o = root.getBoundingClientRect();
    const rel = (r: DOMRect) => ({ top: r.top - o.top, left: r.left - o.left, width: r.width, height: r.height });

    const targetEl = sel ? document.querySelector(sel) : null;
    const navEl = navSel ? document.querySelector(navSel) : null;

    // Effective zoom on the target's own ancestor chain. The overlay root is a
    // SIBLING of each shell's zoomed content area, so any value != 1 here is a
    // real coordinate-space boundary between the two.
    let zoom = 1;
    for (let el: HTMLElement | null = targetEl as HTMLElement | null; el; el = el.parentElement) {
      const z = Number.parseFloat(getComputedStyle(el).zoom || "1");
      if (Number.isFinite(z) && z !== 1) zoom *= z;
    }

    const mask = root.querySelector("mask");
    const cutouts = mask
      ? [...mask.querySelectorAll("rect")]
          .filter(r => r.getAttribute("fill") === "black")
          .map(r => ({
            top: Number.parseFloat(r.getAttribute("y") || "0"),
            left: Number.parseFloat(r.getAttribute("x") || "0"),
            width: Number.parseFloat(r.getAttribute("width") || "0"),
            height: Number.parseFloat(r.getAttribute("height") || "0"),
          }))
      : [];

    const glows = [...root.querySelectorAll(".dw-spotlight-glow")].map(g => {
      const s = (g as HTMLElement).style;
      return {
        top: Number.parseFloat(s.top || "0"),
        left: Number.parseFloat(s.left || "0"),
        width: Number.parseFloat(s.width || "0"),
        height: Number.parseFloat(s.height || "0"),
      };
    });

    // The callout hosts the "Step X of Y" counter and is the only host of Exit.
    const counter = [...root.querySelectorAll("p")]
      .find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
    const calloutEl = counter?.closest("div[class*='rounded-2xl']") as HTMLElement | null;

    return {
      overlayPresent: true,
      containerHeight: o.height,
      origin: { top: o.top, left: o.left, width: o.width, height: o.height },
      target: targetEl ? rel(targetEl.getBoundingClientRect()) : null,
      navTarget: navEl ? rel(navEl.getBoundingClientRect()) : null,
      cutouts,
      glows,
      callout: calloutEl ? rel(calloutEl.getBoundingClientRect()) : null,
      calloutText: calloutEl?.textContent?.trim().slice(0, 160) ?? "",
      fallbackScrim: !!root.querySelector(":scope > div.bg-black\\/40"),
      exitVisible: [...root.querySelectorAll("button")].some(b => /exit/i.test(b.textContent ?? "")),
      zoom,
      targetLifted: !!targetEl?.classList.contains("walk-field-prehighlight"),
      targetTransform: targetEl ? getComputedStyle(targetEl as HTMLElement).transform : "none",
      targetOccludedBy: (() => {
        if (!targetEl) return null;
        const r = targetEl.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit) return "nothing (outside the viewport)";
        if (hit === targetEl || targetEl.contains(hit) || hit.contains(targetEl)) return null;
        // The overlay's own callout legitimately sits over parts of the page;
        // it is reported separately by the callout-overlaps-target check.
        if (root.contains(hit)) return null;
        const id = (hit as HTMLElement).dataset?.walk ?? (hit as HTMLElement).dataset?.tour;
        return `<${hit.tagName.toLowerCase()}${id ? ` data-walk/tour="${id}"` : ""} class="${(hit.className ?? "").toString().slice(0, 60)}">`;
      })(),
      targetVisible: (() => {
        if (!targetEl) return false;
        const r = targetEl.getBoundingClientRect();
        const cs = getComputedStyle(targetEl as HTMLElement);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      })(),
      controlFit: (() => {
        if (!targetEl) return null;
        // querySelectorAll, NOT matches(): descendants only. A target that IS
        // the control ('[data-walk="rx-name"] input', '[data-walk="rx-dose"]')
        // must return null here — there is no wrapper padding to report, and
        // counting the element as its own descendant would make every step
        // look perfectly fitted.
        const focusables = [...targetEl.querySelectorAll(
          'input,button,select,textarea,a[href],[role="button"],[role="switch"],[contenteditable="true"]',
        )]
          .map(el => el.getBoundingClientRect())
          .filter(r => r.width > 0 && r.height > 0);
        if (focusables.length === 0) return null;
        const t = targetEl.getBoundingClientRect();
        const top = Math.min(...focusables.map(r => r.top));
        const left = Math.min(...focusables.map(r => r.left));
        const bottom = Math.max(...focusables.map(r => r.bottom));
        const right = Math.max(...focusables.map(r => r.right));
        const unionArea = Math.max(1, (right - left) * (bottom - top));
        return {
          count: focusables.length,
          union: { top: top - o.top, left: left - o.left, width: right - left, height: bottom - top },
          padTop: top - t.top,
          padBottom: t.bottom - bottom,
          padLeft: left - t.left,
          padRight: t.right - right,
          areaRatio: (t.width * t.height) / unionArea,
        };
      })(),
      calloutCleared: root.getAttribute("data-walk-callout-cleared"),
    };
  }, [selector ?? "", navSelector ?? ""] as [string, string]);
}

// Measure only once the geometry has STOPPED moving. TARGET_LIFT_MS (320ms) is
// a real animation and scrollIntoView is asynchronous, so a fixed wait reports
// transitions as misalignment — which would bury real defects under harness
// noise. Two consecutive identical samples, at least one lift-duration apart.
async function measureSettled(
  page: Page,
  selector: string | undefined,
  navSelector: string | undefined,
): Promise<StepMeasurement> {
  const settleMs = PACING.TARGET_LIFT_MS + 80;
  let prev = await measureOverlay(page, selector, navSelector);
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(settleMs);
    const next = await measureOverlay(page, selector, navSelector);
    if (JSON.stringify(prev) === JSON.stringify(next)) return next;
    prev = next;
  }
  return prev; // never settled — the assertions below will say so honestly
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
const boxNear = (a: Box, b: Box) =>
  near(a.top, b.top) && near(a.left, b.left) && near(a.width, b.width) && near(a.height, b.height);
const fmt = (b: Box | null) =>
  b ? `{top:${b.top.toFixed(1)} left:${b.left.toFixed(1)} w:${b.width.toFixed(1)} h:${b.height.toFixed(1)}}` : "null";
const intersects = (a: Box, b: Box) =>
  a.left < b.left + b.width && b.left < a.left + a.width &&
  a.top < b.top + b.height && b.top < a.top + a.height;

function inflate(b: Box, by: number): Box {
  return { top: b.top - by, left: b.left - by, width: b.width + by * 2, height: b.height + by * 2 };
}

// The five per-step invariants.
function assertStepGeometry(
  m: StepMeasurement, task: string, shell: string, step: number, stepId: string,
  selector?: string,
) {
  const at = (kind: string, detail: string) => report({ task, shell, step, stepId, kind, detail });
  const sel = selector ?? "(none)";

  // 5. A callout ALWAYS renders — it is the only host of Exit, so a missing
  //    one strands the person on an opaque scrim with no way out.
  if (!m.callout) {
    at("callout-missing", `no callout rendered (overlayPresent=${m.overlayPresent}, scrim=${m.fallbackScrim})`);
    return;
  }
  if (!m.exitVisible) at("exit-missing", "callout rendered but no Exit button in it");

  // B3. Walkthrough.tsx reports, on the overlay root, whether ANY placement
  //     could keep the callout clear of its own target. "0" means placement.ts
  //     fell through to its minimise-the-overlap branch — the card is sitting
  //     on the thing it is describing and no amount of geometry work fixes it.
  //     Listed as a STEP-CONTENT item (shorter copy in language.ts, or a
  //     smaller target in the step file), not as a placement defect.
  if (m.calloutCleared === "0") {
    at("callout-could-not-clear",
      `overlay reports data-walk-callout-cleared="0" — no placement clears this target ` +
      `(callout h=${m.callout.height.toFixed(1)}, target h=${m.target?.height.toFixed(1) ?? "n/a"}, ` +
      `container h=${m.containerHeight.toFixed(1)}, usable band ` +
      `${(m.containerHeight - HEADER_RESERVE - NAV_RESERVE).toFixed(1)})`);
  }

  // A step whose target never mounted legitimately shows the fallback scrim
  // and no cutout. Record it, then skip the geometry checks that need a target.
  if (!m.target) {
    at("target-absent", `step selector matched nothing (fallbackScrim=${m.fallbackScrim}, cutouts=${m.cutouts.length})`);
    return;
  }
  if (m.cutouts.length === 0) {
    at("cutout-missing", `target measured ${fmt(m.target)} but no mask cutout was drawn`);
    return;
  }

  // 1. Primary cutout sits exactly on the target (inflated by 6px per side).
  const wantPrimary = inflate(m.target, PRIMARY_INFLATE);
  if (!boxNear(m.cutouts[0], wantPrimary)) {
    at("cutout-misaligned",
      `cutout ${fmt(m.cutouts[0])} != target+${PRIMARY_INFLATE} ${fmt(wantPrimary)} ` +
      `[dy=${(m.cutouts[0].top - wantPrimary.top).toFixed(1)} ` +
      `prehighlight=${m.targetLifted} transform=${m.targetTransform}]` +
      (m.zoom !== 1 ? ` [target subtree zoom=${m.zoom}]` : ""));
  }

  // 1a. B1 — the hole may be exactly on the TARGET and still be off the
  //     CONTROL. `step.selector` uses all three shapes across the step files:
  //     wrapper-as-selector ('[data-walk="rx-dose"]'), control-inside-wrapper
  //     ('[data-walk="rx-name"] input'), explicit descendant
  //     ('[data-walk="travel-enable-toggle"] button'). Only the first can put
  //     the bright box's optical centre above the thing you actually touch,
  //     because the group's label sits above its input.
  //
  //     TRIAGE, NOT DEFECT: some wrapper targets are deliberate —
  //     language_voice_tour spotlights a wrapper precisely so Mei never flips
  //     the person's own language setting. The step id + selector are in the
  //     detail so each one can be judged rather than swept.
  if (m.controlFit) {
    const cf = m.controlFit;
    const dv = Math.abs(cf.padTop - cf.padBottom);
    const dh = Math.abs(cf.padLeft - cf.padRight);
    if (dv > CONTROL_OFFSET_TOL || dh > CONTROL_OFFSET_TOL) {
      at("cutout-off-centre-vs-control",
        `[${stepId}] selector "${sel}" frames a wrapper: pad top/bottom ` +
        `${cf.padTop.toFixed(1)}/${cf.padBottom.toFixed(1)} (Δ${dv.toFixed(1)}), ` +
        `left/right ${cf.padLeft.toFixed(1)}/${cf.padRight.toFixed(1)} (Δ${dh.toFixed(1)}); ` +
        `target ${fmt(m.target)} vs ${cf.count} focusable descendant(s) ${fmt(cf.union)}`);
    }
    if (cf.areaRatio > CONTROL_AREA_RATIO_MAX) {
      at("cutout-oversized-vs-control",
        `[${stepId}] selector "${sel}" area ratio ${cf.areaRatio.toFixed(2)}x ` +
        `(> ${CONTROL_AREA_RATIO_MAX}): target ${fmt(m.target)} vs control union ${fmt(cf.union)}`);
    }
  }

  // 1b. The cutout must frame something the person can actually SEE. A bright
  //     hole in the scrim over an element that is covered (a sheet opened on
  //     top of it) or collapsed is the most literal "buggy highlight box"
  //     there is: it points confidently at nothing.
  if (!m.targetVisible) {
    at("target-not-visible", `cutout drawn at ${fmt(m.cutouts[0])} for a target with no visible box`);
  } else if (m.targetOccludedBy) {
    at("target-occluded", `spotlight frames ${fmt(m.target)} but ${m.targetOccludedBy} is painted over it`);
  }

  // 2a. The glow is computed from the same rect but through a SEPARATE code
  //     path (inline style vs SVG attribute) — it can drift from the cutout.
  if (m.glows.length === 0) {
    at("glow-missing", `cutout drawn at ${fmt(m.cutouts[0])} but no .dw-spotlight-glow`);
  } else if (!boxNear(m.glows[0], m.cutouts[0])) {
    at("glow-drift", `glow ${fmt(m.glows[0])} != cutout ${fmt(m.cutouts[0])}`);
  }

  // 2b. The nav cutout + its own glow, when the step declares a navSelector.
  if (m.navTarget) {
    const wantNav = inflate(m.navTarget, NAV_INFLATE);
    const navCut = m.cutouts[1];
    if (!navCut) {
      at("nav-cutout-missing", `navSelector matched ${fmt(m.navTarget)} but only ${m.cutouts.length} cutout(s) drawn`);
    } else if (!boxNear(navCut, wantNav)) {
      at("nav-cutout-misaligned", `nav cutout ${fmt(navCut)} != navTarget+${NAV_INFLATE} ${fmt(wantNav)}`);
    }
    if (m.glows.length > 1 && navCut && !boxNear(m.glows[1], navCut)) {
      at("nav-glow-drift", `nav glow ${fmt(m.glows[1])} != nav cutout ${fmt(navCut)}`);
    }
  }

  // 3. The callout must not cover the thing it is describing.
  if (intersects(m.callout, m.target)) {
    at("callout-overlaps-target",
      `callout ${fmt(m.callout)} overlaps spotlighted target ${fmt(m.target)}`);
  }

  // 4. The callout stays inside the usable band — never clipped off the top,
  //    never buried under the bottom nav.
  if (m.callout.top < HEADER_RESERVE - TOL) {
    at("callout-above-header", `callout top ${m.callout.top.toFixed(1)} < HEADER_RESERVE ${HEADER_RESERVE}`);
  }
  const calloutBottom = m.callout.top + m.callout.height;
  const navFloor = m.containerHeight - NAV_RESERVE;
  if (calloutBottom > navFloor + TOL) {
    at("callout-under-nav",
      `callout bottom ${calloutBottom.toFixed(1)} > usable floor ${navFloor.toFixed(1)} ` +
      `(containerHeight ${m.containerHeight.toFixed(1)}, callout height ${m.callout.height.toFixed(1)})`);
  }
  // The GAP contract: when the callout is placed clear of the target it should
  // keep a real breathing gap, not sit flush against it.
  if (!intersects(m.callout, m.target)) {
    const below = m.callout.top - (m.target.top + m.target.height);
    const above = m.target.top - calloutBottom;
    const gap = Math.max(below, above);
    if (gap >= 0 && gap < GAP - TOL) {
      at("callout-gap-too-small", `only ${gap.toFixed(1)}px between callout and target (GAP=${GAP})`);
    }
  }
}

// ── B2: the THIRD cutout ────────────────────────────────────────────────────
// Walkthrough.tsx draws three mask rects — primary (rect ± 6, rx=16), nav
// (navRect ± 4, rx=16) and change (changeRect ± 6, rx=12), the last opened by
// tapping "Change" on the review card. Nothing had ever measured the third:
// every check above stops at cutouts[0]/[1], and the change hole only exists
// after a real interaction the sweep never performed.
//
// Runs on any step that declares `confirm` AND has a review card on screen.
// The Change button is located STRUCTURALLY (the button that follows the review
// card's <dl>) rather than by its accessible name — walk.review.change is
// localized, so a name locator would silently match nothing in five of the six
// languages.
async function sweepChangeCutout(
  page: Page, review: ReviewField[], task: string, shell: string, step: number, stepId: string,
  navSelector: string | undefined,
) {
  const at = (kind: string, detail: string) => report({ task, shell, step, stepId, kind, detail });
  const changeBtn = page.locator('[class*="z-[200]"] dl ~ button');
  if (!(await changeBtn.first().isVisible().catch(() => false))) return; // no review card up

  // Which field the hole SHOULD land on. Walkthrough.tsx's focusFirstReviewField
  // prefers `blankFields[0] ?? step.review[0]` — an independent value read here
  // rather than importing the product's own readValues, so this can catch that
  // preference being wrong as well as the geometry.
  //
  // The textContent fallback MIRRORS readValues and is not optional: a review
  // row may name a control that isn't an <input> (add_prescription_auto's
  // course-length summary is a <p>). Reading only `.value` scores such a row
  // BLANK, so this picks it as the expected focus target while the product
  // correctly skips it — reporting a ~700px change-cutout-misaligned every run
  // against a product that is behaving. Independence from readValues is the
  // point; being STALE relative to its contract is not.
  const values = await page.evaluate(
    (sels: string[]) => sels.map(s => {
      const el = document.querySelector(s) as HTMLInputElement | null;
      return el?.value?.trim() ?? el?.textContent?.trim() ?? "";
    }),
    review.map(f => f.selector),
  );
  const blankIdx = values.findIndex(v => !v);
  const expectSel = review[blankIdx >= 0 ? blankIdx : 0].selector;

  await changeBtn.first().click({ timeout: 8_000 }).catch(() => {});
  // Two settle points: focusFirstReviewField itself calls
  // scrollIntoView({block:"center"}), so the tap that opens the hole is also a
  // layout shift.
  const m = await measureSettled(page, expectSel, navSelector);

  const expectedCount = 1 + (m.navTarget ? 1 : 0) + 1;
  const changeCut = m.cutouts[m.cutouts.length - 1];
  if (!m.target) {
    at("change-cutout-misaligned", `[${stepId}] review field "${expectSel}" matched nothing after tapping Change`);
    return;
  }
  if (m.cutouts.length < expectedCount) {
    at("change-cutout-misaligned",
      `[${stepId}] tapped Change on "${expectSel}" but only ${m.cutouts.length} cutout(s) drawn ` +
      `(expected ${expectedCount}: primary${m.navTarget ? " + nav" : ""} + change)`);
    return;
  }
  const want = inflate(m.target, PRIMARY_INFLATE);
  if (!boxNear(changeCut, want)) {
    at("change-cutout-misaligned",
      `[${stepId}] change cutout ${fmt(changeCut)} != "${expectSel}"+${PRIMARY_INFLATE} ${fmt(want)} ` +
      `[dy=${(changeCut.top - want.top).toFixed(1)} dx=${(changeCut.left - want.left).toFixed(1)}]`);
  }
  if (m.glows.length < m.cutouts.length) {
    at("change-glow-missing",
      `[${stepId}] ${m.cutouts.length} cutout(s) but only ${m.glows.length} .dw-spotlight-glow — ` +
      `the change hole has no glow`);
  } else if (!boxNear(m.glows[m.glows.length - 1], changeCut)) {
    at("change-glow-missing",
      `[${stepId}] change glow ${fmt(m.glows[m.glows.length - 1])} != change cutout ${fmt(changeCut)}`);
  }

  // Force a real layout shift under the hole. The whole point of the per-frame
  // watcher (as opposed to the one-shot rect this used to be) is that the hole
  // FOLLOWS — a stale hole here is the same class of bug as the 292px Save
  // misplacement, just on the cutout nobody had looked at.
  const scrolled = await page.evaluate((s: string) => {
    const el = document.querySelector(s);
    let p = el?.parentElement ?? null;
    while (p) {
      const cs = getComputedStyle(p);
      if (p.scrollHeight > p.clientHeight + 8 && /auto|scroll/.test(cs.overflowY)) break;
      p = p.parentElement;
    }
    if (!p) return false;
    p.scrollTop += 40;
    return true;
  }, expectSel);
  if (!scrolled) return; // nothing scrollable under it — no reflow to test

  const m2 = await measureSettled(page, expectSel, navSelector);
  const changeCut2 = m2.cutouts[m2.cutouts.length - 1];
  if (!m2.target || !changeCut2) {
    at("change-cutout-stale-after-reflow",
      `[${stepId}] after a 40px scroll: target=${fmt(m2.target)} cutouts=${m2.cutouts.length}`);
    return;
  }
  const want2 = inflate(m2.target, PRIMARY_INFLATE);
  if (!boxNear(changeCut2, want2)) {
    at("change-cutout-stale-after-reflow",
      `[${stepId}] after a 40px scroll the change cutout ${fmt(changeCut2)} != "${expectSel}"+${PRIMARY_INFLATE} ` +
      `${fmt(want2)} [dy=${(changeCut2.top - want2.top).toFixed(1)}]`);
  }
}

// Walk one task as far as Next taps can carry it, measuring every step.
// waitFor steps have no Next by design — reaching one is a clean stop, not a
// failure: the sweep records where and why it stopped.
async function sweepTask(
  page: Page, task: WalkthroughTaskName, shell: "elder" | "caregiver",
  params: Record<string, string>, maxSteps: number, label: string = task, token: RunToken = { cancelled: false },
): Promise<{ visited: number; stoppedAt: string }> {
  const steps = resolveWalkthroughSteps(task, shell, params);
  const stopIdle = autoDismissIdlePopup(page, token);
  try {
    await startWalkthrough(page, task, params);
    await page.waitForFunction(
      () => [...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
      null, { timeout: 20_000 },
    ).catch(() => {});

    let visited = 0;
    for (let i = 0; i < Math.min(maxSteps, steps.length); i++) {
      if (token.cancelled) return { visited, stoppedAt: `cancelled after ${visited} step(s) — this task's budget expired` };
      const pos = await walkthroughStep(page);
      if (!pos) return { visited, stoppedAt: `overlay unmounted after ${visited} step(s)` };
      const step = steps[pos.current - 1];
      if (!step) return { visited, stoppedAt: `step ${pos.current} out of range (${steps.length} defined)` };

      const m = await measureSettled(page, step.selector, step.navSelector);

      // The run may have CARRIED ITSELF onward while we were measuring.
      // computeHoldGate collapses a click act into the step that works in the
      // surface it opened, so a step measured here can be gone by the time
      // measureSettled returns — and then the cutout belongs to step N+1 while
      // `step.selector` still names N's target, which has usually scrolled out
      // of view. That mismatch reported as `cutout-misaligned` (dy=527.9) plus
      // a companion `target-occluded` on add_doctor_question_auto#2, against a
      // product whose own screenshot showed "Step 3 of 7" with the cutout
      // perfectly glued to step 3's control.
      //
      // Re-read the position and drop the sample rather than assert on it. This
      // is not a blind spot: the step we advanced INTO is measured on the very
      // next iteration, so nothing goes unchecked — only the stale comparison
      // is discarded.
      const after = await walkthroughStep(page);
      if (after && after.current !== pos.current) {
        console.log(`[SWEEP] ${label}#${pos.current} auto-continued to ${after.current} while measuring — sample dropped (it is measured on the next pass)`);
        continue;
      }

      visited++;
      assertStepGeometry(m, label, shell, pos.current, step.id, step.selector);
      await page.screenshot({ path: `${SHOTS}/${task}-${shell}-${String(pos.current).padStart(2, "0")}.png` })
        .catch(() => {});

      // B2. Must run BEFORE the Next tap: the measure effect clears changeRect
      // on every step change, so the third cutout only exists inside this step.
      if (step.confirm && step.review?.length) {
        await sweepChangeCutout(page, step.review, label, shell, pos.current, step.id, step.navSelector);
        await page.screenshot({ path: `${SHOTS}/${task}-${shell}-${String(pos.current).padStart(2, "0")}-change.png` })
          .catch(() => {});
      }

      // Advance. A waitFor step renders a non-interactive wait pill instead of
      // Next — reaching one ends this task's sweep, cleanly.
      //
      // Must go through helpers.ts::tapWalkthroughNext, NOT a bare .click():
      // Next means two different things depending on when it lands (shorten
      // the current dwell vs commit at the terminal gate) and the button is
      // enabled for both, so a hand-rolled click gets spent on the dwell and
      // the step never moves. That helper waits for the gate's own copy first.
      const next = page.getByRole("button", { name: /^(Next|Done)$/ });
      if (!(await next.isVisible().catch(() => false))) {
        // A user-driven step: do what the person would do, so the sweep can
        // actually WALK the spotlight tours instead of measuring their first
        // step and stopping. Only the actions whose real DOM listener is a
        // plain click (Walkthrough.tsx:494 binds "click" for both `click` and
        // `acknowledge`) — a `write-committed` / `detection` step waits on a
        // real async write or the camera and is a legitimate stop.
        const kind = step.waitFor?.type;
        if (kind === "click" || kind === "acknowledge") {
          const sel = (step.waitFor as { selector?: string } | undefined)?.selector ?? step.selector;
          const advanced = await page.locator(sel).first().click({ timeout: 8_000 })
            .then(() => page.waitForFunction(
              (prev: number) => {
                const el = [...document.querySelectorAll("p")].find(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? ""));
                if (!el) return true;
                return Number(el.textContent!.trim().match(/^Step (\d+) of/)![1]) !== prev;
              }, pos.current, { timeout: 20_000 },
            ).then(() => true))
            .catch(() => false);
          if (advanced) continue;
          return { visited, stoppedAt: `step ${pos.current} did not advance on a real ${kind} of ${sel}` };
        }
        return { visited, stoppedAt: `step ${pos.current} is user-driven (waitFor: ${kind ?? "none"})` };
      }
      try {
        await tapWalkthroughNext(page, 30_000);
      } catch {
        // ONE retry, and it is not paranoia: helpers.ts documents that the
        // idle popup must be cleared "at the exact point of contention, rather
        // than with a background poller that could race the tap itself" — and
        // this sweep runs both (the poller, plus tapWalkthroughNext's own
        // dismissal). B2's extra dwell on a confirm step widens that window
        // enough to swallow a tap, and a swallowed tap costs the whole rest of
        // the task's coverage while reading as "the step is stuck".
        await dismissIdlePopupIfOpen(page);
        try {
          await tapWalkthroughNext(page, 30_000);
        } catch {
          return { visited, stoppedAt: `step ${pos.current} would not advance on Next (two taps)` };
        }
      }
    }
    return {
      visited,
      stoppedAt: steps.length <= maxSteps
        ? `walked all ${steps.length} defined step(s)`
        : `reached the ${maxSteps}-step sweep cap`,
    };
  } finally {
    stopIdle();
    await page.evaluate(() => {
      const root = document.querySelector('[class*="z-[200]"]');
      const exit = root && [...root.querySelectorAll("button")].find(b => /exit/i.test(b.textContent ?? ""));
      (exit as HTMLButtonElement | undefined)?.click();
    }).catch(() => {});
  }
}

// Every task the resolver knows, with realistic params. `onboarding` is
// deliberately absent: its steps drive the REAL signup wizard and cannot run
// on an already-signed-in account — ElderlyApp.handleWalkthroughStart refuses
// it outright and hands off to the wizard instead (see its own comment).
// s30-onboarding-resume.spec.ts owns that path.
// `label` disambiguates the two runs of a task that resolves to different
// steps per role (link_caregiver); `shell` forces a role where the resolver's
// own derivation isn't the one under test.
// A medicine with genuinely low supply, for the two tasks whose targets only
// exist below the threshold. Runs AFTER acquirePooledElder for the same reason
// acquirePooledCaregiverLink does: the reset inside the acquire archives every
// medication and nulls every refills row, so anything seeded before it is wiped.
async function seedLowStock(supa: SupabaseClient, userId: string): Promise<void> {
  const { data: med, error: mErr } = await supa
    .from("medications")
    .insert({
      elder_id: userId, name: "Metformin", dosage: "500mg", purpose: "blood sugar",
      schedule: { times: ["08:00"], frequency: "daily" },
    })
    .select("id")
    .single();
  if (mErr) throw new Error(`seedLowStock: medication insert failed — ${mErr.message}`);
  // 3 pills at one dose a day = 3 days left, under LOW_SUPPLY_DAYS (10).
  const { error: rErr } = await supa.from("refills").insert({
    medication_id: med!.id, elder_id: userId, pills_remaining: 3, threshold: 10,
  });
  if (rErr) throw new Error(`seedLowStock: refills insert failed — ${rErr.message}`);
}

const TASKS: Array<{
  task: WalkthroughTaskName;
  params?: Record<string, string>;
  shell?: "elder" | "caregiver";
  label?: string;
  needsPendingLink?: boolean;
  needsLowStock?: boolean;
}> = [
  // duration_days is what makes add_prescription_auto build its two extra steps
  // (autoRx.durationMode + autoRx.duration) and the fourth review row. Without
  // it `hasDuration` is false and all three are silently skipped — the steps
  // would have zero geometry coverage.
  { task: "add_prescription_auto", params: { name: "Lisinopril", dose: "10mg", purpose: "blood pressure", duration_days: "14" } },
  { task: "add_condition_auto", params: { condition: "High blood pressure" } },
  { task: "travel_mode_auto", params: { start_date: "2026-09-01", end_date: "2026-09-07", timezone: "Japan (UTC+9)" } },
  { task: "edit_profile_auto", params: { value: "62" } },
  { task: "add_doctor_question_auto", params: { question: "Is it normal to feel dizzy after my medicine?" } },
  { task: "language_voice_tour" },
  // The Reminders alert card became DATA-DRIVEN on 2026-08-08 and is gated on
  // medsLoaded. resetElderState nulls refills.pills_remaining, so a pooled
  // account has nothing low: liveAlerts is empty, handleWalkthroughStart returns
  // walk.refused.nothingToShow, and this tour never starts at all. Seeding is
  // what keeps it swept.
  { task: "notifications_tour", needsLowStock: true },
  { task: "emergency_contact_tour" },
  { task: "caregiver_view_toggle_tour" },
  { task: "patient_schedule_tour" },
  { task: "weekly_summary_tour" },
  { task: "check_schedule" },
  { task: "log_dose" },
  { task: "undo_dose" },
  { task: "reminder_settings" },
  { task: "text_size" },
  { task: "travel_mode_setup" },
  // Same reason: the per-card Request-refill button only renders below the low
  // threshold. This was a known fixture-shaped `target-absent` in the baseline;
  // seeding converts it into real coverage.
  { task: "request_refill", needsLowStock: true },
  // The Accept button only mounts when a real PENDING care_links row exists —
  // without the fixture this reports target-absent for a fixture reason.
  { task: "accept_caregiver_link", needsPendingLink: true },
  // link_caregiver is genuinely TWO walkthroughs (steps/index.ts resolves it
  // by role), so it is swept twice rather than once.
  { task: "link_caregiver", shell: "elder", label: "link_caregiver-elder" },
  { task: "link_caregiver", shell: "caregiver", label: "link_caregiver-caregiver" },
];

// NOT `mode: "serial"`. It used to be, and that silently cost the zoom cases
// their entire run: this sweep's last line is an intentional
// `expect(findings).toHaveLength(0)`, so the main test FAILS on any finding —
// and a serial group skips every later test once one fails ("3 did not run").
// A reporting sweep whose whole job is to fail on findings must not be the
// gate that decides whether its siblings execute. Order is already guaranteed
// by pw.config.ts's `fullyParallel: false` + one worker.
test.describe.configure({ mode: "default" });

test("highlight sweep: every walkthrough task, every reachable step, both shells", async ({ page }) => {
  // 21 tasks x TASK_BUDGET_MS is 84 minutes in the pathological case, so a
  // 30-minute test timeout could kill the run mid-sweep and lose every finding
  // after the cut — which is how this ended up being run in SWEEP_ONLY batches
  // before. The ceiling is not the expected cost (a healthy task takes 30-90s);
  // it is headroom so a slow tail never truncates the report.
  test.setTimeout(120 * 60_000);
  mkdirSync(SHOTS, { recursive: true });

  const log: Array<Record<string, unknown>> = [];
  // SWEEP_ONLY=a,b limits the run to those tasks — for smoke-testing the
  // harness itself without paying for 20 signups first.
  const only = (process.env.SWEEP_ONLY ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const tasks = only.length
    ? TASKS.filter(t => only.includes(t.label ?? t.task))
    : TASKS;

  for (const { task, params, shell: forcedShell, label, needsPendingLink, needsLowStock } of tasks) {
    // walkthroughShellFor derives the shell from the steps themselves, so
    // there is no second table here to drift out of sync with the step files.
    const shell: "elder" | "caregiver" = forcedShell
      ?? (walkthroughShellFor(task, "elder") === "caregiver" ? "caregiver" : "elder");
    const name = label ?? task;

    let result: { visited: number; stoppedAt: string };
    const token: RunToken = { cancelled: false };
    try {
      result = await withTimeout((async () => {
        // Pooled, not a fresh signup. ~25 signups per run hits Supabase's
        // per-IP signup throttle partway through and every task after it
        // reports a budget timeout that reads exactly like a product defect.
        // The acquire also RESETS the account (helpers.ts::resetElderState) and
        // sets profiles.role, so the caregiver branch no longer needs its own
        // sign-in + role flip here.
        // ONE retry on the whole prelude. Observed live: a caregiver task that
        // failed `signInAfterReset` with "app never mounted" passed on an
        // immediate re-run with the identical account — a transient auth/boot
        // stall, not a fixture or product problem. Without the retry that costs
        // a whole task's coverage and gets reported as a defect.
        let creds!: Awaited<ReturnType<typeof acquirePooledElder>>;
        for (let attempt = 0; ; attempt++) {
          try {
            creds = await acquirePooledElder(shell === "caregiver" ? "caregiver" : "elder");
            // ORDER MATTERS: the reset inside the acquire revokes every
            // care_link this elder is party to, so the pending-link fixture has
            // to run after it, never before.
            if (needsPendingLink) await acquirePooledCaregiverLink(creds.supa, creds.userId);
            // Same ordering rule as the link fixture above — after the reset.
            if (needsLowStock) await seedLowStock(creds.supa, creds.userId);
            // Clean browser first: a reused account means supabase-js's
            // persisted session from the PREVIOUS task is still in
            // localStorage, which sends the app straight past the welcome
            // screen (signIn would then wait forever on a button that never
            // renders). The same clear also drops `dosewise:accessibility` —
            // walkthroughCompletionCount is DEVICE-local, so without it a later
            // task in the run silently walks as a TrustMode veteran — and
            // `dosewise:app-mode:{userId}`, which outranks the DB role.
            await signInAfterReset(page, creds);
            break;
          } catch (err) {
            if (attempt >= 1 || token.cancelled) throw err;
            console.log(`[SWEEP] ${name}: prelude attempt 1 failed (${(err as Error).message.slice(0, 120)}) — retrying once`);
          }
        }
        // Guard the fixture, so a shell that didn't actually change can never
        // be mistaken for a broken walkthrough again.
        if (shell === "caregiver") {
          await page.locator('[data-tour="cg-patientswitcher"]')
            .waitFor({ state: "visible", timeout: 20_000 });
        }
        return sweepTask(page, task, shell, params ?? {}, 12, name, token);
      })(), TASK_BUDGET_MS, `${name} (${shell})`, token);
    } catch (err) {
      // One task blowing up (a Supabase signup rate limit, a target that
      // never mounts) must not discard the findings from every task before
      // it — this sweep costs 20 real signups to reproduce.
      result = { visited: 0, stoppedAt: `ERRORED: ${(err as Error).message.slice(0, 200)}` };
      // Evidence BEFORE the recovery navigation throws it away. An ERRORED row
      // with no picture is what made the last pass's timeouts un-diagnosable —
      // "exceeded 240000ms" cannot be told apart from a product defect without
      // seeing what was actually on screen.
      await page.screenshot({ path: `${SHOTS}/ERROR-${name}.png` }).catch(() => {});
      const onScreen = await page.evaluate(() => ({
        url: location.href,
        mode: (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough ? "shell mounted" : "no dev hook",
        headings: [...document.querySelectorAll("h1,h2")].map(h => h.textContent?.trim()).slice(0, 6),
        buttons: [...document.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean).slice(0, 10),
      })).catch(() => null);
      console.log(`[SWEEP]   at failure: ${JSON.stringify(onScreen)}`);
      // withTimeout only REJECTS — Promise.race cannot cancel the loser, so an
      // abandoned sweepTask keeps driving this page while the next task signs
      // in, and every task after a timeout reports a failure it didn't have.
      // (Observed: four consecutive "overlay unmounted after 0 step(s)" right
      // after one timeout.) Two things isolate the next task: the token, which
      // stops the abandoned run's own loops at their next iteration, and a hard
      // navigation that tears its DOM down and makes its pending page calls
      // reject. The token alone isn't enough (it can be sitting inside a 30s
      // tapWalkthroughNext); the navigation alone wasn't either.
      token.cancelled = true;
      await page.goto("/").catch(() => {});
      await page.waitForTimeout(1_500);
    }
    console.log(`[SWEEP] ${name} (${shell}): ${result.visited} step(s) measured — ${result.stoppedAt}`);
    log.push({ task: name, shell, ...result });
    // Written after EVERY task, not once at the end.
    persistReport(log);
  }

  const pool = poolStats();
  persistReport(log);
  console.log(`\n[SWEEP] ${findings.length} finding(s) across ${tasks.length} tasks — ${REPORT}`);
  console.log(`[SWEEP] accounts: ${pool.minted} minted, ${pool.reused} reused from the pool`);
  for (const f of findings) console.log(`  ${f.task}#${f.step} ${f.kind}: ${f.detail}`);

  expect(findings, `geometry findings:\n${findings.map(f => `${f.task}#${f.step} ${f.kind}: ${f.detail}`).join("\n")}`)
    .toHaveLength(0);
});

// ── The CSS-`zoom` boundary ─────────────────────────────────────────────────
// Both shells wrap their content area in `style={{ zoom: contentZoom }}`
// (App.tsx's ZoomContent, ElderlyApp.tsx's screen-content div) while
// <Walkthrough> mounts as a SIBLING of that div — so every spotlight target
// lives on the far side of a coordinate-space boundary from the overlay that
// draws its cutout. The six-item plan named this as a plausible misalignment
// bug and it was never reproduced either way. At contentZoom 1.25 (xxlarge)
// any failure to normalise would put the cutout 25% off — impossible to miss.
//
// B4 adds the CAREGIVER row. App.tsx:901's <ZoomContent> vs the overlay at
// App.tsx:978 is the identical sibling boundary, and it had never been
// zoom-tested — only the elder shell had. A negative result is expected
// (Chromium's getBoundingClientRect already accounts for CSS `zoom`, which is
// why the elder cases pass); this closes a named gap rather than chasing one.
const ZOOM_CASES: Array<{
  label: string; fontSize: string; expectZoom: number;
  task: WalkthroughTaskName; shell: "elder" | "caregiver"; params?: Record<string, string>;
}> = [
  {
    label: "xxlarge", fontSize: "xxlarge", expectZoom: 1.25,
    task: "add_prescription_auto", shell: "elder",
    params: { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" },
  },
  {
    label: "small", fontSize: "small", expectZoom: 0.85,
    task: "add_prescription_auto", shell: "elder",
    params: { name: "Lisinopril", dose: "10mg", purpose: "blood pressure" },
  },
  {
    label: "caregiver-xxlarge", fontSize: "xxlarge", expectZoom: 1.25,
    task: "patient_schedule_tour", shell: "caregiver",
  },
];

for (const zc of ZOOM_CASES) {
  test(`highlight geometry holds at Text size ${zc.label} (content zoom ${zc.expectZoom})`, async ({ page }) => {
    test.setTimeout(6 * 60_000);
    mkdirSync(SHOTS, { recursive: true });
    const before = findings.length;

    const creds = await acquirePooledElder(zc.shell === "caregiver" ? "caregiver" : "elder");
    await signInAfterReset(page, creds);
    if (zc.shell === "caregiver") {
      await page.locator('[data-tour="cg-patientswitcher"]').waitFor({ state: "visible", timeout: 20_000 });
    }
    // accessibility.tsx persists to this key and DEFAULTS-merges on load, so
    // writing just fontSize is enough; reload to re-run loadInitial().
    await page.evaluate((size) => {
      const key = "dosewise:accessibility";
      const cur = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      window.localStorage.setItem(key, JSON.stringify({ ...cur, fontSize: size }));
    }, zc.fontSize);
    await page.reload();
    await page.waitForFunction(
      () => typeof (window as unknown as { __dwStartWalkthrough?: unknown }).__dwStartWalkthrough === "function",
      null, { timeout: 20_000 },
    );

    const params = zc.params ?? {};
    const steps = resolveWalkthroughSteps(zc.task, zc.shell, params);
    const stopIdle = autoDismissIdlePopup(page);
    await startWalkthrough(page, zc.task, params);
    await page.waitForFunction(
      () => [...document.querySelectorAll("p")].some(p => /^Step \d+ of \d+$/.test(p.textContent?.trim() ?? "")),
      null, { timeout: 20_000 },
    );

    // Walk up to three steps rather than asserting the zoom on step 1: not
    // every task's first target lives INSIDE the zoomed div. The caregiver
    // tour's first two targets are the bottom nav and the patient switcher,
    // both siblings of <ZoomContent> — only the week strip (step 3) is on the
    // far side of the boundary, and that is the one that has to be measured for
    // this test to mean anything. Geometry is checked on every step visited;
    // the zoom assertion is "at least one of them really was zoomed".
    const zooms: number[] = [];
    for (let i = 0; i < Math.min(3, steps.length); i++) {
      const pos = await walkthroughStep(page);
      if (!pos) break;
      const step = steps[pos.current - 1];
      if (!step) break;
      const m = await measureSettled(page, step.selector, step.navSelector);
      zooms.push(m.zoom);
      await page.screenshot({ path: `${SHOTS}/zoom-${zc.label}-${String(pos.current).padStart(2, "0")}.png` })
        .catch(() => {});
      assertStepGeometry(m, `zoom-${zc.label}`, zc.shell, pos.current, step.id, step.selector);

      const next = page.getByRole("button", { name: /^(Next|Done)$/ });
      if (!(await next.isVisible().catch(() => false))) break;
      try {
        await tapWalkthroughNext(page, 30_000);
      } catch {
        break;
      }
    }
    // NOT Math.max: the "small" case expects 0.85, which is BELOW an unzoomed
    // 1 — a max would silently pass on the unzoomed nav target instead.
    //
    // And NOT a bare expect(): a tour that stops early never reaches a zoomed
    // target at all (patient_schedule_tour's first two targets are the bottom
    // nav and the patient switcher, both SIBLINGS of <ZoomContent>; only step
    // 3's week strip is inside it). Failing that as "zoom is broken" would
    // misreport a coverage gap as the alarming thing this test exists to rule
    // out — so it is recorded as its own finding kind instead.
    if (!zooms.some(z => Math.abs(z - zc.expectZoom) < 0.01)) {
      report({
        task: `zoom-${zc.label}`, shell: zc.shell, step: 0, stepId: "(coverage)",
        kind: "zoom-boundary-not-reached",
        detail: `the run measured ${JSON.stringify(zooms)} — no step sat inside a zoom:${zc.expectZoom} ` +
          `subtree, so this case proves nothing about the coordinate boundary either way`,
      });
    }
    stopIdle();

    const mine = findings.slice(before);
    console.log(`[ZOOM ${zc.label}] ${zooms.length} step(s) measured, zooms=${JSON.stringify(zooms)}, ${mine.length} finding(s)`);
    for (const f of mine) console.log(`  ${f.task}#${f.step} ${f.kind}: ${f.detail}`);
    // Land in the SAME artifact as the sweep (merged, not overwritten), so a
    // zoom-only invocation still leaves report.json describing what was
    // actually run instead of silently reverting it to the sweep-only result.
    persistReport([{
      task: `zoom-${zc.label}`, shell: zc.shell, visited: zooms.length,
      stoppedAt: `content zoom ${zc.expectZoom} via Text size "${zc.fontSize}"; measured zooms ${JSON.stringify(zooms)}`,
    }]);
    // Reported here as well as in the main sweep's artifact so a zoom-only
    // regression fails on its own test rather than inside the 20-task run.
    expect(mine, `zoom-${zc.label} findings:\n${mine.map(f => `${f.kind}: ${f.detail}`).join("\n")}`)
      .toHaveLength(0);
  });
}

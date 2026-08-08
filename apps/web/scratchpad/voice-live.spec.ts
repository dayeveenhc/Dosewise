import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createThrowawayElder, signIn, startWalkthrough, walkthroughStep } from "../e2e/helpers";
import { IDLE_TIMEOUT_MS } from "../src/app/lib/walkthrough/pacing";

// ─────────────────────────────────────────────────────────────────────────────
// Item 1 (Voice-Expressive) — the live browser drive it never got.
//
// speech.ts now splits narration into one utterance per sentence/clause,
// chains them with a 200ms pause and a deterministic per-segment rate/pitch
// offset, and guards the chain with a module-level `speakGeneration` counter.
// speech.test.ts covers splitForSpeech's string math; what it CANNOT see is
// the chain running against a real SpeechSynthesis implementation: whether
// every segment actually reaches the engine, whether a superseding speak()
// leaves an orphaned setTimeout that resumes a dead chain, and whether the
// walkthrough's "Explain this step again" (voiceKey's first ever consumer)
// is really wired to it.
//
// Headless Chromium exposes window.speechSynthesis but has no voices and
// never fires onstart/onend — a chain would stall at segment 0 and prove
// nothing. So the init script below replaces the ENGINE (not speech.ts) with
// a recording stub that fires the same events a real engine does. The code
// under test is the real, unmodified speech.ts.

const SHOTS = "scratchpad/shots/voice";

interface SpokenUtterance {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  at: number;
  cancelled: boolean;
}

// Replace the speech engine with a recorder that behaves like a real one:
// speak() → onstart, then onend after a short simulated duration; cancel()
// marks the in-flight utterance cancelled and suppresses its onend, exactly
// as a browser does. Installed via addInitScript so it is in place before any
// app module runs.
async function installSpeechRecorder(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __spoken: SpokenLike[];
      __cancels: number;
      speechSynthesis: unknown;
      SpeechSynthesisUtterance: unknown;
    };
    interface SpokenLike {
      text: string; lang: string; rate: number; pitch: number; at: number; cancelled: boolean;
    }
    w.__spoken = [];
    w.__cancels = 0;

    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      pitch = 1;
      volume = 1;
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) { this.text = text; }
      addEventListener() { /* speech.ts assigns handlers directly */ }
      removeEventListener() { /* unused */ }
    }

    // One deliberately non-empty voice list: speech.ts takes the
    // getVoices().length > 0 branch (setTimeout(start, 0)) rather than
    // waiting on a voiceschanged event that a stub would never fire.
    const VOICES = [
      { name: "Google UK English Female", voiceURI: "gb-female", lang: "en-GB", default: true, localService: false },
      { name: "Google 普通话（中国大陆）", voiceURI: "zh-cn", lang: "zh-CN", default: false, localService: false },
    ];

    let inFlight: { u: FakeUtterance; rec: SpokenLike; timer: number } | null = null;

    const fake = {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => VOICES,
      addEventListener: () => { /* voiceschanged never needed — voices are ready */ },
      removeEventListener: () => { /* unused */ },
      cancel() {
        w.__cancels += 1;
        if (inFlight) {
          clearTimeout(inFlight.timer);
          inFlight.rec.cancelled = true;
          inFlight = null;
        }
        fake.speaking = false;
      },
      pause() { /* unused */ },
      resume() { /* unused */ },
      speak(u: FakeUtterance) {
        const rec: SpokenLike = {
          text: u.text, lang: u.lang, rate: u.rate, pitch: u.pitch,
          at: Math.round(performance.now()), cancelled: false,
        };
        w.__spoken.push(rec);
        fake.speaking = true;
        u.onstart?.();
        // A real engine takes time proportional to the text; 30ms/segment
        // keeps the chain fast while still being genuinely asynchronous.
        const timer = window.setTimeout(() => {
          if (inFlight?.rec !== rec) return; // cancelled
          inFlight = null;
          fake.speaking = false;
          u.onend?.();
        }, 30);
        inFlight = { u, rec, timer };
      },
    };

    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
  });
}

function readSpoken(page: Page): Promise<SpokenUtterance[]> {
  return page.evaluate(() => (window as unknown as { __spoken: SpokenUtterance[] }).__spoken ?? []);
}
function clearSpoken(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __spoken: unknown[]; __cancels: number }).__spoken = [];
    (window as unknown as { __cancels: number }).__cancels = 0;
  });
}

// Drive the REAL exported speak() from lib/speech.ts inside the page — not a
// reimplementation. Vite serves the module graph in dev, so a dynamic import
// of the same specifier the app uses gets the same module instance.
async function callSpeak(page: Page, text: string, lang: string): Promise<void> {
  await page.evaluate(async ([t, l]) => {
    const mod = await import("/src/app/lib/speech.ts");
    (mod as { speak: (a: string, b: string) => void }).speak(t as string, l as string);
  }, [text, lang] as [string, string]);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await installSpeechRecorder(page);
});

test("item 1: a multi-sentence reply reaches the engine as a complete chain of segments", async ({ page }) => {
  test.setTimeout(120_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  await clearSpoken(page);

  // Three sentences plus a decimal dose — the exact shape DECIMAL_DOT_RE
  // exists for. "2.5" must NOT be split into "2." / "5".
  await callSpeak(page, "Good morning. Your dose is 2.5 milligrams today. Please take it with water.", "en-GB");
  await page.waitForFunction(
    () => ((window as unknown as { __spoken: unknown[] }).__spoken ?? []).length >= 3,
    null, { timeout: 10_000 },
  );
  const spoken = await readSpoken(page);

  console.log("[VOICE chain]", JSON.stringify(spoken, null, 2));
  expect(spoken.length, "one utterance per sentence — the chain ran to completion").toBe(3);
  expect(spoken.map(s => s.text).join(" ")).toContain("2.5 milligrams");
  expect(spoken.some(s => /^\s*5 milligrams/.test(s.text)), "a decimal point was never treated as a sentence end").toBe(false);
  for (const s of spoken) expect(s.cancelled, `segment "${s.text}" completed`).toBe(false);

  // Every segment carries the requested language, and the per-segment
  // rate/pitch variance stays inside the deliberately tiny band.
  for (const s of spoken) {
    expect(s.lang).toBe("en-GB");
    expect(s.rate).toBeGreaterThanOrEqual(0.9 - 0.03 - 1e-6);
    expect(s.rate).toBeLessThanOrEqual(0.9 + 0.03 + 1e-6);
    expect(s.pitch).toBeGreaterThanOrEqual(1 - 0.04 - 1e-6);
    expect(s.pitch).toBeLessThanOrEqual(1 + 0.04 + 1e-6);
  }
  // Segment 0 is always unshifted; a multi-segment reply is not flat.
  expect(spoken[0].rate).toBeCloseTo(0.9, 5);
  expect(spoken[0].pitch).toBeCloseTo(1, 5);
  expect(new Set(spoken.map(s => s.pitch)).size, "cadence actually varies across segments").toBeGreaterThan(1);
  // The 200ms inter-segment pause is real, not instant concatenation.
  expect(spoken[1].at - spoken[0].at, "breath-like gap between segments").toBeGreaterThanOrEqual(150);
});

test("item 1: a newer speak() supersedes a chain in flight and no orphaned timer resumes it", async ({ page }) => {
  test.setTimeout(120_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  await clearSpoken(page);

  // Start a long chain, then interrupt it a moment later. speechSynthesis
  // .cancel() stops the CURRENT utterance but cannot cancel speech.ts's own
  // pending inter-segment setTimeout — the generation counter is what must.
  await callSpeak(page, "One. Two. Three. Four. Five. Six.", "en-GB");
  await page.waitForTimeout(120);
  await callSpeak(page, "Interrupting reply.", "en-GB");
  await page.waitForTimeout(1_500); // far longer than the first chain needed

  const spoken = await readSpoken(page);
  console.log("[VOICE supersede]", JSON.stringify(spoken.map(s => s.text)));

  const idx = spoken.findIndex(s => s.text.startsWith("Interrupting"));
  expect(idx, "the interrupting reply was spoken").toBeGreaterThanOrEqual(0);
  const after = spoken.slice(idx + 1);
  expect(after, `nothing from the abandoned chain resumed after the interruption: ${JSON.stringify(after.map(s => s.text))}`)
    .toHaveLength(0);
  expect(spoken.filter(s => /^(One|Two|Three|Four|Five|Six)\./.test(s.text)).length,
    "the first chain was cut short rather than running to completion").toBeLessThan(6);
});

// REMOVED (2026-08-07): two tests covering the idle popup's "Explain this step
// again" button — that it spoke the step's own voiceKey narration, and that it
// stayed silent with Read Aloud off.
//
// The button itself is gone. It was the only consumer WalkthroughStep.voiceKey
// ever had, so the field went with it, and no walkthrough narration is wired to
// speech any more. Deleted rather than skipped: a permanently-red scratchpad
// spec teaches the next reader that something is broken when nothing is.
//
// The rest of this file still covers item 1's real subject — speech.ts's own
// chaining, superseding and per-language utterance behaviour on the CHAT
// surface, which is untouched. If walkthrough narration is ever wired to TTS
// again, resurrect these two from git history alongside voiceKey.
//
// The popup's current action set is asserted in
// src/app/components/Walkthrough.test.tsx ("the popup's action set") and driven
// live in scratchpad/idlenav.spec.ts.

test("item 1: a non-English setting speaks with that language's utterance lang", async ({ page }) => {
  test.setTimeout(120_000);
  const creds = await createThrowawayElder();
  await signIn(page, creds);
  await clearSpoken(page);

  // speechLangFor() maps the app language onto a BCP-47 tag for the engine.
  const expected = await page.evaluate(async () => {
    const mod = await import("/src/app/lib/language.ts");
    return (mod as { speechLangFor: (l: string) => string }).speechLangFor("zh");
  });
  expect(expected, "speechLangFor('zh') resolves to a real tag").toMatch(/^zh/);

  await callSpeak(page, "早安。请记得吃药。", expected);
  // Wait for BOTH segments — the chain speaks them sequentially (onend +
  // INTER_SEGMENT_PAUSE_MS), so reading after the first arrives would report
  // a one-segment "failure" that is really just an early read.
  await page.waitForFunction(
    () => ((window as unknown as { __spoken: unknown[] }).__spoken ?? []).length >= 2,
    null, { timeout: 10_000 },
  );
  const spoken = await readSpoken(page);
  console.log("[VOICE zh]", JSON.stringify(spoken));
  expect(spoken.length, "full-width 。 is a real sentence boundary for splitForSpeech").toBe(2);
  for (const s of spoken) expect(s.lang).toBe(expected);
});

// Text-to-speech for Mei's replies, shared by both AI chat screens and the
// walkthrough's "explain this step again".
//
// TWO exported entry points, deliberately separate rather than one function
// that picks:
//   speakReply() — what the chat screens and the walkthrough use. Asks Hermes
//     for a real neural voice first (/voice/tts, services/hermes/agent/tts.py),
//     which is the only path with any prosody control at all: it takes a
//     delivery INSTRUCTION ("warm, unhurried, expressive"). Falls back to
//     speak() on any failure — no key, offline, signed out, or an audio element
//     the browser refuses to play — because a reply that doesn't speak at all
//     is worse than one that speaks plainly.
//   speak() — the browser's own speechSynthesis, unchanged. Still the whole
//     story on a deploy with no TTS key, and the reason the tuning below
//     matters: Web Speech has no SSML and no instruction channel, so rate,
//     voice ranking and sentence chunking are the entire toolbox.
//
// speak() keeps three robustness/expressiveness pieces on top of a naive
// cancel()+speak():
//   1. speak on the next tick so the preceding cancel() settles — Chromium can
//      otherwise silently drop an utterance queued in the same frame as cancel().
//   2. pick an installed voice matching the language when one exists. Voices can
//      load asynchronously, so wait once for `voiceschanged` on first use.
//   3. narration is split into sentence/clause utterances (splitForSpeech) and
//      chained with a short pause + small per-segment rate/pitch variance —
//      Web Speech has no SSML, so this is the only lever available for a less
//      flat, more natural cadence on a multi-sentence reply. A `generation`
//      counter guards a chain against a NEWER speak() call superseding it
//      mid-flight (cancel() stops the current utterance but not a chain's own
//      queued setTimeout continuations).
// Degrades gracefully: a no-op only when BOTH paths are unavailable.

import { fetchSpokenReply } from "./hermes";

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// Known-female platform voice names across the 6 supported locales (en, zh,
// yue, ms, ta). Best-effort curation — the generic-token net below is primary.
export const FEMALE_VOICE_NAMES = [
  // en
  "samantha", "victoria", "karen", "moira", "tessa", "zira", "aria", "jenny",
  "susan", "google us english", "google uk english female",
  // zh (Mandarin)
  "ting-ting", "tingting", "mei-jia", "meijia", "xiaoxiao", "xiaoyi",
  // yue (Cantonese)
  "sin-ji", "sinji",
  // ms (Melayu)
  "damayanti",
  // ta (Tamil)
  "vani",
];

// Obvious male voices to skip when a female alternative exists (soft, not a
// hard reject). Deliberately short — over-excluding neutral names hurts more.
const MALE_VOICE_NAMES = ["daniel", "alex", "fred", "rishi", "aaron"];

// Female heuristic: generic tokens (incl. the CJK 女 marker) in name/voiceURI,
// or a curated known-female name. Male-named voices are excluded so they never
// win by matching a stray token.
export function isFemaleVoice(v: { name: string; voiceURI: string }): boolean {
  const hay = `${v.name} ${v.voiceURI}`.toLowerCase();
  if (MALE_VOICE_NAMES.some(n => hay.includes(n))) return false;
  if (/female|woman|女/.test(hay)) return true;
  return FEMALE_VOICE_NAMES.some(n => hay.includes(n));
}

// Install-time quality tiers some platforms expose in the voice name/voiceURI:
// macOS's downloadable "Enhanced"/"Premium" voices, Windows 11/Edge's cloud
// "<Name> Online (Natural)" voices, and Google Cloud TTS's "Wavenet"/"Studio"
// voice families (surfaced by some Chrome builds). "online" is its own token
// because a handful of Edge voices carry "Online" in the voiceURI without
// "(Natural)" surviving into it. Soft signal, same spirit as the gender list
// above — never excludes a voice, only reorders preference among voices that
// already match the requested language.
export const HIGH_QUALITY_VOICE_TOKENS = [
  "enhanced", "premium", "natural", "neural", "online", "wavenet", "studio",
];
// macOS's un-upgraded default voices carry "compact" in their voiceURI (e.g.
// com.apple.voice.compact.en-US.Samantha) even when the display name doesn't
// show it. espeak/espeak-ng (Linux/ChromeOS's default) is the most robotic-
// sounding option in practice, regardless of rate/pitch tuning.
export const LOW_QUALITY_VOICE_TOKENS = ["compact", "espeak"];

export function voiceQualityTier(v: { name: string; voiceURI: string }): -1 | 0 | 1 {
  const hay = `${v.name} ${v.voiceURI}`.toLowerCase();
  if (LOW_QUALITY_VOICE_TOKENS.some(t => hay.includes(t))) return -1;
  if (HIGH_QUALITY_VOICE_TOKENS.some(t => hay.includes(t))) return 1;
  return 0;
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return undefined;
  const base = lang.toLowerCase();
  const short = base.split("-")[0];
  const candidates = voices.filter(v => v.lang.toLowerCase() === base);
  if (!candidates.length) {
    for (const v of voices) {
      if (v.lang.toLowerCase().startsWith(short)) candidates.push(v);
    }
  }
  if (!candidates.length) return undefined;
  // Rank candidates by: (1) never a known-robotic voice when a better one is
  // available, (2) female (the assistant's persona), (3) a known higher-
  // quality tier within that — e.g. prefer "Aria (Enhanced)" over plain
  // "Aria" if both are installed. Quality is deliberately NOT the top key:
  // it must not flip the persona's gender just to pick a nicer-sounding
  // voice (a high-quality male voice must not outrank a normal-quality
  // female one).
  return [...candidates].sort((a, b) => {
    const notLow = (v: SpeechSynthesisVoice) => (voiceQualityTier(v) > -1 ? 1 : 0);
    const female = (v: SpeechSynthesisVoice) => (isFemaleVoice(v) ? 1 : 0);
    const high = (v: SpeechSynthesisVoice) => (voiceQualityTier(v) > 0 ? 1 : 0);
    return notLow(b) - notLow(a) || female(b) - female(a) || high(b) - high(a);
  })[0];
}

// Mei's replies are meant to be plain text (soul.md), but LLMs sometimes slip
// in markdown anyway -- the same premise the chat bubble already handles for
// display (see renderWithBold() in AskMeiScreen.tsx / ElderlyAIScreen.tsx).
// Strip the same construct here so it isn't read aloud as literal asterisks.
// Deliberately not touching whitespace/newlines beyond a trim -- most engines
// already pause at a newline, and collapsing it would remove that break
// rather than add one.
function cleanTextForSpeech(text: string, lang: string): string {
  let cleaned = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  // Unit/abbreviation expansion is English-specific wording -- applying it to
  // a zh/yue/ta/ms/hokkien reply would inject English words into a
  // non-English utterance. Six supported languages (speechLangFor), so gate
  // on the lang tag rather than assuming.
  if (lang.toLowerCase().startsWith("en")) {
    cleaned = cleaned
      .replace(/\b(\d+(?:\.\d+)?)\s?mg\b/gi, "$1 milligrams")
      .replace(/\b(\d+(?:\.\d+)?)\s?mL\b/gi, "$1 milliliters")
      .replace(/\bDr\.(?=\s|$)/gi, "Doctor");
  }
  return cleaned.trim();
}

// Sentence/clause boundaries Web Speech can pause at, across all 6 supported
// languages (speechLangFor): ASCII . ! ? plus their full-width CJK
// equivalents. Deliberately NOT the ASCII comma — an ordinary English clause
// comma is far too common and would over-fragment short replies (this is why
// cleanTextForSpeech's "500mg with 2mL, ask Dr. Tan" stays one utterance).
// Run this AFTER cleanTextForSpeech: it expands "Dr." to "Doctor" for English
// replies, removing the abbreviation-period that would otherwise wrongly
// split "ask Dr." from "Tan" (non-English replies keep "Dr." verbatim, so
// that split is still possible there — an accepted, minor cost).
const SEGMENT_RE = /[^.!?，。！？]+[.!?，。！？]*/g;

// A "." inside a dose like "2.5mg" (expanded by cleanTextForSpeech to
// "2.5 milligrams") is a decimal point, not a sentence boundary — without
// this, SEGMENT_RE above would split "...dose to 2.5 milligrams." into
// "...dose to 2." / "5 milligrams.", audibly fracturing the number across a
// pause with its own pitch/rate offset. Mask digit.digit dots with a
// placeholder before splitting, then restore them per-segment afterward,
// rather than complicating SEGMENT_RE itself (character classes can't
// express "not preceded/followed by a digit").
const DECIMAL_DOT_RE = /(\d)\.(\d)/g;
// A control character, not a space: unmasking does a blind split+join back to
// ".", so the placeholder must never occur in real narration text on its own
// (a space would — every OTHER space in the segment would wrongly become a
// ".").
const DECIMAL_DOT_PLACEHOLDER = "\u0000";

// Splits cleaned narration into one utterance per sentence/clause. A run of
// only punctuation (e.g. the second half of "Hello.." or a trailing space)
// never matches — `[^...]+` requires at least one non-boundary character —
// so it can't produce a content-less utterance that stalls on an engine that
// never fires `onend` for silence. A string with no boundary characters at
// all returns exactly one segment, identical to the un-split original.
export function splitForSpeech(text: string): string[] {
  const masked = text.replace(DECIMAL_DOT_RE, `$1${DECIMAL_DOT_PLACEHOLDER}$2`);
  return (masked.match(SEGMENT_RE) ?? [])
    .map(s => s.split(DECIMAL_DOT_PLACEHOLDER).join(".").trim())
    .filter(Boolean);
}

interface SpeakHandlers {
  onStart?: () => void;
  onEnd?: () => void;
}

let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function stopKeepAlive() {
  if (keepAliveTimer !== undefined) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
}

// Chromium has a long-standing bug (crbug.com/335907 and duplicates) where an
// utterance stops mid-sentence with no error/end event once it runs past
// ~15s of audio. A periodic pause()+resume() nudge is the documented
// workaround. Cheap when it never fires (most replies are short): cleared
// the moment speech ends.
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      speechSynthesis.resume();
    }
  }, 12000);
}

// A touch slower than the 1.0 default reads as calmer and more deliberate
// rather than rushed, and aids comprehension for this app's elderly audience.
// Pitch-shifting is still risky on naive engines (SAPI/espeak do DSP, not
// re-synthesis) — the variance below stays tiny (+/-0.04) and exists only to
// give a MULTI-sentence reply a less flat cadence across segments, never to
// change a voice's character. A single-segment reply (the common case: most
// replies are one sentence) gets rate 0.9 / pitch 1, unchanged from before.
const RATE_BASE = 0.9;
const RATE_STEP = 0.03;
const PITCH_BASE = 1;
const PITCH_STEP = 0.04;
// Deterministic (not Math.random) per-segment offset, centered on 0, so a
// reply's cadence is reproducible/testable rather than different on every
// replay. Index 0 (first segment) is always unshifted.
const SEGMENT_OFFSETS = [0, 1, -1, 0.6, -0.6];
function segmentOffset(index: number): number {
  return SEGMENT_OFFSETS[index % SEGMENT_OFFSETS.length];
}

// Short breath-like gap between chained segments.
const INTER_SEGMENT_PAUSE_MS = 200;

// Bumped at the top of every speak()/speakReply() call. A chain's callbacks
// (onstart/onend/onerror, and the pause setTimeout between segments) all check
// this before doing anything, so a NEWER call always wins even though
// speechSynthesis.cancel() only stops the browser's currently-playing
// utterance — it has no way to cancel this module's own pending timers. ONE
// counter across both paths, so a remote clip in flight is superseded by a
// browser utterance and vice versa; two counters could let both play at once.
let speakGeneration = 0;

// The neural-voice clip currently playing, if any. Module-level for the same
// reason speakGeneration is: cancelling has to reach it from whichever entry
// point the next call comes through.
let remoteAudio: HTMLAudioElement | null = null;

function stopRemoteAudio(): void {
  if (!remoteAudio) return;
  const el = remoteAudio;
  remoteAudio = null;
  el.pause();
  // The blob URL is created per clip; leaking one per spoken reply would pin
  // every audio blob of the session in memory.
  if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
  el.removeAttribute("src");
}

export function speak(text: string, lang: string, handlers: SpeakHandlers = {}): void {
  if (!speechSupported() || !text) return;
  stopKeepAlive();
  stopRemoteAudio();
  speechSynthesis.cancel();
  const generation = ++speakGeneration;

  const cleaned = cleanTextForSpeech(text, lang);
  if (!cleaned) return;

  const segments = splitForSpeech(cleaned);
  if (!segments.length) return;

  const speakSegment = (index: number, voice: SpeechSynthesisVoice | undefined) => {
    if (generation !== speakGeneration) return; // superseded by a later speak()

    const utter = new SpeechSynthesisUtterance(segments[index]);
    utter.lang = lang;
    utter.rate = RATE_BASE + segmentOffset(index) * RATE_STEP;
    utter.pitch = PITCH_BASE + segmentOffset(index) * PITCH_STEP;
    if (voice) utter.voice = voice;

    const isLast = index === segments.length - 1;
    utter.onstart = () => {
      if (generation !== speakGeneration) return;
      // onStart/keepalive fire once per speak() call, not once per segment —
      // both chat screens drive a single isSpeaking toggle off these.
      if (index === 0) {
        handlers.onStart?.();
        startKeepAlive();
      }
    };
    utter.onend = () => {
      if (generation !== speakGeneration) return;
      if (isLast) {
        stopKeepAlive();
        handlers.onEnd?.();
      } else {
        setTimeout(() => {
          if (generation !== speakGeneration) return;
          speakSegment(index + 1, voice);
        }, INTER_SEGMENT_PAUSE_MS);
      }
    };
    utter.onerror = () => {
      if (generation !== speakGeneration) return;
      // A mid-chain error aborts the whole reply rather than skipping ahead
      // to the next segment — same "stop, don't guess" spirit as elsewhere.
      stopKeepAlive();
      handlers.onEnd?.();
    };

    speechSynthesis.speak(utter);
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    // Picked once per reply, not per segment, and reused unchanged on every
    // segment — expressiveness must never re-run voice selection and risk a
    // different (or wrong-gender) voice mid-reply.
    speakSegment(0, pickVoice(lang));
  };

  if (speechSynthesis.getVoices().length) {
    setTimeout(start, 0); // let cancel() settle before speaking
  } else {
    // First use before voices have loaded: prefer the voiceschanged signal, but
    // fall back on a timer so a browser that never fires it still speaks.
    speechSynthesis.addEventListener("voiceschanged", start, { once: true });
    setTimeout(start, 250);
  }
}

// Speak a reply in Mei's real (neural) voice when Hermes can serve one, else
// with the browser voice. This is what the chat screens and the walkthrough
// call; speak() above stays the pure browser path.
//
// Always initiated by a user gesture in practice (the speaker button, or
// arriving reply on a screen the person just typed into), which is what keeps
// browser autoplay policy happy — but play() is still awaited and its
// rejection treated as "fall back", because that policy differs per browser
// and a blocked clip must not leave the reply silent.
export async function speakReply(text: string, lang: string, handlers: SpeakHandlers = {}): Promise<void> {
  if (!text) return;
  stopKeepAlive();
  stopRemoteAudio();
  if (speechSupported()) speechSynthesis.cancel();
  const generation = ++speakGeneration;

  // The same cleanup the browser path applies: an LLM that slipped in **bold**
  // must not have the asterisks read out by either voice. Unit expansion is
  // English-only and language-gated inside cleanTextForSpeech.
  const cleaned = cleanTextForSpeech(text, lang);
  if (!cleaned) return;

  const toBrowser = () => {
    if (generation !== speakGeneration) return; // superseded while we were away
    speak(text, lang, handlers);
  };

  let blob: Blob | null = null;
  try {
    blob = await fetchSpokenReply(cleaned);
  } catch {
    blob = null; // fetchSpokenReply already swallows its own errors; belt and braces
  }
  if (generation !== speakGeneration) return;
  if (!blob) return toBrowser();

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  remoteAudio = audio;
  let started = false;
  audio.onended = () => {
    if (generation !== speakGeneration) return;
    stopRemoteAudio();
    handlers.onEnd?.();
  };
  audio.onerror = () => {
    if (generation !== speakGeneration) return;
    stopRemoteAudio();
    // Decode/network failure mid-clip. If it never started we still have a
    // usable fallback; if it did, the person already heard most of it and
    // restarting in a different voice would be worse than stopping.
    if (started) handlers.onEnd?.();
    else toBrowser();
  };

  try {
    await audio.play();
    if (generation !== speakGeneration) {
      // A newer call may already have installed ITS clip while play() was
      // settling — only ever tear down our own.
      if (remoteAudio === audio) stopRemoteAudio();
      return;
    }
    started = true;
    handlers.onStart?.();
  } catch {
    // Autoplay blocked, or no codec — the browser voice still works.
    stopRemoteAudio();
    toBrowser();
  }
}

// Stop whatever is currently speaking, by either path, and report nothing back
// (no onEnd — the caller is the one asking, so it already knows).
//
// Needed because the neural path plays a detached Audio element this module
// owns: speechSynthesis.cancel() cannot reach it, and the chat screens unmount
// on every bottom-nav switch, so without this a reply would keep talking on a
// screen the person has already left.
export function stopSpeaking(): void {
  speakGeneration++; // supersede any in-flight fetch/chain, same as a new call
  stopKeepAlive();
  stopRemoteAudio();
  if (speechSupported()) speechSynthesis.cancel();
}

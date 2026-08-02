// Real text-to-speech via the browser's speechSynthesis, shared by both AI chat
// screens. Two robustness fixes over a naive cancel()+speak():
//   1. speak on the next tick so the preceding cancel() settles — Chromium can
//      otherwise silently drop an utterance queued in the same frame as cancel().
//   2. pick an installed voice matching the language when one exists. Voices can
//      load asynchronously, so wait once for `voiceschanged` on first use.
// Degrades gracefully: a no-op where speechSynthesis is unavailable.

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
// "<Name> Online (Natural)" voices. Soft signal, same spirit as the gender
// list above — never excludes a voice, only reorders preference among voices
// that already match the requested language.
export const HIGH_QUALITY_VOICE_TOKENS = ["enhanced", "premium", "natural", "neural"];
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

export function speak(text: string, lang: string, handlers: SpeakHandlers = {}): void {
  if (!speechSupported() || !text) return;
  stopKeepAlive();
  speechSynthesis.cancel();

  const cleaned = cleanTextForSpeech(text, lang);
  if (!cleaned) return;

  const utter = new SpeechSynthesisUtterance(cleaned);
  utter.lang = lang;
  // A touch slower than the 1.0 default reads as calmer and more deliberate
  // rather than rushed, and aids comprehension for this app's elderly
  // audience. Pitch is deliberately left at the spec default: unlike rate,
  // pitch-shifting on most engines (SAPI, espeak) is a naive DSP operation,
  // not a re-synthesis, so moving it off 1.0 is as likely to sound worse as
  // better, and its safe range is far less predictable across voices.
  utter.rate = 0.9;
  utter.onstart = () => {
    handlers.onStart?.();
    startKeepAlive();
  };
  utter.onend = () => {
    stopKeepAlive();
    handlers.onEnd?.();
  };
  utter.onerror = () => {
    stopKeepAlive();
    handlers.onEnd?.();
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const voice = pickVoice(lang);
    if (voice) utter.voice = voice;
    speechSynthesis.speak(utter);
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

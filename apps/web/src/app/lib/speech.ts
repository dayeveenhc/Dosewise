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
  // Prefer a female voice; else fall back to the first (softest available) match.
  return candidates.find(isFemaleVoice) ?? candidates[0];
}

interface SpeakHandlers {
  onStart?: () => void;
  onEnd?: () => void;
}

export function speak(text: string, lang: string, handlers: SpeakHandlers = {}): void {
  if (!speechSupported() || !text) return;
  speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.onstart = () => handlers.onStart?.();
  utter.onend = () => handlers.onEnd?.();
  utter.onerror = () => handlers.onEnd?.();

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

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

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return undefined;
  const base = lang.toLowerCase();
  const short = base.split("-")[0];
  return (
    voices.find(v => v.lang.toLowerCase() === base) ??
    voices.find(v => v.lang.toLowerCase().startsWith(short))
  );
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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isFemaleVoice, speak, speechSupported } from "./speech";

// speechSynthesis / SpeechSynthesisUtterance do not exist in jsdom, so we stub
// them. pickVoice() is not exported, so per-language voice selection is verified
// end-to-end through speak(): we assert the voice attached to the utterance that
// gets handed to speechSynthesis.speak().

type FakeVoice = { name: string; lang: string; voiceURI: string };

class FakeUtterance {
  text: string;
  lang = "";
  voice: FakeVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

// Realistic platform voice list. Within each language the NON-female voice is
// listed first, so a passing test proves selection is by isFemaleVoice, not by
// "first candidate wins".
const VOICES: FakeVoice[] = [
  // en — Daniel (male) before Samantha (female); langs are en-GB/en-US so a
  // request for en-SG exercises the short-prefix ("en") fallback branch too.
  { name: "Daniel", lang: "en-GB", voiceURI: "com.apple.Daniel" },
  { name: "Samantha", lang: "en-US", voiceURI: "com.apple.Samantha" },
  // zh Mandarin — neutral Google voice before Ting-Ting (female name + 女 tag).
  { name: "Google 普通话（中国大陆）", lang: "zh-CN", voiceURI: "Google 普通话" },
  { name: "Ting-Ting", lang: "zh-CN", voiceURI: "com.apple.Ting-Ting 女" },
  // yue Cantonese — neutral before Sin-ji (female).
  { name: "Google 粤語（香港）", lang: "zh-HK", voiceURI: "Google Cantonese" },
  { name: "Sin-ji", lang: "zh-HK", voiceURI: "com.apple.Sin-ji" },
  // ms Malay — neutral before Damayanti (female).
  { name: "Google Bahasa Melayu", lang: "ms-MY", voiceURI: "Google Bahasa" },
  { name: "Damayanti", lang: "ms-MY", voiceURI: "com.apple.Damayanti" },
  // ta Tamil — ONLY a neutral voice, no female alternative → fallback case.
  { name: "Google தமிழ்", lang: "ta-IN", voiceURI: "Google Tamil" },
  // (deliberately NO voice matching Hokkien / "nan")
];

let speakSpy: ReturnType<typeof vi.fn>;
let cancelSpy: ReturnType<typeof vi.fn>;
let addListenerSpy: ReturnType<typeof vi.fn>;

function installSynth(voices: FakeVoice[]) {
  speakSpy = vi.fn();
  cancelSpy = vi.fn();
  addListenerSpy = vi.fn();
  const synth = {
    getVoices: () => voices,
    cancel: cancelSpy,
    speak: speakSpy,
    addEventListener: addListenerSpy,
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
}

// Run speak() through its deferred tick and return the utterance handed to speak().
function speakAndFlush(text: string, lang: string): FakeUtterance | undefined {
  speak(text, lang);
  vi.runAllTimers();
  return speakSpy.mock.calls.length ? (speakSpy.mock.calls[0][0] as FakeUtterance) : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  installSynth(VOICES);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("speechSupported", () => {
  it("is true once a speechSynthesis is present on window", () => {
    expect(speechSupported()).toBe(true);
  });
});

describe("isFemaleVoice", () => {
  it("matches generic tokens, the CJK 女 marker, and curated names", () => {
    expect(isFemaleVoice({ name: "Samantha", voiceURI: "Samantha" })).toBe(true);
    expect(isFemaleVoice({ name: "Ting-Ting", voiceURI: "Ting-Ting 女" })).toBe(true);
    expect(isFemaleVoice({ name: "Google UK English Female", voiceURI: "x" })).toBe(true);
    expect(isFemaleVoice({ name: "Google 普通话", voiceURI: "Google" })).toBe(false);
  });

  it("male-name exclusion wins even when the voiceURI contains 'female'", () => {
    // Exclusion short-circuits before the generic token net.
    expect(isFemaleVoice({ name: "Daniel", voiceURI: "com.apple.daniel-female" })).toBe(false);
  });
});

describe("speak — per-language female voice selection", () => {
  it("en (en-SG request) picks Samantha over Daniel via the 'en' prefix fallback", () => {
    expect(speakAndFlush("hello", "en-SG")?.voice?.name).toBe("Samantha");
  });

  it("zh-CN picks Ting-Ting over the neutral Google Mandarin voice", () => {
    expect(speakAndFlush("你好", "zh-CN")?.voice?.name).toBe("Ting-Ting");
  });

  it("yue / zh-HK picks Sin-ji over the neutral Cantonese voice", () => {
    expect(speakAndFlush("你好", "zh-HK")?.voice?.name).toBe("Sin-ji");
  });

  it("ms-MY picks Damayanti over the neutral Malay voice", () => {
    expect(speakAndFlush("apa khabar", "ms-MY")?.voice?.name).toBe("Damayanti");
  });
});

describe("speak — fallback languages (no female match)", () => {
  it("ta-IN has only a neutral voice → falls back to that first candidate, no crash", () => {
    const utter = speakAndFlush("வணக்கம்", "ta-IN");
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(utter?.voice?.name).toBe("Google தமிழ்");
  });

  it("Hokkien (nan) has no matching voice → speaks with no voice set, gracefully", () => {
    const utter = speakAndFlush("li ho", "nan");
    expect(speakSpy).toHaveBeenCalledTimes(1); // still speaks
    expect(utter?.voice).toBeNull(); // no voice assigned, no undefined-voice error
  });
});

describe("speak — cancel→speak race fix", () => {
  it("cancels synchronously but defers speak() to a later tick", () => {
    speak("hello", "en-SG");
    // Before any timer runs: cancel already fired, speak has NOT.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(speakSpy).not.toHaveBeenCalled();
    // The utterance is only spoken after the deferred tick settles.
    vi.runAllTimers();
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it("when voices load asynchronously it waits on voiceschanged (and a timer)", () => {
    installSynth([]); // getVoices() empty on first use
    speak("hello", "en-SG");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // No synchronous speak; a voiceschanged-once listener is registered.
    expect(speakSpy).not.toHaveBeenCalled();
    expect(addListenerSpy).toHaveBeenCalledWith("voiceschanged", expect.any(Function), { once: true });
    // Falls back on a timer so a browser that never fires voiceschanged still speaks.
    vi.runAllTimers();
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });
});

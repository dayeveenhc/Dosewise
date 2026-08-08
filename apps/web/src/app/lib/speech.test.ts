import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isFemaleVoice, speak, speechSupported, splitForSpeech } from "./speech";

// speechSynthesis / SpeechSynthesisUtterance do not exist in jsdom, so we stub
// them. pickVoice() is not exported, so per-language voice selection is verified
// end-to-end through speak(): we assert the voice attached to the utterance that
// gets handed to speechSynthesis.speak().

type FakeVoice = { name: string; lang: string; voiceURI: string };

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
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
let pauseSpy: ReturnType<typeof vi.fn>;
let resumeSpy: ReturnType<typeof vi.fn>;
// Mutable so a test can flip .speaking/.paused to simulate the browser's
// state machine around the keepalive's pause()/resume() nudge.
let fakeSynth: { speaking: boolean; paused: boolean };

function installSynth(voices: FakeVoice[]) {
  speakSpy = vi.fn();
  cancelSpy = vi.fn();
  addListenerSpy = vi.fn();
  pauseSpy = vi.fn();
  resumeSpy = vi.fn();
  const synth = {
    getVoices: () => voices,
    cancel: cancelSpy,
    speak: speakSpy,
    addEventListener: addListenerSpy,
    speaking: false,
    paused: false,
    pause: pauseSpy,
    resume: resumeSpy,
  };
  fakeSynth = synth;
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

describe("speak — rate", () => {
  it("defaults to a calmer 0.9 rate instead of the spec default", () => {
    expect(speakAndFlush("hello", "en-SG")?.rate).toBe(0.9);
  });
});

describe("speak — text cleanup before speaking", () => {
  it("strips markdown bold for an English reply", () => {
    expect(speakAndFlush("Take **2 tablets** now", "en-SG")?.text).toBe("Take 2 tablets now");
  });

  it("strips markdown bold for a non-English reply too", () => {
    expect(speakAndFlush("**你好** 你好吗", "zh-CN")?.text).toBe("你好 你好吗");
  });

  it("expands mg/mL/Dr. for an English reply", () => {
    expect(speakAndFlush("Take 500mg with 2mL, ask Dr. Tan", "en-SG")?.text).toBe(
      "Take 500 milligrams with 2 milliliters, ask Doctor Tan"
    );
  });

  it("does NOT expand mg for a non-English reply -- English words must not be injected into a zh-CN utterance", () => {
    expect(speakAndFlush("请服用500mg", "zh-CN")?.text).toBe("请服用500mg");
  });
});

describe("speak — quality-aware voice ranking", () => {
  it("prefers a higher-quality voice over a plain one within the same gender tier", () => {
    installSynth([
      { name: "Aria", lang: "en-US", voiceURI: "com.apple.Aria" },
      { name: "Aria (Enhanced)", lang: "en-US", voiceURI: "com.apple.Aria-Enhanced" },
    ]);
    expect(speakAndFlush("hello", "en-SG")?.voice?.name).toBe("Aria (Enhanced)");
  });

  it("prefers Edge's cloud 'Online' voices and Google Cloud's Wavenet/Studio voices over a plain one, within the same gender tier", () => {
    installSynth([
      { name: "Aria", lang: "en-US", voiceURI: "com.apple.Aria" },
      { name: "Aria Online (Natural)", lang: "en-US", voiceURI: "Microsoft Server Speech Text to Speech Voice Online" },
    ]);
    expect(speakAndFlush("hello", "en-SG")?.voice?.name).toBe("Aria Online (Natural)");

    installSynth([
      { name: "Aria", lang: "en-US", voiceURI: "com.apple.Aria" },
      { name: "Aria (Wavenet)", lang: "en-US", voiceURI: "en-US-Wavenet-F" },
    ]);
    expect(speakAndFlush("hello", "en-SG")?.voice?.name).toBe("Aria (Wavenet)");
  });

  it("never picks a known-robotic (compact) voice when a better match exists, even over a same-gender compact voice", () => {
    installSynth([
      { name: "Samantha", lang: "en-US", voiceURI: "com.apple.voice.compact.en-US.Samantha" },
      { name: "Zira", lang: "en-US", voiceURI: "Microsoft Zira Desktop" },
    ]);
    expect(speakAndFlush("hello", "en-SG")?.voice?.name).toBe("Zira");
  });
});

describe("speak — Chromium 15s keepalive (crbug.com/335907)", () => {
  // Deliberately uses advanceTimersByTime, not runAllTimers: the keepalive is
  // a repeating setInterval, and runAllTimers on an interval that's still
  // "active" (paused/resumed each tick, never cleared until onend) would spin
  // until Vitest's runaway-timer guard aborts the test.
  it("nudges pause()/resume() every 12s while speaking, and stops once speech ends", () => {
    const utter = speakAndFlush("a reasonably long reply", "en-SG");
    expect(utter).toBeDefined();

    // Simulate the browser actually starting speech.
    fakeSynth.speaking = true;
    utter?.onstart?.();

    vi.advanceTimersByTime(12000);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(12000);
    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(resumeSpy).toHaveBeenCalledTimes(2);

    // Speech ends: the interval must be cleared, no further nudges.
    fakeSynth.speaking = false;
    utter?.onend?.();
    vi.advanceTimersByTime(24000);
    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(resumeSpy).toHaveBeenCalledTimes(2);
  });

  it("does not nudge while already paused (avoids re-entrant pause/resume)", () => {
    const utter = speakAndFlush("a reasonably long reply", "en-SG");
    fakeSynth.speaking = true;
    utter?.onstart?.();

    fakeSynth.paused = true;
    vi.advanceTimersByTime(12000);
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
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

describe("splitForSpeech — sentence/clause segmentation", () => {
  it("splits on . ! ? and keeps the delimiter with its segment", () => {
    expect(splitForSpeech("Hello. How are you? Great!")).toEqual([
      "Hello.",
      "How are you?",
      "Great!",
    ]);
  });

  it("splits on full-width CJK punctuation, including the clause comma ，", () => {
    expect(splitForSpeech("你好，你吃饭了吗？该吃药了。")).toEqual([
      "你好，",
      "你吃饭了吗？",
      "该吃药了。",
    ]);
  });

  it("does NOT split on an ASCII comma -- would over-fragment ordinary English replies", () => {
    expect(splitForSpeech("Take 500 milligrams with 2 milliliters, ask Doctor Tan")).toEqual([
      "Take 500 milligrams with 2 milliliters, ask Doctor Tan",
    ]);
  });

  it("returns exactly one segment for text with no boundary punctuation at all", () => {
    expect(splitForSpeech("hello")).toEqual(["hello"]);
    expect(splitForSpeech("你好 你好吗")).toEqual(["你好 你好吗"]);
  });

  it("collapses a run of trailing punctuation instead of emitting a content-less segment", () => {
    // A lone "." or ".." dangling after real content must not become its own
    // utterance -- some engines never fire onend for silence, which would
    // stall the whole chain (isSpeaking stuck true forever).
    expect(splitForSpeech("Hello.. ")).toEqual(["Hello.."]);
  });

  it("does NOT split a decimal point inside a dose, even mid-sentence", () => {
    // Regression: cleanTextForSpeech expands "2.5mg" to "2.5 milligrams",
    // and a naive sentence-boundary "." would fracture the number itself
    // ("...dose to 2." / "5 milligrams...") across a pause with its own
    // pitch/rate offset -- reproducible with the app's own seed data
    // (Bisoprolol 2.5mg). The "." must survive intact in the output segment.
    expect(
      splitForSpeech("Your doctor increased your dose to 2.5 milligrams once daily. Take it with food.")
    ).toEqual([
      "Your doctor increased your dose to 2.5 milligrams once daily.",
      "Take it with food.",
    ]);
  });

  it("does not let the decimal-dot placeholder leak into unrelated text", () => {
    // The masking approach must not corrupt ordinary spaces or produce a
    // stray "." anywhere the source text didn't have a digit.digit dot.
    expect(splitForSpeech("Take 1.5 tablets twice daily with 10.25 milliliters of water.")).toEqual([
      "Take 1.5 tablets twice daily with 10.25 milliliters of water.",
    ]);
  });
});

describe("speak — multi-utterance chaining for expressiveness", () => {
  it("chains sentences as separate utterances, advancing only on onend after a short pause", () => {
    const utter1 = speakAndFlush("Hello. How are you?", "en-SG");
    expect(utter1?.text).toBe("Hello.");
    expect(speakSpy).toHaveBeenCalledTimes(1);

    utter1?.onstart?.();
    utter1?.onend?.();
    expect(speakSpy).toHaveBeenCalledTimes(1); // not yet -- pause hasn't elapsed
    // advanceTimersByTime, not runAllTimers: onstart armed the 12s keepalive
    // interval (still running mid-chain), which runAllTimers would spin on
    // forever -- same reason the keepalive tests above use it.
    vi.advanceTimersByTime(200);
    expect(speakSpy).toHaveBeenCalledTimes(2);
    expect((speakSpy.mock.calls[1][0] as FakeUtterance).text).toBe("How are you?");
  });

  it("a single-segment reply is untouched: rate 0.9, pitch 1, exactly one utterance", () => {
    const utter = speakAndFlush("hello", "en-SG");
    expect(utter?.rate).toBe(0.9);
    expect(utter?.pitch).toBe(1);
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it("applies small deterministic rate/pitch variance across segments, centered on the base", () => {
    const utter1 = speakAndFlush("One. Two. Three.", "en-SG");
    utter1?.onstart?.();
    utter1?.onend?.();
    vi.advanceTimersByTime(200); // keepalive interval is running mid-chain -- see above
    const utter2 = speakSpy.mock.calls[1][0] as FakeUtterance;
    utter2.onstart?.();
    utter2.onend?.();
    vi.advanceTimersByTime(200);
    const utter3 = speakSpy.mock.calls[2][0] as FakeUtterance;

    expect(utter1?.rate).toBe(0.9);
    expect(utter1?.pitch).toBe(1);
    // Every segment stays within the documented +/-0.03 rate / +/-0.04 pitch
    // band -- expressiveness must never swing wildly.
    for (const u of [utter1, utter2, utter3]) {
      expect(u?.rate).toBeGreaterThanOrEqual(0.9 - 0.03);
      expect(u?.rate).toBeLessThanOrEqual(0.9 + 0.03);
      expect(u?.pitch).toBeGreaterThanOrEqual(1 - 0.04);
      expect(u?.pitch).toBeLessThanOrEqual(1 + 0.04);
    }
    // Not all three identical -- there IS a cadence, not a flat repeat.
    const rates = new Set([utter1?.rate, utter2.rate, utter3.rate]);
    expect(rates.size).toBeGreaterThan(1);
  });

  it("fires onStart/onEnd exactly once per speak() call, never once per segment", () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    speak("Hello. How are you? Great!", "en-SG", { onStart, onEnd });
    vi.runAllTimers();

    const utter1 = speakSpy.mock.calls[0][0] as FakeUtterance;
    utter1.onstart?.();
    expect(onStart).toHaveBeenCalledTimes(1);
    utter1.onend?.();
    vi.advanceTimersByTime(200); // keepalive interval is running mid-chain -- see above

    const utter2 = speakSpy.mock.calls[1][0] as FakeUtterance;
    utter2.onstart?.();
    expect(onStart).toHaveBeenCalledTimes(1); // still once, not per-segment
    expect(onEnd).not.toHaveBeenCalled();
    utter2.onend?.();
    vi.advanceTimersByTime(200);

    const utter3 = speakSpy.mock.calls[2][0] as FakeUtterance;
    utter3.onstart?.();
    utter3.onend?.(); // final segment
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps the SAME voice on every segment of a chain -- expressiveness never re-picks or drifts gender", () => {
    const utter1 = speakAndFlush("Hello. How are you? Great!", "zh-CN");
    expect(utter1?.voice?.name).toBe("Ting-Ting"); // the female voice, per existing priority

    utter1?.onstart?.();
    utter1?.onend?.();
    vi.advanceTimersByTime(200); // keepalive interval is running mid-chain -- see above
    const utter2 = speakSpy.mock.calls[1][0] as FakeUtterance;
    utter2.onstart?.();
    utter2.onend?.();
    vi.advanceTimersByTime(200);
    const utter3 = speakSpy.mock.calls[2][0] as FakeUtterance;

    expect(utter2.voice?.name).toBe("Ting-Ting");
    expect(utter3.voice?.name).toBe("Ting-Ting");
  });

  it("a NEW speak() call mid-chain kills the old chain instead of interleaving with it", () => {
    speakAndFlush("First sentence. Second sentence.", "en-SG");
    const firstUtter1 = speakSpy.mock.calls[0][0] as FakeUtterance;
    expect(firstUtter1.text).toBe("First sentence.");

    firstUtter1.onstart?.();
    firstUtter1.onend?.(); // queues "Second sentence." after the inter-segment pause

    // A NEW reply supersedes the old chain before that pause timer fires.
    speak("Replacement message.", "en-SG");
    vi.runAllTimers();

    // Exactly one more speak() call happened, and it's the NEW message --
    // the old chain's "Second sentence." must never have been spoken.
    expect(speakSpy).toHaveBeenCalledTimes(2);
    expect((speakSpy.mock.calls[1][0] as FakeUtterance).text).toBe("Replacement message.");
  });

  it("an error mid-chain aborts the whole reply (fires onEnd once) rather than continuing to the next segment", () => {
    const onEnd = vi.fn();
    speak("First. Second.", "en-SG", { onEnd });
    vi.runAllTimers();
    const utter1 = speakSpy.mock.calls[0][0] as FakeUtterance;
    utter1.onstart?.();
    utter1.onerror?.();

    vi.runAllTimers();
    expect(speakSpy).toHaveBeenCalledTimes(1); // no second segment spoken
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

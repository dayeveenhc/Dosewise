import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The neural-voice path and — the part that actually protects the user — its
// fallback. A reply that goes silent because a TTS key is missing, a clip is
// blocked by autoplay policy, or the network dropped is worse than one read by
// a plain browser voice, so every failure mode here must end in speak().
const fetchSpokenReply = vi.fn();
vi.mock("./hermes", () => ({ fetchSpokenReply: (t: string) => fetchSpokenReply(t) }));

const { speakReply } = await import("./speech");

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

let speakSpy: ReturnType<typeof vi.fn>;
let playSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;
let created: FakeAudio[];

class FakeAudio {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    created.push(this);
  }
  play() {
    return playSpy();
  }
  pause() {
    pauseSpy();
  }
  removeAttribute() {
    this.src = "";
  }
}

beforeEach(() => {
  fetchSpokenReply.mockReset();
  speakSpy = vi.fn();
  playSpy = vi.fn(async () => undefined);
  pauseSpy = vi.fn();
  created = [];
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [],
    cancel: vi.fn(),
    speak: speakSpy,
    addEventListener: vi.fn(),
    speaking: false,
    paused: false,
    pause: vi.fn(),
    resume: vi.fn(),
  });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mei-clip"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });

describe("speakReply — neural voice path", () => {
  it("plays the server clip and never touches the browser voice", async () => {
    fetchSpokenReply.mockResolvedValue(blob());
    const onStart = vi.fn();

    await speakReply("Time for your Metformin.", "en-SG", { onStart });

    expect(playSpy).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
    expect(speakSpy).not.toHaveBeenCalled();
  });

  it("sends the CLEANED text — markdown must not be spoken as asterisks", async () => {
    fetchSpokenReply.mockResolvedValue(blob());
    await speakReply("Take **two** tablets with 500mg of water.", "en-SG");
    const sent = fetchSpokenReply.mock.calls[0][0] as string;
    expect(sent).not.toContain("**");
    expect(sent).toContain("500 milligrams");
  });

  it("reports the end of the clip so the speaking indicator clears", async () => {
    fetchSpokenReply.mockResolvedValue(blob());
    const onEnd = vi.fn();
    await speakReply("Hello", "en-SG", { onEnd });
    created[0].onended?.();
    expect(onEnd).toHaveBeenCalledOnce();
  });
});

describe("speakReply — falls back rather than going silent", () => {
  it("uses the browser voice when the server has no voice configured", async () => {
    fetchSpokenReply.mockResolvedValue(null);
    vi.useFakeTimers();

    await speakReply("Hello there.", "en-SG");
    vi.runAllTimers(); // speak() defers past its own cancel()

    expect(speakSpy).toHaveBeenCalledOnce();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("uses the browser voice when autoplay policy blocks the clip", async () => {
    fetchSpokenReply.mockResolvedValue(blob());
    playSpy.mockRejectedValue(new Error("NotAllowedError"));
    vi.useFakeTimers();

    await speakReply("Hello there.", "en-SG");
    vi.runAllTimers();

    expect(speakSpy).toHaveBeenCalledOnce();
  });

  it("uses the browser voice when the request itself throws", async () => {
    fetchSpokenReply.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();

    await speakReply("Hello there.", "en-SG");
    vi.runAllTimers();

    expect(speakSpy).toHaveBeenCalledOnce();
  });

  it("does nothing at all for empty text — neither path is asked", async () => {
    await speakReply("   ", "en-SG");
    expect(fetchSpokenReply).not.toHaveBeenCalled();
    expect(speakSpy).not.toHaveBeenCalled();
  });
});

describe("speakReply — a newer call always wins", () => {
  it("drops a clip whose fetch resolved after a later call started", async () => {
    let release!: (b: Blob) => void;
    fetchSpokenReply.mockImplementationOnce(() => new Promise<Blob>(r => { release = r; }));
    fetchSpokenReply.mockResolvedValueOnce(blob());

    const stale = speakReply("First reply.", "en-SG");
    await speakReply("Second reply.", "en-SG"); // supersedes the pending one
    const playsAfterSecond = playSpy.mock.calls.length;

    release(blob());
    await stale;

    // The superseded fetch resolved, but its clip must never reach play().
    expect(playSpy.mock.calls.length).toBe(playsAfterSecond);
  });
});

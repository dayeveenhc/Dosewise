import { useState, useRef, useEffect } from "react";
import type { ChangeEvent } from "react";
import { Volume2, Mic, Send, AlertTriangle, MessageCircle, Check, Trash2, Camera, FileText, Pill, Globe, X, Plane, ChevronRight, CalendarDays, CheckCircle2, RotateCcw, RefreshCw, Bell, Phone, Type, QrCode, UserCheck, Stethoscope, HeartPulse, Search, Sparkles } from "lucide-react";
import type { Patient } from "../../types";
import type { EMsg, ElderlyTab } from "./types";
import { agentTurnStream, extractProfile, fileToBase64 } from "../../lib/hermes";
import type { AgentTurnEvent, AgentAction } from "../../lib/hermes";
import { firstHighlightable } from "../../lib/changeHighlight";
import { buttonsFor, lastInteractiveIndex } from "../../lib/chatChoices";
import { anyMedicationRunningLow } from "../../lib/medications";
import { fetchProfile, saveProfile, toProfileDetails, mergeProfileDetails } from "../../lib/profile";
import type { WalkthroughTaskName, WalkthroughParams } from "../../lib/walkthrough/types";
import { firstRoutableAction, ACTION_TARGETS } from "../../lib/agentActions";
import { emitWalkthroughEvent } from "../../lib/walkthrough/bus";
import { PACING } from "../../lib/walkthrough/pacing";
import { useLanguage } from "../../lib/languageContext";
import { useAccessibility } from "../../accessibility.tsx";
import { t, LANGUAGE_OPTIONS, speechLangFor } from "../../lib/language";
import { speak as speakUtterance } from "../../lib/speech";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PhotoSourceSheet } from "../../components/PhotoSourceSheet";
import { BottomSheet } from "../../components/BottomSheet";

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

// Browser speech APIs (Web Speech). Both degrade gracefully when unsupported:
// no SpeechRecognition -> the mic button hides; no speechSynthesis -> replies
// are text-only. Voice itself is client-side; the agent turn stays text+image.
const SpeechRecognitionImpl: any =
  typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
const hasTTS = typeof window !== "undefined" && "speechSynthesis" in window;

// Chat history survives switching bottom-nav tabs (this screen unmounts/remounts
// each time), via sessionStorage — cleared automatically when the browser tab
// closes, and expired after SESSION_TTL_MS of INACTIVITY.
//
// Idle, not total. `startedAt` used to be stamped once at first mount and never
// refreshed, so a conversation begun 31 minutes ago was deleted out from under
// someone still using it — the opposite of "the chat stays until you clear it".
// The window itself is unchanged: an abandoned medication conversation on a
// shared device still expires, which is why this isn't simply removed.
const SESSION_TTL_MS = 30 * 60 * 1000;

// Sentinel id for the single transient "working on it" bubble a live turn may
// show — always at most one at a time, so a fixed id lets us update/replace it
// in place rather than accumulating one bubble per tool call. Module scope so
// the persist effect can strip it (it is UI state, never history).
const LIVE_STEP_ID = -1;

function loadChatSession(key: string): { messages: EMsg[]; startedAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { messages: EMsg[]; startedAt: number };
    if (Date.now() - parsed.startedAt > SESSION_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Mei's replies are meant to be plain text (soul.md), but LLMs sometimes slip
// in markdown anyway — render **bold** as real bold instead of showing the
// literal asterisks. Splits into text/strong nodes rather than using
// dangerouslySetInnerHTML, since this is LLM output.
function renderWithBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

// One row in the help list. Full-width rather than a tile grid: it's the largest
// tap target the frame allows and needs no left-to-right scanning, which matters
// more here than fitting more options above the fold.
function HelpRow({ icon: Icon, label, onClick, "data-walk": dataWalk }: {
  icon: any; label: string; onClick: () => void; "data-walk"?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-walk={dataWalk}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/50 transition-colors"
    >
      <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
        <Icon size={20} className="text-primary" />
      </div>
      <span className="flex-1 min-w-0 text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{label}</span>
      <ChevronRight size={20} className="text-muted-foreground shrink-0" />
    </button>
  );
}

// Seventeen flat rows was the whole list at once and read as a wall. The same
// items are now behind four category tiles: four choices on arrival, then a
// short focused list — the depth costs one tap and buys a screen someone can
// actually take in.
type CatId = "medicines" | "details" | "display" | "care";

export function ElderlyAIScreen({ patient, elderId, onNavigate, onMedsChanged, onMedAdded, onHighlightChange, onOpenTravel, autoMessage, prefillMessage, onAutoMessageConsumed, onPrefillConsumed, onWalkthroughStart, onHeaderOverride, walkthroughResetSignal }: {
  patient: Patient;
  elderId?: string;
  onNavigate: (tab: ElderlyTab) => void;
  onMedsChanged?: () => void | Promise<void>;
  onMedAdded?: (name: string) => void;
  // Canonical "highlight the exact record that changed" hook: handed the first
  // committed action carrying entity_type/entity_id/changed_fields, so the host
  // can mount ChangeHighlight. Replaces the name-string onMedAdded for Tier-A flows.
  onHighlightChange?: (action: AgentAction) => void;
  onOpenTravel: () => void;
  autoMessage?: string;
  // Seeds the input box only — never auto-sent, unlike autoMessage — so a
  // walkthrough step (or any other caller) can pre-fill without Mei sending on
  // the elder's behalf; they still tap Send themselves.
  prefillMessage?: string;
  // Called right after autoMessage/prefillMessage is consumed, so the parent
  // can clear its pending state. Without this, since this screen unmounts on
  // every tab switch, a stale autoMessage silently re-sends itself as a real
  // agent turn on every return to this tab.
  onAutoMessageConsumed?: () => void;
  onPrefillConsumed?: () => void;
  // Returns null when the walkthrough started, or a translation key explaining
  // why it could not — so the chat can SAY so instead of leaving the person
  // staring at a reply that promised a walkthrough which never appeared.
  onWalkthroughStart?: (taskName: WalkthroughTaskName, params?: WalkthroughParams) => string | null | void;
  // Lets a sub-view (a category, or the chat) REPLACE the app header instead of
  // stacking a second one beneath it. Cleared on unmount.
  onHeaderOverride?: (h: { title: string; onBack: () => void; action?: React.ReactNode } | null) => void;
  // Bumped by the host when a walkthrough starts. This screen keeps its own
  // help-vs-chat state, and a tour's onEnter can only switch bottom-nav tabs —
  // so a walkthrough begun FROM the chat (the normal way) left this screen in
  // chat mode, where the category tiles its first step spotlights don't exist
  // at all. Ignore the initial 0 so it can't steal a restored conversation.
  walkthroughResetSignal?: number;
}) {
  const { language, setLanguage } = useLanguage();
  const { voiceOutput, setVoiceOutput } = useAccessibility();
  // Key the saved chat by the signed-in user, not the (constant, mock) patient.id
  // — otherwise every account shares one chat. Each account restores its own.
  const storageKey = `mei-chat:${elderId ?? "anon"}`;
  const restored = loadChatSession(storageKey);
  const startedAtRef = useRef<number>(restored?.startedAt ?? Date.now());
  const [messages, setMessages] = useState<EMsg[]>(() => restored?.messages ?? []);
  const [input, setInput] = useState("");
  // The composer is always on screen; this only decides what fills the space
  // above it — the help buttons, or the conversation. Sending a message flips
  // it to "chat", and the header's back arrow flips it back.
  //
  // Seeded from the RESTORED thread, not hardcoded to "help". This screen
  // unmounts on every bottom-nav tab switch, so a hardcoded "help" dropped the
  // person back on the category tiles each time even though their conversation
  // was still sitting there intact behind the "Back to chat" pill. Clearing the
  // chat is the one thing that should return them to the buttons.
  const [mode, setMode] = useState<"help" | "chat">(restored?.messages?.length ? "chat" : "help");
  const [query, setQuery] = useState("");
  // A photo the user attached but hasn't sent yet — staged so they can type what
  // they want done with it, instead of us sending a fixed "here's my prescription".
  const [pendingImage, setPendingImage] = useState<{ base64: string; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMedPicker, setShowMedPicker] = useState(false);
  const [showLangSheet, setShowLangSheet] = useState(false);
  const [doctorQDraft, setDoctorQDraft] = useState<string | null>(null);
  const [category, setCategory] = useState<CatId | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reportCameraRef = useRef<HTMLInputElement>(null);
  const reportLibraryRef = useRef<HTMLInputElement>(null);
  const rxCameraRef = useRef<HTMLInputElement>(null);
  const rxLibraryRef = useRef<HTMLInputElement>(null);
  const [pickerFor, setPickerFor] = useState<null | "rx" | "report">(null);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // This screen unmounts on every bottom-nav tab switch. A chat turn is a live
  // network call — guard its post-await continuation so a turn the user walked
  // away from can't navigate/highlight a screen they're no longer looking at.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const uniqueMeds = [...new Set(patient.medications.map(m => m.name))];
  // Which message hosts the answer buttons this turn (see lib/chatChoices.ts).
  const interactiveIndex = lastInteractiveIndex(messages);

  // A walkthrough is starting: show the help tiles it expects to spotlight. The
  // conversation is untouched — the "Back to chat" pill returns to it.
  useEffect(() => {
    if (!walkthroughResetSignal) return;
    setMode("help");
    setCategory(null);
    setQuery("");
  }, [walkthroughResetSignal]);
  const canSend = !!input.trim() || !!pendingImage;
  // The refill walkthrough spotlights a per-medicine button that now only
  // exists below half supply. With nothing low it would dim the screen and
  // point at nothing, so fall back to asking Mei — which always works.
  const anyRunningLow = anyMedicationRunningLow(patient.medications);

  // Glide to the newest message instead of snapping: a jump-cut under a bubble
  // that is itself animating in is what made the arrival read as abrupt. The
  // 60ms wait lets the new bubble lay out first, so we scroll to its real
  // height. Anyone who asked the OS for less motion still gets the instant jump.
  // `instant` is for arriving at an already-long thread (opening the chat, or
  // sending from the help view): gliding through every past message would be a
  // long ride to somewhere the person hasn't read yet.
  const scrollToBottom = (instant = false) => setTimeout(() => {
    const el = scrollRef.current;
    if (!el) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: instant || reduced ? "auto" : "smooth" });
  }, 60);

  // Persist chat history so it survives switching bottom-nav tabs (this screen
  // unmounts/remounts each time) — sessionStorage clears on its own when the
  // tab closes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Sending or receiving IS activity — refresh the idle window so a live
    // conversation is never deleted mid-use.
    startedAtRef.current = Date.now();
    const persistable = messages
      // The transient "working on it" chip is UI state for one in-flight turn,
      // never history. Persisting it restored a phantom bubble that the next
      // turn's filter then deleted from under the reader.
      .filter(m => m.id !== LIVE_STEP_ID)
      // blob: object URLs (attached photos) die on a page reload — persisting one
      // restores a broken-image icon. Drop the ref on save; the message text stays.
      .map(m => (m.image?.startsWith("blob:") ? { ...m, image: undefined } : m));
    sessionStorage.setItem(storageKey, JSON.stringify({ messages: persistable, startedAt: startedAtRef.current }));
  }, [messages, storageKey]);

  // Grow the input with its content instead of staying pinned to one row —
  // without this, once text wraps to a second line the textarea's fixed
  // single-row height just auto-scrolls to keep the caret in view, hiding the
  // first line rather than actually showing both.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`; // matches max-h-40
  }, [input, mode]);

  // Expire the session after SESSION_TTL_MS of INACTIVITY even if the person
  // never leaves this screen, not just on the next remount. The persist effect
  // above refreshes startedAt on every message, so this can only fire on a
  // conversation nobody has touched for half an hour — it used to fire on the
  // clock regardless, wiping a chat someone was still in the middle of.
  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - startedAtRef.current > SESSION_TTL_MS) {
        startedAtRef.current = Date.now();
        setMessages([]);
      }
    }, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real TTS via the browser's speechSynthesis, in the chosen language
  // (Hokkien falls back to Mandarin — no browser voice exists for it).
  const speak = (text: string) => {
    if (!voiceOutput || !hasTTS || !text) return;
    speakUtterance(text, speechLangFor(language), {
      onStart: () => setIsSpeaking(true),
      onEnd: () => setIsSpeaking(false),
    });
  };

  // Real dictation via the browser's SpeechRecognition (mic button is hidden
  // when the browser doesn't support it).
  const handleMic = () => {
    if (!SpeechRecognitionImpl) return;
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SpeechRecognitionImpl();
    recognitionRef.current = rec;
    rec.lang = speechLangFor(language);
    rec.interimResults = false;
    rec.onresult = (e: any) => setInput(e.results[0]?.[0]?.transcript ?? "");
    rec.onend = () => setIsListening(false);
    rec.onerror = () => setIsListening(false);
    setIsListening(true);
    rec.start();
  };

  const send = async (text: string, imageBase64?: string, pdfBase64?: string, displayImage?: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    // Leaving a category open would strand its title + back arrow in the app
    // header while the conversation is what's actually on screen.
    setMode("chat");
    setCategory(null);
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: trimmed, time: nowLabel(), image: displayImage }]);
    scrollToBottom(mode === "help"); // sending from the buttons view arrives cold, with no scroll to glide
    setSending(true);

    // Live, as-it-happens progress: the moment a routable write's tool call
    // starts we show a "working on it" bubble, and the moment it lands (not
    // once the whole reply text is back) we navigate — "first wins" if a turn
    // commits more than one routable action, matching firstRoutableAction below.
    let navigated = false;
    const onEvent = (event: AgentTurnEvent) => {
      const target = event.tool ? ACTION_TARGETS[event.tool] : undefined;
      if (!target) return;
      if (event.type === "tool_start") {
        const label = t(language, target.labelKey);
        setMessages(prev => [
          ...prev.filter(m => m.id !== LIVE_STEP_ID),
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.workingOnYourLabel", { label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
      } else if (event.type === "tool_end") {
        // Clear the chip UNCONDITIONALLY. It used to be removed only inside the
        // committed branch below, so on a propose turn — precisely the turn that
        // ends by asking "shall I save it?" — "Updating your medicines…" sat
        // above the question forever.
        setMessages(prev => prev.filter(m => m.id !== LIVE_STEP_ID));
        // Only navigate once the tool actually COMMITTED a write this dispatch —
        // a propose/clarify turn (e.g. log_dose asking which dose) runs the tool
        // but writes nothing, and must not yank the screen to the result page.
        if (event.is_error || !event.committed || navigated || target.confirmFirst) return;
        navigated = true;
        const done = t(language, target.doneKey);
        const label = t(language, target.labelKey);
        setMessages(prev => [
          ...prev.filter(m => m.id !== LIVE_STEP_ID),
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.openingYourLabel", { done, detail: "", label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
        // Screen-transition settle shared with the walkthrough engine.
        setTimeout(() => { if (mountedRef.current) onNavigate(target.elderly); }, PACING.NAVIGATE_MS);
      }
    };

    const { reply, actions, walkthrough, choices, awaiting_confirmation, rateLimited } = await agentTurnStream(trimmed, onEvent, imageBase64, pdfBase64, completedWalkthroughs, "elder");
    // User switched tabs mid-turn: this screen is gone. Don't touch parent state
    // or navigate/highlight a screen they're no longer on (the callbacks below
    // are parent-owned and survive this unmount).
    if (!mountedRef.current) return;
    setMessages(prev => [...prev.filter(m => m.id !== LIVE_STEP_ID), { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel(), isRateLimited: rateLimited, choices: choices ?? undefined, awaitingConfirmation: awaiting_confirmation }]);
    setSending(false);
    scrollToBottom();
    speak(reply);
    // A walkthrough takes over the whole app shell, so the chat sheet has to get
    // out of the way or it would cover the very thing being spotlighted.
    if (walkthrough) {
      setMode("help");
      const refusal = onWalkthroughStart?.(walkthrough.task_name as WalkthroughTaskName, walkthrough.params);
      if (refusal) {
        // The host declined (wrong shell, or a precondition like "nothing is
        // running low"). Mei has already said she'll show them, so say plainly
        // that she can't — dead air here is what "it just brings me to my chat
        // page" was.
        setMode("chat");
        setMessages(prev => [...prev, { id: Date.now() + 3, role: "agent", text: t(language, refusal), time: nowLabel(), isConfirmation: true }]);
        scrollToBottom();
      }
    }
    // Gated for a walkthrough's "agent-action-committed" step: the real
    // committed_actions this turn, never tools_used (proposed but not saved).
    if (actions.length) emitWalkthroughEvent("agent-action-committed", { tools: actions.map(a => a.tool) });
    // Refresh medication state whenever the agent committed *any* write this turn
    // (not only routable ones) — awaited + caught so a failed refetch surfaces
    // instead of silently leaving screens (e.g. the timeline) stale.
    if (actions.length) {
      try {
        await onMedsChanged?.();
      } catch (err) {
        console.warn("[dosewise] medication refresh after agent write failed:", err);
      }
    }
    // Canonical proof-of-change: highlight the EXACT record that changed by
    // entity_type/entity_id, with a caption built from changed_fields. Falls back
    // to the legacy name-string card highlight only if the action lacks entity ids
    // (a tool not yet migrated to record_action).
    const highlight = firstHighlightable(actions);
    if (highlight) {
      onHighlightChange?.(highlight);
    } else {
      const added = actions.find(a => a.tool === "add_prescription");
      if (added?.name) onMedAdded?.(added.name);
    }
    // The live tool_end handler above already showed the confirmation bubble and
    // navigated for the common case. This only fires as a fallback — e.g. a
    // routable action whose event never arrived (older/non-streaming path).
    if (!navigated) {
      const routed = firstRoutableAction(actions);
      if (routed) {
        const detail = routed.action.tool === "add_prescription" && routed.action.summary ? `: ${routed.action.summary}` : "";
        const done = t(language, routed.target.doneKey);
        const label = t(language, routed.target.labelKey);
        setMessages(prev => [...prev, { id: Date.now() + 2, role: "agent", text: t(language, "ai.openingYourLabel", { done, detail, label }), time: nowLabel(), isConfirmation: true }]);
        scrollToBottom();
        setTimeout(() => { if (mountedRef.current) onNavigate(routed.target.elderly); }, 1200);
      }
    }
  };

  // Attach a photo: stage it on the composer so the person can type what they
  // want done with it ("what is this pill?", "add this to my list", …) rather
  // than us assuming it's a prescription.
  const onRxPhotoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMode("chat");
    setCategory(null);
    setPendingImage({ base64: await fileToBase64(file), url: URL.createObjectURL(file) });
    inputRef.current?.focus();
  };

  const handleSend = () => {
    const text = input.trim();
    if ((!text && !pendingImage) || sending) return;
    const img = pendingImage;
    setInput("");
    setPendingImage(null);
    // If they attached a photo but typed nothing, fall back to a neutral prompt.
    send(text || t(language, "ai.photoDefaultPrompt"), img?.base64, undefined, img?.url);
  };

  // Open the chat with a request already typed in — the elder still taps Send,
  // so nothing is ever asked on their behalf. Used by the help rows whose task
  // needs real values from them before Mei can carry it out.
  const openChatWith = (prefill: string) => {
    setInput(prefill);
    setCategory(null);
    setTimeout(() => inputRef.current?.focus(), 80);
  };

  useEffect(() => {
    if (autoMessage) {
      send(autoMessage);
      onAutoMessageConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (prefillMessage) {
      setInput(prefillMessage);
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetched once so agent turns can tell Mei which walkthroughs this elder has
  // already been shown (server-side proactive-offer suppression) — a stale
  // read until the next remount is an accepted tradeoff, same as this app's
  // other per-session profile caches.
  const [completedWalkthroughs, setCompletedWalkthroughs] = useState<string[]>([]);
  useEffect(() => {
    if (!elderId) return;
    fetchProfile(elderId).then(profile => {
      setCompletedWalkthroughs(profile?.details.completedWalkthroughs ?? []);
    });
  }, [elderId]);

  // Start the conversation over: an EMPTY thread (there is no canned greeting
  // any more — the shared header replaced it) and a fresh session window, so
  // the restored-session TTL doesn't immediately expire the new chat.
  const clearChat = () => {
    startedAtRef.current = Date.now();
    setMessages([]);
    setShowClearConfirm(false);
    setMode("help");
    scrollToBottom();
  };

  // "Update profile": the clinic report goes to Hermes's structured
  // /profile/extract endpoint, and the fields it reads are merged into the saved
  // profile (existing values kept; new conditions/allergies unioned). We then
  // redirect to Settings so the change is visible + auditable. If nothing
  // structured comes back, fall back to the conversational agent path.
  const onReportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const b64 = await fileToBase64(file);
    const isPdf = file.type === "application/pdf";
    const msg = t(language, "ai.reportMsgMine");
    setMode("chat");
    setCategory(null);
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: msg, time: nowLabel(), image: isPdf ? undefined : URL.createObjectURL(file) }]);
    scrollToBottom();

    // No identity yet → can't persist; let the agent handle it conversationally.
    if (!elderId) {
      send(msg, isPdf ? undefined : b64, isPdf ? b64 : undefined);
      return;
    }

    setSending(true);
    try {
      const { fields } = await extractProfile(isPdf ? undefined : b64, isPdf ? b64 : undefined);
      const details = toProfileDetails(fields);
      if (Object.keys(details).length === 0) {
        setSending(false);
        // Nothing structured we can save — fall back to the conversational agent.
        send(msg, isPdf ? undefined : b64, isPdf ? b64 : undefined);
        return;
      }
      const prof = await fetchProfile(elderId);
      const merged = mergeProfileDetails(prof?.details ?? {}, details);
      await saveProfile(elderId, "elder", prof?.fullName ?? fields.full_name ?? "", merged);

      const parts: string[] = [];
      if (details.conditions?.length) parts.push(t(language, "settings.medicalConditions"));
      if (details.allergies?.length) parts.push(t(language, "settings.generalAllergies"));
      if (details.drugAllergies?.length) parts.push(t(language, "settings.medicationAllergies"));
      if (details.dob) parts.push(t(language, "settings.dob"));
      if (details.gender) parts.push(t(language, "settings.gender"));
      if (details.weightKg != null) parts.push(t(language, "settings.weightKg"));
      if (details.heightCm != null) parts.push(t(language, "settings.heightCm"));
      const summary = parts.join(", ");
      const confirmText = t(language, "ai.profileUpdated", { summary });
      setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: confirmText, time: nowLabel(), isConfirmation: true }]);
      setSending(false);
      scrollToBottom();
      speak(confirmText);
      setTimeout(() => onNavigate("settings"), 1400);
    } catch (err) {
      console.warn("[dosewise] profile autofill failed:", err);
      setSending(false);
      send(msg, isPdf ? undefined : b64, isPdf ? b64 : undefined);
    }
  };

  // Every help-tile launch goes through here, and it MUST surface a refusal the
  // same way the chat reply path does. Discarding the returned reason is how the
  // tile path stayed dead air after the chat path was fixed: tapping "Show me:
  // my emergency contact" with no caregiver linked did nothing at all, only a
  // console.warn — the exact "Mei says she'll show you and then nothing happens"
  // failure this whole return value exists to end.
  const startWalk = (task: WalkthroughTaskName, params?: WalkthroughParams) => {
    const refusal = onWalkthroughStart?.(task, params);
    if (!refusal) return;
    // Show it in the conversation, not as a toast: it answers a question the
    // person just asked, and the composer underneath is how they follow up.
    setMode("chat");
    setCategory(null);
    setMessages(prev => [...prev, { id: Date.now(), role: "agent", text: t(language, refusal), time: nowLabel(), isConfirmation: true }]);
    scrollToBottom();
  };

  const CATEGORIES: Record<CatId, { icon: any; title: string; items: { icon: any; label: string; run: () => void; walk?: string }[] }> = {
    medicines: {
      icon: Pill,
      title: t(language, "ai.catMedicines"),
      items: [
        { icon: Camera,       label: t(language, "ai.rowAddMedPhoto"),           run: () => setPickerFor("rx") },
        { icon: Pill,         label: t(language, "ai.rowAddMed"),                run: () => openChatWith(t(language, "ai.prefillAddMed")) },
        { icon: RefreshCw,    label: t(language, "prescription.requestRefill"),  run: () => (anyRunningLow ? startWalk("request_refill") : openChatWith(t(language, "ai.suggestRefills"))) },
        { icon: Stethoscope,  label: t(language, "ai.askAboutMed"),              run: () => setShowMedPicker(true) },
        { icon: CheckCircle2, label: t(language, "ai.rowLogDose"),               run: () => startWalk("log_dose") },
        { icon: RotateCcw,    label: t(language, "ai.rowUndoDose"),              run: () => startWalk("undo_dose") },
        { icon: Plane,        label: t(language, "common.travelMode"),           run: onOpenTravel, walk: "elder-travelmode-tile" },
      ],
    },
    details: {
      icon: HeartPulse,
      title: t(language, "ai.catDetails"),
      items: [
        { icon: HeartPulse,   label: t(language, "ai.rowAddCondition"),          run: () => openChatWith(t(language, "ai.prefillAddCondition")) },
        { icon: FileText,     label: t(language, "ai.updateProfile"),            run: () => setPickerFor("report") },
        { icon: CalendarDays, label: t(language, "ai.rowCheckSchedule"),         run: () => startWalk("check_schedule") },
        { icon: Stethoscope,  label: t(language, "ai.rowDoctorQ"),               run: () => setDoctorQDraft(""), walk: "elder-doctorq-row" },
      ],
    },
    display: {
      icon: Type,
      title: t(language, "ai.catDisplay"),
      items: [
        { icon: Type,   label: t(language, "ai.rowContrast"),             run: () => startWalk("text_size") },
        { icon: Bell,   label: t(language, "ai.rowManageAlerts"),         run: () => startWalk("reminder_settings") },
        // Show-me-how variants of the two above: Mei drives the spotlight
        // herself rather than waiting on the person to tap each control.
        { icon: Globe,  label: t(language, "ai.rowLanguageTour"),         run: () => startWalk("language_voice_tour") },
        { icon: Bell,   label: t(language, "ai.rowNotificationsTour"),    run: () => startWalk("notifications_tour") },
      ],
    },
    care: {
      icon: UserCheck,
      title: t(language, "ai.catCare"),
      items: [
        // The guided version of the row above — Mei walks to the card herself.
        { icon: Phone,     label: t(language, "ai.rowEmergencyTour"),       run: () => startWalk("emergency_contact_tour") },
        { icon: QrCode,    label: t(language, "ai.rowShowQr"),              run: () => startWalk("link_caregiver") },
        { icon: UserCheck, label: t(language, "ai.rowAcceptCaregiver"),     run: () => startWalk("accept_caregiver_link") },
      ],
    },
  };

  const searchResults = query.trim()
    ? (Object.keys(CATEGORIES) as CatId[]).flatMap(id =>
        CATEGORIES[id].items
          .filter(i => i.label.toLowerCase().includes(query.trim().toLowerCase()))
          .map(i => ({ ...i, cat: CATEGORIES[id].title })))
    : [];

  // A category or the chat takes over the app header rather than adding a
  // second one under it. Cleared on unmount so switching tabs can't strand it.
  useEffect(() => {
    if (category) {
      onHeaderOverride?.({ title: CATEGORIES[category].title, onBack: () => setCategory(null) });
    } else {
      onHeaderOverride?.(null);
    }
    return () => onHeaderOverride?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, language]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      {/* ONE header for both faces of this screen — same title, same place. Only
          the switch button flips direction, so moving between the buttons and
          the conversation never reads as a different screen (and sending a
          message never spawns tabs). The switch waits for a conversation to
          exist, since before that there's nothing to switch to. */}
      {!category && (
        <div className="px-4 pt-3 shrink-0 flex items-center gap-2">
          <h2 className="flex-1 min-w-0 truncate dw-display text-[calc(20px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "common.askMei")}</h2>
          {messages.length > 0 && (
            <button
              onClick={() => { setMode(mode === "chat" ? "help" : "chat"); scrollToBottom(true); }}
              data-walk={mode === "chat" ? "elder-ai-frequently-used" : "elder-ai-back-to-chat"}
              className="shrink-0 flex items-center gap-1.5 rounded-full dw-surface px-3.5 py-2 active:bg-muted transition-colors"
            >
              {mode === "chat"
                ? <Sparkles size={17} className="text-primary shrink-0" />
                : <MessageCircle size={17} className="text-primary shrink-0" />}
              <span className="text-[calc(14px*var(--dw-text,1))] font-bold text-foreground whitespace-nowrap">{t(language, mode === "chat" ? "ai.frequentlyUsed" : "ai.backToChat")}</span>
            </button>
          )}
          {mode === "chat" && (
            <button onClick={() => setShowClearConfirm(true)} aria-label={t(language, "ai.clearChat")} className="w-11 h-11 rounded-full dw-surface flex items-center justify-center shrink-0 active:bg-muted transition-colors">
              <Trash2 size={18} className="text-muted-foreground" />
            </button>
          )}
        </div>
      )}

      {/* One scroll area above a permanent composer. Chat is a MODE, not a
          separate sheet — the text box never leaves, so typing is always the
          obvious way out of a dead end. */}
      {mode === "chat" ? (
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3 dw-view-in">
          {messages.map((msg, i) => msg.isRateLimited ? (
            <div key={msg.id} className="flex justify-center dw-msg-in">
              <div className="flex items-center gap-1.5 bg-warn-bg border border-warn-border text-warn-fg rounded-full px-3.5 py-1.5">
                <AlertTriangle size={15} className="text-warn shrink-0" />
                <span className="text-[calc(14px*var(--dw-text,1))] font-bold">{msg.text}</span>
              </div>
            </div>
          ) : msg.isConfirmation ? (
            <div key={msg.id} className="flex justify-center dw-msg-in">
              <div className="flex items-center gap-1.5 bg-taken-bg border border-taken-border text-taken-fg rounded-full px-3.5 py-1.5">
                <Check size={15} className="text-taken shrink-0" />
                <span className="text-[calc(14px*var(--dw-text,1))] font-bold">{msg.text.replace(/^✓\s*/, "")}</span>
              </div>
            </div>
          ) : (
            <div key={msg.id} className={`dw-msg-in flex gap-2 ${msg.role === "user" ? "justify-end origin-bottom-right" : "justify-start origin-bottom-left"}`}>
              {msg.role === "agent" && (
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center shrink-0 mt-1">
                  <span className="text-primary-foreground text-[calc(14px*var(--dw-text,1))] font-bold">M</span>
                </div>
              )}
              <div className={`max-w-[82%] flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                {msg.image && (
                  <img src={msg.image} alt={t(language, "ai.attachment")} className="max-w-[70%] rounded-2xl border border-border object-cover" />
                )}
                <div className={`rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "dw-surface rounded-tl-sm"}`}>
                  <p className={`text-[calc(15px*var(--dw-text,1))] leading-relaxed whitespace-pre-line ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>{renderWithBold(msg.text)}</p>
                  {msg.isClinic && <p className="text-[calc(13px*var(--dw-text,1))] mt-2 opacity-70 italic">{t(language, "ai.verifyWithDoctor")}</p>}
                </div>
                {/* Tappable answer buttons — the agent's own (offer_choices) or a
                    synthesized Yes/No when Hermes says a confirm is pending, so
                    nobody has to type "yes" to save something. Anchored on the
                    last message that HAS buttons, not on messages.length-1: a
                    turn that both commits and asks a follow-up appends its
                    confirmation chip after the reply, which used to hide them. */}
                {i === interactiveIndex && !sending && buttonsFor(msg, language).length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {buttonsFor(msg, language).map((c, ci) => (
                      <button
                        key={ci}
                        onClick={() => send(c.value)}
                        className="px-4 py-2 rounded-full bg-primary/10 border border-primary/30 text-primary text-[calc(14px*var(--dw-text,1))] font-bold active:scale-95 transition-transform"
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[calc(12px*var(--dw-text,1))] text-muted-foreground px-1">{msg.time}</p>
              </div>
            </div>
          ))}
          {isListening && (
            <div className="flex justify-center py-2">
              <div className="flex items-center gap-2 bg-missed-bg border border-missed-border rounded-full px-4 py-2">
                <div className="w-2.5 h-2.5 bg-destructive rounded-full animate-pulse" />
                <span className="text-[calc(14px*var(--dw-text,1))] text-missed-fg font-bold">{t(language, "ai.listening")}</span>
              </div>
            </div>
          )}
        </div>
      ) : category ? (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pt-3 pb-4 space-y-3">
          <div className="dw-surface divide-y divide-border overflow-hidden">
            {CATEGORIES[category].items.map(item => (
              <HelpRow key={item.label} icon={item.icon} label={item.label} onClick={item.run} data-walk={item.walk} />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pt-3 pb-4 space-y-3.5" data-tour="elder-quickhelp">
          <div className="relative">
            <Search size={19} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t(language, "ai.searchPlaceholder")}
              data-walk="elder-help-search"
              className="w-full h-12 bg-input-background border border-border rounded-2xl pl-11 pr-11 text-[calc(15px*var(--dw-text,1))] text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label={t(language, "common.cancel")} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <X size={16} className="text-muted-foreground" />
              </button>
            )}
          </div>

          {query.trim() ? (
            <div className="dw-surface divide-y divide-border overflow-hidden">
              {searchResults.map(r => (
                <button
                  key={`${r.cat}-${r.label}`}
                  onClick={() => { setQuery(""); r.run(); }}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/50 transition-colors"
                >
                  <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                    <r.icon size={20} className="text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{r.label}</p>
                    <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{r.cat}</p>
                  </div>
                  <ChevronRight size={20} className="text-muted-foreground shrink-0" />
                </button>
              ))}
              {searchResults.length === 0 && (
                <p className="px-4 py-6 text-[calc(15px*var(--dw-text,1))] text-muted-foreground text-center">{t(language, "settings.noResults", { q: query.trim() })}</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {(Object.keys(CATEGORIES) as CatId[]).map(id => {
                const cat = CATEGORIES[id];
                return (
                  <button
                    key={id}
                    onClick={() => setCategory(id)}
                    data-walk={`elder-cat-${id}`}
                    className="dw-surface dw-press p-4 h-[140px] flex flex-col items-center justify-center gap-2.5 text-center"
                  >
                    <div className="w-12 h-12 rounded-2xl bg-secondary flex items-center justify-center">
                      <cat.icon size={24} className="text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-foreground leading-tight">{cat.title}</p>
                      <p className="text-[calc(12px*var(--dw-text,1))] text-muted-foreground mt-0.5">{t(language, "ai.catCount", { count: cat.items.length })}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {isSpeaking && (
        <div className="px-4 py-1 shrink-0">
          <div className="flex items-center gap-1.5 text-primary">
            <Volume2 size={15} />
            <span className="text-[calc(14px*var(--dw-text,1))] font-bold">{t(language, "ai.speaking")}{language !== "en" ? ` in ${LANGUAGE_OPTIONS.find(o => o.id === language)?.label}` : ""}…</span>
          </div>
        </div>
      )}

      {mode === "chat" && (
        <div className="px-4 pb-2 shrink-0">
          <div
            className="flex gap-2 overflow-x-auto scrollbar-none pb-1"
            onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
          >
            {[t(language, "ai.suggestTookMed"), t(language, "ai.suggestWhatDoITake"), t(language, "ai.suggestRefills"), t(language, "ai.suggestHelp")].map(s => (
              <button key={s} onClick={() => setInput(s)} className="shrink-0 bg-muted text-foreground rounded-full px-3.5 py-2 text-[calc(14px*var(--dw-text,1))] font-bold whitespace-nowrap active:bg-secondary transition-colors">
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Composer — always present, in both modes. */}
      <div className="px-4 pb-3 pt-2 border-t border-border/60 shrink-0">
        {pendingImage && (
          <div className="flex items-center gap-2.5 mb-2 bg-secondary border border-primary/20 rounded-xl p-2">
            <img src={pendingImage.url} alt={t(language, "ai.attachment")} className="w-12 h-12 rounded-lg object-cover shrink-0" />
            <span className="flex-1 text-[calc(14px*var(--dw-text,1))] text-secondary-foreground font-semibold">{t(language, "ai.photoAttachedHint")}</span>
            <button onClick={() => setPendingImage(null)} aria-label={t(language, "common.cancel")} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0">
              <X size={16} />
            </button>
          </div>
        )}
        {/* Camera and mic sit INSIDE the field: as three outside buttons they
            left the text box barely wider than the buttons themselves, and all
            three still need to be reachable at once. */}
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0 bg-input-background rounded-2xl border border-border min-h-12 flex items-end gap-0.5 pl-1.5 pr-3 py-1.5">
            <button onClick={() => setPickerFor("rx")} aria-label={t(language, "common.addPrescription")} className="w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground shrink-0 active:bg-muted transition-colors">
              <Camera size={19} />
            </button>
            {SpeechRecognitionImpl && (
              <button onClick={handleMic} aria-label={t(language, "ai.listening")} className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${isListening ? "bg-destructive text-white" : "text-muted-foreground active:bg-muted"}`}>
                <Mic size={19} />
              </button>
            )}
            <textarea
              ref={inputRef}
              data-walk="elder-ai-composer"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={t(language, pendingImage ? "ai.photoNotePlaceholder" : "ai.askAnything")}
              className="flex-1 min-w-0 bg-transparent text-foreground text-[calc(15px*var(--dw-text,1))] resize-none outline-none max-h-40 leading-relaxed py-2 placeholder:text-muted-foreground"
              rows={1}
            />
          </div>
          <button onClick={handleSend} disabled={!canSend || sending} data-walk="elder-ai-send-button" aria-label={t(language, "notifications.send")} className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 dw-press">
            <Send size={20} />
          </button>
        </div>
        <p className="text-center text-[calc(12px*var(--dw-text,1))] text-muted-foreground mt-1.5">{t(language, "ai.disclaimer")}</p>
      </div>

      {/* Ask a doctor: collect the real question here rather than letting the
          walkthrough invent one, then hand it to the autonomous walkthrough as
          params so the elder watches it being filed under Reminders. */}
      {doctorQDraft !== null && (
        <BottomSheet onClose={() => setDoctorQDraft(null)}>
          <div>
            <div className="flex items-start justify-between gap-2 mb-3">
              <h3 className="font-['Fraunces'] text-[calc(18px*var(--dw-text,1))] font-semibold text-foreground leading-tight">{t(language, "ai.doctorQPrompt")}</h3>
              <button onClick={() => setDoctorQDraft(null)} aria-label={t(language, "common.cancel")} className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0"><X size={20} className="text-muted-foreground" /></button>
            </div>
            <textarea
              autoFocus
              value={doctorQDraft}
              onChange={e => setDoctorQDraft(e.target.value)}
              placeholder={t(language, "ai.questionForDoctorPlaceholder")}
              className="w-full bg-input-background rounded-xl px-4 py-3 text-[calc(15px*var(--dw-text,1))] text-foreground outline-none resize-none leading-relaxed placeholder:text-muted-foreground min-h-[96px] border border-border focus:border-primary transition-colors"
            />
            <button
              onClick={() => {
                const q = doctorQDraft.trim();
                if (!q) return;
                setDoctorQDraft(null);
                startWalk("add_doctor_question_auto", { question: q });
              }}
              disabled={!doctorQDraft.trim()}
              className="mt-3 w-full py-4 rounded-2xl bg-primary text-primary-foreground text-[calc(16px*var(--dw-text,1))] font-bold disabled:opacity-40 active:scale-[0.98] transition-transform"
            >
              {t(language, "ai.doctorQShow")}
            </button>
          </div>
        </BottomSheet>
      )}

      {showMedPicker && (
        <BottomSheet onClose={() => setShowMedPicker(false)}>
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="font-['Fraunces'] text-[calc(18px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "ai.whichMedication")}</h3>
              <button onClick={() => setShowMedPicker(false)} aria-label={t(language, "common.cancel")} className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0"><X size={20} className="text-muted-foreground" /></button>
            </div>
            <div className="flex flex-col gap-2">
              {uniqueMeds.map(n => (
                <button key={n} onClick={() => { setShowMedPicker(false); send(`What is ${n} for?`); }} className="w-full text-left text-[calc(15px*var(--dw-text,1))] font-semibold bg-secondary border border-primary/20 text-secondary-foreground rounded-xl px-4 py-3.5 active:opacity-80 transition-opacity">
                  {n}
                </button>
              ))}
              {uniqueMeds.length === 0 && <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.empty")}</p>}
            </div>
          </div>
        </BottomSheet>
      )}

      {/* Hidden inputs backing "Update profile" and "Add prescription" — each
          flow gets a camera-capture input and a plain library/Files input, so
          PhotoSourceSheet's two options are always both reachable. */}
      <input ref={reportCameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onReportFile} />
      <input ref={reportLibraryRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onReportFile} />
      <input ref={rxCameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onRxPhotoFile} />
      <input ref={rxLibraryRef} type="file" accept="image/*" data-walk="rx-attach-library" className="sr-only" onChange={onRxPhotoFile} />
      {pickerFor && (
        <PhotoSourceSheet
          onTakePhoto={() => {
            (pickerFor === "rx" ? rxCameraRef : reportCameraRef).current?.click();
            setPickerFor(null);
          }}
          onChooseFile={() => {
            (pickerFor === "rx" ? rxLibraryRef : reportLibraryRef).current?.click();
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}

      {/* Language & voice sheet — still reachable from the chat's own quick
          switch, kept because it changes how Mei speaks mid-conversation. */}
      {showLangSheet && (
        <BottomSheet onClose={() => setShowLangSheet(false)}>
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-['Fraunces'] text-[calc(19px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "ai.languageVoice")}</h3>
              <button onClick={() => setShowLangSheet(false)} aria-label={t(language, "common.cancel")} className="w-10 h-10 rounded-full bg-muted flex items-center justify-center"><X size={20} className="text-muted-foreground" /></button>
            </div>
            <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-foreground mb-2">{t(language, "settings.language")}</p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {LANGUAGE_OPTIONS.map(l => (
                <button key={l.id} onClick={() => setLanguage(l.id)} className={`py-3.5 rounded-xl text-[calc(14px*var(--dw-text,1))] font-bold border transition-colors ${language === l.id ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}>
                  {l.label}
                </button>
              ))}
            </div>
            <button onClick={() => setVoiceOutput(!voiceOutput)} className="w-full flex items-center justify-between bg-card border border-border rounded-xl px-4 py-4">
              <div className="flex items-center gap-2"><Volume2 size={20} className="text-primary" /><span className="text-[calc(15px*var(--dw-text,1))] font-bold text-foreground">{t(language, "settings.readAloud")}</span></div>
              <div className={`w-12 h-7 rounded-full transition-colors relative ${voiceOutput ? "bg-primary" : "bg-switch-background"}`}>
                <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${voiceOutput ? "left-[22px]" : "left-0.5"}`} />
              </div>
            </button>
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground mt-3">{t(language, "ai.voiceHint")}</p>
          </div>
        </BottomSheet>
      )}

      {showClearConfirm && (
        <ConfirmDialog
          title={t(language, "confirm.clearChatTitle")}
          body={t(language, "confirm.clearChatBody")}
          confirmLabel={t(language, "ai.clearChat")}
          onConfirm={clearChat}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
}

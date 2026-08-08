import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Send, TrendingUp, Plane, Check, Sparkles, MessageCircle, Camera, FileText, Pill, Globe, Mic, Volume2, X, Trash2, AlertTriangle, ChevronRight, Search, Stethoscope, RefreshCw, MessageSquare, CalendarDays, QrCode, Users, Bell, ChevronDown, CheckCircle2, SlidersHorizontal, ChevronLeft } from "lucide-react";
import type { Patient, Screen } from "../types";
import { ProfileAvatar } from "../components/shared";
import { agentTurnStream, fileToBase64 } from "../lib/hermes";
import type { AgentTurnEvent, AgentAction, WalkthroughRisk } from "../lib/hermes";
import { firstRoutableAction, ACTION_TARGETS } from "../lib/agentActions";
import { firstHighlightable } from "../lib/changeHighlight";
import { buttonsFor, lastInteractiveIndex } from "../lib/chatChoices";
import { emitWalkthroughEvent } from "../lib/walkthrough/bus";
import { fetchProfile } from "../lib/profile";
import type { WalkthroughTaskName, WalkthroughParams } from "../lib/walkthrough/types";
import { PACING } from "../lib/walkthrough/pacing";
import { WeeklySummarySheet } from "./WeeklySummarySheet";
import { TravelModeSheet } from "./TravelModeSheet";
import { useLanguage } from "../lib/languageContext";
import { useAccessibility } from "../accessibility.tsx";
import { t, LANGUAGE_OPTIONS, speechLangFor } from "../lib/language";
import { speakReply as speakUtterance, stopSpeaking } from "../lib/speech";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PhotoSourceSheet } from "../components/PhotoSourceSheet";
import { BottomSheet } from "../components/BottomSheet";

interface ChatMsg { id: number; role: "user" | "agent"; text: string; time: string; isConfirmation?: boolean; isRateLimited?: boolean; image?: string; choices?: { label: string; value: string }[]; awaitingConfirmation?: boolean }

// Chat history survives leaving this screen (it unmounts on every caregiver
// navigation), via sessionStorage — same contract as the elder chat. Expiry is
// IDLE, not total: the persist effect restamps startedAt on every message, so a
// live conversation is never deleted mid-use.
const SESSION_TTL_MS = 30 * 60 * 1000;

// At most one transient "working on it" bubble per turn, so a fixed id lets us
// replace it in place. Module scope: the persist effect strips it, because it is
// UI state for one in-flight turn and never history.
const LIVE_STEP_ID = -1;

function loadChatSession(key: string): { messages: ChatMsg[]; startedAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { messages: ChatMsg[]; startedAt: number };
    if (Date.now() - parsed.startedAt > SESSION_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

// Browser speech APIs (Web Speech). Both degrade gracefully when unsupported:
// no SpeechRecognition -> the mic button hides; no speechSynthesis -> replies
// are text-only. Voice itself is client-side; the agent turn stays text+image.
const SpeechRecognitionImpl: any =
  typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
const hasTTS = typeof window !== "undefined" && "speechSynthesis" in window;

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

// One row in the help list — the same shape the elder screen uses, at caregiver
// text sizes. Full-width rather than a tile grid: it needs no left-to-right
// scanning, and a long label ("Link a care recipient") still fits on one line.
function HelpRow({ icon: Icon, label, onClick, "data-walk": dataWalk }: {
  icon: any; label: string; onClick: () => void; "data-walk"?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-walk={dataWalk}
      className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-secondary/50 transition-colors"
    >
      <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
        <Icon size={17} className="text-primary" />
      </div>
      <span className="flex-1 min-w-0 text-[calc(14px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{label}</span>
      <ChevronRight size={17} className="text-muted-foreground shrink-0" />
    </button>
  );
}

interface HelpItem { icon: any; label: string; run: () => void; walk?: string }

// Four categories on arrival, then a short focused list — the same shape (and
// the same one-tap cost) as the elder screen's Ask Mei.
type CatId = "medicines" | "checkins" | "care" | "app";

/**
 * Who this conversation is about. Multi-select, unlike the header
 * PatientSwitcher — a caregiver often wants to ask across everyone they look
 * after ("who missed something today?").
 *
 * HONEST SCOPE: this changes what Mei is TOLD, not what she can read. A
 * caregiver-authenticated turn is scoped by the caller's own JWT
 * (routes.py derives ToolContext.elder_id from `sub`), so there is no
 * act-on-behalf-of and the names below travel as message context only. Picking
 * exactly one person also switches the rest of the app to them, so the sheets
 * this screen opens (weekly summary, travel mode) follow the selection.
 */
function PatientPicker({ patients, selectedIds, onChange }: {
  patients: Patient[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const chosen = patients.filter(p => selectedIds.includes(p.id));
  const label = chosen.length === 0
    ? t(language, "ai.aboutNobody")
    : chosen.length === 1
      ? chosen[0].nickname || chosen[0].name
      : t(language, "ai.aboutCount", { count: chosen.length });

  const toggle = (id: number) => {
    // Never allow an empty selection — an "about nobody" chat has no context to
    // send, and silently reverting to everyone would be a surprise.
    const next = selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id];
    if (next.length) onChange(next);
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        data-walk="cg-ai-patient-picker"
        className="flex items-center gap-2 rounded-full dw-surface pl-1.5 pr-2.5 py-1.5 active:bg-muted transition-colors max-w-[52vw] md:max-w-[190px]"
      >
        {chosen.length === 1 && <ProfileAvatar photo={chosen[0].photo} size={24} className="rounded-full shrink-0" />}
        {chosen.length !== 1 && (
          <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center shrink-0">
            <Users size={13} className="text-primary" />
          </span>
        )}
        <span className="min-w-0 truncate text-[calc(13px*var(--dw-text,1))] font-bold text-foreground">{label}</span>
        <ChevronDown size={14} className={`text-muted-foreground shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[190]" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1.5 w-64 max-w-[80vw] bg-card rounded-2xl shadow-xl border border-border z-[200] overflow-hidden">
            <p className="px-3 pt-3 pb-1.5 text-[calc(11px*var(--dw-text,1))] font-bold uppercase tracking-widest text-muted-foreground">
              {t(language, "ai.whoIsThisAbout")}
            </p>
            {patients.map(p => {
              const on = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => toggle(p.id)}
                  aria-pressed={on}
                  className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-left transition-colors ${on ? "bg-secondary/60" : "active:bg-muted"}`}
                >
                  <ProfileAvatar photo={p.photo} size={32} className="rounded-full shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[calc(13px*var(--dw-text,1))] font-bold text-foreground truncate">{p.nickname || p.name}</p>
                    <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground truncate">{p.relation}</p>
                  </div>
                  <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${on ? "bg-primary border-primary" : "border-border"}`}>
                    {on && <Check size={13} className="text-primary-foreground" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
            <p className="px-3 py-2 text-[calc(11px*var(--dw-text,1))] text-muted-foreground border-t border-border leading-snug">
              {t(language, "ai.patientPickerNote")}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export function AskMeiScreen({ patient, patients, selectedPatient, onSelectPatient, elderId, onUpdatePatient, onNavigate, onSendReminder, onMedsChanged, onMedAdded, onHighlightChange, onWalkthroughStart, guidedViewActive, openChatView, onOpenChatViewConsumed }: {
  patient: Patient;
  // Everyone this caregiver looks after, so the chat can be scoped to one or
  // several of them. Falls back to just `patient` when a host doesn't pass it.
  patients?: Patient[];
  selectedPatient?: number;
  onSelectPatient?: (index: number) => void;
  elderId?: string;
  onUpdatePatient: (p: Patient) => void;
  onNavigate?: (screen: Screen) => void;
  onSendReminder?: () => void;
  onMedsChanged?: () => void | Promise<void>;
  onMedAdded?: (name: string) => void;
  onHighlightChange?: (action: AgentAction) => void;
  // Returns null when the walkthrough started, or a translation key saying
  // why it could not — so this screen can say so instead of doing nothing.
  // `risk` (RiskClassifier, Item 5) rides along only on the real Hermes-turn
  // path below — App.tsx's own handleWalkthroughStart currently intercepts
  // add_prescription_auto before it ever reaches a Confirm phase here, so
  // this is unused today but kept for parity with the elder screen's shape.
  onWalkthroughStart?: (
    taskName: WalkthroughTaskName,
    params?: WalkthroughParams,
    risk?: WalkthroughRisk,
  ) => string | null | void;
  // True while a guided overlay (the autonomous walkthrough or the passive
  // product tour) is on screen — the tour's Ask-Mei step spotlights
  // [data-tour="cg-askmei"], which only exists in the help view, so a live
  // conversation used to leave it pointing at nothing. Mirrors the elder
  // screen's prop of the same name; see it for why this is a live boolean and
  // not the monotonic counter that shape started as.
  guidedViewActive?: boolean;
  // "Open on the conversation, not the help list" — see the elder screen's prop
  // of the same name for the full reasoning. A nullable value the parent clears
  // after consumption, never a monotonic counter.
  openChatView?: boolean;
  onOpenChatViewConsumed?: () => void;
}) {
  const { language, setLanguage } = useLanguage();
  const { voiceOutput, setVoiceOutput } = useAccessibility();
  // Keyed by the signed-in account and separate from the elder chat's key: a
  // caregiver previewing the elder view is the SAME uid in both shells, so one
  // shared key would cross the two conversations.
  const storageKey = `mei-chat-cg:${elderId ?? "anon"}`;
  const restored = loadChatSession(storageKey);
  const startedAtRef = useRef<number>(restored?.startedAt ?? Date.now());
  // No canned greeting: the screen opens on what Mei can DO, and the thread
  // starts with the caregiver's own first message.
  const [messages, setMessages] = useState<ChatMsg[]>(() => restored?.messages ?? []);
  const [input, setInput] = useState("");
  // The composer is always on screen; this only decides what fills the space
  // above it — the help list, or the conversation. Opens on "help" (mirroring
  // the elder screen); sending a message flips it to "chat", and the header
  // switch flips back.
  // (guidedViewActive overrides this on mount too — see its effect below.)
  // openChatView wins outright — it holds even for an empty conversation,
  // which is the case "Talk to Mei" is usually reached from.
  const [mode, setMode] = useState<"help" | "chat">(
    openChatView ? "chat" : guidedViewActive ? "help" : restored?.messages?.length ? "chat" : "help",
  );
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatId | null>(null);

  // A guided overlay is on screen: show the help list it expects to spotlight.
  // The conversation is untouched — the header switch returns to it, and once
  // the overlay closes a remount restores it from the seed above.
  useEffect(() => {
    if (!guidedViewActive) return;
    setMode("help");
    setCategory(null);
    setQuery("");
  }, [guidedViewActive]);

  // Consume the "open on the conversation" request — and SET the mode. Keyed on
  // [openChatView], not mount-only: the seed above only runs on a real mount,
  // and the host's handoff is `setScreen("ai")`, a no-op when the person is
  // already on the ai screen. See the elder screen's copy for the full story.
  useEffect(() => {
    if (!openChatView) return;
    setMode("chat");
    setCategory(null);
    setQuery("");
    onOpenChatViewConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatView]);

  // Drop the saved thread once it has gone 30 idle minutes WITHOUT a remount.
  // The elder screen has had this since its own restore work; without it a
  // caregiver chat only ever expired on the next mount, so a tab left open all
  // afternoon kept serving a stale conversation the TTL had already retired.
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - startedAtRef.current > SESSION_TTL_MS) setMessages([]);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const roster = patients?.length ? patients : [patient];
  // Who the conversation is about — starts as whoever the app is currently on.
  const [chatPatientIds, setChatPatientIds] = useState<number[]>([patient.id]);
  const chatPatients = roster.filter(p => chatPatientIds.includes(p.id));
  const handlePickPatients = (ids: number[]) => {
    setChatPatientIds(ids);
    // Exactly one person selected: switch the whole app to them, so the sheets
    // this screen opens (weekly summary, travel mode) are about the same person
    // the chat is. With several selected there is no single "current" patient,
    // so the app-level selection is deliberately left where it was.
    if (ids.length === 1 && onSelectPatient) {
      const index = roster.findIndex(p => p.id === ids[0]);
      if (index >= 0 && index !== selectedPatient) onSelectPatient(index);
    }
  };
  // A photo attached but not yet sent — staged so the caregiver types their intent.
  const [pendingImage, setPendingImage] = useState<{ base64: string; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showTravel, setShowTravel] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMedPicker, setShowMedPicker] = useState(false);
  const [showLangSheet, setShowLangSheet] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reportCameraRef = useRef<HTMLInputElement>(null);
  const reportLibraryRef = useRef<HTMLInputElement>(null);
  const rxCameraRef = useRef<HTMLInputElement>(null);
  const rxLibraryRef = useRef<HTMLInputElement>(null);
  const [pickerFor, setPickerFor] = useState<null | "rx" | "report">(null);
  const recognitionRef = useRef<any>(null);

  // This screen unmounts when the caregiver leaves it. A chat turn is a live
  // network call — guard its post-await continuation so a turn they walked away
  // from can't navigate/highlight a screen they're no longer looking at.
  const mountedRef = useRef(true);
  // Also stop any reply mid-sentence. The neural voice plays a detached Audio
  // element owned by lib/speech.ts, so speechSynthesis.cancel() cannot reach
  // it — without this, walking away from the chat leaves Mei talking on a
  // screen nobody is looking at.
  useEffect(() => () => { mountedRef.current = false; stopSpeaking(); }, []);

  const uniqueMeds = [...new Set(patient.medications.map(m => m.name))];
  // Which message hosts the answer buttons this turn (see lib/chatChoices.ts).
  const interactiveIndex = lastInteractiveIndex(messages);

  // Persist the thread so it survives leaving and returning. Sending/receiving
  // is activity, so the idle window restarts here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    startedAtRef.current = Date.now();
    const persistable = messages
      .filter(m => m.id !== LIVE_STEP_ID)
      .map(m => (m.image?.startsWith("blob:") ? { ...m, image: undefined } : m));
    sessionStorage.setItem(storageKey, JSON.stringify({ messages: persistable, startedAt: startedAtRef.current }));
  }, [messages, storageKey]);
  const canSend = !!input.trim() || !!pendingImage;

  // Fetched once so agent turns can tell Mei which walkthroughs this caregiver
  // has already been shown — a stale read until the next remount is accepted,
  // same as this app's other per-session profile caches.
  const [completedWalkthroughs, setCompletedWalkthroughs] = useState<string[]>([]);
  useEffect(() => {
    if (!elderId) return;
    fetchProfile(elderId).then(profile => {
      setCompletedWalkthroughs(profile?.details.completedWalkthroughs ?? []);
    });
  }, [elderId]);

  const scrollToBottom = () => setTimeout(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, 60);

  // Arrive at the BOTTOM of a restored thread — see the elder screen's copy.
  // Every other call site here is an append path, so a conversation restored
  // from sessionStorage opened at its oldest message. This one is already
  // instant (a direct scrollTop, no smooth behaviour), so no flag is needed.
  useEffect(() => {
    if (mode !== "chat" || messages.length === 0) return;
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Grow the input with its content instead of staying pinned to one row —
  // without this, once text wraps to a second line the textarea's fixed
  // single-row height just auto-scrolls to keep the caret in view, hiding the
  // first line rather than actually showing both.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // matches max-h-24
  }, [input, mode]);

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

  // Sentinel id for the single transient "working on it" bubble a live turn may
  // show — always at most one at a time, so a fixed id lets us update/replace it
  // in place rather than accumulating one bubble per tool call.

  const send = async (text: string, imageBase64?: string, pdfBase64?: string, displayImage?: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    // Leaving a category open would strand its title + back arrow above the
    // conversation that is now what's on screen.
    setMode("chat");
    setCategory(null);
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: trimmed, time: nowLabel(), image: displayImage }]);
    scrollToBottom();
    setSending(true);

    // Tell Mei who this is about. Only when it ISN'T just the current patient —
    // otherwise every single turn would carry a redundant preamble. This is
    // context in the message text, not a scope change: see PatientPicker.
    const namedFor = chatPatients.length && !(chatPatients.length === 1 && chatPatients[0].id === patient.id)
      ? t(language, "ai.aboutPrefix", { names: chatPatients.map(p => p.nickname || p.name).join(", ") })
      : "";
    const outgoing = namedFor ? `${namedFor} ${trimmed}` : trimmed;

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
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.workingOnLabel", { label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
      } else if (event.type === "tool_end") {
        // Unconditionally — otherwise on a propose turn (the one that ends by
        // asking "shall I save it?") the chip sits above the question forever.
        setMessages(prev => prev.filter(m => m.id !== LIVE_STEP_ID));
        // Navigate only once the tool actually COMMITTED a write this dispatch.
        if (event.is_error || !event.committed || navigated || target.confirmFirst) return;
        navigated = true;
        const done = t(language, target.doneKey);
        const label = t(language, target.labelKey);
        setMessages(prev => [
          ...prev.filter(m => m.id !== LIVE_STEP_ID),
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.openingLabel", { done, detail: "", label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
        // Screen-transition settle shared with the walkthrough engine.
        if (onNavigate) setTimeout(() => onNavigate(target.caregiver), PACING.NAVIGATE_MS);
      }
    };

    const { reply, actions, walkthrough, choices, awaiting_confirmation, rateLimited } = await agentTurnStream(outgoing, onEvent, imageBase64, pdfBase64, completedWalkthroughs, "caregiver");
    setMessages(prev => [...prev.filter(m => m.id !== LIVE_STEP_ID), { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel(), isRateLimited: rateLimited, choices: choices ?? undefined, awaitingConfirmation: awaiting_confirmation }]);
    if (!mountedRef.current) return;
    setSending(false);
    scrollToBottom();
    speak(reply);
    // A walkthrough takes over the whole app shell, so drop back to the help
    // view — the conversation would otherwise cover what's being spotlighted.
    if (walkthrough) {
      setMode("help");
      const refusal = onWalkthroughStart?.(walkthrough.task_name as WalkthroughTaskName, walkthrough.params, walkthrough.risk);
      if (refusal) {
        setMode("chat");
        setMessages(prev => [...prev, { id: Date.now() + 3, role: "agent", text: t(language, refusal), time: nowLabel(), isConfirmation: true }]);
        scrollToBottom();
      }
    }
    // Gated for a walkthrough's "agent-action-committed" step: the real
    // committed_actions this turn, never tools_used (mirrors ElderlyAIScreen).
    if (actions.length) emitWalkthroughEvent("agent-action-committed", { tools: actions.map(a => a.tool) });
    // Refresh medication state whenever the agent committed *any* write this turn
    // (not only routable ones) — awaited + caught so a failed refetch is visible,
    // not silently swallowed while chat has already reported success.
    if (actions.length) {
      try {
        await onMedsChanged?.();
      } catch (err) {
        console.warn("[dosewise] medication refresh after agent write failed:", err);
      }
    }
    // Canonical proof-of-change (mirrors ElderlyAIScreen): highlight the EXACT
    // record by entity_type/entity_id; fall back to the legacy name-keyed card
    // flag only when the action isn't highlightable.
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
        setMessages(prev => [...prev, { id: Date.now() + 2, role: "agent", text: t(language, "ai.openingLabel", { done, detail, label }), time: nowLabel(), isConfirmation: true }]);
        scrollToBottom();
        if (onNavigate) setTimeout(() => onNavigate(routed.target.caregiver), 1200);
      }
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if ((!text && !pendingImage) || sending) return;
    const img = pendingImage;
    setInput("");
    setPendingImage(null);
    send(text || t(language, "ai.photoDefaultPrompt"), img?.base64, undefined, img?.url);
  };

  // Open the composer with a request already typed in — the caregiver still taps
  // Send, so nothing is ever asked on their behalf. Used by the help rows whose
  // task needs their own words before Mei can carry it out.
  const openChatWith = (prefill: string) => {
    setInput(prefill);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 80);
  };

  const clearChat = () => {
    startedAtRef.current = Date.now();
    // Genuinely EMPTY, matching the elder screen and this file's own "no canned
    // greeting: the screen opens on what Mei can DO" stance a few lines up. It
    // used to re-seed a greeting, which left messages.length > 0 — so with the
    // now-bidirectional pill above, clearing the chat would have immediately
    // offered "Back to chat" to a thread containing nothing but that greeting.
    setMessages([]);
    setShowClearConfirm(false);
    setMode("help");
  };

  // Attach a photo: stage it so the caregiver can type what they want done with
  // it, rather than assuming it's a prescription.
  const onRxPhotoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMode("chat");
    setPendingImage({ base64: await fileToBase64(file), url: URL.createObjectURL(file) });
    inputRef.current?.focus();
  };

  // "Update profile": the clinic report goes to the real agent — a PDF's text is
  // extracted server-side; an image goes through the vision path. The agent
  // proposes the profile update and saves only after a confirming "yes".
  const onReportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const b64 = await fileToBase64(file);
    const msg = t(language, "ai.reportMsg");
    if (file.type === "application/pdf") send(msg, undefined, b64);
    else send(msg, b64, undefined, URL.createObjectURL(file));
  };

  const startWalk = (task: WalkthroughTaskName) => {
    const refusal = onWalkthroughStart?.(task);
    if (!refusal) return;
    // Say why, in the conversation — a silent no-op is indistinguishable from
    // the app being broken, which is the whole reason this returns a reason.
    setMode("chat");
    setCategory(null);
    setMessages(prev => [...prev, { id: Date.now(), role: "agent", text: t(language, refusal), time: nowLabel(), isConfirmation: true }]);
    scrollToBottom();
  };

  // Four categories, mirroring the elder screen: four choices on arrival, then a
  // short focused list. Weekly Summary keeps `cg-weeklysummary-tile` and lives
  // under "checkins", whose tile is what weekly_summary_tour now spotlights.
  const CATEGORIES: Record<CatId, { icon: any; title: string; items: HelpItem[] }> = {
    medicines: {
      icon: Pill,
      title: t(language, "ai.cgCatMedicines"),
      items: [
        { icon: Camera,      label: t(language, "ai.rowAddMedPhoto"),  run: () => setPickerFor("rx") },
        { icon: Pill,        label: t(language, "ai.rowAddMed"),       run: () => openChatWith(t(language, "ai.prefillAddMed")) },
        { icon: Stethoscope, label: t(language, "ai.askAboutMed"),     run: () => setShowMedPicker(true) },
        { icon: RefreshCw,   label: t(language, "ai.suggestRefills"),  run: () => openChatWith(t(language, "ai.suggestRefills")) },
        { icon: Plane,       label: t(language, "common.travelMode"),  run: () => setShowTravel(true) },
      ],
    },
    checkins: {
      icon: TrendingUp,
      title: t(language, "ai.cgCatCheckins"),
      items: [
        { icon: TrendingUp,   label: t(language, "common.weeklySummary"), run: () => setShowSummary(true), walk: "cg-weeklysummary-tile" },
        { icon: CheckCircle2, label: t(language, "ai.cgRowAdherence"),    run: () => openChatWith(t(language, "ai.suggestAdherence")) },
        { icon: AlertTriangle, label: t(language, "ai.cgRowMissed"),      run: () => openChatWith(t(language, "ai.suggestMissed")) },
        { icon: CalendarDays, label: t(language, "ai.cgRowSchedule"),     run: () => startWalk("patient_schedule_tour") },
        { icon: Sparkles,     label: t(language, "ai.cgRowWeeklyTour"),   run: () => startWalk("weekly_summary_tour") },
      ],
    },
    care: {
      icon: Users,
      title: t(language, "ai.cgCatCare"),
      items: [
        { icon: Send,          label: t(language, "common.sendReminder"),   run: () => onSendReminder?.() },
        { icon: MessageSquare, label: t(language, "common.leaveNote"),      run: () => onNavigate?.("messages") },
        { icon: QrCode,        label: t(language, "ai.cgRowLinkPatient"),   run: () => startWalk("link_caregiver") },
        { icon: Users,         label: t(language, "ai.cgRowSwitchView"),    run: () => startWalk("caregiver_view_toggle_tour") },
      ],
    },
    app: {
      icon: SlidersHorizontal,
      title: t(language, "ai.cgCatApp"),
      items: [
        { icon: Globe,    label: t(language, "ai.languageVoice"),      run: () => setShowLangSheet(true) },
        { icon: Bell,     label: t(language, "ai.cgRowNotifications"), run: () => onNavigate?.("settings") },
        { icon: FileText, label: t(language, "ai.updateProfile"),      run: () => setPickerFor("report") },
      ],
    },
  };

  const searchResults = query.trim()
    ? (Object.keys(CATEGORIES) as CatId[]).flatMap(id =>
        CATEGORIES[id].items
          .filter(i => i.label.toLowerCase().includes(query.trim().toLowerCase()))
          .map(i => ({ ...i, section: CATEGORIES[id].title })))
    : [];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      {/* ONE header for both faces of this screen — same title, same place. Only
          the switch button flips direction, so moving between the help list and
          the conversation never reads as a different screen. */}
      {/* Title row: the screen name, who the chat is about, and the one switch
          between the help view and the conversation. The switch only appears
          once a conversation exists — before that there is nothing to go back
          to. */}
      <div className="px-4 pt-3 pb-2 shrink-0 flex items-center gap-2">
        {category ? (
          <>
            <button
              onClick={() => setCategory(null)}
              aria-label={t(language, "common.back")}
              className="w-9 h-9 rounded-full dw-surface flex items-center justify-center shrink-0 active:bg-muted transition-colors"
            >
              <ChevronLeft size={18} className="text-foreground" />
            </button>
            <h2 className="flex-1 min-w-0 truncate dw-display text-[calc(18px*var(--dw-text,1))] font-semibold text-foreground">{CATEGORIES[category].title}</h2>
          </>
        ) : (
          <>
            <h2 className="flex-1 min-w-0 truncate dw-display text-[calc(18px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "common.askMei")}</h2>
            <PatientPicker patients={roster} selectedIds={chatPatientIds} onChange={handlePickPatients} />
          </>
        )}
        {!category && mode === "chat" && (
          <button onClick={() => setShowClearConfirm(true)} aria-label={t(language, "ai.clearChat")} className="w-9 h-9 rounded-full dw-surface flex items-center justify-center shrink-0 active:bg-muted transition-colors">
            <Trash2 size={15} className="text-muted-foreground" />
          </button>
        )}
      </div>

      {/* The switch between the help list and the conversation, as a full-width
          tab under the title — a message having just been sent is exactly when
          it needs to be obvious, and an icon in a crowded header row is not.
          BIDIRECTIONAL, mirroring the elder screen's own pill: it used to
          render only in chat mode and only go chat -> help, so once a caregiver
          was on the help list the ONLY way back into a live thread was to send
          another message (every setMode("chat") in this file is a side effect
          of sending/attaching, never a control). */}
      {!category && (mode === "chat" || messages.length > 0) && (
        <button
          onClick={() => { setMode(mode === "chat" ? "help" : "chat"); setQuery(""); scrollToBottom(); }}
          data-walk={mode === "chat" ? "cg-ai-frequently-used" : "cg-ai-back-to-chat"}
          className="mx-4 mb-2 shrink-0 flex items-center justify-center gap-1.5 rounded-full dw-surface py-2 active:bg-muted transition-colors"
        >
          <Sparkles size={14} className="text-primary shrink-0" />
          <span className="text-[calc(13px*var(--dw-text,1))] font-bold text-foreground">
            {t(language, mode === "chat" ? "ai.frequentlyUsed" : "ai.backToChat")}
          </span>
        </button>
      )}

      {/* One scroll area above a permanent composer. Chat is a MODE, not a
          separate sheet — the text box never leaves, so typing is always the
          obvious way out of a dead end. */}
      {mode === "chat" ? (
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3 border-t border-border/60 dw-view-in">
          {messages.map((msg, i) => msg.isRateLimited ? (
            <div key={msg.id} className="flex justify-center dw-msg-in">
              <div className="flex items-center gap-1.5 bg-warn-bg border border-warn-border text-warn-fg rounded-full px-3.5 py-1.5">
                <AlertTriangle size={13} className="text-warn shrink-0" />
                <span className="text-[calc(13px*var(--dw-text,1))] font-semibold">{msg.text}</span>
              </div>
            </div>
          ) : msg.isConfirmation ? (
            <div key={msg.id} className="flex justify-center dw-msg-in">
              <div className="flex items-center gap-1.5 bg-taken-bg border border-taken-border text-taken-fg rounded-full px-3.5 py-1.5">
                <Check size={13} className="text-taken shrink-0" />
                <span className="text-[calc(13px*var(--dw-text,1))] font-semibold">{msg.text.replace(/^✓\s*/, "")}</span>
              </div>
            </div>
          ) : (
            <div key={msg.id} className={`dw-msg-in flex ${msg.role === "user" ? "justify-end origin-bottom-right" : "justify-start origin-bottom-left"} gap-2`}>
              {msg.role === "agent" && (
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0 mt-1">
                  <span className="text-primary-foreground text-xs font-bold">M</span>
                </div>
              )}
              <div className={`max-w-[82%] flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                {msg.image && (
                  <img src={msg.image} alt={t(language, "ai.attachment")} className="max-w-[70%] rounded-2xl border border-border object-cover" />
                )}
                <div className={`rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "dw-surface rounded-tl-sm"}`}>
                  <p className={`text-[calc(15px*var(--dw-text,1))] leading-relaxed whitespace-pre-line ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>{renderWithBold(msg.text)}</p>
                </div>
                {/* Tappable answer buttons — the agent's own (offer_choices) or a
                    synthesized Yes/No when a confirm is pending, anchored on the
                    last message that HAS buttons (see lib/chatChoices.ts). */}
                {i === interactiveIndex && !sending && buttonsFor(msg, language).length > 0 && (
                  // self-stretch inside this items-start column sizes each answer
                  // to the bubble's own width — see ElderlyAIScreen for the same
                  // treatment; the two chat surfaces stay visually identical.
                  <div className="flex flex-col gap-2 mt-1 self-stretch">
                    {buttonsFor(msg, language).map((c, ci) => (
                      <button
                        key={ci}
                        onClick={() => send(c.value)}
                        className="w-full min-h-[44px] px-4 py-2.5 rounded-2xl bg-primary/10 border border-primary/30 text-primary text-[calc(14px*var(--dw-text,1))] font-semibold active:scale-[0.98] transition-transform"
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground px-1">{msg.time}</p>
              </div>
            </div>
          ))}
          {isListening && (
            <div className="flex justify-center py-2">
              <div className="flex items-center gap-2 bg-missed-bg border border-missed-border rounded-full px-4 py-2">
                <div className="w-2.5 h-2.5 bg-missed rounded-full animate-pulse" />
                <span className="text-sm text-missed-fg font-semibold">{t(language, "ai.listening")}</span>
              </div>
            </div>
          )}
        </div>
      ) : category ? (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pt-3 pb-4 space-y-3 border-t border-border/60 dw-view-in">
          <div className="dw-surface divide-y divide-border overflow-hidden">
            {CATEGORIES[category].items.map(item => (
              <HelpRow key={item.label} icon={item.icon} label={item.label} onClick={item.run} data-walk={item.walk} />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pt-3 pb-4 space-y-3 border-t border-border/60 dw-view-in" data-tour="cg-askmei">
          <div className="relative">
            <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t(language, "ai.searchPlaceholder")}
              className="w-full h-11 bg-input-background border border-border rounded-2xl pl-10 pr-10 text-[calc(14px*var(--dw-text,1))] text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label={t(language, "common.cancel")} className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
                <X size={14} className="text-muted-foreground" />
              </button>
            )}
          </div>

          {query.trim() ? (
            <div className="dw-surface divide-y divide-border overflow-hidden">
              {searchResults.map(r => (
                <button
                  key={`${r.section}-${r.label}`}
                  onClick={() => { setQuery(""); r.run(); }}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-secondary/50 transition-colors"
                >
                  <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                    <r.icon size={17} className="text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[calc(14px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{r.label}</p>
                    <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{r.section}</p>
                  </div>
                  <ChevronRight size={17} className="text-muted-foreground shrink-0" />
                </button>
              ))}
              {searchResults.length === 0 && (
                <p className="px-4 py-6 text-[calc(14px*var(--dw-text,1))] text-muted-foreground text-center">{t(language, "settings.noResults", { q: query.trim() })}</p>
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
                    data-walk={`cg-cat-${id}`}
                    className="dw-surface dw-press p-4 h-[118px] flex flex-col items-center justify-center gap-2 text-center"
                  >
                    <div className="w-11 h-11 rounded-2xl bg-secondary flex items-center justify-center">
                      <cat.icon size={21} className="text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[calc(13px*var(--dw-text,1))] font-bold text-foreground leading-tight">{cat.title}</p>
                      <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground mt-0.5">{t(language, "ai.catCount", { count: cat.items.length })}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Speaking indicator */}
      {isSpeaking && (
        <div className="px-4 py-1 shrink-0">
          <div className="flex items-center gap-1.5 text-primary">
            <Volume2 size={13} />
            <span className="text-xs font-semibold">{t(language, "ai.speaking")}{language !== "en" ? ` in ${LANGUAGE_OPTIONS.find(o => o.id === language)?.label}` : ""}…</span>
          </div>
        </div>
      )}

      {mode === "chat" && (
        <div className="px-4 pb-2 shrink-0">
          <div
            className="flex gap-2 overflow-x-auto scrollbar-none pb-1"
            onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
          >
            {[t(language, "ai.suggestAdherence"), t(language, "ai.suggestMissed"), t(language, "ai.suggestRefills")].map(s => (
              <button
                key={s}
                onClick={() => setInput(s)}
                className="shrink-0 bg-muted text-foreground rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap active:bg-secondary transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Composer — always present, in both modes. Camera and mic sit INSIDE the
          field (as on the elder screen): as outside buttons they left the text
          box barely wider than the buttons themselves. */}
      <div className="px-4 pb-4 pt-2 border-t border-border/60 shrink-0">
        {pendingImage && (
          <div className="flex items-center gap-2.5 mb-2 bg-secondary border border-primary/20 rounded-xl p-2">
            <img src={pendingImage.url} alt={t(language, "ai.attachment")} className="w-12 h-12 rounded-lg object-cover shrink-0" />
            <span className="flex-1 text-[calc(13px*var(--dw-text,1))] text-secondary-foreground font-semibold">{t(language, "ai.photoAttachedHint")}</span>
            <button onClick={() => setPendingImage(null)} aria-label={t(language, "common.cancel")} className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0 bg-input-background rounded-2xl border border-border min-h-11 flex items-end gap-0.5 pl-1.5 pr-3 py-1.5">
            <button onClick={() => setPickerFor("rx")} aria-label={t(language, "common.addPrescription")} className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground shrink-0 active:bg-muted transition-colors">
              <Camera size={17} />
            </button>
            {SpeechRecognitionImpl && (
              <button onClick={handleMic} aria-label={t(language, "ai.listening")} className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${isListening ? "bg-destructive text-destructive-foreground" : "text-muted-foreground active:bg-muted"}`}>
                <Mic size={17} />
              </button>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={t(language, pendingImage ? "ai.photoNotePlaceholder" : "ai.askAnything")}
              className="flex-1 min-w-0 bg-transparent text-foreground text-[calc(15px*var(--dw-text,1))] resize-none outline-none max-h-24 leading-relaxed py-1.5 placeholder:text-muted-foreground"
              rows={1}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!canSend || sending}
            aria-label={t(language, "notifications.send")}
            className="w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 dw-press"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-center text-[calc(10px*var(--dw-text,1))] text-muted-foreground mt-2">{t(language, "ai.disclaimer")}</p>
      </div>

      {/* Hidden inputs backing "Update profile" and "Add prescription" — each
          flow gets a camera-capture input and a plain library/Files input, so
          PhotoSourceSheet's two options are always both reachable. */}
      <input ref={reportCameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onReportFile} />
      <input ref={reportLibraryRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onReportFile} />
      <input ref={rxCameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onRxPhotoFile} />
      <input ref={rxLibraryRef} type="file" accept="image/*" className="sr-only" onChange={onRxPhotoFile} />
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

      {showSummary && <WeeklySummarySheet patient={patient} onClose={() => setShowSummary(false)} />}
      {showTravel && (
        <TravelModeSheet
          patient={patient}
          elderId={elderId}
          onClose={() => setShowTravel(false)}
          onSaved={plan => onUpdatePatient({ ...patient, travelPlan: plan })}
        />
      )}

      {showMedPicker && (
        <BottomSheet onClose={() => setShowMedPicker(false)}>
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="dw-display text-lg font-semibold text-foreground">{t(language, "ai.whichMedication")}</h3>
              <button onClick={() => setShowMedPicker(false)} aria-label={t(language, "common.cancel")} className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0"><X size={16} className="text-muted-foreground" /></button>
            </div>
            <div className="flex flex-col gap-2">
              {uniqueMeds.map(n => (
                <button key={n} onClick={() => { setShowMedPicker(false); send(`What is ${n} for?`); }} className="w-full text-left text-[calc(14px*var(--dw-text,1))] font-semibold bg-secondary border border-primary/20 text-secondary-foreground rounded-xl px-4 py-3 active:opacity-80 transition-opacity">
                  {n}
                </button>
              ))}
              {uniqueMeds.length === 0 && <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.empty")}</p>}
            </div>
          </div>
        </BottomSheet>
      )}

      {/* Language & voice sheet */}
      {showLangSheet && (
        <BottomSheet onClose={() => setShowLangSheet(false)}>
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="dw-display text-xl font-semibold text-foreground">{t(language, "ai.languageVoice")}</h3>
              <button onClick={() => setShowLangSheet(false)} aria-label={t(language, "common.cancel")} className="w-9 h-9 rounded-full bg-muted flex items-center justify-center"><X size={16} className="text-muted-foreground" /></button>
            </div>
            <p className="text-sm font-semibold text-foreground mb-2">{t(language, "settings.language")}</p>
            <div className="grid grid-cols-3 gap-2 mb-5">
              {LANGUAGE_OPTIONS.map(l => (
                <button key={l.id} onClick={() => setLanguage(l.id)} className={`py-3 rounded-xl text-[calc(14px*var(--dw-text,1))] font-bold border transition-colors ${language === l.id ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}>
                  {l.label}
                </button>
              ))}
            </div>
            <button onClick={() => setVoiceOutput(!voiceOutput)} className="w-full flex items-center justify-between bg-card border border-border rounded-xl px-4 py-3.5">
              <div className="flex items-center gap-2"><Volume2 size={18} className="text-primary" /><span className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "settings.readAloud")}</span></div>
              <div className={`w-12 h-7 rounded-full transition-colors relative ${voiceOutput ? "bg-primary" : "bg-switch-background"}`}>
                <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-card shadow transition-all ${voiceOutput ? "left-[22px]" : "left-0.5"}`} />
              </div>
            </button>
            <p className="text-xs text-muted-foreground mt-3">{t(language, "ai.voiceHint")}</p>
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

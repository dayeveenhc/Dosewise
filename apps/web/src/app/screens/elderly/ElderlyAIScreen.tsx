import { useState, useRef, useEffect } from "react";
import type { ChangeEvent } from "react";
import { Volume2, Mic, Send, AlertTriangle, Brain, Circle, Check, Trash2, Plus, Camera, FileText, Pill, Globe, Sparkles, ChevronUp, X, Plane } from "lucide-react";
import type { Patient } from "../../types";
import type { EMsg, ElderlyTab, DoctorQ } from "./types";
import { agentTurnStream, extractProfile, fileToBase64 } from "../../lib/hermes";
import type { AgentTurnEvent, AgentAction } from "../../lib/hermes";
import { firstHighlightable } from "../../lib/changeHighlight";
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

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

// Browser speech APIs (Web Speech). Both degrade gracefully when unsupported:
// no SpeechRecognition -> the mic button hides; no speechSynthesis -> replies
// are text-only. Voice itself is client-side; the agent turn stays text+image.
const SpeechRecognitionImpl: any =
  typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
const hasTTS = typeof window !== "undefined" && "speechSynthesis" in window;

// Chat history survives switching bottom-nav tabs (this screen unmounts/remounts
// each time), via sessionStorage — cleared automatically when the browser tab
// closes, and force-expired after SESSION_TTL_MS regardless of activity.
const SESSION_TTL_MS = 30 * 60 * 1000;

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

// A single feature tile in the "Quick help" launcher.
function FeatureBtn({ icon: Icon, label, onClick, className = "", "data-tour": dataTour, "data-walk": dataWalk }: { icon: any; label: string; onClick: () => void; className?: string; "data-tour"?: string; "data-walk"?: string }) {
  return (
    <button onClick={onClick} data-tour={dataTour} data-walk={dataWalk} className={`h-[88px] flex flex-col items-center justify-center gap-1.5 bg-card border border-border rounded-2xl px-2 text-center active:bg-muted transition-colors ${className}`}>
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0"><Icon size={18} className="text-primary" /></div>
      <span className="text-[12px] font-bold text-foreground leading-tight">{label}</span>
    </button>
  );
}

export function ElderlyAIScreen({ patient, elderId, onNavigate, onMedsChanged, onMedAdded, onHighlightChange, onOpenTravel, doctorQuestions, openDoctorSignal, onAddDoctorQ, onMarkAnswered, onDeleteQuestion, autoMessage, prefillMessage, onAutoMessageConsumed, onPrefillConsumed, onWalkthroughStart }: {
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
  doctorQuestions: DoctorQ[];
  // Bumped by the host to force the "Ask a doctor" sub-tab open (so a
  // doctor_message ChangeHighlight lands on the thread).
  openDoctorSignal?: number;
  onAddDoctorQ: (q: string) => void;
  onMarkAnswered: (id: string) => void;
  onDeleteQuestion: (id: string) => void;
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
  onWalkthroughStart?: (taskName: WalkthroughTaskName, params?: WalkthroughParams) => void;
}) {
  const { language, setLanguage } = useLanguage();
  const { voiceOutput, setVoiceOutput } = useAccessibility();
  const nick = patient.nickname || patient.name.split(" ")[1];
  const buildGreeting = (): EMsg => {
    const h = new Date().getHours();
    const g = h < 12 ? t(language, "home.morning") : h < 17 ? t(language, "home.afternoon") : t(language, "home.evening");
    const next = patient.medications.find(m => m.status === "upcoming");
    const nextInfo = next
      ? t(language, "ai.elderGreetingNext", { name: next.name, dose: next.dose, time: next.time })
      : t(language, "ai.elderGreetingAllDone");
    return {
      id: 1, role: "agent",
      text: t(language, "ai.elderGreeting", { timeOfDay: g, nick, nextInfo }),
      time: nowLabel(),
    };
  };
  // Key the saved chat by the signed-in user, not the (constant, mock) patient.id
  // — otherwise every account shares one chat. Each account restores its own.
  const storageKey = `mei-chat:${elderId ?? "anon"}`;
  const restored = loadChatSession(storageKey);
  const startedAtRef = useRef<number>(restored?.startedAt ?? Date.now());
  const [messages, setMessages] = useState<EMsg[]>(() => restored?.messages ?? [buildGreeting()]);
  const [input, setInput] = useState("");
  // A photo the user attached but hasn't sent yet — staged so they can type what
  // they want done with it, instead of us sending a fixed "here's my prescription".
  const [pendingImage, setPendingImage] = useState<{ base64: string; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [screenTab, setScreenTab] = useState<"chat" | "doctor">("chat");
  // Host asked to reveal the doctor thread (a doctor_message change is being
  // highlighted). Ignore the initial 0 so it doesn't steal focus on mount.
  useEffect(() => {
    if (openDoctorSignal) setScreenTab("doctor");
  }, [openDoctorSignal]);
  const [newQ, setNewQ] = useState("");
  const [showInput, setShowInput] = useState(false);
  // Quick help is a popup over the chat, so it never restores open.
  const [quickOpen, setQuickOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMedPicker, setShowMedPicker] = useState(false);
  const [showLangSheet, setShowLangSheet] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reportCameraRef = useRef<HTMLInputElement>(null);
  const reportLibraryRef = useRef<HTMLInputElement>(null);
  const rxCameraRef = useRef<HTMLInputElement>(null);
  const rxLibraryRef = useRef<HTMLInputElement>(null);
  const [pickerFor, setPickerFor] = useState<null | "rx" | "report">(null);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const flagged  = doctorQuestions.filter(q => !q.answered && q.addedAt.includes("Mei"));
  const manual   = doctorQuestions.filter(q => !q.answered && !q.addedAt.includes("Mei"));
  const answered = doctorQuestions.filter(q => q.answered);
  const unasked  = flagged.length + manual.length;
  const uniqueMeds = [...new Set(patient.medications.map(m => m.name))];

  const scrollToBottom = () => setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 60);

  // Persist chat history so it survives switching bottom-nav tabs (this screen
  // unmounts/remounts each time) — sessionStorage clears on its own when the
  // tab closes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(storageKey, JSON.stringify({ messages, startedAt: startedAtRef.current }));
  }, [messages, storageKey]);

  // Show the latest message immediately when returning to this tab, instead
  // of wherever the scroll position happened to be left.
  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow the input with its content instead of staying pinned to one row —
  // without this, once text wraps to a second line the textarea's fixed
  // single-row height just auto-scrolls to keep the caret in view, hiding the
  // first line rather than actually showing both.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // matches max-h-24
  }, [input]);

  // Force-expire the session after SESSION_TTL_MS even if the person never
  // leaves this screen, not just on the next remount.
  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - startedAtRef.current > SESSION_TTL_MS) {
        startedAtRef.current = Date.now();
        setMessages([buildGreeting()]);
        setQuickOpen(false);
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

  const pushAgent = (text: string, isClinic?: boolean) => {
    setMessages(prev => [...prev, { id: Date.now(), role: "agent", text, time: nowLabel(), isClinic }]);
    scrollToBottom();
    speak(text);
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
  const LIVE_STEP_ID = -1;

  const send = async (text: string, imageBase64?: string, pdfBase64?: string, displayImage?: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: trimmed, time: nowLabel(), image: displayImage }]);
    setQuickOpen(false);
    scrollToBottom();
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
      } else if (event.type === "tool_end" && !event.is_error && !navigated && !target.confirmFirst) {
        navigated = true;
        const done = t(language, target.doneKey);
        const label = t(language, target.labelKey);
        setMessages(prev => [
          ...prev.filter(m => m.id !== LIVE_STEP_ID),
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.openingYourLabel", { done, detail: "", label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
        // Screen-transition settle shared with the walkthrough engine.
        setTimeout(() => onNavigate(target.elderly), PACING.NAVIGATE_MS);
      }
    };

    const { reply, actions, walkthrough, rateLimited } = await agentTurnStream(trimmed, onEvent, imageBase64, pdfBase64, completedWalkthroughs);
    setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel(), isRateLimited: rateLimited }]);
    setSending(false);
    scrollToBottom();
    speak(reply);
    if (walkthrough) onWalkthroughStart?.(walkthrough.task_name as WalkthroughTaskName, walkthrough.params);
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
        setTimeout(() => onNavigate(routed.target.elderly), 1200);
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
    setQuickOpen(false);
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

  // Start the conversation over: fresh greeting and a fresh session window, so
  // the restored-session TTL doesn't immediately expire the new chat.
  const clearChat = () => {
    startedAtRef.current = Date.now();
    setMessages([buildGreeting()]);
    setShowClearConfirm(false);
    setQuickOpen(false);
    scrollToBottom();
  };

  // Quick-help feature actions ----------------------------------------------
  const handleSetup = () => {
    setQuickOpen(false);
    pushAgent(t(language, "ai.setupIntro", { nick }));
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
    setQuickOpen(false);
    const b64 = await fileToBase64(file);
    const isPdf = file.type === "application/pdf";
    const msg = t(language, "ai.reportMsgMine");
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

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      <div className="px-4 pt-2 pb-0 shrink-0">
        <div className="flex gap-2 bg-muted rounded-xl p-1">
          <button onClick={() => setScreenTab("chat")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${screenTab === "chat" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
            {t(language, "ai.chatTab")}
          </button>
          <button onClick={() => setScreenTab("doctor")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors relative ${screenTab === "doctor" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
            {t(language, "ai.doctorTab")}
            {unasked > 0 && <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full text-[9px] text-white font-bold flex items-center justify-center">{unasked}</span>}
          </button>
        </div>
      </div>

      {screenTab === "doctor" ? (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pb-28 pt-3 space-y-3">
          {/* Flagged by Mei — AI couldn't answer */}
          {flagged.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-1 pb-2">
                <AlertTriangle size={14} className="text-amber-600 shrink-0" />
                <p className="text-sm font-bold text-amber-900">{t(language, "ai.notSureAskDoctor")}</p>
                <span className="ml-auto text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{flagged.length}</span>
              </div>
              <div className="space-y-2">
                {flagged.map(q => (
                  <div key={q.id} data-testid={`doctor_message-${q.id}`} className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Brain size={11} className="text-amber-600" />
                        <p className="text-[10px] text-amber-600 font-semibold uppercase tracking-wide">{t(language, "ai.fromChatWithMei")}</p>
                      </div>
                      <p className="text-[15px] text-foreground leading-relaxed">{q.question}</p>
                      <p className="text-xs text-amber-700 mt-1">{q.addedAt}</p>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button onClick={() => onMarkAnswered(q.id)} className="text-xs font-bold text-primary bg-primary/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                        {t(language, "ai.askedMark")}
                      </button>
                      <button onClick={() => onDeleteQuestion(q.id)} className="text-xs font-medium text-destructive bg-destructive/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                        {t(language, "common.delete")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manually added questions */}
          {manual.map(q => (
            <div key={q.id} data-testid={`doctor_message-${q.id}`} className="bg-card rounded-2xl border border-border p-4 flex items-start gap-3">
              <div className="w-5 h-5 rounded-full border-2 border-primary/40 flex items-center justify-center shrink-0 mt-0.5">
                <Circle size={7} className="text-primary fill-primary" />
              </div>
              <div className="flex-1">
                <p className="text-[15px] text-foreground leading-relaxed">{q.question}</p>
                <p className="text-xs text-muted-foreground mt-1">{q.addedAt}</p>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button onClick={() => onMarkAnswered(q.id)} className="text-xs font-bold text-primary bg-primary/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                  {t(language, "ai.askedMark")}
                </button>
                <button onClick={() => onDeleteQuestion(q.id)} className="text-xs font-medium text-destructive bg-destructive/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                  {t(language, "common.delete")}
                </button>
              </div>
            </div>
          ))}

          {/* Add question */}
          {showInput ? (
            <div className="bg-card rounded-2xl border border-border p-4">
              <textarea value={newQ} onChange={e => setNewQ(e.target.value)} placeholder={t(language, "ai.questionForDoctorPlaceholder")} className="w-full bg-transparent text-foreground text-[15px] outline-none resize-none leading-relaxed placeholder:text-muted-foreground min-h-[80px]" autoFocus />
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setShowInput(false); setNewQ(""); }} className="flex-1 h-11 rounded-xl border border-border text-muted-foreground text-sm font-semibold">{t(language, "common.cancel")}</button>
                <button onClick={() => { if (newQ.trim()) { onAddDoctorQ(newQ.trim()); setNewQ(""); setShowInput(false); } }} className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-bold">{t(language, "common.save")}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowInput(true)} className="w-full h-12 rounded-2xl border-2 border-dashed border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
              <Plus size={15} />{t(language, "ai.addOwnQuestion")}
            </button>
          )}

          {/* Already asked */}
          {answered.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-2">{t(language, "ai.alreadyAsked")}</p>
              {answered.map(q => (
                <div key={q.id} data-testid={`doctor_message-${q.id}`} className="bg-muted/40 rounded-xl border border-border p-3 mb-2 flex items-start gap-3">
                  <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center shrink-0 mt-0.5">
                    <Check size={8} className="text-white" />
                  </div>
                  <p className="text-sm text-muted-foreground line-through leading-relaxed flex-1">{q.question}</p>
                  <button onClick={() => onDeleteQuestion(q.id)} className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 active:scale-95 transition-all">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Quick help opens as a popup rather than expanding inline, so the
              conversation never gets pushed off-screen. */}
          <div className="px-4 pt-2.5 pb-1 shrink-0 flex items-center gap-2" data-tour="elder-quickhelp">
            <button
              onClick={() => setQuickOpen(true)}
              className="flex items-center gap-2 rounded-xl bg-primary text-primary-foreground px-3.5 py-2.5 shadow-sm active:scale-[0.97] transition-transform"
            >
              <Sparkles size={15} className="shrink-0" />
              <span className="text-sm font-bold">{t(language, "ai.quickHelp")}</span>
              <ChevronUp size={15} className="shrink-0 opacity-80" />
            </button>
            <button
              onClick={() => setShowClearConfirm(true)}
              className="ml-auto flex items-center gap-1.5 rounded-xl border border-border bg-card text-muted-foreground px-3 py-2.5 shadow-sm active:bg-muted active:scale-[0.97] transition-all"
            >
              <Trash2 size={14} className="shrink-0" />
              <span className="text-sm font-semibold">{t(language, "ai.clearChat")}</span>
            </button>
          </div>

          {/* Speaking indicator */}
          {isSpeaking && (
            <div className="px-4 pb-1 shrink-0">
              <div className="flex items-center gap-1.5 text-primary">
                <Volume2 size={13} />
                <span className="text-xs font-semibold">{t(language, "ai.speaking")}{language !== "en" ? ` in ${LANGUAGE_OPTIONS.find(o => o.id === language)?.label}` : ""}…</span>
              </div>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3 border-t border-border">
            {messages.map(msg => msg.isRateLimited ? (
              <div key={msg.id} className="flex justify-center">
                <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-full px-3.5 py-1.5">
                  <AlertTriangle size={13} className="text-amber-600 shrink-0" />
                  <span className="text-[13px] font-semibold">{msg.text}</span>
                </div>
              </div>
            ) : msg.isConfirmation ? (
              <div key={msg.id} className="flex justify-center">
                <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-full px-3.5 py-1.5">
                  <Check size={13} className="text-emerald-600 shrink-0" />
                  <span className="text-[13px] font-semibold">{msg.text.replace(/^✓\s*/, "")}</span>
                </div>
              </div>
            ) : (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} gap-2`}>
                {msg.role === "agent" && (
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0 mt-1">
                    <span className="text-white text-xs font-bold">M</span>
                  </div>
                )}
                <div className={`max-w-[82%] flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                  {msg.image && (
                    <img src={msg.image} alt={t(language, "ai.attachment")} className="max-w-[70%] rounded-2xl border border-border object-cover" />
                  )}
                  <div className={`rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-card border border-border rounded-tl-sm"}`}>
                    <p className={`text-[15px] leading-relaxed whitespace-pre-line ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>{renderWithBold(msg.text)}</p>
                    {msg.isClinic && <p className="text-[11px] mt-2 opacity-60 italic">{t(language, "ai.verifyWithDoctor")}</p>}
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1">{msg.time}</p>
                </div>
              </div>
            ))}
            {isListening && (
              <div className="flex justify-center py-2">
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-full px-4 py-2">
                  <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-sm text-red-700 font-semibold">{t(language, "ai.listening")}</span>
                </div>
              </div>
            )}
          </div>

          <div className="px-4 pb-2 shrink-0">
            <div
              className="flex gap-2 overflow-x-auto scrollbar-none pb-1"
              onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
            >
              {[t(language, "ai.suggestTookMed"), t(language, "ai.suggestWhatDoITake"), t(language, "ai.suggestRefills"), t(language, "ai.suggestHelp")].map(s => (
                <button key={s} onClick={() => setInput(s)} className="shrink-0 bg-muted text-muted-foreground rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap active:bg-primary/10 active:text-primary transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 pb-4 pt-1 border-t border-border shrink-0">
            {/* Staged photo — attached, awaiting the person's instruction. */}
            {pendingImage && (
              <div className="flex items-center gap-2.5 mb-2 bg-secondary/60 border border-primary/20 rounded-xl p-2">
                <img src={pendingImage.url} alt={t(language, "ai.attachment")} className="w-12 h-12 rounded-lg object-cover shrink-0" />
                <span className="flex-1 text-[13px] text-foreground font-medium">{t(language, "ai.photoAttachedHint")}</span>
                <button onClick={() => setPendingImage(null)} aria-label={t(language, "common.cancel")} className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="flex gap-2 items-end">
              {SpeechRecognitionImpl && (
                <button onClick={handleMic} className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${isListening ? "bg-red-500 text-white" : "bg-muted text-foreground"}`}>
                  <Mic size={17} />
                </button>
              )}
              <button onClick={() => setPickerFor("rx")} className="w-10 h-10 rounded-full bg-muted text-foreground flex items-center justify-center shrink-0">
                <Camera size={17} />
              </button>
              <div className="flex-1 bg-input-background rounded-2xl px-3.5 py-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => { const v = e.target.value; setInput(v); if (v.trim() && quickOpen) setQuickOpen(false); }}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder={t(language, pendingImage ? "ai.photoNotePlaceholder" : "ai.typeOrTapMic")}
                  className="w-full bg-transparent text-foreground text-[15px] resize-none outline-none max-h-24 leading-relaxed placeholder:text-muted-foreground"
                  rows={1}
                />
              </div>
              <button onClick={handleSend} disabled={(!input.trim() && !pendingImage) || sending} data-walk="elder-ai-send-button" className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform">
                <Send size={16} />
              </button>
            </div>
            <p className="text-center text-[10px] text-muted-foreground mt-2">{t(language, "ai.disclaimer")}</p>
          </div>

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

          {/* Language & voice sheet */}
          {showLangSheet && (
            <div className="absolute inset-0 z-50 flex items-end p-3 bg-black/40" onClick={() => setShowLangSheet(false)}>
              <div className="w-full bg-background rounded-3xl border border-border shadow-2xl p-5 max-h-full overflow-y-auto scrollbar-none animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "ai.languageVoice")}</h3>
                  <button onClick={() => setShowLangSheet(false)} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center"><X size={16} className="text-muted-foreground" /></button>
                </div>
                <p className="text-sm font-semibold text-foreground mb-2">{t(language, "settings.language")}</p>
                <div className="grid grid-cols-3 gap-2 mb-5">
                  {LANGUAGE_OPTIONS.map(l => (
                    <button key={l.id} onClick={() => setLanguage(l.id)} className={`py-3 rounded-xl text-[14px] font-bold border transition-colors ${language === l.id ? "bg-primary text-white border-primary" : "bg-card text-foreground border-border"}`}>
                      {l.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setVoiceOutput(!voiceOutput)} className="w-full flex items-center justify-between bg-card border border-border rounded-xl px-4 py-3.5">
                  <div className="flex items-center gap-2"><Volume2 size={18} className="text-primary" /><span className="text-[15px] font-semibold text-foreground">{t(language, "settings.readAloud")}</span></div>
                  <div className={`w-12 h-7 rounded-full transition-colors relative ${voiceOutput ? "bg-primary" : "bg-muted"}`}>
                    <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${voiceOutput ? "left-[22px]" : "left-0.5"}`} />
                  </div>
                </button>
                <p className="text-xs text-muted-foreground mt-3">{t(language, "ai.voiceHint")}</p>
              </div>
            </div>
          )}
        </>
      )}

      {/* Quick help popup — overlays the chat instead of pushing it down, and
          floats clear of the panel edges: this screen's container is
          overflow-hidden, so a sheet flush to the bottom gets visibly cut
          against the nav bar below it. */}
      {quickOpen && (
        <div className="absolute inset-0 z-[140] flex items-end p-3">
          <div className="absolute inset-0 bg-black/40" onClick={() => setQuickOpen(false)} />
          <div className="relative w-full bg-card rounded-3xl border border-border px-4 pt-4 pb-4 shadow-2xl max-h-full overflow-y-auto scrollbar-none animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={16} className="text-primary shrink-0" />
              <h3 className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "ai.quickHelp")}</h3>
              <button
                onClick={() => setQuickOpen(false)}
                aria-label={t(language, "common.cancel")}
                className="ml-auto w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground active:bg-border transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <button onClick={handleSetup} className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-2xl px-3 py-3.5 text-sm font-bold active:scale-[0.99] transition-transform mb-2.5">
              <Sparkles size={16} />{t(language, "ai.helpSetup")}
            </button>

            <div className="grid grid-cols-2 gap-2">
              <FeatureBtn icon={Camera}   label={t(language, "common.addPrescription")} onClick={() => { setQuickOpen(false); setPickerFor("rx"); }} />
              <FeatureBtn icon={FileText} label={t(language, "ai.updateProfile")}       onClick={() => { setQuickOpen(false); setPickerFor("report"); }} />
              <FeatureBtn icon={Pill}     label={t(language, "ai.askAboutMed")}         onClick={() => setShowMedPicker(v => !v)} />
              {/* These two open their own sheets — close the popup first, or it
                  stays stacked on top of whatever they open. */}
              <FeatureBtn icon={Globe}    label={t(language, "ai.languageVoice")}       onClick={() => { setQuickOpen(false); setShowLangSheet(true); }} />
              <FeatureBtn icon={Plane}    label={t(language, "common.travelMode")}      onClick={() => { setQuickOpen(false); onOpenTravel(); }} className="col-span-2" data-walk="elder-travelmode-tile" />
            </div>

            {showMedPicker && (
              <div className="bg-muted/50 border border-border rounded-2xl p-3 mt-2.5">
                <p className="text-xs text-muted-foreground font-semibold px-0.5 pb-2">{t(language, "ai.whichMedication")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {uniqueMeds.map(n => (
                    <button key={n} onClick={() => { setShowMedPicker(false); send(`What is ${n} for?`); }} className="text-sm font-semibold bg-card border border-border text-foreground rounded-full px-3 py-2 active:bg-primary/10 active:text-primary transition-colors">
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
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

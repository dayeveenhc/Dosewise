import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Send, TrendingUp, Plane, Check, Sparkles, ChevronUp, Camera, FileText, Pill, Globe, Mic, Volume2, X, Trash2, AlertTriangle, Search, ChevronRight, MessageCircle } from "lucide-react";
import type { Patient, Screen } from "../types";
import { agentTurnStream, fileToBase64 } from "../lib/hermes";
import type { AgentTurnEvent, AgentAction } from "../lib/hermes";
import { firstRoutableAction, ACTION_TARGETS } from "../lib/agentActions";
import { firstHighlightable } from "../lib/changeHighlight";
import { emitWalkthroughEvent } from "../lib/walkthrough/bus";
import { fetchProfile } from "../lib/profile";
import type { WalkthroughTaskName, WalkthroughParams } from "../lib/walkthrough/types";
import { PACING } from "../lib/walkthrough/pacing";
import { WeeklySummarySheet } from "./WeeklySummarySheet";
import { TravelModeSheet } from "./TravelModeSheet";
import { useLanguage } from "../lib/languageContext";
import { useAccessibility } from "../accessibility.tsx";
import { t, LANGUAGE_OPTIONS, speechLangFor } from "../lib/language";
import { speak as speakUtterance } from "../lib/speech";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PhotoSourceSheet } from "../components/PhotoSourceSheet";
import { BottomSheet } from "../components/BottomSheet";

interface ChatMsg { id: number; role: "user" | "agent"; text: string; time: string; isConfirmation?: boolean; isRateLimited?: boolean; image?: string }

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

function HelpRow({ icon: Icon, label, onClick, "data-walk": dataWalk }: { icon: any; label: string; onClick: () => void; "data-walk"?: string }) {
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

export function AskMeiScreen({ patient, elderId, onUpdatePatient, onNavigate, onMedsChanged, onMedAdded, onHighlightChange, onWalkthroughStart }: { patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onNavigate?: (screen: Screen) => void; onMedsChanged?: () => void | Promise<void>; onMedAdded?: (name: string) => void; onHighlightChange?: (action: AgentAction) => void; onWalkthroughStart?: (taskName: WalkthroughTaskName, params?: WalkthroughParams) => void }) {
  const { language, setLanguage } = useLanguage();
  const { voiceOutput, setVoiceOutput } = useAccessibility();
  const [messages, setMessages] = useState<ChatMsg[]>(() => [
    {
      id: 1,
      role: "agent",
      text: t(language, "ai.greeting", { name: patient.name }),
      time: nowLabel(),
    },
  ]);
  const [input, setInput] = useState("");
  // A photo attached but not yet sent — staged so the caregiver types their intent.
  const [pendingImage, setPendingImage] = useState<{ base64: string; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showTravel, setShowTravel] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMedPicker, setShowMedPicker] = useState(false);
  const [showLangSheet, setShowLangSheet] = useState(false);
  const [mode, setMode] = useState<"help" | "chat">("help");
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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

  const uniqueMeds = [...new Set(patient.medications.map(m => m.name))];

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

  const scrollToBottom = (instant = false) => setTimeout(() => {
    const el = scrollRef.current;
    if (!el) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    el.scrollTo({ top: el.scrollHeight, behavior: instant || reduced ? "auto" : "smooth" });
  }, 60);

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
  const LIVE_STEP_ID = -1;

  const send = async (text: string, imageBase64?: string, pdfBase64?: string, displayImage?: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setMode("chat");
    setCategory(null);
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: trimmed, time: nowLabel(), image: displayImage }]);
    scrollToBottom(mode === "help");
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
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.workingOnLabel", { label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
      } else if (event.type === "tool_end" && !event.is_error && !navigated && !target.confirmFirst) {
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

    const { reply, actions, walkthrough, rateLimited } = await agentTurnStream(trimmed, onEvent, imageBase64, pdfBase64, completedWalkthroughs);
    setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel(), isRateLimited: rateLimited }]);
    setSending(false);
    scrollToBottom();
    speak(reply);
    if (walkthrough) onWalkthroughStart?.(walkthrough.task_name as WalkthroughTaskName, walkthrough.params);
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

  const clearChat = () => {
    setMode("help");
    setCategory(null);
    setMessages([{ id: Date.now(), role: "agent", text: t(language, "ai.greeting", { name: patient.name }), time: nowLabel() }]);
    setShowClearConfirm(false);
  };

  // Attach a photo: stage it so the caregiver can type what they want done with
  // it, rather than assuming it's a prescription.
  const onRxPhotoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMode("chat");
    setCategory(null);
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
    setMode("chat");
    setCategory(null);
    const b64 = await fileToBase64(file);
    const msg = t(language, "ai.reportMsg");
    if (file.type === "application/pdf") send(msg, undefined, b64);
    else send(msg, b64, undefined, URL.createObjectURL(file));
  };

  const quickActions = [
    { icon: TrendingUp, label: t(language, "common.weeklySummary"), onClick: () => setShowSummary(true), dataWalk: "cg-weeklysummary-tile" },
    { icon: Plane, label: t(language, "common.travelMode"), onClick: () => setShowTravel(true), dataWalk: "cg-travel-tile" },
    { icon: Camera, label: t(language, "common.addPrescription"), onClick: () => setPickerFor("rx"), dataWalk: "cg-addrx-tile" },
    { icon: FileText, label: t(language, "ai.updateProfile"), onClick: () => setPickerFor("report"), dataWalk: "cg-report-tile" },
    { icon: Pill, label: t(language, "ai.askAboutMed"), onClick: () => setShowMedPicker(v => !v), dataWalk: "cg-med-tile" },
    { icon: Globe, label: t(language, "ai.languageVoice"), onClick: () => setShowLangSheet(true), dataWalk: "cg-lang-tile" },
  ] as const;

  const searchResults = query.trim()
    ? quickActions.filter(item => item.label.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      {!category && (
        <div className="px-4 pt-3 shrink-0 flex items-center gap-2" data-tour="cg-askmei">
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

      {isSpeaking && (
        <div className="px-4 pb-1 shrink-0">
          <div className="flex items-center gap-1.5 text-primary">
            <Volume2 size={13} />
            <span className="text-xs font-semibold">{t(language, "ai.speaking")}{language !== "en" ? ` in ${LANGUAGE_OPTIONS.find(o => o.id === language)?.label}` : ""}…</span>
          </div>
        </div>
      )}

      {mode === "chat" ? (
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3 dw-view-in">
          {messages.map(msg => msg.isRateLimited ? (
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
                </div>
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
            {quickActions.map(item => (
              <HelpRow key={item.label} icon={item.icon} label={item.label} onClick={() => { setCategory(null); item.onClick(); }} data-walk={item.dataWalk} />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pt-3 pb-4 space-y-3.5">
          <div className="relative">
            <Search size={19} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t(language, "ai.searchPlaceholder")}
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
                  key={r.label}
                  onClick={() => { setQuery(""); r.onClick(); }}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/50 transition-colors"
                >
                  <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                    <r.icon size={20} className="text-primary" />
                  </div>
                  <span className="flex-1 min-w-0 text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{r.label}</span>
                  <ChevronRight size={20} className="text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {quickActions.map(item => (
                <button key={item.label} onClick={item.onClick} data-walk={item.dataWalk} className="h-[88px] flex flex-col items-center justify-center gap-1.5 dw-surface px-2 text-center active:bg-muted transition-colors">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0"><item.icon size={18} className="text-primary" /></div>
                  <span className="text-[calc(12px*var(--dw-text,1))] font-bold text-foreground leading-tight">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="px-4 pb-4 pt-1 border-t border-border shrink-0">
        {pendingImage && (
          <div className="flex items-center gap-2.5 mb-2 bg-secondary/60 border border-primary/20 rounded-xl p-2">
            <img src={pendingImage.url} alt={t(language, "ai.attachment")} className="w-12 h-12 rounded-lg object-cover shrink-0" />
            <span className="flex-1 text-[calc(13px*var(--dw-text,1))] text-foreground font-medium">{t(language, "ai.photoAttachedHint")}</span>
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
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={t(language, pendingImage ? "ai.photoNotePlaceholder" : "common.askMeiPlaceholder")}
              className="w-full bg-transparent text-foreground text-[calc(15px*var(--dw-text,1))] resize-none outline-none max-h-24 leading-relaxed placeholder:text-muted-foreground"
              rows={1}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={(!input.trim() && !pendingImage) || sending}
            className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-center text-[calc(10px*var(--dw-text,1))] text-muted-foreground mt-2">{t(language, "ai.disclaimer")}</p>
      </div>

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

      {showLangSheet && (
        <BottomSheet onClose={() => setShowLangSheet(false)}>
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "ai.languageVoice")}</h3>
              <button onClick={() => setShowLangSheet(false)} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center"><X size={16} className="text-muted-foreground" /></button>
            </div>
            <p className="text-sm font-semibold text-foreground mb-2">{t(language, "settings.language")}</p>
            <div className="grid grid-cols-3 gap-2 mb-5">
              {LANGUAGE_OPTIONS.map(l => (
                <button key={l.id} onClick={() => setLanguage(l.id)} className={`py-3 rounded-xl text-[calc(14px*var(--dw-text,1))] font-bold border transition-colors ${language === l.id ? "bg-primary text-white border-primary" : "bg-card text-foreground border-border"}`}>
                  {l.label}
                </button>
              ))}
            </div>
            <button onClick={() => setVoiceOutput(!voiceOutput)} className="w-full flex items-center justify-between bg-card border border-border rounded-xl px-4 py-3.5">
              <div className="flex items-center gap-2"><Volume2 size={18} className="text-primary" /><span className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "settings.readAloud")}</span></div>
              <div className={`w-12 h-7 rounded-full transition-colors relative ${voiceOutput ? "bg-primary" : "bg-muted"}`}>
                <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${voiceOutput ? "left-[22px]" : "left-0.5"}`} />
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

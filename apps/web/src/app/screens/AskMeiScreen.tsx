import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Send, TrendingUp, Plane, Check, Sparkles, ChevronUp, Camera, FileText, Pill, Globe, Mic, Volume2, X, Trash2 } from "lucide-react";
import type { Patient, Screen } from "../types";
import { agentTurnStream, fileToBase64 } from "../lib/hermes";
import type { AgentTurnEvent } from "../lib/hermes";
import { firstRoutableAction, ACTION_TARGETS } from "../lib/agentActions";
import { WeeklySummarySheet } from "./WeeklySummarySheet";
import { TravelModeSheet } from "./TravelModeSheet";
import { useLanguage } from "../lib/languageContext";
import { useAccessibility } from "../accessibility.tsx";
import { t, LANGUAGE_OPTIONS, speechLangFor } from "../lib/language";
import { speak as speakUtterance } from "../lib/speech";
import { ConfirmDialog } from "../components/ConfirmDialog";

interface ChatMsg { id: number; role: "user" | "agent"; text: string; time: string; isConfirmation?: boolean; image?: string }

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

// A single feature tile in the "Quick help" launcher.
function FeatureBtn({ icon: Icon, label, onClick, className = "" }: { icon: any; label: string; onClick: () => void; className?: string }) {
  return (
    <button onClick={onClick} className={`h-[88px] flex flex-col items-center justify-center gap-1.5 bg-card border border-border rounded-2xl px-2 text-center active:bg-muted transition-colors ${className}`}>
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0"><Icon size={18} className="text-primary" /></div>
      <span className="text-[12px] font-bold text-foreground leading-tight">{label}</span>
    </button>
  );
}

export function AskMeiScreen({ patient, elderId, onUpdatePatient, onNavigate, onMedsChanged, onMedAdded }: { patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onNavigate?: (screen: Screen) => void; onMedsChanged?: () => void | Promise<void>; onMedAdded?: (name: string) => void }) {
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
  const [sending, setSending] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showTravel, setShowTravel] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMedPicker, setShowMedPicker] = useState(false);
  const [showLangSheet, setShowLangSheet] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reportRef = useRef<HTMLInputElement>(null);
  const rxPhotoRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  const uniqueMeds = [...new Set(patient.medications.map(m => m.name))];

  const scrollToBottom = () => setTimeout(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.workingOnLabel", { label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
      } else if (event.type === "tool_end" && !event.is_error && !navigated) {
        navigated = true;
        const done = t(language, target.doneKey);
        const label = t(language, target.labelKey);
        setMessages(prev => [
          ...prev.filter(m => m.id !== LIVE_STEP_ID),
          { id: LIVE_STEP_ID, role: "agent", text: t(language, "ai.openingLabel", { done, detail: "", label }), time: nowLabel(), isConfirmation: true },
        ]);
        scrollToBottom();
        if (onNavigate) setTimeout(() => onNavigate(target.caregiver), 600);
      }
    };

    const { reply, actions } = await agentTurnStream(trimmed, onEvent, imageBase64, pdfBase64);
    setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel() }]);
    setSending(false);
    scrollToBottom();
    speak(reply);
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
    // Flag a freshly added prescription so the timeline/patient list highlights
    // it as visible proof the dose (and its dosage) really landed.
    const added = actions.find(a => a.tool === "add_prescription");
    if (added?.name) onMedAdded?.(added.name);
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
    if (!text) return;
    setInput("");
    send(text);
  };

  const clearChat = () => {
    setMessages([{ id: Date.now(), role: "agent", text: t(language, "ai.greeting", { name: patient.name }), time: nowLabel() }]);
    setShowClearConfirm(false);
  };

  // "Add prescription" quick-help: snap/choose a photo, then let the agent read
  // the label and propose it in the chat (confirm with a simple "yes").
  const onRxPhotoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setQuickOpen(false);
    send(t(language, "ai.rxPhotoMsg"), await fileToBase64(file), undefined, URL.createObjectURL(file));
  };

  // "Update profile": the clinic report goes to the real agent — a PDF's text is
  // extracted server-side; an image goes through the vision path. The agent
  // proposes the profile update and saves only after a confirming "yes".
  const onReportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setQuickOpen(false);
    const b64 = await fileToBase64(file);
    const msg = t(language, "ai.reportMsg");
    if (file.type === "application/pdf") send(msg, undefined, b64);
    else send(msg, b64, undefined, URL.createObjectURL(file));
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      {/* Quick help opens as a popup rather than expanding inline, so the
          conversation never gets pushed off-screen (matches the elder chat). */}
      <div className="px-4 pt-2.5 pb-1 shrink-0 flex items-center gap-2" data-tour="cg-askmei">
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
        {messages.map(msg => msg.isConfirmation ? (
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
          {[t(language, "ai.suggestAdherence"), t(language, "ai.suggestMissed"), t(language, "ai.suggestRefills")].map(s => (
            <button
              key={s}
              onClick={() => setInput(s)}
              className="shrink-0 bg-muted text-muted-foreground rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap active:bg-primary/10 active:text-primary transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4 pt-1 border-t border-border shrink-0">
        <div className="flex gap-2 items-end">
          {SpeechRecognitionImpl && (
            <button onClick={handleMic} className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${isListening ? "bg-red-500 text-white" : "bg-muted text-foreground"}`}>
              <Mic size={17} />
            </button>
          )}
          <button onClick={() => rxPhotoRef.current?.click()} className="w-10 h-10 rounded-full bg-muted text-foreground flex items-center justify-center shrink-0">
            <Camera size={17} />
          </button>
          <div className="flex-1 bg-input-background rounded-2xl px-3.5 py-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => { const v = e.target.value; setInput(v); if (v.trim() && quickOpen) setQuickOpen(false); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={t(language, "common.askMeiPlaceholder")}
              className="w-full bg-transparent text-foreground text-[15px] resize-none outline-none max-h-24 leading-relaxed placeholder:text-muted-foreground"
              rows={1}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground mt-2">{t(language, "ai.disclaimer")}</p>
      </div>

      {/* hidden inputs used by "Update profile" and "Add prescription" */}
      <input ref={reportRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onReportFile} />
      <input ref={rxPhotoRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onRxPhotoFile} />

      {showSummary && <WeeklySummarySheet patient={patient} onClose={() => setShowSummary(false)} />}
      {showTravel && (
        <TravelModeSheet
          patient={patient}
          elderId={elderId}
          onClose={() => setShowTravel(false)}
          onSaved={plan => onUpdatePatient({ ...patient, travelPlan: plan })}
        />
      )}

      {/* Language & voice sheet */}
      {showLangSheet && (
        <div className="absolute inset-0 z-50 flex items-end bg-black/40" onClick={() => setShowLangSheet(false)}>
          <div className="w-full bg-background rounded-t-3xl p-5 pb-7 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
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

            <div className="grid grid-cols-2 gap-2">
              <FeatureBtn icon={TrendingUp} label={t(language, "common.weeklySummary")} onClick={() => { setQuickOpen(false); setShowSummary(true); }} />
              <FeatureBtn icon={Plane}      label={t(language, "common.travelMode")}   onClick={() => { setQuickOpen(false); setShowTravel(true); }} />
              <FeatureBtn icon={Camera}     label={t(language, "common.addPrescription")} onClick={() => rxPhotoRef.current?.click()} />
              <FeatureBtn icon={FileText}   label={t(language, "ai.updateProfile")}       onClick={() => reportRef.current?.click()} />
              <FeatureBtn icon={Pill}       label={t(language, "ai.askAboutMed")}         onClick={() => setShowMedPicker(v => !v)} />
              <FeatureBtn icon={Globe}      label={t(language, "ai.languageVoice")}       onClick={() => { setQuickOpen(false); setShowLangSheet(true); }} />
            </div>

            {showMedPicker && (
              <div className="bg-muted/50 border border-border rounded-2xl p-3 mt-2.5">
                <p className="text-xs text-muted-foreground font-semibold px-0.5 pb-2">{t(language, "ai.whichMedication")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {uniqueMeds.map(n => (
                    <button key={n} onClick={() => { setShowMedPicker(false); setQuickOpen(false); send(`What is ${n} for?`); }} className="text-sm font-semibold bg-card border border-border text-foreground rounded-full px-3 py-2 active:bg-primary/10 active:text-primary transition-colors">
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

import { useState, useRef, useEffect } from "react";
import { Volume2, Mic, Send, AlertTriangle, Brain, Circle, Check, Trash2, Plus, Camera, FileText, Pill, Globe, Sparkles, ChevronDown, X, Plane } from "lucide-react";
import type { Patient } from "../../types";
import type { EMsg, ElderlyTab, DoctorQ } from "./types";
import { agentTurn } from "../../lib/hermes";
import { VOICE_DEMOS } from "../../data/medications";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

// A single feature tile in the "Quick help" launcher.
function FeatureBtn({ icon: Icon, label, onClick, "data-tour": dataTour }: { icon: any; label: string; onClick: () => void; "data-tour"?: string }) {
  return (
    <button onClick={onClick} data-tour={dataTour} className="flex items-center gap-2 bg-card border border-border rounded-xl p-2.5 text-left active:bg-muted transition-colors">
      <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Icon size={14} className="text-primary" /></div>
      <span className="text-[12px] font-bold text-foreground leading-tight">{label}</span>
    </button>
  );
}

export function ElderlyAIScreen({ patient, onLogDose, onNavigate, onAddRxPhoto, onOpenTravel, doctorQuestions, onAddDoctorQ, onMarkAnswered, onDeleteQuestion, autoMessage }: {
  patient: Patient;
  onLogDose: (id: number) => void;
  onNavigate: (tab: ElderlyTab) => void;
  onAddRxPhoto: () => void;
  onOpenTravel: () => void;
  doctorQuestions: DoctorQ[];
  onAddDoctorQ: (q: string) => void;
  onMarkAnswered: (id: number) => void;
  onDeleteQuestion: (id: number) => void;
  autoMessage?: string;
}) {
  const nick = patient.nickname || patient.name.split(" ")[1];
  const h = new Date().getHours();
  const g = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const next = patient.medications.find(m => m.status === "upcoming");
  const greeting: EMsg = {
    id: 1, role: "agent",
    text: `Good ${g}, ${nick}! 😊\n\nI'm Mei, your medication helper. ${next ? `Your next medication is ${next.name} (${next.dose}) at ${next.time}.` : "You've taken all your medications today — well done! 🌟"}\n\nTap a button above for quick help, or just type your question below.`,
    time: nowLabel(),
  };
  const [messages, setMessages] = useState<EMsg[]>([greeting]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const { language, setLanguage } = useLanguage();
  const [voiceOutput, setVoiceOutput] = useState(true);
  const [screenTab, setScreenTab] = useState<"chat" | "doctor">("chat");
  const [newQ, setNewQ] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [quickOpen, setQuickOpen] = useState(true);
  const [showMedPicker, setShowMedPicker] = useState(false);
  const [showLangSheet, setShowLangSheet] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLInputElement>(null);

  const flagged  = doctorQuestions.filter(q => !q.answered && q.addedAt.includes("Mei"));
  const manual   = doctorQuestions.filter(q => !q.answered && !q.addedAt.includes("Mei"));
  const answered = doctorQuestions.filter(q => q.answered);
  const unasked  = flagged.length + manual.length;
  const uniqueMeds = [...new Set(patient.medications.map(m => m.name))];

  const scrollToBottom = () => setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 60);
  const speak = () => { if (voiceOutput) { setIsSpeaking(true); setTimeout(() => setIsSpeaking(false), 2500); } };

  const pushAgent = (text: string, isClinic?: boolean) => {
    setMessages(prev => [...prev, { id: Date.now(), role: "agent", text, time: nowLabel(), isClinic }]);
    scrollToBottom();
    speak();
  };

  const handleMic = () => {
    if (isListening) return;
    setIsListening(true);
    setTimeout(() => {
      setInput(VOICE_DEMOS[Math.floor(Date.now() % VOICE_DEMOS.length)]);
      setIsListening(false);
    }, 1800);
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    setQuickOpen(false);
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: t, time: nowLabel() }]);
    scrollToBottom();
    setSending(true);
    const { reply } = await agentTurn(t);
    setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel() }]);
    setSending(false);
    scrollToBottom();
    speak();
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    send(text);
  };

  useEffect(() => {
    if (autoMessage) send(autoMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quick-help feature actions ----------------------------------------------
  const handleSetup = () => {
    setQuickOpen(false);
    pushAgent(`Let's get you set up, ${nick}! Here's what I can do:\n\n📷 Add a medication — tap “Add prescription” and snap a photo of the box.\n📄 Update your health profile — upload a clinic report and I'll read it.\n💊 Ask about a medication — tap “Ask a medication” and pick one.\n🌐 Change language or turn my voice on/off.\n\nWhat would you like to do first?`);
  };

  const runReport = () => {
    pushAgent("📄 Reading your report…");
    setTimeout(() => {
      pushAgent(`All done! I've updated ${nick}'s medical profile from the report:\n\n• Blood pressure: 128/80\n• HbA1c (sugar): 6.9%\n• Kidney function: normal\n\nYour caregiver can see these updates too. ✅`);
    }, 1400);
  };
  const onReportFile = () => runReport();

  const LANGS = [{ id: "en" as const, label: "English" }, { id: "zh" as const, label: "华语" }, { id: "hokkien" as const, label: "闽南话" }];

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">
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
                <p className="text-sm font-bold text-amber-900">Mei wasn't sure — ask your doctor</p>
                <span className="ml-auto text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{flagged.length}</span>
              </div>
              <div className="space-y-2">
                {flagged.map(q => (
                  <div key={q.id} className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Brain size={11} className="text-amber-600" />
                        <p className="text-[10px] text-amber-600 font-semibold uppercase tracking-wide">From your chat with Mei</p>
                      </div>
                      <p className="text-[15px] text-foreground leading-relaxed">{q.question}</p>
                      <p className="text-xs text-amber-700 mt-1">{q.addedAt}</p>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button onClick={() => onMarkAnswered(q.id)} className="text-xs font-bold text-primary bg-primary/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                        Asked ✓
                      </button>
                      <button onClick={() => onDeleteQuestion(q.id)} className="text-xs font-medium text-destructive bg-destructive/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manually added questions */}
          {manual.map(q => (
            <div key={q.id} className="bg-card rounded-2xl border border-border p-4 flex items-start gap-3">
              <div className="w-5 h-5 rounded-full border-2 border-primary/40 flex items-center justify-center shrink-0 mt-0.5">
                <Circle size={7} className="text-primary fill-primary" />
              </div>
              <div className="flex-1">
                <p className="text-[15px] text-foreground leading-relaxed">{q.question}</p>
                <p className="text-xs text-muted-foreground mt-1">{q.addedAt}</p>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button onClick={() => onMarkAnswered(q.id)} className="text-xs font-bold text-primary bg-primary/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                  Asked ✓
                </button>
                <button onClick={() => onDeleteQuestion(q.id)} className="text-xs font-medium text-destructive bg-destructive/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                  Delete
                </button>
              </div>
            </div>
          ))}

          {/* Add question */}
          {showInput ? (
            <div className="bg-card rounded-2xl border border-border p-4">
              <textarea value={newQ} onChange={e => setNewQ(e.target.value)} placeholder="Type your question for the doctor..." className="w-full bg-transparent text-foreground text-[15px] outline-none resize-none leading-relaxed placeholder:text-muted-foreground min-h-[80px]" autoFocus />
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setShowInput(false); setNewQ(""); }} className="flex-1 h-11 rounded-xl border border-border text-muted-foreground text-sm font-semibold">Cancel</button>
                <button onClick={() => { if (newQ.trim()) { onAddDoctorQ(newQ.trim()); setNewQ(""); setShowInput(false); } }} className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-bold">Save</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowInput(true)} className="w-full h-12 rounded-2xl border-2 border-dashed border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
              <Plus size={15} />Add your own question
            </button>
          )}

          {/* Already asked */}
          {answered.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-2">Already asked</p>
              {answered.map(q => (
                <div key={q.id} className="bg-muted/40 rounded-xl border border-border p-3 mb-2 flex items-start gap-3">
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
          {/* Quick help feature launcher */}
          <div className="px-4 pt-2.5 shrink-0" data-tour="elder-quickhelp">
            <button onClick={() => setQuickOpen(o => !o)} className="w-full flex items-center gap-1.5 mb-2">
              <Sparkles size={15} className="text-primary" />
              <span className="text-sm font-bold text-foreground">{t(language, "ai.quickHelp")}</span>
              <ChevronDown size={16} className={`ml-auto text-muted-foreground transition-transform ${quickOpen ? "rotate-180" : ""}`} />
            </button>
            {quickOpen && (
              <div className="space-y-2 pb-1">
                <button onClick={handleSetup} className="w-full flex items-center gap-2 bg-primary/10 text-primary rounded-xl px-3 py-2.5 text-sm font-bold active:scale-[0.99] transition-transform">
                  <Sparkles size={16} />{t(language, "ai.helpSetup")}
                </button>
                <div className="grid grid-cols-2 gap-1.5">
                  <FeatureBtn icon={Camera}   label="Add prescription" onClick={onAddRxPhoto} />
                  <FeatureBtn icon={FileText} label="Update profile"   onClick={() => reportRef.current?.click()} />
                  <FeatureBtn icon={Pill}     label="Ask a medication" onClick={() => setShowMedPicker(v => !v)} />
                  <FeatureBtn icon={Globe}    label="Language & voice" onClick={() => setShowLangSheet(true)} />
                  <FeatureBtn icon={Plane}    label="Travel Mode"      onClick={onOpenTravel} />
                </div>
                {showMedPicker && (
                  <div className="bg-card border border-border rounded-xl p-2.5">
                    <p className="text-[11px] text-muted-foreground font-semibold px-0.5 pb-1.5">Which medication would you like to know about?</p>
                    <div className="flex flex-wrap gap-1.5">
                      {uniqueMeds.map(n => (
                        <button key={n} onClick={() => { setShowMedPicker(false); send(`What is ${n} for?`); }} className="text-xs font-semibold bg-muted text-foreground rounded-full px-3 py-1.5 active:bg-primary/10 active:text-primary transition-colors">
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Speaking indicator */}
          {isSpeaking && (
            <div className="px-4 pb-1 shrink-0">
              <div className="flex items-center gap-1.5 text-primary">
                <Volume2 size={13} />
                <span className="text-xs font-semibold">{t(language, "ai.speaking")}{language !== "en" ? ` in ${language === "zh" ? "华语" : language === "hokkien" ? "闽南话" : language === "yue" ? "粤语" : language === "ta" ? "தமிழ்" : "Melayu"}` : ""}…</span>
              </div>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3 border-t border-border">
            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} gap-2`}>
                {msg.role === "agent" && (
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0 mt-1">
                    <span className="text-white text-xs font-bold">M</span>
                  </div>
                )}
                <div className={`max-w-[82%] flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                  <div className={`rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-card border border-border rounded-tl-sm"}`}>
                    <p className={`text-[15px] leading-relaxed whitespace-pre-line ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>{msg.text}</p>
                    {msg.isClinic && <p className="text-[11px] mt-2 opacity-60 italic">⚕️ Always verify with your doctor or pharmacist</p>}
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1">{msg.time}</p>
                </div>
              </div>
            ))}
            {isListening && (
              <div className="flex justify-center py-2">
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-full px-4 py-2">
                  <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-sm text-red-700 font-semibold">Listening...</span>
                </div>
              </div>
            )}
          </div>

          <div className="px-4 pb-2 shrink-0">
            <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
              {["I took my medication", "What do I take?", "Check refills", "Help"].map(s => (
                <button key={s} onClick={() => setInput(s)} className="shrink-0 bg-muted text-muted-foreground rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap active:bg-primary/10 active:text-primary transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 pb-4 pt-1 border-t border-border shrink-0">
            <div className="flex gap-2 items-end">
              <button onClick={handleMic} className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${isListening ? "bg-red-500 text-white" : "bg-muted text-foreground"}`}>
                <Mic size={17} />
              </button>
              <div className="flex-1 bg-input-background rounded-2xl px-3.5 py-2">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Type or tap the mic to speak..."
                  className="w-full bg-transparent text-foreground text-[15px] resize-none outline-none max-h-24 leading-relaxed placeholder:text-muted-foreground"
                  rows={1}
                />
              </div>
              <button onClick={handleSend} disabled={!input.trim() || sending} className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform">
                <Send size={16} />
              </button>
            </div>
            <p className="text-center text-[10px] text-muted-foreground mt-2">Mei is an AI helper. Always check with a doctor or pharmacist for medical advice.</p>
          </div>

          {/* hidden input used by "Update profile" */}
          <input ref={reportRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onReportFile} />

          {/* Language & voice sheet */}
          {showLangSheet && (
            <div className="absolute inset-0 z-50 flex items-end bg-black/40" onClick={() => setShowLangSheet(false)}>
              <div className="w-full bg-background rounded-t-3xl p-5 pb-7 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "ai.languageVoice")}</h3>
                  <button onClick={() => setShowLangSheet(false)} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center"><X size={16} className="text-muted-foreground" /></button>
                </div>
                <p className="text-sm font-semibold text-foreground mb-2">{t(language, "settings.language")}</p>
                <div className="flex gap-2 mb-5">
                  {LANGS.map(l => (
                    <button key={l.id} onClick={() => setLanguage(l.id)} className={`flex-1 py-3 rounded-xl text-[15px] font-bold border transition-colors ${language === l.id ? "bg-primary text-white border-primary" : "bg-card text-foreground border-border"}`}>
                      {l.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setVoiceOutput(v => !v)} className="w-full flex items-center justify-between bg-card border border-border rounded-xl px-4 py-3.5">
                  <div className="flex items-center gap-2"><Volume2 size={18} className="text-primary" /><span className="text-[15px] font-semibold text-foreground">{t(language, "settings.readAloud")}</span></div>
                  <div className={`w-12 h-7 rounded-full transition-colors relative ${voiceOutput ? "bg-primary" : "bg-muted"}`}>
                    <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${voiceOutput ? "left-[22px]" : "left-0.5"}`} />
                  </div>
                </button>
                <p className="text-xs text-muted-foreground mt-3">Mei can read her replies aloud in your chosen language.</p>
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}

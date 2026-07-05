import { useEffect, useRef, useState } from "react";
import { Volume2, Mic, Send, AlertTriangle, Brain, Circle, Check, Trash2, Plus } from "lucide-react";
import type { Patient } from "../../types";
import type { EMsg, DoctorQ } from "./types";
import { agentTurn } from "../../lib/hermes";
import { VOICE_DEMOS } from "../../data/medications";

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

export function ElderlyAIScreen({ patient, elderJwt, onDataChanged, doctorQuestions, onAddDoctorQ, onMarkAnswered, onDeleteQuestion, autoMessage }: {
  patient: Patient;
  elderJwt?: string;
  onDataChanged: () => void;
  doctorQuestions: DoctorQ[];
  onAddDoctorQ: (q: string) => void;
  onMarkAnswered: (id: string) => void;
  onDeleteQuestion: (id: string) => void;
  autoMessage?: string;
}) {
  const nick = patient.nickname || patient.name.split(" ")[1];
  const h = new Date().getHours();
  const g = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const next = patient.medications.find(m => m.status === "upcoming");
  const greeting: EMsg = {
    id: 1, role: "agent",
    text: `Good ${g}, ${nick}! 😊\n\nI'm Mei, your medicine helper. ${next ? `Your next medicine is ${next.name} (${next.dose}) at ${next.time}.` : "You've taken all your medicines today — well done! 🌟"}\n\nHow can I help you? Tap the microphone to speak, or type below.`,
    time: nowLabel(),
  };
  const [messages, setMessages] = useState<EMsg[]>([greeting]);
  const [input, setInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [language, setLanguage] = useState<"en" | "zh" | "hokkien">("en");
  const [screenTab, setScreenTab] = useState<"chat" | "doctor">("chat");
  const [newQ, setNewQ] = useState("");
  const [showInput, setShowInput] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const flagged  = doctorQuestions.filter(q => !q.answered && q.addedAt.includes("Mei"));
  const manual   = doctorQuestions.filter(q => !q.answered && !q.addedAt.includes("Mei"));
  const answered = doctorQuestions.filter(q => q.answered);
  const unasked  = flagged.length + manual.length;

  const scrollToBottom = () => setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 60);

  const handleMic = () => {
    if (isListening) return;
    setIsListening(true);
    setTimeout(() => {
      setInput(VOICE_DEMOS[Math.floor(Date.now() % VOICE_DEMOS.length)]);
      setIsListening(false);
    }, 1800);
  };

  const sendMessage = async (text: string) => {
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text, time: nowLabel() }]);
    scrollToBottom();
    if (!elderJwt) {
      setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: "Still signing you in — try again in a moment.", time: nowLabel() }]);
      return;
    }
    try {
      const { reply, tools_used } = await agentTurn(text, elderJwt);
      setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel() }]);
      if (tools_used.length > 0) onDataChanged();
      setIsSpeaking(true);
      setTimeout(() => setIsSpeaking(false), 2500);
    } catch (e) {
      setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: "Sorry, I couldn't reach the server just now. Please try again.", time: nowLabel() }]);
      console.error(e);
    }
    scrollToBottom();
  };

  useEffect(() => {
    if (autoMessage) sendMessage(autoMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
  };

  const LANGS = [{ id: "en" as const, label: "English" }, { id: "zh" as const, label: "华语" }, { id: "hokkien" as const, label: "闽南话" }];

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="px-4 pt-2 pb-0 shrink-0">
        <div className="flex gap-2 bg-muted rounded-xl p-1">
          <button onClick={() => setScreenTab("chat")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${screenTab === "chat" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
            Chat with Mei
          </button>
          <button onClick={() => setScreenTab("doctor")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors relative ${screenTab === "doctor" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
            Ask Doctor
            {unasked > 0 && <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full text-[9px] text-white font-bold flex items-center justify-center">{unasked}</span>}
          </button>
        </div>
      </div>

      {screenTab === "doctor" ? (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pb-28 pt-3 space-y-3">
          {/* Flagged by Mei — AI couldn't answer */}
          {flagged.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                <AlertTriangle size={14} className="text-amber-600 shrink-0" />
                <p className="text-sm font-bold text-amber-900">Mei wasn't sure — ask your doctor</p>
                <span className="ml-auto text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{flagged.length}</span>
              </div>
              <div className="divide-y divide-amber-100">
                {flagged.map(q => (
                  <div key={q.id} className="px-4 py-3 flex items-start gap-3">
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
          <div className="px-4 py-2.5 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex gap-1.5">
              {LANGS.map(l => (
                <button key={l.id} onClick={() => setLanguage(l.id)} className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${language === l.id ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}>
                  {l.label}
                </button>
              ))}
            </div>
            {isSpeaking && (
              <div className="flex items-center gap-1.5 text-primary">
                <Volume2 size={13} />
                <span className="text-xs font-semibold">Speaking...</span>
              </div>
            )}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3">
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
              {["I took my medicine", "What do I take?", "Check refills", "Help"].map(s => (
                <button key={s} onClick={() => setInput(s)} className="shrink-0 bg-muted text-muted-foreground rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap active:bg-primary/10 active:text-primary transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 pb-4 pt-1 border-t border-border shrink-0">
            <div className="flex gap-2 items-end">
              <button onClick={handleMic} className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-colors ${isListening ? "bg-red-500 text-white" : "bg-muted text-foreground"}`}>
                <Mic size={20} />
              </button>
              <div className="flex-1 bg-input-background rounded-2xl px-4 py-3">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Type or tap the mic to speak..."
                  className="w-full bg-transparent text-foreground text-[15px] resize-none outline-none max-h-24 leading-relaxed placeholder:text-muted-foreground"
                  rows={1}
                />
              </div>
              <button onClick={handleSend} disabled={!input.trim()} className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform">
                <Send size={18} />
              </button>
            </div>
            <p className="text-center text-[10px] text-muted-foreground mt-2">Mei is an AI helper. Always check with a doctor or pharmacist for medical advice.</p>
          </div>
        </>
      )}
    </div>
  );
}

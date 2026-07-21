import { useEffect, useRef, useState } from "react";
import { Send, Check, AlertTriangle, Brain, Circle, Trash2, Plus, CalendarClock } from "lucide-react";
import type { DoctorQ } from "../elderly/types";

interface ChatMsg { id: number; role: "user" | "agent"; text: string; time: string; isConfirmation?: boolean }

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

// This scenario is scripted and offline, same reasoning as
// walkthrough/WalkthroughAIScreen — no live Hermes session here, so a small
// local script stands in for agentTurn. The one question this screen exists
// to answer (shifting Amlodipine's timing) gets the real scripted answer;
// anything else gets a graceful, on-brand fallback with no doctor-question offer.
const SHIFT_QUESTION_MATCH = /shift|later|resched|move.*(time|timing)|change.*(time|timing)/i;
const SHIFT_REPLY =
  "Blood pressure medicines like **Amlodipine** are usually kept on a steady daily schedule — spacing doses more than an hour or two from her usual time can affect how evenly it controls her blood pressure through the day.\n\nI can walk you through the general spacing guidelines, but actually changing her schedule needs her doctor's approval first — it's not something I can adjust on my own.\n\nWant me to save this question for Margaret's upcoming Thursday appointment?";
const FALLBACK_REPLY =
  "I can help with that. For anything involving changing her medication schedule specifically, I'll always flag that it needs her doctor's sign-off first.";

async function agentTurn(message: string): Promise<{ reply: string; offerDoctorSave: boolean }> {
  await new Promise(resolve => setTimeout(resolve, 900));
  const matched = SHIFT_QUESTION_MATCH.test(message);
  return { reply: matched ? SHIFT_REPLY : FALLBACK_REPLY, offerDoctorSave: matched };
}

const SAVE_QUESTION_TEXT = "Can I shift Amlodipine to a later afternoon timing?";

export function WalkthroughCaregiverAIScreen({ patient, doctorQuestions, onAddDoctorQ, onMarkAnswered, onDeleteQuestion }: {
  patient: { name: string };
  doctorQuestions: DoctorQ[];
  onAddDoctorQ: (q: string) => void;
  onMarkAnswered: (id: number) => void;
  onDeleteQuestion: (id: number) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { id: 1, role: "agent", text: `Hi! I'm Mei — ask me anything about ${patient.name}'s medicines.`, time: nowLabel() },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [screenTab, setScreenTab] = useState<"chat" | "doctor">("chat");
  const [awaitingDoctorConfirm, setAwaitingDoctorConfirm] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [showInput, setShowInput] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const flagged = doctorQuestions.filter(q => !q.answered && q.addedAt.includes("Mei"));
  const manual = doctorQuestions.filter(q => !q.answered && !q.addedAt.includes("Mei"));
  const answered = doctorQuestions.filter(q => q.answered);
  const unasked = flagged.length + manual.length;

  const scrollToBottom = () => setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 60);

  useEffect(() => { scrollToBottom(); }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [input]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setInput("");
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text: trimmed, time: nowLabel() }]);
    scrollToBottom();
    setSending(true);
    const { reply, offerDoctorSave } = await agentTurn(trimmed);
    setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel() }]);
    setSending(false);
    setAwaitingDoctorConfirm(offerDoctorSave);
    scrollToBottom();
  };

  const confirmSaveForDoctor = () => {
    onAddDoctorQ(SAVE_QUESTION_TEXT);
    setAwaitingDoctorConfirm(false);
    setMessages(prev => [...prev, { id: Date.now(), role: "agent", text: "✓ Saved for Thursday's appointment", time: nowLabel(), isConfirmation: true }]);
    scrollToBottom();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      <div className="px-4 pt-2 pb-0 shrink-0">
        <div className="flex gap-2 bg-muted rounded-xl p-1">
          <button onClick={() => setScreenTab("chat")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${screenTab === "chat" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
            Chat
          </button>
          <button onClick={() => setScreenTab("doctor")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors relative ${screenTab === "doctor" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>
            Ask Doctor
            {unasked > 0 && <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full text-[9px] text-white font-bold flex items-center justify-center">{unasked}</span>}
          </button>
        </div>
      </div>

      {screenTab === "doctor" ? (
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 pb-6 pt-3 space-y-3">
          {flagged.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-1 pb-2">
                <AlertTriangle size={14} className="text-amber-600 shrink-0" />
                <p className="text-sm font-bold text-amber-900">Not sure? Ask her doctor</p>
                <span className="ml-auto text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{flagged.length}</span>
              </div>
              <div className="space-y-2">
                {flagged.map(q => (
                  <div key={q.id} className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Brain size={11} className="text-amber-600" />
                        <p className="text-[10px] text-amber-600 font-semibold uppercase tracking-wide">From chat with Mei</p>
                      </div>
                      <p className="text-[15px] text-foreground leading-relaxed">{q.question}</p>
                      <p className="text-xs text-amber-700 mt-1 flex items-center gap-1"><CalendarClock size={11} />{q.addedAt}</p>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button onClick={() => onMarkAnswered(q.id)} className="text-xs font-bold text-primary bg-primary/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                        Asked
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
                  Asked
                </button>
                <button onClick={() => onDeleteQuestion(q.id)} className="text-xs font-medium text-destructive bg-destructive/10 rounded-xl px-3 py-2 active:scale-95 transition-transform whitespace-nowrap">
                  Delete
                </button>
              </div>
            </div>
          ))}

          {showInput ? (
            <div className="bg-card rounded-2xl border border-border p-4">
              <textarea value={newQ} onChange={e => setNewQ(e.target.value)} placeholder="Type a question for her doctor…" className="w-full bg-transparent text-foreground text-[15px] outline-none resize-none leading-relaxed placeholder:text-muted-foreground min-h-[80px]" autoFocus />
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
                  <div className={`rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-card border border-border rounded-tl-sm"}`}>
                    <p className={`text-[15px] leading-relaxed whitespace-pre-line ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>
                      {msg.text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}
                    </p>
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1">{msg.time}</p>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex gap-2">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0 mt-1">
                  <span className="text-white text-xs font-bold">M</span>
                </div>
                <div className="bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3.5 flex items-center gap-1">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </div>
              </div>
            )}
            {awaitingDoctorConfirm && !sending && (
              <div className="flex justify-start pl-10">
                <button onClick={confirmSaveForDoctor} className="bg-primary text-primary-foreground rounded-full px-4 py-2 text-sm font-bold flex items-center gap-1.5 active:scale-[0.97] transition-transform">
                  <CalendarClock size={14} /> Confirm — save for Thursday
                </button>
              </div>
            )}
          </div>

          <div className="px-4 pb-4 pt-1 border-t border-border shrink-0">
            <div className="flex gap-2 items-end">
              <div className="flex-1 bg-input-background rounded-2xl px-3.5 py-1.5 min-h-10 flex items-center">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Type or tap the mic…"
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
        </>
      )}
    </div>
  );
}

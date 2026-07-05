import { useRef, useState } from "react";
import { Send, TrendingUp } from "lucide-react";
import type { Patient } from "../types";
// Stays on the local canned responder rather than Hermes's /agent/turn: that
// contract only resolves elder_id from the caller's own JWT (services/hermes/
// src/hermes/api/routes.py), with no "caregiver acting on a specific linked
// elder" mode yet. Wiring this for real needs a contract change on the Hermes
// side, out of scope here — see ElderlyAIScreen.tsx for the elder's own chat,
// which already calls Hermes for real since that mapping fits as-is.
import { caregiverAiRespond } from "./caregiverAiRespond";
import { WeeklySummarySheet } from "./WeeklySummarySheet";

interface ChatMsg { id: number; role: "user" | "agent"; text: string; time: string }

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

export function AskMeiScreen({ patient }: { patient: Patient }) {
  const [messages, setMessages] = useState<ChatMsg[]>(() => [
    {
      id: 1,
      role: "agent",
      text: `Hi! I'm Mei, your AI care assistant for ${patient.name}. Ask me about today's adherence, missed doses, refills, or any medication.`,
      time: nowLabel(),
    },
  ]);
  const [input, setInput] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => setTimeout(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, 60);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    const reply = caregiverAiRespond(text, patient);
    setMessages(prev => [...prev,
      { id: Date.now(), role: "user", text, time: nowLabel() },
      { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel() },
    ]);
    setInput("");
    scrollToBottom();
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">
      <div className="px-4 py-2.5 border-b border-border shrink-0">
        <button
          onClick={() => setShowSummary(true)}
          className="w-full flex items-center justify-center gap-1.5 bg-secondary text-primary text-xs font-semibold rounded-full px-3 py-2 active:opacity-80 transition-opacity"
        >
          <TrendingUp size={13} /> View Weekly Summary
        </button>
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
              </div>
              <p className="text-[10px] text-muted-foreground px-1">{msg.time}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 pb-2 shrink-0">
        <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
          {["How's adherence today?", "Any missed doses?", "Check refills"].map(s => (
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
          <div className="flex-1 bg-input-background rounded-2xl px-4 py-3">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Ask Mei about this patient..."
              className="w-full bg-transparent text-foreground text-[15px] resize-none outline-none max-h-24 leading-relaxed placeholder:text-muted-foreground"
              rows={1}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform"
          >
            <Send size={18} />
          </button>
        </div>
      </div>

      {showSummary && <WeeklySummarySheet patient={patient} onClose={() => setShowSummary(false)} />}
    </div>
  );
}

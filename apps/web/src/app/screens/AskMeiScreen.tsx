import { useRef, useState } from "react";
import { Send, TrendingUp, Plane, Check } from "lucide-react";
import type { Patient, Screen } from "../types";
import { agentTurn } from "../lib/hermes";
import { firstRoutableAction } from "../lib/agentActions";
import { WeeklySummarySheet } from "./WeeklySummarySheet";
import { TravelModeSheet } from "./TravelModeSheet";

interface ChatMsg { id: number; role: "user" | "agent"; text: string; time: string; isConfirmation?: boolean }

const nowLabel = () => new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

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

export function AskMeiScreen({ patient, elderId, onUpdatePatient, onNavigate, onMedsChanged }: { patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onNavigate?: (screen: Screen) => void; onMedsChanged?: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>(() => [
    {
      id: 1,
      role: "agent",
      text: `Hi! I'm Mei, your AI care assistant for ${patient.name}. Ask me about today's adherence, missed doses, refills, or any medication.`,
      time: nowLabel(),
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showTravel, setShowTravel] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => setTimeout(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, 60);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setMessages(prev => [...prev, { id: Date.now(), role: "user", text, time: nowLabel() }]);
    scrollToBottom();
    setSending(true);
    const { reply, actions } = await agentTurn(text);
    setMessages(prev => [...prev, { id: Date.now() + 1, role: "agent", text: reply, time: nowLabel() }]);
    setSending(false);
    scrollToBottom();
    // Only when the agent actually committed a write this turn: refresh, confirm,
    // and guide the caregiver to the page that shows the change.
    const routed = firstRoutableAction(actions);
    if (routed) {
      onMedsChanged?.();
      setMessages(prev => [...prev, { id: Date.now() + 2, role: "agent", text: `✓ ${routed.target.done} — opening ${routed.target.label}…`, time: nowLabel(), isConfirmation: true }]);
      scrollToBottom();
      if (onNavigate) setTimeout(() => onNavigate(routed.target.caregiver), 1200);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">
      <div className="px-4 py-2.5 border-b border-border shrink-0 flex gap-2" data-tour="cg-askmei">
        <button
          onClick={() => setShowSummary(true)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-secondary text-primary text-xs font-semibold rounded-full px-3 py-2 active:opacity-80 transition-opacity"
        >
          <TrendingUp size={13} /> Weekly Summary
        </button>
        <button
          onClick={() => setShowTravel(true)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-secondary text-primary text-xs font-semibold rounded-full px-3 py-2 active:opacity-80 transition-opacity"
        >
          <Plane size={13} /> Travel Mode
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-3">
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
                <p className={`text-[15px] leading-relaxed whitespace-pre-line ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>{renderWithBold(msg.text)}</p>
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
            disabled={!input.trim() || sending}
            className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-transform"
          >
            <Send size={18} />
          </button>
        </div>
      </div>

      {showSummary && <WeeklySummarySheet patient={patient} onClose={() => setShowSummary(false)} />}
      {showTravel && (
        <TravelModeSheet
          patient={patient}
          elderId={elderId}
          onClose={() => setShowTravel(false)}
          onSaved={plan => onUpdatePatient({ ...patient, travelPlan: plan })}
        />
      )}
    </div>
  );
}

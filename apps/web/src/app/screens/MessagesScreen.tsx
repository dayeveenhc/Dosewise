import { useEffect, useState } from "react";
import { Users, Send } from "lucide-react";
import type { Patient, Message } from "../types";
import { fetchCaregiverMessages, sendCaregiverMessage } from "../data/api";

export function MessagesScreen({ patient, currentUserId }: { patient: Patient; currentUserId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    fetchCaregiverMessages(patient.id, currentUserId).then(setMessages).catch(console.error);
  }, [patient.id, currentUserId]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    await sendCaregiverMessage(patient.id, currentUserId, body);
    setMessages(await fetchCaregiverMessages(patient.id, currentUserId));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="px-4 py-3 bg-card border-b border-border">
        <div className="flex items-center gap-2 mb-0.5">
          <Users size={14} className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground font-medium">{patient.name} — Care Team</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.isMe ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%]`}>
              {!m.isMe && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <div className="w-5 h-5 rounded-full bg-secondary flex items-center justify-center text-[9px] font-bold text-primary">
                    {m.author.split(" ").map(w => w[0]).join("").slice(0, 2)}
                  </div>
                  <span className="text-[10px] text-muted-foreground font-medium">{m.author} · {m.role}</span>
                </div>
              )}
              <div className={`rounded-2xl px-3.5 py-2.5 ${m.isMe ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-card border border-border rounded-tl-sm"}`}>
                <p className={`text-sm leading-relaxed ${m.isMe ? "text-white" : "text-foreground"}`}>{m.body}</p>
              </div>
              <p className={`text-[10px] font-mono text-muted-foreground mt-1 ${m.isMe ? "text-right mr-1" : "ml-1"}`}>{m.time}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Compose */}
      <div className="px-4 py-3 bg-card border-t border-border">
        <div className="flex gap-2 items-end">
          <div className="flex-1 bg-input-background border border-border rounded-2xl px-4 py-2.5">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="Leave a note for the care team..."
              rows={draft.split("\n").length > 1 ? 3 : 1}
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none leading-relaxed"
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
          </div>
          <button
            onClick={send}
            disabled={!draft.trim()}
            className="w-10 h-10 bg-primary rounded-2xl flex items-center justify-center shrink-0 disabled:opacity-40 transition-opacity"
          >
            <Send size={16} className="text-white" />
          </button>
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          {["Morning meds taken ✓", "Please call at noon", "Call doctor needed"].map(s => (
            <button key={s} onClick={() => setDraft(s)} className="text-[11px] bg-secondary border border-primary/20 text-primary rounded-full px-2.5 py-1 font-medium">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

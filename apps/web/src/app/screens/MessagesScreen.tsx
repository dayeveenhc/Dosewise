import { useState } from "react";
import { Users, Send } from "lucide-react";
import { MESSAGES } from "../data/patients";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

export function MessagesScreen() {
  const { language } = useLanguage();
  const [messages, setMessages] = useState(MESSAGES);
  const [draft, setDraft] = useState("");

  const send = () => {
    if (!draft.trim()) return;
    setMessages(prev => [
      ...prev,
      { id: prev.length + 1, author: "You", role: "Son", body: draft.trim(), time: "Now", isMe: true },
    ]);
    setDraft("");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="px-4 py-3 bg-card border-b border-border">
        <div className="flex items-center gap-2 mb-0.5">
          <Users size={14} className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground font-medium">Mdm Tan Bee Leng — {t(language, "messages.careTeam")}</p>
        </div>
        <div className="flex items-center gap-2">
          {["WM", "SF", "SN"].map((init, i) => (
            <div key={i} className="w-6 h-6 rounded-full bg-secondary border-2 border-background flex items-center justify-center text-[calc(9px*var(--dw-text,1))] font-bold text-primary">{init}</div>
          ))}
          <span className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">You, Shu Fen, Siti Nuraini</span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.isMe ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%]`}>
              {!m.isMe && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <div className="w-5 h-5 rounded-full bg-secondary flex items-center justify-center text-[calc(9px*var(--dw-text,1))] font-bold text-primary">
                    {m.author.split(" ").map(w => w[0]).join("").slice(0, 2)}
                  </div>
                  <span className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground font-medium">{m.author} · {m.role}</span>
                </div>
              )}
              <div className={`rounded-2xl px-3.5 py-2.5 ${m.isMe ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-card border border-border rounded-tl-sm"}`}>
                <p className={`text-sm leading-relaxed ${m.isMe ? "text-white" : "text-foreground"}`}>{m.body}</p>
              </div>
              <p className={`text-[calc(10px*var(--dw-text,1))] font-mono text-muted-foreground mt-1 ${m.isMe ? "text-right mr-1" : "ml-1"}`}>{m.time}</p>
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
              placeholder={t(language, "messages.placeholder")}
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
          {[t(language, "messages.quickMorningMeds"), t(language, "messages.quickCallNoon"), t(language, "messages.quickCallDoctor")].map(s => (
            <button key={s} onClick={() => setDraft(s)} className="text-[calc(11px*var(--dw-text,1))] bg-secondary border border-primary/20 text-primary rounded-full px-2.5 py-1 font-medium">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

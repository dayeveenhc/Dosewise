import { useState } from "react";
import { X, Send, Check } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

interface SendReminderSheetProps {
  patientName: string;
  medName?: string;
  onClose: () => void;
  onSend: (text: string) => void;
}

export function SendReminderSheet({ patientName, medName, onClose, onSend }: SendReminderSheetProps) {
  const { language } = useLanguage();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);

  const defaults = medName
    ? [
        t(language, "reminder.defaultNamed", { med: medName }),
        t(language, "reminder.defaultCheckIn"),
        t(language, "reminder.defaultDontForget"),
      ]
    : [
        t(language, "reminder.defaultTimeToTake"),
        t(language, "reminder.defaultCheckIn"),
        t(language, "reminder.defaultDontForget"),
        t(language, "reminder.defaultRemember"),
      ];

  const handleSend = () => {
    if (!text.trim() || sent) return;
    onSend(text.trim());
    setSent(true);
    setTimeout(onClose, 1400);
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={sent ? undefined : onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {sent ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12">
            <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center animate-in zoom-in duration-300">
              <Check size={30} className="text-white" strokeWidth={3} />
            </div>
            <p className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "reminder.sent")}</p>
            <p className="text-sm text-muted-foreground text-center">{t(language, "reminder.willSeeIt", { name: patientName })}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
              <div>
                <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, "reminder.title")}</h2>
                <p className="text-xs text-muted-foreground">{t(language, "reminder.to", { name: patientName })}</p>
              </div>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <X size={14} className="text-foreground" />
              </button>
            </div>

            <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
              <div>
                <p className="text-xs font-semibold text-foreground mb-2">{t(language, "reminder.quickOptions")}</p>
                <div className="flex flex-col gap-2">
                  {defaults.map(d => (
                    <button
                      key={d}
                      onClick={() => setText(d)}
                      className={`text-left text-sm rounded-xl border px-3.5 py-2.5 transition-colors ${text === d ? "bg-primary/10 border-primary text-foreground" : "bg-muted/50 border-border text-foreground"}`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "reminder.writeOwn")}</label>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder={t(language, "reminder.placeholder")}
                  rows={3}
                  className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors resize-none"
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-border shrink-0">
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
              >
                <Send size={16} /> {t(language, "reminder.send")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

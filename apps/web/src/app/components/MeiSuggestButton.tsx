import { useState } from "react";
import { Sparkles, X, Check } from "lucide-react";
import { agentTurn } from "../lib/hermes";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// The exact sentinel Mei is told to reply with when she has nothing to go on —
// asked for "in English, do not translate" since reply_language can otherwise
// make the agent translate it, breaking the exact-match check below.
const UNKNOWN_SENTINEL = "UNKNOWN";

// A small "ask Mei to guess this" affordance for a blank profile field. Reuses
// the already-wired agentTurn() chat call (no Hermes changes) with a prompt
// asking for a single-value suggestion based on what Mei already knows about
// this user's profile; the reply is shown in a popup with a confirm button
// that autofills the field, matching the elder chat's propose->confirm pattern.
export function MeiSuggestButton({ fieldLabel, onAccept, className = "", formatHint, validate }: {
  fieldLabel: string;
  onAccept: (value: string) => void;
  className?: string;
  // Extra constraint appended to the prompt, e.g. "Reply in YYYY-MM-DD format
  // only." — for fields whose accepted value has a strict shape (a native
  // date input silently rejects anything that isn't ISO).
  formatHint?: string;
  // Extra shape check on top of the UNKNOWN sentinel — a reply that fails
  // this is treated the same as "not enough information" rather than shown
  // as a confident-looking suggestion that wouldn't actually parse.
  validate?: (value: string) => boolean;
}) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);

  const ask = async () => {
    if (loading) return;
    setOpen(true);
    setLoading(true);
    setSuggestion(null);
    setUnknown(false);
    const prompt = `The user is filling in their "${fieldLabel}" and left it blank. Based on everything you already know about their profile, suggest a likely value. Reply with ONLY that value and nothing else — no explanation, no punctuation around it.${formatHint ? ` ${formatHint}` : ""} If you don't have enough information to make a reasonable guess, reply with exactly the single word ${UNKNOWN_SENTINEL} (in English, do not translate it).`;
    const { reply } = await agentTurn(prompt);
    const cleaned = reply.trim().replace(/^["'.\s]+|["'.\s]+$/g, "");
    if (!cleaned || cleaned.toUpperCase() === UNKNOWN_SENTINEL || (validate && !validate(cleaned))) {
      setUnknown(true);
    } else {
      setSuggestion(cleaned);
    }
    setLoading(false);
  };

  const accept = () => {
    if (suggestion) onAccept(suggestion);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={ask}
        disabled={loading}
        title={t(language, "ai.suggestFor", { field: fieldLabel })}
        className={`inline-flex items-center gap-1 text-[10px] font-semibold text-primary bg-secondary rounded-full px-2 py-0.5 active:opacity-80 transition-opacity shrink-0 disabled:opacity-50 ${className}`}
      >
        <Sparkles size={10} className="shrink-0" />
        {t(language, "ai.suggestButton")}
      </button>

      {open && (
        <div className="absolute inset-0 z-[150] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="relative bg-card rounded-2xl p-5 shadow-2xl w-full max-w-[300px]">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
                <span className="text-white text-xs font-bold">M</span>
              </div>
              <h3 className="font-['Fraunces'] text-base font-semibold text-foreground">{t(language, "ai.suggestTitle")}</h3>
              <button onClick={() => setOpen(false)} className="ml-auto w-7 h-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                <X size={13} />
              </button>
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Sparkles size={13} className="text-primary animate-pulse" />{t(language, "ai.suggestLoading")}
              </p>
            ) : unknown ? (
              <p className="text-sm text-muted-foreground leading-relaxed">{t(language, "ai.suggestUnknown")}</p>
            ) : (
              <>
                <p className="text-sm text-foreground leading-relaxed mb-4">{t(language, "ai.suggestValue", { value: suggestion ?? "" })}</p>
                <div className="flex gap-2">
                  <button onClick={() => setOpen(false)} className="flex-1 h-11 rounded-xl border border-border text-muted-foreground text-sm font-semibold">
                    {t(language, "common.cancel")}
                  </button>
                  <button onClick={accept} className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5">
                    <Check size={14} />{t(language, "ai.suggestUseThis")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

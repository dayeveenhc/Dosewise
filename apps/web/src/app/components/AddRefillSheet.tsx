import { useState } from "react";
import { X, Minus, Plus, Check, Sparkles, PackagePlus } from "lucide-react";
import { daysOfSupply } from "../lib/medications";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// The quick counts a box of medicine actually comes in. Tap-first like
// TimesPicker: the stepper and the chips are the intended path, the number
// input is the escape hatch for anything else.
const QUICK_COUNTS = [14, 28, 30, 60, 90];

/**
 * "I've refilled it" — records the supply a person has AT HOME.
 *
 * Deliberately not the same thing as Request refill, which asks the DOCTOR for
 * more (chat -> Hermes `request_refill` -> doctor_questions). Two actions, two
 * actors; the help line below says so, because the two sat next to each other
 * on the medicine card with only their verbs to tell them apart.
 *
 * Collects a COUNT rather than a number of days, matching Hermes's `log_refill`
 * — and because `supplyDaysLeft` prefers `pills_remaining` over the forecast,
 * that count is what the supply bar will read from here on. The live "≈ N days"
 * preview exists so that change of basis is disclosed before the person saves,
 * rather than surprising them afterwards.
 */
export function AddRefillSheet({ medName, dosesPerDay, initialCount, onClose, onSave }: {
  medName: string;
  /** How many are taken per day — what days-left divides by. */
  dosesPerDay: number;
  /** What is already on file, so re-opening shows it rather than starting blank. */
  initialCount?: number;
  onClose: () => void;
  onSave: (pillsRemaining: number) => Promise<void>;
}) {
  const { language } = useLanguage();
  const [raw, setRaw] = useState(initialCount != null ? String(initialCount) : "28");
  const [state, setState] = useState<"idle" | "saving" | "success">("idle");
  const [error, setError] = useState<string | null>(null);

  const count = Number.parseInt(raw, 10);
  const valid = Number.isFinite(count) && count >= 0;
  const preview = valid ? daysOfSupply(count, dosesPerDay) : 0;

  const step = (by: number) => setRaw(String(Math.max(0, (valid ? count : 0) + by)));

  const save = async () => {
    if (!valid || state !== "idle") return;
    setState("saving");
    setError(null);
    try {
      await onSave(count);
      setState("success");
      window.setTimeout(onClose, 700);
    } catch (err) {
      console.error("Failed to log refill", err);
      setState("idle");
      setError(t(language, "prescription.refillError"));
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85%]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0 gap-3">
          <div className="min-w-0">
            <h2 className="dw-display text-[calc(18px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "prescription.addRefillTitle")}</h2>
            <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground truncate">{medName}</p>
          </div>
          <button onClick={onClose} aria-label={t(language, "link.close")} className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
            <X size={15} className="text-foreground" />
          </button>
        </div>

        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-3.5">
          <label className="block text-[calc(13px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "prescription.refillCountLabel")}</label>

          <div className="flex items-center gap-3 bg-card border border-border rounded-xl px-3 py-2.5">
            <button
              onClick={() => step(-1)}
              disabled={!valid || count <= 0}
              aria-label={t(language, "prescription.fewerDays")}
              className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-foreground disabled:opacity-40 shrink-0"
            >
              <Minus size={18} />
            </button>
            <input
              data-walk="refill-count-input"
              type="number"
              min={0}
              inputMode="numeric"
              value={raw}
              onChange={e => setRaw(e.target.value)}
              aria-label={t(language, "prescription.refillCountLabel")}
              className="flex-1 min-w-0 bg-transparent text-center text-[calc(22px*var(--dw-text,1))] font-bold text-foreground outline-none"
            />
            <button
              onClick={() => step(+1)}
              aria-label={t(language, "prescription.moreDays")}
              className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-foreground shrink-0"
            >
              <Plus size={18} />
            </button>
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {QUICK_COUNTS.map(n => (
              <button
                key={n}
                onClick={() => setRaw(String(n))}
                aria-pressed={count === n}
                className={`flex-1 min-w-[56px] h-11 rounded-xl text-[calc(14px*var(--dw-text,1))] font-bold border transition-colors ${
                  count === n ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          {/* The change of basis, stated before it happens. */}
          {valid && (
            <p className="text-[calc(14px*var(--dw-text,1))] font-semibold text-foreground bg-secondary border border-primary/20 rounded-xl px-3.5 py-2.5">
              {t(language, "prescription.refillPreview", { count, perDay: dosesPerDay, days: preview })}
            </p>
          )}

          <p className="text-[calc(12px*var(--dw-text,1))] text-muted-foreground leading-relaxed">{t(language, "prescription.refillHelp")}</p>
        </div>

        <div className="px-5 py-4 border-t border-border shrink-0 space-y-2">
          {error && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-[calc(12px*var(--dw-text,1))] text-destructive">
              {error}
            </div>
          )}
          <button
            data-walk="refill-save-btn"
            onClick={save}
            disabled={!valid || state !== "idle"}
            className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 disabled:opacity-40 dw-press"
          >
            {state === "saving" ? <Sparkles size={17} className="animate-pulse" /> : state === "success" ? <Check size={17} /> : <PackagePlus size={17} />}
            {state === "success" ? t(language, "prescription.refillSaved") : t(language, "prescription.refillSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

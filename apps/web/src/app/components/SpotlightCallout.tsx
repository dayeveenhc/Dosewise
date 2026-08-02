import { useLayoutEffect, useRef } from "react";
import { Brain, AlertTriangle } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import type { ReactNode } from "react";

// The shared spotlight callout card, used by BOTH the Guided Auto-Nav
// walkthrough and the passive product tour, so the app's guidance UI looks like
// one system. A Mei avatar + a "Step X of Y" counter with a single slim progress
// track (scales cleanly — the old one-segment-per-step bar was a mess at ~28
// onboarding steps), an optional Fraunces title, the body, and an actions slot.
// It reports its MEASURED height up (onHeight) so the host can position it clear
// of the spotlight and nav instead of guessing a fixed height.
export function SpotlightCallout({
  stepIndex,
  stepCount,
  title,
  body,
  error = false,
  top,
  counterKey,
  labelKey,
  onHeight,
  panel,
  children,
}: {
  stepIndex: number;
  stepCount: number;
  title?: string;
  body: string;
  error?: boolean;
  top: number;
  counterKey: string; // "walk.stepCounter" | "tour.stepCounter"
  labelKey: string;   // "walk.meiLabel" | "tour.meiLabel"
  onHeight?: (h: number) => void;
  // An optional detail block between the body and the actions row (the
  // "check these details" review card). Deliberately domain-neutral so the
  // passive product tour can use it too. NOT in the measure deps below — a
  // ReactNode is a fresh object every render; the ResizeObserver is what keeps
  // onHeight honest when this grows or a value inside it changes.
  panel?: ReactNode;
  children?: ReactNode; // action buttons (Exit, or Skip/Back/Next)
}) {
  const { language } = useLanguage();
  const ref = useRef<HTMLDivElement>(null);

  // Report real rendered height so the host places the card without overlapping
  // the target or the bottom nav. Re-measures on content/step/error changes and
  // via ResizeObserver (font-size / language can reflow the body).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onHeight) return;
    const report = () => onHeight(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, title, stepIndex, error, onHeight]);

  const pct = stepCount > 0 ? Math.round(((stepIndex + 1) / stepCount) * 100) : 0;

  return (
    <div
      ref={ref}
      className="absolute left-4 right-4 bg-card rounded-2xl border border-border p-4 shadow-xl pointer-events-auto transition-[top] duration-300 ease-out"
      style={{ top }}
    >
      {/* Header: Mei avatar + label, step counter on the right */}
      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${error ? "bg-destructive/10" : "bg-primary/10"}`}>
          {error ? <AlertTriangle size={16} className="text-destructive" /> : <Brain size={16} className="text-primary" />}
        </div>
        <p className="text-[calc(11px*var(--dw-text,1))] font-semibold uppercase tracking-[0.12em] text-muted-foreground flex-1 min-w-0 truncate">
          {t(language, labelKey)}
        </p>
        <p className="text-[calc(11px*var(--dw-text,1))] font-medium text-muted-foreground shrink-0 tabular-nums">
          {t(language, counterKey, { current: stepIndex + 1, total: stepCount })}
        </p>
      </div>

      {/* Single slim progress track */}
      <div className="mt-2.5 h-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
      </div>

      {title && (
        <h3 className="font-['Fraunces'] text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground mt-3 leading-snug">{title}</h3>
      )}
      <p className={`text-sm leading-relaxed ${title ? "mt-1" : "mt-3"} ${error ? "text-destructive font-medium" : "text-muted-foreground"}`}>
        {body}
      </p>

      {panel}

      {children && <div className="flex items-center gap-1.5 mt-3">{children}</div>}
    </div>
  );
}

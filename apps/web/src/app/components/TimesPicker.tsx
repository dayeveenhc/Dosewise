import { useState, useRef } from "react";
import type { ReactNode } from "react";
import { Bed, Check, ChevronDown, ChevronUp, Clock, Coffee, Plus, Sun, Sunset, X } from "lucide-react";
import { MEAL_TIMES } from "../data/medications";
import { to12h, to24h, formatClock } from "../lib/medications";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { emitWalkthroughEvent } from "../lib/walkthrough/bus";
import { useAccessibility } from "../accessibility.tsx";

// The elder's own routine, as collected by the wizard's routine step and stored
// on `ProfileDetails` (note `sleepTime` sits beside `mealTimes`, not inside it).
export interface RoutineTimes {
  breakfast?: string;
  lunch?: string;
  dinner?: string;
  sleepTime?: string;
}

// The four slots that cover almost every prescription. Each prefers the elder's
// own routine and falls back to MEAL_TIMES, which is also what the agent's
// meal-relative parsing ("after breakfast") uses when there's no profile.
const QUICK_SLOTS = [
  { key: "morning", labelKey: "times.morning", Icon: Coffee, pick: (r?: RoutineTimes) => r?.breakfast, fallback: MEAL_TIMES["breakfast"] },
  { key: "noon", labelKey: "times.noon", Icon: Sun, pick: (r?: RoutineTimes) => r?.lunch, fallback: MEAL_TIMES["lunch"] },
  { key: "evening", labelKey: "times.evening", Icon: Sunset, pick: (r?: RoutineTimes) => r?.dinner, fallback: MEAL_TIMES["dinner"] },
  { key: "bedtime", labelKey: "times.bedtime", Icon: Bed, pick: (r?: RoutineTimes) => r?.sleepTime, fallback: MEAL_TIMES["bedtime"] },
] as const;

const slotsFor = (routine?: RoutineTimes) =>
  QUICK_SLOTS.map(s => ({ ...s, hhmm: toHHMM(s.pick(routine) || s.fallback) }));

/** The time a new medication starts on: the elder's breakfast, else 8am. */
export const defaultDoseTime = (routine?: RoutineTimes) =>
  toDisplayTime(routine?.breakfast || MEAL_TIMES["breakfast"]);

/** Normalise any accepted time form to the app's 12h display string. */
export const toDisplayTime = (value: string) => to12h(toHHMM(value));

// One minute at a time. Five-minute jumps meant a time like 7:23 simply could
// not be entered, and made the wheel feel like it was skipping rather than
// turning — the drag is what covers distance quickly now.
const MINUTE_STEP = 1;

const HHMM = /^(\d{1,2}):(\d{2})$/;
// Callers hand us 12h display strings ("8:00 AM"), but a record extraction can
// hand us a 24h one ("08:00"). Accept either and work in 24h internally, where
// string sort is chronological.
function toHHMM(value: string): string {
  const m = value.trim().match(HHMM);
  if (!m) return to24h(value);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

const normalize = (values: string[]) => [...new Set(values.map(toHHMM))].sort();

interface Draft { h12: number; min: number; pm: boolean }

function toDraft(hhmm: string): Draft {
  const [h, min] = hhmm.split(":").map(Number);
  return { h12: h % 12 === 0 ? 12 : h % 12, min, pm: h >= 12 };
}
function fromDraft({ h12, min, pm }: Draft): string {
  const h = pm ? (h12 === 12 ? 12 : h12 + 12) : (h12 === 12 ? 0 : h12);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// One column of the picker: the arrows still step it one value at a time (up
// goes later, down goes earlier), and now the number itself is a wheel — drag
// it, or scroll it, to run through values quickly. The wheel is additive: every
// value remains reachable by tapping alone, which is what shaky hands need.
function Stepper({ value, onUp, onDown, upLabel, downLabel, wheelLabel }: {
  value: string; onUp: () => void; onDown: () => void; upLabel: string; downLabel: string; wheelLabel: string;
}) {
  const btn = "w-14 h-9 rounded-xl bg-muted border border-border flex items-center justify-center text-foreground active:bg-secondary transition-colors";
  // Drag/scroll distance for one step. Short enough that a normal thumb-swipe
  // crosses a useful range now that steps are single minutes, long enough that
  // a tap-with-a-wobble doesn't move anything. Every step goes through the same
  // callbacks the buttons use, so there's one source of truth for wrapping.
  const STEP_PX = 10;
  const dragRef = useRef<{ startY: number; steps: number } | null>(null);
  const wheelRef = useRef(0);

  // Dragging UP raises the value, matching the arrow above it and every
  // physical wheel: the numbers travel with your finger.
  const applyDelta = (deltaSteps: number) => {
    for (let i = 0; i < Math.abs(deltaSteps); i++) (deltaSteps > 0 ? onUp : onDown)();
  };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button type="button" onClick={onUp} aria-label={upLabel} className={btn}><ChevronUp size={18} /></button>
      <div
        role="slider"
        tabIndex={0}
        aria-label={wheelLabel}
        aria-valuetext={value}
        onKeyDown={e => {
          if (e.key === "ArrowUp") { e.preventDefault(); onUp(); }
          if (e.key === "ArrowDown") { e.preventDefault(); onDown(); }
        }}
        onWheel={e => {
          wheelRef.current += e.deltaY;
          while (Math.abs(wheelRef.current) >= STEP_PX) {
            const dir = wheelRef.current > 0 ? -1 : 1; // wheel down = earlier
            wheelRef.current -= Math.sign(wheelRef.current) * STEP_PX;
            applyDelta(dir);
          }
        }}
        onPointerDown={e => {
          dragRef.current = { startY: e.clientY, steps: 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          const d = dragRef.current;
          if (!d) return;
          const wanted = Math.round((d.startY - e.clientY) / STEP_PX); // up = positive
          if (wanted !== d.steps) {
            applyDelta(wanted - d.steps);
            d.steps = wanted;
          }
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
        className="w-14 select-none touch-none cursor-ns-resize rounded-xl py-0.5 flex flex-col items-center outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="text-3xl font-semibold text-foreground tabular-nums leading-none">{value}</span>
        {/* Two short rules under the number: the only affordance that says
            "this one scrolls" without adding words to a picker. */}
        <span className="mt-1 flex flex-col gap-[3px] opacity-40">
          <span className="block w-6 h-[2px] rounded-full bg-foreground" />
          <span className="block w-6 h-[2px] rounded-full bg-foreground" />
        </span>
      </div>
      <button type="button" onClick={onDown} aria-label={downLabel} className={btn}><ChevronDown size={18} /></button>
    </div>
  );
}

// Taps first, wheel optional: the ∧/∨ buttons alone can reach every value, which
// is what shaky hands need, and the number doubles as a wheel for anyone who
// would rather flick through an hour. Renders identically everywhere, unlike
// <input type="time">, which collapses to a cramped spinner on desktop.
function TimeEditor({ initial, onCancel, onSave }: {
  initial: string; onCancel: () => void; onSave: (hhmm: string) => void;
}) {
  const { language } = useLanguage();
  const { timeFormat } = useAccessibility();
  const is24h = timeFormat === "24h";
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  // In 24h there is no AM/PM to flip, so the hour has to run 0–23 and carry the
  // half-day itself — stepping past 23 wraps to 0, and past 11 flips to PM.
  const stepHour = (by: number) => setDraft(d => {
    if (!is24h) return { ...d, h12: ((d.h12 - 1 + by + 12) % 12) + 1 };
    const h24 = (fromDraft(d).split(":").map(Number)[0] + by + 24) % 24;
    return { ...d, h12: h24 % 12 === 0 ? 12 : h24 % 12, pm: h24 >= 12 };
  });
  // Functional update, like stepHour: a drag fires this several times in one
  // tick, and reading `draft` from the closure made every call after the first
  // one a no-op — the wheel moved a single minute however far you pulled it.
  const stepMin = (by: number) => setDraft(d => ({ ...d, min: (d.min + by * MINUTE_STEP + 60) % 60 }));
  const hourText = is24h ? fromDraft(draft).split(":")[0] : String(draft.h12);

  return (
    <div className="rounded-xl border border-primary/30 bg-card p-3">
      {/* Without an AM/PM column the two wheels centre on their own, so the row
          stays balanced instead of sitting off to the left. */}
      <div className="flex items-center justify-center gap-3 mb-3">
        <Stepper
          value={hourText}
          onUp={() => stepHour(1)}
          onDown={() => stepHour(-1)}
          upLabel={t(language, "times.hourUp")}
          downLabel={t(language, "times.hourDown")}
          wheelLabel={t(language, "times.hourWheel")}
        />
        <span className="text-2xl font-semibold text-muted-foreground pb-1">:</span>
        <Stepper
          value={String(draft.min).padStart(2, "0")}
          onUp={() => stepMin(1)}
          onDown={() => stepMin(-1)}
          upLabel={t(language, "times.minuteUp")}
          downLabel={t(language, "times.minuteDown")}
          wheelLabel={t(language, "times.minuteWheel")}
        />
        {!is24h && (
          <div className="flex flex-col gap-1.5 ml-1">
            {[false, true].map(pm => (
              <button
                key={String(pm)}
                type="button"
                onClick={() => set({ pm })}
                aria-pressed={draft.pm === pm}
                className={`w-14 h-9 rounded-xl border text-sm font-bold transition-colors ${draft.pm === pm ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
              >
                {pm ? "PM" : "AM"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 h-10 rounded-xl border border-border text-muted-foreground text-sm font-semibold">
          {t(language, "common.cancel")}
        </button>
        <button type="button" onClick={() => onSave(fromDraft(draft))} className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center gap-1.5">
          <Check size={15} />{t(language, "common.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * A single time, set with the same stepper as the medication times — for the
 * one-off clock answers (meal times, bedtime). Value in and out is 24h "HH:MM",
 * which is what `ProfileDetails.mealTimes` stores.
 */
export function TimeField({ value, onChange, label, icon, "data-walk": dataWalk, walkEvent }: {
  value: string;
  onChange: (hhmm: string) => void;
  label: string;
  icon?: ReactNode;
  "data-walk"?: string;
  // Emitted on lib/walkthrough/bus.ts only when Save actually commits a
  // different value — a tap on the ∧/∨ steppers alone only mutates the
  // editor's local draft, so it can't be the signal a "value-change" wait_for
  // step waits on (see components/Walkthrough.tsx / lib/walkthrough/types.ts).
  walkEvent?: string;
}) {
  const { language } = useLanguage();
  const { timeFormat } = useAccessibility();
  const [open, setOpen] = useState(false);
  const hhmm = toHHMM(value);
  return (
    <div data-walk={dataWalk}>
      <label className="block text-xs font-semibold text-foreground mb-1.5">{label}</label>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${open ? "bg-secondary border-primary" : "bg-input-background border-border"}`}
      >
        <span className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          {icon ?? <Clock size={15} className="text-primary" />}
        </span>
        <span className="flex-1 text-base font-semibold text-foreground">{formatClock(hhmm, timeFormat)}</span>
        <span className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{t(language, "times.change")}</span>
      </button>
      {open && (
        <div className="mt-2">
          <TimeEditor
            initial={hhmm}
            onCancel={() => setOpen(false)}
            onSave={v => {
              onChange(v);
              setOpen(false);
              if (walkEvent && v !== hhmm) emitWalkthroughEvent(walkEvent);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Shared time picker for every "when do you take this?" surface: quick chips for
 * the common routine slots, plus one row per time that expands into a stepper
 * editor when tapped. "Add another time" opens the same editor on a free slot,
 * so any time can be entered, not only the presets.
 *
 * Values in and out are the app's 12h display strings (`Medication.times`).
 */
export function TimesPicker({ times, onChange, label, routine, "data-walk": dataWalk, walkEvent }: {
  times: string[];
  onChange: (times: string[]) => void;
  label?: string;
  routine?: RoutineTimes;
  "data-walk"?: string;
  // Emitted on every real commit (quick-chip toggle, an editor Save, a remove)
  // — never on merely opening/closing the editor. See TimeField's walkEvent.
  walkEvent?: string;
}) {
  const { language } = useLanguage();
  const { timeFormat } = useAccessibility();
  // Which row is open in the editor: an index, "new" while adding, or null.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const slots = normalize(times);
  const quick = slotsFor(routine);
  const commit = (next: string[]) => {
    onChange(normalize(next).map(to12h));
    if (walkEvent) emitWalkthroughEvent(walkEvent);
  };

  const toggle = (hhmm: string) => {
    commit(slots.includes(hhmm) ? slots.filter(s => s !== hhmm) : [...slots, hhmm]);
    setEditing(null);
  };
  const saveAt = (i: number, hhmm: string) => {
    commit(slots.map((s, j) => (j === i ? hhmm : s)));
    setEditing(null);
  };
  const removeAt = (i: number) => {
    commit(slots.filter((_, j) => j !== i));
    setEditing(null);
  };
  // Seed the "add" editor with the first routine slot not already taken, so the
  // common case is one tap of Save and the uncommon case starts somewhere sane.
  const seedForNew = () =>
    quick.map(s => s.hhmm).find(s => !slots.includes(s)) ?? "12:00";

  return (
    <div data-walk={dataWalk}>
      <label className="block text-xs font-semibold text-foreground mb-2">{label ?? t(language, "times.label")}</label>

      <div className="grid grid-cols-4 gap-2 mb-3">
        {quick.map(({ key, labelKey, Icon, hhmm }) => {
          const on = slots.includes(hhmm);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(hhmm)}
              aria-pressed={on}
              className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 transition-colors ${on ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
            >
              <Icon size={16} />
              <span className="text-[calc(11px*var(--dw-text,1))] font-semibold leading-tight">{t(language, labelKey)}</span>
              <span className={`text-[calc(10px*var(--dw-text,1))] leading-tight ${on ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{formatClock(hhmm, timeFormat)}</span>
            </button>
          );
        })}
      </div>

      {slots.length > 0 && (
        <div className="space-y-2 mb-2">
          {slots.map((hhmm, i) => (
            <div key={`${hhmm}-${i}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(editing === i ? null : i)}
                  className={`flex-1 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${editing === i ? "bg-secondary border-primary" : "bg-input-background border-border"}`}
                >
                  <Clock size={15} className="text-primary shrink-0" />
                  <span className="flex-1 text-base font-semibold text-foreground">{formatClock(hhmm, timeFormat)}</span>
                  <span className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{t(language, "times.change")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  aria-label={t(language, "times.remove")}
                  className="shrink-0 w-9 h-9 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X size={15} />
                </button>
              </div>
              {editing === i && (
                <TimeEditor initial={hhmm} onCancel={() => setEditing(null)} onSave={v => saveAt(i, v)} />
              )}
            </div>
          ))}
        </div>
      )}

      {editing === "new" ? (
        <TimeEditor
          initial={seedForNew()}
          onCancel={() => setEditing(null)}
          onSave={v => { commit([...slots, v]); setEditing(null); }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="w-full h-11 rounded-xl border-2 border-dashed border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
        >
          <Plus size={15} />{t(language, "times.addAnother")}
        </button>
      )}

      {slots.length === 0 && editing !== "new" && (
        <p className="text-[calc(11px*var(--dw-text,1))] text-destructive mt-1.5">{t(language, "times.needOne")}</p>
      )}
    </div>
  );
}

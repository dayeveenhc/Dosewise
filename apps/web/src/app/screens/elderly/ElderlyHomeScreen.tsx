import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { RefreshCw, CheckCircle2, ChevronLeft, ChevronRight, Clock, AlertTriangle, Check, LocateFixed, X, Plane, ArrowUp, ArrowDown, RotateCcw } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient, Medication, MedStatus } from "../../types";
import { MED_SIMPLE, MED_SHAPES, MEAL_TIMES } from "../../data/medications";
import { medPhoto } from "../../components/shared";
import { TimeField } from "../../components/TimesPicker";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useLanguage } from "../../lib/languageContext";
import { t, localizeMedText } from "../../lib/language";

// --- timeline window: morning (6 AM) to night (11 PM) ----------------------
// One row per hour, in normal document flow rather than pixel-per-minute
// proportional positioning — an hour with doses takes exactly the space its
// cards need, an hour with none collapses to a thin label row. A fixed
// px-per-hour scale can't do both at once: sized to fit real card heights it
// wastes huge stretches of empty scroll on quiet hours; sized to be compact
// it has to keep borrowing space from later hours to avoid overlapping
// cards, dragging doses away from their true time the busier the day gets.
const START_HOUR = 6;
const END_HOUR = 23;
const HOURS = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i);
const LIST_BOTTOM_PAD = 64;                // clears the floating Now / next-dose
                                           // pills that hover over the timeline

// DEMO ONLY: pretend "now" is this clock time so missed/upcoming states are
// visible regardless of the real clock. Set to null to use the real time.
const DEMO_NOW: string | null = null;

// Parse a "7:00 AM" clock string to minutes-since-midnight, or null if it isn't
// a concrete clock time.
function clockToMinutes(clock: string): number | null {
  const m = clock.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mm = Number(m[2]);
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return h * 60 + mm;
}

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
}

// Resolve a dose's time to a concrete clock time. Concrete times pass through;
// vague / meal-relative ones ("after breakfast") fall back to the caregiver /
// national-average meal times in MEAL_TIMES.
function resolveDose(m: Medication): { minutes: number; clock: string; vague: boolean; note?: string } {
  const direct = clockToMinutes(m.time);
  if (direct !== null) return { minutes: direct, clock: m.time, vague: false };
  const hay = `${m.time} ${MED_SIMPLE[m.name] ?? ""}`.toLowerCase();
  const key = Object.keys(MEAL_TIMES).sort((a, b) => b.length - a.length).find(k => hay.includes(k));
  const clock = key ? MEAL_TIMES[key] : "12:00 PM";
  return { minutes: clockToMinutes(clock)!, clock, vague: true, note: m.time };
}

// Real clock, or the DEMO_NOW override pinned onto today's date.
function makeNow(): Date {
  const mins = DEMO_NOW ? clockToMinutes(DEMO_NOW) : null;
  if (mins == null) return new Date();
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

const to24hInput = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const input24hTo12h = (v: string) => {
  const [hh, mm] = v.split(":").map(Number);
  return minutesToClock(hh * 60 + mm);
};


export function ElderlyHomeScreen({ patient, onLogDose, onUnlogDose, onOpenTravel, justAddedMed }: {
  patient: Patient;
  onLogDose: (id: number, takenAt?: string) => void;
  onUnlogDose: (id: number) => void;
  onOpenTravel: () => void;
  justAddedMed?: string | null;
}) {
  const { colourBlind } = useAccessibility();
  const { language } = useLanguage();
  const [now, setNow] = useState(makeNow());
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());
  const [confirmedId, setConfirmedId] = useState<number | null>(null);
  const [toastKind, setToastKind] = useState<"taken" | "undone">("taken");
  const [toastVisible, setToastVisible] = useState(false);
  const [pendingDose, setPendingDose] = useState<Medication | null>(null);
  const [pendingUndo, setPendingUndo] = useState<Medication | null>(null);
  const [takenInput, setTakenInput] = useState("");
  const [showJump, setShowJump] = useState(false);
  // Which way the next dose's card lies when it is off-screen ("up" once it has
  // scrolled above the fold, "down" while it is still below) — null whenever the
  // card is actually visible, since then the card itself is the indicator.
  const [nextOff, setNextOff] = useState<"up" | "down" | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Live DOM node per dose card, in render (i.e. chronological) order, so the
  // off-screen counts can be measured against real layout.
  const cardRefs = useRef<Map<number, HTMLElement>>(new Map());
  // Tracks which day we've already snap-scrolled for, so the snap fires once per
  // day (on mount / day change) and never re-yanks the user back to "now" when
  // hourRows rebuilds each minute as the clock ticks.
  const scrolledForDayRef = useRef<string>("");
  // DOM node for the "now" divider row — used to scroll-to-now against real
  // layout instead of a pixel formula, since hour rows are no longer
  // time-scaled (which is also what makes overlap between cards impossible).
  const nowRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(makeNow()), 30000);
    return () => clearInterval(id);
  }, []);

  const today = now;
  const isToday = (d: Date) => d.toDateString() === today.toDateString();
  const isPast = (d: Date) => d < today && !isToday(d);
  const isFuture = (d: Date) => d > today && !isToday(d);
  const isSelectedToday = isToday(selectedDay);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowInWindow = nowMinutes >= START_HOUR * 60 && nowMinutes <= END_HOUR * 60;

  // --- status for the selected day -----------------------------------------
  // On today, derive the status from the real clock: a dose already logged stays
  // "taken"; anything still ahead of now is "upcoming" (coming up); anything whose
  // time has passed without being taken is "missed".
  const statusForDay = (m: Medication, day: Date): MedStatus => {
    if (isToday(day)) {
      if (m.status === "taken") return "taken";
      return resolveDose(m).minutes > nowMinutes ? "upcoming" : "missed";
    }
    if (isPast(day)) return (day.getDate() * 3 + m.id) % 10 > 2 ? "taken" : "missed";
    return "upcoming";
  };

  const dayMeds = patient.medications.map(m => ({ ...m, status: statusForDay(m, selectedDay) as MedStatus }));
  const takenCount = dayMeds.filter(m => m.status === "taken").length;
  const total = patient.medications.length;
  const refillAlerts = patient.medications.filter(m => m.refillDaysLeft !== undefined && m.refillDaysLeft <= 5);
  const nextMedId = isSelectedToday ? dayMeds.find(m => m.status === "upcoming")?.id : undefined;

  // --- group meds by resolved time slot ------------------------------------
  const slots = useMemo(() => {
    const byMinute = new Map<number, { minutes: number; clock: string; vague: boolean; note?: string; meds: (Medication & { status: MedStatus })[] }>();
    for (const m of dayMeds) {
      const r = resolveDose(m);
      const g = byMinute.get(r.minutes) ?? { minutes: r.minutes, clock: r.clock, vague: r.vague, note: r.note, meds: [] };
      g.meds.push(m);
      byMinute.set(r.minutes, g);
    }
    return [...byMinute.values()].sort((a, b) => a.minutes - b.minutes);
  }, [dayMeds]);


  // The dose that's genuinely next by the clock. `nextMedId` above follows the
  // medication list's own order, which is only incidentally chronological — the
  // floating indicator has to point at the real next one.
  const nextDose = useMemo(() => {
    if (!isSelectedToday) return null;
    const upcoming = dayMeds.filter(m => m.status === "upcoming");
    if (!upcoming.length) return null;
    return upcoming.reduce((a, b) => (resolveDose(a).minutes <= resolveDose(b).minutes ? a : b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayMeds, isSelectedToday]);

  // --- one row per hour, sized to whatever it actually contains -------------
  // Slots bucketed by hour; an hour with no doses renders as a thin label
  // row instead of a big empty stretch, and an hour with several doses grows
  // to fit them — no fixed px-per-hour scale to fight with either way.
  const hourRows = useMemo(() => {
    const byHour = new Map<number, typeof slots>();
    for (const slot of slots) {
      const hr = Math.floor(slot.minutes / 60);
      (byHour.get(hr) ?? byHour.set(hr, []).get(hr)!).push(slot);
    }
    const currentHour = Math.floor(nowMinutes / 60);
    return HOURS.map(hour => ({
      hour,
      slots: byHour.get(hour) ?? [],
      showNow: isSelectedToday && nowInWindow && hour === currentHour,
    }));
  }, [slots, nowMinutes, isSelectedToday, nowInWindow]);

  // --- scroll: snap to now on load / day change ----------------------------
  const jumpToNow = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    const target = nowRowRef.current;
    if (!el) return;
    if (!target) { el.scrollTo({ top: 0, behavior }); return; }
    el.scrollTo({ top: Math.max(0, target.offsetTop - el.clientHeight * 0.35), behavior });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Snap once per day: skip if we've already snapped for this selected day, so a
    // minute-tick rebuild of hourRows can't drag the view back to "now" mid-scroll.
    const dayKey = selectedDay.toDateString();
    if (scrolledForDayRef.current === dayKey) return;
    scrolledForDayRef.current = dayKey;
    if (isSelectedToday) jumpToNow("auto");
    else el.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDay, hourRows]);

  // Measures which still-to-take cards are outside the visible slice of the
  // timeline. Runs against real geometry rather than the model, because "is it
  // on screen" is a layout question the data can't answer.
  const measureView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const node = nextDose ? cardRefs.current.get(nextDose.id) : undefined;
    if (!node || !node.isConnected) {
      setNextOff(null);
    } else {
      const r = node.getBoundingClientRect();
      setNextOff(r.bottom < box.top + 8 ? "up" : r.top > box.bottom - 8 ? "down" : null);
    }
    const target = nowRowRef.current;
    if (!isSelectedToday || !target) { setShowJump(false); return; }
    const nowTop = target.offsetTop - el.clientHeight * 0.35;
    setShowJump(Math.abs(el.scrollTop - Math.max(0, nowTop)) > 120);
  }, [nextDose, isSelectedToday]);

  useEffect(() => {
    const id = requestAnimationFrame(measureView);
    return () => cancelAnimationFrame(id);
  }, [measureView, hourRows]);

  const scrollToNextDose = () => {
    if (!nextDose) return;
    cardRefs.current.get(nextDose.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // --- dose logging via the time-adjust popup ------------------------------
  const flashToast = (kind: "taken" | "undone", id: number) => {
    setToastKind(kind);
    setConfirmedId(id);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 1600); // start fade
    setTimeout(() => setConfirmedId(null), 2100);   // unmount after the fade finishes
  };

  const openTakeDialog = (m: Medication) => {
    setTakenInput(to24hInput(new Date()));
    setPendingDose(m);
  };
  const confirmTake = () => {
    if (!pendingDose) return;
    onLogDose(pendingDose.id, input24hTo12h(takenInput));
    flashToast("taken", pendingDose.id);
    setPendingDose(null);
  };
  const confirmUndo = () => {
    if (!pendingUndo) return;
    onUnlogDose(pendingUndo.id);
    flashToast("undone", pendingUndo.id);
    setPendingUndo(null);
  };

  const changeDay = (delta: number) => {
    const d = new Date(selectedDay);
    d.setDate(d.getDate() + delta);
    setSelectedDay(d);
  };

  const registerCard = (id: number) => (node: HTMLElement | null) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  };

  // --- one medication card -------------------------------------------------
  // Three deliberately distinct treatments, unchanged in meaning from before:
  // the next dose leads (saturated pine), a missed one alarms (orange, outside
  // the brand ramp), everything else sits quiet. A taken dose recedes furthest
  // — and is the only one that offers Undo.
  const renderCard = (m: Medication & { status: MedStatus }, vague: boolean, note?: string) => {
    const isNext = m.id === nextMedId && confirmedId === null;
    const isTaken = m.status === "taken";
    const isMissed = m.status === "missed";
    const photo = medPhoto(m.name);
    const direction = MED_SIMPLE[m.name] ?? t(language, "home.takeAsDirected");
    const shape = MED_SHAPES[m.name];
    const clock = resolveDose(m).clock;

    if (isTaken) {
      return (
        <div
          key={m.id}
          ref={registerCard(m.id)}
          data-testid={m.medicationId ? `medication-${m.medicationId}` : undefined}
          className="rounded-[20px] border border-taken-border bg-taken-bg/70 px-3.5 py-3"
        >
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[15px] font-bold tracking-tight text-taken-fg/70 whitespace-nowrap shrink-0">{clock}</span>
            <CheckCircle2 size={19} className="text-taken ml-auto shrink-0" />
          </div>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl overflow-hidden shrink-0 bg-muted">
              <img src={photo} alt="" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-bold text-taken-fg/70 line-through leading-snug truncate">{m.name}</p>
              <p className="text-[13px] text-muted-foreground">{m.takenAt ? t(language, "home.takenAt", { time: m.takenAt }) : t(language, "common.taken")}</p>
              {colourBlind && shape && <p className="text-[13px] text-muted-foreground">{shape.shape} · {shape.marking}</p>}
            </div>
          </div>
          {isSelectedToday && (
            <button
              onClick={() => setPendingUndo(m)}
              data-walk="elder-undo-dose"
              className="mt-2 w-full h-10 rounded-xl border border-taken-border bg-card text-[14px] font-bold text-taken-fg flex items-center justify-center gap-2 active:bg-taken-bg transition-colors"
            >
              <RotateCcw size={16} />{t(language, "home.undo")}
            </button>
          )}
        </div>
      );
    }

    const justAdded = !!justAddedMed && m.name === justAddedMed;
    const cardCls = justAdded ? "border-2 border-taken bg-taken-bg dw-shadow ring-2 ring-taken/40"
                  : isNext ? "border-2 border-upcoming-border bg-upcoming-bg dw-shadow"
                  : isMissed ? "border-2 border-missed-border bg-missed-bg dw-shadow"
                  : "border border-border bg-card dw-shadow";
    const timeCls = isNext ? "text-primary" : isMissed ? "text-missed-fg" : "text-muted-foreground";

    return (
      <div
        key={m.id}
        ref={registerCard(m.id)}
        data-testid={m.medicationId ? `medication-${m.medicationId}` : undefined}
        className={`rounded-[20px] overflow-hidden ${cardCls}`}
      >
        <div className="px-4 pt-3 pb-3.5">
          {/* Time and status badges get their own full-width strip. They used to
              share the name's row, which — once the timeline's hour gutter is
              subtracted — left barely 70px for the name and broke single words
              like "Amlodipine" across three lines. */}
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-[16px] font-bold tracking-tight whitespace-nowrap ${timeCls}`}>{clock}</span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {justAdded && (
                <span className="flex items-center gap-1 bg-taken-bg text-taken-fg border border-taken-border text-[12px] font-bold px-2 py-0.5 rounded-full">
                  <Check size={11} strokeWidth={3} />{t(language, "prescription.justAdded")}
                </span>
              )}
              {isMissed && (
                <span className="flex items-center gap-1 bg-card text-missed-fg border border-missed-border text-[12px] font-bold px-2 py-0.5 rounded-full">
                  <AlertTriangle size={11} />{t(language, "common.missed")}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-[52px] h-[52px] rounded-xl overflow-hidden shrink-0 bg-muted">
              <img src={photo} alt="" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-[17px] text-foreground leading-tight truncate">{m.name}</p>
              <p className="text-[14px] text-muted-foreground mt-1 leading-snug">{localizeMedText(language, m.name, "simple", direction)}</p>
              {vague && <p className="text-[13px] text-primary mt-1">🕒 {t(language, "home.vagueTimeNote", { note: note ?? "", clock: minutesToClock(resolveDose(m).minutes) })}</p>}
              {colourBlind && shape && <p className="text-[13px] text-muted-foreground mt-1">{shape.shape} · {shape.marking}</p>}
            </div>
          </div>
        </div>

        {isSelectedToday && (isNext || isMissed) ? (
          <button
            onClick={() => openTakeDialog(m)}
            data-walk="elder-take-dose"
            className={`w-full flex items-center justify-center gap-2.5 py-3 border-t font-bold text-[16px] active:opacity-80 transition-opacity ${
              isNext ? "border-upcoming-border/40 bg-primary/10 text-primary" : "border-missed-border bg-missed/10 text-missed-fg"
            }`}
          >
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${isNext ? "border-primary" : "border-missed-fg"}`}>
              <Check size={13} strokeWidth={3} className={isNext ? "text-primary" : "text-missed-fg"} />
            </div>
            {t(language, "home.iTookIt")}
          </button>
        ) : (
          <div className="w-full flex items-center justify-center gap-2 py-2.5 border-t border-border/40">
            <Clock size={14} className="text-muted-foreground" />
            <p className="text-[14px] text-muted-foreground font-medium">{isFuture(selectedDay) ? t(language, "home.scheduled") : t(language, "home.comingUp")}</p>
          </div>
        )}
      </div>
    );
  };

  const travelPlan = patient.travelPlan;
  // Still show the banner through the last day of the trip, not just before it starts.
  const travelActive = travelPlan && new Date(`${travelPlan.endDate}T23:59:59`) >= new Date();
  const formatTravelDate = (d: string) => new Date(d).toLocaleDateString("en-SG", { day: "numeric", month: "short" });


  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      {/* Travel Mode indicator — display only; the schedule below still runs on
          local time, it doesn't actually shift to the destination timezone. */}
      {travelActive && travelPlan && (
        <button
          onClick={onOpenTravel}
          className="mx-4 mt-3 shrink-0 flex flex-col items-center gap-0.5 bg-secondary border border-primary/20 rounded-xl px-3 py-2 text-center active:opacity-80 transition-opacity"
        >
          <p className="flex items-center gap-1.5 text-[14px] font-bold text-primary">
            <Plane size={15} className="shrink-0" />
            {t(language, "common.travelMode")} · {formatTravelDate(travelPlan.startDate)}–{formatTravelDate(travelPlan.endDate)}
          </p>
          <p className="text-[12px] text-secondary-foreground/80">{t(language, "home.timesShownIn", { tz: travelPlan.timezone })}</p>
        </button>
      )}

      {/* Day navigation — single day with arrows (no week strip) */}
      {/* Date leads at the top-left with the weekday beside it; the day controls
          sit opposite at the top-right, and the progress line closes the block.
          One consistent 12px rhythm throughout — the earlier mix of 8/10px gaps
          read as accidental. */}
      <div className="px-4 pt-3 pb-3 shrink-0 relative z-20 bg-background" data-walk="elder-day-nav">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className={`dw-display text-[23px] font-semibold leading-none whitespace-nowrap ${isSelectedToday ? "text-primary" : "text-foreground"}`}>
              {selectedDay.toLocaleDateString("en-SG", { day: "numeric", month: "long" })}
            </h2>
            <p className="text-[14px] text-muted-foreground leading-none truncate">
              {selectedDay.toLocaleDateString("en-SG", { weekday: "long" })}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!isSelectedToday && (
              <button onClick={() => setSelectedDay(new Date())} className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-[13px] font-bold active:opacity-80 transition-opacity">
                {t(language, "home.today")}
              </button>
            )}
            <button onClick={() => changeDay(-1)} aria-label={t(language, "common.back")} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
              <ChevronLeft size={18} className="text-foreground" />
            </button>
            <button onClick={() => changeDay(1)} aria-label={t(language, "home.scheduled")} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
              <ChevronRight size={18} className="text-foreground" />
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-taken rounded-full transition-all duration-500" style={{ width: `${total ? (takenCount / total) * 100 : 0}%` }} />
          </div>
          <p className="text-[12px] font-semibold text-muted-foreground shrink-0 tabular-nums">{takenCount}/{total} {t(language, "home.taken")}</p>
        </div>
      </div>


      {/* Refill reminder */}
      {refillAlerts.length > 0 && (
        <div className="mx-4 mb-3 bg-warn-bg border border-warn-border rounded-xl px-3.5 py-2.5 shrink-0 relative z-20">
          <div className="flex items-center gap-2">
            <RefreshCw size={16} className="text-warn shrink-0" />
            <p className="text-[14px] font-bold text-warn-fg">{t(language, "home.refillNeeded")}</p>
            <p className="text-[13px] text-warn-fg/80 ml-auto font-medium truncate">{refillAlerts.map(m => m.name).join(", ")}</p>
          </div>
        </div>
      )}

      {/* Timeline — one row per hour, height set by whatever it contains: a
          quiet hour is just its label and a hairline, a busy hour grows to
          fit its cards. Normal document flow throughout, so cards can never
          overlap and every dose sits under its true hour. */}
      <div className="relative flex-1 min-h-0 flex flex-col border-t border-border/60">
        <div ref={scrollRef} data-tour="elder-schedule" onScroll={measureView} className="flex-1 overflow-y-auto scrollbar-none">
          <div className="flex flex-col px-4 pt-2" style={{ paddingBottom: LIST_BOTTOM_PAD }}>
            {hourRows.map(row => (
              <div key={row.hour} className="flex gap-3 py-2 border-b border-border/25 last:border-0">
                {/* Narrow on purpose — every px here comes straight out of the
                    dose card's usable width (see the card header comment). */}
                <div className="w-12 shrink-0 pt-0.5">
                  <span className="text-[12px] font-semibold text-muted-foreground/55 font-mono whitespace-nowrap tracking-tight">
                    {minutesToClock(row.hour * 60).replace(":00", "")}
                  </span>
                </div>
                <div ref={row.showNow ? nowRowRef : undefined} className="flex-1 min-w-0 flex flex-col gap-2">
                  {row.showNow && (
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-[13px] font-bold text-white bg-destructive rounded-full px-2.5 py-1 leading-none">
                        {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true })}
                      </span>
                      <div className="flex-1 h-1 bg-destructive/80 rounded-full" />
                    </div>
                  )}
                  {row.slots.map(slot => (
                    <div key={slot.minutes} className="flex flex-col gap-2">
                      {slot.meds.map(m => renderCard(m, slot.vague, slot.note))}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {slots.length === 0 && (
              <div className="text-center text-[15px] text-muted-foreground pt-8">{t(language, "home.noSchedule")}</div>
            )}
          </div>
        </div>

        {/* Off-screen awareness: a dose card being scrolled out of view must
            never look the same as having nothing left to do. */}
        {/* Points at the next dose and follows it: below the fold it sits at the
            bottom pointing down, and once you have scrolled past it, it moves to
            the top and points back up. Hidden while the card is on screen. */}
        {nextDose && nextOff && (
          <button
            onClick={scrollToNextDose}
            data-testid={`next-dose-${nextOff}`}
            className={`absolute ${nextOff === "up" ? "top-3" : "bottom-4"} left-4 z-30 flex items-center gap-2 bg-card border border-border text-foreground rounded-full pl-3 pr-4 py-2.5 dw-float dw-press transition-transform`}
          >
            {nextOff === "up" ? <ArrowUp size={16} className="text-primary" /> : <ArrowDown size={16} className="text-primary" />}
            <span className="text-[14px] font-bold whitespace-nowrap">{t(language, "home.offscreenBelow", { clock: resolveDose(nextDose).clock })}</span>
          </button>
        )}
        {isSelectedToday && showJump && (
          <button
            onClick={() => jumpToNow("smooth")}
            className="absolute bottom-4 right-4 z-30 flex items-center gap-2 bg-primary text-primary-foreground rounded-full pl-3.5 pr-4 py-2.5 dw-float dw-press transition-transform"
          >
            <LocateFixed size={19} />
            <span className="text-[16px] font-bold">{t(language, "home.now")}</span>
          </button>
        )}
      </div>

      {/* Confirmation toast — centred, fades out rather than vanishing abruptly */}
      {confirmedId !== null && (
        <div className={`absolute inset-0 z-40 flex items-center justify-center pointer-events-none transition-opacity duration-500 ${toastVisible ? "opacity-100" : "opacity-0"}`}>
          <div className={`text-white rounded-[20px] px-6 py-5 flex items-center gap-3 dw-float ${toastKind === "taken" ? "bg-primary" : "bg-accent"}`}>
            {toastKind === "taken" ? <CheckCircle2 size={24} /> : <RotateCcw size={24} />}
            <p className="font-bold text-[16px]">{t(language, toastKind === "taken" ? "home.recorded" : "home.undone")}</p>
          </div>
        </div>
      )}

      {/* "I Took It" — adjust time popup */}
      {pendingDose && (
        <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setPendingDose(null)}>
          <div className="w-full bg-background rounded-t-3xl p-5 pb-7 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-['Fraunces'] text-[20px] font-semibold text-foreground">{t(language, "home.markTaken")}</h3>
              <button onClick={() => setPendingDose(null)} aria-label={t(language, "common.cancel")} className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <X size={20} className="text-muted-foreground" />
              </button>
            </div>

            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted shrink-0">
                <img src={medPhoto(pendingDose.name)} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="min-w-0">
                <p className="font-bold text-[17px] text-foreground break-words">{pendingDose.name}</p>
                <p className="text-[14px] text-muted-foreground">{t(language, "home.scheduledFor", { clock: resolveDose(pendingDose).clock })}</p>
              </div>
            </div>

            {/* Tap-only stepper, never <input type="time"> — see MEMORY.md: the
                native control collapses to a cramped spinner on desktop, which
                is exactly how this phone-frame demo is viewed. */}
            <TimeField label={t(language, "home.whatTime")} value={takenInput} onChange={setTakenInput} icon={<Clock size={16} className="text-primary" />} />
            <button onClick={() => setTakenInput(to24hInput(new Date()))} className="mt-2 w-full h-11 rounded-xl bg-muted text-[15px] font-bold text-foreground active:opacity-80 transition-opacity">
              {t(language, "home.justNow")}
            </button>
            <p className="text-[13px] text-muted-foreground mt-2 mb-5">{t(language, "home.willLogAs", { time: takenInput ? input24hTo12h(takenInput) : "—" })}</p>

            <button onClick={confirmTake} data-walk="elder-take-confirm" className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground text-[17px] font-bold active:scale-[0.98] transition-transform flex items-center justify-center gap-2">
              <Check size={18} strokeWidth={3} />{t(language, "home.confirm")}
            </button>
          </div>
        </div>
      )}

      {/* Undo a logged dose — always confirmed, since it rewrites a real record. */}
      {pendingUndo && (
        <ConfirmDialog
          title={t(language, "home.undoTitle")}
          body={t(language, "home.undoBody", { name: pendingUndo.name, time: pendingUndo.takenAt ?? resolveDose(pendingUndo).clock })}
          confirmLabel={t(language, "home.undoConfirm")}
          onConfirm={confirmUndo}
          onCancel={() => setPendingUndo(null)}
        />
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { RefreshCw, CheckCircle2, ChevronLeft, ChevronRight, Clock, AlertTriangle, Check, LocateFixed, X, Plane, ArrowUp, ArrowDown, RotateCcw, HelpCircle, Sparkles } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient, Medication, MedStatus } from "../../types";
import { MED_SIMPLE, MED_SHAPES, MEAL_TIMES } from "../../data/medications";
import { medPhoto } from "../../components/shared";
import { TimeField } from "../../components/TimesPicker";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { BottomSheet } from "../../components/BottomSheet";
import { useLanguage } from "../../lib/languageContext";
import { t, localizeMedText } from "../../lib/language";
import { formatClock, formatClockAt, lowSupplyMedications } from "../../lib/medications";

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
// How close to the clock a dose has to be before it is treated as actionable:
// highlighted, and offering "I took it". An hour either side covers "just about
// to", "right now" and "you're a bit late" without ever being the whole day.
const DUE_WINDOW_MIN = 60;
const LIST_BOTTOM_PAD = 64;                // clears the floating Now / next-dose
                                           // pills that hover over the timeline

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

const to24hInput = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;


export function ElderlyHomeScreen({ patient, onLogDose, onUnlogDose, onOpenTravel, justAddedMed, onAskMei }: {
  patient: Patient;
  onLogDose: (id: number, takenAt?: string) => void;
  onUnlogDose: (id: number) => void;
  onOpenTravel: () => void;
  justAddedMed?: string | null;
  // Opens Ask Mei with a question already typed in (never sent — the elder
  // still taps Send). Optional so the screen keeps working without a host.
  onAskMei?: (prefill: string) => void;
}) {
  const { colourBlind, timeFormat } = useAccessibility();
  const { language } = useLanguage();
  const [now, setNow] = useState(() => new Date());
  const [showMissedHelp, setShowMissedHelp] = useState(false);
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
  // DOM node for the now LINE itself — not the hour row that contains it. The
  // line sits between that hour's cards, so the row's top can be a long way
  // above it; scrolling to the row put "now" off screen on a busy hour.
  const nowLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  const today = now;
  const isToday = (d: Date) => d.toDateString() === today.toDateString();
  const isPast = (d: Date) => d < today && !isToday(d);
  const isFuture = (d: Date) => d > today && !isToday(d);
  const isSelectedToday = isToday(selectedDay);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  // The one test for "already gone by", shared by the dose statuses, where the
  // now line is drawn, and which dose counts as a medicine's next one. A dose at
  // exactly this minute has NOT passed — it is due now. These three used to be
  // three separate comparisons kept in step by a comment, and had already
  // drifted (`>` in one place, `>=` in the others).
  const hasPassed = (minutes: number) => minutes < nowMinutes;

  // --- status for the selected day -----------------------------------------
  // On today, derive the status from the real clock: a dose already logged stays
  // "taken"; anything still ahead of now is "upcoming" (coming up); anything whose
  // time has passed without being taken is "missed".
  const statusForDay = (m: Medication, day: Date): MedStatus => {
    if (isToday(day)) {
      if (m.status === "taken") return "taken";
      return hasPassed(resolveDose(m).minutes) ? "missed" : "upcoming";
    }
    if (isPast(day)) return (day.getDate() * 3 + m.id) % 10 > 2 ? "taken" : "missed";
    return "upcoming";
  };

  // Memoised because `slots`, `hourRows` and `nextDose` all key on it: a fresh
  // array each render made those three caches miss every time, and left the
  // measure effect below re-subscribing on every render too.
  const dayMeds = useMemo(
    () => patient.medications.map(m => ({ ...m, status: statusForDay(m, selectedDay) as MedStatus })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patient.medications, selectedDay, nowMinutes],
  );
  const takenCount = dayMeds.filter(m => m.status === "taken").length;
  const total = patient.medications.length;
  // The shared rule, so this banner lists exactly the medicines the Medications
  // page marks as low. Its own `refillDaysLeft <= 5` test both double-counted a
  // twice-daily medicine and hid ones that page was already flagging.
  const refillAlerts = useMemo(() => lowSupplyMedications(patient.medications), [patient.medications]);
  const missedMeds = dayMeds.filter(m => m.status === "missed");
  const missedCount = missedMeds.length;

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


  // The dose that's genuinely next by the clock — what the floating indicator
  // points at. Chronological, unlike the medication list's own order.
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
    // The line ALWAYS shows on today. Outside the 6am–11pm window there is no
    // hour row to put it in, so it clamps to the first or last one — pinned to
    // the top before the day starts, to the bottom once it's over — rather than
    // disappearing and leaving the day with no "you are here".
    const currentHour = Math.min(END_HOUR, Math.max(START_HOUR, Math.floor(nowMinutes / 60)));
    return HOURS.map(hour => ({
      hour,
      slots: byHour.get(hour) ?? [],
      showNow: isSelectedToday && hour === currentHour,
    }));
  }, [slots, nowMinutes, isSelectedToday]);

  // What to do about a dose that was missed. Deliberately the standard
  // patient-leaflet rule of thumb and nothing cleverer: take it when you
  // remember, UNLESS the next one is nearly due, in which case skip it and
  // never double up. It is specific per medication only in the way the data
  // genuinely allows — from that medicine's OWN next scheduled time today — and
  // every card says out loud that the doctor's or pharmacist's advice wins.
  const NEXT_DOSE_SOON_MIN = 120;
  const missedAdvice = (m: Medication) => {
    const nextSame = patient.medications
      .filter(o => o.name === m.name && !hasPassed(resolveDose(o).minutes))
      .map(o => resolveDose(o))
      .sort((a, b) => a.minutes - b.minutes)[0];
    const skip = !!nextSame && nextSame.minutes - nowMinutes <= NEXT_DOSE_SOON_MIN;
    return {
      skip,
      dueClock: formatClock(resolveDose(m).clock, timeFormat),
      nextClock: nextSame ? formatClock(nextSame.clock, timeFormat) : undefined,
    };
  };

  // The missed pill points up; tapping it goes there. Earliest missed dose, so
  // it lands at the start of what was skipped rather than the middle of it.
  const jumpToFirstMissed = () => {
    const first = missedMeds.reduce<(typeof missedMeds)[number] | null>(
      (a, b) => (a && resolveDose(a).minutes <= resolveDose(b).minutes ? a : b), null);
    if (first) cardRefs.current.get(first.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // --- scroll: snap to now on load / day change ----------------------------
  // Measured from real geometry rather than offsetTop: offsetTop is relative to
  // the nearest positioned ancestor, which is NOT this scroll container.
  const jumpToNow = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    const target = nowLineRef.current;
    if (!el) return;
    if (!target) { el.scrollTo({ top: 0, behavior }); return; }
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTo({ top: Math.max(0, el.scrollTop + delta - el.clientHeight * 0.35), behavior });
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
    // The button offers to take you somewhere you cannot see. Offering it while
    // the line is already on screen is what made it look broken: you tapped it
    // and the view barely moved.
    const target = nowLineRef.current;
    if (!isSelectedToday || !target) { setShowJump(false); return; }
    const line = target.getBoundingClientRect();
    setShowJump(line.bottom < box.top + 8 || line.top > box.bottom - 8);
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
    onLogDose(pendingDose.id, formatClock(takenInput, "12h"));
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
  // the dose that's DUE NOW leads (saturated pine), a missed one alarms
  // (orange, outside the brand ramp), everything else sits quiet. A taken dose
  // recedes furthest — and is the only one that offers Undo.
  const renderCard = (m: Medication & { status: MedStatus }, vague: boolean, note?: string) => {
    // "Due now" is a WINDOW, not a queue position: a dose an hour either side of
    // the clock. Highlighting the next dose whenever it happened to be next made
    // a 10pm tablet look actionable at breakfast, and offering "I took it" all
    // day invites logging a dose hours before it should be swallowed.
    const dueNow = isSelectedToday && Math.abs(resolveDose(m).minutes - nowMinutes) <= DUE_WINDOW_MIN;
    const isTaken = m.status === "taken";
    const isMissed = m.status === "missed";
    // The pine card is decided by the CLOCK alone, never by list position. It
    // used to also require being the list's first upcoming row, which is only
    // incidentally chronological — so a dose genuinely due in ten minutes could
    // sit there in plain white while another row held the "next" title.
    const isNext = dueNow && !isMissed && confirmedId === null;
    const photo = medPhoto(m.name);
    const direction = MED_SIMPLE[m.name] ?? t(language, "home.takeAsDirected");
    const shape = MED_SHAPES[m.name];
    const clock = formatClock(resolveDose(m).clock, timeFormat);

    if (isTaken) {
      // The whole card is the Undo control now — a done dose doesn't need a
      // button sitting under it all day, and its own scheduled time has stopped
      // mattering: what you want to read back is when it was actually taken.
      const Card = isSelectedToday ? "button" : "div";
      return (
        <Card
          key={m.id}
          ref={registerCard(m.id)}
          data-testid={m.medicationId ? `medication-${m.medicationId}` : undefined}
          onClick={isSelectedToday ? () => setPendingUndo(m) : undefined}
          data-walk={isSelectedToday ? "elder-undo-dose" : undefined}
          aria-label={isSelectedToday ? t(language, "home.undoTitle") : undefined}
          className="w-full text-left rounded-[20px] border border-taken-border bg-taken-bg/70 px-3.5 py-3 active:bg-taken-bg transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl overflow-hidden shrink-0 bg-muted">
              <img src={photo} alt="" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-taken-fg/70 line-through leading-snug truncate">{m.name}</p>
              <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{m.takenAt ? t(language, "home.takenAt", { time: formatClock(m.takenAt, timeFormat) }) : t(language, "common.taken")}</p>
              {colourBlind && shape && <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{shape.shape} · {shape.marking}</p>}
            </div>
            <CheckCircle2 size={19} className="text-taken shrink-0" />
          </div>
        </Card>
      );
    }

    const justAdded = !!justAddedMed && m.name === justAddedMed;
    // The dose that is due right now is a SOLID pine card — the one card on the
    // screen that fills with the brand colour, the way the palette always
    // intended the current dose to read. Everything inside it flips to the
    // light-on-dark pair rather than the usual ink-on-cream.
    const cardCls = justAdded ? "border-2 border-taken bg-taken-bg dw-shadow ring-2 ring-taken/40"
                  : isNext ? "border-2 border-primary bg-primary dw-shadow dw-flow-onpine"
                  : isMissed ? "border-2 border-missed-border bg-missed-bg dw-shadow dw-flow-missed"
                  : "border border-border bg-card dw-shadow";
    const timeCls = isNext ? "text-primary-foreground" : isMissed ? "text-missed-fg" : "text-muted-foreground";

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
            <span className={`text-[calc(16px*var(--dw-text,1))] font-bold tracking-tight whitespace-nowrap ${timeCls}`}>{clock}</span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {justAdded && (
                <span className="flex items-center gap-1 bg-taken-bg text-taken-fg border border-taken-border text-[calc(12px*var(--dw-text,1))] font-bold px-2 py-0.5 rounded-full">
                  <Check size={11} strokeWidth={3} />{t(language, "prescription.justAdded")}
                </span>
              )}
              {isMissed && (
                <span className="flex items-center gap-1 bg-card text-missed-fg border border-missed-border text-[calc(12px*var(--dw-text,1))] font-bold px-2 py-0.5 rounded-full">
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
              <p className={`font-bold text-[calc(17px*var(--dw-text,1))] leading-tight truncate ${isNext ? "text-primary-foreground" : "text-foreground"}`}>{m.name}</p>
              <p className={`text-[calc(14px*var(--dw-text,1))] mt-1 leading-snug ${isNext ? "text-primary-foreground/85" : "text-muted-foreground"}`}>{localizeMedText(language, m.name, "simple", direction)}</p>
              {vague && <p className={`text-[calc(13px*var(--dw-text,1))] mt-1 ${isNext ? "text-primary-foreground/85" : "text-primary"}`}>🕒 {t(language, "home.vagueTimeNote", { note: note ?? "", clock: minutesToClock(resolveDose(m).minutes) })}</p>}
              {colourBlind && shape && <p className={`text-[calc(13px*var(--dw-text,1))] mt-1 ${isNext ? "text-primary-foreground/85" : "text-muted-foreground"}`}>{shape.shape} · {shape.marking}</p>}
            </div>
          </div>
        </div>

        {/* Logging stays available for a missed dose all day — being late is
            exactly when someone needs to record it. Only the pine treatment is
            limited to the due window; the button is not. */}
        {(dueNow || isMissed) && !isTaken ? (
          <button
            onClick={() => openTakeDialog(m)}
            data-walk="elder-take-dose"
            className={`w-full flex items-center justify-center gap-2.5 py-3 border-t font-bold text-[calc(16px*var(--dw-text,1))] active:opacity-80 transition-opacity ${
              isNext ? "border-white/20 bg-white/10 text-primary-foreground" : "border-missed-border bg-missed/10 text-missed-fg"
            }`}
          >
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${isNext ? "border-primary-foreground" : "border-missed-fg"}`}>
              <Check size={13} strokeWidth={3} className={isNext ? "text-primary-foreground" : "text-missed-fg"} />
            </div>
            {t(language, "home.iTookIt")}
          </button>
        ) : (
          <div className="w-full flex items-center justify-center gap-2 py-2.5 border-t border-border/40">
            <Clock size={14} className="text-muted-foreground" />
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground font-medium">
              {isFuture(selectedDay) ? t(language, "home.scheduled")
                : isMissed ? t(language, "common.missed")
                : t(language, "home.comingUp")}
            </p>
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
          <p className="flex items-center gap-1.5 text-[calc(14px*var(--dw-text,1))] font-bold text-primary">
            <Plane size={15} className="shrink-0" />
            {t(language, "common.travelMode")} · {formatTravelDate(travelPlan.startDate)}–{formatTravelDate(travelPlan.endDate)}
          </p>
          <p className="text-[calc(12px*var(--dw-text,1))] text-secondary-foreground/80">{t(language, "home.timesShownIn", { tz: travelPlan.timezone })}</p>
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
            <h2 className={`dw-display text-[calc(23px*var(--dw-text,1))] font-semibold leading-none whitespace-nowrap ${isSelectedToday ? "text-primary" : "text-foreground"}`}>
              {selectedDay.toLocaleDateString("en-SG", { day: "numeric", month: "long" })}
            </h2>
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-none truncate">
              {selectedDay.toLocaleDateString("en-SG", { weekday: "long" })}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!isSelectedToday && (
              <button onClick={() => setSelectedDay(new Date())} className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-[calc(13px*var(--dw-text,1))] font-bold active:opacity-80 transition-opacity">
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
          <p className="text-[calc(12px*var(--dw-text,1))] font-semibold text-muted-foreground shrink-0 tabular-nums">{takenCount}/{total} {t(language, "home.taken")}</p>
        </div>
      </div>


      {/* Refill reminder */}
      {refillAlerts.length > 0 && (
        <div className="mx-4 mb-3 bg-warn-bg border border-warn-border rounded-xl px-3.5 py-2.5 shrink-0 relative z-20">
          {/* Heading left, names right — the first name sits on the heading's
              own line and any others stack under it, still right-aligned, so
              three medicines read as a list instead of running off the edge. */}
          <div className="flex items-start gap-2">
            <RefreshCw size={16} className="text-warn shrink-0 mt-0.5" />
            <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-warn-fg whitespace-nowrap">{t(language, "home.refillNeeded")}</p>
            <div data-testid="refill-names" className="ml-auto min-w-0 flex flex-col items-end gap-0.5">
              {refillAlerts.map(m => (
                <p key={m.name} className="text-[calc(13px*var(--dw-text,1))] text-warn-fg/80 font-medium leading-snug text-right break-words">{m.name}</p>
              ))}
            </div>
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
                  <span className="text-[calc(12px*var(--dw-text,1))] font-semibold text-muted-foreground/55 font-mono whitespace-nowrap tracking-tight">
                    {formatClockAt(row.hour, timeFormat)}
                  </span>
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  {/* The line sits at its real minute WITHIN the hour: after
                      every dose already past, before the ones still to come. A
                      dose at exactly this minute counts as still to come, so the
                      line lands just above its card rather than swallowing it. */}
                  {(() => {
                    const cards = row.slots.map(slot => (
                      <div key={slot.minutes} className="flex flex-col gap-2">
                        {slot.meds.map(m => renderCard(m, slot.vague, slot.note))}
                      </div>
                    ));
                    if (!row.showNow) return cards;
                    const nowBlock = (
                      <div key="now" ref={nowLineRef} className="flex flex-col gap-1">
                      {/* Everything ABOVE this line has already come and gone,
                          so the count of what was missed belongs here, pointing
                          back up at it — not buried in a card further down. */}
                      {missedCount > 0 && (
                        // A row rather than one big button: the X has to be its
                        // own control, and a button can't live inside a button.
                        <div className="dw-flow-missed w-full flex items-center rounded-xl border border-missed-border text-missed-fg overflow-hidden">
                          <button
                            onClick={jumpToFirstMissed}
                            data-walk="elder-missed-summary"
                            className="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-1.5 pl-3 active:opacity-70 transition-opacity"
                          >
                            <ArrowUp size={15} className="shrink-0" />
                            <span className="text-[calc(13px*var(--dw-text,1))] font-bold">
                              {t(language, missedCount === 1 ? "home.missedCountOne" : "home.missedCount", { count: missedCount })}
                            </span>
                          </button>
                          {/* Not a dismiss: the useful thing to offer next to
                              "you missed some" is what to actually do about it. */}
                          <button
                            onClick={() => setShowMissedHelp(true)}
                            data-walk="elder-missed-help"
                            className="flex items-center gap-1 mr-1.5 h-7 px-2 rounded-full border border-missed-border/70 shrink-0 active:bg-missed/15 transition-colors"
                          >
                            <HelpCircle size={14} className="shrink-0" />
                            <span className="text-[calc(12px*var(--dw-text,1))] font-bold whitespace-nowrap">{t(language, "home.whatToDo")}</span>
                          </button>
                        </div>
                      )}
                        <div data-testid="now-line" className="flex items-center gap-2">
                          <span className="shrink-0 text-[calc(13px*var(--dw-text,1))] font-bold text-white bg-destructive rounded-full px-2.5 py-1 leading-none">
                            {formatClockAt(now, timeFormat)}
                          </span>
                          <div className="flex-1 h-1 bg-destructive/80 rounded-full" />
                        </div>
                      </div>
                    );
                    const cutoff = row.slots.findIndex(slot => !hasPassed(slot.minutes));
                    const at = cutoff === -1 ? cards.length : cutoff;
                    return [...cards.slice(0, at), nowBlock, ...cards.slice(at)];
                  })()}
                </div>
              </div>
            ))}

            {slots.length === 0 && (
              <div className="text-center text-[calc(15px*var(--dw-text,1))] text-muted-foreground pt-8">{t(language, "home.noSchedule")}</div>
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
            <span className="text-[calc(14px*var(--dw-text,1))] font-bold whitespace-nowrap">{t(language, "home.offscreenBelow", { clock: formatClock(resolveDose(nextDose).clock, timeFormat) })}</span>
          </button>
        )}
        {isSelectedToday && showJump && (
          <button
            onClick={() => jumpToNow("smooth")}
            className="absolute bottom-4 right-4 z-30 flex items-center gap-2 bg-primary text-primary-foreground rounded-full pl-3.5 pr-4 py-2.5 dw-float dw-press transition-transform"
          >
            <LocateFixed size={19} />
            <span className="text-[calc(16px*var(--dw-text,1))] font-bold">{t(language, "home.now")}</span>
          </button>
        )}
      </div>

      {/* Confirmation toast — centred, fades out rather than vanishing abruptly */}
      {confirmedId !== null && (
        <div className={`absolute inset-0 z-40 flex items-center justify-center pointer-events-none transition-opacity duration-500 ${toastVisible ? "opacity-100" : "opacity-0"}`}>
          <div className={`text-white rounded-[20px] px-6 py-5 flex items-center gap-3 dw-float ${toastKind === "taken" ? "bg-primary" : "bg-accent"}`}>
            {toastKind === "taken" ? <CheckCircle2 size={24} /> : <RotateCcw size={24} />}
            <p className="font-bold text-[calc(16px*var(--dw-text,1))]">{t(language, toastKind === "taken" ? "home.recorded" : "home.undone")}</p>
          </div>
        </div>
      )}

      {/* "I Took It" — adjust time popup */}
      {pendingDose && (
        <BottomSheet onClose={() => setPendingDose(null)}>
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-['Fraunces'] text-[calc(20px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "home.markTaken")}</h3>
              <button onClick={() => setPendingDose(null)} aria-label={t(language, "common.cancel")} className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <X size={20} className="text-muted-foreground" />
              </button>
            </div>

            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted shrink-0">
                <img src={medPhoto(pendingDose.name)} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="min-w-0">
                <p className="font-bold text-[calc(17px*var(--dw-text,1))] text-foreground break-words">{pendingDose.name}</p>
                <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{t(language, "home.scheduledFor", { clock: formatClock(resolveDose(pendingDose).clock, timeFormat) })}</p>
              </div>
            </div>

            {/* Tap-only stepper, never <input type="time"> — see MEMORY.md: the
                native control collapses to a cramped spinner on desktop, which
                is exactly how this phone-frame demo is viewed. */}
            <TimeField label={t(language, "home.whatTime")} value={takenInput} onChange={setTakenInput} icon={<Clock size={16} className="text-primary" />} />
            <button onClick={() => setTakenInput(to24hInput(new Date()))} data-walk="elder-take-justnow" className="mt-2 w-full h-11 rounded-xl bg-muted text-[calc(15px*var(--dw-text,1))] font-bold text-foreground active:opacity-80 transition-opacity">
              {t(language, "home.justNow")}
            </button>
            <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground mt-2 mb-5">{t(language, "home.willLogAs", { time: takenInput ? formatClock(takenInput, timeFormat) : "—" })}</p>

            <button onClick={confirmTake} data-walk="elder-take-confirm" className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground text-[calc(17px*var(--dw-text,1))] font-bold active:scale-[0.98] transition-transform flex items-center justify-center gap-2">
              <Check size={18} strokeWidth={3} />{t(language, "home.confirm")}
            </button>
          </div>
        </BottomSheet>
      )}

      {/* Undo a logged dose — always confirmed, since it rewrites a real record. */}
      {/* What to do about the doses that were missed — one card per medicine,
          each with its own next-dose time. Plain rule-of-thumb guidance with
          the "ask your doctor or pharmacist" line kept in view, never a
          drug-specific instruction the app is in no position to give. */}
      {showMissedHelp && (
        <BottomSheet onClose={() => setShowMissedHelp(false)}>
          <div>
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3 className="font-['Fraunces'] text-[calc(19px*var(--dw-text,1))] font-semibold text-foreground leading-tight">{t(language, "home.missedHelpTitle")}</h3>
              <button onClick={() => setShowMissedHelp(false)} aria-label={t(language, "common.cancel")} className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                <X size={20} className="text-muted-foreground" />
              </button>
            </div>
            <div className="space-y-2.5 mt-3">
              {missedMeds.map(m => {
                const advice = missedAdvice(m);
                return (
                  <div key={m.id} className="rounded-2xl border border-border bg-background p-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 bg-muted">
                        <img src={medPhoto(m.name)} alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-foreground leading-tight truncate">{m.name}</p>
                        <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{t(language, "home.missedWasDue", { time: advice.dueClock })}</p>
                      </div>
                    </div>
                    <p className={`text-[calc(15px*var(--dw-text,1))] font-semibold leading-snug mt-2.5 ${advice.skip ? "text-warn-fg" : "text-foreground"}`}>
                      {advice.skip
                        ? t(language, "home.missedSkip", { time: advice.nextClock ?? "" })
                        : t(language, "home.missedTakeNow")}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* One caution, under the cards rather than above them, and as plain
                text: boxing it made a third card out of something that is a
                footnote to the two above it. */}
            <p className="text-[calc(14px*var(--dw-text,1))] text-warn-fg leading-snug mt-3.5 px-1">
              <span className="font-bold">{t(language, "home.missedNeverDouble")}</span>{" "}
              {t(language, "home.missedCaution")}
            </p>

            {onAskMei && (
              <button
                onClick={() => { setShowMissedHelp(false); onAskMei(t(language, "home.missedAskMeiPrompt")); }}
                data-walk="elder-missed-ask-mei"
                className="mt-3 w-full h-12 rounded-2xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 active:opacity-80 transition-opacity"
              >
                <Sparkles size={17} />{t(language, "home.missedAskMei")}
              </button>
            )}
          </div>
        </BottomSheet>
      )}

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

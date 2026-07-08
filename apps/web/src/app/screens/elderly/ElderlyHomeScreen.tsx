import { useState, useEffect, useRef, useMemo } from "react";
import { RefreshCw, CheckCircle2, ChevronLeft, ChevronRight, Clock, AlertTriangle, Check, LocateFixed, X, Plane } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient, Medication, MedStatus } from "../../types";
import { MED_PHOTOS, MED_SIMPLE, MED_SHAPES, MEAL_TIMES } from "../../data/medications";
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
const LIST_BOTTOM_PAD = 28;                // small breathing room; the bottom nav
                                           // is an in-flow sibling, already excluded
                                           // from this flex-1 scroll area

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

export function ElderlyHomeScreen({ patient, onLogDose, onOpenTravel, justAddedMed }: {
  patient: Patient;
  onLogDose: (id: number, takenAt?: string) => void;
  onOpenTravel: () => void;
  justAddedMed?: string | null;
}) {
  const { colourBlind } = useAccessibility();
  const { language } = useLanguage();
  const [now, setNow] = useState(makeNow());
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());
  const [confirmedId, setConfirmedId] = useState<number | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [pendingDose, setPendingDose] = useState<Medication | null>(null);
  const [takenInput, setTakenInput] = useState("");
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    const target = nowRowRef.current;
    if (!el || !isSelectedToday || !target) { setShowJump(false); return; }
    const nowTop = target.offsetTop - el.clientHeight * 0.35;
    setShowJump(Math.abs(el.scrollTop - Math.max(0, nowTop)) > 120);
  };

  // --- dose logging via the time-adjust popup ------------------------------
  const openTakeDialog = (m: Medication) => {
    setTakenInput(to24hInput(new Date()));
    setPendingDose(m);
  };
  const confirmTake = () => {
    if (!pendingDose) return;
    onLogDose(pendingDose.id, input24hTo12h(takenInput));
    setConfirmedId(pendingDose.id);
    setToastVisible(true);
    setPendingDose(null);
    setTimeout(() => setToastVisible(false), 1600); // start fade
    setTimeout(() => setConfirmedId(null), 2100);   // unmount after the fade finishes
  };

  const changeDay = (delta: number) => {
    const d = new Date(selectedDay);
    d.setDate(d.getDate() + delta);
    setSelectedDay(d);
  };

  // --- one medication card (keeps the original card design) ----------------
  const renderCard = (m: Medication & { status: MedStatus }, vague: boolean, note?: string) => {
    const isNext = m.id === nextMedId && confirmedId === null;
    const isTaken = m.status === "taken";
    const isMissed = m.status === "missed";
    const photo = MED_PHOTOS[m.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format";
    const direction = MED_SIMPLE[m.name] ?? t(language, "home.takeAsDirected");
    const shape = MED_SHAPES[m.name];
    const clock = resolveDose(m).clock;
    const timeCls = isNext ? "bg-primary text-white" : isMissed ? "bg-orange-100 text-orange-700" : "bg-muted text-muted-foreground";

    if (isTaken) {
      return (
        <div key={m.id} className="rounded-xl border border-border bg-card flex items-center gap-3 px-3 py-2.5 opacity-60">
          <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 bg-muted">
            <img src={photo} alt={m.name} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-muted-foreground line-through leading-snug">{m.name}</p>
            <p className="text-xs text-muted-foreground/70">{m.takenAt ? t(language, "home.takenAt", { time: m.takenAt }) : t(language, "common.taken")}</p>
            {colourBlind && shape && <p className="text-xs text-muted-foreground/70">{shape.shape} · {shape.marking}</p>}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-lg whitespace-nowrap">{clock}</span>
            <CheckCircle2 size={18} className="text-emerald-500" />
          </div>
        </div>
      );
    }

    const justAdded = !!justAddedMed && m.name === justAddedMed;
    const cardCls = justAdded ? "border-2 border-emerald-400 bg-emerald-50/60 shadow-sm ring-2 ring-emerald-300/50"
                  : isNext ? "border-2 border-primary bg-sky-50/60 shadow-sm"
                  : isMissed ? "border-2 border-orange-400 bg-orange-50 shadow-sm"
                  : "border border-border bg-card";

    return (
      <div key={m.id} className={`rounded-2xl overflow-hidden ${cardCls}`}>
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-[62px] h-[62px] rounded-xl overflow-hidden shrink-0 bg-muted">
              <img src={photo} alt={m.name} className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="font-bold text-[17px] text-foreground leading-snug">{m.name}</p>
                  {justAdded && (
                    <span className="flex items-center gap-1 bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      <Check size={9} strokeWidth={3} />Just added
                    </span>
                  )}
                  {isMissed && (
                    <span className="flex items-center gap-1 bg-orange-100 text-orange-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      <AlertTriangle size={9} />{t(language, "common.missed")}
                    </span>
                  )}
                </div>
                <span className={`text-base font-bold px-2.5 py-0.5 rounded-xl shrink-0 whitespace-nowrap ${timeCls}`}>{clock}</span>
              </div>
              <p className="text-sm text-muted-foreground mt-1.5">{localizeMedText(language, m.name, "simple", direction)}</p>
              {vague && <p className="text-xs text-primary/80 mt-1">🕒 {t(language, "home.vagueTimeNote", { note: note ?? "", clock: minutesToClock(resolveDose(m).minutes) })}</p>}
              {colourBlind && shape && <p className="text-xs text-muted-foreground mt-1">{shape.shape} · {shape.marking}</p>}
            </div>
          </div>
        </div>

        {isSelectedToday && (isNext || isMissed) ? (
          <button
            onClick={() => openTakeDialog(m)}
            className={`w-full flex items-center justify-center gap-2.5 py-3.5 border-t font-bold text-[15px] active:opacity-80 transition-opacity ${
              isNext ? "border-primary/20 bg-primary/10 text-primary" : "border-orange-200 bg-orange-100/60 text-orange-700"
            }`}
          >
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${isNext ? "border-primary" : "border-orange-500"}`}>
              <Check size={12} strokeWidth={3} className={isNext ? "text-primary" : "text-orange-600"} />
            </div>
            {t(language, "home.iTookIt")}
          </button>
        ) : (
          <div className="w-full flex items-center justify-center gap-2 py-2.5 border-t border-border/40">
            <Clock size={13} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground font-medium">{isFuture(selectedDay) ? t(language, "home.scheduled") : t(language, "home.comingUp")}</p>
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
          className="mx-4 mt-2 shrink-0 flex flex-col items-center gap-0.5 bg-primary/10 border border-primary/20 rounded-xl px-3 py-2 text-center active:bg-primary/15 transition-colors"
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Plane size={13} className="shrink-0" />
            {t(language, "common.travelMode")} · {formatTravelDate(travelPlan.startDate)}–{formatTravelDate(travelPlan.endDate)}
          </p>
          <p className="text-[11px] text-primary/80">{t(language, "home.timesShownIn", { tz: travelPlan.timezone })}</p>
        </button>
      )}

      {/* Day navigation — single day with arrows (no week strip) */}
      <div className="px-4 pt-2.5 pb-2 shrink-0 relative z-20 bg-background">
        <div className="flex items-center gap-2">
          <button onClick={() => changeDay(-1)} className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
            <ChevronLeft size={18} className="text-foreground" />
          </button>
          <div className="flex-1 text-center">
            <p className={`text-sm font-bold leading-tight ${isSelectedToday ? "text-primary" : "text-foreground"}`}>
              {isSelectedToday ? t(language, "home.today") : selectedDay.toLocaleDateString("en-SG", { weekday: "long" })}
            </p>
            <p className="text-xs text-muted-foreground">{selectedDay.toLocaleDateString("en-SG", { day: "numeric", month: "long" })}</p>
          </div>
          <button onClick={() => changeDay(1)} className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
            <ChevronRight size={18} className="text-foreground" />
          </button>
          {!isSelectedToday && (
            <button onClick={() => setSelectedDay(new Date())} className="ml-1 text-xs font-bold px-3 h-9 rounded-xl bg-primary text-primary-foreground active:opacity-80">
              {t(language, "home.today")}
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${total ? (takenCount / total) * 100 : 0}%` }} />
          </div>
          <p className="text-xs font-semibold text-muted-foreground shrink-0">{takenCount}/{total} {t(language, "home.taken")}</p>
        </div>
      </div>

      {/* Refill reminder */}
      {refillAlerts.length > 0 && (
        <div className="mx-4 mb-1 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 shrink-0 relative z-20">
          <div className="flex items-center gap-2">
            <RefreshCw size={13} className="text-amber-600 shrink-0" />
            <p className="text-sm font-semibold text-amber-900">{t(language, "home.refillNeeded")}</p>
            <p className="text-xs text-amber-700 ml-auto font-medium">{refillAlerts.map(m => m.name).join(", ")}</p>
          </div>
        </div>
      )}

      {/* Timeline — one row per hour, height set by whatever it contains: a
          quiet hour is just its label and a hairline, a busy hour grows to
          fit its cards. Normal document flow throughout, so cards can never
          overlap and every dose sits under its true hour. */}
      <div ref={scrollRef} data-tour="elder-schedule" onScroll={onTimelineScroll} className="relative flex-1 overflow-y-auto scrollbar-none border-t border-border">
        <div className="flex flex-col px-4 pt-3" style={{ paddingBottom: LIST_BOTTOM_PAD }}>
          {hourRows.map(row => (
            <div key={row.hour} className="flex gap-3 py-2 border-b border-border/30 last:border-0">
              <div className="w-14 shrink-0 pt-0.5">
                <span className="text-xs font-semibold text-muted-foreground/70 font-mono">
                  {minutesToClock(row.hour * 60).replace(":00", "")}
                </span>
              </div>
              <div ref={row.showNow ? nowRowRef : undefined} className="flex-1 min-w-0 flex flex-col gap-2">
                {row.showNow && (
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[11px] font-bold text-white bg-red-500 rounded-full px-2 py-0.5 leading-none">
                      {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true })}
                    </span>
                    <div className="flex-1 h-0.5 bg-red-500/80" />
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
            <div className="text-center text-sm text-muted-foreground pt-8">No medications scheduled.</div>
          )}
        </div>
      </div>

      {/* Snap-to-now button */}
      {isSelectedToday && showJump && (
        <button
          onClick={() => jumpToNow("smooth")}
          className="absolute bottom-4 right-4 z-30 flex items-center gap-1.5 bg-primary text-primary-foreground rounded-full pl-3 pr-4 py-2.5 shadow-lg active:scale-95 transition-transform"
        >
          <LocateFixed size={16} />
          <span className="text-sm font-bold">Now</span>
        </button>
      )}

      {/* Confirmation toast — centred, fades out rather than vanishing abruptly */}
      {confirmedId !== null && (
        <div className={`absolute inset-0 z-40 flex items-center justify-center pointer-events-none transition-opacity duration-500 ${toastVisible ? "opacity-100" : "opacity-0"}`}>
          <div className="bg-emerald-500 text-white rounded-2xl px-6 py-5 flex items-center gap-3 shadow-xl">
            <CheckCircle2 size={24} />
            <p className="font-semibold text-base">Recorded! Well done 🌟</p>
          </div>
        </div>
      )}

      {/* "I Took It" — adjust time popup */}
      {pendingDose && (
        <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setPendingDose(null)}>
          <div className="w-full bg-background rounded-t-3xl p-5 pb-7 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-['Fraunces'] text-xl font-semibold text-foreground">Mark as taken</h3>
              <button onClick={() => setPendingDose(null)} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>

            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted shrink-0">
                <img src={MED_PHOTOS[pendingDose.name] ?? ""} alt={pendingDose.name} className="w-full h-full object-cover" />
              </div>
              <div>
                <p className="font-bold text-[17px] text-foreground">{pendingDose.name}</p>
                <p className="text-sm text-muted-foreground">Scheduled for {resolveDose(pendingDose).clock}</p>
              </div>
            </div>

            <label className="block text-sm font-semibold text-foreground mb-2">What time did you take it?</label>
            <div className="flex items-center gap-2 mb-3">
              <input
                type="time"
                value={takenInput}
                onChange={e => setTakenInput(e.target.value)}
                className="flex-1 bg-input-background border border-border rounded-xl px-4 py-3 text-lg font-bold text-foreground outline-none focus:border-primary"
              />
              <button onClick={() => setTakenInput(to24hInput(new Date()))} className="px-4 py-3 rounded-xl bg-muted text-sm font-bold text-foreground active:bg-muted/70">
                Just now
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-5">You'll log it as <span className="font-semibold text-foreground">{takenInput ? input24hTo12h(takenInput) : "—"}</span></p>

            <button onClick={confirmTake} className="w-full h-13 py-4 rounded-2xl bg-primary text-primary-foreground text-base font-bold active:scale-[0.98] transition-transform flex items-center justify-center gap-2">
              <Check size={18} strokeWidth={3} />Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

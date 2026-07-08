import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { RefreshCw, CheckCircle2, ChevronLeft, ChevronRight, Clock, AlertTriangle, Check, LocateFixed, X, Plane } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient, Medication, MedStatus } from "../../types";
import { MED_SIMPLE, MED_SHAPES, MEAL_TIMES } from "../../data/medications";
import { MedAvatar } from "../../components/shared";

// --- timeline window: morning (6 AM) to night (11 PM) ----------------------
const START_HOUR = 6;
const END_HOUR = 23;
const HOUR_PX = 72;                       // vertical px per hour
const PX_PER_MIN = HOUR_PX / 60;
const START_MIN = START_HOUR * 60;
const END_MIN = END_HOUR * 60;
const TOP_PAD = 18;                        // keeps the first row off the top edge
const BOTTOM_PAD = 140;                    // clears the bottom nav
const TIMELINE_PX = (END_HOUR - START_HOUR) * HOUR_PX;
const topFor = (minutes: number) => (Math.max(START_MIN, Math.min(END_MIN, minutes)) - START_MIN) * PX_PER_MIN + TOP_PAD;

// Keep the timeline tied to the actual device clock so the "Now" marker and
// medication statuses follow real time while the screen is open.
const DEMO_NOW: string | null = null;

function getLiveNow(): Date {
  const mins = DEMO_NOW ? clockToMinutes(DEMO_NOW) : null;
  if (mins == null) return new Date();
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

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

function formatSlotTime(minutes: number): string {
  const clock = minutesToClock(minutes);
  if (minutes % 60 === 0) {
    return clock.replace(/:00\s*/, " ");
  }
  return clock;
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
const input24hTo12h = (v: string) => {
  const [hh, mm] = v.split(":").map(Number);
  return minutesToClock(hh * 60 + mm);
};

export function ElderlyHomeScreen({ patient, onLogDose, onOpenTravel }: {
  patient: Patient;
  onLogDose: (id: number, takenAt?: string) => void;
  onOpenTravel: () => void;
}) {
  const { colourBlind } = useAccessibility();
  const [now, setNow] = useState<Date>(() => getLiveNow());
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());
  const [confirmedId, setConfirmedId] = useState<number | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [pendingDose, setPendingDose] = useState<Medication | null>(null);
  const [takenInput, setTakenInput] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [expandedSlots, setExpandedSlots] = useState<Record<number, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Real rendered height per slot, keyed by its resolved minute — a card's true
  // height varies a lot by variant (taken vs. next/missed vs. multi-med), so a
  // single flat estimate under-counts tall cards and lets the next slot start
  // too early, overlapping it. Measured after paint, replacing the estimate
  // used for the very first render before any measurement exists yet.
  const slotRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [measuredHeights, setMeasuredHeights] = useState<Record<number, number>>({});

  useEffect(() => {
    const syncNow = () => setNow(getLiveNow());
    const id = window.setInterval(syncNow, 30000);
    window.addEventListener("focus", syncNow);
    document.addEventListener("visibilitychange", syncNow);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", syncNow);
      document.removeEventListener("visibilitychange", syncNow);
    };
  }, []);

  const today = now;
  const isToday = (d: Date) => d.toDateString() === today.toDateString();
  const isPast = (d: Date) => d < today && !isToday(d);
  const isFuture = (d: Date) => d > today && !isToday(d);
  const isSelectedToday = isToday(selectedDay);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowInWindow = nowMinutes >= START_MIN && nowMinutes <= END_MIN;

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

  const getSlotHeightPx = (slot: { minutes: number; clock: string; vague: boolean; note?: string; meds: (Medication & { status: MedStatus })[] }, expanded: boolean) => {
    const measured = measuredHeights[slot.minutes];
    if (measured) return measured;
    // Rough estimate used only until the real height is measured post-paint.
    if (slot.meds.length > 1) {
      return expanded ? Math.min(340, 54 + slot.meds.length * 86) : 54;
    }
    return 108;
  };

  const slotLayout = useMemo(() => {
    let cursorTop = TOP_PAD;

    return slots.reduce<Array<{ minutes: number; clock: string; vague: boolean; note?: string; meds: (Medication & { status: MedStatus })[]; top: number; height: number }>>((acc, slot) => {
      const expanded = expandedSlots[slot.minutes] ?? false;
      const baseTop = topFor(slot.minutes);
      const height = getSlotHeightPx(slot, expanded);
      const top = Math.max(baseTop, cursorTop);
      acc.push({ ...slot, top, height });
      cursorTop = top + height + 12;
      return acc;
    }, []);
    // measuredHeights is read inside getSlotHeightPx above — it must be a
    // dependency here too, or this memo keeps returning stale, estimate-based
    // positions forever once the real heights come in from the effect below.
  }, [slots, expandedSlots, measuredHeights]);

  // Measure each slot's true rendered height after paint and correct the
  // estimate used above — the slot wrapper itself has no natural height (its
  // children are all absolutely positioned), so nothing constrains it to the
  // estimate; an undercount lets the next slot's cards visually overlap this one.
  useLayoutEffect(() => {
    const next: Record<number, number> = {};
    let changed = false;
    slotRefs.current.forEach((el, minutes) => {
      const h = el.offsetHeight;
      if (h > 0) {
        next[minutes] = h;
        if (measuredHeights[minutes] !== h) changed = true;
      }
    });
    if (changed) setMeasuredHeights(prev => ({ ...prev, ...next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, expandedSlots, colourBlind]);

  // A different day's medications can land on the same time-of-day key with a
  // different card mix — drop stale heights so a leftover value from another
  // day never gets reused for even one frame before re-measuring.
  useEffect(() => {
    setMeasuredHeights({});
  }, [selectedDay]);

  // --- scroll: snap to now on load / day change ----------------------------
  const jumpToNow = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    const target = topFor(nowInWindow ? nowMinutes : START_MIN) - el.clientHeight * 0.35;
    el.scrollTo({ top: Math.max(0, target), behavior });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isSelectedToday) jumpToNow("auto");
    else el.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDay]);

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || !isSelectedToday) { setShowJump(false); return; }
    const nowTop = topFor(nowInWindow ? nowMinutes : START_MIN) - el.clientHeight * 0.35;
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

  const toggleSlot = (minutes: number) => {
    setExpandedSlots(prev => ({ ...prev, [minutes]: !prev[minutes] }));
  };

  const hourTicks = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i);

  // --- one medication card (keeps the original card design) ----------------
  const renderCard = (m: Medication & { status: MedStatus }, vague: boolean, note?: string) => {
    const isNext = m.id === nextMedId && confirmedId === null;
    const isTaken = m.status === "taken";
    const isMissed = m.status === "missed";
    const direction = MED_SIMPLE[m.name] ?? "Take as directed by your doctor.";
    const shape = MED_SHAPES[m.name];
    const clock = resolveDose(m).clock;
    const timeCls = isNext ? "bg-primary text-white" : isMissed ? "bg-orange-100 text-orange-700" : "bg-muted text-muted-foreground";

    if (isTaken) {
      return (
        <div key={m.id} className="rounded-xl border border-border bg-card flex items-center gap-3 px-3 py-2.5 opacity-60">
          <MedAvatar name={m.name} size={36} className="rounded-lg shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-muted-foreground line-through leading-snug">{m.name}</p>
            <p className="text-xs text-muted-foreground/70">{m.takenAt ? `Taken at ${m.takenAt}` : "Taken"}</p>
            {colourBlind && shape && <p className="text-xs text-muted-foreground/70">{shape.shape} · {shape.marking}</p>}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-lg whitespace-nowrap">{clock}</span>
            <CheckCircle2 size={18} className="text-emerald-500" />
          </div>
        </div>
      );
    }

    const cardCls = isNext ? "border-2 border-primary bg-sky-50/60 shadow-sm"
                  : isMissed ? "border-2 border-orange-400 bg-orange-50 shadow-sm"
                  : "border border-border bg-card";

    return (
      <div key={m.id} className={`rounded-2xl overflow-hidden ${cardCls}`}>
        <div className="p-3">
          <div className="flex items-start gap-2.5">
            <MedAvatar name={m.name} size={52} className="rounded-xl shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="font-bold text-[16px] text-foreground leading-snug">{m.name}</p>
                  {isMissed && (
                    <span className="flex items-center gap-1 bg-orange-100 text-orange-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      <AlertTriangle size={9} />Missed
                    </span>
                  )}
                </div>
                <span className={`text-sm font-bold px-2 py-0.5 rounded-xl shrink-0 whitespace-nowrap ${timeCls}`}>{clock}</span>
              </div>
              <p className="text-sm text-muted-foreground mt-1">{direction}</p>
              {vague && <p className="text-xs text-primary/80 mt-0.5">🕒 {note} · around {minutesToClock(resolveDose(m).minutes)}</p>}
              {colourBlind && shape && <p className="text-xs text-muted-foreground mt-0.5">{shape.shape} · {shape.marking}</p>}
            </div>
          </div>
        </div>

        {isSelectedToday && (isNext || isMissed) ? (
          <button
            onClick={() => openTakeDialog(m)}
            className={`w-full flex items-center justify-center gap-2 py-2.5 border-t font-bold text-[15px] active:opacity-80 transition-opacity ${
              isNext ? "border-primary/20 bg-primary/10 text-primary" : "border-orange-200 bg-orange-100/60 text-orange-700"
            }`}
          >
            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isNext ? "border-primary" : "border-orange-500"}`}>
              <Check size={11} strokeWidth={3} className={isNext ? "text-primary" : "text-orange-600"} />
            </div>
            I Took It ✓
          </button>
        ) : (
          <div className="w-full flex items-center justify-center gap-2 py-2 border-t border-border/40">
            <Clock size={13} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground font-medium">{isFuture(selectedDay) ? "Scheduled" : "Coming up"}</p>
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
    <div className="flex flex-col flex-1 overflow-hidden relative">
      {/* Travel Mode indicator — display only; the schedule below still runs on
          local time, it doesn't actually shift to the destination timezone. */}
      {travelActive && travelPlan && (
        <button
          onClick={onOpenTravel}
          className="mx-4 mt-2 shrink-0 flex flex-col items-center gap-0.5 bg-primary/10 border border-primary/20 rounded-xl px-3 py-2 text-center active:bg-primary/15 transition-colors"
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Plane size={13} className="shrink-0" />
            Travel Mode · {formatTravelDate(travelPlan.startDate)}–{formatTravelDate(travelPlan.endDate)}
          </p>
          <p className="text-[11px] text-primary/80">Times shown in {travelPlan.timezone}</p>
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
              {isSelectedToday ? "Today" : selectedDay.toLocaleDateString("en-SG", { weekday: "long" })}
            </p>
            <p className="text-xs text-muted-foreground">{selectedDay.toLocaleDateString("en-SG", { day: "numeric", month: "long" })}</p>
          </div>
          <button onClick={() => changeDay(1)} className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center active:bg-muted transition-colors">
            <ChevronRight size={18} className="text-foreground" />
          </button>
          {!isSelectedToday && (
            <button onClick={() => setSelectedDay(new Date())} className="ml-1 text-xs font-bold px-3 h-9 rounded-xl bg-primary text-primary-foreground active:opacity-80">
              Today
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${total ? (takenCount / total) * 100 : 0}%` }} />
          </div>
          <p className="text-xs font-semibold text-muted-foreground shrink-0">{takenCount}/{total} taken</p>
        </div>
      </div>

      {/* Refill reminder */}
      {refillAlerts.length > 0 && (
        <div className="mx-4 mb-1 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 shrink-0 relative z-20">
          <div className="flex items-center gap-2">
            <RefreshCw size={13} className="text-amber-600 shrink-0" />
            <p className="text-sm font-semibold text-amber-900">Refill needed soon</p>
            <p className="text-xs text-amber-700 ml-auto font-medium">{refillAlerts.map(m => m.name).join(", ")}</p>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div ref={scrollRef} data-tour="elder-schedule" onScroll={onTimelineScroll} className="relative flex-1 overflow-y-auto scrollbar-none border-t border-border">
        <div className="relative" style={{ height: Math.max(TIMELINE_PX + TOP_PAD + BOTTOM_PAD, (slotLayout[slotLayout.length - 1]?.top ?? TOP_PAD) + (slotLayout[slotLayout.length - 1]?.height ?? 0) + BOTTOM_PAD + 24) }}>
          {/* hour grid */}
          {hourTicks.map(hr => (
            <div key={hr} className="absolute left-0 right-0 flex items-start" style={{ top: topFor(hr * 60) }}>
              <div className="w-14 shrink-0" />
              <div className="flex-1 h-px bg-border/50 mt-0.5" />
            </div>
          ))}

          {/* now line (today only) */}
          {isSelectedToday && nowInWindow && (
            <div className="absolute left-0 right-0 z-20 flex items-center pointer-events-none" style={{ top: topFor(nowMinutes) }}>
              <span className="ml-2 shrink-0 text-[11px] font-bold text-white bg-red-500 rounded-full px-2 py-0.5 leading-none">
                {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true })}
              </span>
              <div className="flex-1 h-0.5 bg-red-500/80" />
            </div>
          )}

          {/* dose slots, anchored at their time */}
          {slotLayout.map(slot => {
            const isExpanded = expandedSlots[slot.minutes] ?? false;
            const isMulti = slot.meds.length > 1;

            return (
              <div key={slot.minutes} className="absolute left-0 right-0 z-10" style={{ top: slot.top }}>
                <div className="absolute left-0 w-14 pr-2.5 z-20" style={{ top: 6 }}>
                  <p className="text-right text-[11px] font-semibold leading-none text-muted-foreground/80">
                    {formatSlotTime(slot.minutes)}
                  </p>
                </div>
                <div
                  className="absolute left-14 right-3"
                  ref={el => { if (el) slotRefs.current.set(slot.minutes, el); else slotRefs.current.delete(slot.minutes); }}
                >
                {isMulti && (
                  <button
                    type="button"
                    onClick={() => toggleSlot(slot.minutes)}
                    className="mb-2 flex w-full items-center justify-between rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left shadow-sm"
                    aria-expanded={isExpanded}
                  >
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-foreground">{slot.meds.length} medications</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {slot.meds.slice(0, 2).map(m => m.name).join(", ")} {slot.meds.length > 2 ? "…" : ""}
                      </p>
                    </div>
                    <span className="text-[11px] font-semibold text-primary">{isExpanded ? "Hide" : "Tap to view"}</span>
                  </button>
                )}

                {(!isMulti || isExpanded) && (
                  <div className={`flex flex-col gap-2 ${isMulti ? "max-h-[320px] overflow-y-auto pr-1 scrollbar-none" : ""}`}>
                    {slot.meds.map(m => renderCard(m, slot.vague, slot.note))}
                  </div>
                )}
                </div>
              </div>
            );
          })}

          {slots.length === 0 && (
            <div className="absolute left-14 right-3 top-8 text-center text-sm text-muted-foreground">No medications scheduled.</div>
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
              <MedAvatar name={pendingDose.name} size={48} className="rounded-xl shrink-0" />
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

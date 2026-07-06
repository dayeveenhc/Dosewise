import { useState, useEffect } from "react";
import { RefreshCw, CheckCircle2, ChevronLeft, ChevronRight, Clock, AlertTriangle, Check, Eye } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient, Medication, MedStatus } from "../../types";
import type { ElderlyTab } from "./types";
import { MED_PHOTOS, MED_SIMPLE, MED_SHAPES } from "../../data/medications";

export function ElderlyHomeScreen({ patient, onLogDose, onNavigate }: {
  patient: Patient;
  onLogDose: (id: number) => void;
  onNavigate: (tab: ElderlyTab) => void;
}) {
  const { colourBlind } = useAccessibility();
  const [confirmedId, setConfirmedId] = useState<number | null>(null);
  const [now, setNow] = useState(new Date());
  const [weekOffset, setWeekOffset] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  const today = now;
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());

  const DAYS     = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAYS_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - today.getDay() + i + weekOffset * 7);
    return d;
  });
  const weekLabel = weekDays[3].toLocaleDateString("en-SG", { month: "long", year: "numeric" });
  // deterministic past-day adherence per day-of-week
  const WEEK_AD  = [true, true, false, true, true, true, false];

  const isToday  = (d: Date) => d.toDateString() === today.toDateString();
  const isPast   = (d: Date) => d < today && !isToday(d);
  const isFuture = (d: Date) => d > today && !isToday(d);
  const isSelectedToday = isToday(selectedDay);

  // Resolve medication status for an arbitrary day
  const statusForDay = (m: Medication, day: Date): MedStatus => {
    if (isToday(day)) return m.status;
    if (isPast(day))  return (day.getDate() * 3 + m.id) % 10 > 2 ? "taken" : "missed";
    return "upcoming";
  };

  const dayMeds   = patient.medications.map(m => ({ ...m, status: statusForDay(m, selectedDay) as MedStatus }));
  const takenCount = dayMeds.filter(m => m.status === "taken").length;
  const total      = patient.medications.length;
  const refillAlerts = patient.medications.filter(m => m.refillDaysLeft !== undefined && m.refillDaysLeft <= 5);

  // "Take now" only applies on today
  const nextMedId  = isSelectedToday
    ? patient.medications.find(m => m.status === "upcoming")?.id
    : undefined;

  const handleLogDose = (id: number) => {
    onLogDose(id);
    setConfirmedId(id);
    setTimeout(() => setConfirmedId(null), 2500);
  };

  const parseTime = (t: string) => {
    const [time, period] = t.split(" ");
    const [hh, mm] = time.split(":").map(Number);
    const h24 = period === "PM" && hh !== 12 ? hh + 12 : period === "AM" && hh === 12 ? 0 : hh;
    return h24 * 60 + mm;
  };

  const h = today.getHours();
  const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-2 pb-28 space-y-4">

        {/* Greeting + live time */}
        <div className="pt-2 pb-1">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {now.toLocaleDateString("en-SG", { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <h2 className="font-['Fraunces'] text-2xl font-semibold text-foreground">
                Hello, {patient.nickname}! 👋
              </h2>
            </div>
            <div className="shrink-0 ml-3 bg-card border border-border rounded-xl px-3 py-2 flex items-baseline gap-1">
              <p className="text-[26px] font-bold text-foreground font-mono leading-none tracking-tight">
                {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true }).split(" ")[0]}
              </p>
              <p className="text-[11px] font-semibold text-muted-foreground">
                {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", hour12: true }).split(" ")[1]?.toUpperCase()}
              </p>
            </div>
          </div>
        </div>

        {/* Refill reminder — below greeting */}
        {refillAlerts.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <RefreshCw size={13} className="text-amber-600 shrink-0" />
              <p className="text-sm font-semibold text-amber-900">Refill needed</p>
              <p className="text-xs text-amber-600 ml-auto">Caregiver notified</p>
            </div>
            {refillAlerts.map(m => (
              <div key={m.id} className="flex items-center justify-between py-0.5">
                <p className="text-sm text-amber-800">{m.name}</p>
                <p className="text-sm font-bold text-amber-700">{m.refillDaysLeft} left</p>
              </div>
            ))}
          </div>
        )}

        {/* Confirmed toast */}
        {confirmedId !== null && (
          <div className="bg-emerald-500 text-white rounded-2xl p-4 flex items-center gap-3">
            <CheckCircle2 size={22} />
            <div>
              <p className="font-semibold text-base">Recorded! Well done 🌟</p>
              <p className="text-sm opacity-90">Your caregiver has been notified</p>
            </div>
          </div>
        )}

        {/* Week strip + progress */}
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          {/* Week day selector */}
          <div className="px-3 pt-3 pb-2">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1">
                <button onClick={() => setWeekOffset(o => o - 1)} className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center active:bg-muted/70 transition-colors">
                  <ChevronLeft size={14} className="text-foreground" />
                </button>
                <span className="text-xs font-semibold text-foreground px-1">{weekLabel}</span>
                <button onClick={() => setWeekOffset(o => o + 1)} className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center active:bg-muted/70 transition-colors">
                  <ChevronRight size={14} className="text-foreground" />
                </button>
              </div>
              <button
                onClick={() => { setSelectedDay(new Date()); setWeekOffset(0); }}
                className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full transition-all ${
                  isSelectedToday && weekOffset === 0
                    ? "bg-primary/10 text-primary cursor-default"
                    : "bg-primary text-primary-foreground active:opacity-80"
                }`}
              >
                <Clock size={11} />
                Today
              </button>
            </div>
            <div className="flex gap-1">
              {weekDays.map((d, i) => {
                const todayDay    = isToday(d);
                const selectedDay_ = d.toDateString() === selectedDay.toDateString();
                const pastDay     = isPast(d);
                const adherenceDot = pastDay
                  ? ((d.getDate() * 3 + 5) % 10 > 2 ? "bg-emerald-400" : "bg-red-400")
                  : todayDay ? "bg-primary" : "bg-muted-foreground/20";

                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDay(d)}
                    className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl transition-colors
                      ${selectedDay_ && !todayDay ? "bg-primary/10 ring-2 ring-primary/40" : ""}
                      ${todayDay && selectedDay_ ? "bg-primary/10 ring-2 ring-primary" : ""}
                      ${todayDay && !selectedDay_ ? "bg-primary/5" : ""}
                      ${!todayDay && !selectedDay_ ? "active:bg-muted/50" : ""}
                    `}
                  >
                    <p className={`text-[10px] font-semibold ${todayDay ? "text-primary" : selectedDay_ ? "text-primary" : "text-muted-foreground"}`}>
                      {DAYS[d.getDay()]}
                    </p>
                    <p className={`text-sm font-bold ${todayDay || selectedDay_ ? "text-primary" : "text-foreground"}`}>
                      {d.getDate()}
                    </p>
                    <div className={`w-1.5 h-1.5 rounded-full ${adherenceDot}`} />
                  </button>
                );
              })}
            </div>
          </div>

        </div>

        {/* Medication cards — chronological, compact for taken */}
        <div className="space-y-2.5">
          {[...dayMeds].sort((a, b) => parseTime(a.time) - parseTime(b.time)).map(m => {
            const isNext   = m.id === nextMedId && confirmedId === null;
            const isTaken  = m.status === "taken";
            const isMissed = m.status === "missed";
            const photo    = MED_PHOTOS[m.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format";
            const direction = MED_SIMPLE[m.name] ?? "Take as directed by your doctor.";
            const shape    = MED_SHAPES[m.name];

            /* Taken — compact row */
            if (isTaken) {
              return (
                <div key={m.id} className="rounded-xl border border-border bg-card flex items-center gap-3 px-3 py-2.5 opacity-55">
                  <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 bg-muted">
                    <img src={photo} alt={m.name} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-muted-foreground line-through leading-snug">{m.name}</p>
                    <p className="text-xs text-muted-foreground/70">{m.takenAt ? `Taken at ${m.takenAt}` : "Taken"}</p>
                    {colourBlind && shape && (
                      <p className="text-xs text-muted-foreground/70">{shape.shape} · {shape.marking}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-lg">{m.time}</span>
                    <CheckCircle2 size={16} className="text-emerald-500" />
                  </div>
                </div>
              );
            }

            /* Missed / Current / Upcoming — full card */
            const cardCls = isNext   ? "border-2 border-primary bg-sky-50/60 shadow-sm"
                          : isMissed ? "border-2 border-orange-400 bg-orange-50 shadow-sm"
                          :            "border border-border bg-card";
            const timeCls = isNext   ? "bg-primary text-white"
                          : isMissed ? "bg-orange-100 text-orange-700"
                          :            "bg-muted text-muted-foreground";

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
                          {isMissed && (
                            <span className="flex items-center gap-1 bg-orange-100 text-orange-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                              <AlertTriangle size={9} />Missed
                            </span>
                          )}
                        </div>
                        <span className={`text-base font-bold px-2.5 py-0.5 rounded-xl shrink-0 whitespace-nowrap ${timeCls}`}>{m.time}</span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1.5">{direction}</p>
                      {colourBlind && shape && (
                        <p className="text-xs text-muted-foreground mt-1">{shape.shape} · {shape.marking}</p>
                      )}
                    </div>
                  </div>
                </div>

                {isSelectedToday && (isNext || isMissed) ? (
                  <button
                    onClick={() => handleLogDose(m.id)}
                    className={`w-full flex items-center justify-center gap-2.5 py-3.5 border-t font-bold text-[15px] active:opacity-80 transition-opacity ${
                      isNext ? "border-primary/20 bg-primary/10 text-primary" : "border-orange-200 bg-orange-100/60 text-orange-700"
                    }`}
                  >
                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${isNext ? "border-primary" : "border-orange-500"}`}>
                      <Check size={12} strokeWidth={3} className={isNext ? "text-primary" : "text-orange-600"} />
                    </div>
                    I Took It ✓
                  </button>
                ) : (
                  <div className="w-full flex items-center justify-center gap-2 py-2.5 border-t border-border/40">
                    <Clock size={13} className="text-muted-foreground" />
                    <p className="text-xs text-muted-foreground font-medium">
                      {isFuture(selectedDay) ? "Scheduled" : "Coming up"}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* End line */}
        <div className="flex items-center gap-3 py-2">
          <div className="flex-1 h-px bg-border" />
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">End of today</p>
          <div className="flex-1 h-px bg-border" />
        </div>

      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Send } from "lucide-react";
import type { Patient, Medication, MedStatus } from "../types";
import { StatusPill } from "../components/shared";
import { MED_PHOTOS, MED_SIMPLE } from "../data/medications";
import { DASH_DAYS } from "../lib/constants";

export function TimelineScreen({ patient }: { patient: Patient }) {
  const [view, setView] = useState<"daily" | "weekly">("daily");
  const today = new Date();
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<Date>(today);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(id);
  }, []);

  const statusConfig: Record<MedStatus, { dot: string; line: string }> = {
    taken: { dot: "bg-emerald-500", line: "border-emerald-200" },
    missed: { dot: "bg-orange-500", line: "border-orange-200" },
    upcoming: { dot: "bg-sky-400", line: "border-sky-200" },
    skipped: { dot: "bg-stone-400", line: "border-stone-200" },
  };
  const weekDotCls: Record<MedStatus, string> = {
    taken: "bg-emerald-500",
    missed: "bg-orange-500",
    upcoming: "bg-sky-400",
    skipped: "bg-stone-300",
  };

  // Not every medication is due every day — Celecoxib is taken once every 2 days as an example.
  const isDueOnDay = (medName: string, day: Date): boolean => {
    if (medName === "Celecoxib") {
      const epochDay = Math.floor(day.getTime() / 86400000);
      return epochDay % 2 === 0;
    }
    return true;
  };

  const isToday = (d: Date) => d.toDateString() === today.toDateString();
  const isPast  = (d: Date) => d < today && !isToday(d);
  const isSelectedToday = isToday(selectedDay);

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - today.getDay() + i + weekOffset * 7);
    return d;
  });
  const weekLabel = weekDays[3].toLocaleDateString("en-SG", { month: "long", year: "numeric" });

  const statusForDay = (m: Medication, day: Date): MedStatus => {
    if (isToday(day)) return m.status;
    if (isPast(day))  return (day.getDate() * 3 + m.id) % 10 > 2 ? "taken" : "missed";
    return "upcoming";
  };

  const toMin = (t: string) => {
    const [h, m] = t.replace(/ (AM|PM)/, "").split(":").map(Number);
    const isPM = t.includes("PM") && h !== 12;
    return (isPM ? h + 12 : h === 12 && t.includes("AM") ? 0 : h) * 60 + m;
  };
  const dayMeds = patient.medications
    .filter(m => isDueOnDay(m.name, selectedDay))
    .map(m => ({ ...m, status: statusForDay(m, selectedDay) as MedStatus }))
    .sort((a, b) => toMin(a.time) - toMin(b.time));

  return (
    <div className="px-4 py-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-['Fraunces'] text-xl font-semibold text-foreground">Schedule</h2>
        <span className="text-lg font-mono font-bold text-black">
          {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>

      {/* Week strip */}
      <div className="bg-card rounded-2xl border border-border px-3 pt-3 pb-2 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-0.5">
            <button onClick={() => setWeekOffset(o => o - 1)} className="w-7 h-7 flex items-center justify-center active:opacity-60 transition-opacity">
              <ChevronLeft size={16} className="text-foreground" />
            </button>
            <span className="text-xs font-semibold text-foreground px-1">{weekLabel}</span>
            <button onClick={() => setWeekOffset(o => o + 1)} className="w-7 h-7 flex items-center justify-center active:opacity-60 transition-opacity">
              <ChevronRight size={16} className="text-foreground" />
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
            const todayDay     = isToday(d);
            const selectedDay_ = d.toDateString() === selectedDay.toDateString();
            const pastDay      = isPast(d);
            const adherenceDot = pastDay
              ? ((d.getDate() * 3 + 5) % 10 > 2 ? "bg-emerald-400" : "bg-orange-400")
              : todayDay ? "bg-primary" : "bg-muted-foreground/20";

            return (
              <button
                key={i}
                disabled={view === "weekly"}
                onClick={() => setSelectedDay(d)}
                className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl transition-colors
                  ${view === "weekly" ? "cursor-default" : ""}
                  ${selectedDay_ && !todayDay ? "bg-primary/10 ring-2 ring-primary/40" : ""}
                  ${todayDay && selectedDay_ ? "bg-primary/10 ring-2 ring-primary" : ""}
                  ${todayDay && !selectedDay_ ? "bg-primary/5" : ""}
                  ${!todayDay && !selectedDay_ && view === "daily" ? "active:bg-muted/50" : ""}
                `}
              >
                <p className={`text-[10px] font-semibold ${todayDay ? "text-primary" : selectedDay_ ? "text-primary" : "text-muted-foreground"}`}>
                  {DASH_DAYS[d.getDay()]}
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

      {/* Daily / Weekly toggle */}
      <div className="flex bg-muted rounded-xl p-1 mb-4">
        <button
          onClick={() => setView("daily")}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${view === "daily" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          Daily
        </button>
        <button
          onClick={() => setView("weekly")}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${view === "weekly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          Weekly
        </button>
      </div>

      {view === "daily" ? (
        <div className="relative">
          {dayMeds.map((med, i) => {
            const cfg = statusConfig[med.status];
            const photo = MED_PHOTOS[med.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format";
            const direction = MED_SIMPLE[med.name] ?? "Take as directed by your doctor.";
            const lowRefill = med.refillDaysLeft !== undefined && med.refillDaysLeft <= 7;
            const supplyDays = med.refillDaysLeft ?? 30;
            const supplyPct = Math.min(100, Math.round((supplyDays / 30) * 100));
            return (
              <div key={med.id} className="flex gap-4 mb-1">
                {/* Timeline rail */}
                <div className="flex flex-col items-center w-6 shrink-0 pt-1">
                  <div className={`w-3 h-3 rounded-full shrink-0 ${cfg.dot} shadow-sm`} />
                  {i < dayMeds.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                </div>
                {/* Entry — home-page schedule card styling */}
                <div className={`flex-1 mb-4 bg-card rounded-2xl border ${cfg.line} shadow-sm overflow-hidden`}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0 bg-muted">
                      <img src={photo} alt={med.name} className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground">{med.name}</p>
                      <p className="text-xs text-muted-foreground">{direction}</p>
                      <p className="text-[11px] text-muted-foreground font-mono mt-0.5 whitespace-nowrap">
                        {med.status === "taken" ? `Taken at ${med.takenAt}` : `Scheduled ${med.time}`}
                      </p>
                    </div>
                    <StatusPill status={med.status} small />
                  </div>
                  <div className="px-4 pb-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-muted-foreground">Supply remaining</p>
                      <p className={`text-[10px] font-bold ${lowRefill ? "text-red-600" : "text-foreground"}`}>{supplyDays}/30 days</p>
                    </div>
                    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${lowRefill ? "bg-red-400" : "bg-primary"}`}
                        style={{ width: `${supplyPct}%` }}
                      />
                    </div>
                  </div>
                  {med.status === "missed" && (
                    <div className="px-4 pb-3">
                      <button className="w-full bg-orange-50 border border-orange-200 text-orange-700 text-xs font-semibold rounded-xl py-2 flex items-center justify-center gap-1.5">
                        <Send size={11} /> Send reminder to patient
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          {/* Week header */}
          <div className="grid grid-cols-[1fr_repeat(7,28px)] gap-1 px-3 pt-3 pb-2 border-b border-border">
            <span />
            {weekDays.map((d, i) => (
              <div key={i} className="flex flex-col items-center">
                <span className={`text-[9px] font-semibold ${isToday(d) ? "text-primary" : "text-muted-foreground"}`}>{DASH_DAYS[d.getDay()]}</span>
                <span className={`text-[11px] font-bold ${isToday(d) ? "text-primary" : "text-foreground"}`}>{d.getDate()}</span>
              </div>
            ))}
          </div>
          {/* Rows per medication */}
          <div className="divide-y divide-border">
            {patient.medications.map(med => (
              <div key={med.id} className="grid grid-cols-[1fr_repeat(7,28px)] gap-1 items-center px-3 py-2.5">
                <div className="min-w-0 pr-2">
                  <p className="text-xs font-semibold text-foreground truncate">{med.name}</p>
                  <p className="text-[10px] text-muted-foreground">{med.time}</p>
                </div>
                {weekDays.map((d, i) => {
                  if (!isDueOnDay(med.name, d)) {
                    return (
                      <div key={i} className="flex items-center justify-center">
                        <span className="text-muted-foreground/40 text-xs leading-none">✕</span>
                      </div>
                    );
                  }
                  const s = statusForDay(med, d);
                  return (
                    <div key={i} className="flex items-center justify-center">
                      <div className={`w-2.5 h-2.5 rounded-full ${weekDotCls[s]}`} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 px-4 py-3 border-t border-border flex-wrap">
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><div className="w-2 h-2 rounded-full bg-emerald-500" />Taken</span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><div className="w-2 h-2 rounded-full bg-orange-500" />Missed</span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><div className="w-2 h-2 rounded-full bg-sky-400" />Upcoming</span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className="text-muted-foreground/40">✕</span>Not due</span>
          </div>
        </div>
      )}
    </div>
  );
}

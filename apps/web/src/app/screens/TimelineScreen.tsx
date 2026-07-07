import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Send, CheckCircle2, AlertTriangle, Circle, X, Check } from "lucide-react";
import type { Patient, Medication, MedStatus } from "../types";
import { StatusPill } from "../components/shared";
import { MED_PHOTOS, MED_SIMPLE } from "../data/medications";
import { DASH_DAYS } from "../lib/constants";

const rowIconCfg: Record<MedStatus, { icon: typeof CheckCircle2; bg: string; fg: string }> = {
  taken: { icon: CheckCircle2, bg: "bg-emerald-50", fg: "text-emerald-600" },
  missed: { icon: AlertTriangle, bg: "bg-orange-50", fg: "text-orange-600" },
  upcoming: { icon: Circle, bg: "bg-sky-50", fg: "text-sky-500" },
  skipped: { icon: X, bg: "bg-stone-100", fg: "text-stone-400" },
};

const to24hInput = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const input24hTo12h = (v: string) => {
  const [hh, mm] = v.split(":").map(Number);
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
};

function LogDoseSheet({ med, recipientName, onClose, onConfirm }: {
  med: Medication; recipientName: string; onClose: () => void; onConfirm: (takenAt: string) => void;
}) {
  const [takenInput, setTakenInput] = useState(to24hInput(new Date()));
  const photo = MED_PHOTOS[med.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format";

  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="w-full bg-background rounded-t-3xl p-5 pb-7" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-['Fraunces'] text-xl font-semibold text-foreground">Log dose</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Logging dose for <span className="font-semibold text-foreground">{recipientName}</span></p>

        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted shrink-0">
            <img src={photo} alt={med.name} className="w-full h-full object-cover" />
          </div>
          <div>
            <p className="font-bold text-[17px] text-foreground">{med.name}</p>
            <p className="text-sm text-muted-foreground">Scheduled for {med.time}</p>
          </div>
        </div>

        <label className="block text-sm font-semibold text-foreground mb-2">What time was it taken?</label>
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

        <button
          onClick={() => onConfirm(input24hTo12h(takenInput))}
          className="w-full h-13 py-4 rounded-2xl bg-primary text-primary-foreground text-base font-bold active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
        >
          <Check size={18} strokeWidth={3} />Confirm
        </button>
      </div>
    </div>
  );
}

function MedDetailSheet({ med, onClose, onLogDose }: { med: Medication; onClose: () => void; onLogDose: () => void }) {
  const photo = MED_PHOTOS[med.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format";
  const direction = MED_SIMPLE[med.name] ?? "Take as directed by your doctor.";
  const lowRefill = med.refillDaysLeft !== undefined && med.refillDaysLeft <= 7;
  const supplyDays = med.refillDaysLeft ?? 30;
  const supplyPct = Math.min(100, Math.round((supplyDays / 30) * 100));

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-[320px] overflow-hidden">
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 bg-muted">
            <img src={photo} alt={med.name} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{med.name}</p>
            <p className="text-xs text-muted-foreground">{med.dose} · {med.purpose}</p>
          </div>
          <StatusPill status={med.status} small />
        </div>
        <div className="px-5 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">{direction}</p>
          <p className="text-[11px] text-muted-foreground font-mono">
            {med.status === "taken" ? `Taken at ${med.takenAt}` : `Scheduled ${med.time}`}
          </p>
        </div>
        <div className="px-5 pb-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] text-muted-foreground">Supply remaining</p>
            <p className={`text-[10px] font-bold ${lowRefill ? "text-red-600" : "text-foreground"}`}>{supplyDays}/30 days</p>
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${lowRefill ? "bg-red-400" : "bg-primary"}`} style={{ width: `${supplyPct}%` }} />
          </div>
        </div>
        {med.status === "missed" && (
          <div className="px-5 pb-5">
            <button className="w-full bg-orange-50 border border-orange-200 text-orange-700 text-xs font-semibold rounded-xl py-2.5 flex items-center justify-center gap-1.5">
              <Send size={11} /> Send reminder to patient
            </button>
          </div>
        )}
        <div className="flex border-t border-border">
          <button onClick={onClose} className={`flex-1 py-3 text-xs font-semibold text-muted-foreground ${med.status !== "taken" ? "border-r border-border" : ""}`}>
            Close
          </button>
          {med.status !== "taken" && (
            <button onClick={onLogDose} className="flex-1 py-3 text-xs font-semibold text-primary">Log dose</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TimelineScreen({ patient, onLogDose }: { patient: Patient; onLogDose: (medId: number, takenAt?: string) => void }) {
  const [view, setView] = useState<"daily" | "weekly">("daily");
  const today = new Date();
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<Date>(today);
  const [now, setNow] = useState(new Date());
  const [selectedMed, setSelectedMed] = useState<Medication | null>(null);
  const [pendingLogMed, setPendingLogMed] = useState<Medication | null>(null);
  const [activeDot, setActiveDot] = useState<{ medId: number; day: number } | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(id);
  }, []);

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

      {view === "daily" ? (
        <div className="space-y-2" data-tour="cg-schedule">
          {dayMeds.map(med => {
            const { icon: Icon, bg, fg } = rowIconCfg[med.status];
            return (
              <button
                key={med.id}
                onClick={() => setSelectedMed(med)}
                className="w-full flex items-center gap-3 bg-card rounded-2xl border border-border px-4 py-3 text-left active:scale-[0.99] transition-transform"
              >
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${bg}`}>
                  <Icon size={16} className={fg} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{med.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{med.dose}</p>
                </div>
                <StatusPill status={med.status} small />
              </button>
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
                  const isActive = activeDot?.medId === med.id && activeDot.day === i;
                  return (
                    <div
                      key={i}
                      className="relative flex items-center justify-center"
                      onMouseEnter={() => setActiveDot({ medId: med.id, day: i })}
                      onMouseLeave={() => setActiveDot(prev => (prev?.medId === med.id && prev.day === i ? null : prev))}
                      onClick={() => setActiveDot(prev => (prev?.medId === med.id && prev.day === i ? null : { medId: med.id, day: i }))}
                    >
                      <div className={`w-2.5 h-2.5 rounded-full ${weekDotCls[s]}`} />
                      {isActive && (
                        <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-30 whitespace-nowrap bg-foreground text-background text-[10px] font-semibold px-2 py-1 rounded-lg shadow-lg pointer-events-none">
                          {med.name}
                        </div>
                      )}
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

      {selectedMed && (
        <MedDetailSheet
          med={selectedMed}
          onClose={() => setSelectedMed(null)}
          onLogDose={() => { setPendingLogMed(selectedMed); setSelectedMed(null); }}
        />
      )}
      {pendingLogMed && (
        <LogDoseSheet
          med={pendingLogMed}
          recipientName={patient.nickname}
          onClose={() => setPendingLogMed(null)}
          onConfirm={takenAt => { onLogDose(pendingLogMed.id, takenAt); setPendingLogMed(null); }}
        />
      )}
    </div>
  );
}

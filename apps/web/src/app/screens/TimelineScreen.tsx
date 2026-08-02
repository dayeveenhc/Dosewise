import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Send, Check } from "lucide-react";
import type { Patient, Medication, MedStatus } from "../types";
import { StatusPill, MedAvatar } from "../components/shared";
import { MED_SIMPLE } from "../data/medications";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

export function TimelineScreen({ patient, justAddedMed, onSendReminder }: { patient: Patient; justAddedMed?: string | null; onSendReminder: (medName?: string) => void }) {
  const { language } = useLanguage();
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
    taken: { dot: "bg-taken-bg0", line: "border-taken-border" },
    missed: { dot: "bg-missed-bg0", line: "border-missed-border" },
    upcoming: { dot: "bg-upcoming", line: "border-upcoming-border" },
    skipped: { dot: "bg-stone-400", line: "border-stone-200" },
  };
  const weekDotCls: Record<MedStatus, string> = {
    taken: "bg-taken-bg0",
    missed: "bg-missed-bg0",
    upcoming: "bg-upcoming",
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
        <h2 className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "common.schedule")}</h2>
        <span className="text-lg font-mono font-bold text-black">
          {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>

      {/* Week strip */}
      <div className="dw-surface px-3 pt-3 pb-2 mb-4" data-walk="cg-week-strip">
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
            {t(language, "common.today")}
          </button>
        </div>
        <div className="flex gap-1">
          {weekDays.map((d, i) => {
            const todayDay     = isToday(d);
            const selectedDay_ = d.toDateString() === selectedDay.toDateString();
            const pastDay      = isPast(d);
            const adherenceDot = pastDay
              ? ((d.getDate() * 3 + 5) % 10 > 2 ? "bg-taken" : "bg-missed")
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
                <p className={`text-[calc(10px*var(--dw-text,1))] font-semibold ${todayDay ? "text-primary" : selectedDay_ ? "text-primary" : "text-muted-foreground"}`}>
                  {t(language, `day.${d.getDay()}`)}
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
          {t(language, "common.daily")}
        </button>
        <button
          onClick={() => setView("weekly")}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${view === "weekly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          {t(language, "common.weekly")}
        </button>
      </div>

      {view === "daily" ? (
        <div className="relative">
          {dayMeds.map((med, i) => {
            const cfg = statusConfig[med.status];
            const direction = MED_SIMPLE[med.name] ?? t(language, "home.takeAsDirected");
            const lowRefill = med.refillDaysLeft !== undefined && med.refillDaysLeft <= 7;
            const supplyDays = med.refillDaysLeft ?? 30;
            const supplyPct = Math.min(100, Math.round((supplyDays / 30) * 100));
            // Highlight (and prove) a just-added medication is on the timeline —
            // keyed by name because the slot id re-hashes on refetch.
            const justAdded = isSelectedToday && !!justAddedMed && med.name === justAddedMed;
            return (
              <div key={med.id} className="flex gap-4 mb-1">
                {/* Timeline rail */}
                <div className="flex flex-col items-center w-6 shrink-0 pt-1">
                  <div className={`w-3 h-3 rounded-full shrink-0 ${cfg.dot} shadow-sm`} />
                  {i < dayMeds.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                </div>
                {/* Entry — home-page schedule card styling. data-testid keys the
                    caregiver-side dose ChangeHighlight (entity_id = medication uuid). */}
                <div data-testid={med.medicationId ? `medication-${med.medicationId}` : undefined} className={`flex-1 mb-4 bg-card rounded-2xl border shadow-sm overflow-hidden ${justAdded ? "border-2 border-taken ring-2 ring-taken/40" : cfg.line}`}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <MedAvatar name={med.name} size={44} className="rounded-lg shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-foreground">{med.name}{med.dose ? ` · ${med.dose}` : ""}</p>
                        {justAdded && (
                          <span className="flex items-center gap-1 bg-taken-bg text-taken-fg text-[calc(10px*var(--dw-text,1))] font-bold px-2 py-0.5 rounded-full">
                            <Check size={9} strokeWidth={3} />{t(language, "prescription.justAdded")}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{direction}</p>
                      <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground font-mono mt-0.5 whitespace-nowrap">
                        {med.status === "taken" ? `Taken at ${med.takenAt}` : `Scheduled ${med.time}`}
                      </p>
                    </div>
                    <StatusPill status={med.status} small />
                  </div>
                  <div className="px-4 pb-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.supply")}</p>
                      <p className={`text-[calc(10px*var(--dw-text,1))] font-bold ${lowRefill ? "text-red-600" : "text-foreground"}`}>{supplyDays}/30 days</p>
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
                      <button onClick={() => onSendReminder(med.name)} className="w-full bg-missed-bg border border-missed-border text-missed-fg text-xs font-semibold rounded-xl py-2 flex items-center justify-center gap-1.5">
                        <Send size={11} /> {t(language, "common.sendReminder")} to patient
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="dw-surface overflow-hidden">
          {/* Week header */}
          <div className="grid grid-cols-[1fr_repeat(7,28px)] gap-1 px-3 pt-3 pb-2 border-b border-border">
            <span />
            {weekDays.map((d, i) => (
              <div key={i} className="flex flex-col items-center">
                <span className={`text-[calc(9px*var(--dw-text,1))] font-semibold ${isToday(d) ? "text-primary" : "text-muted-foreground"}`}>{t(language, `day.${d.getDay()}`)}</span>
                <span className={`text-[calc(11px*var(--dw-text,1))] font-bold ${isToday(d) ? "text-primary" : "text-foreground"}`}>{d.getDate()}</span>
              </div>
            ))}
          </div>
          {/* Rows per medication */}
          <div className="divide-y divide-border">
            {patient.medications.map(med => (
              <div key={med.id} className="grid grid-cols-[1fr_repeat(7,28px)] gap-1 items-center px-3 py-2.5">
                <div className="min-w-0 pr-2">
                  <p className="text-xs font-semibold text-foreground truncate">{med.name}</p>
                  <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground">{med.time}</p>
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
            <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] text-muted-foreground"><div className="w-2 h-2 rounded-full bg-taken-bg0" />{t(language, "common.taken")}</span>
            <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] text-muted-foreground"><div className="w-2 h-2 rounded-full bg-missed-bg0" />{t(language, "common.missed")}</span>
            <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] text-muted-foreground"><div className="w-2 h-2 rounded-full bg-upcoming" />{t(language, "common.upcoming")}</span>
            <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] text-muted-foreground"><span className="text-muted-foreground/40">✕</span>{t(language, "common.notDue")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Send, Check, X, Minus } from "lucide-react";
import type { Patient, Medication, MedStatus } from "../types";
import { StatusPill, MedAvatar } from "../components/shared";
import { MED_SIMPLE } from "../data/medications";
import { DASH_DAYS } from "../lib/constants";
import { isDueOn, cadenceLabel, WEEKDAY_TOKENS } from "../lib/medications";
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
    taken: { dot: "bg-taken", line: "border-taken-border" },
    missed: { dot: "bg-missed", line: "border-missed-border" },
    upcoming: { dot: "bg-upcoming", line: "border-upcoming-border" },
    skipped: { dot: "bg-muted-foreground/40", line: "border-border" },
  };
  // Weekly grid cells — all circles. Something that HAPPENED is filled and
  // carries a glyph (so the week reads without relying on hue alone, which is
  // what keeps it legible under the colour-vision modes); something that hasn't
  // happened yet is an empty grey ring, and a day the medicine isn't due at all
  // is an empty DOTTED ring. Nothing pending ever gets a colour of its own.
  const weekCell: Record<MedStatus, { cls: string; icon: React.ReactNode }> = {
    taken:    { cls: "bg-taken-bg border-taken-border text-taken-fg",    icon: <Check size={12} strokeWidth={3} /> },
    missed:   { cls: "bg-missed-bg border-missed-border text-missed-fg", icon: <X size={12} strokeWidth={3} /> },
    upcoming: { cls: "bg-transparent border-muted-foreground/35",        icon: null },
    skipped:  { cls: "bg-muted border-border text-muted-foreground",     icon: <Minus size={12} strokeWidth={3} /> },
  };
  const NOT_DUE_CELL = "bg-transparent border-dashed border-muted-foreground/35";

  // Not every medication is due every day. This now reads the medication's REAL
  // cadence (medications.schedule.days / interval_days, set when it was added)
  // instead of the old hardcoded "Celecoxib is every 2 days" demo special-case.
  const isDueOnDay = (med: Medication, day: Date): boolean => isDueOn(med, day);

  // "Mon, Thu" / "Every 2 days", or nothing at all for a plain daily medicine.
  const cadenceFor = (med: Medication) => cadenceLabel(
    med,
    Object.fromEntries(WEEKDAY_TOKENS.map(d => [d, t(language, `common.dayShort.${d}`)])),
    n => t(language, "prescription.everyNDays", { n }),
  );

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

  // One day's doses, already filtered to what was actually due — the same source
  // the grid cells and the week strip's progress bars read, so a column, its bar
  // and the week total can never disagree.
  const dayDoses = (day: Date) =>
    patient.medications.filter(m => isDueOnDay(m, day)).map(m => statusForDay(m, day));

  const dayScore = (day: Date) => {
    const doses = dayDoses(day);
    const taken = doses.filter(s => s === "taken").length;
    // Nothing has been "missed" in the future, so an upcoming day has no score
    // to report — null, rather than a misleading 0%.
    return { taken, total: doses.length, done: isPast(day) || isToday(day) ? doses.filter(s => s !== "upcoming").length : 0 };
  };

  const weekTaken  = weekDays.filter(d => !(d > today && !isToday(d))).flatMap(dayDoses).filter(s => s === "taken").length;
  const weekMissed = weekDays.filter(d => !(d > today && !isToday(d))).flatMap(dayDoses).filter(s => s === "missed").length;
  const weekPct = weekTaken + weekMissed > 0 ? Math.round((weekTaken / (weekTaken + weekMissed)) * 100) : null;

  const toMin = (t: string) => {
    const [h, m] = t.replace(/ (AM|PM)/, "").split(":").map(Number);
    const isPM = t.includes("PM") && h !== 12;
    return (isPM ? h + 12 : h === 12 && t.includes("AM") ? 0 : h) * 60 + m;
  };
  const dayMeds = patient.medications
    .filter(m => isDueOnDay(m, selectedDay))
    .map(m => ({ ...m, status: statusForDay(m, selectedDay) as MedStatus }))
    .sort((a, b) => toMin(a.time) - toMin(b.time));

  return (
    <div className="px-4 py-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="dw-display text-[calc(20px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "common.schedule")}</h2>
        <span className="text-lg font-mono font-bold text-foreground">
          {now.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>

      {/* Week strip — each day carries its own adherence bar rather than a dot,
          so "how did Tuesday go" is answerable at a glance instead of only
          "green or red". */}
      <div className="dw-surface px-3 pt-3 pb-3 mb-3" data-walk="cg-week-strip">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-0.5">
            <button onClick={() => setWeekOffset(o => o - 1)} aria-label={t(language, "common.previousWeek")} className="w-8 h-8 rounded-full flex items-center justify-center active:bg-muted transition-colors">
              <ChevronLeft size={17} className="text-foreground" />
            </button>
            <span className="text-[calc(13px*var(--dw-text,1))] font-bold text-foreground px-1">{weekLabel}</span>
            <button onClick={() => setWeekOffset(o => o + 1)} aria-label={t(language, "common.nextWeek")} className="w-8 h-8 rounded-full flex items-center justify-center active:bg-muted transition-colors">
              <ChevronRight size={17} className="text-foreground" />
            </button>
          </div>
          <button
            onClick={() => { setSelectedDay(new Date()); setWeekOffset(0); }}
            className={`flex items-center gap-1.5 text-[calc(12px*var(--dw-text,1))] font-bold px-3 py-1.5 rounded-full transition-all ${
              isSelectedToday && weekOffset === 0
                ? "bg-secondary text-primary cursor-default"
                : "bg-primary text-primary-foreground active:opacity-80"
            }`}
          >
            <Clock size={12} />
            {t(language, "common.today")}
          </button>
        </div>
        <div className="flex gap-1">
          {weekDays.map((d, i) => {
            const todayDay     = isToday(d);
            const selectedDay_ = d.toDateString() === selectedDay.toDateString();
            const future       = d > today && !todayDay;
            const { taken, total, done } = dayScore(d);
            const pct = done > 0 ? Math.round((taken / done) * 100) : 0;

            return (
              <button
                key={i}
                disabled={view === "weekly"}
                onClick={() => setSelectedDay(d)}
                aria-current={selectedDay_ ? "date" : undefined}
                className={`flex-1 flex flex-col items-center gap-1 pt-1.5 pb-2 rounded-2xl border transition-colors
                  ${selectedDay_ ? "bg-secondary border-primary" : "border-transparent"}
                  ${todayDay && !selectedDay_ ? "bg-secondary/50" : ""}
                  ${!selectedDay_ && view === "daily" ? "active:bg-muted/50" : ""}
                  ${view === "weekly" ? "cursor-default" : ""}
                `}
              >
                <p className={`text-[calc(10px*var(--dw-text,1))] font-bold uppercase ${todayDay || selectedDay_ ? "text-primary" : "text-muted-foreground"}`}>
                  {DASH_DAYS[d.getDay()]}
                </p>
                <p className={`text-[calc(15px*var(--dw-text,1))] font-bold leading-none ${todayDay || selectedDay_ ? "text-primary" : "text-foreground"}`}>
                  {d.getDate()}
                </p>
                {/* Filled portion = doses taken out of those already due. A day
                    with nothing scored yet (future, or all still upcoming) gets
                    a faint empty track, never a red-looking 0%. */}
                <div className={`w-full max-w-[22px] h-1.5 rounded-full overflow-hidden ${done > 0 ? "bg-muted" : "bg-border/50"}`} title={future ? "" : `${taken}/${total}`}>
                  {!future && done > 0 && (
                    <div className={`h-full rounded-full ${pct >= 80 ? "bg-taken" : pct >= 50 ? "bg-warn" : "bg-missed"}`} style={{ width: `${pct}%` }} />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Daily / Weekly toggle */}
      <div className="flex bg-muted/60 rounded-2xl p-1 mb-4">
        <button
          onClick={() => setView("daily")}
          className={`flex-1 py-2 rounded-xl text-[calc(13px*var(--dw-text,1))] font-bold transition-colors ${view === "daily" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
        >
          {t(language, "common.daily")}
        </button>
        <button
          onClick={() => setView("weekly")}
          className={`flex-1 py-2 rounded-xl text-[calc(13px*var(--dw-text,1))] font-bold transition-colors ${view === "weekly" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
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
                    <MedAvatar name={med.name} size={44} className="rounded-xl shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-foreground">{med.name}{med.dose ? ` · ${med.dose}` : ""}</p>
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
                      <p className={`text-[calc(10px*var(--dw-text,1))] font-bold ${lowRefill ? "text-missed-fg" : "text-foreground"}`}>{t(language, "prescription.supplyOfTotal", { days: supplyDays })}</p>
                    </div>
                    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${lowRefill ? "bg-missed" : "bg-primary"}`}
                        style={{ width: `${supplyPct}%` }}
                      />
                    </div>
                  </div>
                  {med.status === "missed" && (
                    <div className="px-4 pb-3">
                      <button onClick={() => onSendReminder(med.name)} className="w-full bg-missed-bg border border-missed-border text-missed-fg text-[calc(12px*var(--dw-text,1))] font-bold rounded-xl py-2.5 flex items-center justify-center gap-1.5 active:opacity-80 transition-opacity">
                        <Send size={12} /> {t(language, "common.sendReminder")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Week at a glance — the one number a caregiver opens this view for,
              with the raw counts behind it so the percentage is never a bare
              claim. */}
          <div className="dw-surface p-4">
            {weekPct === null ? (
              // Nothing has come due yet this week — say that, rather than
              // showing a 0% or a bare dash that reads like a real figure.
              <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{t(language, "common.nothingRecordedWeek")}</p>
            ) : (
              <div className="flex items-center gap-4">
                <div className="shrink-0">
                  <p className="dw-display text-[calc(30px*var(--dw-text,1))] font-semibold leading-none text-primary">{weekPct}%</p>
                  <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground font-semibold mt-1">{t(language, "summary.adherence")}</p>
                </div>
                <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[calc(11px*var(--dw-text,1))] font-bold text-taken-fg bg-taken-bg border border-taken-border rounded-full px-2.5 py-1">
                    <Check size={11} strokeWidth={3} /> {weekTaken} {t(language, "common.taken")}
                  </span>
                  {weekMissed > 0 && (
                    <span className="inline-flex items-center gap-1 text-[calc(11px*var(--dw-text,1))] font-bold text-missed-fg bg-missed-bg border border-missed-border rounded-full px-2.5 py-1">
                      <X size={11} strokeWidth={3} /> {weekMissed} {t(language, "common.missed")}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="dw-surface overflow-hidden">
            {/* Week header — the day column doubles as that day's taken/due
                count, so the grid has a total per column as well as per row. */}
            <div className="grid grid-cols-[minmax(0,1fr)_repeat(7,28px)] gap-x-0.5 px-3 pt-3 pb-2 border-b border-border">
              <span />
              {weekDays.map((d, i) => {
                const { taken, done } = dayScore(d);
                return (
                  <div key={i} className={`flex flex-col items-center rounded-lg py-0.5 ${isToday(d) ? "bg-secondary" : ""}`}>
                    <span className={`text-[calc(9px*var(--dw-text,1))] font-bold uppercase ${isToday(d) ? "text-primary" : "text-muted-foreground"}`}>{DASH_DAYS[d.getDay()]}</span>
                    <span className={`text-[calc(12px*var(--dw-text,1))] font-bold ${isToday(d) ? "text-primary" : "text-foreground"}`}>{d.getDate()}</span>
                    <span className="text-[calc(9px*var(--dw-text,1))] font-mono text-muted-foreground leading-tight">{done > 0 ? `${taken}/${done}` : "·"}</span>
                  </div>
                );
              })}
            </div>
            {/* Rows per medication */}
            <div className="divide-y divide-border">
              {patient.medications.map(med => (
                // The medicine name owns the only flexible column, so the row
                // label stays readable — the daily view carries the pill photo;
                // repeating it here would cost the name most of its width.
                <div key={med.id} className="grid grid-cols-[minmax(0,1fr)_repeat(7,28px)] gap-x-0.5 items-center px-3 py-2">
                  <div className="min-w-0 pr-2">
                    <p className="text-[calc(12px*var(--dw-text,1))] font-bold text-foreground truncate">{med.name}</p>
                    <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground font-mono whitespace-nowrap">
                      {med.time}
                      {cadenceFor(med) ? ` · ${cadenceFor(med)}` : ""}
                    </p>
                  </div>
                  {weekDays.map((d, i) => {
                    if (!isDueOnDay(med, d)) {
                      return (
                        <div key={i} className="flex items-center justify-center">
                          <div className={`w-6 h-6 rounded-full border-[1.5px] ${NOT_DUE_CELL}`} />
                        </div>
                      );
                    }
                    const cell = weekCell[statusForDay(med, d)];
                    return (
                      <div key={i} className="flex items-center justify-center">
                        <div className={`w-6 h-6 rounded-full border-[1.5px] flex items-center justify-center ${cell.cls}`}>
                          {cell.icon}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              {patient.medications.length === 0 && (
                <p className="px-4 py-8 text-center text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.empty")}</p>
              )}
            </div>
            <div className="flex items-center gap-3 px-4 py-3 border-t border-border flex-wrap">
              <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] font-semibold text-muted-foreground"><span className="w-4 h-4 rounded-full border-[1.5px] bg-taken-bg border-taken-border text-taken-fg flex items-center justify-center"><Check size={9} strokeWidth={3} /></span>{t(language, "common.taken")}</span>
              <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] font-semibold text-muted-foreground"><span className="w-4 h-4 rounded-full border-[1.5px] bg-missed-bg border-missed-border text-missed-fg flex items-center justify-center"><X size={9} strokeWidth={3} /></span>{t(language, "common.missed")}</span>
              <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] font-semibold text-muted-foreground"><span className="w-4 h-4 rounded-full border-[1.5px] bg-transparent border-muted-foreground/35" />{t(language, "common.upcoming")}</span>
              <span className="flex items-center gap-1.5 text-[calc(10px*var(--dw-text,1))] font-semibold text-muted-foreground"><span className="w-4 h-4 rounded-full border-[1.5px] border-dashed bg-transparent border-muted-foreground/35" />{t(language, "common.notDue")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

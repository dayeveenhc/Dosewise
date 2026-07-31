import { useState } from "react";
import { Plus, BookOpen, ChevronDown, History, Check, RefreshCw, ShieldAlert } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Medication, Patient } from "../../types";
import { to24h, isRunningLow } from "../../lib/medications";
import { MED_PLAIN, MED_SIMPLE, MED_SHAPES, EYEDROP_STEPS } from "../../data/medications";
import { MedAvatar } from "../../components/shared";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

interface GroupedMed extends Medication { times: string[] }

// Collapse the schedule's per-time-slot entries back into one entry per real
// medication, keeping every time it's taken. Falls back to the name as the key
// for demo/seed data that has no `medicationId`.
function groupByMedication(meds: Medication[]): GroupedMed[] {
  const byKey = new Map<string, GroupedMed>();
  const out: GroupedMed[] = [];
  for (const m of meds) {
    const existing = byKey.get(m.medicationId ?? m.name);
    if (existing) {
      if (!existing.times.includes(m.time)) existing.times.push(m.time);
      continue;
    }
    const grouped: GroupedMed = { ...m, times: [m.time] };
    byKey.set(m.medicationId ?? m.name, grouped);
    out.push(grouped);
  }
  for (const g of out) g.times.sort((a, b) => to24h(a).localeCompare(to24h(b)));
  return out;
}

export function ElderlyPrescriptionScreen({ patient, onAddRx, onRequestRefill, justAddedMed }: {
  patient: Patient;
  onAddRx: () => void;
  // Opens Ask Mei with a refill message PRE-FILLED (never auto-sent — the
  // elder still taps Send themselves), so nothing is sent on their behalf.

  onRequestRefill: (medName: string) => void;
  justAddedMed?: string | null;
}) {
  const { colourBlind } = useAccessibility();
  const { language } = useLanguage();
  const [helpOpen, setHelpOpen] = useState<number | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const pastMedications = patient.pastMedications ?? [];
  // `patient.medications` is one entry per (medication, time-slot) — right for the
  // schedule, wrong here: a twice-daily pill is one prescription, not two. Group
  // back by medication and keep its times for the schedule indicator.
  const prescriptions = groupByMedication(patient.medications);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-3 pb-28 space-y-3">

        {/* Grey and borderless: it's standing advice, not an alert about
            anything happening right now — the warn palette overstated it. */}
        <div className="bg-muted/50 rounded-2xl px-3.5 py-3 flex items-start gap-2.5">
          <ShieldAlert size={18} className="text-muted-foreground shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[14px] font-bold text-foreground/85 leading-tight mb-0.5">{t(language, "prescription.safetyTitle")}</p>
            <p className="text-[13px] text-muted-foreground leading-relaxed">{t(language, "prescription.disclaimer")}</p>
          </div>
        </div>

        {/* Count and the add action share one row, so the button sits in the
            corner opposite the title rather than eating a full-width band. */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-bold text-foreground min-w-0 truncate">{t(language, "prescription.count", { count: prescriptions.length })}</h2>
          <button
            onClick={onAddRx}
            data-tour="elder-add-prescription"
            aria-label={t(language, "prescription.add")}
            className="h-9 px-3.5 bg-primary text-primary-foreground rounded-full text-[15px] font-bold flex items-center gap-1.5 shrink-0 dw-press"
          >
            <Plus size={17} strokeWidth={3} className="shrink-0" />{t(language, "prescription.addShort")}
          </button>
        </div>

        {/* Medication cards — tour target framed tightly around just these, not the whole page */}
        <div data-tour="elder-medlist" className="space-y-3">
        {prescriptions.length === 0 && (
          <div className="bg-muted/40 rounded-2xl p-6 text-center">
            <p className="text-[14px] text-muted-foreground">{t(language, "prescription.empty")}</p>
          </div>
        )}
        {prescriptions.map(m => {
          const plain       = MED_PLAIN[m.name];
          const direction   = MED_SIMPLE[m.name] ?? t(language, "home.takeAsDirected");
          const shape       = MED_SHAPES[m.name];
          const lowRefill   = m.refillDaysLeft !== undefined && m.refillDaysLeft <= 7;
          const supplyDays  = m.refillDaysLeft ?? 30;
          const supplyPct   = Math.min(100, Math.round((supplyDays / 30) * 100));
          // Only offered once it's actually worth acting on. A refill can still
          // be asked for at any time from Ask Mei → My medicines → Request refill.
          const needsRefill = isRunningLow(m);
          const isEyeDrop   = m.name === "Latanoprost Eye Drops";
          const isHelpOpen  = helpOpen === m.id;
          const justAdded   = !!justAddedMed && m.name === justAddedMed;

          return (
            <div key={m.id} data-testid={m.medicationId ? `medication-${m.medicationId}` : undefined} className={`bg-card rounded-2xl border overflow-hidden shadow-sm ${justAdded ? "border-2 border-taken ring-2 ring-taken/40" : "border-border"}`}>
              <div className="p-3.5">
                {/* Badges get their own strip so a long medicine name keeps the
                    full column width (same reason as the Home card). */}
                {justAdded && (
                  <div className="flex items-center gap-1.5 flex-wrap mb-2">
                    <span className="flex items-center gap-1 bg-taken-bg text-taken-fg border border-taken-border text-[12px] font-bold px-2 py-0.5 rounded-full">
                      <Check size={11} strokeWidth={3} />{t(language, "prescription.justAdded")}
                    </span>
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <MedAvatar name={m.name} size={48} className="rounded-xl shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-[17px] text-foreground leading-tight break-words">{m.name}</p>
                    {/* Instructions first (most actionable), then the reason.
                        Both align flush under the name now that the leading
                        colour dot is gone. */}
                    <p className="text-[14px] font-semibold text-foreground leading-snug mt-1">{direction}</p>
                    <p className="text-[13px] text-muted-foreground leading-snug mt-0.5">
                      {plain?.why ?? t(language, "prescription.forPurpose", { purpose: m.purpose.toLowerCase() })}
                    </p>
                    {colourBlind && shape && (
                      <p className="text-[13px] text-muted-foreground mt-1">{shape.shape} · {shape.marking}</p>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {m.times.map(time => (
                    <span key={time} className="text-[15px] font-bold text-secondary-foreground bg-secondary border border-primary/20 rounded-lg px-2.5 py-1.5 whitespace-nowrap">
                      {time}
                    </span>
                  ))}
                </div>

                {/* Supply bar — always shown */}
                <div className="mt-3.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[13px] text-muted-foreground">{t(language, "prescription.supply")}</p>
                    <p className={`text-[13px] font-bold ${lowRefill ? "text-missed-fg" : "text-foreground"}`}>{t(language, "prescription.supplyOfTotal", { days: supplyDays })}</p>
                  </div>
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${lowRefill ? "bg-missed" : "bg-primary"}`}
                      style={{ width: `${supplyPct}%` }}
                    />
                  </div>
                </div>

                {/* How to take it sits above Request refill — using it correctly
                    matters before whether more is needed. */}
                {isEyeDrop && (
                  <button
                    onClick={() => setHelpOpen(isHelpOpen ? null : m.id)}
                    className={`mt-3 w-full flex items-center gap-2.5 px-3.5 h-11 rounded-xl text-[14px] font-bold border transition-colors ${
                      isHelpOpen ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-secondary-foreground border-primary/20"
                    }`}
                  >
                    <BookOpen size={17} className="shrink-0" />
                    <span className="text-left leading-tight">{t(language, "prescription.howToUseEyeDrops")}</span>
                    <ChevronDown size={17} className={`ml-auto shrink-0 transition-transform ${isHelpOpen ? "rotate-180" : ""}`} />
                  </button>
                )}

                {needsRefill && (
                  <button
                    onClick={() => onRequestRefill(m.name)}
                    data-walk="med-request-refill-btn"
                    className="mt-2.5 w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-border text-[14px] font-bold text-foreground active:bg-muted transition-colors"
                  >
                    <RefreshCw size={17} className="shrink-0" />{t(language, "prescription.requestRefill")}
                  </button>
                )}
              </div>

              {/* Eye drop detailed instructions */}
              {isEyeDrop && isHelpOpen && (
                <div className="px-4 pb-4 pt-3 border-t border-border/40 space-y-2.5 bg-secondary/30">
                  <p className="text-[14px] font-bold text-primary uppercase tracking-wider mb-1">{t(language, "prescription.stepByStepGuide")}</p>
                  {EYEDROP_STEPS.map((step, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                        <span className="text-[14px] font-bold text-primary-foreground">{i + 1}</span>
                      </div>
                      <p className="text-[14px] text-foreground leading-snug pt-0.5">
                        <span className="mr-1.5">{step.icon}</span>{step.text}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        </div>

        {pastMedications.length > 0 && (
          <div className="dw-surface overflow-hidden">
            <button
              onClick={() => setPastOpen(v => !v)}
              className="w-full flex items-center gap-2.5 px-4 py-4 text-[15px] font-bold text-foreground"
            >
              <History size={19} className="text-muted-foreground shrink-0" />
              {t(language, "prescription.past")}
              <span className="text-[14px] font-bold text-muted-foreground bg-muted rounded-full px-2.5 py-0.5">{pastMedications.length}</span>
              <ChevronDown size={18} className={`ml-auto text-muted-foreground transition-transform ${pastOpen ? "rotate-180" : ""}`} />
            </button>
            {pastOpen && (
              <div className="divide-y divide-border border-t border-border">
                {pastMedications.map(m => (
                  <div key={m.id} className="px-4 py-3.5">
                    <p className="text-[15px] font-bold text-muted-foreground">{m.name} <span className="text-[14px] font-normal">{m.dose}</span></p>
                    <p className="text-[14px] text-muted-foreground/80">{m.purpose}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { Plus, BookOpen, ChevronDown, Play, Eye, History, Check } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_PLAIN, MED_SIMPLE, MED_SHAPES, EYEDROP_STEPS } from "../../data/medications";
import { MedAvatar } from "../../components/shared";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

export function ElderlyPrescriptionScreen({ patient, onOpenAI, onAddRx, justAddedMed }: { patient: Patient; onOpenAI: (msg?: string) => void; onAddRx: () => void; justAddedMed?: string | null }) {
  const { colourBlind } = useAccessibility();
  const { language } = useLanguage();
  const [helpOpen, setHelpOpen] = useState<number | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const pastMedications = patient.pastMedications ?? [];

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-2 pb-28 space-y-3">

        {/* Header */}
        <div className="flex items-center justify-between pt-1">
          <p className="text-sm text-muted-foreground">{t(language, "prescription.count", { count: patient.medications.length })}</p>
          <button
            onClick={onAddRx}
            data-tour="elder-add-prescription"
            className="h-9 px-3 bg-primary text-primary-foreground rounded-xl text-xs font-semibold flex items-center gap-1 whitespace-nowrap active:scale-95 transition-transform"
          >
            <Plus size={13} className="shrink-0" />{t(language, "prescription.add")}
          </button>
        </div>

        {/* Medication cards — tour target framed tightly around just these, not the whole page */}
        <div data-tour="elder-medlist" className="space-y-3">
        {patient.medications.length === 0 && (
          <div className="bg-muted/40 rounded-2xl p-6 text-center">
            <p className="text-sm text-muted-foreground">{t(language, "prescription.empty")}</p>
          </div>
        )}
        {patient.medications.map(m => {
          const plain       = MED_PLAIN[m.name];
          const direction   = MED_SIMPLE[m.name] ?? t(language, "home.takeAsDirected");
          const shape       = MED_SHAPES[m.name];
          const lowRefill   = m.refillDaysLeft !== undefined && m.refillDaysLeft <= 7;
          const supplyDays  = m.refillDaysLeft ?? 30;
          const supplyPct   = Math.min(100, Math.round((supplyDays / 30) * 100));
          const isEyeDrop   = m.name === "Latanoprost Eye Drops";
          const isHelpOpen  = helpOpen === m.id;
          const justAdded   = !!justAddedMed && m.name === justAddedMed;

          return (
            <div key={m.id} className={`bg-card rounded-2xl border overflow-hidden shadow-sm ${justAdded ? "border-2 border-emerald-400 ring-2 ring-emerald-300/50" : "border-border"}`}>
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <MedAvatar name={m.name} size={62} className="rounded-xl shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <p className="font-bold text-[17px] text-foreground leading-snug">{m.name}</p>
                        {justAdded && (
                          <span className="flex items-center gap-1 bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                            <Check size={9} strokeWidth={3} />{t(language, "prescription.justAdded")}
                          </span>
                        )}
                      </div>
                      {lowRefill && (
                        <span className="shrink-0 text-xs font-bold text-red-600 bg-red-100 px-2.5 py-1 rounded-full whitespace-nowrap">
                          {t(language, "prescription.daysLeftBadge", { days: m.refillDaysLeft ?? 0 })}
                        </span>
                      )}
                    </div>
                    {/* Instructions first — most actionable */}
                    <div className="flex items-center gap-1.5 mt-1">
                      {colourBlind ? (
                        <Eye size={11} className="shrink-0 text-primary" />
                      ) : (
                        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: m.colour }} />
                      )}
                      <p className="text-sm font-semibold text-foreground">{direction}</p>
                    </div>
                    {/* Purpose second — context */}
                    <p className="text-xs text-muted-foreground mt-1 pl-3">
                      {plain?.why ?? t(language, "prescription.forPurpose", { purpose: m.purpose.toLowerCase() })}
                    </p>
                    {colourBlind && shape && (
                      <p className="text-xs text-muted-foreground mt-1 pl-3">{shape.shape} · {shape.marking}</p>
                    )}
                  </div>
                </div>

                {/* Eye drop help button */}
                {isEyeDrop && (
                  <button
                    onClick={() => setHelpOpen(isHelpOpen ? null : m.id)}
                    className={`mt-3 w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                      isHelpOpen ? "bg-primary text-primary-foreground border-primary" : "bg-muted/50 text-foreground border-border"
                    }`}
                  >
                    <BookOpen size={14} className="shrink-0" />
                    <span>{t(language, "prescription.howToUseEyeDrops")}</span>
                    <ChevronDown size={13} className={`ml-auto shrink-0 transition-transform ${isHelpOpen ? "rotate-180" : ""}`} />
                  </button>
                )}

                {/* Supply bar — always shown */}
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">{t(language, "prescription.supply")}</p>
                    <p className={`text-xs font-bold ${lowRefill ? "text-red-600" : "text-foreground"}`}>{t(language, "prescription.supplyOfTotal", { days: supplyDays })}</p>
                  </div>
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${lowRefill ? "bg-red-400" : "bg-primary"}`}
                      style={{ width: `${supplyPct}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Eye drop detailed instructions */}
              {isEyeDrop && isHelpOpen && (
                <div className="px-4 pb-4 pt-3 border-t border-border/40 space-y-2">
                  <p className="text-xs font-bold text-primary uppercase tracking-wider mb-1">{t(language, "prescription.stepByStepGuide")}</p>
                  {EYEDROP_STEPS.map((step, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
                        <span className="text-xs font-bold text-primary-foreground">{i + 1}</span>
                      </div>
                      <p className="text-sm text-foreground leading-snug pt-1">
                        <span className="mr-1">{step.icon}</span>{step.text}
                      </p>
                    </div>
                  ))}
                  <div className="rounded-xl overflow-hidden border border-border mt-3">
                    <div className="h-24 relative bg-stone-800 flex items-center justify-center">
                      <img src="https://images.unsplash.com/photo-1750125625145-7be950011e4c?w=400&h=200&fit=crop&auto=format" alt={t(language, "prescription.eyeDropsAlt")} className="absolute inset-0 w-full h-full object-cover opacity-60" />
                      <div className="relative z-10 w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-lg">
                        <Play size={14} className="text-foreground ml-0.5" fill="currentColor" />
                      </div>
                    </div>
                    <div className="p-2.5">
                      <p className="text-sm font-semibold text-foreground">{t(language, "prescription.watchHowToUse")}</p>
                      <p className="text-xs text-muted-foreground">{t(language, "prescription.videoGuideLength")}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        </div>

        {pastMedications.length > 0 && (
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <button
              onClick={() => setPastOpen(v => !v)}
              className="w-full flex items-center gap-2 px-4 py-3.5 text-sm font-semibold text-foreground"
            >
              <History size={15} className="text-muted-foreground" />
              {t(language, "prescription.past")}
              <span className="text-xs font-bold text-muted-foreground bg-muted rounded-full px-2 py-0.5">{pastMedications.length}</span>
              <ChevronDown size={14} className={`ml-auto text-muted-foreground transition-transform ${pastOpen ? "rotate-180" : ""}`} />
            </button>
            {pastOpen && (
              <div className="divide-y divide-border border-t border-border">
                {pastMedications.map(m => (
                  <div key={m.id} className="px-4 py-3">
                    <p className="text-sm font-semibold text-muted-foreground">{m.name} <span className="text-xs font-normal">{m.dose}</span></p>
                    <p className="text-xs text-muted-foreground/80">{m.purpose}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="bg-muted/40 rounded-2xl p-4 text-center">
          <p className="text-xs text-muted-foreground leading-relaxed">{t(language, "prescription.disclaimer")}</p>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Plus, BookOpen, ChevronDown, Play, Eye } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_PLAIN, MED_PHOTOS, MED_SIMPLE, MED_SHAPES, EYEDROP_STEPS } from "../../data/medications";

export function ElderlyPrescriptionScreen({ patient, onOpenAI }: { patient: Patient; onOpenAI: (msg?: string) => void }) {
  const { colourBlind } = useAccessibility();
  const [helpOpen, setHelpOpen] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-2 pb-28 space-y-3">

        {/* Header */}
        <div className="flex items-center justify-between pt-1">
          <p className="text-sm text-muted-foreground">{patient.medications.length} medicines</p>
          <button
            onClick={() => onOpenAI("I need a refill or new prescription")}
            className="h-9 px-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold flex items-center gap-1.5 active:scale-95 transition-transform"
          >
            <Plus size={14} />Add refill / prescription
          </button>
        </div>

        {/* Medication cards */}
        {patient.medications.map(m => {
          const plain       = MED_PLAIN[m.name];
          const photo       = MED_PHOTOS[m.name] ?? "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format";
          const direction   = MED_SIMPLE[m.name] ?? "Take as directed by your doctor.";
          const shape       = MED_SHAPES[m.name];
          const lowRefill   = m.refillDaysLeft !== undefined && m.refillDaysLeft <= 7;
          const supplyDays  = m.refillDaysLeft ?? 30;
          const supplyPct   = Math.min(100, Math.round((supplyDays / 30) * 100));
          const isEyeDrop   = m.name === "Latanoprost Eye Drops";
          const isHelpOpen  = helpOpen === m.id;

          return (
            <div key={m.id} className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-[62px] h-[62px] rounded-xl overflow-hidden shrink-0 bg-muted">
                    <img src={photo} alt={m.name} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-bold text-[17px] text-foreground leading-snug">{m.name}</p>
                      {lowRefill && (
                        <span className="shrink-0 text-xs font-bold text-red-600 bg-red-100 px-2.5 py-1 rounded-full whitespace-nowrap">
                          {m.refillDaysLeft}d left
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
                      {plain?.why ?? `For ${m.purpose.toLowerCase()}`}
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
                    <span>How to use eye drops</span>
                    <ChevronDown size={13} className={`ml-auto shrink-0 transition-transform ${isHelpOpen ? "rotate-180" : ""}`} />
                  </button>
                )}

                {/* Supply bar — always shown */}
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">Supply remaining</p>
                    <p className={`text-xs font-bold ${lowRefill ? "text-red-600" : "text-foreground"}`}>{supplyDays}/30 days</p>
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
                  <p className="text-xs font-bold text-primary uppercase tracking-wider mb-1">Step-by-step guide</p>
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
                      <img src="https://images.unsplash.com/photo-1750125625145-7be950011e4c?w=400&h=200&fit=crop&auto=format" alt="Eye drops demonstration" className="absolute inset-0 w-full h-full object-cover opacity-60" />
                      <div className="relative z-10 w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-lg">
                        <Play size={14} className="text-foreground ml-0.5" fill="currentColor" />
                      </div>
                    </div>
                    <div className="p-2.5">
                      <p className="text-sm font-semibold text-foreground">Watch: How to use eye drops</p>
                      <p className="text-xs text-muted-foreground">Video guide · 2 min</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="bg-muted/40 rounded-2xl p-4 text-center">
          <p className="text-xs text-muted-foreground leading-relaxed">Always take medicines exactly as prescribed. Never stop or change your dose without checking with your doctor first.</p>
        </div>
      </div>
    </div>
  );
}

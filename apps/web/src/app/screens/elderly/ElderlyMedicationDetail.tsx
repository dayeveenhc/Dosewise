import { BookOpen, PackagePlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { GroupedMed } from "./ElderlyPrescriptionScreen";
import { cadenceForMed } from "./ElderlyPrescriptionScreen";
import { formatClock, supplyDaysLeft, courseDaysLeft, LOW_SUPPLY_DAYS, REFILL_PROMPT_DAYS } from "../../lib/medications";
import { MED_PLAIN, MED_SIMPLE, MED_SHAPES, EYEDROP_STEPS, localizeCatalogValue } from "../../data/medications";
import { MedAvatar } from "../../components/shared";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

/**
 * One medicine, in full — the page a card taps into.
 *
 * A sub-view of the prescriptions tab (via ElderlyApp's `headerOverride`), the
 * same idiom ElderlySettingsScreen's profile/about pages use, NOT a new
 * ElderlyTab: `lib/alerts.ts::destinationFor`, `changeHighlight.ts`'s
 * ENTITY_TARGETS and every walkthrough step's `screen.tab` are all typed on
 * that union, so widening it would touch the routing of things that have
 * nothing to do with this page.
 *
 * IT MUST NOT CARRY a `data-testid` ending in the medication's uuid. Two
 * separate things break if it does: several e2e specs assert an exact count of
 * `[data-testid^="medication-"]`, and `changeHighlight.ts::findEntityElement`
 * falls back to `[data-testid$="-{id}"]` and takes the FIRST match in document
 * order — so a second element bearing the id silently steals every
 * proof-of-change ring on this screen. `data-med-id` is a plain attribute and
 * is invisible to both.
 */
export function ElderlyMedicationDetail({ med, timeFormat, colourBlind, variant = "page", onEdit, onArchive, onAddRefill, onRequestRefill }: {
  med: GroupedMed;
  timeFormat: "12h" | "24h";
  colourBlind: boolean;
  /**
   * "page" — fills the screen under the app header, clearing the bottom nav.
   * "sheet" — inside a BottomSheet: the shell owns the height, so no `flex-1`
   * and no nav-sized bottom padding.
   */
  variant?: "page" | "sheet";
  onEdit: () => void;
  /** Absent for a demo/local row — there is nothing to archive server-side. */
  onArchive?: () => void;
  onAddRefill: () => void;
  /** The OTHER refill: asks the doctor, via chat. Same low-supply gate the card uses. */
  onRequestRefill: () => void;
}) {
  const { language } = useLanguage();
  const plain = MED_PLAIN[med.name];
  const direction = MED_SIMPLE[med.name] ?? t(language, "home.takeAsDirected");
  const shape = MED_SHAPES[med.name];
  const daysLeft = supplyDaysLeft(med, med.times.length);
  const lowRefill = daysLeft != null && daysLeft < LOW_SUPPLY_DAYS;
  const supplyPct = daysLeft == null ? 0 : Math.min(100, Math.round((daysLeft / 30) * 100));
  const courseLeft = courseDaysLeft(med);
  const courseDone = courseLeft !== null && courseLeft < 0;
  const needsRefill = daysLeft != null && daysLeft < REFILL_PROMPT_DAYS;
  const cadence = cadenceForMed(med, language);

  const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="dw-surface px-4 py-3.5">
      <p className="text-[calc(13px*var(--dw-text,1))] font-bold text-muted-foreground mb-1.5">{label}</p>
      {children}
    </div>
  );

  return (
    <div data-testid="med-detail" data-med-id={med.medicationId} className={`flex flex-col min-h-0 ${variant === "page" ? "flex-1" : ""}`}>
      <div className={`overflow-y-auto scrollbar-none px-4 py-3 space-y-3 ${variant === "page" ? "flex-1 pb-28" : "pb-4"}`}>

        {/* Identity */}
        <div className="dw-surface px-4 py-4 flex items-start gap-3.5">
          <MedAvatar name={med.name} size={72} className="rounded-2xl shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-bold text-[calc(19px*var(--dw-text,1))] text-foreground leading-tight break-words">{med.name}</p>
            {med.dose && <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-muted-foreground mt-0.5">{med.dose}</p>}
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-snug mt-1.5">
              {plain ? t(language, plain.whyKey) : t(language, "prescription.forPurpose", { purpose: localizeCatalogValue(med.purpose, k => t(language, k)).toLowerCase() })}
            </p>
            {colourBlind && shape && (
              <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground mt-1.5">{shape.shape} · {shape.marking}</p>
            )}
          </div>
        </div>

        <Section label={t(language, "prescription.directions")}>
          <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{direction}</p>
          {plain?.instructions && (
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-relaxed mt-1">{plain.instructions}</p>
          )}
        </Section>

        <Section label={t(language, "prescription.scheduledTimes")}>
          <div className="flex flex-wrap gap-2">
            {med.times.map(time => (
              <span key={time} className="text-[calc(15px*var(--dw-text,1))] font-bold text-secondary-foreground bg-secondary border border-primary/20 rounded-lg px-2.5 py-1 whitespace-nowrap">
                {formatClock(time, timeFormat)}
              </span>
            ))}
          </div>
          <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground mt-2">
            {t(language, "prescription.howOften")}: {cadence ?? t(language, "prescription.everyDay")}
          </p>
          {courseLeft !== null && (
            <p className={`text-[calc(14px*var(--dw-text,1))] font-bold mt-1.5 ${courseDone ? "text-muted-foreground" : courseLeft <= 3 ? "text-warn-fg" : "text-foreground"}`}>
              {courseDone ? t(language, "prescription.courseFinished")
                : courseLeft === 0 ? t(language, "prescription.courseEndsToday")
                : t(language, "prescription.courseEndsInDays", { days: courseLeft })}
            </p>
          )}
        </Section>

        {/* Unlike the card, which hides this block entirely when there is no
            data, the detail page says so — someone who opened the page to check
            their supply deserves an answer, not an absence. */}
        <Section label={t(language, "prescription.supply")}>
          {daysLeft == null ? (
            <p className="text-[calc(15px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.noSupplyData")}</p>
          ) : (
            <>
              <p className={`text-[calc(15px*var(--dw-text,1))] font-bold ${lowRefill ? "text-missed-fg" : "text-foreground"}`}>
                {t(language, "prescription.daysLeft", { days: daysLeft })}
              </p>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden mt-2">
                <div className={`h-full rounded-full ${lowRefill ? "bg-missed" : "bg-primary"}`} style={{ width: `${supplyPct}%` }} />
              </div>
            </>
          )}
        </Section>

        {med.name === "Latanoprost Eye Drops" && (
          <div className="dw-surface px-4 py-3.5">
            <p className="flex items-center gap-2 text-[calc(13px*var(--dw-text,1))] font-bold text-primary uppercase tracking-wider mb-2.5">
              <BookOpen size={16} className="shrink-0" />{t(language, "prescription.stepByStepGuide")}
            </p>
            <div className="space-y-2.5">
              {EYEDROP_STEPS.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <span className="text-[calc(14px*var(--dw-text,1))] font-bold text-primary-foreground">{i + 1}</span>
                  </div>
                  <p className="text-[calc(14px*var(--dw-text,1))] text-foreground leading-snug pt-0.5">
                    <span className="mr-1.5">{step.icon}</span>{t(language, step.textKey)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions. Edit leads; removal is last and visually separate, because
            it is the only one that changes what is on the list. */}
        <div className="space-y-2 pt-1">
          <button
            data-walk="med-detail-edit-btn"
            onClick={onEdit}
            className="w-full flex items-center justify-center gap-2 h-12 rounded-2xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-bold dw-press"
          >
            <Pencil size={17} className="shrink-0" />{t(language, "common.edit")}
          </button>

          <button
            data-walk="med-detail-refill-btn"
            onClick={onAddRefill}
            className="w-full flex items-center justify-center gap-2 h-12 rounded-2xl border border-border bg-card text-foreground text-[calc(15px*var(--dw-text,1))] font-bold active:bg-muted transition-colors"
          >
            <PackagePlus size={17} className="shrink-0" />{t(language, "prescription.addRefill")}
          </button>

          {needsRefill && !courseDone && (
            <button
              onClick={onRequestRefill}
              className="w-full flex items-center justify-center gap-2 h-12 rounded-2xl border border-border bg-card text-foreground text-[calc(15px*var(--dw-text,1))] font-bold active:bg-muted transition-colors"
            >
              <RefreshCw size={17} className="shrink-0" />{t(language, "prescription.requestRefill")}
            </button>
          )}

          {onArchive && (
            <button
              data-walk="med-detail-archive-btn"
              onClick={onArchive}
              className="w-full flex items-center justify-center gap-2 h-12 rounded-2xl border border-missed-border bg-missed-bg text-missed-fg text-[calc(15px*var(--dw-text,1))] font-bold active:opacity-80 transition-opacity mt-3"
            >
              <Trash2 size={17} className="shrink-0" />{t(language, "prescription.removeFromList")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

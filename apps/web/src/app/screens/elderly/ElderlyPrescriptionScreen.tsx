import { useState, useEffect } from "react";
import { Plus, BookOpen, ChevronDown, History, Check, RefreshCw, ShieldAlert, PackagePlus, X } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { Medication, Patient } from "../../types";
import { to24h, formatClock, supplyDaysLeft, cadenceLabel, courseDaysLeft, WEEKDAY_TOKENS, LOW_SUPPLY_DAYS, REFILL_PROMPT_DAYS } from "../../lib/medications";
import { MED_PLAIN, MED_SIMPLE, MED_SHAPES, EYEDROP_STEPS, localizeCatalogValue } from "../../data/medications";
import { MedAvatar } from "../../components/shared";
import { AddRefillSheet } from "../../components/AddRefillSheet";
import { BottomSheet } from "../../components/BottomSheet";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ElderlyMedicationDetail } from "./ElderlyMedicationDetail";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import type { AppLanguage } from "../../lib/language";

export interface GroupedMed extends Medication { times: string[] }

// "Mon, Thu" / "Every 2 days" — undefined for a plain daily medicine.
// Module-level so the detail page renders the exact same phrase as the card;
// it used to be a closure in the component and there was nowhere to share it
// from.
export function cadenceForMed(m: Medication, language: AppLanguage): string | undefined {
  return cadenceLabel(
    m,
    Object.fromEntries(WEEKDAY_TOKENS.map(d => [d, t(language, `common.dayShort.${d}`)])),
    n => t(language, "prescription.everyNDays", { n }),
  );
}

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

export function ElderlyPrescriptionScreen({ patient, onAddRx, onRequestRefill, onEditRx, onArchiveRx, onAddRefill, walkthroughResetSignal, justAddedMed, highlightIds, focusMed, onFocusMedConsumed }: {
  patient: Patient;
  onAddRx: () => void;
  // Opens Ask Mei with a refill message PRE-FILLED (never auto-sent — the
  // elder still taps Send themselves), so nothing is sent on their behalf.

  onRequestRefill: (medName: string) => void;
  // Opens AddPrescriptionSheet pre-filled with this medication so the elder
  // can correct it, from the detail popup's Edit button.
  onEditRx: (med: GroupedMed) => void;
  // Archives a medicine whose fixed course has run out. Deliberately a tap the
  // person makes, never an automatic write: archiving is the same state
  // discontinue_medication sets, so a medicine leaves the active list only when
  // somebody says so.
  // Widened to a promise so the detail page can close BEFORE the write lands —
  // the handler refetches, and the page holds a snapshot of a medicine that is
  // about to leave the list.
  onArchiveRx?: (med: GroupedMed) => void | Promise<void>;
  // Records the supply on hand (lib/medications.ts::logRefill). A different
  // action from onRequestRefill, which asks the DOCTOR via chat.
  onAddRefill: (med: GroupedMed, pillsRemaining: number) => Promise<void>;
  // Bumped when a walkthrough or tour starts. MANDATORY for this screen: the
  // steps that spotlight `elder-medlist` / `elder-add-prescription` /
  // `med-request-refill-btn` carry `onEnter: {tab: "prescriptions"}`, which is
  // a NO-OP when the tab is already prescriptions — so a detail page left open
  // hides every one of those targets and a waitFor step (which has no Next)
  // can never advance.
  walkthroughResetSignal?: number;
  justAddedMed?: string | null;
  // Entity ids ChangeHighlight is currently trying to ring. Stopped medicines
  // live behind a collapsed accordion, so a discontinue highlight had nothing
  // to find and gave up silently — this lets the screen reveal its own content
  // rather than requiring the highlight layer to know about our accordions.
  highlightIds?: string[];
  // "You were sent here BY an alert about this medicine" — open its detail card
  // instead of dropping the person into a list to search. Nullable-value the
  // child clears (onFocusMedConsumed), the same idiom as ElderlyAIScreen's
  // prefillMessage; carries a name as well as an id because a demo/local row
  // has no medicationId to match on.
  focusMed?: { medicationId?: string; name?: string } | null;
  onFocusMedConsumed?: () => void;
}) {
  const { colourBlind, timeFormat } = useAccessibility();
  const { language } = useLanguage();
  const [helpOpen, setHelpOpen] = useState<number | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const [detailMed, setDetailMed] = useState<GroupedMed | null>(null);
  const [refillFor, setRefillFor] = useState<GroupedMed | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<GroupedMed | null>(null);

  // Open the stopped list whenever the change being highlighted is in it, and
  // leave the detail page first. The ring is this app's proof that something
  // really happened; an elder who stops a medicine used to get the write with
  // no visible confirmation at all. While the detail page is up there is no
  // `medication-{uuid}` in the DOM at all, so findEntityElement misses,
  // ChangeHighlight polls for ~5s and gives up, and the write lands silently.
  useEffect(() => {
    if (!highlightIds?.length) return;
    setDetailMed(null);
    if ((patient.pastMedications ?? []).some(m => highlightIds.includes(m.id))) setPastOpen(true);
  }, [highlightIds, patient.pastMedications]);

  // A walkthrough or tour is starting: return to the list it expects to
  // spotlight. See the prop's own comment for why this is not optional.
  // Ignoring the initial 0 mirrors ElderlySettingsScreen. Deliberately the ONLY
  // thing keyed on this signal here — it is a never-reset monotonic counter and
  // this screen unmounts on every nav switch, so forcing any state that isn't
  // already the mount default would re-fire on every remount (MEMORY.md
  // 2026-08-07). Closing a sub-view is idempotent; a view mode would not be.
  useEffect(() => {
    if (!walkthroughResetSignal) return;
    setDetailMed(null);
    setRefillFor(null);
    setConfirmArchive(null);
  }, [walkthroughResetSignal]);

  const pastMedications = patient.pastMedications ?? [];
  // `patient.medications` is one entry per (medication, time-slot) — right for the
  // schedule, wrong here: a twice-daily pill is one prescription, not two. Group
  // back by medication and keep its times for the schedule indicator.
  // Finished courses sort to the bottom: they are history, not today's regimen.
  const prescriptions = groupByMedication(patient.medications)
    .sort((a, b) => Number((courseDaysLeft(a) ?? 0) < 0) - Number((courseDaysLeft(b) ?? 0) < 0));

  // An alert sent the person here about ONE medicine — open it. Consumed either
  // way, hit or miss: a med-backed alert can only exist once ElderlyApp's
  // medsLoaded gate has opened, so `prescriptions` is already the real fetch and
  // a miss means the medicine is genuinely gone (archived, or the id changed),
  // not that we arrived early. Holding the payload would only let it fire
  // against some unrelated later render.
  useEffect(() => {
    if (!focusMed) return;
    const hit = prescriptions.find(m =>
      (focusMed.medicationId && m.medicationId === focusMed.medicationId) ||
      (!!focusMed.name && m.name === focusMed.name));
    // Not while a highlight is pending: that effect closes the detail page
    // precisely because the ring needs the list, and an alert route arriving in
    // the same commit would re-open it and swallow the proof. Highlight wins.
    if (hit && !highlightIds?.length) setDetailMed(hit);
    onFocusMedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMed, patient.medications]);

  const cadenceFor = (m: Medication) => cadenceForMed(m, language);

  // One instance of each, rendered beside whichever view is showing, so the
  // card and the detail page share exactly one refill write path and one
  // archive confirmation.
  const overlays = (
    <>
      {refillFor && (
        <AddRefillSheet
          medName={refillFor.name}
          dosesPerDay={refillFor.times.length}
          initialCount={refillFor.pillsRemaining}
          onClose={() => setRefillFor(null)}
          onSave={pills => onAddRefill(refillFor, pills)}
        />
      )}
      {confirmArchive && (
        <ConfirmDialog
          title={t(language, "prescription.removeConfirmTitle", { name: confirmArchive.name })}
          body={t(language, "prescription.removeConfirmBody")}
          confirmLabel={t(language, "prescription.removeConfirmYes")}
          onConfirm={() => {
            const med = confirmArchive;
            setConfirmArchive(null);
            // Leave the page BEFORE the write: onArchiveRx refetches, and this
            // page is a snapshot of a medicine about to leave the list.
            setDetailMed(null);
            void onArchiveRx?.(med);
          }}
          onCancel={() => setConfirmArchive(null)}
        />
      )}
    </>
  );

  // The medicine detail is a sheet over the list, not a page swap: the list
  // stays put underneath and tap-outside closes it, the same gesture every
  // other sheet in the app uses.
  const detailSheet = detailMed && (
    <BottomSheet onClose={() => setDetailMed(null)} layout="bare">
      <div className="flex justify-center pt-3 pb-1 shrink-0">
        <div className="w-10 h-1 bg-border rounded-full" />
      </div>
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-1 border-b border-border shrink-0">
        <h2 className="text-[calc(17px*var(--dw-text,1))] font-bold text-foreground min-w-0 truncate">{detailMed.name}</h2>
        <button
          onClick={() => setDetailMed(null)}
          aria-label={t(language, "link.close")}
          className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0"
        >
          <X size={15} className="text-foreground" />
        </button>
      </div>
      <ElderlyMedicationDetail
        med={detailMed}
        timeFormat={timeFormat}
        colourBlind={colourBlind}
        variant="sheet"
        onEdit={() => { const med = detailMed; setDetailMed(null); onEditRx(med); }}
        // Unlike the card's own "Move to past medicines", this is NOT gated on
        // the course having finished — from here, any medicine can be retired.
        // Still archive, never delete: DELETE on medications is denied by
        // migration 0004, and archived=true is the same state Hermes's
        // discontinue_medication writes.
        onArchive={onArchiveRx && detailMed.medicationId ? () => setConfirmArchive(detailMed) : undefined}
        onAddRefill={() => setRefillFor(detailMed)}
        onRequestRefill={() => onRequestRefill(detailMed.name)}
      />
    </BottomSheet>
  );

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-3 pb-28 space-y-3">

        {/* Grey and borderless: it's standing advice, not an alert about
            anything happening right now — the warn palette overstated it. */}
        <div className="bg-muted/50 rounded-2xl px-3.5 py-3 flex items-start gap-2.5">
          <ShieldAlert size={18} className="text-muted-foreground shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-foreground/85 leading-tight mb-0.5">{t(language, "prescription.safetyTitle")}</p>
            <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground leading-relaxed">{t(language, "prescription.disclaimer")}</p>
          </div>
        </div>

        {/* Count and the add action share one row, so the button sits in the
            corner opposite the title rather than eating a full-width band. */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[calc(17px*var(--dw-text,1))] font-bold text-foreground min-w-0 truncate">{t(language, "prescription.count", { count: prescriptions.length })}</h2>
          <button
            onClick={onAddRx}
            data-tour="elder-add-prescription"
            aria-label={t(language, "prescription.add")}
            className="h-9 px-3.5 bg-primary text-primary-foreground rounded-full text-[calc(15px*var(--dw-text,1))] font-bold flex items-center gap-1.5 shrink-0 dw-press"
          >
            <Plus size={17} strokeWidth={3} className="shrink-0" />{t(language, "prescription.addShort")}
          </button>
        </div>

        {/* Medication cards — tour target framed tightly around just these, not the whole page */}
        <div data-tour="elder-medlist" className="space-y-3">
        {prescriptions.length === 0 && (
          <div className="bg-muted/40 rounded-2xl p-6 text-center">
            <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.empty")}</p>
          </div>
        )}
        {prescriptions.map(m => {
          const plain       = MED_PLAIN[m.name];
          const direction   = MED_SIMPLE[m.name] ?? t(language, "home.takeAsDirected");
          const shape       = MED_SHAPES[m.name];
          // Days left comes from the pills remaining divided by how many are
          // taken per day (m.times.length), so a twice-daily medicine runs out
          // in half the time. Undefined when there's no refill data at all —
          // the supply block is then hidden rather than showing a guess.
          const daysLeft    = supplyDaysLeft(m, m.times.length);
          const lowRefill   = daysLeft != null && daysLeft < LOW_SUPPLY_DAYS;
          const supplyPct   = daysLeft == null ? 0 : Math.min(100, Math.round((daysLeft / 30) * 100));
          // Offered a little before the red warning, so the action is there
          // before it becomes urgent. Ask Mei reads the same threshold.
          const needsRefill = daysLeft != null && daysLeft < REFILL_PROMPT_DAYS;
          // null = ongoing (the common case); < 0 = the course has run out, so
          // isDueOn already produces no doses and the card must say why rather
          // than just quietly emptying.
          const courseLeft  = courseDaysLeft(m);
          const courseDone  = courseLeft !== null && courseLeft < 0;
          const isEyeDrop   = m.name === "Latanoprost Eye Drops";
          const isHelpOpen  = helpOpen === m.id;
          const justAdded   = !!justAddedMed && m.name === justAddedMed;

          return (
            // Running low is carried by the CARD, in the same colours a missed
            // dose uses on Home — the supply bar alone was a detail several
            // lines down a card that otherwise looked like every other. Flat
            // fill, no drifting gradient: a list of cards all breathing at once
            // would be noise, not emphasis. Just-added still wins: it's a
            // one-off confirmation that fades on the next visit.
            <div
              key={m.id}
              data-testid={m.medicationId ? `medication-${m.medicationId}` : undefined}
              onClick={() => setDetailMed(m)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setDetailMed(m); }}
              className={`rounded-2xl border overflow-hidden shadow-sm text-left active:opacity-90 transition-opacity ${
                justAdded ? "bg-card border-2 border-taken ring-2 ring-taken/40"
                : courseDone ? "bg-muted/40 border-border"
                : lowRefill ? "bg-missed-bg border-missed-border"
                : "bg-card border-border"
              }`}
            >
              <div className="p-3.5">
                {/* Badges get their own strip so a long medicine name keeps the
                    full column width (same reason as the Home card). */}
                {justAdded && (
                  <div className="flex items-center gap-1.5 flex-wrap mb-2">
                    <span className="flex items-center gap-1 bg-taken-bg text-taken-fg border border-taken-border text-[calc(12px*var(--dw-text,1))] font-bold px-2 py-0.5 rounded-full">
                      <Check size={11} strokeWidth={3} />{t(language, "prescription.justAdded")}
                    </span>
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <MedAvatar name={m.name} size={48} className="rounded-xl shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-[calc(17px*var(--dw-text,1))] text-foreground leading-tight break-words">
                      {m.name}
                      {m.dose && <span className="ml-1.5 text-[calc(14px*var(--dw-text,1))] font-semibold text-muted-foreground">{m.dose}</span>}
                    </p>
                    {/* Instructions first (most actionable), then the reason.
                        Both align flush under the name now that the leading
                        colour dot is gone. */}
                    <p className="text-[calc(14px*var(--dw-text,1))] font-semibold text-foreground leading-snug mt-1">{direction}</p>
                    <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground leading-snug mt-0.5">
                      {plain ? t(language, plain.whyKey) : t(language, "prescription.forPurpose", { purpose: localizeCatalogValue(m.purpose, k => t(language, k)).toLowerCase() })}
                    </p>
                    {colourBlind && shape && (
                      <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground mt-1">{shape.shape} · {shape.marking}</p>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {m.times.map(time => (
                    <span key={time} className="text-[calc(14px*var(--dw-text,1))] font-bold text-secondary-foreground bg-secondary border border-primary/20 rounded-lg px-2.5 py-1 whitespace-nowrap">
                      {formatClock(time, timeFormat)}
                    </span>
                  ))}
                  {/* Only shown when the medicine ISN'T daily — "Every day" on
                      every card would be noise. */}
                  {cadenceFor(m) && (
                    <span className="text-[calc(14px*var(--dw-text,1))] font-bold text-foreground bg-muted rounded-lg px-2.5 py-1 whitespace-nowrap">
                      {cadenceFor(m)}
                    </span>
                  )}
                  {courseLeft !== null && (
                    <span className={`text-[calc(14px*var(--dw-text,1))] font-bold rounded-lg px-2.5 py-1 whitespace-nowrap ${
                      courseDone ? "text-muted-foreground bg-muted"
                        : courseLeft <= 3 ? "text-warn-fg bg-warn-bg border border-warn-border"
                        : "text-foreground bg-muted"
                    }`}>
                      {courseDone ? t(language, "prescription.courseFinished")
                        : courseLeft === 0 ? t(language, "prescription.courseEndsToday")
                        : t(language, "prescription.courseEndsInDays", { days: courseLeft })}
                    </span>
                  )}
                </div>

                {daysLeft != null && !courseDone && (
                  <div className="mt-3.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[calc(13px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.supply")}</p>
                      <p className={`text-[calc(13px*var(--dw-text,1))] font-bold ${lowRefill ? "text-missed-fg" : "text-foreground"}`}>{t(language, "prescription.daysLeft", { days: daysLeft })}</p>
                    </div>
                    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${lowRefill ? "bg-missed" : "bg-primary"}`}
                        style={{ width: `${supplyPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* How to take it sits above Request refill — using it correctly
                    matters before whether more is needed. */}
                {isEyeDrop && (
                  <button
                    onClick={e => { e.stopPropagation(); setHelpOpen(isHelpOpen ? null : m.id); }}
                    className={`mt-3 w-full flex items-center gap-2.5 px-3.5 h-11 rounded-xl text-[calc(14px*var(--dw-text,1))] font-bold border transition-colors ${
                      isHelpOpen ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-secondary-foreground border-primary/20"
                    }`}
                  >
                    <BookOpen size={17} className="shrink-0" />
                    <span className="text-left leading-tight">{t(language, "prescription.howToUseEyeDrops")}</span>
                    <ChevronDown size={17} className={`ml-auto shrink-0 transition-transform ${isHelpOpen ? "rotate-180" : ""}`} />
                  </button>
                )}

                {needsRefill && !courseDone && (
                  <button
                    onClick={e => { e.stopPropagation(); onRequestRefill(m.name); }}
                    data-walk="med-request-refill-btn"
                    className="mt-2.5 w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-border text-[calc(14px*var(--dw-text,1))] font-bold text-foreground active:bg-muted transition-colors"
                  >
                    <RefreshCw size={17} className="shrink-0" />{t(language, "prescription.requestRefill")}
                  </button>
                )}

                {/* The other refill, and deliberately a different verb: Request
                    refill above asks the DOCTOR (chat -> request_refill), this
                    records what is already in the cupboard. stopPropagation
                    because the card itself is role="button" and opens the
                    detail page. */}
                {m.medicationId && !courseDone && (
                  <button
                    onClick={e => { e.stopPropagation(); setRefillFor(m); }}
                    data-walk="med-add-refill-btn"
                    className="mt-2.5 w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-border text-[calc(14px*var(--dw-text,1))] font-bold text-foreground active:bg-muted transition-colors"
                  >
                    <PackagePlus size={17} className="shrink-0" />{t(language, "prescription.addRefill")}
                  </button>
                )}

                {/* The course is over and this medicine is producing no more
                    doses. Offering the tidy-up here — rather than archiving it
                    behind their back — is what keeps the disappearance
                    explained and the decision theirs. */}
                {courseDone && onArchiveRx && m.medicationId && (
                  <button
                    onClick={e => { e.stopPropagation(); onArchiveRx(m); }}
                    data-walk="med-move-to-past-btn"
                    className="mt-2.5 w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-[calc(14px*var(--dw-text,1))] font-bold dw-press"
                  >
                    <History size={17} className="shrink-0" />{t(language, "prescription.moveToPast")}
                  </button>
                )}
              </div>

              {/* Eye drop detailed instructions */}
              {isEyeDrop && isHelpOpen && (
                <div className="px-4 pb-4 pt-3 border-t border-border/40 space-y-2.5 bg-secondary/30">
                  <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-primary uppercase tracking-wider mb-1">{t(language, "prescription.stepByStepGuide")}</p>
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
              )}
            </div>
          );
        })}
        </div>

        {/* Stopped (archived) medications — collapsed by default, grouped after
            the active cards, each keyed by its real medication uuid so a
            discontinue_medication highlight lands on data-testid="medication-{id}".
            The effect above force-opens this when such a highlight is pending:
            a collapsed accordion means the row isn't in the DOM at all, and
            ChangeHighlight polls for 5s and then gives up.
            Muted on purpose: stopped, never deleted. */}
        {pastMedications.length > 0 && (
          <div className="dw-surface overflow-hidden">
            <button
              onClick={() => setPastOpen(v => !v)}
              className="w-full flex items-center gap-2.5 px-4 py-4 text-[calc(15px*var(--dw-text,1))] font-bold text-foreground"
            >
              <History size={19} className="text-muted-foreground shrink-0" />
              {t(language, "prescription.past")}
              <span className="text-[calc(14px*var(--dw-text,1))] font-bold text-muted-foreground bg-muted rounded-full px-2.5 py-0.5">{pastMedications.length}</span>
              <ChevronDown size={18} className={`ml-auto text-muted-foreground transition-transform ${pastOpen ? "rotate-180" : ""}`} />
            </button>
            {pastOpen && (
              <div className="divide-y divide-border border-t border-border">
                {pastMedications.map(m => (
                  <div key={m.id} data-testid={`medication-${m.id}`} className="px-4 py-3.5 flex items-center gap-2 opacity-80">
                    <div className="flex-1 min-w-0">
                      <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-muted-foreground">{m.name} <span className="text-[calc(14px*var(--dw-text,1))] font-normal">{m.dose}</span></p>
                      <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground/80">{localizeCatalogValue(m.purpose, k => t(language, k))}</p>
                    </div>
                    <span className="shrink-0 text-[calc(10px*var(--dw-text,1))] font-bold uppercase tracking-wide text-muted-foreground bg-muted border border-border rounded-full px-2 py-0.5">
                      {t(language, "prescription.stopped")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {detailSheet}
      {/* After the detail sheet in the DOM so the refill sheet and the archive
          confirmation stack above it — they share the same z-index. */}
      {overlays}
    </div>
  );
}

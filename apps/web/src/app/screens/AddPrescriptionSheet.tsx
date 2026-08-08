import { useState, useRef, useEffect } from "react";
import type { ReactNode, ChangeEvent } from "react";
import { X, Check, Plus, Minus, Pill, Camera, PenLine, Image as ImageIcon, Sparkles } from "lucide-react";
import type { Medication } from "../types";
import { WEEKDAY_TOKENS, courseDaysLeft, isoDate } from "../lib/medications";
import { MED_COLOURS, MEDICATION_CATALOG, COMMON_CONDITIONS, MED_PHOTOS, localizeCatalogValue } from "../data/medications";
import { TimesPicker, defaultDoseTime } from "../components/TimesPicker";
import type { RoutineTimes } from "../components/TimesPicker";
import { agentTurn, fileToBase64 } from "../lib/hermes";
import { withCatalogLabels } from "./setup/GuidedSetupWizard";
import { PhotoSourceSheet } from "../components/PhotoSourceSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { checkDoseSafety } from "../lib/doseSafety";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// The three cadences the app can express. "days" writes medications.schedule.days
// (which Hermes's reminder scheduler already understands); "interval" writes
// schedule.interval_days — see lib/medications.ts::isDueOn for what that does and
// does not reach.
type Cadence = "daily" | "days" | "interval";

interface AddPrescriptionSheetProps {
  onClose: () => void;
  onAdd: (med: Omit<Medication, "id" | "status"> & { times?: string[] }) => Promise<unknown> | void;
  onAdded?: () => void;
  initialTab?: "scan" | "manual";
  // The elder's meal/bedtime routine, so the time picker's quick chips offer
  // their actual times rather than generic defaults.
  routine?: RoutineTimes;
  // Called after the agent commits a scanned prescription server-side, so the
  // parent can refetch the medication list (there is no local onAdd for this path).
  // Receives the added medication name so the parent can highlight it as proof.
  onAgentAdded?: (name?: string) => void;
  // When set, the sheet opens pre-filled for this medication and calls onAdd
  // with the edited values instead of a blank one — the scan tab makes no
  // sense for an edit, so it's hidden and manual is forced.
  editing?: Medication & { times?: string[] };
  // A course length Mei already knows (from the chat request the walkthrough was
  // started for). Only used to render an extra exact-value preset alongside the
  // standard three, so an autonomous walkthrough can CLICK a real control for a
  // duration like 5 days instead of snapping to the nearest preset and silently
  // rewriting a doctor's instruction. Deliberately does NOT pre-select anything:
  // Mei still performs both taps visibly, which is the point of the walkthrough.
  initialDurationDays?: number;
  // HOOK POINT for the Confirm phase (plan doc: "Item 5 — ConfirmBack-Phase",
  // not yet built). Once a walkthrough's own Confirm step has risk-gated and
  // tapped through the SAME dosage-jump signal checkDoseSafety detects here,
  // this dialog would be a THIRD confirm on one write (Confirm-phase tap ->
  // Submit tap -> this interstitial) — so an `*_auto` write path should be
  // able to pass true here to skip it. Deliberately unwired for now (no
  // caller sets it): the Confirm phase doesn't exist yet, so nothing may
  // suppress this dialog today — it stays the only dose-safety net for every
  // current walkthrough AND the ordinary direct-UI path. Leave untouched for
  // the direct-UI path even after Item 5 lands.
  suppressDoseConfirm?: boolean;
}

// A small type-ahead input: shows filtered suggestions as the user types.
function TypeAhead<T>({ value, onChange, onPick, items, filter, label, render, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onPick: (item: T) => void;
  items: T[];
  filter: (item: T, q: string) => boolean;
  label: (item: T) => string;
  render?: (item: T) => ReactNode;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = q ? items.filter(i => filter(i, q)).slice(0, 6) : [];
  const showList = open && matches.length > 0 && !(matches.length === 1 && label(matches[0]).toLowerCase() === q);

  return (
    <div className="relative">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
      />
      {showList && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto scrollbar-none">
          {matches.map((item, i) => (
            <button
              key={i}
              onMouseDown={e => { e.preventDefault(); onPick(item); setOpen(false); }}
              className="w-full text-left px-3.5 py-2.5 hover:bg-muted active:bg-muted border-b border-border/50 last:border-0 transition-colors"
            >
              {render ? render(item) : <span className="text-sm text-foreground">{label(item)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AddPrescriptionSheet({ onClose, onAdd, onAdded, initialTab = "manual", routine, onAgentAdded, editing, suppressDoseConfirm = false, initialDurationDays }: AddPrescriptionSheetProps) {
  const { language } = useLanguage();
  const [tab, setTab] = useState<"scan" | "manual">(editing ? "manual" : initialTab);
  const [scannedPhoto, setScannedPhoto] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "saving" | "success">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [showPhotoSource, setShowPhotoSource] = useState(false);

  const [name, setName] = useState(editing?.name ?? "");
  const [dose, setDose] = useState(editing?.dose ?? "");
  const [purpose, setPurpose] = useState(editing?.purpose ?? "");
  const [selectedTimes, setSelectedTimes] = useState<string[]>(editing?.times ?? (editing?.time ? [editing.time] : [defaultDoseTime(routine)]));
  const [cadence, setCadence] = useState<Cadence>(editing?.days?.length ? "days" : (editing?.intervalDays ?? 1) > 1 ? "interval" : "daily");
  const [weekDays, setWeekDays] = useState<string[]>(editing?.days ?? []);
  const [intervalDays, setIntervalDays] = useState(editing?.intervalDays ?? 2);
  const [refillDays, setRefillDays] = useState(editing?.refillDaysLeft ? String(editing.refillDaysLeft) : "");
  // The stored truth is the END DATE, not a duration: presets and the stepper
  // SET it, the summary DERIVES days-remaining from it. That is what makes
  // re-opening an existing medicine show the course's remaining days rather
  // than restarting it — saving without touching this control passes the
  // original date straight back through, with no drift across repeated edits.
  const [courseMode, setCourseMode] = useState<"ongoing" | "fixed">(editing?.endDate ? "fixed" : "ongoing");
  const [endDate, setEndDate] = useState<string | undefined>(editing?.endDate);
  const [colour, setColour] = useState(editing?.colour ?? MED_COLOURS[0].hex);
  const [showDoseConfirm, setShowDoseConfirm] = useState(false);
  // Cleared whenever the dose or its schedule changes, so an "I'm sure" given
  // for "10 tablets" can't carry over to a different number typed after it.
  const [doseConfirmed, setDoseConfirmed] = useState(false);
  useEffect(() => setDoseConfirmed(false), [dose, selectedTimes.length]);

  // "Certain days" with nothing ticked is not a schedule — block the save rather
  // than silently falling back to daily, which would be a different medicine
  // regimen than the person just described. Same shape for a fixed course with
  // no length chosen.
  const isValid = !!(name.trim() && dose.trim() && purpose.trim() && selectedTimes.length > 0
    && (cadence !== "days" || weekDays.length > 0)
    && (courseMode !== "fixed" || !!endDate));

  // n days INCLUSIVE of today, so "2 weeks" ends 13 days from now — the same
  // rule tools/medications.py applies to duration_days and the same one
  // courseDaysLeft reads back.
  const endDateAfter = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days - 1);
    return isoDate(d);
  };
  const courseDays = courseDaysLeft({ endDate });
  // Presets the walkthrough can click. The fourth appears only when Mei arrived
  // with a duration that isn't one of the standard three.
  const DURATION_PRESETS = [7, 14, 30];
  const showCustomPreset = !!initialDurationDays && initialDurationDays > 0
    && !DURATION_PRESETS.includes(initialDurationDays);
  const courseSummary = courseDays === null
    ? t(language, "prescription.courseOngoing")
    : courseDays < 0 ? t(language, "prescription.courseFinished")
      : courseDays === 0 ? t(language, "prescription.courseEndsToday")
        : t(language, "prescription.courseEndsInDays", { days: courseDays });

  const toggleWeekDay = (token: string) =>
    setWeekDays(prev => prev.includes(token) ? prev.filter(d => d !== token) : [...prev, token]);

  const cadenceSummary = cadence === "days"
    ? WEEKDAY_TOKENS.filter(d => weekDays.includes(d)).map(d => t(language, `common.day.${d}`)).join(", ")
    : cadence === "interval"
      ? t(language, "prescription.everyNDays", { n: intervalDays })
      : t(language, "prescription.everyDay");

  // An implausible count is caught between "Add" and the save, and asked about
  // once — never silently corrected, since only the label knows the truth.
  const doseConcern = checkDoseSafety(dose, selectedTimes.length);

  const handleAdd = async () => {
    if (!isValid || submitState === "saving") return;
    if (doseConcern && !doseConfirmed && !suppressDoseConfirm) { setShowDoseConfirm(true); return; }
    const chosenTimes = selectedTimes;
    setSubmitState("saving");
    setSubmitError(null);
    try {
      await onAdd({
        name: name.trim(),
        dose: dose.trim(),
        purpose: purpose.trim(),
        time: chosenTimes[0] || "8:00 AM",
        times: chosenTimes,
        refillDaysLeft: refillDays ? parseInt(refillDays) : undefined,
        colour,
        days: cadence === "days" ? WEEKDAY_TOKENS.filter(d => weekDays.includes(d)) : undefined,
        intervalDays: cadence === "interval" ? intervalDays : undefined,
        endDate: courseMode === "fixed" ? endDate : undefined,
      });
      setSubmitState("success");
      window.setTimeout(() => {
        onAdded?.();
        onClose();
      }, 700);
    } catch (error) {
      console.error("Failed to add medication", error);
      setSubmitState("idle");
      setSubmitError(t(language, "prescription.saveError"));
    }
  };

  const pickMedication = (m: { name: string; purpose: string; purposeKey: string; dose: string }) => {
    setName(m.name);
    if (!purpose.trim()) setPurpose(m.purpose);
    if (!dose.trim()) setDose(m.dose);
  };

  // Real label scan: the photo or PDF goes to Hermes, whose add_prescription tool
  // reads the label and proposes the details (propose→confirm; nothing is saved
  // until the person confirms below, and the write happens server-side).
  const runScan = async (photoUrl: string | null, file: Blob, isPdf: boolean) => {
    setScannedPhoto(photoUrl);
    setScanning(true);
    setProposal(null);
    setCommitted(false);
    const b64 = await fileToBase64(file);
    const { reply } = await agentTurn(
      "Here is a photo of my prescription.",
      isPdf ? undefined : b64,
      isPdf ? b64 : undefined
    );
    setProposal(reply);
    setScanning(false);
  };

  const confirmScan = async () => {
    setCommitting(true);
    const { reply, actions } = await agentTurn("Yes, please add it.");
    setProposal(reply);
    setCommitting(false);
    // actions only contains add_prescription once the write actually committed
    // (never on the propose turn) — a reliable "it's really saved" signal.
    const added = actions.find(a => a.tool === "add_prescription");
    if (added) {
      setCommitted(true);
      onAgentAdded?.(added.name);
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const isPdf = file.type === "application/pdf";
    runScan(isPdf ? null : URL.createObjectURL(file), file, isPdf);
  };

  const onSamplePhoto = async () => {
    // The bundled sample image, routed through the same real agent path.
    const blob = await (await fetch(MED_PHOTOS["Metformin"])).blob();
    runScan(MED_PHOTOS["Metformin"], blob, false);
  };

  const inputCls = "w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors";

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-card rounded-t-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90%]">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div>
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">{t(language, editing ? "prescription.editTitle" : "prescription.add")}</h2>
            <p className="text-xs text-muted-foreground">{t(language, editing ? "prescription.editSubtitle" : "prescription.snapOrType")}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        {/* Mode toggle — hidden when editing: re-scanning a label makes no
            sense once a medication already exists. */}
        {!editing && (
          <div className="px-5 pt-3 shrink-0">
            <div className="flex gap-2 bg-muted rounded-xl p-1">
              <button
                onClick={() => setTab("scan")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${tab === "scan" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                <Camera size={16} />{t(language, "prescription.scanPhotoTab")}
              </button>
              <button
                onClick={() => setTab("manual")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${tab === "manual" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                <PenLine size={16} />{t(language, "prescription.enterManuallyTab")}
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          {tab === "scan" ? (
            <div className="space-y-3">
              {/* Two inputs — one camera-only, one library/Files-only — backing the
                  explicit PhotoSourceSheet chooser below, so both are always
                  reachable regardless of what a given mobile browser's native
                  file picker defaults to. */}
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile} />
              <input ref={libraryRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onFile} />
              {scanning ? (
                <div className="border-2 border-primary/30 bg-primary/5 rounded-2xl p-6 flex flex-col items-center text-center gap-3">
                  {scannedPhoto && <img src={scannedPhoto} alt="scan" className="w-24 h-24 rounded-xl object-cover" />}
                  <div className="flex items-center gap-2 text-primary">
                    <Sparkles size={16} className="animate-pulse" />
                    <span className="text-sm font-semibold">{t(language, "prescription.readingLabel")}</span>
                  </div>
                </div>
              ) : proposal ? (
                <div className="space-y-3">
                  <div className="border border-border bg-card rounded-2xl p-4 flex flex-col gap-3">
                    {scannedPhoto && <img src={scannedPhoto} alt="scan" className="w-20 h-20 rounded-xl object-cover" />}
                    <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-relaxed whitespace-pre-line">{proposal}</p>
                  </div>
                  {committed ? (
                    <button onClick={onClose} className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2">
                      <Check size={16} /> {t(language, "prescription.done")}
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setProposal(null); setScannedPhoto(null); }}
                        disabled={committing}
                        className="flex-1 h-12 rounded-2xl border border-border text-muted-foreground text-sm font-semibold disabled:opacity-40"
                      >
                        {t(language, "prescription.retake")}
                      </button>
                      <button
                        onClick={confirmScan}
                        disabled={committing}
                        className="flex-1 h-12 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
                      >
                        {committing ? <Sparkles size={15} className="animate-pulse" /> : <Check size={15} />}
                        {committing ? t(language, "settings.saving") : t(language, "prescription.yesAddIt")}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setShowPhotoSource(true)}
                    className="w-full border-2 border-dashed border-border rounded-2xl p-6 flex flex-col items-center text-center gap-2 active:bg-muted/50 transition-colors"
                  >
                    <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                      <Camera size={26} className="text-primary" />
                    </div>
                    <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "prescription.takePhotoOrUpload")}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{t(language, "prescription.snapOrUploadDesc")}</p>
                  </button>
                  <button
                    onClick={onSamplePhoto}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-muted text-sm font-semibold text-foreground active:bg-muted/70"
                  >
                    <ImageIcon size={15} />{t(language, "prescription.trySamplePhoto")}
                  </button>
                  <p className="text-center text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.preferToType")}{" "}
                    <button onClick={() => setTab("manual")} className="text-primary font-semibold underline">{t(language, "prescription.enterManuallyTab")}</button>
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Medication name — type-ahead */}
              <div data-walk="rx-name">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.medicationName")} <span className="text-destructive">*</span></label>
                <TypeAhead
                  value={name}
                  onChange={setName}
                  onPick={pickMedication}
                  items={MEDICATION_CATALOG}
                  filter={(m, q) => m.name.toLowerCase().includes(q)}
                  label={m => m.name}
                  placeholder={t(language, "prescription.namePlaceholder")}
                  render={m => (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{m.name}</span>
                      <span className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{t(language, m.purposeKey)} · {m.dose}</span>
                    </div>
                  )}
                />
              </div>

              {/* Dose */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "prescription.dose")} <span className="text-destructive">*</span></label>
                <input data-walk="rx-dose" value={dose} onChange={e => setDose(e.target.value)} placeholder={t(language, "prescription.dosePlaceholder")} className={inputCls} />
              </div>

              {/* Purpose / condition — type-ahead */}
              <div data-walk="rx-purpose">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "prescription.purposeCondition")} <span className="text-destructive">*</span></label>
                <TypeAhead
                  value={purpose}
                  onChange={setPurpose}
                  onPick={c => setPurpose(c.value)}
                  items={withCatalogLabels(COMMON_CONDITIONS, language)}
                  filter={(c, q) => c.label.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)}
                  label={c => c.label}
                  placeholder={t(language, "wizard.conditionsPlaceholder")}
                />
              </div>

              {/* Time */}
              <TimesPicker times={selectedTimes} onChange={setSelectedTimes} label={t(language, "prescription.scheduledTimes")} routine={routine} />

              {/* Which days — plenty of medicines aren't daily (alternate-day
                  anti-inflammatories, a weekly bisphosphonate). Tap-only, like
                  TimesPicker: no free-text, nothing to mistype. */}
              <div data-walk="rx-cadence">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "prescription.whichDays")}</label>
                <div className="flex gap-1 bg-muted/60 rounded-xl p-1">
                  {([
                    ["daily", t(language, "prescription.everyDay")],
                    ["days", t(language, "prescription.certainDays")],
                    ["interval", t(language, "prescription.everyFewDays")],
                  ] as [Cadence, string][]).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setCadence(id)}
                      className={`flex-1 py-2 rounded-lg text-[calc(12px*var(--dw-text,1))] font-bold transition-colors ${cadence === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {cadence === "days" && (
                  <div className="flex gap-1 mt-2.5">
                    {WEEKDAY_TOKENS.map(d => {
                      const on = weekDays.includes(d);
                      return (
                        <button
                          key={d}
                          onClick={() => toggleWeekDay(d)}
                          aria-pressed={on}
                          className={`flex-1 h-11 rounded-xl text-[calc(12px*var(--dw-text,1))] font-bold border transition-colors ${on ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}
                        >
                          {t(language, `common.dayShort.${d}`)}
                        </button>
                      );
                    })}
                  </div>
                )}

                {cadence === "interval" && (
                  <div className="flex items-center gap-3 mt-2.5 bg-card border border-border rounded-xl px-3 py-2.5">
                    <button
                      onClick={() => setIntervalDays(n => Math.max(2, n - 1))}
                      disabled={intervalDays <= 2}
                      aria-label={t(language, "prescription.fewerDays")}
                      className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-foreground disabled:opacity-40 shrink-0"
                    >
                      <Minus size={16} />
                    </button>
                    <p className="flex-1 text-center text-[calc(14px*var(--dw-text,1))] font-bold text-foreground">
                      {t(language, "prescription.everyNDays", { n: intervalDays })}
                    </p>
                    <button
                      onClick={() => setIntervalDays(n => Math.min(30, n + 1))}
                      disabled={intervalDays >= 30}
                      aria-label={t(language, "prescription.moreDays")}
                      className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-foreground disabled:opacity-40 shrink-0"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                )}

                {cadence === "days" && weekDays.length === 0 && (
                  <p className="text-[calc(11px*var(--dw-text,1))] text-missed-fg mt-1.5">{t(language, "prescription.pickAtLeastOneDay")}</p>
                )}
              </div>

              {/* How long — a course the doctor issued for a fixed period ("take
                  this for 2 weeks"). Sits with "which days" because both answer
                  the same question, the schedule. Tap-only like everything else
                  here: presets are individually clickable buttons rather than a
                  date field, both because no date picker exists in this app and
                  because an autonomous walkthrough can only act:click a real
                  control. */}
              <div data-walk="rx-duration">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "prescription.courseLength")}</label>
                <div className="flex gap-1 bg-muted/60 rounded-xl p-1">
                  {([
                    ["ongoing", t(language, "prescription.courseOngoing")],
                    ["fixed", t(language, "prescription.courseFixed")],
                  ] as ["ongoing" | "fixed", string][]).map(([id, label]) => (
                    <button
                      key={id}
                      data-walk={`rx-duration-${id}`}
                      onClick={() => {
                        setCourseMode(id);
                        // Seed the user's own example rather than nothing, so
                        // switching to a course is one tap if they agree.
                        setEndDate(id === "ongoing" ? undefined : (endDate ?? endDateAfter(initialDurationDays || 14)));
                      }}
                      aria-pressed={courseMode === id}
                      className={`flex-1 py-2 rounded-lg text-[calc(12px*var(--dw-text,1))] font-bold transition-colors ${courseMode === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {courseMode === "fixed" && (
                  <>
                    <div className="flex gap-1 mt-2.5">
                      {DURATION_PRESETS.map(n => {
                        const on = courseDays !== null && courseDays === n - 1;
                        return (
                          <button
                            key={n}
                            data-walk={`rx-duration-${n}`}
                            onClick={() => setEndDate(endDateAfter(n))}
                            aria-pressed={on}
                            className={`flex-1 h-11 rounded-xl text-[calc(12px*var(--dw-text,1))] font-bold border transition-colors ${on ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}
                          >
                            {t(language, n === 7 ? "prescription.course1Week" : n === 14 ? "prescription.course2Weeks" : "prescription.course1Month")}
                          </button>
                        );
                      })}
                      {showCustomPreset && (
                        <button
                          data-walk="rx-duration-custom"
                          onClick={() => setEndDate(endDateAfter(initialDurationDays!))}
                          aria-pressed={courseDays === initialDurationDays! - 1}
                          className={`flex-1 h-11 rounded-xl text-[calc(12px*var(--dw-text,1))] font-bold border transition-colors ${courseDays === initialDurationDays! - 1 ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}
                        >
                          {t(language, "prescription.courseDays", { days: initialDurationDays! })}
                        </button>
                      )}
                    </div>

                    {/* Anything the presets don't cover. No data-walk: like the
                        interval stepper, this is a human-only control — an
                        ActDirective has no way to drive a stepper to a value. */}
                    <div className="flex items-center gap-3 mt-2.5 bg-card border border-border rounded-xl px-3 py-2.5">
                      <button
                        onClick={() => setEndDate(endDateAfter(Math.max(1, (courseDays ?? 0) + 1 - 1)))}
                        disabled={(courseDays ?? 0) + 1 <= 1}
                        aria-label={t(language, "prescription.fewerCourseDays")}
                        className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-foreground disabled:opacity-40 shrink-0"
                      >
                        <Minus size={16} />
                      </button>
                      <p data-walk="rx-duration-summary" className="flex-1 text-center text-[calc(14px*var(--dw-text,1))] font-bold text-foreground">
                        {courseSummary}
                      </p>
                      <button
                        // max(1,…) so stepping up from an already-finished
                        // course (negative days left, seen when editing) lands
                        // on "ends today" rather than another past date.
                        onClick={() => setEndDate(endDateAfter(Math.min(60, Math.max(1, (courseDays ?? 0) + 2))))}
                        disabled={(courseDays ?? 0) + 1 >= 60}
                        aria-label={t(language, "prescription.moreCourseDays")}
                        className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-foreground disabled:opacity-40 shrink-0"
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                    <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground mt-1.5">{t(language, "prescription.courseHint")}</p>
                  </>
                )}
              </div>

              {/* Refill supply */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "prescription.currentSupply")}</label>
                <input type="number" value={refillDays} onChange={e => setRefillDays(e.target.value)} placeholder={t(language, "prescription.supplyPlaceholder")} min={1} className={inputCls} />
                <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground mt-1">{t(language, "prescription.alertedWhenLow")}</p>
              </div>

              {/* Colour */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-2">{t(language, "prescription.colourLabel")}</label>
                <div className="flex gap-3">
                  {MED_COLOURS.map(c => (
                    <button
                      key={c.hex}
                      onClick={() => setColour(c.hex)}
                      className="w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all"
                      style={{ backgroundColor: c.hex, borderColor: colour === c.hex ? c.hex : "transparent", boxShadow: colour === c.hex ? `0 0 0 2px white, 0 0 0 4px ${c.hex}` : "none" }}
                      title={c.label}
                    >
                      {colour === c.hex && <Check size={14} className="text-white" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview */}
              {isValid && (
                <div className="bg-secondary border border-primary/20 rounded-xl p-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${colour}20` }}>
                    <Pill size={16} style={{ color: colour }} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{name} <span className="text-xs font-normal text-muted-foreground">{dose}</span></p>
                    <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{localizeCatalogValue(purpose, k => t(language, k))} · {selectedTimes.join(" • ") || "8:00 AM"}</p>
                    <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">
                      {[cadenceSummary, courseMode === "fixed" ? courseSummary : null].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Submit (manual only) */}
        {tab === "manual" && (
          <div className="px-5 py-4 border-t border-border shrink-0 space-y-2">
            {submitError && (
              <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {submitError}
              </div>
            )}
            {submitState !== "idle" && (
              <div className={`rounded-xl border px-3 py-2.5 flex items-center gap-2 text-sm ${submitState === "saving" ? "border-primary/20 bg-primary/10 text-primary" : "border-taken-border bg-taken-bg text-taken-fg"}`}>
                {submitState === "saving" ? <Sparkles size={14} className="animate-pulse" /> : <Check size={14} />}
                <span>{submitState === "saving" ? t(language, "prescription.savingMedication") : t(language, "prescription.medicationAdded")}</span>
              </div>
            )}
            <button
              data-walk="rx-submit"
              onClick={handleAdd}
              disabled={!isValid || submitState === "saving" || submitState === "success"}
              className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
            >
              {submitState === "saving" ? <Sparkles size={16} className="animate-pulse" /> : submitState === "success" ? <Check size={16} /> : <Plus size={16} />}
              {submitState === "saving" ? t(language, "prescription.adding") : submitState === "success" ? t(language, "prescription.added") : editing ? t(language, "prescription.saveChanges") : t(language, "prescription.addNamed", { name: name || t(language, "prescription.medicationFallback") })}
            </button>
          </div>
        )}
      </div>
      {showDoseConfirm && doseConcern && (
        <ConfirmDialog
          title={t(language, "prescription.doseCheckTitle")}
          body={t(language, doseConcern.kind === "perDose" ? "prescription.doseCheckPerDose" : "prescription.doseCheckPerDay", {
            dose: dose.trim(),
            perDay: String(Number(doseConcern.perDay.toFixed(2))),
            times: String(selectedTimes.length),
          })}
          confirmLabel={t(language, "prescription.doseCheckConfirm")}
          onConfirm={() => { setShowDoseConfirm(false); setDoseConfirmed(true); }}
          onCancel={() => setShowDoseConfirm(false)}
        />
      )}
      {showPhotoSource && (
        <PhotoSourceSheet
          onTakePhoto={() => { setShowPhotoSource(false); cameraRef.current?.click(); }}
          onChooseFile={() => { setShowPhotoSource(false); libraryRef.current?.click(); }}
          onClose={() => setShowPhotoSource(false)}
        />
      )}
    </div>
  );
}

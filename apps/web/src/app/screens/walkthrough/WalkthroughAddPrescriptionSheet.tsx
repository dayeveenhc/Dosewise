import { useState, useRef, useEffect } from "react";
import type { ReactNode, ChangeEvent } from "react";
import { X, Check, Plus, Pill, Camera, PenLine, Image as ImageIcon, Sparkles, ScanLine, AlertTriangle } from "lucide-react";
import type { Medication } from "../../types";
import { MED_COLOURS, MEDICATION_CATALOG, COMMON_CONDITIONS, MED_PHOTOS } from "../../data/medications";
import { TimesPicker, defaultDoseTime, toDisplayTime } from "../../components/TimesPicker";
import type { RoutineTimes } from "../../components/TimesPicker";
import { to24h } from "../../lib/medications";
import { ConfirmDialog } from "../../components/ConfirmDialog";

// Patch a duplicate scan hands back to the parent to fold into the existing med.
export interface MedUpdate { dose: string; time: string; times: string[]; refillDaysLeft?: number }

interface WalkthroughAddPrescriptionSheetProps {
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
  // The person's current medications, so a scan of one they already take is
  // recognised as a dose change (update the existing card) rather than a duplicate.
  existingMeds?: Medication[];
  onUpdateMed?: (id: number, patch: MedUpdate) => Promise<unknown> | void;
  // Which scripted scan this sheet stages (0 = Metformin dosage change, 1 =
  // eye drops) and how to advance it. Unlike the live AddPrescriptionSheet
  // this tracks in the walkthrough's own React state (via ScenarioWalkthroughPage
  // -> WalkthroughApp), not localStorage — sharing that key with the live app
  // would let each one silently advance the other's demo step.
  step: number;
  onAdvanceStep: () => void;
}

// --- Mock label scan (demo) --------------------------------------------------
// The real product reads the label with Hermes' vision tool. For the mockup we
// skip the backend and stage a short scripted sequence, advanced once per
// committed scan:
//   1. a *crumpled* Metformin refill — only the name reads through; dose + timing
//      are illegible, so the person enters them by hand (and, since they already
//      take Metformin, it updates that card instead of adding a duplicate);
//   2. a clean Latanoprost eye-drops label — fully read, no missing fields,
//      landing at 9 PM (bedtime) with only a 4-day supply so the later refill
//      alert and Travel Mode's "running low" warning both have something to
//      point at;
//   3. she's since collected the new prescription Travel Mode warned her
//      about — another clean Latanoprost label, this time with a full 30-day
//      supply, folded into the same existing card so the refill alert clears.
interface ScanScenario {
  name: string; purpose: string; dose: string; refillDays: string;
  crumpled: boolean; timeSlot: "morning" | "evening" | "bedtime"; photo: string;
}
const SCAN_SCENARIOS: ScanScenario[] = [
  { name: "Metformin",             purpose: "Diabetes", dose: "",              refillDays: "",   crumpled: true,  timeSlot: "morning", photo: MED_PHOTOS["Metformin"] },
  { name: "Latanoprost Eye Drops", purpose: "Glaucoma", dose: "1 drop each eye", refillDays: "4",  crumpled: false, timeSlot: "bedtime", photo: MED_PHOTOS["Warfarin"] },
  { name: "Latanoprost Eye Drops", purpose: "Glaucoma", dose: "1 drop each eye", refillDays: "30", crumpled: false, timeSlot: "bedtime", photo: MED_PHOTOS["Warfarin"] },
];

// Resolve a scenario's vague slot to the elder's own routine time.
const slotToTime = (slot: ScanScenario["timeSlot"], routine?: RoutineTimes) => {
  const raw = slot === "morning" ? (routine?.breakfast || "08:00")
            : slot === "evening" ? (routine?.dinner || "19:00")
            : (routine?.sleepTime || "22:00");
  return toDisplayTime(raw);
};

// Mei's "usual timing" guess for a medication with nothing on file yet —
// Metformin (for diabetes) is typically dosed twice a day, with breakfast and
// dinner, rather than the generic single-dose default.
const typicalTimesFor = (medName: string, routine?: RoutineTimes): string[] =>
  medName.trim().toLowerCase() === "metformin"
    ? [slotToTime("morning", routine), slotToTime("evening", routine)]
    : [defaultDoseTime(routine)];

// Describes suggested times loosely ("morning and evening") instead of exact
// clock times, since Mei is suggesting a usual routine, not reading a label.
const timeOfDayLabel = (hhmm12: string) => {
  const hour = Number(to24h(hhmm12).split(":")[0]);
  if (hour < 11) return "morning";
  if (hour < 16) return "midday";
  if (hour < 21) return "evening";
  return "bedtime";
};
const describeTimes = (times: string[]) => {
  const labels = [...new Set(times.map(timeOfDayLabel))];
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0];
};

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

// A small popover anchored to an "Ask Mei" button: Mei's guess for a blank
// field, with a Confirm that plays out the "checking against the label" beat
// before filling it in.
function AskMeiPopover({ message, checking, onConfirm, onClose }: {
  message: string;
  checking: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute z-30 right-0 top-full mt-2 w-60 bg-card border border-border rounded-2xl shadow-xl p-3.5">
      <div className="flex items-center gap-1.5 text-primary mb-1.5">
        <Sparkles size={14} />
        <span className="text-xs font-semibold">Mei</span>
      </div>
      <p className="text-xs text-foreground leading-relaxed mb-3">{message}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={checking}
          className="flex-1 bg-primary text-primary-foreground rounded-xl py-2 text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
        >
          {checking ? <Sparkles size={13} className="animate-pulse" /> : <Check size={13} />}
          {checking ? "Checking label…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={checking}
          className="px-3 rounded-xl border border-border text-xs font-semibold text-muted-foreground disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// A small round button that opens an AskMeiPopover — the "Ask Mei" trigger
// placed to the right of a blank field's input space.
function AskMeiButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Ask Mei"
      className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${open ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"}`}
    >
      <Sparkles size={16} />
    </button>
  );
}

export function WalkthroughAddPrescriptionSheet({ onClose, onAdd, onAdded, routine, existingMeds, onUpdateMed, step, onAdvanceStep }: WalkthroughAddPrescriptionSheetProps) {
  const [tab, setTab] = useState<"scan" | "manual">("scan");
  const [scannedPhoto, setScannedPhoto] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  // Set once a label has been "read": `crumpled` decides whether the banner warns
  // that the dose/timing were unreadable (fill by hand) or just confirms the read.
  const [scanNote, setScanNote] = useState<{ read: string; crumpled: boolean } | null>(null);
  const [submitState, setSubmitState] = useState<"idle" | "saving" | "success">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The already-taken med a committed scan would duplicate — set to open the
  // "update existing?" confirmation before writing.
  const [dupConfirm, setDupConfirm] = useState<Medication | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scanTimer = useRef<number | undefined>(undefined);
  // Which scripted scenario this scan stages. Frozen for the sheet's lifetime so
  // it can't shift mid-scan; the next open reads the parent's advanced step.
  const stepRef = useRef<number>(Math.min(SCAN_SCENARIOS.length - 1, Math.max(0, step)));
  const scenario = SCAN_SCENARIOS[stepRef.current];

  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const [purpose, setPurpose] = useState("");
  const [selectedTimes, setSelectedTimes] = useState<string[]>([defaultDoseTime(routine)]);
  const [refillDays, setRefillDays] = useState("");
  const [colour, setColour] = useState(MED_COLOURS[0].hex);
  // Which field's "Ask Mei" popover is open (only one at a time), and whether
  // its Confirm button is in the scripted "checking against the label" beat.
  const [askMeiOpen, setAskMeiOpen] = useState<"dose" | "purpose" | "times" | "refillDays" | null>(null);
  const [askMeiChecking, setAskMeiChecking] = useState(false);

  const isValid = name.trim() && dose.trim() && purpose.trim() && selectedTimes.length > 0;

  // What Mei would suggest for a field left blank by an unreadable label: the
  // person's existing record for this medication (truest "what you usually
  // take"), falling back to the general catalog entry. Times/refill always have
  // a fallback so the button never offers an empty suggestion; dose/purpose
  // only appear when there's an actual match to suggest.
  const nameKey = name.trim().toLowerCase();
  const existingMed = existingMeds?.find(m => m.name.trim().toLowerCase() === nameKey);
  const catalogMed = MEDICATION_CATALOG.find(m => m.name.toLowerCase() === nameKey);
  const askMeiSuggestion = {
    dose: existingMed?.dose || catalogMed?.dose,
    purpose: existingMed?.purpose || catalogMed?.purpose,
    times: existingMed?.times?.length ? existingMed.times : existingMed?.time ? [existingMed.time] : typicalTimesFor(name, routine),
    refillDays: existingMed?.refillDaysLeft != null ? String(existingMed.refillDaysLeft) : "30",
  };

  // Confirm always resolves as "matches the label" — there's no real vision
  // check in this mock, just the same short beat the scan animation already uses.
  const confirmAskMei = (field: "dose" | "purpose" | "times" | "refillDays") => {
    setAskMeiChecking(true);
    window.setTimeout(() => {
      if (field === "dose") setDose(askMeiSuggestion.dose ?? "");
      else if (field === "purpose") setPurpose(askMeiSuggestion.purpose ?? "");
      else if (field === "times") setSelectedTimes(askMeiSuggestion.times);
      else setRefillDays(askMeiSuggestion.refillDays);
      setAskMeiChecking(false);
      setAskMeiOpen(null);
    }, 900);
  };

  // Mock scan: stage the active scenario after a short loading animation. A
  // crumpled label fills only name + condition (dose/timing left blank to enter by
  // hand); a clean label fills everything. Nothing is committed here — the person
  // confirms via the "Add" button below (the real onAdd / onUpdateMed path).
  const runMockScan = (photoUrl: string) => {
    window.clearTimeout(scanTimer.current);
    setScannedPhoto(photoUrl);
    setScanNote(null);
    setScanning(true);
    setTab("scan");
    scanTimer.current = window.setTimeout(() => {
      setName(scenario.name);
      setPurpose(scenario.purpose);
      if (scenario.crumpled) {
        setDose("");           // illegible on the crumpled label — enter by hand
        setSelectedTimes([]);  // illegible — pick the times by hand
        setRefillDays("");
      } else {
        setDose(scenario.dose);
        setSelectedTimes([slotToTime(scenario.timeSlot, routine)]);
        setRefillDays(scenario.refillDays);
      }
      setScanNote({ read: scenario.name, crumpled: scenario.crumpled });
      setScanning(false);
      setTab("manual");
    }, 1800);
  };

  // Auto-start the mock scan the moment the sheet opens, so tapping "Add
  // prescription" goes straight into the scanning animation.
  useEffect(() => {
    runMockScan(scenario.photo);
    return () => window.clearTimeout(scanTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write the entered details — as a new medication, or (when they already take
  // it) folded into the existing card. Advances the scripted demo on success.
  const commit = async (dupMed?: Medication) => {
    const chosenTimes = selectedTimes;
    setSubmitState("saving");
    setSubmitError(null);
    try {
      if (dupMed && onUpdateMed) {
        await onUpdateMed(dupMed.id, {
          dose: dose.trim(),
          time: chosenTimes[0] || dupMed.time,
          times: chosenTimes,
          refillDaysLeft: refillDays ? parseInt(refillDays) : undefined,
        });
      } else {
        await onAdd({
          name: name.trim(),
          dose: dose.trim(),
          purpose: purpose.trim(),
          time: chosenTimes[0] || "8:00 AM",
          times: chosenTimes,
          refillDaysLeft: refillDays ? parseInt(refillDays) : undefined,
          colour,
        });
      }
      onAdvanceStep();
      setSubmitState("success");
      setDupConfirm(null);
      window.setTimeout(() => {
        onAdded?.();
        onClose();
      }, 700);
    } catch (error) {
      console.error("Failed to save medication", error);
      setSubmitState("idle");
      setDupConfirm(null);
      setSubmitError("Couldn't save the medication. Please try again.");
    }
  };

  const handleAdd = () => {
    if (!isValid || submitState === "saving") return;
    // Already take this one? Treat the scan as a dose change and confirm before
    // updating the existing card, rather than adding a second Metformin.
    const dup = onUpdateMed
      ? existingMeds?.find(m => m.name.trim().toLowerCase() === name.trim().toLowerCase())
      : undefined;
    if (dup) { setDupConfirm(dup); return; }
    void commit();
  };

  const pickMedication = (m: { name: string; purpose: string; dose: string }) => {
    setName(m.name);
    if (!purpose.trim()) setPurpose(m.purpose);
    if (!dose.trim()) setDose(m.dose);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // Mockup: the actual bytes aren't read — show the chosen image while the
    // canned scan runs.
    const isPdf = file.type === "application/pdf";
    runMockScan(isPdf ? scenario.photo : URL.createObjectURL(file));
  };

  const onSamplePhoto = () => runMockScan(scenario.photo);

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
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground">Add refill / prescription</h2>
            <p className="text-xs text-muted-foreground">Snap the label or type it in</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        {/* Mode toggle */}
        <div className="px-5 pt-3 shrink-0">
          <div className="flex gap-2 bg-muted rounded-xl p-1">
            <button
              onClick={() => setTab("scan")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${tab === "scan" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              <Camera size={16} />Scan photo
            </button>
            <button
              onClick={() => setTab("manual")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${tab === "manual" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              <PenLine size={16} />Enter manually
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          {tab === "scan" ? (
            <div className="space-y-3">
              {/* No `capture` here — mobile browsers bias straight into the camera
                  when it's present, which blocks picking an existing PDF from
                  Files. Omitting it still offers "Take Photo" as one of the
                  native picker's options, so scanning still works. */}
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onFile} />
              {scanning ? (
                <div className="border-2 border-primary/30 bg-primary/5 rounded-2xl p-6 flex flex-col items-center text-center gap-3">
                  {scannedPhoto && (
                    <div className="relative w-28 h-28 rounded-xl overflow-hidden">
                      <img src={scannedPhoto} alt="scan" className="w-full h-full object-cover" />
                      {/* Sweeping scan line over the label */}
                      <div className="absolute inset-x-0 h-0.5 bg-primary/80 shadow-[0_0_8px_2px] shadow-primary/50 animate-scanline" />
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-primary">
                    <ScanLine size={16} className="animate-pulse" />
                    <span className="text-sm font-semibold">Scanning prescription label…</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Reading the medication, dose and instructions</p>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="w-full border-2 border-dashed border-border rounded-2xl p-6 flex flex-col items-center text-center gap-2 active:bg-muted/50 transition-colors"
                  >
                    <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                      <Camera size={26} className="text-primary" />
                    </div>
                    <p className="text-[15px] font-semibold text-foreground">Scan another photo or file</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">Snap the medication box or prescription label, or upload a photo/PDF of it — Mei will read it and check the details with you.</p>
                  </button>
                  <button
                    onClick={onSamplePhoto}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-muted text-sm font-semibold text-foreground active:bg-muted/70"
                  >
                    <ImageIcon size={15} />Try with a sample photo
                  </button>
                  <p className="text-center text-[11px] text-muted-foreground">Prefer to type it?{" "}
                    <button onClick={() => setTab("manual")} className="text-primary font-semibold underline">Enter manually</button>
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Crumpled label → warn that the dose/timing were unreadable and
                  must be entered by hand. Clean label → just confirm the read. */}
              {scanNote && (scanNote.crumpled ? (
                <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3.5 space-y-1.5">
                  <div className="flex items-center gap-2 text-amber-700">
                    <AlertTriangle size={15} className="shrink-0" />
                    <span className="text-sm font-semibold">Label looks crumpled</span>
                  </div>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    I could read the name (<span className="font-semibold">{scanNote.read}</span>), but the
                    <span className="font-semibold"> dosage</span> and <span className="font-semibold">timing</span> were
                    too creased to make out. Please enter them yourself below.
                  </p>
                </div>
              ) : (
                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3.5 space-y-1">
                  <div className="flex items-center gap-2 text-primary">
                    <Sparkles size={15} className="shrink-0" />
                    <span className="text-sm font-semibold">Read from the label</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Got <span className="font-semibold text-foreground">{scanNote.read}</span> and its details — please check them before adding.
                  </p>
                </div>
              ))}

              {/* Medication name — type-ahead */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Medication name <span className="text-destructive">*</span></label>
                <TypeAhead
                  value={name}
                  onChange={setName}
                  onPick={pickMedication}
                  items={MEDICATION_CATALOG}
                  filter={(m, q) => m.name.toLowerCase().includes(q)}
                  label={m => m.name}
                  placeholder="Start typing, e.g. Metf…"
                  render={m => (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{m.name}</span>
                      <span className="text-[11px] text-muted-foreground">{m.purpose} · {m.dose}</span>
                    </div>
                  )}
                />
              </div>

              {/* Dose */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Dose <span className="text-destructive">*</span></label>
                <div className="flex items-center gap-2">
                  <input value={dose} onChange={e => setDose(e.target.value)} placeholder="e.g. 500mg, 2 tablets, 1 drop each eye" className={`${inputCls} flex-1`} />
                  {!dose.trim() && askMeiSuggestion.dose && (
                    <div className="relative">
                      <AskMeiButton open={askMeiOpen === "dose"} onToggle={() => setAskMeiOpen(o => o === "dose" ? null : "dose")} />
                      {askMeiOpen === "dose" && (
                        <AskMeiPopover
                          message={`You usually take ${name.trim() || "this"} as ${askMeiSuggestion.dose}. Want me to check that against the label?`}
                          checking={askMeiChecking}
                          onConfirm={() => confirmAskMei("dose")}
                          onClose={() => setAskMeiOpen(null)}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Purpose / condition — type-ahead */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Purpose / Condition <span className="text-destructive">*</span></label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <TypeAhead
                      value={purpose}
                      onChange={setPurpose}
                      onPick={c => setPurpose(c)}
                      items={COMMON_CONDITIONS}
                      filter={(c, q) => c.toLowerCase().includes(q)}
                      label={c => c}
                      placeholder="e.g. Diabetes, Blood Pressure"
                    />
                  </div>
                  {!purpose.trim() && askMeiSuggestion.purpose && (
                    <div className="relative">
                      <AskMeiButton open={askMeiOpen === "purpose"} onToggle={() => setAskMeiOpen(o => o === "purpose" ? null : "purpose")} />
                      {askMeiOpen === "purpose" && (
                        <AskMeiPopover
                          message={`${name.trim() || "This"} is usually for ${askMeiSuggestion.purpose}. Want me to check that against the label?`}
                          checking={askMeiChecking}
                          onConfirm={() => confirmAskMei("purpose")}
                          onClose={() => setAskMeiOpen(null)}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Time */}
              <TimesPicker
                times={selectedTimes}
                onChange={setSelectedTimes}
                label="Scheduled times"
                routine={routine}
                headerAction={selectedTimes.length === 0 ? (
                  <div className="relative">
                    <AskMeiButton open={askMeiOpen === "times"} onToggle={() => setAskMeiOpen(o => o === "times" ? null : "times")} />
                    {askMeiOpen === "times" && (
                      <AskMeiPopover
                        message={`You usually take ${name.trim() || "this"} in the ${describeTimes(askMeiSuggestion.times)}. Want me to check that against the label?`}
                        checking={askMeiChecking}
                        onConfirm={() => confirmAskMei("times")}
                        onClose={() => setAskMeiOpen(null)}
                      />
                    )}
                  </div>
                ) : undefined}
              />

              {/* Refill supply */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Current supply (days remaining)</label>
                <div className="flex items-center gap-2">
                  <input type="number" value={refillDays} onChange={e => setRefillDays(e.target.value)} placeholder="e.g. 28" min={1} className={`${inputCls} flex-1`} />
                  {!refillDays.trim() && (
                    <div className="relative">
                      <AskMeiButton open={askMeiOpen === "refillDays"} onToggle={() => setAskMeiOpen(o => o === "refillDays" ? null : "refillDays")} />
                      {askMeiOpen === "refillDays" && (
                        <AskMeiPopover
                          message={`Prescriptions like this usually come with about a ${askMeiSuggestion.refillDays}-day supply. Want me to check that against the label?`}
                          checking={askMeiChecking}
                          onConfirm={() => confirmAskMei("refillDays")}
                          onClose={() => setAskMeiOpen(null)}
                        />
                      )}
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">You'll be alerted when this runs low.</p>
              </div>

              {/* Colour */}
              <div>
                <label className="block text-xs font-semibold text-foreground mb-2">Colour label</label>
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
                    <p className="text-[11px] text-muted-foreground">{purpose} · {selectedTimes.join(" • ") || "8:00 AM"}</p>
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
              <div className={`rounded-xl border px-3 py-2.5 flex items-center gap-2 text-sm ${submitState === "saving" ? "border-primary/20 bg-primary/10 text-primary" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                {submitState === "saving" ? <Sparkles size={14} className="animate-pulse" /> : <Check size={14} />}
                <span>{submitState === "saving" ? "Saving medication…" : "Medication added"}</span>
              </div>
            )}
            <button
              onClick={handleAdd}
              disabled={!isValid || submitState === "saving" || submitState === "success"}
              className="w-full bg-primary text-primary-foreground rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
            >
              {submitState === "saving" ? <Sparkles size={16} className="animate-pulse" /> : submitState === "success" ? <Check size={16} /> : <Plus size={16} />}
              {submitState === "saving" ? "Adding…" : submitState === "success" ? "Added" : `Add ${name || "medication"}`}
            </button>
          </div>
        )}
      </div>

      {/* Already-taken med → confirm this is a dose change or refill to the existing card. */}
      {dupConfirm && (
        <ConfirmDialog
          title={`Update your ${dupConfirm.name}?`}
          body={`You already take ${dupConfirm.name} (${dupConfirm.dose}). This looks like an updated prescription — update your existing ${dupConfirm.name} instead of adding another one?`}
          confirmLabel="Update it"
          onConfirm={() => void commit(dupConfirm)}
          onCancel={() => setDupConfirm(null)}
        />
      )}
    </div>
  );
}

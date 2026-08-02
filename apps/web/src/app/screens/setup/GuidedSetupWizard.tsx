import { useRef, useState } from "react";
import type { ReactNode, ChangeEvent } from "react";
import { ArrowLeft, Loader2, Plus, X, Check, Sunrise, Coffee, Utensils, UtensilsCrossed, Moon, PartyPopper, Users, Camera, Sparkles, Venus, Mars, Eye, EyeOff } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { saveProfile, markWalkthroughCompleted } from "../../lib/profile";
import { addMedication, archiveMedication, to24h } from "../../lib/medications";
import { extractProfile, fileToBase64 } from "../../lib/hermes";
import { normalizeAllergies } from "../../lib/changeHighlight";
import { MEDICATION_CATALOG, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES, localizeCatalogValue } from "../../data/medications";
import { TimeField, TimesPicker, defaultDoseTime } from "../../components/TimesPicker";
import type { RoutineTimes } from "../../components/TimesPicker";
import type { PrefillMed, Role, WizardPrefill } from "../../lib/profile";
import { MeiSuggestButton } from "../../components/MeiSuggestButton";
import { PhotoSourceSheet } from "../../components/PhotoSourceSheet";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";
import type { AppLanguage } from "../../lib/language";
import { emitWalkthroughEvent } from "../../lib/walkthrough/bus";

// Maps a {value, labelKey} catalog entry list into the {value, label} pairs
// TagList/type-aheads render — display localizes, the stored `value` doesn't.
export const withCatalogLabels = (items: { value: string; labelKey: string }[], language: AppLanguage) =>
  items.map(i => ({ value: i.value, label: t(language, i.labelKey) }));

// A small shared gender picker — icon + label per option, used both here and
// in ElderlySettingsScreen's "edit what you answered" section.
// `inline` is the settings-row variant: two equal buttons the same height as the
// fields beside them, icon and word on ONE line. Stacked icon-over-label at that
// width left two squat boxes with the label crushed under the icon.
export function GenderPicker({ value, onChange, size = "base" }: { value: string; onChange: (g: string) => void; size?: "base" | "sm" | "inline" }) {
  const options = [{ g: "Female", Icon: Venus }, { g: "Male", Icon: Mars }] as const;
  const inline = size === "inline";
  return (
    <div className={`flex gap-2 ${inline ? "w-full" : ""}`}>
      {options.map(({ g, Icon }) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          aria-pressed={value === g}
          className={`flex-1 min-w-0 border transition-colors ${
            inline
              ? "h-10 rounded-lg flex items-center justify-center gap-1.5 px-2"
              : `flex flex-col items-center gap-1 rounded-xl ${size === "sm" ? "py-2.5" : "py-3"}`
          } ${value === g ? "bg-primary text-primary-foreground border-primary" : "bg-input-background text-foreground border-border"}`}
        >
          <Icon size={inline ? 15 : size === "sm" ? 16 : 20} className="shrink-0" />
          <span className={`font-semibold truncate ${inline ? "text-[calc(14px*var(--dw-text,1))]" : size === "sm" ? "text-sm" : "text-base"}`}>{g}</span>
        </button>
      ))}
    </div>
  );
}

const fieldBase = "w-full bg-input-background rounded-xl px-4 py-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none transition-colors border";
export const fieldCls = `${fieldBase} border-border focus:border-primary`;
const fieldClsValid = `${fieldBase} border-taken focus:border-taken`;
// Swaps the border to green once a field's value satisfies its own validity check
// (e.g. password long enough, a real-looking email) — leaves it neutral otherwise.
export const cls = (valid: boolean) => valid ? fieldClsValid : fieldCls;
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const isPositiveNumber = (v: string) => v.trim() !== "" && Number(v) > 0;
// Mei's suggestion for a numeric field may come back with units attached
// ("70 kg") — pull just the leading number so it lands in a number input cleanly.
const extractNumber = (v: string) => v.match(/\d+(\.\d+)?/)?.[0] ?? v;
const to24hDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function WizardChrome({ step, total, onBack, showBack = true, children }: { step: number; total: number; onBack: () => void; showBack?: boolean; children: ReactNode }) {
  const { language } = useLanguage();
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-4 pt-4 pb-1 flex items-center gap-3 shrink-0">
        {showBack ? (
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors shrink-0" aria-label={t(language, "wizard.back")}>
            <ArrowLeft size={16} className="text-foreground" />
          </button>
        ) : (
          <div className="w-9 h-9 shrink-0" />
        )}
        <div className="flex-1 flex gap-1.5">
          {Array.from({ length: total }, (_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-none px-6 pt-3 pb-6 flex flex-col">{children}</div>
    </div>
  );
}

function ReviewBadge() {
  const { language } = useLanguage();
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-taken-border bg-taken-bg px-3 py-2.5">
      <Sparkles size={14} className="text-taken-fg mt-0.5 shrink-0" />
      <p className="text-xs text-taken-fg leading-relaxed">{t(language, "setup.autofilledReview")}</p>
    </div>
  );
}

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h1 className="font-['Fraunces'] text-xl font-semibold text-foreground leading-snug mb-1.5">{title}</h1>
      <p className="text-sm text-muted-foreground leading-relaxed">{subtitle}</p>
    </div>
  );
}

function ContinueButton({ onClick, disabled, loading, children = "Continue" }: { onClick: () => void; disabled?: boolean; loading?: boolean; children?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      // A single shared selector: only one ContinueButton is ever mounted at a
      // time (one wizard step renders at once), so "whichever Continue/Create
      // button is currently shown" is unambiguous.
      data-walk="wizard-continue-button"
      className="w-full h-13 py-3.5 mt-auto rounded-2xl bg-primary text-primary-foreground text-[calc(15px*var(--dw-text,1))] font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

export function TagList({ label, placeholder, items, suggestions, extractField, onAdd, onRemove, "data-walk": dataWalk }: {
  label: string; placeholder: string; items: string[]; suggestions?: { value: string; label: string }[];
  extractField?: "conditions" | "allergies" | "drug_allergies";
  onAdd: (v: string) => void; onRemove: (i: number) => void;
  "data-walk"?: string;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scanCameraRef = useRef<HTMLInputElement>(null);
  const scanLibraryRef = useRef<HTMLInputElement>(null);
  const [showPhotoSource, setShowPhotoSource] = useState(false);
  const submit = (pick?: string) => {
    const val = (pick ?? value).trim();
    if (val) { onAdd(val); setValue(""); setOpen(false); }
  };
  // Real scan: pull structured fields from an uploaded report/label and add the
  // ones for THIS list (conditions / allergies / drug allergies). The person
  // still sees each tag and can remove it before continuing.
  const onScanFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !extractField) return;
    setScanning(true);
    try {
      const b64 = await fileToBase64(file);
      const isPdf = file.type === "application/pdf";
      const { fields } = await extractProfile(isPdf ? undefined : b64, isPdf ? b64 : undefined);
      for (const v of fields[extractField] ?? []) {
        const val = (v ?? "").trim();
        if (val && !items.some(x => x.toLowerCase() === val.toLowerCase())) onAdd(val);
      }
    } finally {
      setScanning(false);
    }
  };
  const { language } = useLanguage();
  const q = value.trim().toLowerCase();
  // Match on the localized label OR the canonical English value: filtering on
  // the label alone meant that in Chinese "diab" matched nothing, and deduping
  // on an exact-case value let someone re-add an entry they already had under
  // different capitalisation.
  const chosen = new Set(items.map(i => i.trim().toLowerCase()));
  const matches = q && suggestions
    ? suggestions
        .filter(s => (s.label.toLowerCase().includes(q) || s.value.toLowerCase().includes(q))
          && !chosen.has(s.value.trim().toLowerCase()))
        .slice(0, 6)
    : [];
  return (
    <div className="mb-5" data-walk={dataWalk}>
      <label className="block text-sm font-semibold text-foreground mb-2">{label}</label>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2.5">
          {items.map((it, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 bg-secondary border border-primary/20 text-primary rounded-xl px-2.5 py-1.5 text-sm font-medium">
              {localizeCatalogValue(it, k => t(language, k))}
              <button onClick={() => onRemove(i)} className="text-primary/60 hover:text-destructive transition-colors">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <div className="flex gap-2">
          <input
            value={value}
            onChange={e => { setValue(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={e => e.key === "Enter" && submit()}
            placeholder={placeholder}
            className={`${fieldCls} flex-1`}
          />
          <button onClick={() => submit()} disabled={!value.trim()} data-walk={dataWalk && `${dataWalk}-add-btn`} className="w-11 h-11 bg-primary rounded-xl flex items-center justify-center disabled:opacity-40 shrink-0">
            <Plus size={18} className="text-white" />
          </button>
          {extractField && (
            <button onClick={() => setShowPhotoSource(true)} disabled={scanning} title={t(language, "wizard.scanReportOrLabel")} className="w-11 h-11 bg-muted rounded-xl flex items-center justify-center disabled:opacity-60 shrink-0">
              {scanning ? <Sparkles size={16} className="text-primary animate-pulse" /> : <Camera size={18} className="text-foreground" />}
            </button>
          )}
          <input ref={scanCameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onScanFile} />
          <input ref={scanLibraryRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onScanFile} />
          {showPhotoSource && (
            <PhotoSourceSheet
              onTakePhoto={() => { setShowPhotoSource(false); scanCameraRef.current?.click(); }}
              onChooseFile={() => { setShowPhotoSource(false); scanLibraryRef.current?.click(); }}
              onClose={() => setShowPhotoSource(false)}
            />
          )}
        </div>
        {open && matches.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-48 overflow-y-auto">
            {matches.map(m => (
              <button key={m.value} onMouseDown={e => { e.preventDefault(); submit(m.value); }} className="w-full text-left px-3.5 py-2.5 hover:bg-muted active:bg-muted border-b border-border/50 last:border-0 transition-colors text-sm text-foreground">
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface DraftMed { name: string; dose: string; times: string[] }

const toDraftMeds = (meds?: PrefillMed[]): DraftMed[] =>
  (meds ?? []).map(m => ({ name: m.name, dose: m.dose, times: [m.time] }));

function MedList({ meds, extractKind, routine, onAdd, onRemove, "data-walk": dataWalk }: { meds: DraftMed[]; extractKind: "current" | "past"; routine: RoutineTimes; onAdd: (m: DraftMed) => void; onRemove: (i: number) => void; "data-walk"?: string }) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const defaultTime = defaultDoseTime(routine);
  const [times, setTimes] = useState<string[]>([defaultTime]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [showPhotoSource, setShowPhotoSource] = useState(false);

  const submit = () => {
    if (!name.trim() || !times.length) return;
    onAdd({ name: name.trim(), dose: dose.trim() || t(language, "wizard.asDirected"), times });
    setName(""); setDose(""); setTimes([defaultTime]); setOpen(false); setProposal(null);
  };

  const cancel = () => {
    setOpen(false);
    setProposal(null);
  };

  // Real upload: the photo/PDF goes to Hermes's structured /profile/extract
  // endpoint, which returns the medications it read. We add each one to the list
  // (reviewable + removable) rather than guessing from a catalog substring.
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const isPdf = file.type === "application/pdf";
    setScanning(true);
    setProposal(null);
    try {
      const b64 = await fileToBase64(file);
      const { fields, note } = await extractProfile(isPdf ? undefined : b64, isPdf ? b64 : undefined);
      const found = (extractKind === "past" ? fields.past_meds : fields.current_meds) ?? [];
      let added = 0;
      for (const m of found) {
        const medName = (m.name ?? "").trim();
        if (!medName) continue;
        onAdd({ name: medName, dose: (m.dose ?? "").trim() || t(language, "wizard.asDirected"), times: [defaultTime] });
        added++;
      }
      setProposal(added ? t(language, "wizard.uploadAddedCount", { count: added }) : (note ?? t(language, "wizard.uploadNoMed")));
      if (!added) setOpen(true);
    } finally {
      setScanning(false);
    }
  };

  const q = name.trim().toLowerCase();
  const matches = q ? MEDICATION_CATALOG.filter(m => m.name.toLowerCase().includes(q)).slice(0, 6) : [];

  return (
    <div>
      {/* Two inputs — one camera-only, one library/Files-only — backing the
          explicit PhotoSourceSheet chooser below, so both are always reachable
          regardless of what a given mobile browser's native picker defaults to. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile} />
      <input ref={libraryRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onFile} />
      {showPhotoSource && (
        <PhotoSourceSheet
          onTakePhoto={() => { setShowPhotoSource(false); cameraRef.current?.click(); }}
          onChooseFile={() => { setShowPhotoSource(false); libraryRef.current?.click(); }}
          onClose={() => setShowPhotoSource(false)}
        />
      )}
      {meds.length > 0 && (
        <div className="space-y-2 mb-3">
          {meds.map((m, i) => (
            <div key={i} className="flex items-center gap-3 bg-muted rounded-xl px-3.5 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{m.name} <span className="text-xs font-normal text-muted-foreground">{m.dose}</span></p>
                <p className="text-xs text-muted-foreground">{m.times.join(" · ")}</p>
              </div>
              <button onClick={() => onRemove(i)} className="shrink-0 text-muted-foreground hover:text-destructive transition-colors">
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {open ? (
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          {(scanning || proposal) && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 flex gap-3">
              <div className="flex-1 min-w-0">
                {scanning ? (
                  <p className="text-xs text-primary font-semibold flex items-center gap-1.5"><Sparkles size={12} className="animate-pulse" />{t(language, "wizard.reading")}</p>
                ) : (
                  <p className="text-xs text-muted-foreground leading-relaxed">{proposal}</p>
                )}
              </div>
            </div>
          )}
          <div className="relative">
            <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.medicationName")}</label>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder={t(language, "wizard.medicationNamePlaceholder")}
              className={fieldCls}
              autoFocus
            />
            {showSuggestions && matches.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                {matches.map(m => (
                  <button
                    key={m.name}
                    onMouseDown={e => { e.preventDefault(); setName(m.name); setDose(m.dose); setShowSuggestions(false); }}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-muted active:bg-muted border-b border-border/50 last:border-0 transition-colors"
                  >
                    <span className="text-sm font-medium text-foreground">{m.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{m.purpose} · {m.dose}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.dose")}</label>
            <input value={dose} onChange={e => setDose(e.target.value)} placeholder={t(language, "wizard.dosePlaceholder")} className={fieldCls} />
          </div>
          <TimesPicker
            times={times}
            onChange={setTimes}
            label={t(language, "wizard.usualTimes")}
            routine={routine}
            data-walk={dataWalk && `${dataWalk}-timespicker`}
            walkEvent={dataWalk && `${dataWalk}-times-changed`}
          />
          <div className="flex gap-2 pt-1">
            <button onClick={cancel} className="flex-1 h-10 rounded-xl border border-border text-muted-foreground text-sm font-semibold">{t(language, "wizard.cancel")}</button>
            <button onClick={submit} disabled={!name.trim() || !times.length} data-walk={dataWalk && `${dataWalk}-add-btn`} className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-bold disabled:opacity-40">{t(language, "wizard.add")}</button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setOpen(true)} data-walk={dataWalk && `${dataWalk}-open`} className="flex-1 h-12 rounded-2xl border-2 border-dashed border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
            <Plus size={15} />{t(language, "wizard.addMedication")}
          </button>
          <button onClick={() => setShowPhotoSource(true)} disabled={scanning} className="flex-1 h-12 rounded-2xl border-2 border-dashed border-primary/40 text-primary text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60">
            {scanning ? <Sparkles size={15} className="animate-pulse" /> : <Camera size={15} />}
            {scanning ? t(language, "wizard.reading") : t(language, "wizard.scanOrUpload")}
          </button>
        </div>
      )}
    </div>
  );
}

export function GuidedSetupWizard({ mode, hasSession, elderId: initialElderId, prefill, onComplete, onExit }: {
  mode: "elderly" | "caregiver";
  hasSession: boolean;
  elderId?: string;
  // Fields pulled from an uploaded record on the setup-method screen; seeds the
  // answers so the user reviews + edits instead of typing from scratch.
  prefill?: WizardPrefill;
  onComplete: () => void;
  onExit: () => void;
}) {
  // Frozen at mount: once the account step creates a session mid-wizard, the
  // parent's live `hasSession` prop flips true, which would otherwise filter
  // "account" out of `steps` mid-flow and shift every later index by one.
  const { language } = useLanguage();
  const [hasSessionAtStart] = useState(hasSession);
  const [stepIndex, setStepIndex] = useState(0);
  const [elderId, setElderId] = useState<string | undefined>(initialElderId);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountInfo, setAccountInfo] = useState<string | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Seeded once from `prefill` (an uploaded-record extraction) so the user
  // reviews pre-filled answers; empty when the person chose guided setup.
  const [fullName, setFullName] = useState(prefill?.fullName ?? "");
  const [dob, setDob] = useState(prefill?.details.dob ?? "");
  const [weightKg, setWeightKg] = useState(prefill?.details.weightKg != null ? String(prefill.details.weightKg) : "");
  const [heightCm, setHeightCm] = useState(prefill?.details.heightCm != null ? String(prefill.details.heightCm) : "");
  const [gender, setGender] = useState(prefill?.details.gender ?? "");
  const [conditions, setConditions] = useState<string[]>(prefill?.details.conditions ?? []);
  // Extraction prefill is always plain strings, but ProfileDetails.allergies
  // may carry promoted {name, severity} entries — normalize to names here.
  const [allergies, setAllergies] = useState<string[]>(() => normalizeAllergies(prefill?.details.allergies).map(a => a.name).filter(Boolean));
  const [drugAllergies, setDrugAllergies] = useState<string[]>(prefill?.details.drugAllergies ?? []);
  const [wakeTime, setWakeTime] = useState(prefill?.details.wakeTime ?? "07:00");
  // An extraction yields one time per med; the wizard's multi-select shape wraps
  // it so the person can add more times on top of what was read.
  const [currentMeds, setCurrentMeds] = useState<DraftMed[]>(() => toDraftMeds(prefill?.currentMeds));
  const [pastMeds, setPastMeds] = useState<DraftMed[]>(() => toDraftMeds(prefill?.pastMeds));
  const [breakfast, setBreakfast] = useState("08:00");
  const [lunch, setLunch] = useState("12:30");
  const [dinner, setDinner] = useState("19:00");
  const [sleepTime, setSleepTime] = useState("22:30");
  const [finishing, setFinishing] = useState(false);

  // The routine step runs before the medication steps, so these are already
  // answered by the time the time picker offers its quick chips.
  const routine: RoutineTimes = { breakfast, lunch, dinner, sleepTime };

  // Whether the upload pre-filled anything worth flagging for review.
  const prefilled = !!prefill && (
    !!prefill.fullName ||
    Object.keys(prefill.details).length > 0 ||
    prefill.currentMeds.length > 0 ||
    prefill.pastMeds.length > 0
  );

  const role: Role = mode === "elderly" ? "elder" : "caregiver";
  // "routine" runs before the medication steps: the meal and bedtime answers are
  // the frame people describe their doses against ("one after breakfast"), so
  // asking them first makes the med steps easier to answer.
  const allSteps = mode === "elderly"
    ? ["account", "profile", "conditions", "allergies", "routine", "current-meds", "med-history", "done"]
    : ["account", "placeholder"];
  // The "account" step always runs — even with a session already in hand — so
  // a returning user who signed up via email confirmation still gets asked
  // their preferred name; only the email/password fields are skipped for them.
  const steps = allSteps;
  const step = steps[stepIndex];
  const total = steps.length;
  const showBackButton = step !== "done";

  const goNext = () => setStepIndex(i => {
    const next = Math.min(i + 1, steps.length - 1);
    // The onboarding walkthrough's step-transition steps ride this signal
    // rather than the Continue button's raw click, since createAccount (the
    // one async case) only ever calls goNext() after a successful signup —
    // this stays correct for both the sync and async Continue buttons alike.
    if (next !== i) emitWalkthroughEvent("wizard-step-changed", { toStep: steps[next] });
    return next;
  });
  const goBack = () => setStepIndex(i => Math.max(i - 1, 0));

  const createAccount = async () => {
    if (!email.trim() || !password.trim()) return;
    setAccountLoading(true);
    setAccountError(null);
    setAccountInfo(null);
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
    setAccountLoading(false);
    if (error) { setAccountError(error.message); return; }
    if (!data.session || !data.user) {
      setAccountInfo(t(language, "wizard.checkEmail"));
      return;
    }
    setElderId(data.user.id);
    goNext();
  };

  const finish = async () => {
    if (!elderId) return;
    setFinishing(true);
    if (mode === "elderly") {
      await saveProfile(elderId, role, fullName, {
        dob: dob || undefined,
        weightKg: weightKg ? Number(weightKg) : undefined,
        heightCm: heightCm ? Number(heightCm) : undefined,
        gender: gender || undefined,
        conditions,
        allergies, drugAllergies,
        wakeTime,
        mealTimes: { breakfast, lunch, dinner },
        sleepTime,
      });
      for (const m of currentMeds) {
        await addMedication(elderId, { name: m.name, dosage: m.dose, purpose: "", timeHHMMs: m.times.map(to24h) });
      }
      for (const m of pastMeds) {
        const id = await addMedication(elderId, { name: m.name, dosage: m.dose, purpose: "", timeHHMMs: m.times.map(to24h) });
        await archiveMedication(id);
      }
    } else {
      await saveProfile(elderId, role, fullName, {});
    }
    // Mark this task done so prompts.py's "not yet shown" gate can actually
    // suppress re-offering onboarding once it's genuinely complete — every
    // wizard run (new signup or a chat-triggered one) reaches this point.
    await markWalkthroughCompleted(elderId, role, "onboarding");
    setFinishing(false);
    // Gated on the real, resolved profile/medication writes above — never the
    // Finish button's click alone.
    emitWalkthroughEvent("wizard-finished");
    onComplete();
  };

  return (
    <WizardChrome step={stepIndex} total={total} onBack={stepIndex > 0 ? goBack : onExit} showBack={showBackButton}>
      {step === "account" && (
        <>
          <StepHeader
            title={hasSessionAtStart ? t(language, "wizard.accountTitleReturning") : t(language, "wizard.accountTitleNew")}
            subtitle={hasSessionAtStart ? t(language, "wizard.accountSubtitleReturning") : t(language, "wizard.accountSubtitleNew")}
          />
          <div className="space-y-3 flex-1">
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.preferredName")}</label>
              <input data-walk="wizard-fullname" value={fullName} onChange={e => setFullName(e.target.value)} placeholder={t(language, "wizard.preferredNamePlaceholder")} className={cls(fullName.trim().length > 0)} />
            </div>
            {!hasSessionAtStart && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.email")}</label>
                  <input data-walk="wizard-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t(language, "wizard.emailPlaceholder")} className={cls(isEmail(email))} autoComplete="email" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.password")}</label>
                  <div className="relative">
                    <input
                      data-walk="wizard-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && createAccount()}
                      placeholder={t(language, "wizard.passwordPlaceholder")}
                      className={`${cls(password.length >= 6)} pr-11`}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowPassword(v => !v)}
                      aria-label={showPassword ? t(language, "common.hidePassword") : t(language, "common.showPassword")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </div>
              </>
            )}
            {accountError && <p className="text-xs text-destructive font-medium">{accountError}</p>}
            {accountInfo && <p className="text-xs text-primary font-medium">{accountInfo}</p>}
          </div>
          {hasSessionAtStart ? (
            <ContinueButton onClick={goNext} disabled={!fullName.trim()}>{t(language, "wizard.continue")}</ContinueButton>
          ) : (
            <ContinueButton onClick={createAccount} disabled={!email.trim() || !password.trim()} loading={accountLoading}>{t(language, "wizard.createAccount")}</ContinueButton>
          )}
        </>
      )}

      {step === "profile" && (
        <>
          <StepHeader title={t(language, "wizard.profileTitle")} subtitle={t(language, "wizard.profileSubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="space-y-3 flex-1">
            <div className="flex gap-3">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-foreground">{t(language, "settings.dob")}</label>
                  {!dob.trim() && (
                    <MeiSuggestButton
                      fieldLabel={t(language, "settings.dob")}
                      formatHint="Reply in YYYY-MM-DD format only."
                      validate={v => /^\d{4}-\d{2}-\d{2}$/.test(v)}
                      onAccept={setDob}
                    />
                  )}
                </div>
                <input data-walk="wizard-dob" type="date" value={dob} onChange={e => setDob(e.target.value)} max={to24hDate(new Date())} className={cls(dob.trim().length > 0)} />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-foreground">{t(language, "settings.gender")}</label>
                  {!gender.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.gender")} onAccept={v => setGender(/^f/i.test(v) ? "Female" : /^m/i.test(v) ? "Male" : v)} />}
                </div>
                <div data-walk="wizard-gender-picker"><GenderPicker value={gender} onChange={setGender} /></div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-foreground">{t(language, "settings.weightKg")}</label>
                  {!weightKg.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.weightKg")} onAccept={v => setWeightKg(extractNumber(v))} />}
                </div>
                <input data-walk="wizard-weight" type="number" value={weightKg} onChange={e => setWeightKg(e.target.value)} placeholder={t(language, "wizard.weightPlaceholder")} className={cls(isPositiveNumber(weightKg))} />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-foreground">{t(language, "settings.heightCm")}</label>
                  {!heightCm.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.heightCm")} onAccept={v => setHeightCm(extractNumber(v))} />}
                </div>
                <input data-walk="wizard-height" type="number" value={heightCm} onChange={e => setHeightCm(e.target.value)} placeholder={t(language, "wizard.heightPlaceholder")} className={cls(isPositiveNumber(heightCm))} />
              </div>
            </div>
          </div>
          <ContinueButton onClick={goNext}>{t(language, "wizard.continue")}</ContinueButton>
        </>
      )}

      {step === "conditions" && (
        <>
          <StepHeader title={t(language, "wizard.conditionsTitle")} subtitle={t(language, "wizard.conditionsSubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <TagList data-walk="wizard-conditions-taglist" label={t(language, "common.medicalConditions")} placeholder={t(language, "wizard.conditionsPlaceholder")} items={conditions} suggestions={withCatalogLabels(COMMON_CONDITIONS, language)} extractField="conditions" onAdd={v => setConditions(p => [...p, v])} onRemove={i => setConditions(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{conditions.length ? t(language, "wizard.continue") : t(language, "wizard.skipForNow")}</ContinueButton>
        </>
      )}

      {step === "allergies" && (
        <>
          <StepHeader title={t(language, "wizard.allergiesTitle")} subtitle={t(language, "wizard.allergiesSubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <TagList data-walk="wizard-allergies-taglist" label={t(language, "settings.generalAllergies")} placeholder={t(language, "wizard.allergiesPlaceholder")} items={allergies} suggestions={withCatalogLabels(COMMON_ALLERGIES, language)} extractField="allergies" onAdd={v => setAllergies(p => [...p, v])} onRemove={i => setAllergies(p => p.filter((_, j) => j !== i))} />
            <TagList data-walk="wizard-drug-allergies-taglist" label={t(language, "settings.medicationAllergies")} placeholder={t(language, "wizard.drugAllergiesPlaceholder")} items={drugAllergies} suggestions={withCatalogLabels(COMMON_DRUG_ALLERGIES, language)} extractField="drug_allergies" onAdd={v => setDrugAllergies(p => [...p, v])} onRemove={i => setDrugAllergies(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{t(language, "wizard.continue")}</ContinueButton>
        </>
      )}

      {step === "current-meds" && (
        <>
          <StepHeader title={t(language, "wizard.currentMedsTitle")} subtitle={t(language, "wizard.currentMedsSubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <MedList data-walk="wizard-medlist" meds={currentMeds} extractKind="current" routine={routine} onAdd={m => setCurrentMeds(p => [...p, m])} onRemove={i => setCurrentMeds(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{currentMeds.length ? t(language, "wizard.continue") : t(language, "wizard.skipForNow")}</ContinueButton>
        </>
      )}

      {step === "med-history" && (
        <>
          <StepHeader title={t(language, "wizard.medHistoryTitle")} subtitle={t(language, "wizard.medHistorySubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <MedList data-walk="wizard-medlist" meds={pastMeds} extractKind="past" routine={routine} onAdd={m => setPastMeds(p => [...p, m])} onRemove={i => setPastMeds(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{pastMeds.length ? t(language, "wizard.continue") : t(language, "wizard.skipForNow")}</ContinueButton>
        </>
      )}

      {step === "routine" && (
        <>
          <StepHeader title={t(language, "wizard.routineTitle")} subtitle={t(language, "wizard.routineSubtitle")} />
          <div className="space-y-3 flex-1">
            <TimeField data-walk="wizard-routine-wakeTime" walkEvent="wizard-routine-wakeTime-changed" label={t(language, "wizard.wakeUpTime")} icon={<Sunrise size={15} className="text-primary" />} value={wakeTime} onChange={setWakeTime} />
            <TimeField data-walk="wizard-routine-breakfast" walkEvent="wizard-routine-breakfast-changed" label={t(language, "wizard.breakfast")} icon={<Coffee size={15} className="text-primary" />} value={breakfast} onChange={setBreakfast} />
            <TimeField data-walk="wizard-routine-lunch" walkEvent="wizard-routine-lunch-changed" label={t(language, "wizard.lunch")} icon={<Utensils size={15} className="text-primary" />} value={lunch} onChange={setLunch} />
            <TimeField data-walk="wizard-routine-dinner" walkEvent="wizard-routine-dinner-changed" label={t(language, "wizard.dinner")} icon={<UtensilsCrossed size={15} className="text-primary" />} value={dinner} onChange={setDinner} />
            <TimeField data-walk="wizard-routine-sleepTime" walkEvent="wizard-routine-sleepTime-changed" label={t(language, "wizard.bedtime")} icon={<Moon size={15} className="text-primary" />} value={sleepTime} onChange={setSleepTime} />

          </div>
          <ContinueButton onClick={goNext}>{t(language, "wizard.continue")}</ContinueButton>
        </>
      )}

      {step === "done" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <PartyPopper size={30} className="text-primary" />
            </div>
            <h1 className="font-['Fraunces'] text-xl font-semibold text-foreground mb-2">{t(language, "wizard.allSet", { name: fullName ? `, ${fullName}` : "" })}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[260px]">{t(language, "wizard.profileReady")}</p>
          </div>
          <ContinueButton onClick={finish} loading={finishing}><Check size={16} />{t(language, "wizard.goToDosewise")}</ContinueButton>
        </>
      )}

      {step === "placeholder" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Users size={28} className="text-primary" />
            </div>
            <h1 className="font-['Fraunces'] text-xl font-semibold text-foreground mb-2">{t(language, "wizard.youreSetUp")}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[260px]">{t(language, "wizard.caregiverPlaceholderBody")}</p>
          </div>
          <ContinueButton onClick={finish} loading={finishing}><Check size={16} />{t(language, "wizard.goToDosewise")}</ContinueButton>
        </>
      )}
    </WizardChrome>
  );
}

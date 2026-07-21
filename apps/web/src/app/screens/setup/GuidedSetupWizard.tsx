import { useEffect, useRef, useState } from "react";
import type { ReactNode, ChangeEvent } from "react";
import { ArrowLeft, Loader2, Plus, X, Check, Sunrise, Coffee, Utensils, UtensilsCrossed, Moon, PartyPopper, Users, Camera, Sparkles, Venus, Mars, Eye, EyeOff } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { saveProfile } from "../../lib/profile";
import { addMedication, archiveMedication, to24h } from "../../lib/medications";
import { extractProfile, fileToBase64 } from "../../lib/hermes";
import type { ExtractedProfile } from "../../lib/hermes";
import { MEDICATION_CATALOG, MEAL_TIMES, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES } from "../../data/medications";
import { TimeField, TimesPicker, defaultDoseTime } from "../../components/TimesPicker";
import type { RoutineTimes } from "../../components/TimesPicker";
import { resetRefillDemo } from "../AddPrescriptionSheet";
import type { PrefillMed, Role, WizardPrefill } from "../../lib/profile";
import { useLanguage } from "../../lib/languageContext";
import { t } from "../../lib/language";

// A small shared gender picker — icon + label per option, used both here and
// in ElderlySettingsScreen's "edit what you answered" section.
export function GenderPicker({ value, onChange, size = "base" }: { value: string; onChange: (g: string) => void; size?: "base" | "sm" }) {
  const options = [{ g: "Female", Icon: Venus }, { g: "Male", Icon: Mars }] as const;
  return (
    <div className="flex gap-2">
      {options.map(({ g, Icon }) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          className={`flex-1 flex flex-col items-center gap-1 rounded-xl border transition-colors ${size === "sm" ? "py-2.5" : "py-3"} ${value === g ? "bg-primary text-primary-foreground border-primary" : "bg-input-background text-foreground border-border"}`}
        >
          <Icon size={size === "sm" ? 16 : 20} />
          <span className={`font-semibold ${size === "sm" ? "text-sm" : "text-base"}`}>{g}</span>
        </button>
      ))}
    </div>
  );
}

const fieldBase = "w-full bg-input-background rounded-xl px-4 py-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none transition-colors border";
export const fieldCls = `${fieldBase} border-border focus:border-primary`;
const fieldClsValid = `${fieldBase} border-emerald-500 focus:border-emerald-500`;
// Swaps the border to green once a field's value satisfies its own validity check
// (e.g. password long enough, a real-looking email) — leaves it neutral otherwise.
export const cls = (valid: boolean) => valid ? fieldClsValid : fieldCls;
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const isPositiveNumber = (v: string) => v.trim() !== "" && Number(v) > 0;
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
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-300/60 bg-emerald-50 px-3 py-2.5">
      <Sparkles size={14} className="text-emerald-600 mt-0.5 shrink-0" />
      <p className="text-xs text-emerald-800 leading-relaxed">{t(language, "setup.autofilledReview")}</p>
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
      className="w-full h-13 py-3.5 mt-auto rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

export function TagList({ label, placeholder, items, suggestions, extractField, onAdd, onRemove }: {
  label: string; placeholder: string; items: string[]; suggestions?: string[];
  extractField?: "conditions" | "allergies" | "drug_allergies";
  onAdd: (v: string) => void; onRemove: (i: number) => void;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
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
  const matches = q && suggestions
    ? suggestions.filter(s => s.toLowerCase().includes(q) && !items.includes(s)).slice(0, 6)
    : [];
  return (
    <div className="mb-5">
      <label className="block text-sm font-semibold text-foreground mb-2">{label}</label>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2.5">
          {items.map((it, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 bg-secondary border border-primary/20 text-primary rounded-xl px-2.5 py-1.5 text-sm font-medium">
              {it}
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
          <button onClick={() => submit()} disabled={!value.trim()} className="w-11 h-11 bg-primary rounded-xl flex items-center justify-center disabled:opacity-40 shrink-0">
            <Plus size={18} className="text-white" />
          </button>
          {extractField && (
            <button onClick={() => scanRef.current?.click()} disabled={scanning} title={t(language, "wizard.scanReportOrLabel")} className="w-11 h-11 bg-muted rounded-xl flex items-center justify-center disabled:opacity-60 shrink-0">
              {scanning ? <Sparkles size={16} className="text-primary animate-pulse" /> : <Camera size={18} className="text-foreground" />}
            </button>
          )}
          <input ref={scanRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onScanFile} />
        </div>
        {open && matches.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden max-h-48 overflow-y-auto">
            {matches.map(m => (
              <button key={m} onMouseDown={e => { e.preventDefault(); submit(m); }} className="w-full text-left px-3.5 py-2.5 hover:bg-muted active:bg-muted border-b border-border/50 last:border-0 transition-colors text-sm text-foreground">
                {m}
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

// Demo "scan" result for the medication step: clicking Scan runs a mock label
// read that surfaces these after a short loading animation (nothing is
// pre-listed). Current meds mirror the Metformin/Amlodipine morning routine the
// rest of the app references; the history step reads none.
const DEMO_SCAN_MEDS: Record<"current" | "past", DraftMed[]> = {
  current: [
    { name: "Metformin",  dose: "500mg", times: ["8:00 AM"] },
    { name: "Amlodipine", dose: "5mg",   times: ["8:00 AM"] },
  ],
  past: [],
};

function MedList({ meds, extractKind, routine, onAdd, onRemove }: { meds: DraftMed[]; extractKind: "current" | "past"; routine: RoutineTimes; onAdd: (m: DraftMed) => void; onRemove: (i: number) => void }) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const defaultTime = defaultDoseTime(routine);
  const [times, setTimes] = useState<string[]>([defaultTime]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const scanTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(scanTimer.current), []);

  const submit = () => {
    if (!name.trim() || !times.length) return;
    onAdd({ name: name.trim(), dose: dose.trim() || t(language, "wizard.asDirected"), times });
    setName(""); setDose(""); setTimes([defaultTime]); setOpen(false); setProposal(null);
  };

  const cancel = () => {
    setOpen(false);
    setProposal(null);
  };

  // Mock scan: no backend or file needed. Tapping Scan plays a short loading
  // animation, then the "read" medications appear in the list (reviewable +
  // removable) — the demo stand-in for Hermes's real /profile/extract read.
  const runMockScan = () => {
    window.clearTimeout(scanTimer.current);
    setOpen(false);
    setProposal(null);
    setScanning(true);
    scanTimer.current = window.setTimeout(() => {
      const found = DEMO_SCAN_MEDS[extractKind];
      for (const m of found) onAdd(m);
      // Nothing read (history step) → drop into the manual form with a note;
      // on a successful read the meds simply appear in the list above.
      if (!found.length) {
        setProposal(t(language, "wizard.uploadNoMed"));
        setOpen(true);
      }
      setScanning(false);
    }, 1800);
  };

  const q = name.trim().toLowerCase();
  const matches = q ? MEDICATION_CATALOG.filter(m => m.name.toLowerCase().includes(q)).slice(0, 6) : [];

  return (
    <div>
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
          <TimesPicker times={times} onChange={setTimes} label={t(language, "wizard.usualTimes")} routine={routine} />
          <div className="flex gap-2 pt-1">
            <button onClick={cancel} className="flex-1 h-10 rounded-xl border border-border text-muted-foreground text-sm font-semibold">{t(language, "wizard.cancel")}</button>
            <button onClick={submit} disabled={!name.trim() || !times.length} className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-bold disabled:opacity-40">{t(language, "wizard.add")}</button>
          </div>
        </div>
      ) : scanning ? (
        <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-5 flex flex-col items-center text-center gap-2">
          <div className="relative w-12 h-12 rounded-xl bg-primary/10 overflow-hidden flex items-center justify-center">
            <Camera size={22} className="text-primary" />
            <div className="absolute inset-x-0 h-0.5 bg-primary/80 shadow-[0_0_8px_2px] shadow-primary/50 animate-scanline" />
          </div>
          <p className="text-sm font-semibold text-primary">{t(language, "wizard.reading")}</p>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setOpen(true)} className="flex-1 h-12 rounded-2xl border-2 border-dashed border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
            <Plus size={15} />{t(language, "wizard.addMedication")}
          </button>
          <button onClick={runMockScan} disabled={scanning} className="flex-1 h-12 rounded-2xl border-2 border-dashed border-primary/40 text-primary text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60">
            <Camera size={15} />{t(language, "wizard.scanOrUpload")}
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
  const [allergies, setAllergies] = useState<string[]>(prefill?.details.allergies ?? []);
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
  // Once an account exists (returning user, or just created), the account step
  // renders as a safe name-only view — so it can be revisited without trying to
  // sign up again. That lets every step after "account" carry a back button; the
  // account step itself only backs out (to the setup-method screen) before the
  // account is created.
  const accountEstablished = hasSessionAtStart || !!elderId;
  const showBackButton = step !== "done" && (stepIndex > 0 || !elderId);

  const goNext = () => setStepIndex(i => Math.min(i + 1, steps.length - 1));
  const goBack = () => setStepIndex(i => Math.max(i - 1, 0));

  const createAccount = async () => {
    if (!email.trim() || !password.trim()) return;
    setAccountLoading(true);
    setAccountError(null);
    setAccountInfo(null);
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
    setAccountLoading(false);
    if (error) { setAccountError(error.message); return; }
    // Fresh account → replay the scripted refill demo from the crumpled Metformin.
    resetRefillDemo();
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
    setFinishing(false);
    onComplete();
  };

  return (
    <WizardChrome step={stepIndex} total={total} onBack={stepIndex > 0 ? goBack : onExit} showBack={showBackButton}>
      {step === "account" && (
        <>
          <StepHeader
            title={accountEstablished ? t(language, "wizard.accountTitleReturning") : t(language, "wizard.accountTitleNew")}
            subtitle={accountEstablished ? t(language, "wizard.accountSubtitleReturning") : t(language, "wizard.accountSubtitleNew")}
          />
          <div className="space-y-3 flex-1">
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.preferredName")}</label>
              <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder={t(language, "wizard.preferredNamePlaceholder")} className={cls(fullName.trim().length > 0)} />
            </div>
            {!accountEstablished && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.email")}</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t(language, "wizard.emailPlaceholder")} className={cls(isEmail(email))} autoComplete="email" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "wizard.password")}</label>
                  <div className="relative">
                    <input type={showPassword ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && createAccount()} placeholder={t(language, "wizard.passwordPlaceholder")} className={`${cls(password.length >= 6)} pr-11`} autoComplete="new-password" />
                    <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label={t(language, showPassword ? "wizard.hidePassword" : "wizard.showPassword")}>
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </>
            )}
            {accountError && <p className="text-xs text-destructive font-medium">{accountError}</p>}
            {accountInfo && <p className="text-xs text-primary font-medium">{accountInfo}</p>}
          </div>
          {accountEstablished ? (
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
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.dob")}</label>
                <input type="date" value={dob} onChange={e => setDob(e.target.value)} max={to24hDate(new Date())} className={cls(dob.trim().length > 0)} />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.gender")}</label>
                <GenderPicker value={gender} onChange={setGender} />
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.weightKg")}</label>
                <input type="number" value={weightKg} onChange={e => setWeightKg(e.target.value)} placeholder={t(language, "wizard.weightPlaceholder")} className={cls(isPositiveNumber(weightKg))} />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.heightCm")}</label>
                <input type="number" value={heightCm} onChange={e => setHeightCm(e.target.value)} placeholder={t(language, "wizard.heightPlaceholder")} className={cls(isPositiveNumber(heightCm))} />
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
            <TagList label={t(language, "common.medicalConditions")} placeholder={t(language, "wizard.conditionsPlaceholder")} items={conditions} suggestions={COMMON_CONDITIONS} extractField="conditions" onAdd={v => setConditions(p => [...p, v])} onRemove={i => setConditions(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{conditions.length ? t(language, "wizard.continue") : t(language, "wizard.skipForNow")}</ContinueButton>
        </>
      )}

      {step === "allergies" && (
        <>
          <StepHeader title={t(language, "wizard.allergiesTitle")} subtitle={t(language, "wizard.allergiesSubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <TagList label={t(language, "settings.generalAllergies")} placeholder={t(language, "wizard.allergiesPlaceholder")} items={allergies} suggestions={COMMON_ALLERGIES} extractField="allergies" onAdd={v => setAllergies(p => [...p, v])} onRemove={i => setAllergies(p => p.filter((_, j) => j !== i))} />
            <TagList label={t(language, "settings.medicationAllergies")} placeholder={t(language, "wizard.drugAllergiesPlaceholder")} items={drugAllergies} suggestions={COMMON_DRUG_ALLERGIES} extractField="drug_allergies" onAdd={v => setDrugAllergies(p => [...p, v])} onRemove={i => setDrugAllergies(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{t(language, "wizard.continue")}</ContinueButton>
        </>
      )}

      {step === "current-meds" && (
        <>
          <StepHeader title={t(language, "wizard.currentMedsTitle")} subtitle={t(language, "wizard.currentMedsSubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <MedList meds={currentMeds} extractKind="current" routine={routine} onAdd={m => setCurrentMeds(p => [...p, m])} onRemove={i => setCurrentMeds(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{currentMeds.length ? t(language, "wizard.continue") : t(language, "wizard.skipForNow")}</ContinueButton>
        </>
      )}

      {step === "med-history" && (
        <>
          <StepHeader title={t(language, "wizard.medHistoryTitle")} subtitle={t(language, "wizard.medHistorySubtitle")} />
          {prefilled && <ReviewBadge />}
          <div className="flex-1">
            <MedList meds={pastMeds} extractKind="past" routine={routine} onAdd={m => setPastMeds(p => [...p, m])} onRemove={i => setPastMeds(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{pastMeds.length ? t(language, "wizard.continue") : t(language, "wizard.skipForNow")}</ContinueButton>
        </>
      )}

      {step === "routine" && (
        <>
          <StepHeader title={t(language, "wizard.routineTitle")} subtitle={t(language, "wizard.routineSubtitle")} />
          <div className="space-y-3 flex-1">
            <TimeField label={t(language, "wizard.wakeUpTime")} icon={<Sunrise size={15} className="text-primary" />} value={wakeTime} onChange={setWakeTime} />
            <TimeField label={t(language, "wizard.breakfast")} icon={<Coffee size={15} className="text-primary" />} value={breakfast} onChange={setBreakfast} />
            <TimeField label={t(language, "wizard.lunch")} icon={<Utensils size={15} className="text-primary" />} value={lunch} onChange={setLunch} />
            <TimeField label={t(language, "wizard.dinner")} icon={<UtensilsCrossed size={15} className="text-primary" />} value={dinner} onChange={setDinner} />
            <TimeField label={t(language, "wizard.bedtime")} icon={<Moon size={15} className="text-primary" />} value={sleepTime} onChange={setSleepTime} />

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

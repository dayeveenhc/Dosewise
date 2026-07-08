import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Loader2, Plus, X, Check, Coffee, Utensils, Moon, PartyPopper, Users, Camera, Sparkles } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { saveProfile } from "../../lib/profile";
import { addMedication, archiveMedication, to24h } from "../../lib/medications";
import { MEDICATION_CATALOG, PRESET_TIMES, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES } from "../../data/medications";
import type { Role } from "../../lib/profile";

const fieldBase = "w-full bg-input-background rounded-xl px-4 py-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none transition-colors border";
export const fieldCls = `${fieldBase} border-border focus:border-primary`;
const fieldClsValid = `${fieldBase} border-emerald-500 focus:border-emerald-500`;
// Swaps the border to green once a field's value satisfies its own validity check
// (e.g. password long enough, a real-looking email) — leaves it neutral otherwise.
export const cls = (valid: boolean) => valid ? fieldClsValid : fieldCls;
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const isPositiveNumber = (v: string) => v.trim() !== "" && Number(v) > 0;

function WizardChrome({ step, total, onBack, showBack = true, children }: { step: number; total: number; onBack: () => void; showBack?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-4 pt-4 pb-1 flex items-center gap-3 shrink-0">
        {showBack ? (
          <button onClick={onBack} className="w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center active:bg-muted transition-colors shrink-0" aria-label="Back">
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

export function TagList({ label, placeholder, items, suggestions, scanDemo, onAdd, onRemove }: {
  label: string; placeholder: string; items: string[]; suggestions?: string[]; scanDemo?: string; onAdd: (v: string) => void; onRemove: (i: number) => void;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const submit = (pick?: string) => {
    const val = (pick ?? value).trim();
    if (val) { onAdd(val); setValue(""); setOpen(false); }
  };
  // Simulated label/photo scan — no real OCR yet, just fills in a plausible
  // suggestion so the flow can be tried end to end.
  const runScan = () => {
    if (!scanDemo) return;
    setScanning(true);
    setTimeout(() => { setScanning(false); onAdd(scanDemo); }, 1100);
  };
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
          {scanDemo && (
            <button onClick={runScan} disabled={scanning} title="Scan a label or photo" className="w-11 h-11 bg-muted rounded-xl flex items-center justify-center disabled:opacity-60 shrink-0">
              {scanning ? <Sparkles size={16} className="text-primary animate-pulse" /> : <Camera size={18} className="text-foreground" />}
            </button>
          )}
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

interface DraftMed { name: string; dose: string; time: string }

function MedList({ meds, onAdd, onRemove }: { meds: DraftMed[]; onAdd: (m: DraftMed) => void; onRemove: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const [time, setTime] = useState(PRESET_TIMES[0]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [scanning, setScanning] = useState(false);

  const submit = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), dose: dose.trim() || "as directed", time });
    setName(""); setDose(""); setOpen(false);
  };

  // Simulated label scan — no real OCR yet, just pre-fills the form with a
  // plausible result (matching AddPrescriptionSheet's demo scan) for review.
  const runScan = () => {
    setScanning(true);
    setTimeout(() => {
      const demo = MEDICATION_CATALOG[0];
      setName(demo.name); setDose(demo.dose); setTime(PRESET_TIMES[0]);
      setScanning(false);
      setOpen(true);
    }, 1200);
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
                <p className="text-xs text-muted-foreground">{m.time}</p>
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
          <div className="relative">
            <label className="block text-xs font-semibold text-foreground mb-1.5">Medication name</label>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="e.g. Metformin"
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
            <label className="block text-xs font-semibold text-foreground mb-1.5">Dose (optional)</label>
            <input value={dose} onChange={e => setDose(e.target.value)} placeholder="e.g. 500mg" className={fieldCls} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">Usual time</label>
            <div className="flex flex-wrap gap-2">
              {PRESET_TIMES.map(t => (
                <button key={t} onClick={() => setTime(t)} className={`text-xs font-medium rounded-xl px-3 py-1.5 border transition-colors ${time === t ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => setOpen(false)} className="flex-1 h-10 rounded-xl border border-border text-muted-foreground text-sm font-semibold">Cancel</button>
            <button onClick={submit} disabled={!name.trim()} className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-bold disabled:opacity-40">Add</button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => setOpen(true)} className="flex-1 h-12 rounded-2xl border-2 border-dashed border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
            <Plus size={15} />Add a medication
          </button>
          <button onClick={runScan} disabled={scanning} className="flex-1 h-12 rounded-2xl border-2 border-dashed border-primary/40 text-primary text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60">
            {scanning ? <Sparkles size={15} className="animate-pulse" /> : <Camera size={15} />}
            {scanning ? "Reading…" : "Scan a label"}
          </button>
        </div>
      )}
    </div>
  );
}

export function GuidedSetupWizard({ mode, hasSession, elderId: initialElderId, onComplete, onExit }: {
  mode: "elderly" | "caregiver";
  hasSession: boolean;
  elderId?: string;
  onComplete: () => void;
  onExit: () => void;
}) {
  // Frozen at mount: once the account step creates a session mid-wizard, the
  // parent's live `hasSession` prop flips true, which would otherwise filter
  // "account" out of `steps` mid-flow and shift every later index by one.
  const [hasSessionAtStart] = useState(hasSession);
  const [stepIndex, setStepIndex] = useState(0);
  const [elderId, setElderId] = useState<string | undefined>(initialElderId);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountInfo, setAccountInfo] = useState<string | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [fullName, setFullName] = useState("");
  const [age, setAge] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [gender, setGender] = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [allergies, setAllergies] = useState<string[]>([]);
  const [drugAllergies, setDrugAllergies] = useState<string[]>([]);
  const [currentMeds, setCurrentMeds] = useState<DraftMed[]>([]);
  const [pastMeds, setPastMeds] = useState<DraftMed[]>([]);
  const [breakfast, setBreakfast] = useState("08:00");
  const [lunch, setLunch] = useState("12:30");
  const [dinner, setDinner] = useState("19:00");
  const [sleepTime, setSleepTime] = useState("22:30");
  const [finishing, setFinishing] = useState(false);

  const role: Role = mode === "elderly" ? "elder" : "caregiver";
  const allSteps = mode === "elderly"
    ? ["account", "profile", "conditions", "allergies", "current-meds", "med-history", "routine", "done"]
    : ["account", "placeholder"];
  const steps = allSteps.filter(s => !(s === "account" && hasSessionAtStart));
  const step = steps[stepIndex];
  const total = steps.length;
  const showBackButton = !elderId && step !== "done";

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
    if (!data.session || !data.user) {
      setAccountInfo("Check your email to confirm your account, then come back and sign in.");
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
        age: age ? Number(age) : undefined,
        weightKg: weightKg ? Number(weightKg) : undefined,
        heightCm: heightCm ? Number(heightCm) : undefined,
        gender: gender || undefined,
        conditions,
        allergies, drugAllergies,
        mealTimes: { breakfast, lunch, dinner },
        sleepTime,
      });
      for (const m of currentMeds) {
        await addMedication(elderId, { name: m.name, dosage: m.dose, purpose: "", timeHHMM: to24h(m.time) });
      }
      for (const m of pastMeds) {
        const id = await addMedication(elderId, { name: m.name, dosage: m.dose, purpose: "", timeHHMM: to24h(m.time) });
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
          <StepHeader title="Let's create your account" subtitle="This keeps your information safe and lets you sign back in later." />
          <div className="space-y-3 flex-1">
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Preferred name</label>
              <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="What should we call you?" className={cls(fullName.trim().length > 0)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className={cls(isEmail(email))} autoComplete="email" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && createAccount()} placeholder="At least 6 characters" className={cls(password.length >= 6)} autoComplete="new-password" />
            </div>
            {accountError && <p className="text-xs text-destructive font-medium">{accountError}</p>}
            {accountInfo && <p className="text-xs text-primary font-medium">{accountInfo}</p>}
          </div>
          <ContinueButton onClick={createAccount} disabled={!email.trim() || !password.trim()} loading={accountLoading}>Create account</ContinueButton>
        </>
      )}

      {step === "profile" && (
        <>
          <StepHeader title="Tell us about yourself" subtitle="Just the basics — you can update this anytime." />
          <div className="space-y-3 flex-1">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">Age</label>
                <input type="number" value={age} onChange={e => setAge(e.target.value)} placeholder="e.g. 78" className={cls(isPositiveNumber(age))} />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">Gender</label>
                <div className="flex gap-2">
                  {(["Female", "Male"] as const).map(g => (
                    <button
                      key={g}
                      onClick={() => setGender(g)}
                      className={`flex-1 py-3.5 rounded-xl border text-base font-semibold transition-colors ${gender === g ? "bg-primary text-primary-foreground border-primary" : "bg-input-background text-foreground border-border"}`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">Weight (kg)</label>
                <input type="number" value={weightKg} onChange={e => setWeightKg(e.target.value)} placeholder="e.g. 60" className={cls(isPositiveNumber(weightKg))} />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1.5">Height (cm)</label>
                <input type="number" value={heightCm} onChange={e => setHeightCm(e.target.value)} placeholder="e.g. 160" className={cls(isPositiveNumber(heightCm))} />
              </div>
            </div>
          </div>
          <ContinueButton onClick={goNext}>Continue</ContinueButton>
        </>
      )}

      {step === "conditions" && (
        <>
          <StepHeader title="Any medical conditions?" subtitle="This helps us understand your health picture. Leave blank if none." />
          <div className="flex-1">
            <TagList label="Medical conditions" placeholder="e.g. Diabetes, Blood Pressure" items={conditions} suggestions={COMMON_CONDITIONS} scanDemo={COMMON_CONDITIONS.find(c => !conditions.includes(c))} onAdd={v => setConditions(p => [...p, v])} onRemove={i => setConditions(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{conditions.length ? "Continue" : "Skip for now"}</ContinueButton>
        </>
      )}

      {step === "allergies" && (
        <>
          <StepHeader title="Do you have any allergies?" subtitle="This helps us warn you about medications that could be risky. Leave blank if none." />
          <div className="flex-1">
            <TagList label="General allergies" placeholder="e.g. Peanuts, Shellfish" items={allergies} suggestions={COMMON_ALLERGIES} scanDemo={COMMON_ALLERGIES.find(a => !allergies.includes(a))} onAdd={v => setAllergies(p => [...p, v])} onRemove={i => setAllergies(p => p.filter((_, j) => j !== i))} />
            <TagList label="Medication allergies" placeholder="e.g. Penicillin" items={drugAllergies} suggestions={COMMON_DRUG_ALLERGIES} scanDemo={COMMON_DRUG_ALLERGIES.find(a => !drugAllergies.includes(a))} onAdd={v => setDrugAllergies(p => [...p, v])} onRemove={i => setDrugAllergies(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>Continue</ContinueButton>
        </>
      )}

      {step === "current-meds" && (
        <>
          <StepHeader title="What medications are you taking now?" subtitle="Add each one you take regularly. You can skip this and add them later." />
          <div className="flex-1">
            <MedList meds={currentMeds} onAdd={m => setCurrentMeds(p => [...p, m])} onRemove={i => setCurrentMeds(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{currentMeds.length ? "Continue" : "Skip for now"}</ContinueButton>
        </>
      )}

      {step === "med-history" && (
        <>
          <StepHeader title="Any medications you've taken before?" subtitle="Past medications help us spot possible conflicts with new ones. Optional." />
          <div className="flex-1">
            <MedList meds={pastMeds} onAdd={m => setPastMeds(p => [...p, m])} onRemove={i => setPastMeds(p => p.filter((_, j) => j !== i))} />
          </div>
          <ContinueButton onClick={goNext}>{pastMeds.length ? "Continue" : "Skip for now"}</ContinueButton>
        </>
      )}

      {step === "routine" && (
        <>
          <StepHeader title="When do you usually eat and sleep?" subtitle="Some medications are timed around meals — this helps us remind you at the right moment." />
          <div className="space-y-4 flex-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Coffee size={16} className="text-primary" /></div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1">Breakfast</label>
                <input type="time" value={breakfast} onChange={e => setBreakfast(e.target.value)} className={fieldCls} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Utensils size={16} className="text-primary" /></div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1">Lunch</label>
                <input type="time" value={lunch} onChange={e => setLunch(e.target.value)} className={fieldCls} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Utensils size={16} className="text-primary" /></div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1">Dinner</label>
                <input type="time" value={dinner} onChange={e => setDinner(e.target.value)} className={fieldCls} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Moon size={16} className="text-primary" /></div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-foreground mb-1">Bedtime</label>
                <input type="time" value={sleepTime} onChange={e => setSleepTime(e.target.value)} className={fieldCls} />
              </div>
            </div>
          </div>
          <ContinueButton onClick={goNext}>Continue</ContinueButton>
        </>
      )}

      {step === "done" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <PartyPopper size={30} className="text-primary" />
            </div>
            <h1 className="font-['Fraunces'] text-xl font-semibold text-foreground mb-2">All set{fullName ? `, ${fullName}` : ""}!</h1>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[260px]">Your profile is ready. You can always change any of this later in Settings.</p>
          </div>
          <ContinueButton onClick={finish} loading={finishing}><Check size={16} />Go to Dosewise</ContinueButton>
        </>
      )}

      {step === "placeholder" && (
        <>
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Users size={28} className="text-primary" />
            </div>
            <h1 className="font-['Fraunces'] text-xl font-semibold text-foreground mb-2">You're set up!</h1>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[260px]">Next, link the person you're caring for — that's coming soon. For now, take a look around.</p>
          </div>
          <ContinueButton onClick={finish} loading={finishing}><Check size={16} />Go to Dosewise</ContinueButton>
        </>
      )}
    </WizardChrome>
  );
}

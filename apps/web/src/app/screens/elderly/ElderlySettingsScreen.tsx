import { useState, useEffect } from "react";
import { Shield, ChevronDown, Eye, Phone, RefreshCw, LogOut, Check, Loader2, Coffee, Utensils, Moon } from "lucide-react";
import { useAccessibility } from "../../accessibility.tsx";
import type { FontSize } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_SHAPES, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES } from "../../data/medications";
import { fetchProfile, saveProfile, calculateAge } from "../../lib/profile";
import { TagList, fieldCls, GenderPicker } from "../setup/GuidedSetupWizard";
import { MedAvatar } from "../../components/shared";
import { CallMockup } from "../../components/CallMockup";
import { useLanguage } from "../../lib/languageContext";
import { LANGUAGE_OPTIONS, t } from "../../lib/language";

export function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${on ? "bg-primary" : "bg-muted"}`}>
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? "translate-x-6" : "translate-x-0.5"}`} />
    </button>
  );
}

const FONT_SIZES: FontSize[] = ["small", "normal", "large", "xlarge", "xxlarge"];

export function ElderlySettingsScreen({ patient, elderId, onUpdatePatient, onBack, onSignOut }: {
  patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onBack: () => void; onSignOut: () => void;
}) {
  const { fontSize, setFontSize, highContrast, setHighContrast, colourBlind, setColourBlind } = useAccessibility();
  const { language, setLanguage } = useLanguage();
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [showShapes, setShowShapes] = useState(false);
  const [showCallPrimary, setShowCallPrimary] = useState(false);
  const primary = patient.contacts.find(c => c.isPrimary);

  // Draft copies of everything the guided setup wizard collects, so this
  // section can double as "edit what you answered during setup."
  const [dobDraft, setDobDraft] = useState("");
  const [genderDraft, setGenderDraft] = useState("");
  const [weightDraft, setWeightDraft] = useState("");
  const [heightDraft, setHeightDraft] = useState("");
  const [conditionsDraft, setConditionsDraft] = useState<string[]>([]);
  const [allergiesDraft, setAllergiesDraft] = useState<string[]>([]);
  const [drugAllergiesDraft, setDrugAllergiesDraft] = useState<string[]>([]);
  const [breakfastDraft, setBreakfastDraft] = useState("08:00");
  const [lunchDraft, setLunchDraft] = useState("12:30");
  const [dinnerDraft, setDinnerDraft] = useState("19:00");
  const [sleepDraft, setSleepDraft] = useState("22:30");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (!elderId) return;
    fetchProfile(elderId).then(profile => {
      if (!profile) return;
      const d = profile.details;
      setDobDraft(d.dob ?? "");
      setGenderDraft(d.gender ?? "");
      setWeightDraft(d.weightKg ? String(d.weightKg) : "");
      setHeightDraft(d.heightCm ? String(d.heightCm) : "");
      setConditionsDraft(d.conditions ?? []);
      setAllergiesDraft(d.allergies ?? []);
      setDrugAllergiesDraft(d.drugAllergies ?? []);
      setBreakfastDraft(d.mealTimes?.breakfast ?? "08:00");
      setLunchDraft(d.mealTimes?.lunch ?? "12:30");
      setDinnerDraft(d.mealTimes?.dinner ?? "19:00");
      setSleepDraft(d.sleepTime ?? "22:30");
    });
  }, [elderId]);

  const saveProfileDraft = async () => {
    if (!elderId) return;
    setProfileSaving(true);
    const mealTimes = { breakfast: breakfastDraft, lunch: lunchDraft, dinner: dinnerDraft };
    await saveProfile(elderId, "elder", patient.name, {
      dob: dobDraft || undefined,
      weightKg: weightDraft ? Number(weightDraft) : undefined,
      heightCm: heightDraft ? Number(heightDraft) : undefined,
      gender: genderDraft || undefined,
      conditions: conditionsDraft,
      allergies: allergiesDraft,
      drugAllergies: drugAllergiesDraft,
      mealTimes,
      sleepTime: sleepDraft,
    });
    onUpdatePatient({
      ...patient,
      age: dobDraft ? calculateAge(dobDraft) : patient.age,
      gender: genderDraft || undefined,
      weightKg: weightDraft ? Number(weightDraft) : undefined,
      heightCm: heightDraft ? Number(heightDraft) : undefined,
      conditions: conditionsDraft,
      allergies: [...allergiesDraft, ...drugAllergiesDraft],
      mealTimes,
      sleepTime: sleepDraft,
    });
    setProfileSaving(false);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-2 pb-28 space-y-4">
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="flex items-center gap-3 mb-3">
            <img src={patient.photo} alt={patient.nickname} className="w-14 h-14 rounded-full object-cover bg-muted border-2 border-primary/20" />
            <div>
              <p className="font-bold text-foreground text-lg">{patient.nickname}</p>
              <p className="text-sm text-muted-foreground">{patient.name} · {patient.age} yrs</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {patient.conditions.map(c => <span key={c} className="text-xs bg-secondary text-secondary-foreground rounded-full px-2.5 py-1">{c}</span>)}
          </div>
        </div>

        {/* Your Profile — everything the guided setup wizard asked, editable here */}
        <div className="bg-card rounded-2xl border border-border overflow-hidden" data-tour="elder-profile-section">
          <button
            onClick={() => setProfileOpen(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3.5 font-semibold text-foreground"
          >
            {t(language, "settings.yourProfile")}
            <ChevronDown size={16} className={`text-muted-foreground transition-transform ${profileOpen ? "rotate-180" : ""}`} />
          </button>
          {profileOpen && (
          <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.dob")}</label>
              <input type="date" value={dobDraft} onChange={e => setDobDraft(e.target.value)} max={new Date().toISOString().slice(0, 10)} className={fieldCls} />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.gender")}</label>
              <GenderPicker value={genderDraft} onChange={setGenderDraft} size="sm" />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.weightKg")}</label>
              <input type="number" value={weightDraft} onChange={e => setWeightDraft(e.target.value)} placeholder="e.g. 60" className={fieldCls} />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "settings.heightCm")}</label>
              <input type="number" value={heightDraft} onChange={e => setHeightDraft(e.target.value)} placeholder="e.g. 160" className={fieldCls} />
            </div>
          </div>

          <TagList label={t(language, "settings.medicalConditions")} placeholder="e.g. Diabetes, Blood Pressure" items={conditionsDraft} suggestions={COMMON_CONDITIONS} onAdd={v => setConditionsDraft(p => [...p, v])} onRemove={i => setConditionsDraft(p => p.filter((_, j) => j !== i))} />
          <TagList label={t(language, "settings.generalAllergies")} placeholder="e.g. Peanuts, Shellfish" items={allergiesDraft} suggestions={COMMON_ALLERGIES} onAdd={v => setAllergiesDraft(p => [...p, v])} onRemove={i => setAllergiesDraft(p => p.filter((_, j) => j !== i))} />
          <TagList label={t(language, "settings.medicationAllergies")} placeholder="e.g. Penicillin" items={drugAllergiesDraft} suggestions={COMMON_DRUG_ALLERGIES} onAdd={v => setDrugAllergiesDraft(p => [...p, v])} onRemove={i => setDrugAllergiesDraft(p => p.filter((_, j) => j !== i))} />

          <div>
            <p className="text-sm font-semibold text-foreground mb-2">{t(language, "settings.mealsSleep")}</p>
            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Coffee size={16} className="text-primary" /></div>
                <input type="time" value={breakfastDraft} onChange={e => setBreakfastDraft(e.target.value)} className={`${fieldCls} flex-1`} />
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Utensils size={16} className="text-primary" /></div>
                <input type="time" value={lunchDraft} onChange={e => setLunchDraft(e.target.value)} className={`${fieldCls} flex-1`} />
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Utensils size={16} className="text-primary" /></div>
                <input type="time" value={dinnerDraft} onChange={e => setDinnerDraft(e.target.value)} className={`${fieldCls} flex-1`} />
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0"><Moon size={16} className="text-primary" /></div>
                <input type="time" value={sleepDraft} onChange={e => setSleepDraft(e.target.value)} className={`${fieldCls} flex-1`} />
              </div>
            </div>
          </div>

          <button
            onClick={saveProfileDraft}
            disabled={profileSaving || !elderId}
            className="w-full h-12 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            {profileSaving ? <Loader2 size={15} className="animate-spin" /> : profileSaved ? <Check size={15} /> : null}
            {profileSaving ? t(language, "settings.saving") : profileSaved ? t(language, "settings.saved") : t(language, "settings.saveChanges")}
          </button>
          </div>
          )}
        </div>

        {/* Accessibility */}
        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          <div className="px-4 py-3 flex items-center gap-2">
            <Shield size={15} className="text-primary" />
            <p className="font-semibold text-foreground">{t(language, "settings.accessibility")}</p>
          </div>

          {/* Font size */}
          <div className="px-4 py-4" data-tour="elder-fontsize">
            <p className="text-[15px] font-medium text-foreground mb-0.5">{t(language, "settings.textSize")}</p>
            <p className="text-xs text-muted-foreground mb-3">{t(language, "settings.textSizeDesc")}</p>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-muted-foreground shrink-0">A</span>
              <input
                type="range"
                min={0}
                max={FONT_SIZES.length - 1}
                step={1}
                value={FONT_SIZES.indexOf(fontSize)}
                onChange={e => setFontSize(FONT_SIZES[Number(e.target.value)])}
                className="flex-1 accent-primary h-2"
              />
              <span className="text-xl font-semibold text-muted-foreground shrink-0">A</span>
            </div>
          </div>

          {/* High contrast */}
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-[15px] font-medium text-foreground">{t(language, "settings.highContrast")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.highContrastDesc")}</p>
            </div>
            <Toggle on={highContrast} onToggle={() => setHighContrast(!highContrast)} />
          </div>

          {/* Colour blind mode */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex-1">
                <p className="text-[15px] font-medium text-foreground">{t(language, "settings.colourBlindMode")}</p>
                <p className="text-xs text-muted-foreground">{t(language, "settings.colourBlindDesc")}</p>
              </div>
              <Toggle on={colourBlind} onToggle={() => setColourBlind(!colourBlind)} />
            </div>

            {colourBlind && (
              <div className="bg-muted/40 rounded-xl p-3 space-y-1.5">
                <button
                  onClick={() => setShowShapes(v => !v)}
                  className="w-full flex items-center justify-between text-sm font-semibold text-foreground"
                >
                  <span className="flex items-center gap-1.5"><Eye size={13} className="text-primary" />{t(language, "settings.medicationDescriptions")}</span>
                  <ChevronDown size={13} className={`text-muted-foreground transition-transform ${showShapes ? "rotate-180" : ""}`} />
                </button>
                {showShapes && (
                  <div className="mt-2 space-y-2 pt-2 border-t border-border/40">
                    {patient.medications.map(m => {
                      const shape = MED_SHAPES[m.name];
                      if (!shape) return null;
                      return (
                        <div key={m.id} className="flex items-start gap-3 py-1">
                          <MedAvatar name={m.name} size={36} className="rounded-lg shrink-0 grayscale" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-foreground">{m.name}</p>
                            <p className="text-xs text-muted-foreground">{shape.shape}</p>
                            <p className="text-xs text-muted-foreground">{shape.marking}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border divide-y divide-border" data-tour="elder-language">
          <div className="px-4 py-3"><p className="font-semibold text-foreground">{t(language, "settings.voiceAndLanguage")}</p></div>
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-[15px] font-medium text-foreground">{t(language, "settings.readAloud")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.readAloudDesc")}</p>
            </div>
            <Toggle on={voiceEnabled} onToggle={() => setVoiceEnabled(v => !v)} />
          </div>
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-[15px] font-medium text-foreground">{t(language, "settings.language")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.languageDesc")}</p>
            </div>
            <select value={language} onChange={e => setLanguage(e.target.value as any)} className="bg-muted rounded-xl px-3 py-2 text-sm font-medium text-foreground outline-none">
              {LANGUAGE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          <div className="px-4 py-3"><p className="font-semibold text-foreground">{t(language, "settings.reminders")}</p></div>
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-[15px] font-medium text-foreground">{t(language, "settings.medicationReminders")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.medicationRemindersDesc")}</p>
            </div>
            <Toggle on={notifications} onToggle={() => setNotifications(v => !v)} />
          </div>
        </div>

        {primary && (
          <div className="bg-card rounded-2xl border border-border divide-y divide-border">
            <div className="px-4 py-3"><p className="font-semibold text-foreground">{t(language, "settings.emergencyContact")}</p></div>
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-[15px] font-medium text-foreground">{primary.name}</p>
                <p className="text-sm text-muted-foreground">{primary.role}</p>
                <p className="text-sm text-muted-foreground">{primary.phone}</p>
              </div>
              <button onClick={() => setShowCallPrimary(true)} className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-xl flex items-center justify-center active:scale-95 transition-transform">
                <Phone size={18} />
              </button>
            </div>
          </div>
        )}

        <button onClick={onBack} className="w-full h-12 rounded-2xl border border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
          <RefreshCw size={14} />{t(language, "settings.switchToCaregiver")}
        </button>

        <button onClick={onSignOut} className="w-full h-12 rounded-2xl border border-destructive/30 text-destructive text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
          <LogOut size={14} />{t(language, "settings.signOut")}
        </button>
      </div>

      {showCallPrimary && primary && (
        <CallMockup name={primary.name} role={primary.role} onEnd={() => setShowCallPrimary(false)} />
      )}
    </div>
  );
}

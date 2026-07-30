import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Shield, ChevronDown, Eye, Phone, RefreshCw, LogOut, Check, Loader2, Sunrise, Coffee, Utensils, UtensilsCrossed, Moon, QrCode } from "lucide-react";
import { buildCareLinkPayload } from "../../lib/careLinks";
import { useAccessibility } from "../../accessibility.tsx";
import type { FontSize } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_SHAPES, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES } from "../../data/medications";
import { fetchProfile, saveProfile, calculateAge } from "../../lib/profile";
import type { SymptomReport } from "../../lib/profile";
import { normalizeAllergies, slugify } from "../../lib/changeHighlight";
import { TagList, fieldCls, GenderPicker, withCatalogLabels } from "../setup/GuidedSetupWizard";
import { MedAvatar } from "../../components/shared";
import { MeiSuggestButton } from "../../components/MeiSuggestButton";
import { TimeField } from "../../components/TimesPicker";
import { CallMockup } from "../../components/CallMockup";
import { useLanguage } from "../../lib/languageContext";
import { LANGUAGE_OPTIONS, t } from "../../lib/language";

export function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-pressed={on} className={`w-12 h-6 rounded-full transition-colors relative shrink-0 ${on ? "bg-primary" : "bg-muted"}`}>
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? "translate-x-6" : "translate-x-0.5"}`} />
    </button>
  );
}

const FONT_SIZES: FontSize[] = ["small", "normal", "large", "xlarge", "xxlarge"];

export function ElderlySettingsScreen({ patient, elderId, onUpdatePatient, onBack, onSignOut }: {
  patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onBack: () => void; onSignOut: () => void;
}) {
  const { fontSize, setFontSize, highContrast, setHighContrast, colourBlind, setColourBlind, voiceOutput, setVoiceOutput } = useAccessibility();
  const { language, setLanguage } = useLanguage();
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
  // Normalized saved allergies (legacy strings OR promoted {name, severity}
  // objects — lib/changeHighlight.ts's normalizeAllergies) — drives the
  // always-visible chips in the summary card, so a set_allergy_severity
  // highlight (data-testid="allergy-{slug}") resolves even while the editable
  // profile section is collapsed; severities survive a profile save.
  const [allergyEntries, setAllergyEntries] = useState<{ name: string; severity: string | null }[]>([]);
  // Read-only symptom journal written by Mei's add_symptom tool.
  const [symptomReports, setSymptomReports] = useState<SymptomReport[]>([]);
  const [drugAllergiesDraft, setDrugAllergiesDraft] = useState<string[]>([]);
  const [wakeDraft, setWakeDraft] = useState("07:00");
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
      const allergies = normalizeAllergies(d.allergies).filter(a => a.name);
      setAllergyEntries(allergies);
      setAllergiesDraft(allergies.map(a => a.name));
      setSymptomReports(
        [...(d.symptom_reports ?? [])].sort((a, b) => (b.noted_at ?? "").localeCompare(a.noted_at ?? ""))
      );
      setDrugAllergiesDraft(d.drugAllergies ?? []);
      setWakeDraft(d.wakeTime ?? "07:00");
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
    // Re-attach a graded severity (set via Mei's set_allergy_severity) to any
    // surviving name, so editing the list here never silently drops a grade.
    const severityByName = Object.fromEntries(
      allergyEntries.filter(a => a.severity).map(a => [a.name.trim().toLowerCase(), a.severity!])
    );
    const savedAllergies = allergiesDraft.map(n => {
      const severity = severityByName[n.trim().toLowerCase()];
      return severity ? { name: n, severity } : n;
    });
    // Read-merge-write (profile.ts's rule for this shared jsonb): fields this
    // form doesn't edit — medical_profile, symptom_reports, dose_snoozes,
    // travelPlan, completedWalkthroughs — must survive a save here.
    const existing = (await fetchProfile(elderId))?.details ?? {};
    await saveProfile(elderId, "elder", patient.name, {
      ...existing,
      dob: dobDraft || undefined,
      weightKg: weightDraft ? Number(weightDraft) : undefined,
      heightCm: heightDraft ? Number(heightDraft) : undefined,
      gender: genderDraft || undefined,
      conditions: conditionsDraft,
      allergies: savedAllergies,
      drugAllergies: drugAllergiesDraft,
      wakeTime: wakeDraft,
      mealTimes,
      sleepTime: sleepDraft,
    });
    setAllergyEntries(normalizeAllergies(savedAllergies));
    onUpdatePatient({
      ...patient,
      age: dobDraft ? calculateAge(dobDraft) : patient.age,
      gender: genderDraft || undefined,
      weightKg: weightDraft ? Number(weightDraft) : undefined,
      heightCm: heightDraft ? Number(heightDraft) : undefined,
      conditions: conditionsDraft,
      allergies: [...allergiesDraft, ...drugAllergiesDraft],
      wakeTime: wakeDraft,
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
            {/* Saved allergies (both legacy strings and promoted {name, severity}
                objects) — always visible so a set_allergy_severity highlight can
                land on data-testid="allergy-{slug}" even while the editable
                profile section below is collapsed. */}
            {allergyEntries.map(a => (
              <span key={a.name} data-testid={`allergy-${slugify(a.name)}`} className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-800 border border-red-200 rounded-full px-2.5 py-1">
                {a.name}
                {a.severity && (
                  <em className="not-italic text-[10px] font-bold uppercase tracking-wide bg-red-100 text-red-700 rounded-full px-1.5 py-0.5">{a.severity}</em>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* Symptoms noted — read-only journal written by Mei's add_symptom tool
            (accessibility.symptom_reports), newest first; hidden when empty. */}
        {symptomReports.length > 0 && (
          <div className="bg-card rounded-2xl border border-border divide-y divide-border">
            <div className="px-4 py-3"><p className="font-semibold text-foreground">{t(language, "settings.symptomsNoted")}</p></div>
            {symptomReports.map(r => (
              <div key={r.id} data-testid={`symptom-${r.id}`} className="px-4 py-3">
                <p className="text-[15px] text-foreground leading-snug">{r.symptom}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {r.medication_name ? `${r.medication_name} · ` : ""}
                  {Number.isNaN(new Date(r.noted_at).getTime())
                    ? ""
                    : new Date(r.noted_at).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Your Profile — everything the guided setup wizard asked, editable here */}
        <div className="bg-card rounded-2xl border border-border overflow-hidden" data-tour="elder-profile-section">
          <button
            data-walk="elder-profile-toggle"
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
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-foreground">{t(language, "settings.dob")}</label>
                {!dobDraft.trim() && (
                  <MeiSuggestButton
                    fieldLabel={t(language, "settings.dob")}
                    formatHint="Reply in YYYY-MM-DD format only."
                    validate={v => /^\d{4}-\d{2}-\d{2}$/.test(v)}
                    onAccept={setDobDraft}
                  />
                )}
              </div>
              <input type="date" value={dobDraft} onChange={e => setDobDraft(e.target.value)} max={new Date().toISOString().slice(0, 10)} className={fieldCls} />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-foreground">{t(language, "settings.gender")}</label>
                {!genderDraft.trim() && (
                  <MeiSuggestButton
                    fieldLabel={t(language, "settings.gender")}
                    onAccept={v => setGenderDraft(/^f/i.test(v) ? "Female" : /^m/i.test(v) ? "Male" : v)}
                  />
                )}
              </div>
              <GenderPicker value={genderDraft} onChange={setGenderDraft} size="sm" />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-foreground">{t(language, "settings.weightKg")}</label>
                {!weightDraft.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.weightKg")} onAccept={v => setWeightDraft(v.match(/\d+(\.\d+)?/)?.[0] ?? v)} />}
              </div>
              <input type="number" data-walk="elder-profile-weight" value={weightDraft} onChange={e => setWeightDraft(e.target.value)} placeholder="e.g. 60" className={fieldCls} />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-foreground">{t(language, "settings.heightCm")}</label>
                {!heightDraft.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.heightCm")} onAccept={v => setHeightDraft(v.match(/\d+(\.\d+)?/)?.[0] ?? v)} />}
              </div>
              <input type="number" value={heightDraft} onChange={e => setHeightDraft(e.target.value)} placeholder="e.g. 160" className={fieldCls} />
            </div>
          </div>

          <TagList data-walk="elder-conditions" label={t(language, "settings.medicalConditions")} placeholder={t(language, "wizard.conditionsPlaceholder")} items={conditionsDraft} suggestions={withCatalogLabels(COMMON_CONDITIONS, language)} onAdd={v => setConditionsDraft(p => [...p, v])} onRemove={i => setConditionsDraft(p => p.filter((_, j) => j !== i))} />
          <TagList label={t(language, "settings.generalAllergies")} placeholder={t(language, "wizard.allergiesPlaceholder")} items={allergiesDraft} suggestions={withCatalogLabels(COMMON_ALLERGIES, language)} onAdd={v => setAllergiesDraft(p => [...p, v])} onRemove={i => setAllergiesDraft(p => p.filter((_, j) => j !== i))} />
          <TagList label={t(language, "settings.medicationAllergies")} placeholder={t(language, "wizard.drugAllergiesPlaceholder")} items={drugAllergiesDraft} suggestions={withCatalogLabels(COMMON_DRUG_ALLERGIES, language)} onAdd={v => setDrugAllergiesDraft(p => [...p, v])} onRemove={i => setDrugAllergiesDraft(p => p.filter((_, j) => j !== i))} />

          <div>
            <p className="text-sm font-semibold text-foreground mb-2">{t(language, "settings.mealsSleep")}</p>
            <div className="space-y-3">
              <TimeField label={t(language, "wizard.wakeUpTime")} icon={<Sunrise size={15} className="text-primary" />} value={wakeDraft} onChange={setWakeDraft} />
              <TimeField label={t(language, "wizard.breakfast")} icon={<Coffee size={15} className="text-primary" />} value={breakfastDraft} onChange={setBreakfastDraft} />
              <TimeField label={t(language, "wizard.lunch")} icon={<Utensils size={15} className="text-primary" />} value={lunchDraft} onChange={setLunchDraft} />
              <TimeField label={t(language, "wizard.dinner")} icon={<UtensilsCrossed size={15} className="text-primary" />} value={dinnerDraft} onChange={setDinnerDraft} />
              <TimeField label={t(language, "wizard.bedtime")} icon={<Moon size={15} className="text-primary" />} value={sleepDraft} onChange={setSleepDraft} />
            </div>
          </div>

          <button
            data-walk="elder-profile-save"
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

        {/* Caregiver linking QR — a caregiver scans this to request managing this
            elder's medications; the request lands in the elder's Notifications. */}
        {elderId && (
          <div className="bg-card rounded-2xl border border-border p-4" data-tour="elder-qr-link">
            <div className="flex items-center gap-2 mb-1">
              <QrCode size={15} className="text-primary" />
              <p className="font-semibold text-foreground">{t(language, "link.qrTitle")}</p>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{t(language, "link.qrDesc")}</p>
            <div className="flex justify-center">
              {/* No app-observable signal exists for "showed this to someone" (it's
                  a physical action outside the DOM) — a tap on the code itself,
                  once shown, is the least-arbitrary real action available, and is
                  what the link_caregiver walkthrough's QR-display step waits on
                  ("acknowledge", used sparingly for pure-display steps). */}
              <button
                type="button"
                data-walk="elder-qr-gotit"
                className="bg-white rounded-2xl p-4 border border-border active:scale-[0.98] transition-transform"
                aria-label={t(language, "walk.link.gotIt")}
              >
                <QRCodeSVG value={buildCareLinkPayload(elderId, patient.name)} size={168} level="M" />
              </button>
            </div>
          </div>
        )}

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
            <Toggle on={voiceOutput} onToggle={() => setVoiceOutput(!voiceOutput)} />
          </div>
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-[15px] font-medium text-foreground">{t(language, "settings.language")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.languageDesc")}</p>
            </div>
            <select value={language} data-walk="elder-language-select" onChange={e => setLanguage(e.target.value as any)} className="bg-muted rounded-xl px-3 py-2 text-sm font-medium text-foreground outline-none">
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
          <div className="bg-card rounded-2xl border border-border divide-y divide-border" data-walk="elder-emergency-section">
            <div className="px-4 py-3"><p className="font-semibold text-foreground">{t(language, "settings.emergencyContact")}</p></div>
            <div className="px-4 py-4 flex items-center justify-between">
              <div>
                <p className="text-[15px] font-medium text-foreground">{primary.name}</p>
                <p className="text-sm text-muted-foreground">{primary.role}</p>
                <p className="text-sm text-muted-foreground">{primary.phone}</p>
              </div>
              <button onClick={() => setShowCallPrimary(true)} data-walk="elder-emergency-call" className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-xl flex items-center justify-center active:scale-95 transition-transform">
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

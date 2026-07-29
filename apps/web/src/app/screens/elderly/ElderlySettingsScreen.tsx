import { useState, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Shield, ChevronRight, ChevronDown, Eye, Phone, RefreshCw, LogOut, Check, Loader2,
  Sunrise, Coffee, Utensils, UtensilsCrossed, Moon, QrCode, Search, X, Bell, Globe, UserRound,
  Info, Type,
} from "lucide-react";
import { buildCareLinkPayload } from "../../lib/careLinks";
import { useAccessibility } from "../../accessibility.tsx";
import type { FontSize, ContrastMode, ColourVisionMode, NotificationPrefs } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_SHAPES, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES } from "../../data/medications";
import { fetchProfile, saveProfile, calculateAge } from "../../lib/profile";
import { TagList, fieldCls, GenderPicker, withCatalogLabels } from "../setup/GuidedSetupWizard";
import { MedAvatar } from "../../components/shared";
import { MeiSuggestButton } from "../../components/MeiSuggestButton";
import { TimeField } from "../../components/TimesPicker";
import { CallMockup } from "../../components/CallMockup";
import { useLanguage } from "../../lib/languageContext";
import { LANGUAGE_OPTIONS, t } from "../../lib/language";

export function Toggle({ on, onToggle, "data-walk": dataWalk }: { on: boolean; onToggle: () => void; "data-walk"?: string }) {
  return (
    <button onClick={onToggle} aria-pressed={on} data-walk={dataWalk} className={`w-14 h-8 rounded-full transition-colors relative shrink-0 ${on ? "bg-primary" : "bg-switch-background"}`}>
      <div className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${on ? "translate-x-7" : "translate-x-1"}`} />
    </button>
  );
}

const FONT_SIZES: FontSize[] = ["small", "normal", "large", "xlarge", "xxlarge"];

// Which sub-screen is open. The hub shows the common controls inline and each
// section's "More settings" opens the full page — so the everyday toggles stay
// one tap away while the long forms stop making the hub a scroll marathon.
type Section = "profile" | "accessibility" | "reminders" | "voice" | "emergency" | "caregiver" | "about";

// A labelled row of mutually exclusive choices. Used for contrast and colour
// vision, where a switch can't express three or four states and a dropdown
// hides the options behind a tap.
function ChoiceRow<T extends string>({ value, options, onChange, "data-walk": dataWalk }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; "data-walk"?: string;
}) {
  return (
    <div data-walk={dataWalk} className="flex flex-wrap gap-2">
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`px-3.5 py-2.5 rounded-xl text-[14px] font-bold border-2 transition-colors ${
            value === o.id ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-4 flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-semibold text-foreground leading-snug">{label}</p>
        {desc && <p className="text-[14px] text-muted-foreground leading-snug mt-0.5">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function SectionCard({ icon: Icon, title, walk, children, onMore }: {
  icon: any; title: string; walk?: string; children?: React.ReactNode; onMore?: () => void;
}) {
  const { language } = useLanguage();
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <button
        onClick={onMore}
        data-walk={walk}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/60 transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Icon size={20} className="text-primary" />
        </div>
        <span className="flex-1 min-w-0 text-[17px] font-bold text-foreground leading-tight">{title}</span>
        <ChevronRight size={20} className="text-muted-foreground shrink-0" />
      </button>
      {children && <div className="border-t border-border divide-y divide-border">{children}</div>}
      {children && onMore && (
        <button onClick={onMore} className="w-full px-4 py-3.5 border-t border-border text-[14px] font-bold text-primary flex items-center justify-center gap-1.5 active:bg-secondary/60 transition-colors">
          {t(language, "settings.moreSettings")}<ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}

// The title and back button live in the app header (onHeaderOverride), so this
// is just the scroll body.
function SubScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 pb-28 space-y-3">{children}</div>
    </div>
  );
}

export function ElderlySettingsScreen({ patient, elderId, onUpdatePatient, onBack, onSignOut, onHeaderOverride }: {
  patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onBack: () => void; onSignOut: () => void;
  // A sub-screen REPLACES the app header rather than stacking its own beneath it.
  onHeaderOverride?: (h: { title: string; onBack: () => void; action?: React.ReactNode } | null) => void;
}) {
  const {
    fontSize, setFontSize, contrast, setContrast, colourVision, setColourVision,
    colourBlind, voiceOutput, setVoiceOutput, notifications, setNotification,
  } = useAccessibility();
  const { language, setLanguage } = useLanguage();
  const [section, setSection] = useState<Section | null>(null);
  const [query, setQuery] = useState("");
  const [showShapes, setShowShapes] = useState(false);
  const [showCallPrimary, setShowCallPrimary] = useState(false);
  const [showQr, setShowQr] = useState(false);
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
  const [wakeDraft, setWakeDraft] = useState("07:00");
  const [breakfastDraft, setBreakfastDraft] = useState("08:00");
  const [lunchDraft, setLunchDraft] = useState("12:30");
  const [dinnerDraft, setDinnerDraft] = useState("19:00");
  const [sleepDraft, setSleepDraft] = useState("22:30");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

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
    await saveProfile(elderId, "elder", patient.name, {
      dob: dobDraft || undefined,
      weightKg: weightDraft ? Number(weightDraft) : undefined,
      heightCm: heightDraft ? Number(heightDraft) : undefined,
      gender: genderDraft || undefined,
      conditions: conditionsDraft,
      allergies: allergiesDraft,
      drugAllergies: drugAllergiesDraft,
      wakeTime: wakeDraft,
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
      wakeTime: wakeDraft,
      mealTimes,
      sleepTime: sleepDraft,
    });
    setProfileSaving(false);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const contrastOptions: { id: ContrastMode; label: string }[] = [
    { id: "normal", label: t(language, "settings.contrastNormal") },
    { id: "high", label: t(language, "settings.contrastHigh") },
    { id: "max", label: t(language, "settings.contrastMax") },
  ];
  const colourVisionOptions: { id: ColourVisionMode; label: string }[] = [
    { id: "off", label: t(language, "settings.cvOff") },
    { id: "deuteranopia", label: t(language, "settings.cvDeuter") },
    { id: "protanopia", label: t(language, "settings.cvProtan") },
    { id: "tritanopia", label: t(language, "settings.cvTritan") },
  ];
  const notifOptions: { key: keyof NotificationPrefs; label: string }[] = [
    { key: "doseReminders", label: t(language, "settings.notifDose") },
    { key: "refillAlerts", label: t(language, "settings.notifRefill") },
    { key: "caregiverNotes", label: t(language, "settings.notifCaregiver") },
    { key: "missedDoseAlerts", label: t(language, "settings.notifMissed") },
  ];

  // Every individually-findable setting, so search can jump straight to the
  // sub-screen that owns it instead of only matching section titles.
  const searchIndex = useMemo<{ label: string; section: Section }[]>(() => [
    { label: t(language, "settings.dob"), section: "profile" },
    { label: t(language, "settings.gender"), section: "profile" },
    { label: t(language, "settings.weightKg"), section: "profile" },
    { label: t(language, "settings.heightCm"), section: "profile" },
    { label: t(language, "settings.medicalConditions"), section: "profile" },
    { label: t(language, "settings.generalAllergies"), section: "profile" },
    { label: t(language, "settings.medicationAllergies"), section: "profile" },
    { label: t(language, "settings.mealsSleep"), section: "profile" },
    { label: t(language, "settings.textSize"), section: "accessibility" },
    { label: t(language, "settings.contrast"), section: "accessibility" },
    { label: t(language, "settings.colourVision"), section: "accessibility" },
    { label: t(language, "settings.medicationDescriptions"), section: "accessibility" },
    ...notifOptions.map(o => ({ label: o.label, section: "reminders" as Section })),
    { label: t(language, "settings.language"), section: "voice" },
    { label: t(language, "settings.readAloud"), section: "voice" },
    { label: t(language, "settings.emergencyContact"), section: "emergency" },
    { label: t(language, "link.qrTitle"), section: "caregiver" },
    { label: t(language, "settings.about"), section: "about" },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [language]);

  const matches = query.trim()
    ? searchIndex.filter(i => i.label.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  const SECTION_TITLES: Record<Section, string> = {
    profile: t(language, "settings.yourProfile"),
    accessibility: t(language, "settings.accessibility"),
    reminders: t(language, "settings.reminders"),
    voice: t(language, "settings.voiceAndLanguage"),
    emergency: t(language, "settings.emergencyContact"),
    caregiver: t(language, "settings.caregiverSection"),
    about: t(language, "settings.about"),
  };

  // --- controls, defined once and reused by both the hub and the sub-screens ---
  const textSizeControl = (
    <div className="px-4 py-4" data-tour="elder-fontsize">
      <p className="text-[15px] font-semibold text-foreground mb-0.5">{t(language, "settings.textSize")}</p>
      <p className="text-[14px] text-muted-foreground mb-3">{t(language, "settings.textSizeDesc")}</p>
      <div className="flex items-center gap-3">
        <span className="text-[14px] font-bold text-muted-foreground shrink-0">A</span>
        <input
          type="range"
          min={0}
          max={FONT_SIZES.length - 1}
          step={1}
          value={FONT_SIZES.indexOf(fontSize)}
          onChange={e => setFontSize(FONT_SIZES[Number(e.target.value)])}
          aria-label={t(language, "settings.textSize")}
          className="flex-1 accent-primary h-3"
        />
        <span className="text-[26px] font-bold text-muted-foreground shrink-0 leading-none">A</span>
      </div>
    </div>
  );

  const contrastControl = (
    <div className="px-4 py-4">
      <p className="text-[15px] font-semibold text-foreground mb-0.5">{t(language, "settings.contrast")}</p>
      <p className="text-[14px] text-muted-foreground mb-3">{t(language, "settings.contrastDesc")}</p>
      <ChoiceRow value={contrast} options={contrastOptions} onChange={setContrast} data-walk="elder-contrast" />
    </div>
  );

  const colourVisionControl = (
    <div className="px-4 py-4">
      <p className="text-[15px] font-semibold text-foreground mb-0.5">{t(language, "settings.colourVision")}</p>
      <p className="text-[14px] text-muted-foreground mb-3">{t(language, "settings.colourVisionDesc")}</p>
      <ChoiceRow value={colourVision} options={colourVisionOptions} onChange={setColourVision} data-walk="elder-colourvision" />
      {colourBlind && (
        <div className="bg-secondary/50 rounded-xl p-3 mt-3">
          <button onClick={() => setShowShapes(v => !v)} className="w-full flex items-center justify-between text-[14px] font-bold text-foreground">
            <span className="flex items-center gap-2"><Eye size={17} className="text-primary" />{t(language, "settings.medicationDescriptions")}</span>
            <ChevronDown size={17} className={`text-muted-foreground transition-transform ${showShapes ? "rotate-180" : ""}`} />
          </button>
          {showShapes && (
            <div className="mt-3 space-y-3 pt-3 border-t border-border/40">
              {patient.medications.map(m => {
                const shape = MED_SHAPES[m.name];
                if (!shape) return null;
                return (
                  <div key={m.id} className="flex items-start gap-3">
                    <MedAvatar name={m.name} size={44} className="rounded-lg shrink-0 grayscale" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-bold text-foreground break-words">{m.name}</p>
                      <p className="text-[14px] text-muted-foreground">{shape.shape}</p>
                      <p className="text-[14px] text-muted-foreground">{shape.marking}</p>
                    </div>
                  </div>
                );
              })}
              {patient.medications.every(m => !MED_SHAPES[m.name]) && (
                <p className="text-[14px] text-muted-foreground">{t(language, "prescription.empty")}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const languageControl = (
    <div className="px-4 py-4">
      <p className="text-[15px] font-semibold text-foreground mb-0.5">{t(language, "settings.language")}</p>
      <p className="text-[14px] text-muted-foreground mb-3">{t(language, "settings.languageDesc")}</p>
      <div data-walk="elder-language-select" className="grid grid-cols-2 gap-2">
        {LANGUAGE_OPTIONS.map(o => (
          <button
            key={o.id}
            onClick={() => setLanguage(o.id)}
            aria-pressed={language === o.id}
            className={`py-3 px-2 rounded-xl text-[14px] font-bold border-2 transition-colors ${
              language === o.id ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  const readAloudControl = (
    <SettingRow label={t(language, "settings.readAloud")} desc={t(language, "settings.readAloudDesc")}>
      <Toggle on={voiceOutput} onToggle={() => setVoiceOutput(!voiceOutput)} data-walk="elder-readaloud-toggle" />
    </SettingRow>
  );

  const emergencyCard = primary ? (
    <div className="px-4 py-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[17px] font-bold text-foreground break-words leading-tight">{primary.name}</p>
        <p className="text-[14px] text-muted-foreground">{primary.role}</p>
        <p className="text-[14px] text-muted-foreground">{primary.phone}</p>
      </div>
      <button
        onClick={() => setShowCallPrimary(true)}
        data-walk="elder-emergency-call"
        aria-label={`${t(language, "settings.emergencyContact")}: ${primary.name}`}
        className="w-14 h-14 bg-taken-bg text-taken-fg border-2 border-taken-border rounded-2xl flex items-center justify-center shrink-0 active:scale-95 transition-transform"
      >
        <Phone size={22} />
      </button>
    </div>
  ) : null;

  const qrCard = elderId ? (
    <div className="bg-card rounded-2xl border border-border p-4" data-tour="elder-qr-link">
      <div className="flex items-center gap-2.5">
        <QrCode size={20} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold text-foreground leading-tight">{t(language, "settings.caregiverCode")}</p>
          <p className="text-[14px] text-muted-foreground leading-snug">{t(language, "link.qrDesc")}</p>
        </div>
      </div>
      <button
        onClick={() => setShowQr(v => !v)}
        className="mt-3 w-full h-12 rounded-xl border border-border text-[14px] font-bold text-foreground active:bg-muted transition-colors"
      >
        {showQr ? t(language, "settings.hideCode") : t(language, "settings.showCode")}
      </button>
      {showQr && (
        <div className="flex justify-center mt-3">
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
            <QRCodeSVG value={buildCareLinkPayload(elderId, patient.name)} size={180} level="M" />
          </button>
        </div>
      )}
    </div>
  ) : null;

  useEffect(() => {
    onHeaderOverride?.(section ? { title: SECTION_TITLES[section], onBack: () => setSection(null) } : null);
    return () => onHeaderOverride?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, language]);

  // --- sub-screens -----------------------------------------------------------
  if (section) {
    if (section === "profile") {
      return (
        <SubScreen>
          <div className="bg-card rounded-2xl border border-border p-4 space-y-4">
            <div className="flex gap-3">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[14px] font-bold text-foreground">{t(language, "settings.dob")}</label>
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
                  <label className="text-[14px] font-bold text-foreground">{t(language, "settings.gender")}</label>
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
                  <label className="text-[14px] font-bold text-foreground">{t(language, "settings.weightKg")}</label>
                  {!weightDraft.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.weightKg")} onAccept={v => setWeightDraft(v.match(/\d+(\.\d+)?/)?.[0] ?? v)} />}
                </div>
                <input type="number" data-walk="elder-profile-weight" value={weightDraft} onChange={e => setWeightDraft(e.target.value)} placeholder="e.g. 60" className={fieldCls} />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[14px] font-bold text-foreground">{t(language, "settings.heightCm")}</label>
                  {!heightDraft.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.heightCm")} onAccept={v => setHeightDraft(v.match(/\d+(\.\d+)?/)?.[0] ?? v)} />}
                </div>
                <input type="number" value={heightDraft} onChange={e => setHeightDraft(e.target.value)} placeholder="e.g. 160" className={fieldCls} />
              </div>
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-border p-4 space-y-4">
            <TagList data-walk="elder-conditions" label={t(language, "settings.medicalConditions")} placeholder={t(language, "wizard.conditionsPlaceholder")} items={conditionsDraft} suggestions={withCatalogLabels(COMMON_CONDITIONS, language)} onAdd={v => setConditionsDraft(p => [...p, v])} onRemove={i => setConditionsDraft(p => p.filter((_, j) => j !== i))} />
            <TagList label={t(language, "settings.generalAllergies")} placeholder={t(language, "wizard.allergiesPlaceholder")} items={allergiesDraft} suggestions={withCatalogLabels(COMMON_ALLERGIES, language)} onAdd={v => setAllergiesDraft(p => [...p, v])} onRemove={i => setAllergiesDraft(p => p.filter((_, j) => j !== i))} />
            <TagList label={t(language, "settings.medicationAllergies")} placeholder={t(language, "wizard.drugAllergiesPlaceholder")} items={drugAllergiesDraft} suggestions={withCatalogLabels(COMMON_DRUG_ALLERGIES, language)} onAdd={v => setDrugAllergiesDraft(p => [...p, v])} onRemove={i => setDrugAllergiesDraft(p => p.filter((_, j) => j !== i))} />
          </div>

          <div className="bg-card rounded-2xl border border-border p-4">
            <p className="text-[15px] font-bold text-foreground mb-3">{t(language, "settings.mealsSleep")}</p>
            <div className="space-y-3">
              <TimeField label={t(language, "wizard.wakeUpTime")} icon={<Sunrise size={17} className="text-primary" />} value={wakeDraft} onChange={setWakeDraft} />
              <TimeField label={t(language, "wizard.breakfast")} icon={<Coffee size={17} className="text-primary" />} value={breakfastDraft} onChange={setBreakfastDraft} />
              <TimeField label={t(language, "wizard.lunch")} icon={<Utensils size={17} className="text-primary" />} value={lunchDraft} onChange={setLunchDraft} />
              <TimeField label={t(language, "wizard.dinner")} icon={<UtensilsCrossed size={17} className="text-primary" />} value={dinnerDraft} onChange={setDinnerDraft} />
              <TimeField label={t(language, "wizard.bedtime")} icon={<Moon size={17} className="text-primary" />} value={sleepDraft} onChange={setSleepDraft} />
            </div>
          </div>

          <button
            data-walk="elder-profile-save"
            onClick={saveProfileDraft}
            disabled={profileSaving || !elderId}
            className="w-full h-13 py-3.5 rounded-2xl bg-primary text-primary-foreground text-[16px] font-bold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            {profileSaving ? <Loader2 size={19} className="animate-spin" /> : profileSaved ? <Check size={19} /> : null}
            {profileSaving ? t(language, "settings.saving") : profileSaved ? t(language, "settings.saved") : t(language, "settings.saveChanges")}
          </button>
        </SubScreen>
      );
    }
    if (section === "accessibility") {
      return (
        <SubScreen>
          <div className="bg-card rounded-2xl border border-border divide-y divide-border">
            {textSizeControl}
            {contrastControl}
            {colourVisionControl}
          </div>
        </SubScreen>
      );
    }
    if (section === "reminders") {
      return (
        <SubScreen>
          <div className="bg-card rounded-2xl border border-border divide-y divide-border">
            {notifOptions.map(o => (
              <SettingRow key={o.key} label={o.label}>
                <Toggle
                  on={notifications[o.key]}
                  onToggle={() => setNotification(o.key, !notifications[o.key])}
                  data-walk={o.key === "doseReminders" ? "elder-reminder-meds" : undefined}
                />
              </SettingRow>
            ))}
          </div>
          <p className="text-[14px] text-muted-foreground px-1 leading-relaxed">{t(language, "settings.medicationRemindersDesc")}</p>
        </SubScreen>
      );
    }
    if (section === "voice") {
      return (
        <SubScreen>
          <div className="bg-card rounded-2xl border border-border divide-y divide-border" data-tour="elder-language">
            {readAloudControl}
            {languageControl}
          </div>
        </SubScreen>
      );
    }
    if (section === "emergency") {
      return (
        <SubScreen>
          <div className="bg-card rounded-2xl border border-border">
            {emergencyCard ?? <p className="px-4 py-6 text-[14px] text-muted-foreground text-center">{t(language, "notifications.empty")}</p>}
          </div>
          {showCallPrimary && primary && <CallMockup name={primary.name} role={primary.role} onEnd={() => setShowCallPrimary(false)} />}
        </SubScreen>
      );
    }
    if (section === "caregiver") {
      return <SubScreen>{qrCard}</SubScreen>;
    }
    return (
      <SubScreen>
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-[15px] text-foreground leading-relaxed">{t(language, "settings.aboutBody")}</p>
        </div>
        <button onClick={onBack} className="w-full h-13 py-3.5 rounded-2xl border border-border text-foreground text-[15px] font-bold flex items-center justify-center gap-2 active:bg-muted transition-colors">
          <RefreshCw size={18} />{t(language, "settings.switchToCaregiver")}
        </button>
        <button onClick={onSignOut} className="w-full h-13 py-3.5 rounded-2xl border-2 border-destructive/40 text-destructive text-[15px] font-bold flex items-center justify-center gap-2 active:bg-destructive/10 transition-colors">
          <LogOut size={18} />{t(language, "settings.signOut")}
        </button>
      </SubScreen>
    );
  }

  // --- hub -------------------------------------------------------------------
  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-3 pb-28 space-y-3">
        {/* Profile card, with the edit button on the card itself rather than as
            a separate row further down the page. */}
        <div className="bg-card rounded-2xl border border-border p-4" data-tour="elder-profile-section">
          <div className="flex items-center gap-3.5">
            <img src={patient.photo} alt="" className="w-[60px] h-[60px] rounded-full object-cover bg-muted border-2 border-primary/20 shrink-0" />
            <div className="min-w-0">
              <p className="font-bold text-foreground text-[20px] leading-tight break-words">{patient.nickname}</p>
              <p className="text-[14px] text-muted-foreground break-words">{patient.name} · {patient.age}</p>
            </div>
          </div>
          {patient.conditions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {patient.conditions.map(c => <span key={c} className="text-[14px] font-semibold bg-secondary text-secondary-foreground rounded-full px-3 py-1">{c}</span>)}
            </div>
          )}
          <button
            data-walk="elder-profile-toggle"
            onClick={() => setSection("profile")}
            className="mt-3.5 w-full h-13 py-3.5 rounded-xl bg-primary text-primary-foreground text-[15px] font-bold flex items-center justify-center gap-2 active:opacity-80 transition-opacity"
          >
            <UserRound size={19} />{t(language, "settings.editProfile")}
          </button>
        </div>

        {qrCard}

        <div className="relative">
          <Search size={20} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t(language, "settings.searchPlaceholder")}
            data-walk="elder-settings-search"
            className="w-full h-13 bg-input-background border border-border rounded-2xl pl-11 pr-11 text-[15px] text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label={t(language, "common.cancel")} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
              <X size={16} className="text-muted-foreground" />
            </button>
          )}
        </div>

        {query.trim() ? (
          <div className="bg-card rounded-2xl border border-border divide-y divide-border overflow-hidden">
            {matches.map(m => (
              <button
                key={`${m.section}-${m.label}`}
                onClick={() => { setSection(m.section); setQuery(""); }}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/60 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold text-foreground leading-snug">{m.label}</p>
                  <p className="text-[14px] text-muted-foreground">{SECTION_TITLES[m.section]}</p>
                </div>
                <ChevronRight size={20} className="text-muted-foreground shrink-0" />
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-4 py-6 text-[14px] text-muted-foreground text-center">{t(language, "settings.noResults", { q: query.trim() })}</p>
            )}
          </div>
        ) : (
          <>
            {/* Each card leads with the one or two controls people actually
                reach for, then "More settings" opens the full page. */}
            <SectionCard icon={Type} title={SECTION_TITLES.accessibility} walk="elder-settings-accessibility" onMore={() => setSection("accessibility")}>
              {textSizeControl}
            </SectionCard>

            <SectionCard icon={Bell} title={SECTION_TITLES.reminders} walk="elder-settings-notifications" onMore={() => setSection("reminders")}>
              <SettingRow label={t(language, "settings.notifDose")}>
                <Toggle on={notifications.doseReminders} onToggle={() => setNotification("doseReminders", !notifications.doseReminders)} data-walk="elder-reminder-meds" />
              </SettingRow>
            </SectionCard>

            <SectionCard icon={Globe} title={SECTION_TITLES.voice} walk="elder-settings-voice" onMore={() => setSection("voice")}>
              {readAloudControl}
            </SectionCard>

            <SectionCard icon={Phone} title={SECTION_TITLES.emergency} walk="elder-settings-emergency" onMore={() => setSection("emergency")}>
              {emergencyCard ?? undefined}
            </SectionCard>

            <SectionCard icon={Shield} title={SECTION_TITLES.caregiver} onMore={() => setSection("caregiver")} />
            <SectionCard icon={Info} title={SECTION_TITLES.about} onMore={() => setSection("about")} />

            <button onClick={onBack} className="w-full h-13 py-3.5 rounded-2xl border border-border text-foreground text-[15px] font-bold flex items-center justify-center gap-2 active:bg-muted transition-colors">
              <RefreshCw size={18} />{t(language, "settings.switchToCaregiver")}
            </button>

            <button onClick={onSignOut} className="w-full h-13 py-3.5 rounded-2xl border-2 border-destructive/40 text-destructive text-[15px] font-bold flex items-center justify-center gap-2 active:bg-destructive/10 transition-colors">
              <LogOut size={18} />{t(language, "settings.signOut")}
            </button>
          </>
        )}
      </div>

      {showCallPrimary && primary && (
        <CallMockup name={primary.name} role={primary.role} onEnd={() => setShowCallPrimary(false)} />
      )}
    </div>
  );
}

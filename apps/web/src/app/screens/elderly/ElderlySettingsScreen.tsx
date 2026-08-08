import { useState, useEffect, useMemo, useRef } from "react";
import type { ChangeEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ChevronRight, ChevronDown, Eye, Phone, LogOut, Check, Loader2,
  Sunrise, Coffee, Utensils, UtensilsCrossed, Moon, QrCode, Search, X, Bell, Globe, UserRound,
  Info, Type, HeartPulse, Camera,
} from "lucide-react";
import { buildCareLinkPayload, fetchLinkedCaregivers } from "../../lib/careLinks";
import type { LinkedCaregiver } from "../../lib/careLinks";
import { useAccessibility } from "../../accessibility.tsx";
import type { FontSize, ContrastMode, ColourVisionMode, NotificationPrefs } from "../../accessibility.tsx";
import type { Patient } from "../../types";
import { MED_SHAPES, COMMON_CONDITIONS, COMMON_ALLERGIES, COMMON_DRUG_ALLERGIES, localizeCatalogValue } from "../../data/medications";
import { fetchProfile, saveProfile, calculateAge } from "../../lib/profile";
import type { SymptomReport } from "../../lib/profile";
import { normalizeAllergies, slugify } from "../../lib/changeHighlight";
import { TagList, GenderPicker, withCatalogLabels } from "../setup/GuidedSetupWizard";
import { MedAvatar, ProfileAvatar } from "../../components/shared";
import { PhotoSourceSheet } from "../../components/PhotoSourceSheet";
import { MeiSuggestButton } from "../../components/MeiSuggestButton";
import { TimeField } from "../../components/TimesPicker";

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
import { CallMockup } from "../../components/CallMockup";
import { useLanguage } from "../../lib/languageContext";
import { LANGUAGE_OPTIONS, t, type AppLanguage } from "../../lib/language";

export function Toggle({ on, onToggle, "data-walk": dataWalk }: { on: boolean; onToggle: () => void; "data-walk"?: string }) {
  return (
    <button onClick={onToggle} aria-pressed={on} data-walk={dataWalk} className={`w-14 h-8 rounded-full transition-colors relative shrink-0 ${on ? "bg-primary" : "bg-switch-background"}`}>
      <div className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${on ? "translate-x-7" : "translate-x-1"}`} />
    </button>
  );
}

// Allergy severity is a backend-written word ("mild"/"moderate"/"severe").
// t() returns the KEY itself when there's no entry, so an unknown or legacy
// value would print literally as "severity.foo" — fall back to the raw word.
// Same guard localizeCatalogValue applies to catalog values.
function localizeSeverity(language: AppLanguage, severity: string): string {
  const key = `severity.${severity}`;
  const label = t(language, key);
  return label === key ? severity : label;
}

const FONT_SIZES: FontSize[] = ["small", "normal", "large", "xlarge", "xxlarge"];

// Every setting now lives ON the page — no "More settings", no sub-screens, so
// nothing is one tap out of reach. These name the sections purely so search can
// scroll to the one that owns a match. "Edit profile" is the single exception:
// it's a long form with its own Save, so it stays a separate screen.
type Anchor = "profile" | "accessibility" | "reminders" | "voice" | "emergency" | "caregiver" | "about";

// A row of mutually exclusive choices, all visible at once — a switch can't
// express three states. Equal columns on ONE row, each label on ONE line:
// options sized by their own text read as a ragged list rather than one
// control, and a wrapped label turned a chip into a block. Anything too long
// for its column truncates rather than wrapping or spilling.
const CHOICE_COLS: Record<number, string> = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };

export function ChoiceRow<T extends string>({ value, options, onChange, "data-walk": dataWalk }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; "data-walk"?: string;
}) {
  return (
    <div data-walk={dataWalk} className={`grid gap-1.5 ${CHOICE_COLS[options.length] ?? "grid-cols-3"}`}>
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          title={o.label}
          className={`h-10 px-1 rounded-lg text-[calc(12px*var(--dw-text,1))] font-semibold border truncate transition-colors ${
            value === o.id ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// The profile at rest: one labelled line per answer, value on the right. A page
// of empty-looking input boxes read as work to do; this reads as a record.
function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground shrink-0">{label}</p>
      <p className="flex-1 min-w-0 text-[calc(15px*var(--dw-text,1))] font-bold text-foreground text-right break-words">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

// The same row, editing: label in the same place, a filled field where the
// value was. Grey-filled rather than outlined — it reads as "this is a box you
// can type in" without turning the page into a wall of borders. Each field is
// sized to its own answer instead of stretching the full width: a two-digit
// weight in a 200px box looks like a mistake waiting to happen.
const editFieldCls = "h-10 rounded-lg bg-input-background border border-border px-2.5 text-[calc(15px*var(--dw-text,1))] font-bold text-foreground text-right outline-none focus:border-primary transition-colors";

function EditRow({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="shrink-0 flex items-center gap-1.5">
        <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{label}</p>
        {hint}
      </div>
      <div className="flex-1 min-w-0 max-w-[68%] flex justify-end">{children}</div>
    </div>
  );
}

function InfoSection({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div className="dw-surface p-4">
      <div className="flex items-center gap-2.5 pb-1.5">
        <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Icon size={18} className="text-primary" />
        </div>
        <h3 className="flex-1 min-w-0 text-[calc(16px*var(--dw-text,1))] font-bold text-foreground">{title}</h3>
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-4 flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{label}</p>
        {desc && <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-snug mt-0.5">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

// A titled card holding a section's controls in full. The title is a heading,
// not a button — there is nowhere further to go.
function SectionCard({ icon: Icon, title, anchor, walk, children }: {
  // `walk` is a stable walkthrough anchor, separate from `anchor` (which the
  // settings SEARCH scrolls to). A walkthrough that spotlights a section needs
  // its own contract: the emergency-contact tour pointed at a data-walk that
  // the settings-hub revamp deleted, and silently spotlighted nothing.
  icon: any; title: string; anchor: Anchor; walk?: string; children?: React.ReactNode;
}) {
  return (
    <div data-settings={anchor} data-walk={walk} className="dw-surface overflow-hidden scroll-mt-3">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Icon size={20} className="text-primary" />
        </div>
        <h2 className="flex-1 min-w-0 text-[calc(17px*var(--dw-text,1))] font-bold text-foreground leading-tight">{title}</h2>
      </div>
      {children && <div className="border-t border-border divide-y divide-border">{children}</div>}
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

export function ElderlySettingsScreen({ patient, elderId, onUpdatePatient, onSignOut, onHeaderOverride, walkthroughResetSignal }: {
  patient: Patient; elderId?: string; onUpdatePatient: (p: Patient) => void; onSignOut: () => void;
  // A sub-screen REPLACES the app header rather than stacking its own beneath it.
  onHeaderOverride?: (h: { title: string; onBack: () => void; action?: React.ReactNode } | null) => void;
  // Bumped by the host when a walkthrough starts. Every settings walkthrough
  // opens from the HUB, but a tour's onEnter can only switch bottom-nav tabs —
  // so if this screen was already sitting in a sub-page (or showing search
  // results, which unmount every section), the first target simply was not
  // there. Ignore the initial 0 so mounting normally changes nothing.
  walkthroughResetSignal?: number;
}) {
  const {
    fontSize, setFontSize, contrast, setContrast, colourVision, setColourVision,
    colourBlind, voiceOutput, setVoiceOutput, notifications, setNotification,
    timeFormat, setTimeFormat, walkthroughManualMode, setWalkthroughManualMode,
  } = useAccessibility();
  const { language, setLanguage } = useLanguage();
  // Saved conditions/allergies are stored as canonical English. Render them in
  // the app's language where they're one of our catalog values, and leave
  // anything the person typed themselves exactly as they wrote it.
  const loc = (v: string) => localizeCatalogValue(v, k => t(language, k));
  // The two screens that are NOT about this person's care: their own profile
  // form, and the app itself. Everything else stays on the page.
  const [subScreen, setSubScreen] = useState<null | "profile" | "about">(null);
  const [query, setQuery] = useState("");
  const [showShapes, setShowShapes] = useState(false);
  // Which mode the colour-vision switch turns back ON to, so flicking it off
  // and on again returns to the one that was chosen, not the first in the list.
  const lastColourMode = useRef<ColourVisionMode>(colourVision === "off" ? "deuteranopia" : colourVision);
  const [showCallPrimary, setShowCallPrimary] = useState(false);
  const [showQr, setShowQr] = useState(false);
  // The emergency contact IS the linked caregiver — read from care_links, not
  // from data/patients.ts. The fixture contact used to render on every real
  // account (App.tsx spreads ...prev[0] and never overwrote `contacts`), so the
  // app displayed a name and phone number for someone who did not exist while
  // Mei correctly reported no caregiver was linked. Dosewise stores no phone
  // number anywhere, so none is shown.
  const [caregivers, setCaregivers] = useState<LinkedCaregiver[]>([]);
  useEffect(() => {
    if (!elderId) return;
    void fetchLinkedCaregivers(elderId).then(setCaregivers);
  }, [elderId]);
  const primary = caregivers[0];

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
  // The profile screen opens read-only, showing what's on file; "Edit profile"
  // there is what makes the fields editable.
  const [profileEditing, setProfileEditing] = useState(false);
  const [showPhotoSource, setShowPhotoSource] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  // A walkthrough is starting: return to the hub it expects to spotlight.
  useEffect(() => {
    if (!walkthroughResetSignal) return;
    setSubScreen(null);
    setProfileEditing(false);
    setQuery("");
  }, [walkthroughResetSignal]);

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

  useEffect(() => {
    if (colourVision !== "off") lastColourMode.current = colourVision;
  }, [colourVision]);

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

  const contrastOptions: { id: ContrastMode; label: string }[] = [
    { id: "normal", label: t(language, "settings.contrastNormal") },
    { id: "high", label: t(language, "settings.contrastHigh") },
    { id: "max", label: t(language, "settings.contrastMax") },
  ];
  // "Off" is the switch now, so the choices are only the modes themselves.
  const colourVisionModes: { id: ColourVisionMode; label: string }[] = [
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
  // section that owns it instead of only matching section titles.
  const searchIndex = useMemo<{ label: string; section: Anchor }[]>(() => [
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
    { label: t(language, "settings.time24h"), section: "accessibility" },
    { label: t(language, "settings.medicationDescriptions"), section: "accessibility" },
    ...notifOptions.map(o => ({ label: o.label, section: "reminders" as Anchor })),
    { label: t(language, "settings.language"), section: "voice" },
    { label: t(language, "settings.readAloud"), section: "voice" },
    { label: t(language, "settings.walkthroughManual"), section: "voice" },
    { label: t(language, "settings.emergencyContact"), section: "emergency" },
    { label: t(language, "link.qrTitle"), section: "caregiver" },
    { label: t(language, "settings.about"), section: "about" },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [language]);

  const matches = query.trim()
    ? searchIndex.filter(i => i.label.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  const SECTION_TITLES: Record<Anchor, string> = {
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
      <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground mb-3">{t(language, "settings.textSize")}</p>
      <div className="flex items-center gap-3">
        <span className="text-[calc(14px*var(--dw-text,1))] font-bold text-muted-foreground shrink-0">A</span>
        <input
          type="range"
          min={0}
          max={FONT_SIZES.length - 1}
          step={1}
          value={FONT_SIZES.indexOf(fontSize)}
          onChange={e => setFontSize(FONT_SIZES[Number(e.target.value)])}
          aria-label={t(language, "settings.textSize")}
          // The text_size walkthrough waits for a real `input` change here. It
          // used to point at the wrapping div, whose `.value` is undefined —
          // so the check could never pass and that step hung forever.
          data-walk="elder-fontsize-slider"
          className="flex-1 accent-primary h-3"
        />
        <span className="text-[calc(26px*var(--dw-text,1))] font-bold text-muted-foreground shrink-0 leading-none">A</span>
      </div>
    </div>
  );

  const contrastControl = (
    <div className="px-4 py-4">
      <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground mb-3">{t(language, "settings.contrast")}</p>
      <ChoiceRow value={contrast} options={contrastOptions} onChange={setContrast} data-walk="elder-contrast" />
    </div>
  );

  const colourVisionControl = (
    <div className="px-4 py-4">
      {/* Switched, not chosen: most people never turn this on, and a row of
          modes sitting there permanently made a four-way choice out of a
          yes/no. The modes only appear once it's on. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground">{t(language, "settings.colourVision")}</p>
          <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-snug mt-0.5">{t(language, "settings.colourVisionDesc")}</p>
        </div>
        <Toggle
          on={colourBlind}
          onToggle={() => setColourVision(colourBlind ? "off" : lastColourMode.current)}
          data-walk="elder-colourvision-toggle"
        />
      </div>
      {colourBlind && (
        <div className="mt-3">
          <ChoiceRow value={colourVision} options={colourVisionModes} onChange={setColourVision} data-walk="elder-colourvision" />
        </div>
      )}
      {colourBlind && (
        <div className="bg-secondary/50 rounded-xl p-3 mt-3">
          <button onClick={() => setShowShapes(v => !v)} className="w-full flex items-center justify-between text-[calc(14px*var(--dw-text,1))] font-bold text-foreground">
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
                      <p className="text-[calc(14px*var(--dw-text,1))] font-bold text-foreground break-words">{m.name}</p>
                      <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{shape.shape}</p>
                      <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{shape.marking}</p>
                    </div>
                  </div>
                );
              })}
              {patient.medications.every(m => !MED_SHAPES[m.name]) && (
                <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{t(language, "prescription.empty")}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const languageControl = (
    <div className="px-4 py-4">
      <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground mb-3">{t(language, "settings.language")}</p>
      {/* A native <select>: it opens the OS's own picker, which is bigger and
          more familiar than anything drawn in-page — and six languages as a
          button grid was a block of colour competing with the settings around
          it. The wrapper keeps the data-walk the language walkthrough points at. */}
      <div data-walk="elder-language-select" className="relative">
        <select
          value={language}
          onChange={e => setLanguage(e.target.value as AppLanguage)}
          aria-label={t(language, "settings.language")}
          className="w-full h-13 appearance-none bg-input-background border border-border rounded-xl pl-4 pr-11 text-[calc(15px*var(--dw-text,1))] font-bold text-foreground outline-none focus:border-primary transition-colors"
        >
          {LANGUAGE_OPTIONS.map(o => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <ChevronDown size={20} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
      </div>
    </div>
  );

  // Clock format sits under Accessibility rather than with the language
  // settings: 24h is here for people who can't read an AM/PM at a glance, not
  // as a regional preference.
  const timeFormatControl = (
    <SettingRow label={t(language, "settings.time24h")} desc={t(language, "settings.time24hDesc")}>
      <Toggle
        on={timeFormat === "24h"}
        onToggle={() => setTimeFormat(timeFormat === "24h" ? "12h" : "24h")}
        data-walk="elder-24h-toggle"
      />
    </SettingRow>
  );

  const readAloudControl = (
    <SettingRow label={t(language, "settings.readAloud")} desc={t(language, "settings.readAloudDesc")}>
      <Toggle on={voiceOutput} onToggle={() => setVoiceOutput(!voiceOutput)} data-walk="elder-readaloud-toggle" />
    </SettingRow>
  );

  // TrustMode (Item 2): the permanent opt-out — leaves the walkthrough's
  // Next tap-gate mandatory no matter how many walkthroughs have completed.
  const walkthroughManualControl = (
    <SettingRow label={t(language, "settings.walkthroughManual")} desc={t(language, "settings.walkthroughManualDesc")}>
      <Toggle
        on={walkthroughManualMode}
        onToggle={() => setWalkthroughManualMode(!walkthroughManualMode)}
        data-walk="elder-walkthroughmanual-toggle"
      />
    </SettingRow>
  );

  const primaryName = primary?.name ?? t(language, "settings.emergencyUnnamed");
  const emergencyCard = primary ? (
    <div className="px-4 py-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[calc(17px*var(--dw-text,1))] font-bold text-foreground break-words leading-tight">{primaryName}</p>
        {primary.relationship && (
          <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{primary.relationship}</p>
        )}
        {/* No phone column exists in the schema. Saying so is the honest thing —
            the alternative was a fixture number that belonged to nobody. */}
        <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{t(language, "settings.emergencyNoPhone")}</p>
      </div>
      <button
        onClick={() => setShowCallPrimary(true)}
        data-walk="elder-emergency-call"
        aria-label={`${t(language, "settings.emergencyContact")}: ${primaryName}`}
        className="w-14 h-14 bg-taken-bg text-taken-fg border-2 border-taken-border rounded-2xl flex items-center justify-center shrink-0 active:scale-95 transition-transform"
      >
        <Phone size={22} />
      </button>
    </div>
  ) : null;

  const qrCard = elderId ? (
    <div className="dw-surface p-4" data-tour="elder-qr-link">
      <div className="flex items-center gap-2.5">
        <QrCode size={20} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[calc(15px*var(--dw-text,1))] font-bold text-foreground leading-tight">{t(language, "settings.caregiverCode")}</p>
          <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-snug">{t(language, "link.qrDesc")}</p>
        </div>
      </div>
      <button
        onClick={() => setShowQr(v => !v)}
        // The link_caregiver walkthrough has to open this itself: its next step
        // waits on the QR code, which only mounts once showQr is true. Without
        // an anchor here that step spotlighted an element that could never
        // exist and the elder side of the flow dead-ended at 2 of 4.
        data-walk="elder-qr-show"
        className="mt-3 w-full h-12 rounded-xl border border-border text-[calc(14px*var(--dw-text,1))] font-bold text-foreground active:bg-muted transition-colors"
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

  // The profile's Edit button lives in the header's top-right corner — the one
  // place on this screen that isn't part of the record being read.
  useEffect(() => {
    onHeaderOverride?.(subScreen ? {
      title: SECTION_TITLES[subScreen],
      onBack: () => setSubScreen(null),
      action: subScreen === "profile" && !profileEditing ? (
        <button
          data-walk="elder-profile-edit"
          onClick={() => setProfileEditing(true)}
          className="shrink-0 flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-3.5 h-10 active:opacity-80 transition-opacity"
        >
          <UserRound size={16} className="shrink-0" />
          <span className="text-[calc(14px*var(--dw-text,1))] font-bold whitespace-nowrap">{t(language, "settings.editProfile")}</span>
        </button>
      ) : undefined,
    } : null);
    return () => onHeaderOverride?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subScreen, profileEditing, language]);

  // The profile always opens as what it is — the answers already on file. Only
  // "Edit profile" there unlocks the fields, so a tap meant as "let me check my
  // details" can't change any of them.
  const openProfile = () => {
    setProfileEditing(false);
    setSubScreen("profile");
  };

  // Applies immediately (like the rest of patient.photo's local-only, cosmetic
  // history) rather than waiting on the DOB/weight/etc. Save button below,
  // which only writes the separate profile-jsonb draft fields.
  const onPhotoFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void fileToDataUrl(file).then(photo => onUpdatePatient({ ...patient, photo }));
  };

  // A search hit scrolls to the section that owns it — unless that section is
  // one of the two real screens. The sections aren't mounted while results are
  // up (they replace the list), so clear the query first and scroll next paint.
  const goToSetting = (anchor: Anchor) => {
    setQuery("");
    if (anchor === "profile") { openProfile(); return; }
    if (anchor === "about") { setSubScreen(anchor); return; }
    setTimeout(() => document.querySelector(`[data-settings="${anchor}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
  };

  // --- about Dosewise: the app itself, kept off the page of personal settings -
  if (subScreen === "about") {
    return (
      <SubScreen>
        <div className="dw-surface p-4">
          <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-relaxed">{t(language, "settings.aboutBody")}</p>
        </div>
      </SubScreen>
    );
  }

  // --- your profile: what's on file, editable only once they ask ------------
  if (subScreen === "profile" && !profileEditing) {
    const listOr = (items: string[]) => items.join(", ");
    return (
      <SubScreen>
        <InfoSection icon={UserRound} title={t(language, "settings.personalInfo")}>
          <InfoRow label={t(language, "settings.dob")} value={dobDraft} />
          <InfoRow label={t(language, "settings.gender")} value={genderDraft} />
          {/* The unit is already in the label, as in "Weight (kg)" — repeating
              it in the value just makes the line longer. */}
          <InfoRow label={t(language, "settings.weightKg")} value={weightDraft} />
          <InfoRow label={t(language, "settings.heightCm")} value={heightDraft} />
        </InfoSection>

        <InfoSection icon={HeartPulse} title={t(language, "settings.medicalInfo")}>
          <InfoRow label={t(language, "settings.medicalConditions")} value={listOr(conditionsDraft.map(loc))} />
          <InfoRow label={t(language, "settings.generalAllergies")} value={listOr(allergiesDraft.map(loc))} />
          <InfoRow label={t(language, "settings.medicationAllergies")} value={listOr(drugAllergiesDraft.map(loc))} />
        </InfoSection>

        <InfoSection icon={Utensils} title={t(language, "settings.mealsSleep")}>
          <InfoRow label={t(language, "wizard.wakeUpTime")} value={wakeDraft} />
          <InfoRow label={t(language, "wizard.breakfast")} value={breakfastDraft} />
          <InfoRow label={t(language, "wizard.lunch")} value={lunchDraft} />
          <InfoRow label={t(language, "wizard.dinner")} value={dinnerDraft} />
          <InfoRow label={t(language, "wizard.bedtime")} value={sleepDraft} />
        </InfoSection>
      </SubScreen>
    );
  }

  if (subScreen === "profile") {
      return (
        <SubScreen>
          <div className="flex justify-center pb-1">
            <div className="relative">
              <ProfileAvatar photo={patient.photo} size={80} className="rounded-full border-2 border-primary/20" />
              <button
                onClick={() => setShowPhotoSource(true)}
                aria-label={t(language, "photoSource.takePhoto")}
                className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center border-2 border-card"
              >
                <Camera size={14} />
              </button>
            </div>
          </div>
          <input ref={cameraRef} type="file" accept="image/*" capture="user" className="sr-only" onChange={onPhotoFile} />
          <input ref={libraryRef} type="file" accept="image/*" className="sr-only" onChange={onPhotoFile} />
          {showPhotoSource && (
            <PhotoSourceSheet
              onTakePhoto={() => { setShowPhotoSource(false); cameraRef.current?.click(); }}
              onChooseFile={() => { setShowPhotoSource(false); libraryRef.current?.click(); }}
              onClose={() => setShowPhotoSource(false)}
            />
          )}
          {/* Editing keeps the SAME record layout — same sections, same rows,
              same order. Only the values change: each becomes a filled field,
              which is what says "you can type here now". Nothing moves, so
              it's obvious you're looking at the same page you just read. */}
          <InfoSection icon={UserRound} title={t(language, "settings.personalInfo")}>
            <EditRow
              label={t(language, "settings.dob")}
              hint={!dobDraft.trim() && (
                <MeiSuggestButton
                  fieldLabel={t(language, "settings.dob")}
                  formatHint="Reply in YYYY-MM-DD format only."
                  validate={v => /^\d{4}-\d{2}-\d{2}$/.test(v)}
                  onAccept={setDobDraft}
                />
              )}
            >
              <input type="date" value={dobDraft} onChange={e => setDobDraft(e.target.value)} max={new Date().toISOString().slice(0, 10)} className={`${editFieldCls} w-[160px]`} />
            </EditRow>
            <EditRow
              label={t(language, "settings.gender")}
              hint={!genderDraft.trim() && (
                <MeiSuggestButton
                  fieldLabel={t(language, "settings.gender")}
                  onAccept={v => setGenderDraft(/^f/i.test(v) ? "Female" : /^m/i.test(v) ? "Male" : v)}
                />
              )}
            >
              <GenderPicker value={genderDraft} onChange={setGenderDraft} size="inline" />
            </EditRow>
            <EditRow
              label={t(language, "settings.weightKg")}
              hint={!weightDraft.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.weightKg")} onAccept={v => setWeightDraft(v.match(/\d+(\.\d+)?/)?.[0] ?? v)} />}
            >
              <input type="number" inputMode="decimal" data-walk="elder-profile-weight" value={weightDraft} onChange={e => setWeightDraft(e.target.value)} placeholder="60" className={`${editFieldCls} w-[88px]`} />
            </EditRow>
            <EditRow
              label={t(language, "settings.heightCm")}
              hint={!heightDraft.trim() && <MeiSuggestButton fieldLabel={t(language, "settings.heightCm")} onAccept={v => setHeightDraft(v.match(/\d+(\.\d+)?/)?.[0] ?? v)} />}
            >
              <input type="number" inputMode="decimal" value={heightDraft} onChange={e => setHeightDraft(e.target.value)} placeholder="160" className={`${editFieldCls} w-[88px]`} />
            </EditRow>
          </InfoSection>

          <InfoSection icon={HeartPulse} title={t(language, "settings.medicalInfo")}>
            {/* These three carry their own labels and chips, so they stay
                full-width blocks rather than a label/value row. */}
            <div className="py-3 space-y-4">
              <TagList data-walk="elder-conditions" label={t(language, "settings.medicalConditions")} placeholder={t(language, "wizard.conditionsPlaceholder")} items={conditionsDraft} suggestions={withCatalogLabels(COMMON_CONDITIONS, language)} onAdd={v => setConditionsDraft(p => [...p, v])} onRemove={i => setConditionsDraft(p => p.filter((_, j) => j !== i))} />
              <TagList label={t(language, "settings.generalAllergies")} placeholder={t(language, "wizard.allergiesPlaceholder")} items={allergiesDraft} suggestions={withCatalogLabels(COMMON_ALLERGIES, language)} onAdd={v => setAllergiesDraft(p => [...p, v])} onRemove={i => setAllergiesDraft(p => p.filter((_, j) => j !== i))} />
              <TagList label={t(language, "settings.medicationAllergies")} placeholder={t(language, "wizard.drugAllergiesPlaceholder")} items={drugAllergiesDraft} suggestions={withCatalogLabels(COMMON_DRUG_ALLERGIES, language)} onAdd={v => setDrugAllergiesDraft(p => [...p, v])} onRemove={i => setDrugAllergiesDraft(p => p.filter((_, j) => j !== i))} />
            </div>
          </InfoSection>

          <InfoSection icon={Utensils} title={t(language, "settings.mealsSleep")}>
            <div className="py-3 space-y-3">
              <TimeField label={t(language, "wizard.wakeUpTime")} icon={<Sunrise size={17} className="text-primary" />} value={wakeDraft} onChange={setWakeDraft} />
              <TimeField label={t(language, "wizard.breakfast")} icon={<Coffee size={17} className="text-primary" />} value={breakfastDraft} onChange={setBreakfastDraft} />
              <TimeField label={t(language, "wizard.lunch")} icon={<Utensils size={17} className="text-primary" />} value={lunchDraft} onChange={setLunchDraft} />
              <TimeField label={t(language, "wizard.dinner")} icon={<UtensilsCrossed size={17} className="text-primary" />} value={dinnerDraft} onChange={setDinnerDraft} />
              <TimeField label={t(language, "wizard.bedtime")} icon={<Moon size={17} className="text-primary" />} value={sleepDraft} onChange={setSleepDraft} />
            </div>
          </InfoSection>

          {/* Stays in edit mode after saving: the "Saved!" state and the
              walkthrough's reveal both point AT the field that just changed,
              and dropping back to the read view deletes it out from under them
              (reveal-caption.spec.ts catches exactly this). */}
          <button
            data-walk="elder-profile-save"
            onClick={saveProfileDraft}
            disabled={profileSaving || !elderId}
            className="w-full h-13 py-3.5 rounded-2xl bg-primary text-primary-foreground text-[calc(16px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            {profileSaving ? <Loader2 size={19} className="animate-spin" /> : profileSaved ? <Check size={19} /> : null}
            {profileSaving ? t(language, "settings.saving") : profileSaved ? t(language, "settings.saved") : t(language, "settings.saveChanges")}
          </button>
        </SubScreen>
      );
  }

  // --- hub -------------------------------------------------------------------
  return (
    <div className="flex-1 overflow-y-auto scrollbar-none">
      <div className="px-4 pt-3 pb-28 space-y-3">
        {/* Search first, above everything: with every setting now on this one
            page, typing is the shortest route to any of them. */}
        <div className="relative">
          <Search size={20} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t(language, "settings.searchPlaceholder")}
            data-walk="elder-settings-search"
            className="w-full h-13 bg-input-background border border-border rounded-2xl pl-11 pr-11 text-[calc(15px*var(--dw-text,1))] text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label={t(language, "common.cancel")} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
              <X size={16} className="text-muted-foreground" />
            </button>
          )}
        </div>

        {query.trim() ? (
          <div className="dw-surface divide-y divide-border overflow-hidden">
            {matches.map(m => (
              <button
                key={`${m.section}-${m.label}`}
                onClick={() => goToSetting(m.section)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[calc(15px*var(--dw-text,1))] font-semibold text-foreground leading-snug">{m.label}</p>
                  <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground">{SECTION_TITLES[m.section]}</p>
                </div>
                <ChevronRight size={20} className="text-muted-foreground shrink-0" />
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-4 py-6 text-[calc(14px*var(--dw-text,1))] text-muted-foreground text-center">{t(language, "settings.noResults", { q: query.trim() })}</p>
            )}
          </div>
        ) : (
          <>
            {/* Profile card, with the edit button on the card itself rather than
                as a separate row further down the page. */}
            {/* The whole card opens the profile — an arrow says so, which is one
                less thing to read than a button repeating it. */}
            <button
              data-tour="elder-profile-section"
              data-settings="profile"
              data-walk="elder-profile-toggle"
              onClick={() => openProfile()}
              className="dw-surface dw-press w-full p-4 text-left scroll-mt-3 active:bg-secondary/50 transition-colors"
            >
              <div className="flex items-center gap-3.5">
                <ProfileAvatar photo={patient.photo} size={60} className="rounded-full border-2 border-primary/20 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="dw-display font-semibold text-foreground text-[calc(22px*var(--dw-text,1))] leading-tight break-words">{patient.nickname}</p>
                  <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground break-words">{patient.name} · {patient.age}</p>
                </div>
                <ChevronRight size={22} className="text-muted-foreground shrink-0" />
              </div>
              {(patient.conditions.length > 0 || allergyEntries.length > 0) && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {patient.conditions.map(c => <span key={c} className="text-[calc(14px*var(--dw-text,1))] font-semibold bg-secondary text-secondary-foreground rounded-full px-3 py-1">{loc(c)}</span>)}
                  {/* Saved allergies (both legacy strings and promoted
                      {name, severity} objects — lib/changeHighlight.ts's
                      normalizeAllergies). Always visible so a
                      set_allergy_severity highlight can land on
                      data-testid="allergy-{slug}" without the profile
                      sub-screen being open. */}
                  {allergyEntries.map(a => (
                    <span
                      key={a.name}
                      data-testid={`allergy-${slugify(a.name)}`}
                      className="inline-flex items-center gap-1.5 text-[calc(14px*var(--dw-text,1))] font-semibold bg-card text-destructive border border-destructive/30 rounded-full px-3 py-1"
                    >
                      {/* loc(), same as the conditions row above — these
                          pills were the one place on this card still rendering
                          the raw stored English. data-testid deliberately
                          stays keyed on the CANONICAL a.name so the
                          set_allergy_severity highlight can still find it. */}
                      {loc(a.name)}
                      {a.severity && (
                        <em className="not-italic text-[calc(12px*var(--dw-text,1))] font-bold uppercase tracking-wide bg-destructive text-destructive-foreground rounded-full px-1.5 py-0.5">{localizeSeverity(language, a.severity)}</em>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </button>

            {/* Symptoms noted — read-only journal written by Mei's add_symptom
                tool (accessibility.symptom_reports), newest first; hidden when
                empty so it never shows an empty card. */}
            {/* Not a SectionCard: those stamp data-settings={anchor}, and the
                only fitting anchor ("profile") is already claimed by the card
                above — a duplicate would break the search jump. */}
            {symptomReports.length > 0 && (
              <div className="dw-surface overflow-hidden">
                <div className="px-4 py-3.5">
                  <h2 className="text-[calc(17px*var(--dw-text,1))] font-bold text-foreground leading-tight">{t(language, "settings.symptomsNoted")}</h2>
                </div>
                <div className="divide-y divide-border border-t border-border">
                  {symptomReports.map(r => (
                    <div key={r.id} data-testid={`symptom-${r.id}`} className="px-4 py-3.5">
                      <p className="text-[calc(15px*var(--dw-text,1))] text-foreground leading-snug break-words">{r.symptom}</p>
                      <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground mt-0.5">
                        {r.medication_name ? `${r.medication_name} · ` : ""}
                        {Number.isNaN(new Date(r.noted_at).getTime())
                          ? ""
                          : new Date(r.noted_at).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div data-settings="caregiver" className="scroll-mt-3">{qrCard}</div>

            {/* Every section in full, in place. Nothing is behind another tap. */}
            <SectionCard icon={Type} title={SECTION_TITLES.accessibility} anchor="accessibility">
              {textSizeControl}
              {contrastControl}
              {colourVisionControl}
              {timeFormatControl}
            </SectionCard>

            <SectionCard icon={Bell} title={SECTION_TITLES.reminders} anchor="reminders">
              {notifOptions.map(o => (
                <SettingRow key={o.key} label={o.label}>
                  <Toggle
                    on={notifications[o.key]}
                    onToggle={() => setNotification(o.key, !notifications[o.key])}
                    data-walk={o.key === "doseReminders" ? "elder-reminder-meds" : undefined}
                  />
                </SettingRow>
              ))}
              <p className="px-4 py-3.5 text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-relaxed">{t(language, "settings.medicationRemindersDesc")}</p>
            </SectionCard>

            <div data-tour="elder-language">
              <SectionCard icon={Globe} title={SECTION_TITLES.voice} anchor="voice">
                {readAloudControl}
                {walkthroughManualControl}
                {languageControl}
              </SectionCard>
            </div>

            <SectionCard icon={Phone} title={SECTION_TITLES.emergency} anchor="emergency" walk="elder-emergency-section">
              {emergencyCard ?? <p className="px-4 py-5 text-[calc(14px*var(--dw-text,1))] text-muted-foreground text-center">{t(language, "settings.emergencyNone")}</p>}
            </SectionCard>

            {/* What the app is, rather than anything about this person's care —
                still its own screen. Signing out is NOT filed under it: it's the
                one action people come to Settings looking for. */}
            <button
              onClick={() => setSubScreen("about")}
              data-walk="elder-settings-about"
              className="dw-surface dw-press w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                <Info size={20} className="text-primary" />
              </div>
              <span className="flex-1 min-w-0 text-[calc(17px*var(--dw-text,1))] font-bold text-foreground leading-tight">{SECTION_TITLES.about}</span>
              <ChevronRight size={20} className="text-muted-foreground shrink-0" />
            </button>

            <button
              onClick={onSignOut}
              data-walk="elder-sign-out"
              className="w-full h-13 py-3.5 rounded-2xl border-2 border-destructive/40 text-destructive text-[calc(15px*var(--dw-text,1))] font-bold flex items-center justify-center gap-2 active:bg-destructive/10 transition-colors"
            >
              <LogOut size={18} />{t(language, "settings.signOut")}
            </button>
          </>
        )}
      </div>

      {showCallPrimary && primary && (
        <CallMockup
          name={primaryName}
          role={primary.relationship ?? t(language, "link.reqDefaultRelation")}
          onEnd={() => setShowCallPrimary(false)}
        />
      )}
    </div>
  );
}

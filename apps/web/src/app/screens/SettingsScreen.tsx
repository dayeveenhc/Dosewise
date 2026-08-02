import { useState } from "react";
import { Lock, Shield, Edit3, RefreshCw, Plus, CheckCircle2, LogOut, Phone, Star, User } from "lucide-react";
import { Card, SectionHeader, ProfileAvatar } from "../components/shared";
import { Switch } from "../components/ui/switch";
import { ChoiceRow } from "./elderly/ElderlySettingsScreen";
import { useLanguage } from "../lib/languageContext";
import { LANGUAGE_OPTIONS, t } from "../lib/language";
import { useAccessibility } from "../accessibility.tsx";
import type { FontSize, ContrastMode } from "../accessibility.tsx";
import type { Patient, Contact } from "../types";
import { CallMockup } from "../components/CallMockup";

const FONT_SIZES: FontSize[] = ["small", "normal", "large", "xlarge", "xxlarge"];

interface CareTeamMember { name: string; role: string; initials: string; active: boolean }
const CARE_TEAM_SEED: CareTeamMember[] = [
  { name: "Tan Shu Fen", role: "Daughter · View only", initials: "SF", active: true },
  { name: "Siti Nuraini", role: "Helper · Log doses only", initials: "SN", active: true },
  { name: "Dr Priya Nair", role: "GP · Medical records", initials: "PN", active: false },
];

interface CaregiverAccount { name: string | null; email: string | null }

export function SettingsScreen({ patient, caregiverAccount, onSwitchMode, onSignOut, onEditProfile, onEditAccount }: {
  patient: Patient;
  caregiverAccount: CaregiverAccount;
  onSwitchMode: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
  onEditAccount: () => void;
}) {
  const { language, setLanguage } = useLanguage();
  const { fontSize, setFontSize, contrast, setContrast, voiceOutput, setVoiceOutput } = useAccessibility();
  const contrastOptions: { id: ContrastMode; label: string }[] = [
    { id: "normal", label: t(language, "settings.contrastNormal") },
    { id: "high", label: t(language, "settings.contrastHigh") },
    { id: "max", label: t(language, "settings.contrastMax") },
  ];
  const [callTarget, setCallTarget] = useState<Contact | null>(null);
  const [notifMissed, setNotifMissed] = useState(true);
  const [notifRefill, setNotifRefill] = useState(true);
  const [notifSummary, setNotifSummary] = useState(true);
  const [notifRefillDays, setNotifRefillDays] = useState("7");
  const [careTeam, setCareTeam] = useState<CareTeamMember[]>(CARE_TEAM_SEED);
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("");

  const caregiverInitials = caregiverAccount.name
    ? caregiverAccount.name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase()
    : (caregiverAccount.email ?? "?").slice(0, 2).toUpperCase();

  const addCareTeamMember = () => {
    if (!newMemberName.trim()) return;
    const initials = newMemberName.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
    setCareTeam(prev => [...prev, { name: newMemberName.trim(), role: newMemberRole.trim() || "Care team", initials, active: true }]);
    setNewMemberName(""); setNewMemberRole(""); setShowAddMember(false);
  };

  return (
    <div className="px-4 py-5 space-y-5">
      {/* Account — the signed-in caregiver's own identity, never the elder's */}
      <div>
        <SectionHeader title={t(language, "settings.account")} />
        <Card>
          <div className="flex items-center gap-3 px-4 py-4">
            <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-lg shrink-0">{caregiverInitials}</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">{caregiverAccount.name || caregiverAccount.email || "—"}</p>
              {caregiverAccount.name && caregiverAccount.email && (
                <p className="text-xs text-muted-foreground truncate">{caregiverAccount.email}</p>
              )}
            </div>
            <button
              onClick={onEditAccount}
              aria-label={t(language, "settings.editAccount")}
              className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 active:bg-primary/20 transition-colors"
            >
              <Edit3 size={15} className="text-primary" />
            </button>
          </div>
        </Card>
      </div>

      {/* Care recipient — kept visually separate from Account above so it's
          unambiguous that this edits the elder's profile, not the caregiver's own */}
      <div>
        <SectionHeader title={t(language, "settings.careRecipient")} />
        <Card>
          <div className="flex items-center gap-3 px-4 py-4">
            <ProfileAvatar photo={patient.photo} size={48} className="rounded-2xl shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">{patient.nickname}</p>
              <p className="text-xs text-muted-foreground truncate">{patient.relation}</p>
            </div>
            <button
              onClick={onEditProfile}
              aria-label={t(language, "settings.editCareRecipientProfile", { name: patient.nickname })}
              className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 active:bg-primary/20 transition-colors"
            >
              <Edit3 size={15} className="text-primary" />
            </button>
          </div>
        </Card>
      </div>

      {/* Emergency contacts */}
      <div data-tour="cg-emergency">
        <SectionHeader title={t(language, "common.emergencyContacts")} />
        <Card className="divide-y divide-border">
          {patient.contacts.map((c, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${c.isPrimary ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {c.isPrimary ? <Star size={13} /> : <User size={13} className="text-muted-foreground" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{c.name}</p>
                <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground">{c.role}</p>
              </div>
              <button onClick={() => setCallTarget(c)} className="w-8 h-8 bg-taken-bg border border-taken-border rounded-full flex items-center justify-center active:scale-95 transition-transform">
                <Phone size={13} className="text-taken-fg" />
              </button>
            </div>
          ))}
        </Card>
      </div>

      {/* Accessibility */}
      <div>
        <SectionHeader title={t(language, "settings.accessibility")} />
        <Card className="divide-y divide-border">
          <div className="px-4 py-4">
            <p className="text-sm font-medium text-foreground mb-3">{t(language, "settings.textSize")}</p>
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
          <div className="px-4 py-4">
            <p className="text-sm font-medium text-foreground mb-3">{t(language, "settings.contrast")}</p>
            <ChoiceRow value={contrast} options={contrastOptions} onChange={setContrast} />
          </div>
        </Card>
      </div>

      {/* Language */}
      <div>
        <SectionHeader title={t(language, "settings.voiceAndLanguage")} />
        <Card className="divide-y divide-border">
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">{t(language, "settings.language")}</p>
            <select value={language} onChange={e => setLanguage(e.target.value as any)} className="bg-muted rounded-xl px-3 py-2 text-sm font-medium text-foreground outline-none">
              {LANGUAGE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">{t(language, "settings.readAloud")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.readAloudDesc")}</p>
            </div>
            <Switch checked={voiceOutput} onCheckedChange={setVoiceOutput} />
          </div>
        </Card>
      </div>

      {/* Notifications */}
      <div data-tour="cg-settings">
        <SectionHeader title={t(language, "nav.notifications")} />
        <Card className="divide-y divide-border">
          {[
            { label: t(language, "settings.missedDoseAlerts"), sub: t(language, "settings.missedDoseAlertsDesc"), val: notifMissed, set: setNotifMissed },
            { label: t(language, "settings.refillReminders"), sub: t(language, "settings.refillRemindersDesc", { days: notifRefillDays }), val: notifRefill, set: setNotifRefill },
            { label: t(language, "settings.weeklyAiSummary"), sub: t(language, "settings.weeklyAiSummaryDesc"), val: notifSummary, set: setNotifSummary },
          ].map(({ label, sub, val, set }) => (
            <div key={label} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground">{sub}</p>
              </div>
              <Switch checked={val} onCheckedChange={set} />
            </div>
          ))}
        </Card>
        <div className="mt-2 bg-card border border-border rounded-2xl px-4 py-3">
          <p className="text-xs font-medium text-foreground mb-2">{t(language, "settings.alertWhenBelow")}</p>
          <div className="flex gap-2">
            {["3", "5", "7", "10"].map(d => (
              <button
                key={d}
                onClick={() => setNotifRefillDays(d)}
                className={`flex-1 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${notifRefillDays === d ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border"}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Caregiver team */}
      <div>
        <SectionHeader title={t(language, "settings.careTeamAccess")} />
        <Card className="divide-y divide-border">
          {careTeam.map(m => (
            <div key={m.name} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-[calc(11px*var(--dw-text,1))] font-bold text-primary shrink-0">{m.initials}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.role}</p>
              </div>
              <div className={`w-2.5 h-2.5 rounded-full ${m.active ? "bg-taken" : "bg-muted-foreground/30"}`} />
            </div>
          ))}
          {showAddMember ? (
            <div className="px-4 py-3 space-y-2">
              <input
                value={newMemberName}
                onChange={e => setNewMemberName(e.target.value)}
                placeholder={t(language, "common.fullName")}
                className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
              <input
                value={newMemberRole}
                onChange={e => setNewMemberRole(e.target.value)}
                placeholder={t(language, "common.roleExample")}
                className="w-full bg-input-background border border-border rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
              <div className="flex gap-2">
                <button onClick={addCareTeamMember} disabled={!newMemberName.trim()} className="flex-1 bg-primary text-primary-foreground rounded-xl py-2 text-xs font-semibold disabled:opacity-40">
                  {t(language, "common.add")}
                </button>
                <button onClick={() => { setShowAddMember(false); setNewMemberName(""); setNewMemberRole(""); }} className="px-4 rounded-xl border border-border text-xs font-semibold text-muted-foreground">
                  {t(language, "common.dismiss")}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAddMember(true)} className="flex items-center gap-3 px-4 py-3 w-full">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Plus size={14} className="text-muted-foreground" />
              </div>
              <span className="text-sm text-muted-foreground font-medium">{t(language, "settings.addCareTeamMember")}</span>
            </button>
          )}
        </Card>
      </div>

      {/* Privacy */}
      <div>
        <SectionHeader title={t(language, "settings.privacySecurity")} />
        <Card className="divide-y divide-border">
          {[
            { icon: <Lock size={15} />, label: t(language, "settings.dataEncryption"), sub: t(language, "settings.dataEncryptionDesc") },
            { icon: <Shield size={15} />, label: t(language, "settings.pdpaCompliance"), sub: t(language, "settings.pdpaComplianceDesc") },
            { icon: <Edit3 size={15} />, label: t(language, "settings.auditLog"), sub: t(language, "settings.auditLogDesc") },
          ].map(({ icon, label, sub }) => (
            <div key={label} className="flex items-center gap-3 px-4 py-3">
              <div className="w-7 h-7 bg-secondary rounded-xl flex items-center justify-center text-primary shrink-0">{icon}</div>
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-taken-fg font-medium">{sub}</p>
              </div>
              <CheckCircle2 size={15} className="ml-auto text-taken" />
            </div>
          ))}
        </Card>
      </div>

      <button onClick={onSwitchMode} data-walk="cg-switch-mode" className="w-full h-12 rounded-2xl border border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
        <RefreshCw size={14} />{t(language, "settings.switchToElderly")}
      </button>

      <button onClick={onSignOut} className="w-full h-12 rounded-2xl border border-destructive/30 text-destructive text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
        <LogOut size={14} />{t(language, "settings.signOut")}
      </button>

      <p className="text-center text-[calc(11px*var(--dw-text,1))] text-muted-foreground pb-4">DOSEWISE v1.0 · {t(language, "settings.footer")}</p>

      {callTarget && <CallMockup name={callTarget.name} role={callTarget.role} onEnd={() => setCallTarget(null)} />}
    </div>
  );
}

import { useState } from "react";
import { ChevronRight, Lock, Shield, Edit3, RefreshCw, Plus, CheckCircle2, LogOut } from "lucide-react";
import { Card, SectionHeader } from "../components/shared";
import { Switch } from "../components/ui/switch";
import { useLanguage } from "../lib/languageContext";
import { LANGUAGE_OPTIONS, t } from "../lib/language";

export function SettingsScreen({ onSwitchMode, onSignOut, onEditProfile }: { onSwitchMode: () => void; onSignOut: () => void; onEditProfile: () => void }) {
  const { language, setLanguage } = useLanguage();
  const [notifMissed, setNotifMissed] = useState(true);
  const [notifRefill, setNotifRefill] = useState(true);
  const [notifSummary, setNotifSummary] = useState(true);
  const [notifRefillDays, setNotifRefillDays] = useState("7");

  return (
    <div className="px-4 py-5 space-y-5">
      {/* Account */}
      <div>
        <SectionHeader title="Account" />
        <Card>
          <div className="flex items-center gap-3 px-4 py-4 border-b border-border">
            <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-lg shrink-0">TW</div>
            <div>
              <p className="text-sm font-semibold text-foreground">Tan Wei Ming</p>
              <p className="text-xs text-muted-foreground">Primary Caregiver · wm.tan@gmail.com</p>
            </div>
          </div>
          <button onClick={onEditProfile} className="w-full flex items-center justify-between px-4 py-3 text-sm text-foreground font-medium">
            Edit profile <ChevronRight size={14} className="text-muted-foreground" />
          </button>
        </Card>
      </div>

      {/* Language */}
      <div>
        <SectionHeader title={t(language, "settings.voiceAndLanguage")} />
        <Card className="px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t(language, "settings.language")}</p>
              <p className="text-xs text-muted-foreground">{t(language, "settings.languageDesc")}</p>
            </div>
            <select value={language} onChange={e => setLanguage(e.target.value as any)} className="bg-muted rounded-xl px-3 py-2 text-sm font-medium text-foreground outline-none">
              {LANGUAGE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
        </Card>
      </div>

      {/* Notifications */}
      <div data-tour="cg-settings">
        <SectionHeader title="Notifications" />
        <Card className="divide-y divide-border">
          {[
            { label: "Missed dose alerts", sub: "Immediate push notification", val: notifMissed, set: setNotifMissed },
            { label: "Refill reminders", sub: `Alert when supply drops below ${notifRefillDays} days`, val: notifRefill, set: setNotifRefill },
            { label: "Weekly AI summary", sub: "Every Monday morning", val: notifSummary, set: setNotifSummary },
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
          <p className="text-xs font-medium text-foreground mb-2">Alert when below</p>
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
        <SectionHeader title="Care Team Access" />
        <Card className="divide-y divide-border">
          {[
            { name: "Tan Shu Fen", role: "Daughter · View only", initials: "SF", active: true },
            { name: "Siti Nuraini", role: "Helper · Log doses only", initials: "SN", active: true },
            { name: "Dr Priya Nair", role: "GP · Medical records", initials: "PN", active: false },
          ].map(m => (
            <div key={m.name} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-[11px] font-bold text-primary shrink-0">{m.initials}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.role}</p>
              </div>
              <div className={`w-2 h-2 rounded-full ${m.active ? "bg-emerald-500" : "bg-stone-300"}`} />
            </div>
          ))}
          <button className="flex items-center gap-3 px-4 py-3 w-full">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Plus size={14} className="text-muted-foreground" />
            </div>
            <span className="text-sm text-muted-foreground font-medium">Add care team member</span>
          </button>
        </Card>
      </div>

      {/* Privacy */}
      <div>
        <SectionHeader title="Privacy & Security" />
        <Card className="divide-y divide-border">
          {[
            { icon: <Lock size={15} />, label: "Data encryption", sub: "End-to-end encrypted" },
            { icon: <Shield size={15} />, label: "PDPA compliance", sub: "Singapore PDPA 2012" },
            { icon: <Edit3 size={15} />, label: "Audit log", sub: "All access events recorded" },
          ].map(({ icon, label, sub }) => (
            <div key={label} className="flex items-center gap-3 px-4 py-3">
              <div className="w-7 h-7 bg-secondary rounded-xl flex items-center justify-center text-primary shrink-0">{icon}</div>
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-emerald-700 font-medium">{sub}</p>
              </div>
              <CheckCircle2 size={15} className="ml-auto text-emerald-600" />
            </div>
          ))}
        </Card>
      </div>

      <button onClick={onSwitchMode} className="w-full h-12 rounded-2xl border border-border text-muted-foreground text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
        <RefreshCw size={14} />Switch to Elderly Mode
      </button>

      <button onClick={onSignOut} className="w-full h-12 rounded-2xl border border-destructive/30 text-destructive text-sm font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
        <LogOut size={14} />Sign out
      </button>

      <p className="text-center text-[11px] text-muted-foreground pb-4">DOSEWISE v1.0 · Made with care in Singapore</p>
    </div>
  );
}

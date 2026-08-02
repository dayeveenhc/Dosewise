import { useState, useEffect } from "react";
import { X, Plane, Globe, Package, Check, Loader2 } from "lucide-react";
import type { Patient } from "../types";
import { fetchProfile, saveProfile } from "../lib/profile";
import { fieldCls } from "./setup/GuidedSetupWizard";
import { Toggle } from "./elderly/ElderlySettingsScreen";
import { BottomSheet } from "../components/BottomSheet";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { emitWalkthroughEvent } from "../lib/walkthrough/bus";

const TIMEZONES = [
  "Singapore (UTC+8)", "Malaysia (UTC+8)", "Thailand (UTC+7)", "Indonesia — Jakarta (UTC+7)",
  "Japan (UTC+9)", "South Korea (UTC+9)", "China (UTC+8)", "Hong Kong (UTC+8)",
  "Taiwan (UTC+8)", "Vietnam (UTC+7)", "Philippines (UTC+8)",
  "Australia — Sydney (UTC+11)", "India (UTC+5:30)", "United Kingdom (UTC+0)",
  "USA — New York (UTC-5)", "USA — Los Angeles (UTC-8)", "UAE — Dubai (UTC+4)",
];

interface TravelPlan { startDate: string; endDate: string; timezone: string }

export function TravelModeSheet({ patient, elderId, onClose, onSaved }: {
  patient: Patient; elderId?: string; onClose: () => void; onSaved?: (plan: TravelPlan | undefined) => void;
}) {
  const { language } = useLanguage();
  const [enabled, setEnabled] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [timezone, setTimezone] = useState(TIMEZONES[0]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hadSavedPlan, setHadSavedPlan] = useState(false);

  useEffect(() => {
    if (!elderId) return;
    fetchProfile(elderId).then(profile => {
      const plan = profile?.details.travelPlan;
      if (plan) {
        setStartDate(plan.startDate); setEndDate(plan.endDate); setTimezone(plan.timezone);
        setEnabled(new Date(`${plan.endDate}T23:59:59`) >= new Date());
        setHadSavedPlan(true);
      }
    });
  }, [elderId]);

  const days = startDate && endDate
    ? Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000) + 1)
    : 0;

  // patient.medications has one entry per (medication, time-slot) — dedupe by
  // name for the packing list, then count slots to get doses/day.
  const activeMeds = patient.medications.filter((m, i, arr) => arr.findIndex(x => x.name === m.name) === i);
  const packingList = days > 0 ? activeMeds.map(m => ({
    name: m.name,
    dose: m.dose,
    qty: patient.medications.filter(x => x.name === m.name).length * days,
  })) : [];

  const handleSave = async () => {
    if (!elderId) { onClose(); return; }
    setSaving(true);
    // saveProfile overwrites the whole details blob, so merge with whatever's
    // already there instead of wiping out age/allergies/etc.
    const existing = await fetchProfile(elderId);
    const travelPlan: TravelPlan | undefined = enabled ? { startDate, endDate, timezone } : undefined;
    await saveProfile(elderId, "elder", patient.name, {
      ...(existing?.details ?? {}),
      travelPlan,
    });
    setSaving(false);
    setSaved(true);
    setHadSavedPlan(enabled);
    onSaved?.(travelPlan);
    // Gate the travel_mode_setup walkthrough's save step on this real, resolved
    // write — never on the button's click, which fires before the await settles.
    emitWalkthroughEvent("travel-plan-saved");
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <BottomSheet onClose={onClose} layout="bare">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex items-center justify-between px-5 pb-3 pt-1 border-b border-border shrink-0">
          <div>
            <h2 className="font-['Fraunces'] text-lg font-semibold text-foreground flex items-center gap-2">
              <Plane size={17} className="text-primary" />{t(language, "common.travelMode")}
            </h2>
            <p className="text-xs text-muted-foreground">{t(language, "travel.subtitle")}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <X size={14} className="text-foreground" />
          </button>
        </div>

        <div className="overflow-y-auto scrollbar-none px-5 py-4 space-y-4">
          <div className="flex items-center justify-between bg-muted/40 rounded-xl px-3.5 py-3" data-walk="travel-enable-toggle">
            <div>
              <p className="text-sm font-semibold text-foreground">{t(language, "common.travelMode")}</p>
              <p className="text-xs text-muted-foreground">{enabled ? t(language, "travel.onLabel") : t(language, "travel.offLabel")}</p>
            </div>
            <Toggle on={enabled} onToggle={() => setEnabled(v => !v)} />
          </div>

          {enabled && (
            <>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "travel.from")}</label>
                  <input type="date" data-walk="travel-start-date" value={startDate} onChange={e => setStartDate(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1.5">{t(language, "travel.to")}</label>
                  <input type="date" data-walk="travel-end-date" value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} className={fieldCls} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
                  <Globe size={13} />{t(language, "travel.destinationTimezone")}
                </label>
                <select data-walk="travel-timezone-select" value={timezone} onChange={e => setTimezone(e.target.value)} className={fieldCls}>
                  {TIMEZONES.map(tz => <option key={tz}>{tz}</option>)}
                </select>
                <p className="text-[calc(11px*var(--dw-text,1))] text-muted-foreground mt-1.5">{t(language, "travel.timezoneNote")}</p>
              </div>

              {days > 0 && (
                <div>
                  <p className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
                    <Package size={14} className="text-primary" />{t(language, "travel.packingList", { days, unit: days > 1 ? t(language, "travel.days") : t(language, "travel.day") })}
                  </p>
                  {packingList.length > 0 ? (
                    <div className="bg-muted/40 rounded-xl divide-y divide-border/60">
                      {packingList.map(m => (
                        <div key={m.name} className="flex items-center justify-between px-3.5 py-2.5">
                          <p className="text-sm font-medium text-foreground">{m.name} <span className="text-xs text-muted-foreground font-normal">{m.dose}</span></p>
                          <span className="text-xs font-bold text-primary bg-primary/10 rounded-full px-2.5 py-1 whitespace-nowrap">{t(language, "travel.dosesCount", { qty: m.qty })}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t(language, "travel.noActiveMeds")}</p>
                  )}
                  <div className="bg-secondary/60 rounded-xl px-3.5 py-3 mt-2">
                    <p className="text-xs font-semibold text-foreground mb-1">{t(language, "travel.alsoBring")}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{t(language, "travel.alsoBringItems")}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            data-walk="travel-save-button"
            onClick={!enabled && !hadSavedPlan ? onClose : handleSave}
            disabled={saving || (enabled && (!startDate || !endDate))}
            className="w-full h-12 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={16} /> : null}
            {saving ? t(language, "settings.saving") : saved ? t(language, "settings.saved") : enabled ? t(language, "travel.saveTravelPlan") : hadSavedPlan ? t(language, "travel.turnOff") : t(language, "link.close")}
          </button>
        </div>
    </BottomSheet>
  );
}

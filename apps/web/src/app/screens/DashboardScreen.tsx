import {
  ClipboardList, CheckCircle2, AlertTriangle, Circle, Send, RefreshCw,
  Clock, MessageSquare,
} from "lucide-react";
import type { Patient, Screen } from "../types";
import { Card, SectionHeader, QuickAction } from "../components/shared";
import { PillIcon, shapeFor } from "../components/PillIcon";
import { MED_SHAPES } from "../data/medications";
import { isDueOn } from "../lib/medications";
import { useAccessibility } from "../accessibility.tsx";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

export function DashboardScreen({ patient, onNavigate, onSendReminder }: { patient: Patient; onNavigate: (s: Screen) => void; onSendReminder: (medName?: string) => void }) {
  const { language } = useLanguage();
  const { colourBlind } = useAccessibility();
  // "Today" means the doses actually due today — a medicine on a weekly or
  // every-other-day cadence must not inflate the count on a day it isn't taken.
  // Refill alerts deliberately stay across ALL medications: supply runs low
  // whether or not today happens to be a dose day.
  const dueToday = patient.medications.filter(m => isDueOn(m, new Date()));
  const taken = dueToday.filter(m => m.status === "taken").length;
  const missed = dueToday.filter(m => m.status === "missed").length;
  const upcoming = dueToday.filter(m => m.status === "upcoming").length;
  const total = dueToday.length;
  const refillAlerts = patient.medications.filter(m => m.refillDaysLeft && m.refillDaysLeft <= 7);

  return (
    <div className="px-4 py-5 space-y-3">
      {/* Adherence overview */}
      <Card className="p-3.5" data-tour="cg-dashboard">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground uppercase tracking-widest font-medium mb-0.5">{t(language, "home.today")} {t(language, "nav.medications")}</p>
          <button
            onClick={() => onNavigate("timeline")}
            className="shrink-0 flex items-center gap-1 text-xs font-semibold text-primary bg-secondary rounded-full px-3 py-1.5 active:opacity-80 transition-opacity whitespace-nowrap -mt-1"
          >
            <ClipboardList size={12} />
            {t(language, "common.viewSchedule")}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-1">
          {dueToday.map(m => (
            <div key={m.id} title={`${m.name} · ${m.time}${m.status === "taken" ? ` · ${t(language, "common.taken")}` : ""}`}>
              <PillIcon shape={shapeFor(m.name, MED_SHAPES[m.name]?.shape)} colour={m.colour} filled={m.status === "taken"} />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">{t(language, "dashboard.dosesTaken", { taken, total })}</p>
        {colourBlind && (
          <div className="flex flex-col gap-0.5 mt-1">
            {[...new Set(dueToday.map(m => m.name))].filter(n => MED_SHAPES[n]).map(n => (
              <p key={n} className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground/70">{n}: {MED_SHAPES[n].shape}</p>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-2">
          <span className="inline-flex items-center gap-1 text-[calc(10px*var(--dw-text,1))] font-medium text-taken-fg bg-taken-bg border border-taken-border rounded-full px-2 py-0.5 whitespace-nowrap">
            <CheckCircle2 size={10} /> {taken} {t(language, "common.taken")}
          </span>
          {missed > 0 && (
            <span className="inline-flex items-center gap-1 text-[calc(10px*var(--dw-text,1))] font-medium text-missed-fg bg-missed-bg border border-missed-border rounded-full px-2 py-0.5 whitespace-nowrap">
              <AlertTriangle size={10} /> {missed} {t(language, "common.missed")}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[calc(10px*var(--dw-text,1))] font-medium text-upcoming-fg bg-upcoming-bg border border-upcoming-border rounded-full px-2 py-0.5 whitespace-nowrap">
            <Circle size={10} /> {upcoming} {t(language, "common.upcoming")}
          </span>
        </div>
      </Card>

      {/* Missed medications alert */}
      {missed > 0 && (
        <div className="bg-missed-bg border border-missed-border rounded-2xl p-3.5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-missed-fg shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-missed-fg">{t(language, "dashboard.missedDoseAlert")}</p>
              {dueToday.filter(m => m.status === "missed").map(m => (
                <p key={m.id} className="text-xs text-missed-fg mt-0.5">{t(language, "dashboard.wasDueAt", { name: m.name, dose: m.dose, time: m.time })}</p>
              ))}
            </div>
            <button onClick={() => onSendReminder(dueToday.find(m => m.status === "missed")?.name)} className="shrink-0 bg-card border border-missed-border text-missed-fg text-xs font-bold rounded-xl px-3 py-2 flex items-center gap-1.5 active:opacity-80 transition-opacity">
              <Send size={11} /> {t(language, "dashboard.remind")}
            </button>
          </div>
        </div>
      )}

      {/* Refill alerts */}
      {refillAlerts.length > 0 && (
        <div>
          <SectionHeader title={t(language, "home.refillNeeded")} />
          <div className="space-y-2">
            {refillAlerts.map(m => (
              <div key={m.id} className="bg-warn-bg border border-warn-border rounded-2xl px-4 py-3 flex items-center gap-3">
                <RefreshCw size={16} className="text-warn-fg shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-warn-fg">{m.name}</p>
                  <p className="text-xs text-warn-fg">{t(language, "dashboard.daysRemainingOrderSoon", { days: m.refillDaysLeft })}</p>
                </div>
                <span className="text-[calc(10px*var(--dw-text,1))] font-bold text-warn-fg bg-warn-bg border border-warn-border rounded-full px-2 py-0.5">{m.refillDaysLeft}d</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <Card className="p-3.5">
        <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground uppercase tracking-widest font-medium mb-2">{t(language, "dashboard.quickActions")}</p>
        <div className="flex gap-2">
          {/* One tile treatment for all four, matching the elder help rows:
              a pine icon on the same soft tint. Emergency is the exception —
              it keeps the missed palette so it never reads as routine. */}
          <QuickAction
            icon={<Clock size={20} className="text-primary" />}
            label={t(language, "common.checkSchedule")}
            colour="bg-secondary"
            onClick={() => onNavigate("timeline")}
          />
          <QuickAction
            icon={<Send size={20} className="text-primary" />}
            label={t(language, "common.sendReminder")}
            colour="bg-secondary"
            onClick={() => onSendReminder()}
          />
          <QuickAction
            icon={<MessageSquare size={20} className="text-primary" />}
            label={t(language, "common.leaveNote")}
            colour="bg-secondary"
            onClick={() => onNavigate("messages")}
          />
          <QuickAction
            icon={<AlertTriangle size={20} className="text-missed-fg" />}
            label={t(language, "common.emergency")}
            colour="bg-missed-bg border border-missed-border"
            onClick={() => onNavigate("settings")}
          />
        </div>
      </Card>
    </div>
  );
}

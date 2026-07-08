import {
  ClipboardList, CheckCircle2, AlertTriangle, Circle, Send, RefreshCw,
  Clock, MessageSquare,
} from "lucide-react";
import type { Patient, Screen } from "../types";
import { Card, SectionHeader, QuickAction } from "../components/shared";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

function AdherenceRing({ value }: { value: number }) {
  const size = 112;
  const strokeWidth = 9;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = circumference - (value / 100) * circumference;
  const colour = value >= 80 ? "#2E7D32" : value >= 50 ? "#C05621" : "#B91C1C";
  const cx = size / 2;
  const cy = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#E6E2D8" strokeWidth={strokeWidth} />
      <circle
        cx={cx} cy={cy} r={radius}
        fill="none" stroke={colour} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={progress}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
    </svg>
  );
}

export function DashboardScreen({ patient, onNavigate }: { patient: Patient; onNavigate: (s: Screen) => void }) {
  const { language } = useLanguage();
  const taken = patient.medications.filter(m => m.status === "taken").length;
  const missed = patient.medications.filter(m => m.status === "missed").length;
  const upcoming = patient.medications.filter(m => m.status === "upcoming").length;
  const total = patient.medications.length;
  const refillAlerts = patient.medications.filter(m => m.refillDaysLeft && m.refillDaysLeft <= 7);

  return (
    <div className="px-4 py-5 space-y-3">
      {/* Adherence overview */}
      <Card className="p-3.5" data-tour="cg-dashboard">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium mb-0.5">{t(language, "home.today")} {t(language, "nav.medications")}</p>
          <button
            onClick={() => onNavigate("timeline")}
            className="shrink-0 flex items-center gap-1 text-xs font-semibold text-primary bg-secondary rounded-full px-3 py-1.5 active:opacity-80 transition-opacity whitespace-nowrap -mt-1"
          >
            <ClipboardList size={12} />
            {t(language, "common.viewSchedule")}
          </button>
        </div>
        <p className="font-['Fraunces'] text-4xl font-semibold text-foreground leading-none">
          {patient.adherenceToday}<span className="text-lg text-muted-foreground">%</span>
        </p>
        <p className="text-xs text-muted-foreground mt-1">{taken} of {total} doses taken</p>
        <div className="flex gap-2 mt-2">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 whitespace-nowrap">
            <CheckCircle2 size={10} /> {taken} Taken
          </span>
          {missed > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5 whitespace-nowrap">
              <AlertTriangle size={10} /> {missed} Missed
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5 whitespace-nowrap">
            <Circle size={10} /> {upcoming} Upcoming
          </span>
        </div>
      </Card>

      {/* Missed medications alert */}
      {missed > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-2xl p-3.5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-orange-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-orange-800">{t(language, "common.missed")} dose alert</p>
              {patient.medications.filter(m => m.status === "missed").map(m => (
                <p key={m.id} className="text-xs text-orange-700 mt-0.5">{m.name} {m.dose} — was due at {m.time}</p>
              ))}
            </div>
            <button onClick={() => onNavigate("messages")} className="shrink-0 bg-orange-600 text-white text-xs font-semibold rounded-xl px-3 py-1.5 flex items-center gap-1">
              <Send size={11} /> Remind
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
              <div key={m.id} className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-center gap-3">
                <RefreshCw size={16} className="text-amber-700 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-amber-900">{m.name}</p>
                  <p className="text-xs text-amber-700">{m.refillDaysLeft} days remaining · Order soon</p>
                </div>
                <span className="text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">{m.refillDaysLeft}d</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <Card className="p-3.5">
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium mb-2">Quick Actions</p>
        <div className="flex gap-2">
          <QuickAction
            icon={<Clock size={20} className="text-emerald-700" />}
            label={t(language, "common.checkSchedule")}
            colour="bg-emerald-50"
            onClick={() => onNavigate("timeline")}
          />
          <QuickAction
            icon={<Send size={20} className="text-primary" />}
            label={t(language, "common.sendReminder")}
            colour="bg-secondary"
            onClick={() => onNavigate("messages")}
          />
          <QuickAction
            icon={<MessageSquare size={20} className="text-accent" />}
            label={t(language, "common.leaveNote")}
            colour="bg-orange-50"
            onClick={() => onNavigate("messages")}
          />
          <QuickAction
            icon={<AlertTriangle size={20} className="text-red-600" />}
            label={t(language, "common.emergency")}
            colour="bg-red-50"
          />
        </div>
      </Card>
    </div>
  );
}

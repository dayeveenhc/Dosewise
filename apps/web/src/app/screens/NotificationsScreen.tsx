import { useState } from "react";
import { AlertTriangle, RefreshCw, Brain, Bell, Phone, CheckCircle2, Send, Check } from "lucide-react";
import type { Notification, Patient } from "../types";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import { CallMockup } from "../components/CallMockup";

export function NotificationsScreen({ notifications, patient, onMarkAllRead, onDismiss }: {
  notifications: Notification[]; patient: Patient; onMarkAllRead: () => void; onDismiss: (id: number) => void;
}) {
  const { language } = useLanguage();
  const notifs = notifications;
  const unread = notifs.filter(n => !n.read).length;
  const [showCallPatient, setShowCallPatient] = useState(false);
  // No pharmacy-ordering backend exists yet — requesting a refill just confirms
  // the ask was logged, same demo-depth as the rest of this screen's actions.
  const [refillRequested, setRefillRequested] = useState<Set<number>>(new Set());

  const markAllRead = onMarkAllRead;
  const dismiss = onDismiss;

  const iconFor = (type: Notification["type"]) => {
    if (type === "missed") return <AlertTriangle size={16} className="text-missed-fg" />;
    if (type === "refill") return <RefreshCw size={16} className="text-warn" />;
    if (type === "info") return <Brain size={16} className="text-primary" />;
    if (type === "reminder") return <Send size={16} className="text-primary" />;
    return <Bell size={16} className="text-muted-foreground" />;
  };

  const bgFor = (type: Notification["type"]) => {
    if (type === "missed") return "bg-missed-bg border-missed-border";
    if (type === "refill") return "bg-warn-bg border-warn-border";
    if (type === "info") return "bg-secondary border-primary/20";
    if (type === "reminder") return "bg-secondary border-primary/20";
    return "bg-card border-border";
  };

  return (
    <div className="px-4 py-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "nav.notifications")}</h2>
          {unread > 0 && <p className="text-xs text-muted-foreground">{t(language, "notifications.unreadCount", { count: unread })}</p>}
        </div>
        {unread > 0 && (
          <button onClick={markAllRead} className="text-xs text-primary font-semibold">{t(language, "notifications.markAllRead")}</button>
        )}
      </div>

      <div className="space-y-2">
        {notifs.map(n => (
          <div key={n.id} className={`rounded-2xl border p-4 relative ${bgFor(n.type)} ${!n.read ? "shadow-sm" : "opacity-70"}`}>
            {!n.read && <div className="absolute top-3 right-3 w-2 h-2 bg-primary rounded-full" />}
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-white/70 flex items-center justify-center shrink-0">
                {iconFor(n.type)}
              </div>
              <div className="flex-1 min-w-0 pr-4">
                <p className="text-sm font-semibold text-foreground">{n.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{n.body}</p>
                <p className="text-[calc(10px*var(--dw-text,1))] font-mono text-muted-foreground mt-1.5">{n.time}</p>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              {n.type === "missed" && (
                <button onClick={() => setShowCallPatient(true)} className="flex-1 text-xs font-semibold bg-missed-fg text-white rounded-xl py-2 flex items-center justify-center gap-1.5">
                  <Phone size={11} /> {t(language, "common.callPatient")}
                </button>
              )}
              {n.type === "refill" && (
                <button
                  onClick={() => setRefillRequested(prev => new Set(prev).add(n.id))}
                  disabled={refillRequested.has(n.id)}
                  className="flex-1 text-xs font-semibold bg-warn text-white rounded-xl py-2 flex items-center justify-center gap-1.5 disabled:opacity-60"
                >
                  {refillRequested.has(n.id) ? <Check size={11} /> : <RefreshCw size={11} />}
                  {refillRequested.has(n.id) ? t(language, "common.requested") : t(language, "common.orderRefill")}
                </button>
              )}
              <button onClick={() => dismiss(n.id)} className="text-xs font-medium text-muted-foreground border border-border bg-white/60 rounded-xl px-3 py-2">
                {t(language, "common.dismiss")}
              </button>
            </div>
          </div>
        ))}

        {notifs.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center">
              <CheckCircle2 size={28} className="text-taken" />
            </div>
            <p className="font-['Fraunces'] text-lg text-foreground">{t(language, "common.allClear")}</p>
            <p className="text-sm text-muted-foreground">{t(language, "common.noPendingNotifications")}</p>
          </div>
        )}
      </div>

      {showCallPatient && (
        <CallMockup name={patient.nickname} role={t(language, "common.patient")} onEnd={() => setShowCallPatient(false)} />
      )}
    </div>
  );
}

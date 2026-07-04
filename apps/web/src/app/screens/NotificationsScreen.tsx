import { useState } from "react";
import { AlertTriangle, RefreshCw, Brain, Bell, Phone, CheckCircle2 } from "lucide-react";
import type { Notification } from "../types";
import { NOTIFICATIONS } from "../data/patients";

export function NotificationsScreen() {
  const [notifs, setNotifs] = useState(NOTIFICATIONS);
  const unread = notifs.filter(n => !n.read).length;

  const markAllRead = () => setNotifs(prev => prev.map(n => ({ ...n, read: true })));
  const dismiss = (id: number) => setNotifs(prev => prev.filter(n => n.id !== id));

  const iconFor = (type: Notification["type"]) => {
    if (type === "missed") return <AlertTriangle size={16} className="text-orange-600" />;
    if (type === "refill") return <RefreshCw size={16} className="text-amber-600" />;
    if (type === "info") return <Brain size={16} className="text-primary" />;
    return <Bell size={16} className="text-muted-foreground" />;
  };

  const bgFor = (type: Notification["type"]) => {
    if (type === "missed") return "bg-orange-50 border-orange-200";
    if (type === "refill") return "bg-amber-50 border-amber-200";
    if (type === "info") return "bg-secondary border-primary/20";
    return "bg-card border-border";
  };

  return (
    <div className="px-4 py-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-['Fraunces'] text-xl font-semibold text-foreground">Notifications</h2>
          {unread > 0 && <p className="text-xs text-muted-foreground">{unread} unread</p>}
        </div>
        {unread > 0 && (
          <button onClick={markAllRead} className="text-xs text-primary font-semibold">Mark all read</button>
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
                <p className="text-[10px] font-mono text-muted-foreground mt-1.5">{n.time}</p>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              {n.type === "missed" && (
                <button className="flex-1 text-xs font-semibold bg-orange-600 text-white rounded-xl py-2 flex items-center justify-center gap-1.5">
                  <Phone size={11} /> Call Patient
                </button>
              )}
              {n.type === "refill" && (
                <button className="flex-1 text-xs font-semibold bg-amber-600 text-white rounded-xl py-2 flex items-center justify-center gap-1.5">
                  <RefreshCw size={11} /> Order Refill
                </button>
              )}
              <button onClick={() => dismiss(n.id)} className="text-xs font-medium text-muted-foreground border border-border bg-white/60 rounded-xl px-3 py-2">
                Dismiss
              </button>
            </div>
          </div>
        ))}

        {notifs.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center">
              <CheckCircle2 size={28} className="text-emerald-600" />
            </div>
            <p className="font-['Fraunces'] text-lg text-foreground">All clear</p>
            <p className="text-sm text-muted-foreground">No pending notifications.</p>
          </div>
        )}
      </div>
    </div>
  );
}

import { AlertTriangle, Bell } from "lucide-react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import type { Alert } from "../lib/alerts";

/**
 * The one thing allowed to interrupt: a full-screen alert for something the
 * person has to act on today and would otherwise miss.
 *
 * Deliberately the same shape as WalkthroughIdlePrompt — same backdrop, card,
 * and "each action renders only if its callback exists" rule — because that is
 * the interruption idiom this app already has, and a second visual language for
 * "stop and read this" would be worse than reusing the first.
 *
 * WHETHER it appears is not decided here. `lib/alerts.ts::pickPopupAlert` owns
 * every anti-nag rule (tier, preference toggle, once-per-day dedupe, cooldown,
 * quiet hours, suppression behind other modals) so they live in one testable
 * place rather than being spread across a component's render.
 *
 * Unlike its sibling this mounts standalone, so it carries its OWN z-index:
 * above the Add-prescription sheet (z-50) and the bottom nav (z-40), because an
 * urgent notice buried under a form is not urgent — but BELOW the walkthrough
 * overlay (z-[200]), whose callout is the only host of its Exit button, and
 * below the toasts (z-[300]).
 */
export function UrgentAlertPopup({ alert, onDismiss, onView, onTalkToMei }: {
  alert: Alert;
  onDismiss: () => void;
  // Absent when the alert has nowhere specific to go (an agent notice with no
  // backing entity) — a button that lands nowhere is worse than no button.
  onView?: () => void;
  onTalkToMei?: () => void;
}) {
  const { language } = useLanguage();
  const critical = alert.severity === "critical";
  return (
    <div
      data-walk="urgent-alert-popup"
      className="absolute inset-0 z-[120] flex items-center justify-center p-6 pointer-events-auto"
    >
      {/* Tapping outside dismisses, like the idle popup — but it is recorded as
          a real dismissal, so the same alert cannot pop again today. */}
      <div className="absolute inset-0 bg-black/50" onClick={onDismiss} />
      <div className="relative bg-card rounded-2xl p-5 shadow-2xl w-full max-w-[330px]">
        <div className="flex items-center gap-2.5 mb-3">
          {/* Under .contrast-max every *-bg token collapses to white, so the
              tier has to be carried by the border and the glyph too, never by
              a background tint alone. */}
          <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 border-2 ${
            critical ? "bg-missed-bg border-missed-border" : "bg-warn-bg border-warn-border"
          }`}>
            {critical
              ? <AlertTriangle size={21} className="text-missed-fg" strokeWidth={2.5} />
              : <Bell size={21} className="text-warn-fg" strokeWidth={2.5} />}
          </div>
          <p className={`text-[calc(12px*var(--dw-text,1))] font-bold uppercase tracking-wider ${
            critical ? "text-missed-fg" : "text-warn-fg"
          }`}>
            {t(language, critical ? "alerts.tierCritical" : "alerts.tierUrgent")}
          </p>
        </div>

        <h3 className="font-['Fraunces'] text-[calc(19px*var(--dw-text,1))] font-semibold text-foreground mb-2 leading-tight">
          {t(language, alert.titleKey, alert.params)}
        </h3>
        <p className="text-[calc(15px*var(--dw-text,1))] text-muted-foreground leading-relaxed mb-4">
          {t(language, alert.bodyKey, alert.params)}
        </p>

        <div className="flex flex-col gap-2">
          {onView && (
            <button
              onClick={onView}
              className="w-full min-h-[44px] py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold dw-press"
            >
              {t(language, "alerts.popupView")}
            </button>
          )}
          {onTalkToMei && (
            <button
              onClick={onTalkToMei}
              className="w-full min-h-[44px] py-3 rounded-xl border border-border text-foreground text-sm font-semibold dw-press"
            >
              {t(language, "alerts.popupTalkToMei")}
            </button>
          )}
          <button
            onClick={onDismiss}
            className="w-full min-h-[44px] py-3 rounded-xl border border-border text-muted-foreground text-sm font-semibold dw-press"
          >
            {t(language, "alerts.popupDismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}

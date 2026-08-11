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
export function UrgentAlertPopup({ alert, members, raiseCount = 1, raiseMax = 1, onDismiss, onView, onTalkToMei }: {
  alert: Alert;
  // Everything this one interruption stands for. When there is more than one,
  // the popup leads with the COUNT and lists them — three missed doses are one
  // situation, and showing them one at a time never said "three".
  members?: Alert[];
  // Which interrupt this is, and how many this tier gets at all. Prominence
  // escalates as lib/alerts.ts's cooldown ladder stretches: more insistent to
  // look at, less frequent to be hit by.
  raiseCount?: number;
  raiseMax?: number;
  onDismiss: () => void;
  // Absent when the alert has nowhere specific to go (an agent notice with no
  // backing entity) — a button that lands nowhere is worse than no button.
  // lib/alerts.ts::canViewAlert is what the host decides this with.
  onView?: () => void;
  // There is deliberately no onTellCaregiver. See lib/alerts.ts's note above
  // canViewAlert: the only alerts it was ever offered for are the ones the
  // person answers themselves, one tap away. The Reminders cards keep it.
  onTalkToMei?: () => void;
}) {
  const { language } = useLanguage();
  const critical = alert.severity === "critical";
  const rest = members && members.length > 1 ? members : null;
  const grouped = rest ? (alert.kind === "out_of_supply" || alert.kind === "low_supply" ? "supply" : "missed") : null;
  // Last rung says so plainly; the middle rungs say it isn't done yet. The
  // wording is what makes the meter mean something rather than decorate.
  const tierKey = raiseCount >= raiseMax && raiseMax > 1
    ? (critical ? "alerts.tierCriticalLast" : "alerts.tierUrgentLast")
    : raiseCount > 1
      ? (critical ? "alerts.tierCriticalAgain" : "alerts.tierUrgentAgain")
      : (critical ? "alerts.tierCritical" : "alerts.tierUrgent");
  const VISIBLE_MEMBERS = 4;

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
          <div className="min-w-0">
            <p className={`text-[calc(12px*var(--dw-text,1))] font-bold uppercase tracking-wider ${
              critical ? "text-missed-fg" : "text-warn-fg"
            }`}>
              {t(language, tierKey)}
            </p>
            {/* The insistence meter. Only once there is more than one rung to
                show — a single-shot alert has nothing to count. Carries its own
                words, because a row of bars is not information to a screen
                reader or to someone who cannot separate the two fills. */}
            {raiseMax > 1 && (
              <div
                className="flex items-center gap-1 mt-1"
                role="img"
                aria-label={t(language, "alerts.meterLabel", { n: raiseCount, max: raiseMax })}
              >
                {Array.from({ length: raiseMax }, (_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-4 rounded-full ${
                      i < raiseCount ? (critical ? "bg-missed-fg" : "bg-warn-fg") : "bg-muted"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <h3 className="font-['Fraunces'] text-[calc(19px*var(--dw-text,1))] font-semibold text-foreground mb-2 leading-tight">
          {rest
            ? t(language, grouped === "supply" ? "alerts.groupSupplyTitle" : "alerts.groupMissedTitle", { count: rest.length })
            : t(language, alert.titleKey, alert.params)}
        </h3>
        <p className="text-[calc(15px*var(--dw-text,1))] text-muted-foreground leading-relaxed mb-3">
          {rest
            ? t(language, grouped === "supply" ? "alerts.groupSupplyBody" : "alerts.groupMissedBody")
            : t(language, alert.bodyKey, alert.params)}
        </p>

        {/* Rows, not one interpolated sentence: medicine names run long at
            elder text sizes, and a list is scannable where a comma-joined
            string is not. */}
        {rest && (
          <ul className="mb-4 space-y-1.5">
            {rest.slice(0, VISIBLE_MEMBERS).map(m => (
              <li key={m.id} className="flex items-baseline gap-2 text-[calc(15px*var(--dw-text,1))]">
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full translate-y-[-2px] ${m.severity === "critical" ? "bg-missed-fg" : "bg-warn-fg"}`} />
                <span className="font-semibold text-foreground break-words">{m.medName ?? t(language, m.titleKey, m.params)}</span>
                {typeof m.params.time === "string" && (
                  <span className="text-muted-foreground shrink-0">{m.params.time}</span>
                )}
              </li>
            ))}
            {rest.length > VISIBLE_MEMBERS && (
              <li className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground pl-3.5">
                {t(language, "alerts.groupMore", { n: rest.length - VISIBLE_MEMBERS })}
              </li>
            )}
          </ul>
        )}

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

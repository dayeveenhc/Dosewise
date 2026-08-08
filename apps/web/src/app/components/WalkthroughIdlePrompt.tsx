import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

/**
 * IdleTimeout's (Item 6) "still there?" popup — fired by Walkthrough.tsx once
 * `waitingOnUser` has held true for IDLE_TIMEOUT_MS with zero interaction.
 * Purely presentational: each action is an optional callback, absent exactly
 * when that action isn't safe/available for the current step (mirrors the
 * Replay button's own optional-prop-gated rendering in Walkthrough.tsx) —
 * a button that would silently do nothing is worse than no button.
 */
export function WalkthroughIdlePrompt({ onTalkToMei, onEndWalkthrough, onContinue }: {
  // Absent when the host hasn't wired a chat handoff. Hands off to the real
  // conversation — the host exits the walkthrough AND opens the chat in its
  // conversation view, not on the help tiles (see the hosts' own
  // handleWalkthroughTalkToMei).
  onTalkToMei?: () => void;
  // Leave the walkthrough entirely. Safe on every step (exiting writes nothing
  // back), so it has no absent case — but it stays an optional prop for
  // symmetry with its sibling.
  onEndWalkthrough?: () => void;
  onContinue: () => void;
}) {
  const { language } = useLanguage();
  return (
    // data-walk (not a behavioural hook, just a scoping anchor): the existing
    // consent-invariant tests/specs assert "the only advance-shaped control in
    // the walkthrough root is Exit" by filtering rounded-xl buttons — this
    // popup's own non-advancing buttons share that class, so a future e2e
    // spec parked on a slow waitFor step (request_refill's agent-action-
    // committed wait routinely exceeds IDLE_TIMEOUT_MS) needs an easy way to
    // exclude this subtree from that filter.
    <div data-walk="walk-idle-popup" className="absolute inset-0 flex items-center justify-center p-6 pointer-events-auto">
      {/* Tapping the backdrop is itself a real interaction — same dismiss+
          reset as the explicit "still here" button below. */}
      <div className="absolute inset-0 bg-black/40" onClick={onContinue} />
      <div className="relative bg-card rounded-2xl p-5 shadow-2xl w-full max-w-[330px]">
        <h3 className="font-['Fraunces'] text-[calc(19px*var(--dw-text,1))] font-semibold text-foreground mb-2 leading-tight">
          {t(language, "walk.idle.title")}
        </h3>
        <p className="text-[calc(14px*var(--dw-text,1))] text-muted-foreground leading-relaxed mb-4">
          {t(language, "walk.idle.body")}
        </p>
        <div className="flex flex-col gap-2">
          {onTalkToMei && (
            <button
              onClick={onTalkToMei}
              className="w-full min-h-[44px] py-3 rounded-xl border border-border text-foreground text-sm font-semibold dw-press"
            >
              {t(language, "walk.idle.talkToMei")}
            </button>
          )}
          {onEndWalkthrough && (
            <button
              onClick={onEndWalkthrough}
              className="w-full min-h-[44px] py-3 rounded-xl border border-border text-foreground text-sm font-semibold dw-press"
            >
              {t(language, "walk.idle.endWalkthrough")}
            </button>
          )}
          <button
            onClick={onContinue}
            className="w-full min-h-[44px] py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold dw-press"
          >
            {t(language, "walk.idle.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

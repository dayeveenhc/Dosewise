/**
 * Which urgent alerts have already interrupted this person, and when the next
 * one may.
 *
 * sessionStorage rather than an in-memory ref, because every screen in the
 * elder shell unmounts on a bottom-nav switch — an in-memory Set would let the
 * same alert pop again on every tab round trip, which is exactly the nagging
 * this state exists to prevent.
 *
 * sessionStorage rather than localStorage, because the dedupe is DAY-scoped: a
 * stale entry surviving to tomorrow would silently suppress a genuinely new
 * alert about the same medicine.
 *
 * Keyed by `{shell}:{userId}` for the same reason walkthroughState.ts is — a
 * caregiver previewing the elder view shares one userId across both shells.
 */
import { isoDate } from "./medications";

const KEY_PREFIX = "dosewise:alertsPopped";

// Two urgent things at once should not be two modals. The second is still on
// the Reminders tab and still badged; it just doesn't interrupt.
export const ALERT_POPUP_COOLDOWN_MS = 30 * 60 * 1000;

export interface AlertPopupState {
  /** `${alertId}|${YYYY-MM-DD}` — day-scoped so a genuinely new day re-alerts. */
  popped: string[];
  /** Epoch ms; nothing may interrupt before this. */
  cooldownUntil: number;
}

const EMPTY: AlertPopupState = { popped: [], cooldownUntil: 0 };

const key = (shell: string, userId?: string | null) => `${KEY_PREFIX}:${shell}:${userId ?? "anon"}`;

export function loadAlertState(shell: string, userId?: string | null): AlertPopupState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = sessionStorage.getItem(key(shell, userId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<AlertPopupState>;
    return {
      popped: Array.isArray(parsed.popped) ? parsed.popped : [],
      cooldownUntil: typeof parsed.cooldownUntil === "number" ? parsed.cooldownUntil : 0,
    };
  } catch {
    return EMPTY;
  }
}

export function saveAlertState(shell: string, userId: string | null | undefined, state: AlertPopupState): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key(shell, userId), JSON.stringify(state));
  } catch {
    /* private mode / quota — the popup degrades to "may repeat", never to a crash */
  }
}

/** The day-scoped dedupe handle for one alert. */
export const poppedKey = (alertId: string, now = new Date()) => `${alertId}|${isoDate(now)}`;

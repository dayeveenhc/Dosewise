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

export interface AlertPopupState {
  /** `${alertId}|${YYYY-MM-DD}` — day-scoped so a genuinely new day re-alerts. */
  popped: string[];
  /** Epoch ms; nothing may interrupt before this. */
  cooldownUntil: number;
  /** `${groupId}|${YYYY-MM-DD}` -> how many times that group has interrupted.
   *  Drives BOTH ladders in lib/alerts.ts: the cooldown that follows, and the
   *  insistence meter the popup shows. "One sitting" needs no extra concept —
   *  this whole record is sessionStorage, so a session IS a sitting. */
  raises: Record<string, number>;
}

const EMPTY: AlertPopupState = { popped: [], cooldownUntil: 0, raises: {} };

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
      raises: parsed.raises && typeof parsed.raises === "object" ? parsed.raises : {},
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

/** The day-scoped dedupe handle for one alert or group. */
export const poppedKey = (id: string, now = new Date()) => `${id}|${isoDate(now)}`;

/**
 * TODAY's popped ids, with the day suffix stripped — the shape
 * `lib/alerts.ts::pickPopupGroup` compares against.
 *
 * This exists because the two halves disagreed. The store wrote
 * `poppedKey(alert.id)` (`"supply:m1|2026-08-11"`) while pickPopupAlert asked
 * `popped.has(alert.id)` (`"supply:m1"`), so the once-per-day dedupe never
 * matched anything and the only thing limiting repeat popups was the flat
 * 30-minute cooldown. The unit tests passed throughout, because they hand in
 * bare ids — which is exactly the shape this returns, so they still do.
 *
 * Filtering by day rather than just splitting on "|" is the load-bearing half:
 * yesterday's entries must not suppress today's alert, and an id can contain
 * "|" of its own (`missed:{medId}|{time}|{date}`).
 */
export function poppedIdsFor(state: AlertPopupState, now = new Date()): Set<string> {
  const suffix = `|${isoDate(now)}`;
  return new Set(
    state.popped.filter(k => k.endsWith(suffix)).map(k => k.slice(0, -suffix.length)),
  );
}

/** Today's raise counts, keyed by bare group id. */
export function raisesFor(state: AlertPopupState, now = new Date()): Record<string, number> {
  const suffix = `|${isoDate(now)}`;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(state.raises)) {
    if (key.endsWith(suffix)) out[key.slice(0, -suffix.length)] = count;
  }
  return out;
}

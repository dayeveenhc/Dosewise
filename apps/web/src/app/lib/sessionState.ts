const APP_MODE_KEY = "dosewise:app-mode";

function getAppModeStorageKey(userId?: string | null): string {
  return userId ? `${APP_MODE_KEY}:${userId}` : APP_MODE_KEY;
}

export function readStoredAppMode(userId?: string | null): "onboarding" | "caregiver" | "elderly" | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(getAppModeStorageKey(userId));
  if (stored === "caregiver" || stored === "elderly") return stored;
  return null;
}

export function persistAppMode(userId: string | undefined | null, mode: "onboarding" | "caregiver" | "elderly") {
  if (typeof window === "undefined") return;
  if (!userId) return;
  window.localStorage.setItem(getAppModeStorageKey(userId), mode);
}

// Wipes the "last interface used" preference on sign-out, so the NEXT login —
// whether the same person or someone else sharing this browser — starts from
// the real database role rather than whatever mode a previous session (e.g. a
// caregiver's "preview elderly" tap) left behind. Without this, a caregiver
// who ever previewed the elderly interface would be silently dropped back
// into it on every future login, since readStoredAppMode takes priority over
// the DB role.
export function clearStoredAppMode(userId: string | undefined | null) {
  if (typeof window === "undefined") return;
  if (!userId) return;
  window.localStorage.removeItem(getAppModeStorageKey(userId));
}

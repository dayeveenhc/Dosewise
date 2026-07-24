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

const APP_MODE_KEY = "dosewise:app-mode";
const CHAT_MESSAGES_KEY_PREFIX = "dosewise:chat";

export function getAppModeStorageKey(userId?: string | null): string {
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

export function getChatStorageKey(userId?: string | null): string {
  return `${CHAT_MESSAGES_KEY_PREFIX}:${userId ?? "guest"}`;
}

export function readStoredChatMessages<T>(userId?: string | null): T[] | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(getChatStorageKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function persistChatMessages<T>(userId: string | undefined | null, messages: T[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getChatStorageKey(userId), JSON.stringify(messages));
}

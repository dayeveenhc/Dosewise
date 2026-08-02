import type { WalkthroughParams, WalkthroughTaskName } from "./walkthrough/types";

// In-progress walkthrough position — sessionStorage, same pattern as the elder
// chat's own session persistence (ElderlyAIScreen.tsx: keyed per-user, TTL'd,
// cleared automatically when the tab closes). Explicitly does NOT survive a
// full page refresh's worth of "was this the exact same load" — it survives a
// same-tab screen switch (e.g. to chat and back) within the TTL, matching the
// one case that's actually real for a walkthrough; a hard refresh restarting
// is acceptable (the onboarding wizard itself doesn't survive one either).
const TTL_MS = 30 * 60 * 1000;
const KEY_PREFIX = "dosewise:walkthrough";

// Which shell owns this session. A caregiver previewing their own elder view
// (caregiver_view_toggle_tour) uses the SAME userId in both shells — without
// this discriminator, a caregiver-shell session (e.g. mid-completion when its
// last step's click also flips appMode to "elderly") gets picked up by
// ElderlyApp's own restore-on-mount effect the instant it mounts, and THAT
// shell's handleWalkthroughAdvance re-fires completion with role="elder"
// hardcoded — silently overwriting the caregiver's real profiles.role to
// "elder" in the database. Found live (s27 spec, 2026-08): every
// caregiver_view_toggle_tour run corrupted the caregiver's own role column.
export type WalkthroughShell = "elder" | "caregiver";

export interface WalkthroughSession {
  taskName: WalkthroughTaskName;
  stepIndex: number;
  startedAt: number;
  // Real values injected into an autonomous walkthrough's fill/verify steps, so a
  // same-tab remount mid-walkthrough keeps filling the right thing.
  params?: WalkthroughParams;
}

function key(shell: WalkthroughShell, userId?: string | null): string {
  return `${KEY_PREFIX}:${shell}:${userId ?? "anon"}`;
}

export function loadWalkthroughSession(shell: WalkthroughShell, userId?: string | null): WalkthroughSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key(shell, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalkthroughSession;
    if (Date.now() - parsed.startedAt > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveWalkthroughSession(shell: WalkthroughShell, userId: string | undefined | null, session: WalkthroughSession): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(key(shell, userId), JSON.stringify(session));
}

// Exiting/skipping clears client state only — never written back to Supabase.
// Only genuine completion (the last step's real waitFor firing) writes
// completedWalkthroughs (lib/profile.ts).
export function clearWalkthroughSession(shell: WalkthroughShell, userId?: string | null): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(key(shell, userId));
}

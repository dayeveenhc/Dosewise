import type { AppMode } from "../types";

// Small localStorage-backed user preferences, keyed per Supabase user id so each
// account keeps its own settings on this browser. Matches the lib/*.ts helper
// pattern (medications.ts, profile.ts) — no new state-management abstraction.

// ---------------------------------------------------------------------------
// Last-active interface (elderly vs caregiver)
// ---------------------------------------------------------------------------
// Mode is normally derived from the DB role, but "Switch mode" is a preview the
// user expects to persist — reopening the app should land on the interface they
// last used, not snap back to the role default. Keyed per user so switching
// accounts restores each one's own last-used mode.
const modeKey = (userId: string) => `dosewise:mode:${userId}`;

export function getMode(userId: string): "elderly" | "caregiver" | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(modeKey(userId));
  return v === "elderly" || v === "caregiver" ? v : null;
}

export function setMode(userId: string, mode: AppMode): void {
  if (typeof window === "undefined") return;
  if (mode !== "elderly" && mode !== "caregiver") return; // never persist "onboarding"
  localStorage.setItem(modeKey(userId), mode);
}

// ---------------------------------------------------------------------------
// Language ("Mei responds in this language")
// ---------------------------------------------------------------------------
export type LangCode = "en" | "zh" | "hokkien" | "cantonese" | "tamil" | "malay";

export interface LangOption {
  code: LangCode;
  label: string; // shown in the Settings dropdown / chat language sheet
  // Natural-language name sent to Hermes as reply_language ("reply in {x}").
  // undefined for English so the agent keeps its default behaviour.
  replyLanguage?: string;
  bcp47: string; // for browser SpeechRecognition / speechSynthesis
}

export const LANG_OPTIONS: LangOption[] = [
  { code: "en",        label: "English",         replyLanguage: undefined,          bcp47: "en-SG" },
  { code: "zh",        label: "华语 (Mandarin)",  replyLanguage: "Mandarin Chinese", bcp47: "zh-CN" },
  { code: "hokkien",   label: "闽南话 (Hokkien)", replyLanguage: "Hokkien",          bcp47: "zh-CN" },
  { code: "cantonese", label: "粤语 (Cantonese)", replyLanguage: "Cantonese",        bcp47: "zh-HK" },
  { code: "tamil",     label: "தமிழ் (Tamil)",    replyLanguage: "Tamil",            bcp47: "ta-IN" },
  { code: "malay",     label: "Melayu",          replyLanguage: "Malay",            bcp47: "ms-MY" },
];

export function langOption(code: LangCode): LangOption {
  return LANG_OPTIONS.find(o => o.code === code) ?? LANG_OPTIONS[0];
}

const langKey = (userId: string) => `dosewise:lang:${userId}`;

export function getLanguage(userId: string): LangCode {
  if (typeof window === "undefined") return "en";
  const v = localStorage.getItem(langKey(userId));
  return LANG_OPTIONS.some(o => o.code === v) ? (v as LangCode) : "en";
}

export function setLanguage(userId: string, code: LangCode): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(langKey(userId), code);
}

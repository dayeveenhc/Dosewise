import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see apps/web/.env.example)");
}

export const supabase = createClient(url, anonKey);

// A throwaway client for signing up an elder profile a caregiver creates on
// someone else's behalf (see api.ts's createLinkedElder). Uses its own storage
// key and never persists, so it can't clobber the caregiver's own session in
// the main `supabase` client above — no service-role key involved.
export function createScopedClient() {
  return createClient(url, anonKey, {
    auth: { storageKey: "dosewise-scoped-auth", persistSession: false, autoRefreshToken: false },
  });
}

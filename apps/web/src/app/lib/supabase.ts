import { createClient } from "@supabase/supabase-js";

const rawUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const url = rawUrl
  ? rawUrl.replace(/\/(?:rest\/v1|auth\/v1)\/?$/, "")
  : "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy apps/web/.env.example to .env and fill them in."
  );
}

export const supabase = createClient(url, anonKey);

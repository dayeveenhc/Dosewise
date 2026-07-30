import { supabase } from "./supabase";

export interface CareNote {
  id: string;
  body: string;
  time: string;
}

// Fetch the signed-in user's real care-log notes — conversation_turns rows the
// backend's add_care_note tool wrote (services/hermes tools/caregiver.py:
// the chat identity IS the record owner, so a caregiver's notes live under
// their OWN elder_id; RLS `auth.uid() = elder_id` scopes this query the same
// way). Newest first, so MessagesScreen can render them above the mock thread
// and a care_note ChangeHighlight (data-testid="care_note-{id}") can land.
export async function fetchCareNotes(userId: string): Promise<CareNote[]> {
  const { data, error } = await supabase
    .from("conversation_turns")
    .select("id,transcript,created_at")
    .eq("elder_id", userId)
    .eq("tool", "add_care_note")
    .order("created_at", { ascending: false });
  if (error || !data) {
    if (error) console.warn("[dosewise] fetchCareNotes failed:", error.message);
    return [];
  }
  return data
    .filter(r => String(r.transcript ?? "").trim())
    .map(r => ({
      id: String(r.id),
      body: String(r.transcript),
      time: formatWhen(String(r.created_at)),
    }));
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

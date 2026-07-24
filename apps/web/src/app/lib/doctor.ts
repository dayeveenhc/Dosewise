import { supabase } from "./supabase";
import type { DoctorQ } from "../screens/elderly/types";

// Fetch the elder's real doctor_questions (RLS-scoped as the signed-in user), so
// questions Mei queued via the add_doctor_question tool actually show in the
// elder's "Ask a doctor" thread — and can be pulse-highlighted by ChangeHighlight
// (data-testid="doctor_message-{id}"). Escalations ([ESCALATION] rows) are the
// human-handoff log, not doctor questions, so they're excluded here.
export async function fetchDoctorQuestions(elderId: string): Promise<DoctorQ[]> {
  const { data, error } = await supabase
    .from("doctor_questions")
    .select("id,question,source,status,created_at")
    .eq("elder_id", elderId)
    .order("created_at", { ascending: false });
  if (error || !data) {
    if (error) console.warn("[dosewise] fetchDoctorQuestions failed:", error.message);
    return [];
  }
  return data
    .filter(r => !String(r.question).startsWith("[ESCALATION]"))
    .map(r => ({
      id: String(r.id),
      question: String(r.question),
      // The elder thread splits "flagged by Mei" vs "manual" on the word "Mei" in
      // addedAt — keep that contract (agent-sourced reads as "Added by Mei").
      addedAt: `${r.source === "agent" ? "Added by Mei" : "Added"} · ${formatWhen(String(r.created_at))}`,
      answered: r.status !== "open",
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

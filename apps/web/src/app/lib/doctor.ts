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
      // Timestamp ONLY. The "Added by Mei ·" prefix is composed at render time
      // from `source` below, so it can be shown in the person's own language —
      // it used to be baked in here in English, and the thread's flagged-vs-
      // manual split then depended on that English word surviving translation.
      addedAt: formatWhen(String(r.created_at)),
      source: r.source === "agent" || r.source === "caregiver" ? r.source : "elder",
      answered: r.status !== "open",
    }));
}

// Persist a question the elder typed themselves. Previously the "add your own
// question" box only pushed onto local component state, so the question vanished
// on reload and could never be verified — which also made it impossible for an
// autonomous walkthrough to prove it had really saved. `source: "elder"` is one
// of the three values public.question_source allows (agent | elder | caregiver)
// and keeps the thread's "Added by Mei" vs "Added" split intact — only 'agent'
// reads as Mei (see fetchDoctorQuestions).
export async function createDoctorQuestion(elderId: string, question: string): Promise<DoctorQ | null> {
  const { data, error } = await supabase
    .from("doctor_questions")
    .insert({ elder_id: elderId, question, source: "elder", status: "open" })
    .select("id,question,source,status,created_at")
    .single();
  if (error || !data) {
    if (error) console.warn("[dosewise] createDoctorQuestion failed:", error.message);
    return null;
  }
  return {
    id: String(data.id),
    question: String(data.question),
    addedAt: formatWhen(String(data.created_at)),
    source: "elder",
    answered: false,
  };
}

// Locale-independent enough to be shown as-is: a clock time or a short date,
// never an English word. An unparseable timestamp yields "" rather than the old
// English "recently" — the caller renders the prefix alone, which stays correct
// in every language.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

import type { Patient } from "../types";
import { MED_PLAIN, MED_REASONS } from "../data/medications";

export function caregiverAiRespond(input: string, patient: Patient): string {
  const q = input.toLowerCase().trim();
  const nick = patient.nickname || patient.name.split(" ")[1];

  if (/^(hi|hello|hey|good (morning|afternoon|evening))/.test(q)) {
    return `Hi! I'm Mei, your AI care assistant for ${patient.name}. Ask me about today's adherence, missed doses, refills, or any of ${nick}'s medications.`;
  }

  if (/adheren|how.*(doing|going)|progress/.test(q)) {
    return `${patient.name} is at ${patient.adherenceToday}% adherence today and ${patient.adherenceWeek}% for the week.`;
  }

  if (/missed/.test(q)) {
    const missed = patient.medications.filter(m => m.status === "missed");
    if (!missed.length) return `No missed doses today — ${nick} is on track! 🎉`;
    return `Missed today:\n\n${missed.map(m => `• ${m.name} ${m.dose} — was due at ${m.time}`).join("\n")}`;
  }

  if (/refill|running low|low on|stock/.test(q)) {
    const low = patient.medications.filter(m => m.refillDaysLeft !== undefined && m.refillDaysLeft <= 7);
    if (!low.length) return "All medications have healthy supply levels — no refills needed soon.";
    return `Running low:\n\n${low.map(m => `• ${m.name} — ${m.refillDaysLeft} days left`).join("\n")}`;
  }

  if (/summary|weekly|report|insight|trend/.test(q)) {
    return `Tap "View Weekly Summary" above for the full adherence trend and AI insights.`;
  }

  const foundMed = patient.medications.find(m => q.includes(m.name.toLowerCase()));
  if (foundMed) {
    const plain = MED_PLAIN[foundMed.name];
    return `${foundMed.name} ${foundMed.dose}\n\n${MED_REASONS[foundMed.purpose] ?? "Part of the treatment plan."}\n\nScheduled at ${foundMed.time}.\n\n${plain?.instructions ?? ""}`;
  }

  return `I'm not sure I understood that. Try asking about adherence, missed doses, refills, or a specific medication like "${patient.medications[0]?.name}".`;
}

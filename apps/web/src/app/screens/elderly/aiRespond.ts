import type { Patient } from "../../types";
import { MED_PLAIN, MED_REASONS } from "../../data/medications";

export function aiRespond(input: string, patient: Patient): {
  text: string; action?: string; actionPayload?: any; doctorQ?: string; isClinic?: boolean;
} {
  const q = input.toLowerCase().trim();
  const nick = patient.nickname || patient.name.split(" ")[1];

  if (/^(hi|hello|good|how are|ni hao|morning|afternoon|evening|hai|helo)/.test(q)) {
    const h = new Date().getHours();
    const g = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    const next = patient.medications.find(m => m.status === "upcoming");
    return { text: `Good ${g}, ${nick}! 😊\n\nI'm Mei, your medicine helper. ${next ? `Your next medicine is ${next.name} (${next.dose}) at ${next.time}.` : "You've taken all your medicines today — well done! 🌟"}\n\nHow can I help you?` };
  }

  if (/took|taken|already|finish|makan|eat|consumed|drink/.test(q)) {
    const found = patient.medications.find(m =>
      q.includes(m.name.toLowerCase()) ||
      (q.includes("diabetes") && m.purpose === "Diabetes") ||
      (q.includes("blood pressure") && m.purpose === "Blood Pressure") ||
      (q.includes("cholesterol") && m.purpose === "Cholesterol") ||
      (q.includes("pain") && m.purpose === "Joint Pain") ||
      (q.includes("blood thin") && m.purpose === "Blood Thinning") ||
      (q.includes("heart") && m.purpose === "Heart Rate") ||
      (q.includes("eye") && m.name.toLowerCase().includes("eye"))
    );
    const fallback = patient.medications.find(m => m.status === "upcoming");
    const target = found || fallback;
    if (target) {
      const t = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
      return { text: `✅ Recorded! You took ${target.name} ${target.dose} at ${t}. 🌟\n\nYour caregiver has been notified. Keep it up!`, action: "logDose", actionPayload: target.id };
    }
    return { text: "Which medicine did you take? You can say the name, or describe it — like 'my diabetes pill', 'the evening tablet', or 'my eye drops'." };
  }

  if (/medicine|medication|pill|tablet|what.*take|prescri|list|show/.test(q)) {
    return { text: `Opening your medicine list now. You have ${patient.medications.length} medicines. Tap any one to see full details and how-to instructions. 📋`, action: "navigate", actionPayload: "prescriptions" };
  }

  if (/refill|running|low|run out|finish|left|stock|almost/.test(q)) {
    const low = patient.medications.filter(m => m.refillDaysLeft !== undefined && m.refillDaysLeft <= 7);
    if (low.length) return { text: `⚠️ Running low on:\n\n${low.map(m => `• ${m.name} — about ${m.refillDaysLeft} days left`).join("\n")}\n\nI've already notified your caregiver. They will help arrange a refill.` };
    return { text: "Your medicine supply looks good! I'll remind you when it's time to refill. 😊" };
  }

  if (/side effect|safe|dangerous|hurt|harm|mix|together|allerg|interact|stop|change|double/.test(q)) {
    return { text: "That's an important question — and one your doctor or pharmacist is the right person to answer. I don't want to guess on anything to do with your medicines.\n\nI've added it to your 'Ask Doctor' list so you won't forget to bring it up at your next visit. 📝\n\n⚠️ Please don't change or stop any medicines without checking with your doctor first.", doctorQ: input, isClinic: true };
  }

  const foundMed = patient.medications.find(m => q.includes(m.name.toLowerCase()));
  if (foundMed) {
    const plain = MED_PLAIN[foundMed.name];
    return { text: `**${foundMed.name} ${foundMed.dose}**\n\n${MED_REASONS[foundMed.purpose] || "This medicine is part of your treatment plan."}\n\nYou take it at ${foundMed.time}.\n\n${plain?.instructions || ""}\n\n⚠️ For questions about your dose or stopping this medicine, always check with your doctor or pharmacist first.`, isClinic: true };
  }

  if (/note|doctor|question|ask|remember/.test(q)) {
    return { text: "I'll take you to the Ask Doctor tab where you can see all questions to ask your doctor.", action: "openDoctorTab" };
  }

  if (/help|what.*do|can.*do|how.*work/.test(q)) {
    return { text: `Here's what I can help with:\n\n💊 "I took my metformin"\n📋 "Show me my medicines"\n⚠️ "Am I running out of anything?"\n❓ "What is amlodipine for?"\n📝 "Remember to ask doctor about X"\n\nJust speak or type — I'll do my best! 😊` };
  }

  return { text: "I'm not sure I quite understood that. You can try:\n\n• \"I took my medicine\"\n• \"What do I take today?\"\n• \"Help\" to see what I can do\n\nOr tap the microphone and speak slowly — I'm listening! 🎤", doctorQ: input.length > 15 ? input : undefined };
}

// Which tappable answer buttons sit under a chat message, and under WHICH
// message. Pure — both chat screens (elder + caregiver) share it, and it is unit
// tested without mounting either (lib/chatChoices.test.ts), the same way
// lib/changeHighlight.ts factors out the highlight decision.
//
// Two sources, in precedence order:
//  1. `choices` — the agent called offer_choices, so it authored context-specific
//     labels ("Yes, save it" / "No, not now") already in the person's language.
//  2. `awaitingConfirmation` — Hermes says a tool PROPOSED something this turn
//     and is waiting on a yes/no (services/hermes session.awaiting_confirmation,
//     the same signal Telegram uses for its ✅/✖ keyboard). Deterministic, so a
//     confirm is never a "type the word yes" dead end just because the model
//     didn't happen to call offer_choices.
//
// The CLIENT owns the synthesized label text, not Hermes: the tapped `value` is
// rendered as the person's own chat bubble AND sent as their next message, so it
// has to be in their language — and this side already holds all six. Hermes has
// no translation table, and reply_language reaches it as free prose, not an enum.

import { t } from "./language";
import type { AgentChoice } from "./hermes";
import type { AppLanguage } from "./language";

export interface ChoiceCarrier {
  role: "user" | "agent";
  choices?: AgentChoice[];
  awaitingConfirmation?: boolean;
}

/**
 * The buttons to render under `msg`, or [] for none. Never returns buttons for
 * a user's own message.
 *
 * `label === value` (as offer_choices itself does, tools/choices.py): the button
 * text IS the message sent, so what the person "said" matches what they saw. A
 * magic token like `__CONFIRM__` would render verbatim in their own bubble and
 * be worse input for the model than a plain sentence.
 */
export function buttonsFor(msg: ChoiceCarrier, language: AppLanguage): AgentChoice[] {
  if (msg.role !== "agent") return [];
  if (msg.choices?.length) return msg.choices;
  if (!msg.awaitingConfirmation) return [];
  const yes = t(language, "ai.confirmYes");
  const no = t(language, "ai.confirmNo");
  return [
    { label: yes, value: yes },
    { label: no, value: no },
  ];
}

/**
 * Index of the last message that has buttons, or -1.
 *
 * Deliberately NOT `messages.length - 1`: a turn that both commits a routable
 * write and asks a follow-up appends its "opening your medicines…" confirmation
 * chip AFTER the reply, so the reply carrying the buttons is no longer last and
 * they silently never rendered. Anchoring on "the last message that actually has
 * buttons" removes the whole class of ordering bug rather than one instance.
 */
export function lastInteractiveIndex(messages: ChoiceCarrier[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "agent" && (m.choices?.length || m.awaitingConfirmation)) return i;
  }
  return -1;
}

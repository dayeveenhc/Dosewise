import { supabase } from "./supabase";
import { getLanguage, langOption } from "./preferences";

const HERMES_URL = import.meta.env.VITE_HERMES_URL;
const HERMES_API_KEY = import.meta.env.VITE_HERMES_API_KEY;

const FALLBACK_REPLY = "Sorry, something went wrong. Let me get a person to help.";

// A write the agent actually committed this turn (never a mere proposal), so the
// UI can confirm it and redirect to the page that shows the change.
export interface AgentAction {
  tool: string;
  summary?: string;
}

interface AgentTurnResponse {
  reply: string;
  tools_used: string[];
  actions: AgentAction[];
}

// Mirrors Hermes's /agent/turn contract (services/hermes/src/hermes/api/routes.py):
// the client forwards its Supabase session JWT, Hermes verifies it and acts as
// that elder. On any failure, fall back to a friendly message instead of a raw
// error — same pattern as the Telegram channel's try/except around run_agent_turn.
export async function agentTurn(
  message: string,
  imageBase64?: string,
  pdfBase64?: string
): Promise<AgentTurnResponse> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { reply: FALLBACK_REPLY, tools_used: [], actions: [] };

    // Reply in the language this user configured under "Voice & Language"
    // (undefined for English keeps Hermes's default behaviour).
    const replyLanguage = langOption(getLanguage(session.user.id)).replyLanguage;

    const resp = await fetch(`${HERMES_URL}/agent/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(HERMES_API_KEY ? { "X-Hermes-Api-Key": HERMES_API_KEY } : {}),
      },
      body: JSON.stringify({
        message,
        jwt: session.access_token,
        image_base64: imageBase64,
        pdf_base64: pdfBase64,
        reply_language: replyLanguage,
      }),
    });
    if (!resp.ok) return { reply: FALLBACK_REPLY, tools_used: [], actions: [] };
    const data = await resp.json();
    return { reply: data.reply, tools_used: data.tools_used ?? [], actions: data.actions ?? [] };
  } catch {
    return { reply: FALLBACK_REPLY, tools_used: [], actions: [] };
  }
}

// Read a File/Blob into the raw base64 Hermes expects (data-URL prefix stripped).
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

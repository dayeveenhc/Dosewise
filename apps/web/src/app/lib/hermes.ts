import { supabase } from "./supabase";

const HERMES_URL = import.meta.env.VITE_HERMES_URL;

const FALLBACK_REPLY = "Sorry, something went wrong. Let me get a person to help.";

interface AgentTurnResponse {
  reply: string;
  tools_used: string[];
}

// Mirrors Hermes's /agent/turn contract (services/hermes/src/hermes/api/routes.py):
// the client forwards its Supabase session JWT, Hermes verifies it and acts as
// that elder. On any failure, fall back to a friendly message instead of a raw
// error — same pattern as the Telegram channel's try/except around run_agent_turn.
export async function agentTurn(
  message: string,
  imageBase64?: string
): Promise<AgentTurnResponse> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { reply: FALLBACK_REPLY, tools_used: [] };

    const resp = await fetch(`${HERMES_URL}/agent/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        jwt: session.access_token,
        image_base64: imageBase64,
      }),
    });
    if (!resp.ok) return { reply: FALLBACK_REPLY, tools_used: [] };
    return await resp.json();
  } catch {
    return { reply: FALLBACK_REPLY, tools_used: [] };
  }
}

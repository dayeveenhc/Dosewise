// Thin client for Hermes's /agent/turn contract (services/hermes/src/hermes/api/routes.py).
// Read-only reference to that file — nothing there is edited by this client.

export interface AgentTurnResponse {
  reply: string;
  tools_used: string[];
}

export async function agentTurn(message: string, jwt: string): Promise<AgentTurnResponse> {
  const res = await fetch(`${import.meta.env.VITE_HERMES_URL}/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, jwt }),
  });
  if (!res.ok) {
    throw new Error(`Hermes /agent/turn failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

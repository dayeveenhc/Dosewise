import { supabase } from "./supabase";
import { readStoredLanguage } from "./languageContext";
import { replyLanguageFor } from "./language";

const HERMES_URL = import.meta.env.VITE_HERMES_URL;
const HERMES_API_KEY = import.meta.env.VITE_HERMES_API_KEY;

// Friendly, class-specific fallbacks. A single opaque English line used to mask
// every failure (expired sign-in, rate limit, server error, network) as one
// message with no logging — which made real bugs invisible and looked like the
// agent "couldn't understand." Distinguish the classes: log the real cause to
// the console, and tell the user something they can act on.
const FALLBACK_GENERIC = "Sorry, something went wrong. Let me get a person to help.";
const FALLBACK_SIGNED_OUT = "You've been signed out. Please sign in again to keep chatting with Mei.";
const FALLBACK_RATE_LIMIT = "You're sending messages a little too fast. Please wait a moment and try again.";
const FALLBACK_UNREACHABLE = "I can't reach the assistant right now. Please check your connection and try again in a moment.";

function fallback(reply: string, rateLimited = false): AgentTurnResponse {
  // awaiting_confirmation is explicitly false: a sign-out/network/rate-limit
  // fallback must never paint confirm buttons under a reply nothing proposed.
  return { reply, tools_used: [], actions: [], walkthrough: null, choices: null, awaiting_confirmation: false, rateLimited };
}

// A tappable answer button the agent offered this turn (offer_choices tool):
// `label` is shown, `value` is sent as the person's next message when tapped.
export interface AgentChoice {
  label: string;
  value: string;
}

// One field's before/after on a committed write. `before` is null for a
// newly-created record. The UI builds its highlight caption from these.
export interface ChangedField {
  before: unknown;
  after: unknown;
}

// A write the agent actually committed this turn (never a mere proposal), so the
// UI can confirm it, redirect to the page that shows the change, and highlight
// the exact record that changed.
export interface AgentAction {
  tool: string;
  summary?: string;
  // What changed, not just that something changed (services/hermes tools/base.py
  // record_action). `entity_type`+`entity_id` locate the exact DOM element via
  // data-testid="{entity_type}-{entity_id}"; `changed_fields` builds the caption.
  // Optional so a tool mid-migration (or a channel that doesn't set them) parses.
  entity_type?: string;
  entity_id?: string;
  changed_fields?: Record<string, ChangedField>;
  // For add_prescription: the medication name, so the UI can highlight the exact
  // card that just landed on the timeline / medication list as visible proof.
  name?: string;
  // BULK actions (e.g. resolve_missed_doses): one record per affected entity, and
  // NO top-level entity_type/entity_id. Each entity's entity_id is the id the UI
  // can resolve to a card (for doses: the MEDICATION uuid); extra per-entity
  // fields (dose_id, slot, name, …) ride along untyped.
  entities?: Array<{
    entity_type: string;
    entity_id: string;
    changed_fields?: Record<string, ChangedField>;
    [k: string]: unknown;
  }>;
}

// Set when Mei's start_walkthrough tool ran this turn — the step content itself
// is resolved client-side, by task_name, from lib/walkthrough/steps/. `params`
// carries only VALUES the app injects into the walkthrough's fill/verify steps
// (e.g. {name, dose, purpose} for add_prescription_auto) — never selectors.
export interface WalkthroughPayload {
  task_name: string;
  params?: Record<string, string>;
}

interface AgentTurnResponse {
  reply: string;
  tools_used: string[];
  actions: AgentAction[];
  walkthrough: WalkthroughPayload | null;
  // Tappable answer buttons the agent offered this turn (offer_choices), or null.
  choices?: AgentChoice[] | null;
  // True when a tool PROPOSED something this turn and is waiting on a yes/no
  // (Hermes session.awaiting_confirmation). Deterministic, unlike `choices`,
  // which only exists if the model chose to call offer_choices — so the chat
  // synthesizes its own localized Yes/No pair from this when `choices` is empty.
  awaiting_confirmation?: boolean;
  // True only when this reply is the client-side rate-limit fallback (HTTP
  // 429), so the UI can render it as a system notice instead of a normal
  // agent answer.
  rateLimited?: boolean;
}

// A 429 from the shared per-user rate limiter is transient — the server tells us
// how long to wait via Retry-After. Rather than surfacing the error immediately
// (which tempts the user to re-send, adding MORE hits to the sliding window), we
// wait it out ONCE and retry, so a normal propose→confirm rhythm self-heals. The
// caller's `sending` guard keeps the input locked during the brief wait.
const RETRY_AFTER_CAP_MS = 8000;

async function postAgentTurn(path: string, jwt: string, body: Record<string, unknown>): Promise<Response> {
  const doFetch = () => fetch(`${HERMES_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(HERMES_API_KEY ? { "X-Hermes-Api-Key": HERMES_API_KEY } : {}),
    },
    body: JSON.stringify({ ...body, jwt }),
  });
  const resp = await doFetch();
  if (resp.status !== 429) return resp;
  const header = resp.headers.get("Retry-After");
  const secs = header ? Number(header) : NaN;
  const waitMs = Math.min(Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1500, RETRY_AFTER_CAP_MS);
  console.warn(`[dosewise] 429 from ${path}; waiting ${waitMs}ms then retrying once`);
  await new Promise(r => setTimeout(r, waitMs));
  return doFetch();
}

// Mirrors Hermes's /agent/turn contract (services/hermes/src/hermes/api/routes.py):
// the client forwards its Supabase session JWT, Hermes verifies it and acts as
// that elder. On any failure, fall back to a friendly message instead of a raw
// error — same pattern as the Telegram channel's try/except around run_agent_turn.
export async function agentTurn(
  message: string,
  imageBase64?: string,
  pdfBase64?: string,
  completedWalkthroughs?: string[],
  // Which shell is asking. Hermes only offers walkthroughs that can actually
  // run in it — the two shells have entirely different screens.
  appRole?: "elder" | "caregiver"
): Promise<AgentTurnResponse> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      console.warn("[dosewise] agentTurn: no Supabase session — user is signed out");
      return fallback(FALLBACK_SIGNED_OUT);
    }

    // Reply in the language configured under "Voice & Language"
    // (undefined for English keeps Hermes's default behaviour).
    const replyLanguage = replyLanguageFor(readStoredLanguage());

    const resp = await postAgentTurn("/agent/turn", session.access_token, {
      message,
      image_base64: imageBase64,
      pdf_base64: pdfBase64,
      reply_language: replyLanguage,
      completed_walkthroughs: completedWalkthroughs ?? [],
      app_role: appRole ?? "elder",
    });
    if (!resp.ok) {
      // Distinguish the failure classes that used to collapse into one message.
      const detail = await resp.text().catch(() => "");
      console.warn(`[dosewise] agentTurn: HTTP ${resp.status} from /agent/turn`, detail);
      if (resp.status === 401) return fallback(FALLBACK_SIGNED_OUT);
      if (resp.status === 429) return fallback(FALLBACK_RATE_LIMIT, true);
      return fallback(FALLBACK_GENERIC); // 4xx/5xx: server/provider-side issue
    }
    const data = await resp.json();
    return {
      reply: data.reply ?? "",
      tools_used: data.tools_used ?? [],
      actions: data.actions ?? [],
      walkthrough: data.walkthrough ?? null,
      choices: data.choices ?? null,
      awaiting_confirmation: data.awaiting_confirmation ?? false,
    };
  } catch (err) {
    // Network failure, CORS rejection, or malformed JSON — the request never got
    // a usable answer back.
    console.warn("[dosewise] agentTurn: request failed before a reply", err);
    return fallback(FALLBACK_UNREACHABLE);
  }
}

// A single SSE event from /agent/turn/stream. "tool_start"/"tool_end" arrive as
// the agent loop dispatches each tool call; the terminal "final" event carries
// the same fields as AgentTurnResponse (reply/tools_used/actions).
export interface AgentTurnEvent {
  type: "tool_start" | "tool_end" | "final";
  tool?: string;
  is_error?: boolean;
  // tool_end only: whether THIS dispatch actually committed a write (a tool can
  // run and return without writing — a propose/clarify turn). The chat screens
  // gate screen-navigation on this so a mere proposal doesn't yank the UI.
  committed?: boolean;
  reply?: string;
  tools_used?: string[];
  actions?: AgentAction[];
  walkthrough?: WalkthroughPayload | null;
  choices?: AgentChoice[] | null;
  awaiting_confirmation?: boolean;
}

// Streaming variant of agentTurn — same contract and fallback behaviour, but
// calls onEvent for each "tool_start"/"tool_end" as the agent loop runs, then
// resolves with the same AgentTurnResponse shape agentTurn returns. Uses
// fetch()'s streaming body reader rather than EventSource, since EventSource
// can't send a POST body or the JWT/API-key headers this endpoint needs.
export async function agentTurnStream(
  message: string,
  onEvent: (event: AgentTurnEvent) => void,
  imageBase64?: string,
  pdfBase64?: string,
  completedWalkthroughs?: string[],
  // Which shell is asking. Hermes only offers walkthroughs that can actually
  // run in it — the two shells have entirely different screens.
  appRole?: "elder" | "caregiver"
): Promise<AgentTurnResponse> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      console.warn("[dosewise] agentTurnStream: no Supabase session — user is signed out");
      return fallback(FALLBACK_SIGNED_OUT);
    }

    const replyLanguage = replyLanguageFor(readStoredLanguage());

    const resp = await postAgentTurn("/agent/turn/stream", session.access_token, {
      message,
      image_base64: imageBase64,
      pdf_base64: pdfBase64,
      reply_language: replyLanguage,
      completed_walkthroughs: completedWalkthroughs ?? [],
      app_role: appRole ?? "elder",
    });
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      console.warn(`[dosewise] agentTurnStream: HTTP ${resp.status} from /agent/turn/stream`, detail);
      if (resp.status === 401) return fallback(FALLBACK_SIGNED_OUT);
      if (resp.status === 429) return fallback(FALLBACK_RATE_LIMIT, true);
      return fallback(FALLBACK_GENERIC);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: AgentTurnResponse | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line ("\n\n").
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!frame.startsWith("data: ")) continue;
        const event: AgentTurnEvent = JSON.parse(frame.slice("data: ".length));
        if (event.type === "final") {
          result = {
            reply: event.reply ?? "",
            tools_used: event.tools_used ?? [],
            actions: event.actions ?? [],
            walkthrough: event.walkthrough ?? null,
            choices: event.choices ?? null,
            awaiting_confirmation: event.awaiting_confirmation ?? false,
          };
        } else {
          onEvent(event);
        }
      }
    }
    return result ?? fallback(FALLBACK_GENERIC);
  } catch (err) {
    console.warn("[dosewise] agentTurnStream: request failed before a reply", err);
    return fallback(FALLBACK_UNREACHABLE);
  }
}

// Structured fields read from an uploaded record by Hermes's /profile/extract
// "pull" endpoint (snake_case mirrors services/hermes/src/hermes/agent/extract.py).
export interface ExtractedMed {
  name?: string;
  dose?: string;
  time?: string;
}
export interface ExtractedProfile {
  full_name?: string;
  dob?: string;
  gender?: string;
  weight_kg?: number;
  height_cm?: number;
  conditions?: string[];
  allergies?: string[];
  drug_allergies?: string[];
  current_meds?: ExtractedMed[];
  past_meds?: ExtractedMed[];
}
export interface ExtractProfileResult {
  fields: ExtractedProfile;
  // A friendly reason the fields are empty (e.g. a scanned PDF), if any.
  note?: string;
}

// Pull structured profile fields from an uploaded PDF/image so the app can
// pre-fill a form the user reviews. Stateless on the server (no jwt needed —
// works during onboarding before an account exists), only the API key. On any
// failure returns empty fields so callers can fall back to manual entry.
export async function extractProfile(
  imageBase64?: string,
  pdfBase64?: string
): Promise<ExtractProfileResult> {
  try {
    const resp = await fetch(`${HERMES_URL}/profile/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(HERMES_API_KEY ? { "X-Hermes-Api-Key": HERMES_API_KEY } : {}),
      },
      body: JSON.stringify({ image_base64: imageBase64, pdf_base64: pdfBase64 }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.warn(`[dosewise] extractProfile: HTTP ${resp.status} from /profile/extract`, detail);
      return { fields: {} };
    }
    const data = await resp.json();
    return { fields: data.fields ?? {}, note: data.note ?? undefined };
  } catch (err) {
    console.warn("[dosewise] extractProfile: request failed before a reply", err);
    return { fields: {} };
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

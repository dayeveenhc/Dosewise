import { supabase } from "./supabase";

// Caregiver <-> elder linking over the existing public.care_links table. No new
// schema is needed: care_link_status already has a 'pending' state, RLS lets a
// caregiver INSERT a link naming themselves (with_check caregiver_id = auth.uid())
// and lets EITHER party UPDATE its status, and 0004 forbids deletes. So the whole
// flow is: elder shows a QR of their id -> caregiver scans + inserts a pending
// link -> elder flips it to 'active' (accept) or 'revoked' (reject).
//
// The elder can't read the caregiver's profile row (profiles RLS is self-or-
// linked-caregiver, and the link isn't active yet), so the caregiver's display
// name + relationship are stashed in the link's `permissions` jsonb at insert
// time — the elder is allowed to read the care_links row itself.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CareLinkPayload {
  app: "dosewise";
  kind: "care-link";
  v: 1;
  elderId: string;
  name?: string;
}

// The string encoded into the elder's QR code.
export function buildCareLinkPayload(elderId: string, name?: string): string {
  const payload: CareLinkPayload = { app: "dosewise", kind: "care-link", v: 1, elderId };
  if (name?.trim()) payload.name = name.trim();
  return JSON.stringify(payload);
}

// Parse a scanned string back into an elder id + display name, or null if it
// isn't one of our care-link QR codes.
export function parseCareLinkPayload(text: string): { elderId: string; name?: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const p = obj as Partial<CareLinkPayload>;
  if (p.app !== "dosewise" || p.kind !== "care-link") return null;
  if (typeof p.elderId !== "string" || !UUID_RE.test(p.elderId)) return null;
  return { elderId: p.elderId, name: typeof p.name === "string" ? p.name : undefined };
}

export type LinkRequestResult =
  | { status: "sent" }
  | { status: "already_active" }
  | { status: "already_pending" }
  | { status: "self" }
  | { status: "not_signed_in" }
  | { status: "error"; message: string };

// Caregiver-side: create (or re-arm) a pending link to the scanned elder. Runs as
// the signed-in caregiver, so caregiver_id is auth.uid(). Idempotent against the
// unique(elder_id, caregiver_id) constraint — re-scanning an existing link
// reports its current state rather than erroring.
export async function createLinkRequest(elderId: string, relationship: string): Promise<LinkRequestResult> {
  const { data: userData } = await supabase.auth.getUser();
  const caregiver = userData.user;
  if (!caregiver) return { status: "not_signed_in" };
  if (caregiver.id === elderId) return { status: "self" };

  const { data: me } = await supabase
    .from("profiles").select("full_name").eq("id", caregiver.id).maybeSingle();
  const caregiverName = me?.full_name?.trim() || caregiver.email?.split("@")[0] || "Your caregiver";

  const permissions = {
    requested_by_name: caregiverName,
    relationship: relationship.trim() || undefined,
  };

  // Is there already a link between this pair? (Either party can read it.)
  const { data: existing } = await supabase
    .from("care_links").select("id,status")
    .eq("elder_id", elderId).eq("caregiver_id", caregiver.id).maybeSingle();

  if (existing) {
    if (existing.status === "active") return { status: "already_active" };
    // Re-arm a previously pending/revoked link and refresh the stored name.
    const { error } = await supabase
      .from("care_links").update({ status: "pending", permissions }).eq("id", existing.id);
    if (error) return { status: "error", message: error.message };
    return existing.status === "pending" ? { status: "already_pending" } : { status: "sent" };
  }

  const { error } = await supabase.from("care_links").insert({
    elder_id: elderId,
    caregiver_id: caregiver.id,
    relationship: relationship.trim() || null,
    status: "pending",
    permissions,
  });
  if (error) return { status: "error", message: error.message };
  return { status: "sent" };
}

export interface PendingLinkRequest {
  id: string;
  caregiverName: string;
  relationship: string | null;
  requestedAt: string;
}

// Elder-side: incoming link requests awaiting a decision.
export async function fetchPendingLinkRequests(elderId: string): Promise<PendingLinkRequest[]> {
  const { data } = await supabase
    .from("care_links")
    .select("id,relationship,permissions,created_at")
    .eq("elder_id", elderId).eq("status", "pending")
    .order("created_at", { ascending: false });
  return (data ?? []).map(row => {
    const perms = (row.permissions ?? {}) as { requested_by_name?: string };
    return {
      id: row.id as string,
      caregiverName: perms.requested_by_name?.trim() || "A caregiver",
      relationship: (row.relationship as string | null) ?? null,
      requestedAt: row.created_at as string,
    };
  });
}

// Elder-side: accept (-> active) or reject (-> revoked). Delete is blocked by RLS,
// so a rejection is a status flip, keeping the audit trail.
export async function respondToLinkRequest(linkId: string, accept: boolean): Promise<boolean> {
  const { error } = await supabase
    .from("care_links").update({ status: accept ? "active" : "revoked" }).eq("id", linkId);
  return !error;
}

// Elder-side: does the elder have at least one ACTIVE caregiver link? Used by the
// accept-caregiver-link walkthrough's Verify phase to re-query real state after
// the elder taps Accept — never trusting the update's own return.
export async function hasActiveCareLink(elderId: string): Promise<boolean> {
  const { data } = await supabase
    .from("care_links")
    .select("id")
    .eq("elder_id", elderId).eq("status", "active")
    .limit(1);
  return (data ?? []).length > 0;
}

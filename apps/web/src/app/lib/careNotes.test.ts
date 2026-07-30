import { describe, it, expect, vi, beforeEach } from "vitest";

// lib/supabase throws at module load without env vars, so it's mocked with a
// minimal chainable query stub whose terminal result each test sets.
const mocks = vi.hoisted(() => {
  const result: { data: unknown; error: { message: string } | null } = { data: null, error: null };
  const order = vi.fn(async () => result);
  const eqTool = vi.fn(() => ({ order }));
  const eqElder = vi.fn(() => ({ eq: eqTool }));
  const select = vi.fn(() => ({ eq: eqElder }));
  const from = vi.fn(() => ({ select }));
  return { result, order, eqTool, eqElder, select, from };
});

vi.mock("./supabase", () => ({ supabase: { from: mocks.from } }));

import { fetchCareNotes } from "./careNotes";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.result.data = null;
  mocks.result.error = null;
});

describe("fetchCareNotes — add_care_note conversation_turns → CareNote mapping", () => {
  it("queries the signed-in user's add_care_note turns, newest first", async () => {
    mocks.result.data = [];
    await fetchCareNotes("user-1");
    expect(mocks.from).toHaveBeenCalledWith("conversation_turns");
    expect(mocks.select).toHaveBeenCalledWith("id,transcript,created_at");
    expect(mocks.eqElder).toHaveBeenCalledWith("elder_id", "user-1");
    expect(mocks.eqTool).toHaveBeenCalledWith("tool", "add_care_note");
    expect(mocks.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("maps rows to {id, body, time} and drops blank transcripts", async () => {
    mocks.result.data = [
      { id: "n1", transcript: "Mom seemed tired today", created_at: "2026-01-05T02:00:00Z" },
      { id: "n2", transcript: "   ", created_at: "2026-01-05T03:00:00Z" },
      { id: "n3", transcript: null, created_at: "2026-01-05T04:00:00Z" },
    ];
    const notes = await fetchCareNotes("user-1");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: "n1", body: "Mom seemed tired today" });
    // An older-day timestamp formats as day + short month, not a clock time.
    expect(notes[0].time).toMatch(/Jan/);
  });

  it("formats a same-day note as a clock time", async () => {
    mocks.result.data = [{ id: "n1", transcript: "Ate well", created_at: new Date().toISOString() }];
    const [note] = await fetchCareNotes("user-1");
    expect(note.time).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns [] on a query error instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.result.error = { message: "boom" };
    await expect(fetchCareNotes("user-1")).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

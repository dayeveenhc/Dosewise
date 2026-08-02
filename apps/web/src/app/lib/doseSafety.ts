// A last sanity check between "what was typed" and "what gets saved as a dose".
// Deliberately NOT clinical advice: it knows nothing about any specific drug's
// real ceiling — it only catches the counts that are implausible for ANY tablet
// (a slipped digit, "10" where "1.0" was meant, a per-day total typed into a
// per-dose box) and asks the person to confirm. Anything it isn't sure about it
// stays silent on, since a false alarm on every save teaches people to tap
// through the one that matters.

// Only units that are COUNTED. "500 mg" or "5 ml" are strengths/volumes, where a
// big number is normal and means nothing about how many things are swallowed.
const COUNTABLE = /\b(tablet|tablets|tab|tabs|pill|pills|capsule|capsules|cap|caps)\b/i;

// Leading quantity: "2", "1.5", "1/2", "½".
const HALVES: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75 };
const LEADING = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+))?/;

export function parseDoseCount(dose: string): number | null {
  const trimmed = dose.trim();
  if (!trimmed) return null;
  const glyph = HALVES[trimmed[0]];
  if (glyph !== undefined) return glyph;
  const m = trimmed.match(LEADING);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  // "1/2 tablet" — a fraction, never a concern.
  if (m[2]) {
    const d = Number(m[2]);
    return d > 0 ? n / d : null;
  }
  return n;
}

// Above these, ask. Four of anything in one go, or eight across a day, is past
// what an ordinary tablet regimen looks like for the people this app is for.
export const MAX_PER_DOSE = 4;
export const MAX_PER_DAY = 8;

export interface DoseConcern {
  kind: "perDose" | "perDay";
  perDose: number;
  perDay: number;
}

/**
 * Returns what looks wrong about `dose` taken `timesPerDay` times, or null when
 * there's nothing to flag (including every case it can't read confidently).
 */
export function checkDoseSafety(dose: string, timesPerDay: number): DoseConcern | null {
  if (!COUNTABLE.test(dose)) return null;
  const perDose = parseDoseCount(dose);
  if (perDose === null || perDose <= 0) return null;
  const perDay = perDose * Math.max(1, timesPerDay);
  if (perDose > MAX_PER_DOSE) return { kind: "perDose", perDose, perDay };
  if (perDay > MAX_PER_DAY) return { kind: "perDay", perDose, perDay };
  return null;
}

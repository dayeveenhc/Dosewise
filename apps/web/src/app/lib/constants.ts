// (The old DASH_DAYS weekday abbreviations lived here. They were rendered raw,
// so the caregiver timeline's week strip stayed English in every language —
// they're now the `day.0`…`day.6` keys, translated in all six.)

// The destinations Travel Mode offers. Lives here, not in TravelModeSheet, so
// the walkthrough step builder can resolve against it WITHOUT importing a
// screen (which would drag lib/profile → lib/supabase into the vitest import
// graph, whose module-load throw breaks it — same rule lib/walkthrough/verify.ts
// documents).
//
// These strings are the <option> VALUES: the options carry no value attribute,
// so each option's value is exactly its text content. Four contain an em-dash
// (U+2014). Getting one character wrong does not "miss" — it sets
// selectedIndex = -1 and BLANKS the field.
export const TIMEZONES = [
  "Singapore (UTC+8)", "Malaysia (UTC+8)", "Thailand (UTC+7)", "Indonesia — Jakarta (UTC+7)",
  "Japan (UTC+9)", "South Korea (UTC+9)", "China (UTC+8)", "Hong Kong (UTC+8)",
  "Taiwan (UTC+8)", "Vietnam (UTC+7)", "Philippines (UTC+8)",
  "Australia — Sydney (UTC+11)", "India (UTC+5:30)", "United Kingdom (UTC+0)",
  "USA — New York (UTC-5)", "USA — Los Angeles (UTC-8)", "UAE — Dubai (UTC+4)",
];

// What Mei (or a person) plausibly says for each option: IANA zone ids, bare
// city/country names, common abbreviations. DELIBERATELY an explicit table
// rather than fuzzy string distance — a travel plan silently saved against the
// wrong country is far worse than one that honestly declines to guess.
const TIMEZONE_ALIASES: Record<string, string[]> = {
  "Singapore (UTC+8)": ["asia/singapore", "singapore", "sg"],
  "Malaysia (UTC+8)": ["asia/kuala lumpur", "kuala lumpur", "malaysia", "kl"],
  "Thailand (UTC+7)": ["asia/bangkok", "bangkok", "thailand"],
  "Indonesia — Jakarta (UTC+7)": ["asia/jakarta", "jakarta", "indonesia"],
  "Japan (UTC+9)": ["asia/tokyo", "tokyo", "japan", "jst"],
  "South Korea (UTC+9)": ["asia/seoul", "seoul", "south korea", "korea", "kst"],
  "China (UTC+8)": ["asia/shanghai", "asia/beijing", "shanghai", "beijing", "china"],
  "Hong Kong (UTC+8)": ["asia/hong kong", "hong kong", "hk"],
  "Taiwan (UTC+8)": ["asia/taipei", "taipei", "taiwan"],
  "Vietnam (UTC+7)": ["asia/ho chi minh", "ho chi minh", "hanoi", "vietnam"],
  "Philippines (UTC+8)": ["asia/manila", "manila", "philippines"],
  "Australia — Sydney (UTC+11)": ["australia/sydney", "sydney", "australia"],
  "India (UTC+5:30)": ["asia/kolkata", "asia/calcutta", "kolkata", "mumbai", "delhi", "new delhi", "india", "ist"],
  "United Kingdom (UTC+0)": ["europe/london", "london", "united kingdom", "uk", "england", "britain"],
  "USA — New York (UTC-5)": ["america/new york", "new york", "nyc", "est"],
  "USA — Los Angeles (UTC-8)": ["america/los angeles", "los angeles", "san francisco", "california", "pst"],
  "UAE — Dubai (UTC+4)": ["asia/dubai", "dubai", "uae", "abu dhabi"],
};

// Fold the spellings that differ only cosmetically: case, surrounding space,
// underscores in IANA ids, and em/en-dashes vs a plain hyphen.
const norm = (s: string): string =>
  s.trim().toLowerCase().replace(/[—–]/g, "-").replace(/_/g, " ").replace(/\s+/g, " ");

// "UTC+9" / "utc+09:00" / "+9" all mean the same offset; "(UTC+5:30)" keeps its
// minutes. Returns null for anything that isn't an offset at all.
function normOffset(s: string): string | null {
  const m = norm(s).replace(/utc|gmt/g, "").trim().match(/^([+-])\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const mins = m[3] && m[3] !== "00" ? `:${m[3]}` : "";
  return `${m[1]}${Number(m[2])}${mins}`;
}

const offsetOf = (label: string): string | null => {
  const inner = label.match(/\(([^)]+)\)/)?.[1];
  return inner ? normOffset(inner) : null;
};

// The label without its offset — "Indonesia — Jakarta (UTC+7)" → "indonesia - jakarta".
const placeOf = (label: string): string => norm(label.replace(/\s*\([^)]*\)\s*$/, ""));

const BY_ALIAS: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const label of TIMEZONES) {
    map.set(norm(label), label);
    map.set(placeOf(label), label);
    // Each side of a "Country — City" label on its own ("usa", "sydney").
    for (const part of placeOf(label).split("-")) {
      const key = part.trim();
      if (key && !map.has(key)) map.set(key, label);
    }
  }
  for (const [label, aliases] of Object.entries(TIMEZONE_ALIASES)) {
    for (const alias of aliases) if (!map.has(norm(alias))) map.set(norm(alias), label);
  }
  return map;
})();

/**
 * Resolve whatever was asked for to one of the exact TIMEZONES strings, or null
 * if it can't be resolved confidently.
 *
 * This exists because the timezone arrives as a free-text `start_walkthrough`
 * param: an LLM will happily send "Asia/Tokyo", "Tokyo", "JST" or "UTC+9" for
 * what the <select> spells "Japan (UTC+9)". Assigning any of those to the
 * element blanks it, and the blank then persists — which is the "travel mode
 * did not fill in the time zone correctly" report.
 */
export function resolveTimezone(input: string | null | undefined): string | null {
  if (!input) return null;
  const key = norm(input);
  const direct = BY_ALIAS.get(key);
  if (direct) return direct;
  // Last resort: a bare offset. Ambiguous by nature (UTC+8 has five options),
  // so take the first — the list is ordered by how likely this app's users are
  // to travel there, and an offset is all the person actually specified.
  const wanted = normOffset(input);
  return wanted ? TIMEZONES.find(label => offsetOf(label) === wanted) ?? null : null;
}

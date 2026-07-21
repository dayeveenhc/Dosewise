import { useId } from "react";

export type PillShape = "round" | "oval" | "capsule" | "lotion" | "droplet";

const GREY_FILL = "#D9D9D9";
const GREY_STROKE = "#9CA3AF";
// Score/split lines sit on top of a fill that's sometimes light, sometimes a
// saturated medication colour — a stroke matching the fill (or even white)
// disappears on one side or the other. A translucent dark line darkens
// whatever it sits on instead, so it reads the same regardless of fill.
const DETAIL_LINE = "rgba(0,0,0,0.35)";

// Lightens (amt > 0) or darkens (amt < 0) a #rrggbb / #rgb colour by blending
// toward white/black — used to build each shape's own top-to-bottom gradient
// instead of a flat fill, for a bit of dimension.
function adjust(hex: string, amt: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return hex;
  const channel = (shift: number) => {
    const c = (num >> shift) & 255;
    const adjusted = amt >= 0 ? c + (255 - c) * amt : c + c * amt;
    return Math.max(0, Math.min(255, Math.round(adjusted)));
  };
  const [r, g, b] = [channel(16), channel(8), channel(0)];
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

// Deterministic small hash so a medication outside the demo catalog (no
// MED_SHAPES entry) still gets a stable, distinct-looking tablet shape rather
// than every unknown medication collapsing onto the same glyph. Restricted to
// the three solid-dose shapes — lotion/droplet are only ever picked by an
// explicit keyword match (a hash landing on "lotion bottle" for a plain
// tablet would be actively misleading).
function hashShape(name: string): PillShape {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const shapes: PillShape[] = ["round", "oval", "capsule"];
  return shapes[h % shapes.length];
}

// Maps a medication's name and data/medications.ts's free-text MED_SHAPES
// description to a shape: creams/lotions/ointments get a bottle, anything
// "drop(s)" (eye drops etc.) gets a water droplet, tablets/capsules match by
// keyword, and anything else falls back to a stable per-name hash.
export function shapeFor(name: string, catalogShape?: string): PillShape {
  const n = name.toLowerCase();
  const s = catalogShape?.toLowerCase() ?? "";
  if (n.includes("cream") || n.includes("lotion") || n.includes("ointment")) return "lotion";
  if (n.includes("drop") || s.includes("drop")) return "droplet";
  if (s.includes("capsule")) return "capsule";
  if (s.includes("oval")) return "oval";
  if (s.includes("round")) return "round";
  return hashShape(name);
}

// A small per-medication pill glyph for the dashboard's "doses today" row:
// tinted with the medication's own colour once taken, grey until then, with
// a gradient + gloss highlight on each shape for some dimension instead of a
// flat silhouette, and shape geometry chosen to actually read as that form
// (a two-tone capsule, a scored tablet, a squeeze bottle, a droplet) rather
// than variations on an oval.
export function PillIcon({ shape, colour, filled, size = 24 }: {
  shape: PillShape;
  colour: string;
  filled: boolean;
  size?: number;
}) {
  const base = filled ? colour : GREY_FILL;
  const stroke = filled ? adjust(colour, -0.25) : GREY_STROKE;
  const light = adjust(base, 0.32);
  const dark = adjust(base, -0.18);
  const uid = useId().replace(/[:]/g, "");
  const gradMain = `pg-main-${uid}`;
  const gradPale = `pg-pale-${uid}`;
  const clipId = `pg-clip-${uid}`;

  const gradients = (
    <defs>
      <linearGradient id={gradMain} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={light} />
        <stop offset="1" stopColor={dark} />
      </linearGradient>
      <linearGradient id={gradPale} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#FDFCFA" />
        <stop offset="1" stopColor={filled ? "#E8E4DA" : "#C7C7C7"} />
      </linearGradient>
    </defs>
  );

  if (shape === "capsule") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        {gradients}
        <defs><clipPath id={clipId}><rect x="1.5" y="8.5" width="21" height="7" rx="3.5" /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          <rect x="1.5" y="8.5" width="10.5" height="7" fill={`url(#${gradMain})`} />
          <rect x="12" y="8.5" width="10.5" height="7" fill={`url(#${gradPale})`} />
          <ellipse cx="6.5" cy="10.2" rx="2.6" ry="0.9" fill="white" fillOpacity={0.45} />
        </g>
        <rect x="1.5" y="8.5" width="21" height="7" rx="3.5" fill="none" stroke={stroke} strokeWidth={1.1} />
        <line x1="12" y1="8.5" x2="12" y2="15.5" stroke={DETAIL_LINE} strokeWidth={1} />
      </svg>
    );
  }

  if (shape === "lotion") {
    // A squeeze bottle: cap, neck, rounded body — horizontal gradient plus a
    // vertical highlight streak reads as a cylindrical container.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <defs>
          <linearGradient id={gradMain} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={light} />
            <stop offset="0.55" stopColor={base} />
            <stop offset="1" stopColor={dark} />
          </linearGradient>
        </defs>
        <rect x="9.5" y="2" width="5" height="2.2" rx="0.7" fill={adjust(stroke, -0.1)} />
        <rect x="10" y="4.2" width="4" height="2" fill={dark} />
        <path d="M7.5 6.2h9a1.5 1.5 0 0 1 1.5 1.5v13a1.3 1.3 0 0 1-1.3 1.3H7.3A1.3 1.3 0 0 1 6 20.7v-13a1.5 1.5 0 0 1 1.5-1.5Z" fill={`url(#${gradMain})`} stroke={stroke} strokeWidth={1} />
        <rect x="8.2" y="8" width="2" height="11" rx="1" fill="white" fillOpacity={0.3} />
        <rect x="6.7" y="12.5" width="10.6" height="3" fill="white" fillOpacity={filled ? 0.22 : 0.35} />
      </svg>
    );
  }

  if (shape === "droplet") {
    // A single glossy water drop — eye drops, liquids.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        {gradients}
        <path d="M12 3C12 3 5 12.3 5 16.3a7 7 0 0 0 14 0C19 12.3 12 3 12 3Z" fill={`url(#${gradMain})`} stroke={stroke} strokeWidth={1} strokeLinejoin="round" />
        <ellipse cx="9.7" cy="14.2" rx="1.8" ry="2.6" fill="white" fillOpacity={0.4} transform="rotate(-18 9.7 14.2)" />
      </svg>
    );
  }

  if (shape === "oval") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        {gradients}
        <ellipse cx="12" cy="12" rx="10" ry="6" fill={`url(#${gradMain})`} stroke={stroke} strokeWidth={1.1} />
        <line x1="12" y1="7" x2="12" y2="17" stroke={DETAIL_LINE} strokeWidth={1} />
        <ellipse cx="8.5" cy="9.5" rx="2.6" ry="1" fill="white" fillOpacity={0.4} transform="rotate(-20 8.5 9.5)" />
      </svg>
    );
  }

  // Round tablet.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      {gradients}
      <circle cx="12" cy="12" r="9" fill={`url(#${gradMain})`} stroke={stroke} strokeWidth={1.1} />
      <line x1="4.5" y1="12" x2="19.5" y2="12" stroke={DETAIL_LINE} strokeWidth={1} />
      <ellipse cx="8.8" cy="8.5" rx="2.4" ry="1.3" fill="white" fillOpacity={0.4} transform="rotate(-25 8.8 8.5)" />
    </svg>
  );
}

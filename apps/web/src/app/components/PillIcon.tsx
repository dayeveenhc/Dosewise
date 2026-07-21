import { useId } from "react";

export type PillShape = "round" | "oval" | "capsule" | "lotion" | "droplet";

const NOT_FILLED_FILL = "#D9D9D9";
const NOT_FILLED_STROKE = "#9CA3AF";
// Fixed regardless of the fill colour — a stroke matching the fill or white
// disappears against a same-toned or light-grey background.
const SCORE_STROKE = "rgba(0,0,0,0.35)";

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Positive amount lightens toward white, negative darkens toward black.
function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (amount >= 0) return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
  return rgbToHex(r * (1 + amount), g * (1 + amount), b * (1 + amount));
}

// Which real-world shape to draw for a medication. Keyword matches first
// (lotion/droplet are keyword-only — never picked by the hash fallback),
// then the catalog's own shape description, then a deterministic hash so an
// unknown medication still gets a stable (if arbitrary) shape rather than a
// random one on every render.
export function shapeFor(name: string, catalogShape?: string): PillShape {
  const n = name.toLowerCase();
  const s = (catalogShape ?? "").toLowerCase();
  if (n.includes("cream") || n.includes("lotion") || n.includes("ointment")) return "lotion";
  if (n.includes("drop") || s.includes("drop")) return "droplet";
  if (s.includes("capsule")) return "capsule";
  if (s.includes("oval")) return "oval";
  if (s.includes("round")) return "round";
  let hash = 0;
  for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) | 0;
  const fallback: PillShape[] = ["round", "oval", "capsule"];
  return fallback[Math.abs(hash) % fallback.length];
}

export function PillIcon({ shape, colour, filled, size = 24 }: { shape: PillShape; colour: string; filled: boolean; size?: number }) {
  const uid = useId();
  const base = filled ? colour : NOT_FILLED_FILL;
  const light = shade(base, filled ? 0.35 : 0.5);
  const dark = shade(base, filled ? -0.25 : -0.1);
  const stroke = filled ? shade(base, -0.35) : NOT_FILLED_STROKE;
  const gradId = `pill-grad-${uid}`;

  // Diagonal by default ("lighter toward one edge, darker toward the
  // other"); lotion overrides this with an explicitly horizontal gradient.
  const gradient = (x2: string, y2: string) => (
    <linearGradient id={gradId} x1="0%" y1="0%" x2={x2} y2={y2}>
      <stop offset="0%" stopColor={light} />
      <stop offset="100%" stopColor={dark} />
    </linearGradient>
  );

  if (shape === "round") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <defs>{gradient("100%", "100%")}</defs>
        <circle cx="12" cy="12" r="9.5" fill={`url(#${gradId})`} stroke={stroke} strokeWidth="1" />
        <line x1="12" y1="4" x2="12" y2="20" stroke={SCORE_STROKE} strokeWidth="1" />
        <ellipse cx="8.5" cy="8" rx="3" ry="1.8" fill="white" opacity="0.5" transform="rotate(-30 8.5 8)" />
      </svg>
    );
  }

  if (shape === "oval") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <defs>{gradient("100%", "100%")}</defs>
        <ellipse cx="12" cy="12" rx="9.5" ry="6.5" fill={`url(#${gradId})`} stroke={stroke} strokeWidth="1" />
        <line x1="4" y1="12" x2="20" y2="12" stroke={SCORE_STROKE} strokeWidth="1" />
        <ellipse cx="8" cy="9.5" rx="2.6" ry="1.4" fill="white" opacity="0.5" transform="rotate(-20 8 9.5)" />
      </svg>
    );
  }

  if (shape === "capsule") {
    const paleGradId = `pill-pale-${uid}`;
    const clipId = `pill-clip-${uid}`;
    const paleLight = shade(NOT_FILLED_FILL, 0.5);
    const paleDark = shade(NOT_FILLED_FILL, -0.1);
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <defs>
          {gradient("100%", "100%")}
          <linearGradient id={paleGradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={paleLight} />
            <stop offset="100%" stopColor={paleDark} />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x="2" y="8" width="20" height="8" rx="4" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect x="2" y="8" width="10" height="8" fill={`url(#${gradId})`} />
          <rect x="12" y="8" width="10" height="8" fill={`url(#${paleGradId})`} />
        </g>
        <rect x="2" y="8" width="20" height="8" rx="4" fill="none" stroke={stroke} strokeWidth="1" />
        <ellipse cx="7" cy="10.3" rx="2.4" ry="1" fill="white" opacity="0.5" transform="rotate(-10 7 10.3)" />
      </svg>
    );
  }

  if (shape === "lotion") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <defs>{gradient("100%", "0%")}</defs>
        <rect x="9" y="2" width="6" height="3" rx="1" fill={dark} />
        <rect x="10" y="4.5" width="4" height="2.5" fill={dark} />
        <rect x="5" y="7" width="14" height="15" rx="3" fill={`url(#${gradId})`} stroke={stroke} strokeWidth="1" />
        <rect x="8" y="9.5" width="2" height="10" rx="1" fill="white" opacity="0.45" />
      </svg>
    );
  }

  // droplet
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <defs>{gradient("100%", "100%")}</defs>
      <path d="M12 2 C12 2 5 11 5 15.5 C5 19.6 8.13 22 12 22 C15.87 22 19 19.6 19 15.5 C19 11 12 2 12 2 Z" fill={`url(#${gradId})`} stroke={stroke} strokeWidth="1" />
      <ellipse cx="9.5" cy="14" rx="2" ry="3" fill="white" opacity="0.4" transform="rotate(-15 9.5 14)" />
    </svg>
  );
}

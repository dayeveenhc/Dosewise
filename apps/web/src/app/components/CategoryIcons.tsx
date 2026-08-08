// The four "Ask Mei" category glyphs. Drawn here rather than taken from lucide
// because these four are the screen's largest, most-looked-at icons and each one
// carries a specific picture (hands cupping a heart, a bottle with a capsule, a
// palette, a person) that lucide's single-concept glyphs don't.
//
// Stroked in `currentColor` on a 512 grid, so they take the app's palette from
// whatever text colour the caller sets (`text-primary`) and follow the dark and
// high-contrast themes for free — same contract as the lucide icons beside them.
// The `size` prop matches lucide's so a call site can swap either way.

type IconProps = { size?: number; className?: string };

// 34 on the 512 grid ≈ 2px at the 30px tile size — matched to lucide's default
// weight so a tile glyph doesn't read as lighter than the row icons under it.
const STROKE = 34;

function Svg({ size = 24, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 512 512"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Two hands cupping a heart — the "care / people" category. The hand is drawn
// once and mirrored, so the pair stays symmetrical about the heart's point.
const HAND = "M112 476 V424 c0 -18 -7 -35 -20 -48 L46 310 C34 298 26 281 26 263 V100 a25 25 0 0 1 50 0 l15 158 l97 97 a25 25 0 0 1 22 26 V476 Z";

export function HandsHeartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M256 272 L152 168 A73.5 73.5 0 0 1 256 64 A73.5 73.5 0 0 1 360 168 Z" />
      <path d={HAND} />
      <path d={HAND} transform="translate(512 0) scale(-1 1)" />
    </Svg>
  );
}

// A pill bottle with a capsule lying across it — the "medicines" category. The
// bottle's right edge and base stop where the capsule crosses them, so the
// capsule reads as sitting in front rather than as crossed lines.
export function PillBottleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="68" y="18" width="222" height="84" rx="24" />
      <path d="M96 102 V150 L46 222 C38 230 34 240 34 252 V424 a46 46 0 0 0 46 46 H278" />
      <path d="M262 102 V150 L312 222 c8 8 12 18 12 30 V300" />
      <path d="M34 252 H324" />
      <path d="M34 400 H240" />
      <path d="M178 286 V370 M136 328 H220" />
      <path d="M256.2 368.2 L386.2 238.2 A62 62 0 0 1 473.8 325.8 L343.8 455.8 A62 62 0 0 1 256.2 368.2 Z" />
      <path d="M310.8 313.6 L398.4 401.2" />
    </Svg>
  );
}

// An artist's palette with a brush laid over it — the "display / appearance"
// category. Like the capsule above, the palette's outline breaks either side of
// the brush handle instead of running through it.
export function PaletteBrushIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M391 177 C340 120 250 62 178 66 C96 70 40 130 36 208 c-2 38 24 54 24 90 c0 36 -28 50 -24 88 c10 74 108 112 206 90 c92 -22 176 -110 195 -253" />
      <circle cx="200" cy="124" r="30" />
      <circle cx="100" cy="190" r="30" />
      <circle cx="300" cy="180" r="30" />
      <circle cx="104" cy="372" r="30" />
      <path d="M299.4 269.4 C352 206 432 144 480.2 118.2 A11 11 0 0 1 495.8 133.8 C470 184 408 264 344.6 314.6 Z" />
      <path d="M299.4 269.4 C266 296 250 330 248 364 c-2 24 26 34 44 20 c22 -18 40 -46 52.6 -69.4" />
    </Svg>
  );
}

// A clipboard with a check badge over its corner — the caregiver's "check-ins"
// category. The reference's inner page outline and second small tick are left
// out on purpose: the caregiver tiles render at 21px, where those two turn to
// mush and cost the badge its clarity.
export function ClipboardCheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M140 66 a40 40 0 0 1 80 0" />
      <rect x="112" y="66" width="136" height="52" rx="16" />
      <path d="M112 78 H44 a28 28 0 0 0 -28 28 V458 a28 28 0 0 0 28 28 H296" />
      <path d="M248 78 H318 a28 28 0 0 1 28 28 V200" />
      <path d="M78 170 H210" />
      <path d="M78 262 H175" />
      <path d="M78 354 H148" />
      <circle cx="348" cy="344" r="140" />
      {/* Heavier than the outlines around it — the reference draws this tick as
          a filled shape, and a same-weight stroke reads as an afterthought. */}
      <path d="M272 344 L328 402 L424 280" strokeWidth={44} />
    </Svg>
  );
}

// Three slider rows — the caregiver's "app settings" category. Each track stops
// at its knob rather than running behind it, which is what keeps the knobs
// legible once the whole icon is 21px wide.
export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="145" cy="96" r="52" />
      <path d="M30 96 H59 M231 96 H482" />
      <circle cx="360" cy="256" r="52" />
      <path d="M30 256 H274 M446 256 H482" />
      <circle cx="215" cy="416" r="52" />
      <path d="M30 416 H129 M301 416 H482" />
    </Svg>
  );
}

// Head and shoulders — the "my details" category.
export function PersonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="256" cy="148" r="110" />
      <path d="M40 432 V404 C40 336 78 296 118 272 a26 26 0 0 1 34 10 C186 300 220 314 256 314 S326 300 360 282 a26 26 0 0 1 34 -10 C434 296 472 336 472 404 V432 a46 46 0 0 1 -46 46 H86 a46 46 0 0 1 -46 -46 Z" />
    </Svg>
  );
}

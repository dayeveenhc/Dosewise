import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Circle, X, ChevronDown, Plus, QrCode } from "lucide-react";
import type { MedStatus, Patient } from "../types";
import type { TimeFormat } from "../accessibility";
import { formatClockAt } from "../lib/medications";
import { MED_PHOTOS, MED_PHOTO_FALLBACKS } from "../data/medications";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

// Deterministic index per medication name, so a given medicine always draws the
// same fallback photo instead of jittering between renders.
function nameHash(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

// Every medicine shows a photo now — a bundled one where we have it, otherwise a
// deterministic generic medicine photo. Both are illustrative stock imagery
// rather than the real pill; MED_SHAPES is the accurate physical identifier.
export function medPhoto(name: string): string {
  return MED_PHOTOS[name] ?? MED_PHOTO_FALLBACKS[nameHash(name) % MED_PHOTO_FALLBACKS.length];
}

export function MedAvatar({ name, size, className = "" }: { name: string; size: number; className?: string }) {
  return (
    <img
      src={medPhoto(name)}
      alt=""
      style={{ width: size, height: size }}
      className={`object-cover bg-muted ${className}`}
    />
  );
}

// A person's own profile photo, not a medicine's — falls back to a plain
// silhouette (never stock imagery) once they haven't uploaded one.
export function ProfileAvatar({ photo, size, className = "" }: { photo?: string; size: number; className?: string }) {
  if (photo) {
    return <img src={photo} alt="" style={{ width: size, height: size }} className={`object-cover bg-muted ${className}`} />;
  }
  return (
    <div style={{ width: size, height: size }} className={`relative shrink-0 overflow-hidden bg-muted text-muted-foreground ${className}`}>
      {/* Plain inline transform, not Tailwind's top-1/2/-translate-x-1/2
          utilities: Tailwind v4 compiles those to the standalone CSS
          `translate` property rather than `transform: translate(...)`, which
          is real but newer and not guaranteed everywhere `transform` is —
          this keeps centering on the one mechanism every renderer supports. */}
      {/* Hand-rolled FILLED silhouette, not lucide's User — lucide ships
          outline glyphs, and an empty avatar should read as the familiar
          solid placeholder person (same rationale as the status-bar icons
          below). currentColor keeps it on text-muted-foreground. */}
      <svg
        width={Math.round(size * 0.55)}
        height={Math.round(size * 0.55)}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}
      >
        <circle cx="12" cy="7.2" r="4.4" />
        <path d="M12 13.4c-5.2 0-8.4 2.7-8.4 6.4 0 .9.7 1.6 1.6 1.6h13.6c.9 0 1.6-.7 1.6-1.6 0-3.7-3.2-6.4-8.4-6.4z" />
      </svg>
    </div>
  );
}

// --- iOS-style status bar -------------------------------------------------
// The icons are hand-rolled inline SVG rather than lucide's Wifi/Battery/Signal.
// Those are OUTLINE glyphs on a 24px grid; iOS uses filled shapes — a solid
// 4-bar ladder, a filled fan, a rounded capsule with a nub — so lucide would
// read as "some icons", not as an iPhone. Inline SVG needs no dependency, and
// the bar already hand-rolled its signal bars for the same reason.
//
// Everything is currentColor so the bar keeps tracking the theme (and the
// contrast/colour-vision variants) exactly as it always has.

function CellularBars() {
  // Four ascending bars, all full — this is mockup chrome, like the old ones.
  return (
    <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor" aria-hidden="true">
      {[0, 1, 2, 3].map(i => (
        <rect key={i} x={i * 4.5} y={8 - i * 2.4} width="3" height={3 + i * 2.4} rx="1" />
      ))}
    </svg>
  );
}

function WifiFan() {
  // Three nested arcs + a dot, drawn as filled wedges the way iOS does it
  // rather than as stroked arcs.
  return (
    <svg width="15" height="11" viewBox="0 0 15 11" fill="currentColor" aria-hidden="true">
      <path d="M7.5 9.6 5.55 7.5a2.9 2.9 0 0 1 3.9 0L7.5 9.6Z" />
      <path d="M7.5 4.6c1.42 0 2.72.52 3.7 1.38l-1.16 1.2A4.2 4.2 0 0 0 7.5 6.05a4.2 4.2 0 0 0-2.54.85l-1.16-1.2A5.53 5.53 0 0 1 7.5 4.6Z" />
      <path d="M7.5 1.2c2.32 0 4.44.86 6.03 2.27l-1.16 1.2A7.5 7.5 0 0 0 7.5 2.75 7.5 7.5 0 0 0 2.63 4.67L1.47 3.47A8.98 8.98 0 0 1 7.5 1.2Z" />
    </svg>
  );
}

function BatteryCapsule() {
  // Rounded capsule, an inner fill inset by 1.5px, and the nub on the right.
  // Static and full, matching how the signal bars and Wi-Fi are also mockup.
  return (
    <svg width="25" height="12" viewBox="0 0 25 12" fill="none" aria-hidden="true">
      <rect x="0.6" y="0.6" width="21" height="10.8" rx="3.2" stroke="currentColor" strokeWidth="1.1" opacity="0.4" />
      <rect x="2.1" y="2.1" width="18" height="7.8" rx="2" fill="currentColor" />
      <path d="M23 4.2v3.6a2 2 0 0 0 0-3.6Z" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

/**
 * The phone mockup's status bar: a centred notch, the time on the left, and the
 * cellular/Wi-Fi/battery cluster on the right.
 *
 * `timeFormat` is a PROP, not a `useAccessibility()` call. That hook throws
 * without a provider (accessibility.tsx), and App.tsx documents a
 * blank-white-screen incident from exactly that — three of this component's
 * four mount sites are pre-auth screens, so a prop cannot regress them.
 */
export function LiveStatusBar({ className = "", timeFormat = "12h" }: {
  className?: string;
  timeFormat?: TimeFormat;
}) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  // No AM/PM: iOS never shows a suffix in the status bar, whichever clock the
  // person uses. The 24h setting is still honoured — formatClockAt already
  // returns "15:45" there, so there is nothing to strip; only the redundant
  // 12h suffix goes.
  const clock = formatClockAt(currentTime, timeFormat).replace(/\s*[ap]\.?m\.?$/i, "");

  return (
    <div className={`relative flex items-center justify-between px-6 h-10 shrink-0 ${className}`}>
      {/* The notch. Deliberately NOT md:-gated, even though the phone bezel in
          App.tsx is: `md` is 768px and this app is demoed in a phone-shaped
          window (its own Playwright configs are 430 and 460px wide), so a
          md:-gated notch would be invisible at exactly the width the mockup is
          normally looked at. It belongs with the fake cellular/Wi-Fi/battery
          icons beside it — all of them are mockup chrome that renders at every
          width — not with the desktop-only bezel.

          Solid bg-black with NO /NN opacity class and NO border class, both
          deliberate: theme.css flattens /10../60 backgrounds to card white
          under .contrast-max (an opacity-drawn notch would vanish) and forces
          border-width:2px on anything border-classed under the contrast
          variants. Fixed black also matches the bezel's own md:border-black —
          hardware chrome already opts out of the theme. */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-0 w-[150px] h-[26px] rounded-b-[14px] bg-black"
        style={{ transform: "translateX(-50%)" }}
      />
      {/* font-sans is EXPLICIT and load-bearing: every phone-frame wrapper in
          App.tsx sets an inline fontFamily of "'DM Sans', system-ui, sans-serif",
          and inline font-family inherits — so without this the time silently
          renders in DM Sans. font-sans resolves to ui-sans-serif/system-ui,
          which IS SF Pro on Apple hardware (SF Pro itself is not
          redistributable, and no new font is being loaded). tabular-nums stops
          the digits jittering as the clock ticks. */}
      <span className="font-sans tabular-nums text-xs font-semibold text-foreground">
        {clock}
      </span>
      <div className="flex items-center gap-1.5 text-foreground">
        <CellularBars />
        <WifiFan />
        <BatteryCapsule />
      </div>
    </div>
  );
}

export function StatusPill({ status, small = false }: { status: MedStatus; small?: boolean }) {
  const { language } = useLanguage();
  // Status colours come from the shared tokens (styles/theme.css) so the
  // caregiver's chips track the elder's cards — including under the contrast
  // and colour-vision modes, which a hardcoded Tailwind palette would ignore.
  const map: Record<MedStatus, { label: string; icon: React.ReactNode; cls: string }> = {
    taken: { label: t(language, "common.taken"), icon: <CheckCircle2 size={small ? 11 : 13} />, cls: "bg-taken-bg text-taken-fg border border-taken-border" },
    missed: { label: t(language, "common.missed"), icon: <AlertTriangle size={small ? 11 : 13} />, cls: "bg-missed-bg text-missed-fg border border-missed-border" },
    upcoming: { label: t(language, "common.upcoming"), icon: <Circle size={small ? 11 : 13} />, cls: "bg-upcoming-bg text-upcoming-fg border border-upcoming-border" },
    skipped: { label: t(language, "common.skipped"), icon: <X size={small ? 11 : 13} />, cls: "bg-muted text-muted-foreground border border-border" },
  };
  const { label, icon, cls } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${small ? "px-2 py-0.5 text-[calc(10px*var(--dw-text,1))]" : "px-2.5 py-1 text-xs"} ${cls}`}>
      {icon} {label}
    </span>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-[calc(11px*var(--dw-text,1))] font-bold text-muted-foreground uppercase tracking-widest px-1">{title}</h3>
      {action && <button onClick={onAction} className="text-[calc(12px*var(--dw-text,1))] text-primary font-bold px-1">{action}</button>}
    </div>
  );
}

export function Card({ children, className = "", "data-tour": dataTour }: { children: React.ReactNode; className?: string; "data-tour"?: string }) {
  return <div className={`dw-surface ${className}`} data-tour={dataTour}>{children}</div>;
}

export function QuickAction({ icon, label, colour, onClick }: { icon: React.ReactNode; label: string; colour: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 flex-1 dw-press">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${colour}`}>
        {icon}
      </div>
      <span className="text-[calc(11px*var(--dw-text,1))] font-semibold text-foreground text-center leading-tight">{label}</span>
    </button>
  );
}

export function PatientSwitcher({ patients, selected, onSelect, onAdd, onScan }: { patients: Patient[]; selected: number; onSelect: (i: number) => void; onAdd: (name: string, relation: string) => void; onScan?: () => void }) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRelation, setNewRelation] = useState("");
  const patient = patients[selected];

  const submitAdd = () => {
    if (!newName.trim()) return;
    onAdd(newName.trim(), newRelation.trim() || t(language, "patientSwitcher.careRecipientDefault"));
    setNewName(""); setNewRelation(""); setAdding(false); setOpen(false);
  };

  return (
    <div className="relative z-[200]">
      <button
        onClick={() => setOpen(!open)}
        data-tour="cg-patientswitcher"
        className="flex items-center gap-2.5 bg-card/70 backdrop-blur-sm border border-border rounded-2xl px-3 py-2 w-full active:bg-muted/60 transition-colors"
      >
        <ProfileAvatar photo={patient.photo} size={32} className="rounded-full shrink-0" />
        <div className="flex-1 text-left">
          <div className="text-xs font-semibold text-foreground leading-tight">{patient.nickname} · {patient.relation}</div>
          <div className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground">{t(language, "patientSwitcher.checked", { time: patient.lastChecked })}</div>
        </div>
        <ChevronDown size={14} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-card rounded-2xl shadow-xl border border-border z-[200] overflow-hidden">
          {patients.map((p, i) => (
            <button
              key={p.id}
              onClick={() => { onSelect(i); setOpen(false); }}
              className={`flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors ${i === selected ? "bg-secondary" : "hover:bg-muted"}`}
            >
              <ProfileAvatar photo={p.photo} size={32} className="rounded-full shrink-0" />
              <div>
                <div className="text-xs font-semibold text-foreground">{p.name}</div>
                <div className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground">{t(language, "common.relationAge", { relation: p.relation, age: p.age })}</div>
              </div>
              {i === selected && <CheckCircle2 size={14} className="ml-auto text-primary" />}
            </button>
          ))}
          {adding ? (
            <div className="p-3 border-t border-border space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t(language, "common.fullName")}
                className="w-full bg-input-background border border-border rounded-xl px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
              <input
                value={newRelation}
                onChange={e => setNewRelation(e.target.value)}
                placeholder={t(language, "patientSwitcher.relationPlaceholder")}
                className="w-full bg-input-background border border-border rounded-xl px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
              />
              <div className="flex gap-2">
                <button onClick={submitAdd} disabled={!newName.trim()} className="flex-1 bg-primary text-primary-foreground rounded-xl py-1.5 text-xs font-semibold disabled:opacity-40">
                  {t(language, "wizard.add")}
                </button>
                <button onClick={() => { setAdding(false); setNewName(""); setNewRelation(""); }} className="px-3 rounded-xl border border-border text-xs font-semibold text-muted-foreground">
                  {t(language, "common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {onScan && (
                <button onClick={() => { setOpen(false); onScan(); }} data-walk="patientswitcher-scan-qr" className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-muted border-t border-border">
                  <div className="w-8 h-8 rounded-xl bg-secondary flex items-center justify-center">
                    <QrCode size={14} className="text-primary" />
                  </div>
                  <span className="text-xs text-foreground font-medium">{t(language, "patientSwitcher.scanQr")}</span>
                </button>
              )}
              <button onClick={() => setAdding(true)} className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-muted border-t border-border">
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                  <Plus size={14} className="text-muted-foreground" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">{t(language, "patientSwitcher.addCareRecipient")}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

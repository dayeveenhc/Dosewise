import type { ReactNode } from "react";

/**
 * The one slide-up sheet shell for the whole app: dimmed backdrop, a floating
 * rounded card inset from every edge, tap-outside to close.
 *
 * Every sheet used to bring its own version of this — some flush to the bottom
 * with square lower corners, some blurred, some at different z-indexes — which
 * read as several different UIs. Content stays each caller's own business; this
 * owns nothing but the box and the overlay.
 *
 * Floating rather than flush on purpose: the elder frame is `overflow-hidden`
 * with a nav bar under it, and a sheet pinned to the bottom edge gets visibly
 * clipped against it.
 */
export function BottomSheet({ onClose, children, layout = "padded" }: {
  onClose: () => void;
  children: ReactNode;
  /**
   * "padded" — the shell pads the content and scrolls it. What almost every
   * sheet wants.
   * "bare"  — the caller owns the inside: its own scrolling body, its own
   * pinned footer, its own padding. Named rather than a className escape
   * hatch, so the sheet has one public contract instead of two (it used to
   * take `!p-0 !overflow-hidden`, which is a caller reaching past the API).
   */
  layout?: "padded" | "bare";
}) {
  const inner = layout === "padded"
    ? "p-5 overflow-y-auto scrollbar-none"
    : "overflow-hidden flex flex-col";
  return (
    <div className="absolute inset-0 z-[150] flex items-end p-3">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative w-full bg-card rounded-3xl border border-border shadow-2xl max-h-full animate-in slide-in-from-bottom duration-200 ${inner}`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";
import type { ReviewField } from "../lib/walkthrough/types";

// How often to re-read the form while the review card is up. Cheap (a handful
// of querySelector().value reads) and it exists because listeners alone are not
// enough — see readValues below.
const POLL_MS = 300;

const readValues = (fields: ReviewField[]): string[] =>
  fields.map(f => (document.querySelector(f.selector) as HTMLInputElement | null)?.value?.trim() ?? "");

/**
 * The "check these details" card shown inside the walkthrough callout before a
 * manual Save. Mei fills the form out of the person's sight-line — this puts
 * what she typed in front of them, in the same card as the instruction, so
 * confirming is an informed act rather than a leap of faith.
 *
 * Reads the LIVE form rather than any captured value, so tapping Change and
 * retyping updates the card immediately and the person always confirms what is
 * really in the fields.
 */
export function WalkthroughReview({ fields, onChange }: {
  fields: ReviewField[];
  onChange: () => void;
}) {
  const { language } = useLanguage();
  const [values, setValues] = useState<string[]>(() => readValues(fields));

  useEffect(() => {
    const sync = () => setValues(prev => {
      const next = readValues(fields);
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
    sync();

    // Native listeners catch ordinary typing. The interval is NOT belt-and-
    // braces: AddPrescriptionSheet routes name/purpose through TypeAhead, whose
    // onPick sets React state — React writes the DOM value during commit and
    // dispatches NO native input event, so picking a suggestion would otherwise
    // be invisible here. (A MutationObserver can't help: `value` is a property,
    // not an attribute.)
    const poll = setInterval(sync, POLL_MS);
    const nodes = fields
      .map(f => document.querySelector(f.selector))
      .filter((el): el is Element => el !== null);
    for (const el of nodes) {
      el.addEventListener("input", sync);
      el.addEventListener("change", sync);
    }
    return () => {
      clearInterval(poll);
      for (const el of nodes) {
        el.removeEventListener("input", sync);
        el.removeEventListener("change", sync);
      }
    };
  }, [fields]);

  return (
    // An inset, NOT .dw-surface — the callout is already a card at the same
    // elevation, and nesting the full card treatment reads as a card-in-a-card.
    <div className="mt-3 rounded-xl border border-border bg-muted/40 p-3">
      <p className="text-[calc(11px*var(--dw-text,1))] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t(language, "walk.review.title")}
      </p>
      {/* Capped height + per-row truncation keep the callout short enough that
          it can't grow into the Save button it sits above (placement.ts falls
          back to placing the card ABOVE the target when space below is tight). */}
      <dl className="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
        {fields.map((f, i) => (
          <div key={f.selector} className="flex items-baseline gap-2">
            <dt className="w-20 shrink-0 text-[calc(12px*var(--dw-text,1))] text-muted-foreground truncate">
              {t(language, f.labelKey)}
            </dt>
            <dd className="flex-1 min-w-0 text-[calc(13px*var(--dw-text,1))] font-semibold text-foreground truncate">
              {values[i] || t(language, "walk.review.empty")}
            </dd>
          </div>
        ))}
      </dl>
      <button
        onClick={onChange}
        className="mt-2 min-h-[44px] px-2 -ml-2 text-sm font-semibold text-primary"
      >
        {t(language, "walk.review.change")}
      </button>
    </div>
  );
}

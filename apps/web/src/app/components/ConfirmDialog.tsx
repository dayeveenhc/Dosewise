import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void;
}) {
  const { language } = useLanguage();
  return (
    <div className="absolute inset-0 z-[150] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      {/* Stacked buttons, not side-by-side: at these text sizes a two-up row
          truncates longer confirm labels, and full-width rows are the larger,
          easier tap target. */}
      <div className="relative bg-card rounded-2xl p-5 shadow-2xl w-full max-w-[330px]">
        <h3 className="font-['Fraunces'] text-[calc(22px*var(--dw-text,1))] font-semibold text-foreground mb-2 leading-tight">{title}</h3>
        <p className="text-[calc(16px*var(--dw-text,1))] text-muted-foreground leading-relaxed mb-5">{body}</p>
        <div className="flex flex-col gap-2">
          <button onClick={onConfirm} data-walk="confirm-dialog-confirm" className="w-full h-13 py-3.5 rounded-xl bg-primary text-primary-foreground text-[calc(17px*var(--dw-text,1))] font-bold active:opacity-80 transition-opacity">
            {confirmLabel ?? t(language, "home.confirm")}
          </button>
          <button onClick={onCancel} className="w-full h-13 py-3.5 rounded-xl border border-border text-foreground text-[calc(17px*var(--dw-text,1))] font-semibold active:bg-muted transition-colors">
            {t(language, "common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

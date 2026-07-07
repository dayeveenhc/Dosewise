export function ConfirmDialog({ title, body, confirmLabel = "Confirm", onConfirm, onCancel }: {
  title: string; body: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-[150] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-card rounded-2xl p-5 shadow-2xl w-full max-w-[300px]">
        <h3 className="font-['Fraunces'] text-lg font-semibold text-foreground mb-1.5">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">{body}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 h-11 rounded-xl border border-border text-muted-foreground text-sm font-semibold">
            Cancel
          </button>
          <button onClick={onConfirm} className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

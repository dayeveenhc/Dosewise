import { useEffect } from "react";
import { Bell, X } from "lucide-react";

export interface ToastItem { id: number; title: string; body: string }

function ToastCard({ toast, onDismiss, onClick }: { toast: ToastItem; onDismiss: () => void; onClick: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={onClick}
      className="pointer-events-auto bg-card border border-border rounded-2xl shadow-xl px-4 py-3 flex items-start gap-3 animate-in slide-in-from-top duration-300 cursor-pointer"
    >
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <Bell size={14} className="text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground truncate">{toast.title}</p>
        <p className="text-xs text-muted-foreground leading-snug">{toast.body}</p>
      </div>
      <button onClick={e => { e.stopPropagation(); onDismiss(); }} className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors">
        <X size={12} />
      </button>
    </div>
  );
}

// A stack of top-of-screen popup notifications — separate from the persistent
// notifications list screen, which only shows what's already been read/dismissed.
export function ToastStack({ toasts, onDismiss, onClick }: { toasts: ToastItem[]; onDismiss: (id: number) => void; onClick?: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="absolute top-3 left-3 right-3 z-[300] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} onClick={() => onClick?.(toast.id)} />
      ))}
    </div>
  );
}

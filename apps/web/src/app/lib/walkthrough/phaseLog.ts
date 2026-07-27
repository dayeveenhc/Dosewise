// DEV-only pacing instrumentation: an append-only window.__dwPhaseLog of every
// paced phase (walkthrough) and highlight dwell, written automatically by
// PaceController.paced() and ChangeHighlight — so the log can never drift from
// actual behaviour. Timestamps are performance.now(). No-op outside DEV.
export interface PhaseLogEntry {
  surface: "walkthrough" | "highlight";
  task?: string;
  stepId?: string;
  phase: string;
  minMs: number;
  startedAt: number;
  endedAt: number;
}

type PhaseLogWindow = { __dwPhaseLog?: PhaseLogEntry[] };

export function recordPhase(entry: PhaseLogEntry): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const w = window as unknown as PhaseLogWindow;
  (w.__dwPhaseLog ??= []).push(entry);
}

export function resetPhaseLog(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  (window as unknown as PhaseLogWindow).__dwPhaseLog = [];
}

export function readPhaseLog(): PhaseLogEntry[] {
  if (!import.meta.env.DEV || typeof window === "undefined") return [];
  return (window as unknown as PhaseLogWindow).__dwPhaseLog ?? [];
}

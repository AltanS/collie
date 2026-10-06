// The pane screen's status line. It used to be a store of its own that pane.tsx forwarded to the
// shell; the shell's status (lib/status.ts) is the one line now, shown in the header's title slot
// (REMIX3.md rule 6). These two names stay so the action modules keep one import.
import { clearStatus, setStatus, type StatusTone } from "../../lib/status";

export type { StatusTone };

export function setPaneStatus(text: string, tone: StatusTone = "info"): void {
  setStatus(text, tone);
}

export function clearPaneStatus(): void {
  clearStatus();
}

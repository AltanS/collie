// The pane screen's one status line: what the last send or tap did ("Sent ✓", "The menu changed",
// an error). web/'s `setStatus` (web/src/lib/status.ts) is the same channel, behind a React hook;
// this is a module store the line above the composer reads, cleared after a few seconds.
import { createStore } from "../../lib/store";

export type StatusTone = "info" | "success" | "warn" | "error";

export interface PaneStatus {
  text: string;
  tone: StatusTone;
  /** Bumped on every message, so the same words twice still re-arm the timer. */
  serial: number;
}

const TTL_MS = { info: 3000, success: 2500, warn: 4000, error: 6000 } satisfies Record<StatusTone, number>;

export const paneStatus = createStore<PaneStatus | null>(null);

let serial = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function setPaneStatus(text: string, tone: StatusTone = "info"): void {
  serial++;
  const mine = serial;
  paneStatus.set({ text, tone, serial: mine });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (paneStatus.get()?.serial === mine) paneStatus.set(null);
  }, TTL_MS[tone]);
}

export function clearPaneStatus(): void {
  if (timer) clearTimeout(timer);
  paneStatus.set(null);
}

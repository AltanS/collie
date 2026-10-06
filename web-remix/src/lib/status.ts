// The app's one status channel (web/src/lib/status.ts): anything that wants to tell the operator
// something (a send landed, a refusal, the pane closed) calls `setStatus()`. Latest wins. Errors
// persist until dismissed; everything else clears after 2.5 s.
//
// Who reads it:
//   - the header's title slot (`shell/header.tsx`, HeaderStatus) on a route that claims it,
//   - the toast in the overlay layer (`ui/toast-viewport.tsx`, StatusToast) on the others,
//   - the Collie mark, which turns its orbit ONE round per publish (`shell/collie-mark.tsx`):
//     "if it was worth a notice, it is worth a round" (web/src/components/collie-home.tsx).
import { createStore } from "./store";

export type StatusTone = "info" | "success" | "warn" | "error";

export interface StatusMessage {
  /** Monotone per publish, so the same words twice are still two events. */
  id: number;
  text: string;
  tone: StatusTone;
  /** The full message for the detail sheet, when `text` is a short form of it. */
  detail?: string;
}

/** web/'s default lifetime for a non-error status. */
export const STATUS_TTL_MS = 2500;

export const status = createStore<StatusMessage | null>(null);

let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface StatusOptions {
  /** Override the per-tone default; `null` persists until `clearStatus()`. */
  ttlMs?: number | null;
  detail?: string;
}

export function setStatus(text: string, tone: StatusTone = "info", options: StatusOptions = {}): StatusMessage {
  if (timer) clearTimeout(timer);
  timer = null;
  const message: StatusMessage = { id: nextId++, text, tone };
  if (options.detail !== undefined) message.detail = options.detail;
  status.set(message);
  const ttl = options.ttlMs === undefined ? (tone === "error" ? null : STATUS_TTL_MS) : options.ttlMs;
  if (ttl !== null) {
    timer = setTimeout(() => {
      timer = null;
      if (status.get()?.id === message.id) status.set(null);
    }, ttl);
  }
  return message;
}

export function clearStatus(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  status.set(null);
}

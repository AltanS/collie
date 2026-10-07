// Which sheet is open on an islands page (S3). The `sheets` island draws it; anything opens it: a
// delegated act on server HTML (the row's long press, the pane name, the cache chip; islands/act-table.ts),
// the header's ⋮ (islands/header-actions.tsx), the composer's switcher pill (islands/composer.tsx).
// One sheet at a time, as the static shell's screens keep it.
import { createStore } from "../lib/store";

export type SheetRequest =
  /** The dashboard row's hold: that pane's actions. */
  | { kind: "row-actions"; paneId: string; host?: string; session?: string }
  /** The pane's ⋮. */
  | { kind: "pane-actions" }
  | { kind: "pane-settings" }
  | { kind: "cache" }
  | { kind: "switcher" };

export const sheetRequest = createStore<SheetRequest | null>(null);

export function openSheet(request: SheetRequest): void {
  sheetRequest.set(request);
}

export function closeSheet(): void {
  sheetRequest.set(null);
}

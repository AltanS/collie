// The composer's draft store: web's per-pane drafts (web/src/lib/drafts.ts, read-only reuse: the
// same localStorage keys, the memory tier, the size cap) plus the reload hold the React composer
// takes through `useHoldReload`. A pane with words in its box, a chip, or an open Undo window holds
// the self-update reload, so an update never throws away what the operator was typing
// (update/reload-hold.ts; web/src/components/composer.tsx says why).
import {
  clearDraft as clearWebDraft,
  fitsDraftStore,
  loadDraftEntry,
  saveDraft as saveWebDraft,
  type Draft,
  type DraftAttachment,
} from "@web/lib/drafts";
import { paneScopeKey, type Scope } from "@web/lib/scope";

import { holdReload, releaseReload } from "../update/reload-hold";

export type { Draft, DraftAttachment };
export { fitsDraftStore };

const EMPTY: Draft = { text: "", attachments: [], next: 1 };

function holdKey(scope: Scope | undefined, paneId: string): string {
  return `composer:${paneScopeKey(scope, paneId)}`;
}

/** The pane's saved draft, or an empty one. */
export function loadDraft(scope: Scope | undefined, paneId: string): Draft {
  return loadDraftEntry(scope, paneId) ?? EMPTY;
}

/** Whether a draft has anything worth keeping. */
export function hasDraft(text: string, attachments: readonly DraftAttachment[]): boolean {
  return text.trim() !== "" || attachments.length > 0;
}

/** Write the draft through, and hold or release the reload to match. */
export function saveDraft(
  scope: Scope | undefined,
  paneId: string,
  text: string,
  attachments: readonly DraftAttachment[] = [],
  next = 1,
): void {
  saveWebDraft(scope, paneId, text, attachments, next);
  holdDraft(scope, paneId, hasDraft(text, attachments));
}

/** Drop the draft (a send landed, or the password prompt took it) and release its hold. */
export function clearDraft(scope: Scope | undefined, paneId: string): void {
  clearWebDraft(scope, paneId);
  holdDraft(scope, paneId, false);
}

/**
 * Hold or release this pane's reload hold directly: the composer also holds while an Undo window is
 * open, direct typing is armed, or an upload is in flight, none of which is a stored draft.
 */
export function holdDraft(scope: Scope | undefined, paneId: string, on: boolean): void {
  const key = holdKey(scope, paneId);
  if (on) holdReload(key);
  else releaseReload(key);
}

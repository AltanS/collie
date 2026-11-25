import { useSyncExternalStore } from "react";

import { hasDraft, subscribeDrafts } from "@/lib/drafts";
import type { Scope } from "@/lib/scope";

/**
 * Whether THIS DEVICE holds an unsent composer draft for a pane (lib/drafts.ts): text that is not blank, or a
 * chip. It follows the store live, so a row's pencil comes when the draft is saved and goes when it is sent or
 * cleared, also for a draft another tab of this browser changed. The answer is a cached boolean per pane, so a
 * list of rows reads the disk once each at first paint and then only when a draft changes.
 *
 * `scope` is the pane's own address (`paneScope`, lib/hosts.ts), the one the composer saves under.
 */
export function useHasDraft(scope: Scope | undefined, paneId: string): boolean {
  return useSyncExternalStore(
    subscribeDrafts,
    () => hasDraft(scope, paneId),
    () => false,
  );
}

// The History view's one read (web/src/lib/loaders.ts `historyLoader`, `fetchHistory`): the whole
// transcript in one request, and `before=` pages for a log longer than one page. It is a READ of the
// pane, so it carries the header that lets the bridge count it as seen (bridge/server.ts marksPaneSeen).
// Not polled: a several-hundred-turn transcript must never be re-pulled out from under the reader.
import type { Scope } from "@web/lib/scope";
import type { PaneHistoryResponse } from "@web/lib/types";

import { bridgeGet } from "../../lib/api";
import { HISTORY_PAGE_SIZE } from "./window";

export type HistoryUnavailable = "disabled" | "no-session" | "no-log" | "error";

export function historyPath(paneId: string, query: string): string {
  return `/api/pane/${encodeURIComponent(paneId)}/history?${query}`;
}

/** One page of the transcript. A throw is a failed read; `available: false` is an ordinary answer. */
export function fetchHistoryPage(paneId: string, query: string, scope: Scope, signal: AbortSignal): Promise<PaneHistoryResponse> {
  return bridgeGet<PaneHistoryResponse>(historyPath(paneId, query), scope, signal, { "x-collie-seen": "1" });
}

/** The query for the first request: the whole conversation, taken literally. */
export const FIRST_PAGE_QUERY = `limit=${String(HISTORY_PAGE_SIZE)}`;

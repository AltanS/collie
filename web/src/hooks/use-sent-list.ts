import { useCallback, useEffect, useRef, useState } from "react";

import { clearSent, getSent, isApiErrorStatus, removeSent } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import { appendPage, scopeOfHost, withoutEntry } from "@/lib/sent-rows";
import type { SentEntry, SentMachine } from "@/lib/types";

// THE SENT SHEET'S DATA (M61 spec 02): one page of lines at a time, read from the bridge while the
// sheet is mounted (it mounts only while open) and held in this hook's memory. Nothing is stored: no localStorage, no IndexedDB, no
// offline copy. Closing the sheet drops the lines.

/** What the sheet lists: the pane's folder, the pane's machine, or every machine of the crew. */
export type SentChoice = "folder" | "machine" | "all";

/** How many lines a page asks for. The bridge's own default, spelled out. */
export const SENT_PAGE = 50;

/** The wait after the last keystroke before a search goes to the bridge. */
export const SENT_SEARCH_DEBOUNCE_MS = 250;

export type SentView =
  | { phase: "loading" }
  /** The machine answered 404: it runs a Collie older than Sent. */
  | { phase: "old" }
  | { phase: "error" }
  | { phase: "ready"; entries: SentEntry[]; more: boolean; off: boolean; machines: SentMachine[] };

export interface UseSentListArgs {
  choice: SentChoice;
  /** The pane's folder; "This folder" asks for it. */
  cwd: string | undefined;
  /** The text in the search field, not yet settled. */
  query: string;
  /** The pane's machine: where "This machine" reads and "Clear Sent" writes. */
  scope: Scope | undefined;
  /** The crew's lead, so a write to its rows carries no host. Absent on a solo bridge. */
  lead: string | undefined;
}

export interface UseSentList {
  view: SentView;
  /** The next page is on its way. */
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Forget one line on its machine. True when the machine took it. */
  forget: (entry: SentEntry) => Promise<boolean>;
  /** Empty the pane's machine. True when it took it. */
  clear: () => Promise<boolean>;
}

const LOADING: SentView = { phase: "loading" };

export function useSentList({ choice, cwd, query, scope, lead }: UseSentListArgs): UseSentList {
  const [view, setView] = useState<SentView>(LOADING);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settled, setSettled] = useState(query);
  const [nonce, setNonce] = useState(0);
  const placeRef = useRef("");
  const viewRef = useRef(view);
  viewRef.current = view;

  // The search goes out once the person stops typing. An empty field settles at once, so clearing it
  // is not a wait.
  useEffect(() => {
    if (query === "") {
      setSettled("");
      return;
    }
    const timer = setTimeout(() => setSettled(query), SENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The scope is read by value, never by identity: a scope is an object the pane view re-creates.
  const host = scope?.host;
  useEffect(() => {
    const abort = new AbortController();
    // A new search keeps the lines on screen until the answer lands; a new place (another scope, folder
    // or machine) must not show the old place's lines under the new name.
    const place = `${choice}\u0000${cwd ?? ""}\u0000${host ?? ""}`;
    const moved = place !== placeRef.current;
    placeRef.current = place;
    setView((now) => (moved || now.phase !== "ready" ? LOADING : now));
    setLoadingMore(false);
    async function read() {
      try {
        const answer = await getSent(
          { scope: choice === "all" ? "all" : "here", cwd: choice === "folder" ? cwd : undefined, q: settled, limit: SENT_PAGE },
          host === undefined ? undefined : { host },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setView({ phase: "ready", entries: answer.entries, more: answer.more, off: answer.off, machines: answer.machines });
      } catch (error) {
        if (abort.signal.aborted) return;
        setView({ phase: isApiErrorStatus(error, 404) ? "old" : "error" });
      }
    }
    void read();
    return () => abort.abort();
  }, [choice, cwd, settled, host, nonce]);

  const loadMore = useCallback(() => {
    const current = viewRef.current;
    if (current.phase !== "ready" || !current.more) return;
    const oldest = current.entries.at(-1);
    if (oldest === undefined) return;
    async function read(before: number) {
      setLoadingMore(true);
      try {
        const answer = await getSent(
          { scope: choice === "all" ? "all" : "here", cwd: choice === "folder" ? cwd : undefined, q: settled, limit: SENT_PAGE, before },
          host === undefined ? undefined : { host },
        );
        setView((now) =>
          now.phase === "ready"
            ? { ...now, entries: appendPage(now.entries, answer.entries), more: answer.more, machines: answer.machines }
            : now,
        );
      } catch {
        // The page stays as it was; "Load more" is still there to try again.
      } finally {
        setLoadingMore(false);
      }
    }
    void read(oldest.at);
  }, [choice, cwd, settled, host]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  const forget = useCallback(
    async (entry: SentEntry): Promise<boolean> => {
      try {
        const answer = await removeSent(entry.id, scopeOfHost(entry.host, lead));
        if (!answer.ok) return false;
        setView((now) => (now.phase === "ready" ? { ...now, entries: withoutEntry(now.entries, entry) } : now));
        return true;
      } catch {
        return false;
      }
    },
    [lead],
  );

  const clear = useCallback(async (): Promise<boolean> => {
    try {
      const answer = await clearSent(host === undefined ? undefined : { host });
      if (!answer.ok) return false;
      setNonce((n) => n + 1);
      return true;
    } catch {
      return false;
    }
  }, [host]);

  return { view, loadingMore, loadMore, retry, forget, clear };
}

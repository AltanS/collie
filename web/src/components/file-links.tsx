import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { useNav } from "@/hooks/use-nav";
import { FILES_EXIST_MAX, fetchFilesExist, isApiErrorStatus, isRefusalStatus } from "@/lib/api";
import { isLostLatched } from "@/lib/connection-health";
import { paneFilesRoot, resolveFilePathLink, type PrintedPath, type RootPane, type RootWorkspace } from "@/lib/file-paths";
import { useLaunchers } from "@/lib/launchers";
import { filesPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";

// A path the agent printed, opened in the Files view (ADR 0088). The screen that knows which pane
// the text belongs to provides an opener; the chat prose, the tool cards and the terminal mirror ask
// it, each in its own drawing. With no opener (History, a Files preview, the playground), for a
// path that resolves outside the Changes root, and for one the bridge has not said exists, the text
// stays text: a dead link is worse than none.
//
// ── THE EXISTENCE CHECK ──────────────────────────────────────────────────────────────────────────
// Agents name files from sibling checkouts, bare names in code spans, and `./x` against a cwd the
// mirror does not know, and most such links opened "This file is not available". So the opener links
// a path only once the bridge has said it is a file or a folder under the root (`POST …/files/exist`,
// one `lstat` per path, nothing read). Asking is the opener's side effect: each path it is shown and
// has no answer for is queued, and the queue goes out 150 ms after the last addition, deduped, at most
// 64 paths a request. Until then, and for good on an absent answer, the path is plain text; a link
// never turns back into text while the view stays open. Offline, or after a failure, nothing is asked.

/** One tap target: `href` for a middle-click or a long-press copy, `onOpen` for the tap. */
export interface FileLinkTarget {
  href: string;
  onOpen: () => void;
}

/** Where a printed path leads, or null when it leads nowhere Files can open. */
export type FileLinkOpener = (found: PrintedPath) => FileLinkTarget | null;

const FileLinkContext = createContext<FileLinkOpener | null>(null);

/** The opener of the screen the caller sits in, or null when that screen has none. */
export function useFileLinks(): FileLinkOpener | null {
  return useContext(FileLinkContext);
}

export function FileLinksProvider({ value, children }: { value: FileLinkOpener | null; children: ReactNode }) {
  return <FileLinkContext.Provider value={value}>{children}</FileLinkContext.Provider>;
}

/** A plain click is the screen's to handle; a modified one (new tab, copy) is the browser's. */
export function isPlainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

// ── Which paths exist ──────────────────────────────────────────────────────────────────────────────

/** How long the queue waits for the rest of a render's paths before it asks. */
export const FILE_EXIST_DEBOUNCE_MS = 150;
/** Answers kept per pane view, oldest absent answer evicted first. */
export const FILE_EXIST_CACHE_MAX = 512;
/** After a failure that may pass (a timeout, a 5xx, no network), the view asks nothing for this long. */
const FILE_EXIST_RETRY_MS = 30_000;
/**
 * How long an "absent" answer is believed. A present answer stays for the view's life (files do not
 * come back as nothing in the middle of a session); an absent one may be wrong within seconds, since
 * the agent's Write often waits on a permission prompt while its path is already printed. After this
 * the path is asked about again the next time it is drawn. ADR 0088.
 */
export const FILE_EXIST_ABSENT_TTL_MS = 30_000;

/** What the opener asks of the existence answers. Stable until a new path is known to exist. */
export interface FileLinkExistence {
  /** Whether the bridge said this root-relative path is a file or a folder. */
  isKnownFile(rel: string): boolean;
  /** Queue a root-relative path to be asked about, unless it is answered, queued or on its way. */
  want(rel: string): void;
}

type ExistAsk = (paths: readonly string[], signal: AbortSignal) => Promise<string[]>;

/**
 * One pane view's answers and its queue. Plain state outside React: `want` runs while the screen
 * renders, so it only adds to a set and arms a timer, and the one thing that reaches React is the
 * `onAnswer` call after a request came back with a path that exists.
 */
class FileExistenceStore {
  private readonly ask: ExistAsk;
  /** Root-relative path to its answer, in recency order (a `Map` keeps insertion order). */
  private readonly answers = new Map<string, boolean>();
  /** When each ABSENT answer was given, for {@link FILE_EXIST_ABSENT_TTL_MS}. */
  private readonly absentAt = new Map<string, number>();
  private readonly queued = new Set<string>();
  private readonly asking = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private attached = false;
  /** The route is not there (a member, an older bridge) or refused: nothing more is asked. */
  private refused = false;
  private quietUntil = 0;
  private onAnswer: () => void = () => {};
  /**
   * What React reads: a fresh object each time a request found a path that exists, so a memoised
   * link scan that depends on it runs again then, and only then.
   */
  view: FileLinkExistence;

  constructor(ask: ExistAsk) {
    this.ask = ask;
    this.view = this.freshView();
  }

  private freshView(): FileLinkExistence {
    return { isKnownFile: (rel) => this.isKnownFile(rel), want: (rel) => this.want(rel) };
  }

  /** The view's subscription is the store's life: asking starts with it and stops at its end. */
  subscribe(onAnswer: () => void): () => void {
    this.attach(onAnswer);
    return () => this.detach();
  }

  isKnownFile(rel: string): boolean {
    if (this.answers.get(rel) !== true) return false;
    this.answers.delete(rel);
    this.answers.set(rel, true);
    return true;
  }

  want(rel: string): void {
    if (this.answers.get(rel) === false && Date.now() - (this.absentAt.get(rel) ?? 0) >= FILE_EXIST_ABSENT_TTL_MS) {
      // Stale "not there": forget it and ask again below.
      this.answers.delete(rel);
      this.absentAt.delete(rel);
    }
    if (this.answers.has(rel) || this.queued.has(rel) || this.asking.has(rel)) return;
    if (this.refused || Date.now() < this.quietUntil || isLostLatched()) return;
    this.queued.add(rel);
    this.arm();
  }

  private attach(onAnswer: () => void): void {
    this.attached = true;
    this.onAnswer = onAnswer;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    if (this.queued.size > 0) this.arm();
  }

  private detach(): void {
    this.attached = false;
    this.onAnswer = () => {};
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller.abort();
  }

  /** Each `want` pushes the send back, so one render's paths leave together. */
  private arm(): void {
    if (!this.attached) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), FILE_EXIST_DEBOUNCE_MS);
  }

  private flush(): void {
    this.timer = null;
    const paths = [...this.queued];
    this.queued.clear();
    if (!this.attached || isLostLatched()) return;
    for (let i = 0; i < paths.length; i += FILES_EXIST_MAX) void this.send(paths.slice(i, i + FILES_EXIST_MAX));
  }

  private async send(paths: readonly string[]): Promise<void> {
    const signal = this.controller.signal;
    for (const p of paths) this.asking.add(p);
    try {
      const found = new Set(await this.ask(paths, signal));
      for (const p of paths) this.remember(p, found.has(p));
      if (found.size > 0) {
        this.view = this.freshView();
        this.onAnswer();
      }
    } catch (error) {
      if (signal.aborted) return;
      // A 4xx is an answer about the route, not this moment: an older bridge, a member the lead
      // cannot forward to (501), a device the gate refuses. Anything else may pass: wait, then ask.
      if (isRefusalStatus(error) || isApiErrorStatus(error, 501)) this.refused = true;
      else this.quietUntil = Date.now() + FILE_EXIST_RETRY_MS;
    } finally {
      for (const p of paths) this.asking.delete(p);
    }
  }

  private remember(rel: string, exists: boolean): void {
    this.answers.delete(rel);
    this.answers.set(rel, exists);
    if (exists) this.absentAt.delete(rel);
    else this.absentAt.set(rel, Date.now());
    while (this.answers.size > FILE_EXIST_CACHE_MAX) {
      // An absent answer goes first: dropping a known file would turn a drawn link back into text.
      let drop: string | undefined;
      for (const [key, known] of this.answers) {
        if (!known) {
          drop = key;
          break;
        }
      }
      const gone = drop ?? this.answers.keys().next().value!;
      this.answers.delete(gone);
      this.absentAt.delete(gone);
    }
  }
}

/**
 * The existence answers for one pane view (ADR 0088), or null with no root (nothing can link then).
 * Keyed on the pane, its scope and its root: a new root means new relative paths, so the answers
 * start over. The returned value changes only when a request found a path that exists, which is when
 * a drawn path must become a link.
 */
export function useFileLinkExistence({
  paneId,
  host,
  session,
  root,
}: {
  paneId: string;
  host?: string;
  session?: string;
  root: string | null;
}): FileLinkExistence | null {
  const store = useMemo(() => {
    // The bridge finds the root itself; here it only decides whether there is anything to ask.
    if (root === null) return null;
    const at: Scope = {};
    if (host !== undefined) at.host = host;
    if (session !== undefined) at.session = session;
    return new FileExistenceStore((paths, signal) => fetchFilesExist(paneId, paths, at, signal));
  }, [paneId, host, session, root]);
  const subscribe = useCallback((onAnswer: () => void) => (store === null ? () => {} : store.subscribe(onAnswer)), [store]);
  const view = useCallback(() => store?.view ?? null, [store]);
  return useSyncExternalStore(subscribe, view, view);
}

/**
 * The opener for one pane's view: the Changes root as the bridge picks it from the snapshot
 * (`paneFilesRoot`), the pane's cwd for relative paths, and that machine's home dir for `~/` and for
 * the root's bound. Home comes from the launchers answer, the one read that already names it per
 * host; until it arrives the opener is null and every path reads as text.
 *
 * A tap goes one level down to the file (ADR 0067), allowed to fall back to a folder (`viaLink`),
 * since a printed `./scripts` may be either. A path the bridge has not said exists opens nothing and
 * is queued for the existence check ({@link useFileLinkExistence}). Stable while its inputs are and
 * no new path is known, so the mirror's memoised link scan does not re-run on every poll.
 */
export function usePaneFileLinks({
  paneId,
  scope,
  pane,
  panes,
  workspaces,
}: {
  paneId: string;
  scope?: Scope;
  pane: (RootPane & { paneId: string }) | undefined;
  panes: readonly RootPane[];
  workspaces: readonly RootWorkspace[];
}): FileLinkOpener | null {
  const nav = useNav();
  const { home } = useLaunchers(scope);
  const root = useMemo(
    () => (pane === undefined ? null : paneFilesRoot({ pane, panes, workspaces, home })),
    [pane, panes, workspaces, home],
  );
  const cwd = pane?.cwd ?? "";
  // Keyed on the scope's two fields, not its identity: the pane loader hands a fresh object per poll.
  const host = scope?.host;
  const session = scope?.session;
  const existence = useFileLinkExistence({ paneId, host, session, root });
  return useMemo<FileLinkOpener | null>(() => {
    if (root === null) return null;
    const at: Scope = {};
    if (host !== undefined) at.host = host;
    if (session !== undefined) at.session = session;
    return ({ path, line }) => {
      const rel = resolveFilePathLink({ path, root, cwd, home });
      if (rel === null) return null;
      if (existence === null) return null;
      if (!existence.isKnownFile(rel)) {
        existence.want(rel);
        return null;
      }
      const href = filesPath(paneId, at, line === undefined ? { path: rel } : { path: rel, line });
      return { href, onOpen: () => nav.down(href, { viaLink: true }) };
    };
  }, [root, cwd, home, paneId, host, session, nav, existence]);
}

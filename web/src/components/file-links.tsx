import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useNav } from "@/hooks/use-nav";
import { paneFilesRoot, resolveFilePathLink, type PrintedPath, type RootPane, type RootWorkspace } from "@/lib/file-paths";
import { useLaunchers } from "@/lib/launchers";
import { filesPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";

// A path the agent printed, opened in the Files view (ADR 0088). The screen that knows which pane
// the text belongs to provides an opener; the chat prose, the tool cards and the terminal mirror ask
// it, each in its own drawing. With no opener (History, a Files preview, the playground), and for a
// path that resolves outside the Changes root, the text stays text: a dead link is worse than none.

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

/**
 * The opener for one pane's view: the Changes root as the bridge picks it from the snapshot
 * (`paneFilesRoot`), the pane's cwd for relative paths, and that machine's home dir for `~/` and for
 * the root's bound. Home comes from the launchers answer, the one read that already names it per
 * host; until it arrives the opener is null and every path reads as text.
 *
 * A tap goes one level down to the file (ADR 0067), allowed to fall back to a folder (`viaLink`),
 * since a printed `./scripts` may be either. Stable while its inputs are, so the mirror's memoised
 * link scan does not re-run on every poll.
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
  return useMemo<FileLinkOpener | null>(() => {
    if (root === null) return null;
    const at: Scope = {};
    if (host !== undefined) at.host = host;
    if (session !== undefined) at.session = session;
    return ({ path, line }) => {
      const rel = resolveFilePathLink({ path, root, cwd, home });
      if (rel === null) return null;
      const href = filesPath(paneId, at, line === undefined ? { path: rel } : { path: rel, line });
      return { href, onOpen: () => nav.down(href, { viaLink: true }) };
    };
  }, [root, cwd, home, paneId, host, session, nav]);
}

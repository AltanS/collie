import { useCallback, useEffect, useRef, useState } from "react";

import { FilesLoading } from "@/components/file-preview";
import { FilesFolderBody } from "@/components/files-view";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import type { FilesAnswer } from "@/lib/api";
import { unavailableKey } from "@/lib/changes-reason";
import type { MarkedFolder } from "@/lib/files-marks";
import { t } from "@/lib/i18n";
import { isAbortError } from "@/lib/loaders";
import type { FileEntry, FileReadResponse, FilesListResponse } from "@/lib/types";

// The Changes screen's folder tree (ADR 0083): the read of one folder or one file of the Changes root,
// and the body a folder draws. The screen itself is `ChangesScreen` in `changes.tsx`, which owns the
// Changes list as well and joins the two (lib/files-marks.ts): the tree is the screen's default body,
// and a folder or a file is the same route one segment below it (`…/changes/files`), with `?dir=`
// naming a folder and `?path=` a file, both relative to the root.
//
// NOT POLLED. A folder or a file is asked for when it opens, and again on the refresh button, never
// on a timer: there is no change feed under a folder, and a list that re-sorts under a thumb is the
// fault DESIGN.md §2 names. The change MARKS do move with the list's own 5 s beat, which the screen
// already runs; a mark is paint on a row that stays where it is. A refresh keeps what is on screen
// until the new answer replaces it.

export type Refusal = Exclude<FilesAnswer<never>["outcome"], "body">;

/** What one folder or file read holds now. */
export type FilesReadState<T> =
  | { key: string; phase: "loading" }
  | { key: string; phase: "error" }
  | { key: string; phase: "refused"; why: Refusal }
  | { key: string; phase: "ready"; data: T };

/** A folder listing or a file read, as the tree asks for them. */
export type TreeRead = FilesListResponse | FileReadResponse;

/**
 * One read of the bridge, keyed: a different key starts a fresh read and shows loading, the same key
 * keeps its answer. `reload` asks again WITHOUT clearing, so a refresh never blanks the screen. A
 * null key reads nothing: the screen is on the Changes list, or on a file the disk no longer has.
 */
export function useFilesRead<T>(key: string | null, load: (signal: AbortSignal) => Promise<FilesAnswer<T>>) {
  const [state, setState] = useState<FilesReadState<T>>({ key: key ?? "", phase: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const ctl = useRef<AbortController | null>(null);

  const run = useCallback(async (forKey: string, quiet: boolean) => {
    ctl.current?.abort();
    const mine = new AbortController();
    ctl.current = mine;
    if (!quiet) setState({ key: forKey, phase: "loading" });
    try {
      const answer = await loadRef.current(mine.signal);
      if (mine.signal.aborted) return;
      setState(answer.outcome === "body" ? { key: forKey, phase: "ready", data: answer.body } : { key: forKey, phase: "refused", why: answer.outcome });
    } catch (e) {
      if (isAbortError(e) || mine.signal.aborted) return;
      setState({ key: forKey, phase: "error" });
    }
  }, []);

  useEffect(() => {
    if (key === null) return;
    void run(key, false);
    return () => ctl.current?.abort();
  }, [key, run]);

  /** Ask again in place. Resolves when the answer is on screen. */
  const reload = useCallback(async () => {
    if (key !== null) await run(key, true);
  }, [key, run]);
  // An answer for another key is not this screen's: until its own arrives the screen is loading.
  const shown: FilesReadState<T> = state.key === key ? state : { key: key ?? "", phase: "loading" };
  return { state: shown, reload };
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

// The quiet loading line lives beside the file drawings, which wait on a picture with it too
// (ADR 0090); the screens here keep importing it from this module.
export { FilesLoading };

/**
 * The way to the changes when the tree cannot show this folder: at the root, the Changes list still
 * can, and one tap turns it on.
 */
function ChangesOnlyOffer({ onChangesOnly }: { onChangesOnly: (() => void) | undefined }) {
  if (onChangesOnly === undefined) return null;
  return (
    <Button variant="outline" className="h-11" onClick={onChangesOnly}>
      {t("files.showChangesOnly")}
    </Button>
  );
}

/** Why a read was refused, in words. The unpaired device also gets the way to pair. */
export function RefusedBody({
  why,
  subject,
  onPair,
  onChangesOnly,
}: {
  why: Refusal;
  subject: "file" | "folder";
  onPair: () => void;
  /** At the tree's root: turn Changes only on, since the list does not need what the tree needs. */
  onChangesOnly?: () => void;
}) {
  useLocale();
  let sentence: React.ReactNode;
  if (why === "unknown-path") sentence = t(subject === "file" ? "files.unknown.file" : "files.unknown.folder");
  else if (why === "stale") sentence = t("files.stale.member");
  else if (why === "not-authorised") sentence = t("files.notAuthorised");
  else sentence = t("files.notPaired");
  return (
    <div className="flex flex-col items-center gap-3">
      <Quiet>{sentence}</Quiet>
      {why === "not-paired" && (
        <Button variant="outline" className="h-11" onClick={onPair}>
          {t("files.pairLink")}
        </Button>
      )}
      <ChangesOnlyOffer onChangesOnly={onChangesOnly} />
    </div>
  );
}

/**
 * One folder of the tree: its rows with their change marks, or the sentence that stands in for them.
 * `folder` is the listing joined to the change set; it is also set when the bridge no longer has the
 * folder and the change set names deleted files in it, so a deleted folder's diffs stay reachable.
 */
export function TreeFolderBody({
  state,
  folder,
  truncated,
  listAvailable,
  query,
  showIgnored,
  onShowIgnored,
  onClearQuery,
  onOpen,
  onPair,
  onChangesOnly,
}: {
  state: FilesReadState<TreeRead>;
  folder: MarkedFolder | null;
  truncated: boolean;
  /** The Changes list answered for this root, so a folder Files cannot open still has its changes. */
  listAvailable: boolean;
  query: string;
  showIgnored: boolean;
  onShowIgnored: (show: boolean) => void;
  onClearQuery: () => void;
  onOpen: (entry: FileEntry) => void;
  onPair: () => void;
  onChangesOnly: (() => void) | undefined;
}) {
  useLocale();
  if (folder !== null) {
    return (
      <FilesFolderBody
        entries={folder.entries}
        marks={folder.marks}
        truncated={truncated}
        query={query}
        showIgnored={showIgnored}
        onShowIgnored={onShowIgnored}
        onClearQuery={onClearQuery}
        onOpen={onOpen}
      />
    );
  }
  if (state.phase === "loading") return <FilesLoading />;
  if (state.phase === "error") {
    return (
      <Notice variant="box" tone="danger" announce="alert">
        {t("files.error")}
      </Notice>
    );
  }
  if (state.phase === "refused") return <RefusedBody why={state.why} subject="folder" onPair={onPair} onChangesOnly={onChangesOnly} />;
  if (!state.data.available) {
    // Files is bounded tighter than Changes (ADR 0083 rule 1): a pane parked in the home folder has a
    // Changes list and no Files. Say which half is missing, and offer the half that is there.
    const ownWords = state.data.reason === "no-folder" && listAvailable;
    return (
      <div className="flex flex-col items-center gap-3">
        <Quiet>{t(ownWords ? "files.noFolder" : unavailableKey(state.data.reason))}</Quiet>
        {ownWords && <ChangesOnlyOffer onChangesOnly={onChangesOnly} />}
      </div>
    );
  }
  // A file answered where a folder was asked for: the screen moves to the file on its own.
  return <FilesLoading />;
}

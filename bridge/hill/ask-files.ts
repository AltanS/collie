// The linked files of an ask (`collie walky ask --file`, Asks 2026-11-22). THE SECURITY-SENSITIVE PART.
//
// A POINTER, NEVER A COPY. The bridge never reads, copies or serves a file's content for an ask. It
// stores the path relative to the poster's pane's Files root, and the phone opens it later through the
// Files routes that exist (`GET /api/pane/<pane id>/files?path=`), under the Files right the device holds.
// An ask grants nothing: a device without the Files right sees a path it cannot open.
//
// THE CHECKS ARE THE FILES VIEW'S OWN, not a second checker. The root is the one the Files route picks for
// the pane (bridge/server.ts `agentPaneFilesRoot`: the workspace root as the pane sees it, else its own
// bounded folder). Each path, which the CLI resolved to an absolute real path, goes through
// bridge/files-view.ts `linkableFile`: outside the root's real path is refused; so is everything a Files
// read refuses (a link that leads out, `.git`, Collie's state and config folders, a state secret's name),
// and anything that is not a regular file. One `lstat` per path; nothing is opened.
//
// `#heading` and `:line` are stored as given and never used to read.

import { linkableFile, type FilesContext } from "../files-view.ts";
import { parseAddress } from "../walky/address.ts";
import type { HillAskFile, HillAskFileInput } from "../../web/src/lib/hill/wire.ts";

/** What resolving an ask's files came to: the root the phone opens them under and the relative paths, or why not. */
export type HillAskFilesAnswer = { readonly ok: true; readonly root: string | null; readonly files: HillAskFile[] } | { readonly ok: false; readonly error: string };

/** What the resolver needs: the Files root of one of this machine's agent panes, and the Files context's other parts. */
export interface HillAskFilesDeps {
  /** `{ root }` for an agent pane of this machine (root null when it has none narrow enough), null for no such pane. */
  readonly paneRoot: (paneId: string) => Promise<{ readonly root: string | null } | null>;
  readonly home: string;
  /** The bridge's own state and config folders (bridge/server.ts `filesPrivateFolders`). */
  readonly privateFolders: readonly string[];
}

/** The sentence for a `--file` from a pane with no Files root. */
export const ASK_FILES_NO_ROOT = "--file needs a workspace: this session's pane has no folder the Files view can open, so it cannot link a file";

/**
 * The resolver `HillService` calls for each local ask (deps `askFiles`): the poster's pane id from its
 * walky address, that pane's Files root, and each file checked by {@link linkableFile}. `root` on the
 * answer is the pane id, as the Files route takes it, or null when the pane has no Files root (then any
 * `--file` is refused with {@link ASK_FILES_NO_ROOT}).
 */
export function askFilesResolver(deps: HillAskFilesDeps): (address: string, files: readonly HillAskFileInput[]) => Promise<HillAskFilesAnswer> {
  return async (address, files) => {
    const at = parseAddress(address);
    const placed = at === null || at.kind !== "pane" ? null : await deps.paneRoot(at.paneId);
    const root = placed?.root ?? null;
    if (root === null || at === null || at.kind !== "pane") return files.length === 0 ? { ok: true, root: null, files: [] } : { ok: false, error: ASK_FILES_NO_ROOT };
    const ctx: FilesContext = { root, home: deps.home, privateFolders: deps.privateFolders };
    const out: HillAskFile[] = [];
    for (const file of files) {
      const checked = await linkableFile(ctx, file.path);
      if (!checked.ok) {
        if (checked.reason === "no-folder") return { ok: false, error: ASK_FILES_NO_ROOT };
        if (checked.reason === "outside") return { ok: false, error: `--file ${file.path} is outside the workspace root ${root}: link only a file under it` };
        return { ok: false, error: `--file ${file.path} is not a file the Files view opens: it does not exist, is not a regular file, or sits where Files shows nothing (.git, Collie's own folders)` };
      }
      const base: HillAskFile = { path: checked.path };
      out.push(file.heading !== undefined ? { ...base, heading: file.heading } : file.line !== undefined ? { ...base, line: file.line } : base);
    }
    return { ok: true, root: at.paneId, files: out };
  };
}

// Prime the stores from an islands document's data block (S3, islands/document-data.ts): at boot, before
// `run()` (islands/boot.ts), and before a soft navigation diffs the next document in (islands/resolver.ts),
// so the islands that re-render with the new page's props read the new page's data.
//
//   - the address, from the document's path;
//   - the snapshot, only when it is newer than the one held (a beat may have landed since the document
//     was drawn; freshness never moves back, lib/identity-seed.ts `seedStores`);
//   - the config, as the document has it;
//   - the snapshot frames' hashes (islands/snapshot-frames.ts `seedHeld`), always: they describe the HTML
//     the runtime is about to show;
//   - a pane page's read and its frames' ETag (S2's `primePane`), so the first beat answers 304 when the
//     pane did not move. The pane frames' module loads for a pane page only (the dashboard never needs it).
import { internScope, paneScopeKey, scopeFromUrl } from "@web/lib/scope";

import { paneStore } from "../lib/data";
import { seedStores } from "../lib/identity-seed";
import { displayPrefs } from "../lib/prefs";
import type { DocumentData } from "./document-data";
import { seedHeld } from "./snapshot-frames";

/** The pane id of a pane page's path (mount off), or null (lib/identity-seed.ts reads it the same way). */
const PANE_PATH = /^\/pane\/([^/?#]+)/u;

type PaneModules = [typeof import("../routes/pane/pane-frames"), typeof import("../routes/pane/data"), typeof import("../routes/pane/parse-model")];
let paneModules: PaneModules | null = null;

/** The pane modules the seed reads. Also called by the press that warms a pane (islands/registry.ts). */
export async function loadPaneModules(): Promise<PaneModules> {
  paneModules ??= await Promise.all([import("../routes/pane/pane-frames"), import("../routes/pane/data"), import("../routes/pane/parse-model")]);
  return paneModules;
}

export async function seedFromDocument(data: DocumentData): Promise<void> {
  seedStores(data);
  seedHeld(data.held);
  const url = new URL(data.path, window.location.origin);
  const raw = PANE_PATH.exec(url.pathname)?.[1];
  if (raw === undefined || data.pane === undefined) return;
  const paneId = decodeURIComponent(raw);
  const scope = internScope(scopeFromUrl(url.href));
  const store = paneStore(paneScopeKey(scope, paneId));
  // A beat of this pane may have landed after the document was read (a sideways move back): the
  // document's read is taken only when the store holds none.
  if (store.get().data === undefined) store.set({ data: data.pane.read, error: undefined, status: undefined });
  // Loaded once; after that (and after a press warmed them, islands/registry.ts) no await sits in the commit.
  const [{ paneFrameSrc, primePaneFrames }, { findPane, PANE_LINES }, { parseAgent }] = paneModules ?? (await loadPaneModules());
  const agent = parseAgent(findPane(data.snapshot, paneId)?.agent, displayPrefs.get().rawTerminal);
  primePaneFrames(paneFrameSrc(paneId, scope, PANE_LINES, agent), paneId, scope, data.pane.etag, data.pane.read);
}

// The way back from Changes to the pane that opened it, as a history pop (ADR 0067).
//
// A Changes screen under a pane is reached by walking: pane, Changes, a file, perhaps another file.
// Bringing the comments to the agent should land on the pane the way Back would, popping the walk
// off the stack, not pushing a second copy of the pane that a swipe would then walk back through.
// This is the search for that pop. It reads the tab's trail (lib/nav-trail.ts) and decides; the
// caller navigates.

import { decodedPath, pathOnly } from "./nav";
import type { TrailEntries } from "./nav-trail";

/**
 * How many history entries to pop to stand on `dest`, a pane's path, or `null` when the entries
 * just behind this one do not lead back to it. Only entries under `<dest>/changes` may be crossed:
 * a Settings page or another pane in between means the walk did not start at `dest`, and popping
 * past it would skip a screen the operator visited on purpose.
 *
 * `idx` is the current entry's history index (`history.state.idx`); `undefined` (a page that cannot
 * read it) finds nothing.
 */
export function stepsBackToPane(dest: string, idx: number | undefined, entries: TrailEntries): number | null {
  if (idx === undefined) return null;
  const destPath = decodedPath(pathOnly(dest));
  const changesPrefix = `${destPath}/changes`;
  for (let step = idx - 1; step >= 0; step--) {
    const href = entries.get(step);
    if (href === undefined) return null;
    const path = decodedPath(pathOnly(href));
    if (path === destPath) return idx - step;
    if (path !== changesPrefix && !path.startsWith(`${changesPrefix}/`)) return null;
  }
  return null;
}

// How many live snapshots this page has taken from the bridge. A successful snapshot proves the
// connection is up and the build behind it answers, so a decision made on an earlier failure (the
// file-exists check's "the bridge refused me", components/file-links.tsx) can be taken again once
// the count moves. A plain counter in module state, in the idiom of lib/busy.ts: it has no
// subscribers, because its readers look at it when they are about to act, not to repaint.

let taken = 0;

/** Count one snapshot that came back with the bridge's herd link up (lib/api.ts `fetchSnapshot`). */
export function noteSnapshotTaken(): void {
  taken += 1;
}

/** How many live snapshots have arrived since the page loaded. Only ever grows. */
export function snapshotsTaken(): number {
  return taken;
}

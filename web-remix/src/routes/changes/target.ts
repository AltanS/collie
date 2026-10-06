// Whose Changes: a pane's (the bridge resolves the pane's workspace) or a workspace asked directly.
// Both answer the same shapes (ADR 0065). `routes/frame/map.tsx` builds these from the URL.
export type ChangesTarget = { kind: "pane"; paneId: string } | { kind: "space"; spaceId: string };

/** Which of the three levels of one screen the URL is at: the list, the commit under it, the tree. */
export type ChangesLevel = "list" | "commit" | "files";

/** The screen's own key, `pane:<id>` or `space:<id>`: the key of the kept list and the folds. */
export function targetKey(target: ChangesTarget): string {
  return target.kind === "pane" ? `pane:${target.paneId}` : `space:${target.spaceId}`;
}

// What the URL says the Changes screen is showing (web/src/routes/changes.tsx, the block at the top of
// `ChangesScreen`). One screen serves every level of both targets, so the level and the query decide
// the body. Pure: the route reads `window.location.search`, this reads a string and a pref.
//
//   level "list"    …/changes                the Files tree, or the Changes list when `changesOnly`
//                   …/changes?repo=&path=     one changed file's diff
//   level "commit"  …/changes/commit?repo=    that repo's last commit, `&path=` one file of it
//   level "files"   …/changes/files           the root (neither query), `?dir=` a folder, `?path=` a file
import type { ChangeRef } from "./api";
import type { ChangesLevel } from "./target";

export interface ChangesView {
  level: ChangesLevel;
  /** The commit view. */
  commitView: boolean;
  /** `…/changes/files`: a folder or a file of the tree, or its root. */
  filesLevel: boolean;
  /** The root: the screen itself, or `…/changes/files` with neither query. */
  atRoot: boolean;
  /** The root's body is the list of changes, not the tree. */
  showList: boolean;
  /** The folder the tree shows (`""` the root), or null when this screen is not a folder. */
  treeDir: string | null;
  /** The file of the tree, or null. */
  treeFile: string | null;
  /** The list's own file screen (`?repo=&path=`): one changed file's diff. */
  open: ChangeRef | null;
  /** The commit view's repo. */
  commitRepo: string | null;
  /** The commit view's open file. */
  commitOpen: ChangeRef | null;
  /** The file either screen shows the diff of. */
  current: ChangeRef | null;
}

export function readView(level: ChangesLevel, search: string, changesOnly: boolean): ChangesView {
  const params = new URLSearchParams(search);
  const repoParam = params.get("repo");
  const pathParam = params.get("path");
  const commitView = level === "commit";
  const filesLevel = level === "files";
  const dirParam = filesLevel ? (params.get("dir") ?? "") : "";
  const treePathParam = filesLevel ? (pathParam ?? "") : "";
  const fileRef: ChangeRef | null = !filesLevel && repoParam !== null && pathParam !== null ? { repo: repoParam, path: pathParam } : null;
  const atRoot = filesLevel ? dirParam === "" && treePathParam === "" : !commitView && fileRef === null;
  const showList = atRoot && changesOnly;
  const treeFile = treePathParam !== "" ? treePathParam : null;
  const treeDir = atRoot ? (changesOnly ? null : "") : filesLevel && treeFile === null ? dirParam : null;
  const open = commitView ? null : fileRef;
  const commitOpen = commitView ? fileRef : null;
  return {
    level,
    commitView,
    filesLevel,
    atRoot,
    showList,
    treeDir,
    treeFile,
    open,
    commitRepo: commitView ? repoParam : null,
    commitOpen,
    current: open ?? commitOpen,
  };
}

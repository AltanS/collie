// The pure half of the Files view (ADR 0083): which files have a preview, how a changed file's repo
// path becomes a path under the root, how a size reads, and how a file's text splits into lines.
// Nothing here reads the DOM or the network.

/** What a Preview can draw. */
export type PreviewKind = "markdown" | "json" | "html";

// A Map, not an object literal, so a file named `x.constructor` finds nothing on the prototype.
const PREVIEW_BY_EXTENSION = new Map<string, PreviewKind>([
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["json", "json"],
  ["html", "html"],
  ["htm", "html"],
]);

/** The preview a path has by its extension, or null when it has none (Source only). */
export function previewKindFor(path: string): PreviewKind | null {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return PREVIEW_BY_EXTENSION.get(name.slice(dot + 1)) ?? null;
}

/**
 * A changed file's path from the Changes root, or null when it lies outside the root.
 *
 * The Changes list names a file by its repo and a path inside that repo; Files names it by one path
 * from the root. A repo at or below the root has a `relPath` of `.` or `a/b`. A repo ABOVE the root
 * (the root is a folder inside a repo, such as a pane opened in `repo/web`) has `..` or `../..`, and
 * its paths start with the folders between the repo and the root, which are the root's own last
 * segments. A file elsewhere in that repo is not under the root, and Files cannot open it. An
 * untracked folder's trailing slash is dropped.
 */
export function rootPathOf(root: string, repo: string, path: string): string | null {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  if (repo === "." || repo === "") return bare;
  const segments = repo.split("/");
  const ups = segments.findIndex((s) => s !== "..");
  if (ups === 0) return `${repo}/${bare}`;
  // Only ups: `..` or `../..`. A mixed shape is not one the bridge sends.
  if (ups !== -1) return null;
  const tail = root.split(/[\\/]/).filter((s) => s !== "");
  if (tail.length < segments.length) return null;
  const prefix = `${tail.slice(-segments.length).join("/")}/`;
  if (!bare.startsWith(prefix) || bare.length === prefix.length) return null;
  return bare.slice(prefix.length);
}

/**
 * The folder as the Files header spells it beside the workspace label. The whole path, with the
 * screen cutting it from the LEFT when it does not fit (so the last folders stay readable), except
 * that a folder named like the label is not said twice: the label already is its last segment, so
 * only the folders above it show, ending in a slash.
 */
export function headerFolder(path: string, label: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut === -1 || trimmed.slice(cut + 1) !== label) return trimmed === "" ? path : trimmed;
  return trimmed.slice(0, cut + 1);
}

/** The last segment of a path: a file's name, a folder's name, or `""` for the root. */
export function baseName(path: string): string {
  return path.split("/").at(-1) ?? "";
}

/** A folder and a child's name as one root-relative path. `""` is the root. */
export function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** A byte count as a person reads it: `812 B`, `3.4 KB`, `1.2 MB`. Binary steps, the usual labels. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * A file's text as the lines a reader counts. CRLF reads as one break, and the newline that ends the
 * last line does not start another empty one. An empty file has no lines.
 */
/**
 * The most lines the Files view puts in the DOM for one file. A 1 MiB file of short lines is a
 * quarter of a million rows, and the tab stops answering well before that. Past the cap the screen
 * says so in one plain line. Markdown past it shows its source instead of a rendered page.
 */
export const RENDER_MAX_LINES = 5000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const normal = text.replace(/\r\n/g, "\n");
  return (normal.endsWith("\n") ? normal.slice(0, -1) : normal).split("\n");
}

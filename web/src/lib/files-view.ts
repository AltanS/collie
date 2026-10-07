// The pure half of the Files view (ADR 0083): which files have a preview, how a changed file's repo
// path becomes a path under the root, how a size reads, and how a file's text splits into lines.
// Nothing here reads the DOM or the network.

/** What a Preview can draw. An SVG is text, read by the text read and drawn as a picture (ADR 0090). */
export type PreviewKind = "markdown" | "json" | "html" | "svg";

// A Map, not an object literal, so a file named `x.constructor` finds nothing on the prototype.
const PREVIEW_BY_EXTENSION = new Map<string, PreviewKind>([
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["json", "json"],
  ["html", "html"],
  ["htm", "html"],
  ["svg", "svg"],
]);

/** A path's extension, lower-cased, or `""` for none. A dot-file (`.md`) has none. */
function extensionOf(path: string): string {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** The preview a path has by its extension, or null when it has none (Source only). */
export function previewKindFor(path: string): PreviewKind | null {
  return PREVIEW_BY_EXTENSION.get(extensionOf(path)) ?? null;
}

// The raster pictures the bridge's image read serves (ADR 0090), by the name a reader expects. The
// name only decides whether the phone ASKS: the bridge reads the type off the bytes, and a file that
// is not what its name says answers 415, which the screen shows as the binary line it was before.
const RASTER_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);

/** Whether a path names a raster picture the image read may serve: png, jpg, jpeg, gif, webp, avif. */
export function isRasterImagePath(path: string): boolean {
  return RASTER_EXTENSIONS.has(extensionOf(path));
}

// The word a caption gives each type the bridge sniffs, and SVG's, which the phone draws itself.
const IMAGE_TYPE_WORD = new Map<string, string>([
  ["image/png", "PNG"],
  ["image/jpeg", "JPEG"],
  ["image/gif", "GIF"],
  ["image/webp", "WebP"],
  ["image/avif", "AVIF"],
  ["image/svg+xml", "SVG"],
]);

/**
 * A picture's caption: `1200 × 800 · 51 KB · PNG`. Each part only when it is known: the size the
 * text read gave, the natural size once the picture has drawn, the word for the type the bytes have.
 * No words of Collie's own are in it, so it is the same in every language.
 */
export function imageCaption(parts: { width?: number; height?: number; size?: number; type?: string }): string {
  const out: string[] = [];
  if (parts.width !== undefined && parts.height !== undefined && parts.width > 0 && parts.height > 0) {
    out.push(`${parts.width} × ${parts.height}`);
  }
  if (parts.size !== undefined) out.push(formatBytes(parts.size));
  const word = parts.type === undefined ? undefined : IMAGE_TYPE_WORD.get(parts.type.split(";")[0]!.trim().toLowerCase());
  if (word !== undefined) out.push(word);
  return out.join(" · ");
}

/**
 * A changed file's path from the Changes root, or null when it lies outside the root.
 *
 * The Changes list names a file by its repo and a path inside that repo; Files names it by one path
 * from the root. A repo at or below the root has a `relPath` of `.` or `a/b`. A repo ABOVE the root
 * (the root is a folder inside a repo, such as a pane opened in `repo/web`) has `..` or `../..`, and
 * its paths start with the folders between the repo and the root, which are the root's own last
 * segments. A file elsewhere in that repo is not under the root, and Files cannot open it. An
 * untracked folder's trailing slash is dropped. An untracked folder that holds the root, or is it,
 * comes out as `""`: the root itself is untracked. A root that is a Windows drive or UNC path
 * matches the folders without regard to case.
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
  // On Windows git spells a path as it is on disk and the root's realpath may spell it otherwise.
  const fold = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(root) ? (v: string) => v.toLowerCase() : (v: string) => v;
  // An untracked folder that holds the root (or is the root): git lists the folder, not its files,
  // so the root itself is untracked. `""` is the root's own path.
  if (path.endsWith("/") && fold(prefix).startsWith(`${fold(bare)}/`)) return "";
  if (!fold(bare).startsWith(fold(prefix)) || bare.length === prefix.length) return null;
  return bare.slice(prefix.length);
}

/**
 * What the Files header says after the workspace label: the root folder's LAST segment when it is
 * another name than the label, `""` when it is the label itself (or the root is `/`). Never the
 * whole path, which a phone has no room for and the breadcrumb below already tells.
 */
export function headerFolder(path: string, label: string): string {
  const last = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  return last === label ? "" : last;
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

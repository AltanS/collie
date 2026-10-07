import type { FilesAt } from "@/lib/nav";

// Where a relative link in a Markdown FILE leads, inside the Files view (ADR 0083).
//
// A README is read where it lives, so `[guide](./docs/guide.md)` means the guide next to it, and
// `[home](/README.md)` means the README at the root of the folder Files shows, never the app's own
// origin. This is pure string work on paths relative to that root: it knows nothing of the router or
// the disk. The bridge is what keeps a path inside the root; the check here only saves a reader a
// tap that could not have worked, so a link that climbs past the root reads as text.

/**
 * Where `href` leads from the file at `fromPath`, or null when it leads nowhere a reader can go:
 * past the root, or onto a path that is not text at all.
 *
 * `?query` and `#fragment` are dropped, the rest is percent-decoded ONCE (`my%20file.md` is
 * `my file.md`; a malformed escape is no link), then resolved against the file's folder, with `.`
 * and `..` folded. A root-absolute `/x` starts at the root instead. A path that ends in a slash, or
 * in `.` or `..`, is a folder; anything else is asked for as a file, and the screen falls back to a
 * folder when that file turns out to be one (`viaLink`).
 */
export function resolveFileLink(href: string, fromPath: string): FilesAt | null {
  const cut = href.search(/[?#]/);
  const raw = cut === -1 ? href : href.slice(0, cut);
  if (raw === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const rooted = decoded.startsWith("/");
  const segments: string[] = rooted ? [] : fromPath.split("/").slice(0, -1);
  const parts = decoded.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const last = parts[parts.length - 1] ?? "";
  const folder = last === "" || last === "." || last === "..";
  const rel = segments.join("/");
  if (folder || rel === "") return { dir: rel };
  return { path: rel };
}

// A URL scheme: `https:`, `data:`, `javascript:`. Anything with one is not a file under the root.
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The file an image in a Markdown file names (`![alt](src)`, ADR 0090), as a path from the root, or
 * null when the preview must not load it and shows the alt text instead, as it always has.
 *
 * Only a RELATIVE `src` resolves: no scheme, and not starting with `/`, `~` or `//`. A remote picture
 * stays its alt text (the page's CSP would refuse it anyway, and a README must not make the phone
 * call a stranger's server), and a root-absolute one is left alone, because on the web it means the
 * site's root and nobody wrote it to mean this folder. The rest resolves against the file's folder by
 * {@link resolveFileLink}, so a `..` that climbs past the root is null, and so is a path through a
 * `.git` folder, which the bridge refuses anyway.
 */
export function resolveImageSrc(src: string, fromPath: string): string | null {
  const raw = src.trim();
  if (raw === "" || SCHEME.test(raw) || raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("#") || raw.startsWith("?")) {
    return null;
  }
  const at = resolveFileLink(raw, fromPath);
  if (at === null || at.path === undefined) return null;
  if (at.path.split("/").some((segment) => segment.toLowerCase() === ".git")) return null;
  return at.path;
}

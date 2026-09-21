// Where this app is mounted (ADR 0052): `/` at the origin root, `/collie/` behind a proxy that
// gives Collie a path. ONE BUILD SERVES ANY MOUNT, so the value is not known at build time and is
// not a Vite constant. The bridge writes it into `<meta name="collie-base">` when it serves
// index.html (bridge/server.ts, `mountIndexHtml`), and this module is the one reader.
//
// Read SYNCHRONOUSLY at first use and cached: the router is built at module scope and the first
// `apiFetch` fires from a loader, both before any effect runs, so nothing here may wait. With no
// meta tag (the Vite dev server, a test) the answer is the root, which is what every URL in the
// code base already assumed.

let cached: string | null = null;

/** The mount, always with a leading and a trailing slash: `/` or `/collie/`. */
export function basePath(): string {
  cached ??= readMount();
  return cached;
}

/**
 * A root-absolute path as the mounted origin serves it: `mounted("/api/snapshot")` is
 * `/collie/api/snapshot` under `/collie/` and unchanged at the root. Anything that is not
 * root-absolute (a full URL, a relative path) is returned as it came.
 */
export function mounted(path: string): string {
  const base = basePath();
  if (base === "/" || !path.startsWith("/")) return path;
  return `${base.slice(0, -1)}${path}`;
}

/** Forget the cached mount, so a test can set the meta tag and read again. */
export function resetBasePathForTests(): void {
  cached = null;
}

function readMount(): string {
  const raw = document.querySelector('meta[name="collie-base"]')?.getAttribute("content") ?? "";
  return normalise(raw);
}

/** The same shape the bridge produces (`normaliseBasePath`, bridge/config.ts): `/` or `/a/b/`. */
function normalise(raw: string): string {
  const segments = raw.trim().split("/").filter((s) => s !== "");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

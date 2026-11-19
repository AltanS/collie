// THE PUSH COPY OF A PROJECT PICTURE (issue 811, ADR 0161), read by the service worker.
//
// The page keeps its own PNG of each picture (lib/project-picture.ts), drawn on a canvas from the bytes
// it fetched, and a map from a pane to the picture's version, both in one Cache per mount. A push names
// its pane; the worker looks the pane up, finds the page's copy, and hands it to the notification as a
// `data:` URL. Nothing is fetched at push time, and the repository's own bytes never reach the operating
// system, which decodes a notification's icon outside the browser's sandbox. No map, no entry or no copy
// means the Collie icon.
//
// Imported by both sides, so this module holds no state, imports no React and has no side effect.

import { isPictureVersion } from "./project-picture-wire";

/** The Cache the push copies and the pane map live in, per mount (two collies on one origin keep their own). */
export function projectPictureCacheName(mount: string): string {
  return mount === "/" ? "collie-project-pictures" : `collie-project-pictures:${mount}`;
}

/** The key of one push copy in that Cache. Never requested from the network. */
export function pushCopyKey(origin: string, mount: string, version: string): string {
  return `${origin}${mount}project-pictures/${version}.png`;
}

/** The key of the pane map in that Cache. Never requested from the network. */
export function paneMapKey(origin: string, mount: string): string {
  return `${origin}${mount}project-pictures/panes.json`;
}

/**
 * The map's key for one pane: its machine and its pane id. Not its session: a push names the primary
 * session as no session at all, while a widened snapshot names it, so the two would never meet. Two
 * sessions on one machine with the same pane id share one entry, and the later one wins; the cost is a
 * push showing the other pane's picture, never a picture from outside this device's own copies.
 */
export function paneKey(pane: { host?: string | null; paneId: string }): string {
  return `${pane.host ?? ""}\u0000${pane.paneId}`;
}

/** The one slice of Cache Storage the worker's read needs, so a test can fake it. */
export interface PictureCaches {
  has(cacheName: string): Promise<boolean>;
  open(cacheName: string): Promise<Pick<Cache, "match">>;
}

/** A PNG's bytes as a `data:` URL. */
function asDataUrl(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:image/png;base64,${btoa(text)}`;
}

/** The PNG signature: only the page's own copy is ever handed on, never anything else in the Cache. */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The icon for a push about `pane`, as a `data:` URL of the page's own copy, or null for the Collie icon.
 * Never throws and never fetches.
 */
export async function pushPictureFor(
  caches: PictureCaches,
  origin: string,
  mount: string,
  pane: { host?: string | null; paneId?: string | null } | undefined,
): Promise<string | null> {
  if (pane?.paneId === undefined || pane.paneId === null || pane.paneId === "") return null;
  try {
    const name = projectPictureCacheName(mount);
    if (!(await caches.has(name))) return null;
    const cache = await caches.open(name);
    const map = await cache.match(paneMapKey(origin, mount));
    if (map === undefined) return null;
    const table = asTable(await map.text());
    const version = table.get(paneKey({ host: pane.host, paneId: pane.paneId }));
    if (version === undefined || !isPictureVersion(version)) return null;
    const copy = await cache.match(pushCopyKey(origin, mount, version));
    if (copy === undefined) return null;
    const bytes = new Uint8Array(await copy.arrayBuffer());
    return PNG_HEAD.every((b, i) => bytes[i] === b) ? asDataUrl(bytes) : null;
  } catch {
    return null;
  }
}

/** A stored `{ pane: version }` table; anything malformed reads as empty. */
function asTable(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: Record<string, string> | null = null;
  try {
    // SAFETY: every entry is checked below before it is kept; the cast only names what `JSON.parse`
    // returned as a record so the loop can read it.
    doc = JSON.parse(text) as Record<string, string>;
  } catch {
    return out;
  }
  if (doc === null || Array.isArray(doc) || !(doc instanceof Object)) return out;
  for (const [k, v] of Object.entries(doc)) if (isPictureVersion(Object.prototype.toString.call(v) === "[object String]" ? v : null)) out.set(k, v);
  return out;
}

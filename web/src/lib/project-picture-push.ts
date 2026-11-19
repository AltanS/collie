// THE PUSH PICTURE OF A PROJECT (issue 811, ADR 0160), read by the service worker.
//
// A notification's ICON is always Collie's, and so is its badge: no repository, setting or session
// changes them (the owner, 2026-11-19). A project picture travels only in the notification's own picture
// slot, `image`, which Android shows as a wide banner when the notification is expanded. Nothing is drawn
// on top of it: no agent logo, no badge, no ring.
//
// The page keeps its own banner PNG of each picture (lib/project-picture.ts), drawn on a canvas of the
// banner's shape ({@link BANNER_WIDTH} x {@link BANNER_HEIGHT}, 2:1) from the bytes it fetched, the picture
// whole and centred on a transparent ground, never cropped or stretched. Beside the copies sits a map
// from a pane to the version it showed when the page last wrote it, both in one Cache per mount. A push
// names its pane; the worker looks the pane up and takes the copy of THAT machine and THAT version, as a
// `data:` URL. Nothing is fetched at push time, and the repository's own bytes never reach the operating
// system, which decodes a notification's pictures outside the browser's sandbox. No map, no entry, no
// copy, a copy that is not a PNG, or a system with no `image` slot (Safari, Firefox): the push has no
// picture and is otherwise unchanged.
//
// Imported by both sides, so this module holds no state, imports no React and has no side effect.

import { isPictureVersion } from "./project-picture-wire";

/** The banner copy's size in px: the 2:1 shape Chrome on Android shows an expanded notification's image in. */
export const BANNER_WIDTH = 1024;
export const BANNER_HEIGHT = 512;

/** The Cache the banner copies and the pane map live in, per mount (two collies on one origin keep their own). */
export function projectPictureCacheName(mount: string): string {
  return mount === "/" ? "collie-project-pictures" : `collie-project-pictures:${mount}`;
}

/** One machine's part of a key: the lead (no host) or a member by name, so no host can spell another's. */
function machinePart(host: string | null | undefined): string {
  return host === undefined || host === null || host === "" ? "lead" : `host-${encodeURIComponent(host)}`;
}

/**
 * The key of one banner copy in that Cache, by machine AND version, so one machine can never supply the
 * picture another machine's pane shows. Never requested from the network.
 */
export function bannerCopyKey(origin: string, mount: string, host: string | null | undefined, version: string): string {
  return `${origin}${mount}project-pictures/${machinePart(host)}/${version}.png`;
}

/** The key of the pane map in that Cache. Never requested from the network. */
export function paneMapKey(origin: string, mount: string): string {
  return `${origin}${mount}project-pictures/panes.json`;
}

/**
 * The map's key for one pane: its machine and its pane id. Not its session: a push names the primary
 * session as no session at all, while a widened snapshot names it, so the two would never meet. The entry
 * holds the version the page saw for the pane; a pane that leaves the herd or changes its picture is
 * rewritten at the page's next snapshot. Until then a reused pane id can show the old picture.
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
 * The banner picture for a push about `pane`, as a `data:` URL of the page's own copy for that pane's
 * machine and the version the page last wrote for it, or null for none. Never throws and never fetches.
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
    const copy = await cache.match(bannerCopyKey(origin, mount, pane.host, version));
    if (copy === undefined) return null;
    const bytes = new Uint8Array(await copy.arrayBuffer());
    return PNG_HEAD.every((b, i) => bytes[i] === b) ? asDataUrl(bytes) : null;
  } catch {
    return null;
  }
}

/** Whether this system's notifications have a picture slot. Safari and Firefox have none. */
export function notificationsShowImage(kind: { prototype: object } | undefined): boolean {
  return kind !== undefined && "image" in kind.prototype;
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

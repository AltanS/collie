// THE PUSH PICTURE OF A PROJECT (issue 811, ADR 0160), read by the service worker.
//
// A push about a session whose repository names a picture shows that picture as the notification's ICON,
// the small square beside the title, and sets no `image`: Android draws `image` as a full-width picture
// about half the notification tall, which the owner found far too large (2026-11-20, "yes approve small
// square"). The badge stays Collie's, and with no picture the icon is the Collie mark as before. Nothing
// is drawn on top of the picture: no agent logo, no badge, no ring.
//
// The page keeps its own square PNG of each picture for this (lib/project-picture.ts), drawn on a canvas
// of {@link PUSH_ICON_PX} px from the bytes it fetched, the picture whole and centred on a transparent
// ground, never cropped or stretched. Beside the copies sits a map
// from a pane to the version it showed when the page last wrote it, both in one Cache per mount. A push
// names its pane; the worker looks the pane up and takes the copy of THAT machine and THAT version, as a
// `data:` URL. Nothing is fetched at push time, and the repository's own bytes never reach the operating
// system, which decodes a notification's pictures outside the browser's sandbox. No map, no entry, no
// copy, or a copy that is not a PNG: the push shows the Collie mark and is otherwise unchanged. A system
// that draws its own icon in place of `icon` (Safari) shows that, as it did before.
//
// Imported by both sides, so this module holds no state, imports no React and has no side effect.

import { isPictureVersion } from "./project-picture-wire";

/**
 * The push icon copy's side in px. Android draws a notification's large icon at 64 dp, which is 192 px on
 * a 3x screen and less on most phones, and desktop browsers draw theirs smaller still, so the copy is
 * scaled down and never up. A few KB, where the 1024 x 512 banner it replaced was up to 1 MB.
 */
export const PUSH_ICON_PX = 192;

/** The Cache the push icon copies and the pane map live in, per mount (two collies on one origin keep their own). */
export function projectPictureCacheName(mount: string): string {
  return mount === "/" ? "collie-project-pictures" : `collie-project-pictures:${mount}`;
}

/** One machine's part of a key: the lead (no host) or a member by name, so no host can spell another's. */
function machinePart(host: string | null | undefined): string {
  return host === undefined || host === null || host === "" ? "lead" : `host-${encodeURIComponent(host)}`;
}

/**
 * The key of one push icon copy in that Cache, by machine AND version, so one machine can never supply the
 * picture another machine's pane shows. Never requested from the network. `icon-` keeps it apart from the
 * 2:1 banner copies an older build kept under `<version>.png`, which the page's pruning then deletes.
 */
export function iconCopyKey(origin: string, mount: string, host: string | null | undefined, version: string): string {
  return `${origin}${mount}project-pictures/${machinePart(host)}/icon-${version}.png`;
}

/**
 * The switch's marker, for the worker, which cannot read localStorage: present while "Project pictures"
 * is off on this device, in a Cache of its own so that turning the switch off (which deletes the picture
 * Cache) never deletes it. The page writes and removes it with the switch, and again at every start.
 */
export function pictureSwitchCacheName(mount: string): string {
  return mount === "/" ? "collie-project-pictures-switch" : `collie-project-pictures-switch:${mount}`;
}

/** The marker's key in its Cache. Never requested from the network. */
export function pictureSwitchKey(origin: string, mount: string): string {
  return `${origin}${mount}project-pictures-off`;
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
 * The icon for a push about `pane`, as a `data:` URL of the page's own copy for that pane's
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
    // The switch is off on this device, whatever another tab still holds in memory.
    const switchName = pictureSwitchCacheName(mount);
    if (await caches.has(switchName)) {
      const marker = await (await caches.open(switchName)).match(pictureSwitchKey(origin, mount));
      if (marker !== undefined) return null;
    }
    const name = projectPictureCacheName(mount);
    if (!(await caches.has(name))) return null;
    const cache = await caches.open(name);
    const map = await cache.match(paneMapKey(origin, mount));
    if (map === undefined) return null;
    const table = asTable(await map.text());
    const version = table.get(paneKey({ host: pane.host, paneId: pane.paneId }));
    if (version === undefined || !isPictureVersion(version)) return null;
    const copy = await cache.match(iconCopyKey(origin, mount, pane.host, version));
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

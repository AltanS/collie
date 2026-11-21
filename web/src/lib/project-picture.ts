import { useEffect, useSyncExternalStore } from "react";

import { fetchAuthedBytes } from "@/lib/api";
import { basePath } from "@/lib/base-path";
import { iconCopyKey, paneKey, paneMapKey, pictureSwitchCacheName, pictureSwitchKey, projectPictureCacheName, PUSH_ICON_PX } from "@/lib/project-picture-push";
import { isPictureVersion, pictureHeaderFits, PROJECT_PICTURE_BYTES_MAX, projectPicturePath } from "@/lib/project-picture-wire";
import { onWipe } from "@/lib/wipe";
import type { AgentView } from "@/lib/types";

// THE PROJECT PICTURE ON THE PHONE (issue 811, ADR 0160).
//
// A pane's view carries `picture`, the version of the picture its repository's `collie.toml` names. This
// module turns a version into something the page can draw at once, and keeps what the service worker
// needs to put the same picture on a push.
//
// EVERYTHING IS KEYED BY MACHINE AND VERSION. A version is a hash of the bytes, but the bytes come from
// one machine's disk, so one machine can never supply, or block, the picture of another machine's pane.
//
// THE PAGE NEVER DRAWS THE REPOSITORY'S BYTES TWICE. The bytes are fetched once per machine and version
// with the pairing token, checked on their header before any decode ({@link pictureHeaderFits}: the size
// cap, PNG, JPEG or WebP, each side in range), decoded by the browser into a bitmap, and drawn onto a
// canvas. What is kept, and what every surface shows, is the page's own PNG made from that canvas:
//
//   - a small copy ({@link SMALL_PX} px square), a `data:` URL in localStorage, so a cold open draws the
//     picture in the first frame instead of the agent logo (bounded to {@link COPIES_MAX});
//   - a push icon copy ({@link PUSH_ICON_PX} px square, lib/project-picture-push.ts), a PNG in Cache
//     Storage, which the service worker puts in a notification's icon. The operating system decodes it
//     outside the browser's sandbox, so it gets this re-encoded copy and never the repository's bytes
//     (sw.ts). The badge is always Collie's.
//
// Beside them, a small map from a pane (machine and pane id) to its version, rewritten from each snapshot
// (a pane that left the herd or changed its picture loses its old entry), in localStorage for the page's
// first frame and in Cache Storage for the service worker, which has no localStorage. A push names its
// pane, never a folder or a version.
//
// THE SWITCH. Settings, Look and feel, "Project pictures", per device, on until the person turns it off.
// Off: no picture anywhere, the agent logo everywhere, no push picture. Turning it off
// also drops every copy and the map, so nothing of a repository's picture stays on the device.
//
// A version that fails to load (the bridge refused, the header check failed, the bytes do not decode) is
// tried again only after a backoff that doubles from {@link RETRY_FIRST_MS} to {@link RETRY_MAX_MS}, so a
// broken picture cannot make the phone fetch on every poll, and a 404 from a bridge still reading its
// disk does not block the picture for the rest of the page's life.

/** The small copy's side, in px: three times the 32 px a header tile draws at most. */
export const SMALL_PX = 96;
/** The first wait before a failed version is tried again, and the longest. */
export const RETRY_FIRST_MS = 15_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** How many small copies the device keeps, newest kept. */
export const COPIES_MAX = 16;
/** How many panes the map remembers. */
export const PANES_MAX = 64;

const SWITCH_KEY = "collie:project-pictures:v1";
const COPIES_KEY = "collie:project-picture-copies:v1";
const PANES_KEY = "collie:project-picture-panes:v1";

/** A pane's picture version, or null. A malformed one from a peer reads as none. */
export function panePicture(pane: Pick<AgentView, "picture">): string | null {
  return isPictureVersion(pane.picture) ? pane.picture : null;
}

// ── storage ──────────────────────────────────────────────────────────────────────────────────────

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Quota or private mode: what is in memory still draws for this page.
  }
}

/** A stored `{ key: text }` object, its entries in insertion order; anything malformed reads as empty. */
function readTable(key: string, accept: (k: string, v: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const raw = read(key);
  if (raw === null) return out;
  let doc: Record<string, string> | null = null;
  try {
    // SAFETY: every entry is checked by `accept` below before it is kept; the cast only names what
    // `JSON.parse` returned as a record so the loop can read it.
    doc = JSON.parse(raw) as Record<string, string>;
  } catch {
    return out;
  }
  if (doc === null || Array.isArray(doc) || !(doc instanceof Object)) return out;
  for (const [k, v] of Object.entries(doc)) if (Object.prototype.toString.call(v) === "[object String]" && accept(k, v)) out.set(k, v);
  return out;
}

function writeTable(key: string, table: Map<string, string>): void {
  write(key, table.size === 0 ? null : JSON.stringify(Object.fromEntries(table)));
}

/** The key of one picture: its machine (empty for the lead) and its version. */
function copyKey(host: string | null | undefined, version: string): string {
  return `${host ?? ""}\u0000${version}`;
}

const isCopy = (k: string, v: string) => isPictureVersion(k.slice(k.lastIndexOf("\u0000") + 1)) && k.includes("\u0000") && v.startsWith("data:image/png;base64,");
const isPane = (_k: string, v: string) => isPictureVersion(v);

let on = read(SWITCH_KEY) !== "off";
let copies = readTable(COPIES_KEY, isCopy);
let panes = readTable(PANES_KEY, isPane);
/** Failed loads by copy key: when the next try may run, and the wait after that. */
const failed = new Map<string, { until: number; wait: number }>();
const loading = new Map<string, Promise<void>>();
/** One retry timer per failed copy key: it fires when the wait ends, not only when a row draws again. */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

// THE WORKER'S HALF IS REPAIRED, NOT TRUSTED (round 17). The small copies and the pane memory live in
// localStorage; the push icon copies and the map the worker reads live in Cache Storage. The two can part: a stuck
// update's escape (lib/pwa.ts) deletes every Cache and keeps localStorage, and so may the browser. Before,
// the page then saw its copy and an unchanged map and wrote neither again, so every push came without its
// picture while the dashboard still showed it (the operator's phone, 2026-11-20). Now each page life writes
// the map once, and checks once per picture that its icon copy is in the Cache, drawing it again when not.
/** Icon copy URLs this page life has seen in the Cache, or written there. */
const iconsHeld = new Set<string>();
/** The map this page life last wrote to the Cache, as its JSON, or null for none yet. */
let mapWritten: string | null = null;

// THE LEAD'S OWN PANES, AS A PUSH NAMES THEM (round 17). In a crew the merged snapshot tags the lead's own
// panes with the lead's id, while the lead's own push names no host at all (bridge/push.ts). The worker
// reads by the push's words, so the map and the icon copies name the lead's panes with no host.
let leadHost: string | null = null;

/** A pane's machine as its push names it: none for the lead's own panes, the member's id for a member's. */
function pushHost(host: string | null | undefined): string | null {
  return host === undefined || host === null || host === "" || host === leadHost ? null : host;
}
const listeners = new Set<() => void>();
let snapshot = 0;

function emit(): void {
  snapshot += 1;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getSnapshot = () => snapshot;

/** Whether this device shows project pictures. */
export function projectPicturesOn(): boolean {
  return on;
}

/** The switch, reactive. */
export function useProjectPicturesOn(): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return on;
}

/** The Settings switch. Off drops every copy and the map, on this device and in Cache Storage. */
export function setProjectPictures(next: boolean): void {
  if (on === next) return;
  on = next;
  write(SWITCH_KEY, next ? null : "off");
  void writeSwitchMarker(next);
  if (!next) void forgetProjectPictures();
  emit();
}

/** The worker's copy of the switch (project-picture-push.ts): present while the switch is off. */
async function writeSwitchMarker(isOn: boolean): Promise<void> {
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined) return;
  try {
    const name = pictureSwitchCacheName(basePath());
    if (isOn) {
      await storage.delete(name);
      return;
    }
    const cache = await storage.open(name);
    await cache.put(pictureSwitchKey(location.origin, basePath()), new Response("off", { headers: { "content-type": "text/plain" } }));
  } catch {
    // No Cache Storage: the page's own off still drops every copy, so the worker has none to show.
  }
}

/**
 * The switch as another tab set it. Every tab of this device holds the switch in memory, so a tab that
 * missed the change would write the map and the icon copies again; the `storage` event brings it along.
 */
function followOtherTabs(event: StorageEvent): void {
  if (event.key !== SWITCH_KEY && event.key !== null) return;
  const next = read(SWITCH_KEY) !== "off";
  if (next === on) return;
  on = next;
  if (!next) void forgetProjectPictures();
  emit();
}

if (globalThis.window !== undefined) {
  globalThis.window.addEventListener("storage", followOtherTabs);
  // At every start the marker follows the switch, so a wipe that cleared Cache Storage cannot leave the
  // worker believing an off switch is on.
  void writeSwitchMarker(on);
}

/** Drop every copy and the pane map: the switch's off, and the device wipe. The switch itself stays. */
export async function forgetProjectPictures(): Promise<void> {
  copies = new Map();
  panes = new Map();
  iconsHeld.clear();
  mapWritten = null;
  failed.clear();
  clearRetries(() => true);
  write(COPIES_KEY, null);
  write(PANES_KEY, null);
  emit();
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined) return;
  try {
    await storage.delete(projectPictureCacheName(basePath()));
  } catch {
    // Cache Storage refused: the wipe's own cache sweep still runs.
  }
}

// The device wipe (lib/wipe.ts) drops the copies and the map: pictures this pairing's repositories named.
// The switch stays, like every look preference. A password wipe touches session text only.
onWipe("project-pictures", (context) => (context.reason === "password" ? undefined : forgetProjectPictures()));

/** The small copy of one machine's version, or null. Synchronous: what the first frame draws. */
export function pictureCopy(host: string | null | undefined, version: string | null): string | null {
  if (!on || version === null) return null;
  return copies.get(copyKey(host, version)) ?? null;
}

/** The version the device last saw for a pane, or null: a tile's guess before the snapshot lands. */
export function rememberedPicture(pane: { host?: string | null; session?: string | null; paneId: string }): string | null {
  if (!on) return null;
  return panes.get(paneKey(pane)) ?? null;
}

// ── the canvas copy ─────────────────────────────────────────────────────────────────────────────

/** What the page needs to turn bytes into its own PNG. A seam, so a test runs without a canvas. */
export interface PictureCanvas {
  /** The picture drawn into each box, kept whole and centred on a transparent ground, as PNGs. */
  draw(bytes: Blob, boxes: readonly { width: number; height: number }[]): Promise<Blob[]>;
  /** A PNG as a `data:` URL. */
  dataUrl(png: Blob): Promise<string>;
}

/** The browser's own decoder and canvas. */
export const browserCanvas: PictureCanvas = {
  async draw(bytes, boxes) {
    const bitmap = await createImageBitmap(bytes);
    try {
      const out: Blob[] = [];
      for (const box of boxes) {
        const canvas = new OffscreenCanvas(box.width, box.height);
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no 2d canvas");
        // Contain: the whole picture, centred, never cropped and never stretched.
        const scale = Math.min(box.width / bitmap.width, box.height / bitmap.height);
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        ctx.drawImage(bitmap, Math.round((box.width - w) / 2), Math.round((box.height - h) / 2), w, h);
        out.push(await canvas.convertToBlob({ type: "image/png" }));
      }
      return out;
    } finally {
      bitmap.close();
    }
  },
  async dataUrl(png) {
    const bytes = new Uint8Array(await png.arrayBuffer());
    let text = "";
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return `data:image/png;base64,${btoa(text)}`;
  },
};

let canvas: PictureCanvas = browserCanvas;
let fetchBytes: (path: string) => Promise<Blob> = (path) => fetchAuthedBytes(path);
let clock: () => number = Date.now;

/** Test seam: replace the canvas, the fetch and the clock. */
export function __setProjectPictureSeams(seams: { canvas?: PictureCanvas; fetch?: (path: string) => Promise<Blob>; now?: () => number }): void {
  if (seams.canvas !== undefined) canvas = seams.canvas;
  if (seams.fetch !== undefined) fetchBytes = seams.fetch;
  if (seams.now !== undefined) clock = seams.now;
}

/** Test seam: back to a device that never saw a picture, the switch on. */
export function __resetProjectPictures(): void {
  on = true;
  copies = new Map();
  panes = new Map();
  iconsHeld.clear();
  mapWritten = null;
  leadHost = null;
  failed.clear();
  clearRetries(() => true);
  loading.clear();
  write(SWITCH_KEY, null);
  write(COPIES_KEY, null);
  write(PANES_KEY, null);
  canvas = browserCanvas;
  fetchBytes = (path) => fetchAuthedBytes(path);
  clock = Date.now;
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadProjectPictures(): void {
  on = read(SWITCH_KEY) !== "off";
  copies = readTable(COPIES_KEY, isCopy);
  panes = readTable(PANES_KEY, isPane);
  iconsHeld.clear();
  mapWritten = null;
  failed.clear();
  clearRetries(() => true);
  loading.clear();
  emit();
}

/** Stop the retry timers whose key `drop` names. */
function clearRetries(drop: (key: string) => boolean): void {
  for (const [key, timer] of retryTimers) {
    if (!drop(key)) continue;
    clearTimeout(timer);
    retryTimers.delete(key);
  }
}

function keepCopy(key: string, url: string): void {
  copies.delete(key);
  copies.set(key, url);
  while (copies.size > COPIES_MAX) {
    const oldest = copies.keys().next().value;
    if (oldest === undefined) break;
    copies.delete(oldest);
  }
  writeTable(COPIES_KEY, copies);
}

/** The icon copy key of a small copy key, for the pruning below. */
function iconKeyOf(key: string): string {
  const cut = key.lastIndexOf("\u0000");
  const host = key.slice(0, cut);
  return iconCopyKey(location.origin, basePath(), pushHost(host), key.slice(cut + 1));
}

/**
 * Keep one push icon copy, and drop every other key that is not among the newest {@link COPIES_MAX}: the same
 * pictures the small copies hold, so a repository that changes its picture every few seconds costs the
 * device at most {@link COPIES_MAX} icon copies (a few KB each). The 2:1 banners an older build kept go at the first write.
 */
async function keepIconCopy(host: string | null | undefined, version: string, png: Blob): Promise<void> {
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined || !on) return;
  try {
    const cache = await storage.open(projectPictureCacheName(basePath()));
    const url = iconCopyKey(location.origin, basePath(), pushHost(host), version);
    await cache.put(url, new Response(png, { headers: { "content-type": "image/png" } }));
    iconsHeld.add(url);
    const kept = new Set([...copies.keys()].map(iconKeyOf));
    const map = paneMapKey(location.origin, basePath());
    for (const request of await cache.keys()) {
      if (request.url !== map && !kept.has(request.url)) await cache.delete(request);
    }
  } catch {
    // No Cache Storage (plain HTTP, private mode): the push shows the Collie icon.
  }
}

/** The map the worker reads: every remembered pane, keyed as its push names it. Written when it differs from this page life's last write. */
async function writePaneMap(): Promise<void> {
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined || !on) return;
  const table: Record<string, string> = {};
  for (const [key, version] of panes) {
    const cut = key.indexOf("\u0000");
    table[paneKey({ host: pushHost(key.slice(0, cut)), paneId: key.slice(cut + 1) })] = version;
  }
  const json = JSON.stringify(table);
  if (json === mapWritten) return;
  try {
    const cache = await storage.open(projectPictureCacheName(basePath()));
    await cache.put(paneMapKey(location.origin, basePath()), new Response(json, { headers: { "content-type": "application/json" } }));
    mapWritten = json;
  } catch {
    // As above: the push shows the Collie icon.
  }
}

/** Fetch, check, decode and keep one machine's version, once at a time. Never rejects. */
export function loadPicture(version: string, host?: string | null): Promise<void> {
  const key = copyKey(host, version);
  if (!on) return Promise.resolve();
  if (copies.has(key)) return holdIcon(version, host);
  return drawPicture(version, host);
}

/** A copy the page holds: check once per page life that the worker's icon copy of it is in the Cache too. */
async function holdIcon(version: string, host: string | null | undefined): Promise<void> {
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined) return;
  const url = iconCopyKey(location.origin, basePath(), pushHost(host), version);
  if (iconsHeld.has(url)) return;
  try {
    const held = await (await storage.open(projectPictureCacheName(basePath()))).match(url);
    if (held !== undefined) {
      iconsHeld.add(url);
      return;
    }
  } catch {
    return;
  }
  await drawPicture(version, host);
}

/** Fetch, check, decode and keep one machine's version, once at a time: the small copy and the push icon copy. */
function drawPicture(version: string, host: string | null | undefined): Promise<void> {
  const key = copyKey(host, version);
  const retry = failed.get(key);
  if (retry !== undefined && clock() < retry.until) return Promise.resolve();
  const running = loading.get(key);
  if (running !== undefined) return running;
  const work = (async () => {
    try {
      const bytes = await fetchBytes(projectPicturePath(version, host));
      // The header before the decoder: a hostile picture's harm is in decoding it.
      if (bytes.size > PROJECT_PICTURE_BYTES_MAX || !pictureHeaderFits(new Uint8Array(await bytes.arrayBuffer()))) throw new Error("refused");
      const [small, icon] = await canvas.draw(bytes, [
        { width: SMALL_PX, height: SMALL_PX },
        { width: PUSH_ICON_PX, height: PUSH_ICON_PX },
      ]);
      if (small === undefined || icon === undefined) throw new Error("no copy");
      const url = await canvas.dataUrl(small);
      if (!on) return;
      failed.delete(key);
      clearRetries((k) => k === key);
      keepCopy(key, url);
      await keepIconCopy(host, version, icon);
      emit();
    } catch {
      const wait = Math.min((retry?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
      failed.set(key, { until: clock() + wait, wait });
      // Tried again when the wait ends, whether or not a row draws again in the meantime.
      clearRetries((k) => k === key);
      retryTimers.set(
        key,
        setTimeout(() => {
          retryTimers.delete(key);
          void loadPicture(version, host);
        }, wait),
      );
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, work);
  return work;
}

/**
 * Remember which version each pane shows, for the next cold open and for the service worker. Called with
 * every pane of a snapshot: the map is rebuilt from it, so a pane that left the herd or changed its
 * picture loses its old entry at once. Writes only when something changed.
 */
export function rememberPanePictures(list: readonly Pick<AgentView, "paneId" | "picture" | "host" | "session">[], lead?: string | null): void {
  if (!on) return;
  leadHost = lead ?? null;
  const next = new Map<string, string>();
  for (const pane of list) {
    const version = panePicture(pane);
    if (version !== null) next.set(paneKey(pane), version);
  }
  while (next.size > PANES_MAX) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  // A retry for a picture no pane shows any more stops here, and its failure is forgotten: a member that
  // names a new version on every poll would otherwise add one entry each time, without end.
  const shown = new Set(list.flatMap((pane) => {
    const version = panePicture(pane);
    return version === null ? [] : [copyKey(pane.host, version)];
  }));
  clearRetries((k) => !shown.has(k));
  for (const key of failed.keys()) if (!shown.has(key)) failed.delete(key);
  const same = next.size === panes.size && [...next].every(([k, v]) => panes.get(k) === v);
  if (!same) {
    panes = next;
    writeTable(PANES_KEY, panes);
  }
  // Written even when nothing changed: the first call of a page life puts back a map the Cache lost.
  void writePaneMap();
}

/**
 * The picture to draw for a pane, as a URL the page made itself, or null for the agent logo. Starts the
 * load of a version the device does not hold yet; the component draws again when it lands.
 *
 * A pane whose view names no version yet falls back to the version this device last saw for it, so the
 * first frame after a cold open, or after a bridge restart whose first snapshot has not read the disk
 * yet, keeps the picture instead of flashing the logo. The next snapshot that names no picture drops
 * that memory (`rememberPanePictures`), so a picture taken out of the file goes with it.
 */
export function useProjectPicture(pane: Pick<AgentView, "picture" | "host" | "session" | "paneId"> | null | undefined): string | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const version = pane === null || pane === undefined ? null : (panePicture(pane) ?? rememberedPicture(pane));
  const host = pane?.host ?? null;
  useEffect(() => {
    if (version !== null) void loadPicture(version, host);
  }, [version, host]);
  return pictureCopy(host, version);
}

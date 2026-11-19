import { useEffect, useSyncExternalStore } from "react";

import { fetchAuthedBytes } from "@/lib/api";
import { basePath } from "@/lib/base-path";
import { paneKey, paneMapKey, projectPictureCacheName, pushCopyKey } from "@/lib/project-picture-push";
import { isPictureVersion, projectPicturePath } from "@/lib/project-picture-wire";
import { onWipe } from "@/lib/wipe";
import type { AgentView } from "@/lib/types";

// THE PROJECT PICTURE ON THE PHONE (issue 811, ADR 0161).
//
// A pane's view carries `picture`, the version of the picture its repository's `collie.toml` names. This
// module turns a version into something the page can draw at once, and keeps what the service worker
// needs to put the same picture on a push.
//
// THE PAGE NEVER DRAWS THE REPOSITORY'S BYTES TWICE. The bytes are fetched once per version with the
// pairing token, decoded by the browser into a bitmap, and drawn onto a canvas. What is kept, and what
// every surface shows, is the page's own PNG made from that canvas:
//
//   - a small copy ({@link SMALL_PX} px), a `data:` URL in localStorage, so a cold open draws the picture
//     in the first frame instead of the agent logo or the dog (bounded to {@link COPIES_MAX} versions);
//   - a push copy ({@link PUSH_PX} px), a PNG in Cache Storage, which the service worker hands to the
//     notification. The operating system decodes a notification's icon outside the browser's sandbox, so
//     it gets this re-encoded copy and never the repository's bytes (sw.ts).
//
// Beside them, a small map from a pane (machine and pane id) to its version, in localStorage for the
// page's first frame and in Cache Storage for the service worker, which has no localStorage. A push names
// its pane, never a folder or a version.
//
// THE SWITCH. Settings, Appearance, "Project pictures", per device, on until the person turns it off.
// Off: no picture anywhere, the agent logo and the Collie mark everywhere, no push picture. Turning it off
// also drops every copy and the map, so nothing of a repository's picture stays on the device.
//
// A version that fails to load (the bridge refused, the bytes do not decode) is not asked again in this
// page's life, so a broken picture cannot make the phone fetch on every poll.

/** The small copy's side, in px: three times the 32 px a header tile draws at most. */
export const SMALL_PX = 96;
/** The push copy's side, in px: the size Android draws a notification's large icon. */
export const PUSH_PX = 192;
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

const isCopy = (k: string, v: string) => isPictureVersion(k) && v.startsWith("data:image/png;base64,");
const isPane = (_k: string, v: string) => isPictureVersion(v);

let on = read(SWITCH_KEY) !== "off";
let copies = readTable(COPIES_KEY, isCopy);
let panes = readTable(PANES_KEY, isPane);
const failed = new Set<string>();
const loading = new Map<string, Promise<void>>();
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
  if (!next) void forgetProjectPictures();
  emit();
}

/** Drop every copy and the pane map: the switch's off, and the device wipe. The switch itself stays. */
export async function forgetProjectPictures(): Promise<void> {
  copies = new Map();
  panes = new Map();
  failed.clear();
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

/** The small copy of a version, or null. Synchronous: what the first frame draws. */
export function pictureCopy(version: string | null): string | null {
  if (!on || version === null) return null;
  return copies.get(version) ?? null;
}

/** The version the device last saw for a pane, or null: the header's guess before the snapshot lands. */
export function rememberedPicture(pane: { host?: string | null; session?: string | null; paneId: string }): string | null {
  if (!on) return null;
  return panes.get(paneKey(pane)) ?? null;
}

// ── the canvas copy ─────────────────────────────────────────────────────────────────────────────

/** What the page needs to turn bytes into its own PNG. A seam, so a test runs without a canvas. */
export interface PictureCanvas {
  /** The picture drawn into a square of `side` px, kept whole and centred, as a PNG. */
  draw(bytes: Blob, sides: readonly number[]): Promise<Blob[]>;
  /** A PNG as a `data:` URL. */
  dataUrl(png: Blob): Promise<string>;
}

/** The browser's own decoder and canvas. */
export const browserCanvas: PictureCanvas = {
  async draw(bytes, sides) {
    const bitmap = await createImageBitmap(bytes);
    try {
      const out: Blob[] = [];
      for (const side of sides) {
        const canvas = new OffscreenCanvas(side, side);
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no 2d canvas");
        const scale = Math.min(side / bitmap.width, side / bitmap.height);
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        ctx.drawImage(bitmap, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
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

/** Test seam: replace the canvas and the fetch. */
export function __setProjectPictureSeams(seams: { canvas?: PictureCanvas; fetch?: (path: string) => Promise<Blob> }): void {
  if (seams.canvas !== undefined) canvas = seams.canvas;
  if (seams.fetch !== undefined) fetchBytes = seams.fetch;
}

/** Test seam: back to a device that never saw a picture, the switch on. */
export function __resetProjectPictures(): void {
  on = true;
  copies = new Map();
  panes = new Map();
  failed.clear();
  loading.clear();
  write(SWITCH_KEY, null);
  write(COPIES_KEY, null);
  write(PANES_KEY, null);
  canvas = browserCanvas;
  fetchBytes = (path) => fetchAuthedBytes(path);
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadProjectPictures(): void {
  on = read(SWITCH_KEY) !== "off";
  copies = readTable(COPIES_KEY, isCopy);
  panes = readTable(PANES_KEY, isPane);
  failed.clear();
  loading.clear();
  emit();
}

function keepCopy(version: string, url: string): void {
  copies.delete(version);
  copies.set(version, url);
  while (copies.size > COPIES_MAX) {
    const oldest = copies.keys().next().value;
    if (oldest === undefined) break;
    copies.delete(oldest);
  }
  writeTable(COPIES_KEY, copies);
}

async function keepPushCopy(version: string, png: Blob): Promise<void> {
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined) return;
  try {
    const cache = await storage.open(projectPictureCacheName(basePath()));
    await cache.put(pushCopyKey(location.origin, basePath(), version), new Response(png, { headers: { "content-type": "image/png" } }));
  } catch {
    // No Cache Storage (plain HTTP, private mode): the push shows the Collie icon.
  }
}

async function writePaneMap(): Promise<void> {
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined) return;
  try {
    const cache = await storage.open(projectPictureCacheName(basePath()));
    await cache.put(paneMapKey(location.origin, basePath()), new Response(JSON.stringify(Object.fromEntries(panes)), { headers: { "content-type": "application/json" } }));
  } catch {
    // As above: the push shows the Collie icon.
  }
}

/** Fetch, decode and keep one version, once. Never rejects. */
export function loadPicture(version: string, host?: string | null): Promise<void> {
  if (!on || copies.has(version) || failed.has(version)) return Promise.resolve();
  const running = loading.get(version);
  if (running !== undefined) return running;
  const work = (async () => {
    try {
      const bytes = await fetchBytes(projectPicturePath(version, host));
      const [small, push] = await canvas.draw(bytes, [SMALL_PX, PUSH_PX]);
      if (small === undefined || push === undefined) throw new Error("no copy");
      const url = await canvas.dataUrl(small);
      if (!on) return;
      keepCopy(version, url);
      await keepPushCopy(version, push);
      emit();
    } catch {
      failed.add(version);
    } finally {
      loading.delete(version);
    }
  })();
  loading.set(version, work);
  return work;
}

/**
 * Remember which version each pane shows, for the next cold open and for the service worker. Called with
 * the panes of a snapshot; writes only when something changed.
 */
export function rememberPanePictures(list: readonly Pick<AgentView, "paneId" | "picture" | "host" | "session">[]): void {
  if (!on) return;
  let changed = false;
  for (const pane of list) {
    const key = paneKey(pane);
    const version = panePicture(pane);
    if (version === null) {
      if (panes.delete(key)) changed = true;
      continue;
    }
    if (panes.get(key) === version) continue;
    panes.delete(key);
    panes.set(key, version);
    changed = true;
  }
  while (panes.size > PANES_MAX) {
    const oldest = panes.keys().next().value;
    if (oldest === undefined) break;
    panes.delete(oldest);
  }
  if (!changed) return;
  writeTable(PANES_KEY, panes);
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
  return pictureCopy(version);
}

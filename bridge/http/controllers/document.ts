// The server document (S1 of the Remix 3 plan, `experiments/remix-v3/ACTION-PLAN.md` B): `/` and
// `/pane/:paneId` answered with the app already rendered from this request's snapshot, so the first
// row paints before any script runs. The browser hydrates it in place (web-remix/src/main.tsx).
//
// ONLY FOR A REQUEST THAT MAY READ THE SNAPSHOT. The router's middleware (peer, Access, deposed) has
// already run; then the same `checkAccess` the snapshot route applies, and the same session and host
// resolution (`snapshotFor`). A request that fails any of them, a path that is not one of the two,
// a missing build, a build of web/'s React shell (no `collie-shell` marker), a renderer that cannot
// load or a render that throws: every one gets the static
// shell exactly as before (`serveStatic`). Snapshot data never goes into a document the gate refused.
//
// THE DOCUMENT is `web/dist/index.html`, mounted by the same `mountIndexHtml` (ADR 0052), with its
// body replaced by the rendered island; the render puts the mount on every link it draws. It is
// never cached (`no-store`): it carries one moment's panes.
//
// THE RENDERER is the shell's own code (`web-remix/src/ssr/render.tsx`), compiled into the binary.
// It is loaded with `require`, not `import`, on purpose: the root `tsc` follows an import and would
// check the shell's TSX under this tree's React JSX settings and without its path aliases; the
// shell's own `tsc` checks it. Bun's bundler compiles each file under its nearest tsconfig, so the
// binary gets Remix JSX. Bun's runtime does not (it takes the working directory's tsconfig), so
// `bun run bridge/index.ts` from the repo root loads a renderer whose JSX is React's: the load check
// below sees that and serves the static shell, with one log line.
//
// A PANE DOCUMENT CARRIES ITS PANE (S2). For `/pane/:paneId` the pane is read too, through the pane
// route's own body (`browserPaneRead`: its gate, its crew forward), with the 600-row window the shell
// polls, and the shell draws its two frames from that read inline (./frames.ts says what they are).
// The read sends no `x-collie-seen`: a document GET is a navigation, which a page on another site can
// start, so it never clears an alert; the shell's first poll marks the pane seen, as before. A read
// that fails leaves the document as S1 drew it, with the screen's skeleton.

import { join } from "node:path";
import { mountIndexHtml, buildId, BUILD_HEADER, checkAccess, CSP, WEB_DIR } from "../../server.ts";
import type { Config } from "../../config.ts";
import type { SnapshotResponse } from "../../types.ts";
import type { BridgeHttp } from "../deps.ts";
import { secure } from "../middleware/secure.ts";
import { configFor } from "./config.ts";
import { FRAME_VARY, type FrameRenderer } from "./frames.ts";
import { browserPaneRead } from "./pane.ts";
import { snapshotFor } from "./snapshot.ts";

/** The build stamp the bundle on disk carries (`web/dist/build-info.json`). */
export interface BuildStamp {
  version: string;
  sha: string;
  time: string;
  id: string;
  channel: "release" | "dev";
}

/** What the bridge hands the shell's renderer for one request. */
export interface DocumentInput {
  url: URL;
  base: string;
  snapshot: SnapshotResponse;
  snapshotAt: number;
  config: Awaited<ReturnType<typeof configFor>>;
  prefs: string | null;
  now: number;
  /** A pane document's pane read (S2), and its ETag. */
  pane?: { read: unknown; etag: string | null };
}

/** What the bridge hands the renderer for an islands document (S3): each island's chunks, mounted. */
export interface IslandsDocumentInput extends DocumentInput {
  preloads?: Record<string, string[]>;
}

/** What the bridge hands the renderer for one snapshot beat (S3, web-remix/src/islands/snapshot-wire.ts). */
export interface SnapshotFramesInput extends IslandsDocumentInput {
  held: Map<string, string>;
  ranks: string | null;
  snapshotJson: string;
  raw?: boolean;
}

/** The shell's renderer, as `web-remix/src/ssr/render.tsx` exports it. */
export interface ShellRenderer extends FrameRenderer {
  isDocumentRoute(url: URL): boolean;
  snapshotApiPath(url: URL): string;
  /** The `/api/pane/:id` path a pane document reads (the shell's poll window), or null for another page. */
  documentPaneReadPath(url: URL): string | null;
  renderAppDocument(indexHtml: string, input: DocumentInput): Promise<string>;
  /** S3: the islands document where the page is drawn that way, else the S1/S2 document. */
  renderDocument?(indexHtml: string, input: IslandsDocumentInput): Promise<{ html: string; islands: boolean }>;
  /** S3: one snapshot beat's answer, or null when the page is not an islands page. */
  renderSnapshotFrames?(input: SnapshotFramesInput): Promise<string> | null;
  /** S3: the island module ids and their source files, as Vite's manifest keys them. */
  ISLAND_SOURCES?: Record<string, string>;
  /** S3: `X-Collie-Snap`, decoded. */
  decodeHeld?(header: string | null): Map<string, string>;
  /** S3: whether a frame name is a snapshot frame. */
  isSnapshotFrameName?(name: string | null | undefined): boolean;
}

/** What {@link serveDocument} reads. A narrow seam, so a test needs no `startServer`. */
export interface DocumentDeps {
  cfg: Config;
  snapshot(req: Request, apiUrl: URL): SnapshotResponse | Response;
  config(req: Request, apiUrl: URL): Promise<DocumentInput["config"] | Response>;
  /** The pane route's own GET of `/api/pane/:paneId` (`browserPaneRead`). */
  paneRead(req: Request, apiUrl: URL, rawPaneId: string): Promise<Response>;
  renderer(): Promise<ShellRenderer | null>;
  /** Where `index.html` is read from. */
  webDir: string;
  buildId(): Promise<string>;
  now(): number;
}

/** The cookie the shell writes with the device's prefs (web-remix/src/lib/prefs.ts `PREFS_COOKIE`). */
const PREFS_COOKIE = "collie-prefs";

/** The prefs cookie's JSON, URI-decoded, or null. The shell's decoders validate what is inside. */
export function prefsFromCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== PREFS_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** The meta tag only web-remix's `index.html` carries. */
const SHELL_MARKER = '<meta name="collie-shell" content="remix" />';

/** Below this many bytes the document goes out raw (the static path's floor). */
const GZIP_MIN_BYTES = 1024;

/** The header that marks an islands document (S3); the shell's resolver refuses a page without it. */
export const DOCUMENT_MARK_HEADER = "x-collie-document";

function documentResponse(html: string, method: string, acceptEncoding: string | null, build: string, islands = false): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CSP,
    "cache-control": "no-store",
    // The frames share this URL (./frames.ts): a cache must never hand one for the other.
    vary: FRAME_VARY,
    [BUILD_HEADER]: build,
  });
  if (islands) headers.set(DOCUMENT_MARK_HEADER, "islands");
  let bytes = new TextEncoder().encode(html);
  if (bytes.byteLength >= GZIP_MIN_BYTES && /\bgzip\b/.test(acceptEncoding ?? "")) {
    bytes = Bun.gzipSync(bytes);
    headers.set("content-encoding", "gzip");
    headers.set("vary", `${FRAME_VARY}, Accept-Encoding`);
  }
  headers.set("content-length", String(bytes.byteLength));
  return secure(new Response(method === "HEAD" ? null : bytes, { headers }));
}

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.error(`collie: server document off, static shell served (${message})`);
}

/**
 * The server document for this request, or null when the static shell must answer instead. `url` is
 * the routed URL, mount already off.
 */
export async function serveDocument(deps: DocumentDeps, req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  // A cheap filter before the renderer is asked: only `/` and `/pane/<one segment>` can be one.
  if (url.pathname !== "/" && !/^\/pane\/[^/]+\/?$/.test(url.pathname)) return null;
  if (!checkAccess(req, deps.cfg).ok) return null;
  const renderer = await deps.renderer();
  if (renderer === null || !renderer.isDocumentRoute(url)) return null;

  const snapshot = deps.snapshot(req, new URL(renderer.snapshotApiPath(url), url));
  if (snapshot instanceof Response) return null;
  const config = await deps.config(req, new URL("/api/config", url));
  if (config instanceof Response) return null;

  const index = Bun.file(join(deps.webDir, "index.html"));
  if (!(await index.exists())) return null;
  const built = await index.text();
  // Only into the shell that can adopt it: web/'s React build mounts into its own root element, which
  // a spliced body would remove (see the marker in web-remix/index.html).
  if (!built.includes(SHELL_MARKER)) return null;
  const indexHtml = mountIndexHtml(built, deps.cfg.basePath);
  const pane = await paneFor(deps, renderer, req, url);
  const now = deps.now();
  let html: string;
  let islands = false;
  try {
    const input: IslandsDocumentInput = {
      url,
      base: deps.cfg.basePath,
      snapshot,
      snapshotAt: now,
      config,
      prefs: prefsFromCookie(req.headers.get("cookie")),
      now,
    };
    if (pane !== null) input.pane = pane;
    if (renderer.renderDocument !== undefined) {
      input.preloads = await islandPreloads(deps.webDir, deps.cfg.basePath, renderer.ISLAND_SOURCES ?? {});
      const out = await renderer.renderDocument(indexHtml, input);
      html = out.html;
      islands = out.islands;
    } else {
      html = await renderer.renderAppDocument(indexHtml, input);
    }
  } catch (error) {
    console.error("collie: server document failed, static shell served", error);
    return null;
  }
  return documentResponse(html, req.method, req.headers.get("accept-encoding"), await deps.buildId(), islands);
}

// ── The snapshot frames (S3) ───────────────────────────────────────────────────────────────────────

/** `X-Collie-Snap` and `X-Collie-Ranks` (web-remix/src/islands/snapshot-wire.ts). */
const SNAP_HEADER = "x-collie-snap";
const RANKS_HEADER = "x-collie-ranks";
const TARGET_HEADER = "x-remix-target";
const FRAME_ANSWER_HEADER = "x-collie-frame";

/**
 * One snapshot beat of an islands page (S3): `/` or `/pane/:paneId` with `X-Collie-Snap`, or a plain
 * named-frame request for a snapshot frame. The snapshot, read through the snapshot route's own gate and
 * scope (`snapshotFor`), and the moved frames' HTML, in one body. Null when the request is not one (the
 * pane frames, the document and the static shell answer it then). A refused gate answers its own status
 * with no frame header, so the browser reads it as the JSON poll would.
 */
export async function serveSnapshotFrames(deps: DocumentDeps, req: Request, url: URL): Promise<Response | null> {
  const snap = req.headers.get(SNAP_HEADER);
  const target = req.headers.get(TARGET_HEADER);
  if (snap === null && target === null) return null;
  if (url.pathname !== "/" && !/^\/pane\/[^/]+\/?$/.test(url.pathname)) return null;
  const renderer = await deps.renderer();
  if (renderer === null || renderer.renderSnapshotFrames === undefined || renderer.decodeHeld === undefined) return null;
  if (snap === null && renderer.isSnapshotFrameName?.(target) !== true) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const build = await deps.buildId();
  const access = checkAccess(req, deps.cfg);
  if (!access.ok) return plain(403, access.reason, build);
  const snapshot = deps.snapshot(req, new URL(renderer.snapshotApiPath(url), url));
  if (snapshot instanceof Response) return snapshot;
  const config = await deps.config(req, new URL("/api/config", url));
  if (config instanceof Response) return config;
  const held = snap === null ? new Map([[target ?? "", ""]]) : renderer.decodeHeld(snap);
  const now = deps.now();
  let body: string | null;
  try {
    body = await renderer.renderSnapshotFrames({
      url,
      base: deps.cfg.basePath,
      snapshot,
      snapshotAt: now,
      config,
      prefs: prefsFromCookie(req.headers.get("cookie")),
      now,
      held,
      ranks: req.headers.get(RANKS_HEADER),
      snapshotJson: JSON.stringify(snapshot),
      preloads: await islandPreloads(deps.webDir, deps.cfg.basePath, renderer.ISLAND_SOURCES ?? {}),
      raw: snap === null,
    });
  } catch (error) {
    console.error("collie: snapshot frames failed", error);
    return plain(500, "snapshot frames failed", build);
  }
  // Not an islands page any more (a pref moved): no frame header, and the browser falls back to JSON.
  if (body === null) return plain(404, "not an islands page", build);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    vary: FRAME_VARY,
    [BUILD_HEADER]: build,
    [FRAME_ANSWER_HEADER]: snap === null ? (target ?? "") : "snapshot",
  });
  let bytes = new TextEncoder().encode(body);
  if (bytes.byteLength >= GZIP_MIN_BYTES && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    bytes = Bun.gzipSync(bytes);
    headers.set("content-encoding", "gzip");
    headers.set("vary", `${FRAME_VARY}, Accept-Encoding`);
  }
  headers.set("content-length", String(bytes.byteLength));
  return secure(new Response(req.method === "HEAD" ? null : bytes, { headers }));
}

function plain(status: number, body: string, build: string): Response {
  return secure(new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", [BUILD_HEADER]: build } }));
}

// ── Island preloads (S3) ───────────────────────────────────────────────────────────────────────────

interface ManifestChunk {
  file: string;
  imports?: string[];
  isEntry?: boolean;
}

let manifestCache: { dir: string; mtime: number; chunks: Record<string, ManifestChunk> } | null = null;

async function readManifest(webDir: string): Promise<Record<string, ManifestChunk> | null> {
  const file = Bun.file(join(webDir, ".vite", "manifest.json"));
  if (!(await file.exists())) return null;
  const mtime = file.lastModified;
  if (manifestCache?.dir === webDir && manifestCache.mtime === mtime) return manifestCache.chunks;
  try {
    // SAFETY: Vite's own build manifest next to the bundle (web-remix/vite.config.ts `build.manifest`);
    // only `file` and `imports` are read, and a garbled file is caught here.
    const chunks = (await file.json()) as Record<string, ManifestChunk>;
    manifestCache = { dir: webDir, mtime, chunks };
    return chunks;
  } catch {
    return null;
  }
}

/**
 * Each island module's chunk and the chunks it imports directly, mounted, from Vite's manifest: the
 * document preloads them (`<link rel="modulepreload">`), so an island's code is not a request made only
 * after the entry ran. The build puts the islands' start code in a few chunks (web-remix/vite.config.ts
 * `startChunksPlugin`), so an island chunk is a small facade over those and one level reaches them all.
 * A chunk the entry already loads is never listed. Empty when there is no manifest.
 */
export async function islandPreloads(webDir: string, basePath: string, sources: Record<string, string>): Promise<Record<string, string[]>> {
  const chunks = await readManifest(webDir);
  const out: Record<string, string[]> = {};
  if (chunks === null) return out;
  const entryKeys = new Set<string>();
  const walk = (key: string, into: Set<string>): void => {
    if (into.has(key)) return;
    into.add(key);
    for (const next of chunks[key]?.imports ?? []) walk(next, into);
  };
  for (const [key, chunk] of Object.entries(chunks)) if (chunk.isEntry === true) walk(key, entryKeys);
  const mount = basePath.endsWith("/") ? basePath : `${basePath}/`;
  for (const [moduleId, source] of Object.entries(sources)) {
    if (chunks[source] === undefined) continue;
    const keys = [source, ...(chunks[source]?.imports ?? [])].filter((key) => !entryKeys.has(key));
    out[moduleId] = keys.map((key) => `${mount}${chunks[key]?.file ?? ""}`);
  }
  return out;
}

/**
 * The pane a pane document draws, read as the shell's poll reads it (see the file header), or null:
 * not a pane page, or the read did not answer 200.
 */
async function paneFor(deps: DocumentDeps, renderer: ShellRenderer, req: Request, url: URL): Promise<DocumentInput["pane"] | null> {
  const path = renderer.documentPaneReadPath(url);
  const raw = /^\/pane\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (path === null || raw === undefined) return null;
  const apiUrl = new URL(path, url);
  const headers = new Headers(req.headers);
  for (const name of ["accept-encoding", "accept", "if-none-match", "x-collie-seen"]) headers.delete(name);
  try {
    const res = await deps.paneRead(new Request(apiUrl, { method: "GET", headers, signal: req.signal }), apiUrl, raw);
    if (res.status !== 200) return null;
    // SAFETY: a 200 from the pane route is its `PaneReadResponse`; the shell's renderer reads `text`
    // and `logicalText` from it and nothing else, and a body that does not parse is caught here.
    const read: unknown = JSON.parse(await res.text());
    return { read, etag: res.headers.get("etag") };
  } catch {
    return null;
  }
}

// ── The renderer, loaded once ──────────────────────────────────────────────────────────────────────

/** The shell's renderer module, as `require` hands it back. */
interface RendererModule extends ShellRenderer {
  rendersRemixJsx(): boolean;
}

let loading: Promise<ShellRenderer | null> | undefined;

async function readStamp(webDir: string): Promise<BuildStamp | null> {
  try {
    // SAFETY: `build-info.json` is written by this repo's own Vite build next to the bundle it
    // stamps (web-remix/vite.config.ts `buildInfoPlugin`); a missing or garbled file is caught here.
    return (await Bun.file(join(webDir, "build-info.json")).json()) as BuildStamp;
  } catch {
    return null;
  }
}

/**
 * Load the shell's renderer once per process. The build stamp goes on `globalThis` first, because the
 * shell reads it when its modules evaluate (web-remix/src/ssr/build-info.ts). A rebuild without a
 * restart keeps the old stamp in server renders until the next start. Resolves null when the
 * renderer cannot serve: not compiled in, or compiled with the wrong JSX (see the file header).
 */
export function loadShellRenderer(webDir: string = WEB_DIR): Promise<ShellRenderer | null> {
  loading ??= (async () => {
    const stamp = await readStamp(webDir);
    // BEFORE the require: web/src/lib/build.ts reads the stamp when it evaluates, once. The renderer's
    // own placeholder (ssr/build-info.ts) only fills in when this is absent.
    if (stamp !== null) Object.assign(globalThis, { __BUILD_INFO__: stamp });
    try {
      // SAFETY: the path is this repo's own shell renderer, whose exports are `RendererModule`
      // (web-remix/src/ssr/render.tsx); `rendersRemixJsx` below proves the compiled form before use.
      const mod = require("../../../web-remix/src/ssr/render.tsx") as RendererModule;
      if (!mod.rendersRemixJsx()) {
        warnOnce("the renderer was compiled with React JSX; run the compiled binary");
        return null;
      }
      return mod;
    } catch (error) {
      warnOnce(error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  return loading;
}

/** The bridge's own wiring of {@link DocumentDeps}. */
export function documentDeps(deps: BridgeHttp): DocumentDeps {
  return {
    cfg: deps.cfg,
    snapshot: (req, apiUrl) => snapshotFor(deps, req, apiUrl),
    config: (req, apiUrl) => configFor(deps, req, apiUrl),
    paneRead: (req, apiUrl, rawPaneId) => browserPaneRead(deps, req, apiUrl, rawPaneId),
    renderer: () => loadShellRenderer(),
    webDir: WEB_DIR,
    buildId,
    now: Date.now,
  };
}

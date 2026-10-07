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

/** The shell's renderer, as `web-remix/src/ssr/render.tsx` exports it. */
export interface ShellRenderer extends FrameRenderer {
  isDocumentRoute(url: URL): boolean;
  snapshotApiPath(url: URL): string;
  /** The `/api/pane/:id` path a pane document reads (the shell's poll window), or null for another page. */
  documentPaneReadPath(url: URL): string | null;
  renderAppDocument(indexHtml: string, input: DocumentInput): Promise<string>;
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

function documentResponse(html: string, method: string, acceptEncoding: string | null, build: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CSP,
    "cache-control": "no-store",
    // The frames share this URL (./frames.ts): a cache must never hand one for the other.
    vary: FRAME_VARY,
    [BUILD_HEADER]: build,
  });
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
  try {
    const input: DocumentInput = {
      url,
      base: deps.cfg.basePath,
      snapshot,
      snapshotAt: now,
      config,
      prefs: prefsFromCookie(req.headers.get("cookie")),
      now,
    };
    if (pane !== null) input.pane = pane;
    html = await renderer.renderAppDocument(indexHtml, input);
  } catch (error) {
    console.error("collie: server document failed, static shell served", error);
    return null;
  }
  return documentResponse(html, req.method, req.headers.get("accept-encoding"), await deps.buildId());
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

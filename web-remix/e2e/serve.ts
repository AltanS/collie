// A static server for web-remix/dist, standing in for the bridge's file half: the built files off
// disk, `index.html` for any path without an extension (the SPA fallback), 127.0.0.1 only.
//
// With PROXY set, `/api/*` goes to that bridge with the Host header rewritten to the bridge's own
// address, which is how the live screenshot reads a real instance. Without it, `/api/*` answers 501
// so a Playwright stub (`page.route`) is the only thing that can answer it.
//
// SERVER DOCUMENTS (S1, e2e/ssr-boot.spec.ts). A spec POSTs `{ snapshot, config }` to `/__ssr`; after
// that, a document GET for `/` or `/pane/:paneId` that carries the cookie `e2e-ssr=1` is rendered as
// the bridge renders it (web-remix/src/ssr/render.tsx, the same module the bridge compiles in), and
// `e2e-ssr=403` answers 403 there, as a refusing proxy would. Without the cookie nothing changes.
//
//   PORT=5192 bun e2e/serve.ts
//   PORT=5193 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts
import { join, normalize } from "node:path";

import type { BridgeConfig, SnapshotResponse } from "@web/lib/types";

const root = process.env.DIST ? process.env.DIST : join(import.meta.dirname, "..", "dist");
const port = Number(process.env.PORT ?? "5192");
const proxy = process.env.PROXY;

async function serveFile(pathname: string): Promise<Response> {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(root, safe));
  if (safe !== "/" && (await file.exists())) return new Response(file);
  if (/\.[a-z0-9]+$/i.test(safe)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(root, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function forward(req: Request, url: URL, target: string): Promise<Response> {
  const upstream = new URL(url.pathname + url.search, target);
  const headers = new Headers(req.headers);
  headers.set("host", upstream.host);
  headers.delete("origin");
  headers.delete("referer");
  const res = await fetch(upstream, { method: req.method, headers, body: req.body, redirect: "manual" });
  // Bun decodes compressed bodies, so the encoding header no longer describes the bytes.
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(res.body, { status: res.status, headers: out });
}

interface SsrState {
  snapshot: SnapshotResponse;
  config: BridgeConfig;
}
let ssr: SsrState | null = null;

/** What this server uses of web-remix/src/ssr/render.tsx. Spelled out rather than `typeof import`, so the
 * e2e typecheck does not pull the whole shell into its program. */
interface Renderer {
  isDocumentRoute(url: URL): boolean;
  renderAppDocument(
    indexHtml: string,
    input: { url: URL; base: string; snapshot: SnapshotResponse; snapshotAt: number; config: BridgeConfig; prefs: string | null; now: number },
  ): Promise<string>;
}
let renderer: Promise<Renderer> | undefined;

/** The renderer, loaded on first use with the build's own stamp on `globalThis` first (as the bridge does). */
function loadRenderer(): Promise<Renderer> {
  renderer ??= (async () => {
    const stamp: unknown = await Bun.file(join(root, "build-info.json")).json();
    Object.assign(globalThis, { __BUILD_INFO__: stamp });
    const path = join(import.meta.dirname, "..", "src", "ssr", "render.tsx");
    // SAFETY: the module's exports include the two functions `Renderer` names (ssr/render.tsx).
    return (await import(path)) as Renderer;
  })();
  return renderer;
}

function ssrCookie(req: Request): string | null {
  const match = /(?:^|;\s*)e2e-ssr=([^;]*)/.exec(req.headers.get("cookie") ?? "");
  return match?.[1] ?? null;
}

async function serveDocument(req: Request, url: URL): Promise<Response | null> {
  const mode = ssrCookie(req);
  if (mode === null || req.method !== "GET") return null;
  const render = await loadRenderer();
  if (!render.isDocumentRoute(url)) return null;
  if (mode === "403") return new Response("refused", { status: 403 });
  if (ssr === null) return null;
  const now = Date.now();
  const html = await render.renderAppDocument(await Bun.file(join(root, "index.html")).text(), {
    url,
    base: "/",
    snapshot: ssr.snapshot,
    snapshotAt: now,
    config: ssr.config,
    prefs: null,
    now,
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__ssr" && req.method === "POST") {
      // SAFETY: only a spec posts here, with a SnapshotResponse and a BridgeConfig it built.
      ssr = (await req.json()) as SsrState;
      return new Response(null, { status: 204 });
    }
    const document = await serveDocument(req, url);
    if (document !== null) return document;
    if (url.pathname.startsWith("/api/")) {
      if (proxy) return forward(req, url, proxy);
      return new Response("no stub for this path", { status: 501 });
    }
    return serveFile(url.pathname);
  },
});
console.log(`web-remix dist on http://127.0.0.1:${String(port)}${proxy ? ` (api → ${proxy})` : ""}`);

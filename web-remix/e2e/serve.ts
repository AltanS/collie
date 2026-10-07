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
// PANE FRAMES (S2, e2e/pane-frames.spec.ts). A spec POSTs `{ paneId, text }` (or `{ paneId, status }`
// for a refusal) to `/__pane` (`{ reset: true }` forgets them all, so the next spec reads its own stub); after that, a named-frame GET for that pane (`X-Remix-Frame: true`,
// `X-Remix-Target`) is answered as the bridge's frame route answers it (bridge/http/controllers/
// frames.ts): the read's ETag, 304 on a match, the poll answer with `X-Collie-Poll`, and
// `X-Collie-Frame` on every answer. A pane no spec posted gets the static fallback, as from a bridge
// without the route, and the shell reads JSON. A server document for a posted pane draws its frames.
//
//   PORT=5192 bun e2e/serve.ts
//   PORT=5193 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import type { BridgeConfig, PaneReadResponse, SnapshotResponse } from "@web/lib/types";

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
type FrameName = "pane-screen" | "pane-status";
/** A pane read and its ETag, as a pane document carries it. */
interface PaneDocRead {
  read: PaneReadResponse;
  etag: string;
}
/** ssr/render.tsx's `DocumentInput`. */
interface DocumentInput {
  url: URL;
  base: string;
  snapshot: SnapshotResponse;
  snapshotAt: number;
  config: BridgeConfig;
  prefs: string | null;
  now: number;
  pane?: PaneDocRead;
}
interface Renderer {
  isDocumentRoute(url: URL): boolean;
  renderAppDocument(indexHtml: string, input: DocumentInput): Promise<string>;
  isPaneFrameName(name: string | null | undefined): name is FrameName;
  pollTargets(header: string | null): FrameName[];
  renderPaneFrames(input: { text: string; agent: string | undefined }, targets: readonly FrameName[]): Promise<Partial<Record<FrameName, string>>>;
  pollAnswer(read: PaneReadResponse, frames: Partial<Record<FrameName, string>>): string;
}
let renderer: Promise<Renderer> | undefined;

/** The renderer, loaded on first use with the build's own stamp on `globalThis` first (as the bridge does). */
function loadRenderer(): Promise<Renderer> {
  renderer ??= (async () => {
    const stamp: unknown = await Bun.file(join(root, "build-info.json")).json();
    Object.assign(globalThis, { __BUILD_INFO__: stamp });
    // BUNDLED, as the bridge's binary bundles it: the bundler compiles the shell under its own
    // tsconfig (Remix JSX). A plain import takes the JSX setting from the working directory, and a
    // config that starts this server from e2e/ then renders every component as nothing.
    const out = mkdtempSync(join(tmpdir(), "collie-e2e-renderer-"));
    process.on("exit", () => rmSync(out, { recursive: true, force: true }));
    const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "..", "src", "ssr", "render.tsx")], outdir: out, target: "bun" });
    if (!built.success) throw new AggregateError(built.logs, "renderer bundle failed");
    // SAFETY: the bundle of ssr/render.tsx, whose exports include every function `Renderer` names.
    return (await import(built.outputs[0]!.path)) as Renderer;
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
  const paneId = paneIdOf(url);
  const posted = paneId === null ? undefined : panes.get(paneId);
  const input: DocumentInput = { url, base: "/", snapshot: ssr.snapshot, snapshotAt: now, config: ssr.config, prefs: null, now };
  if (posted?.text !== undefined && paneId !== null) input.pane = paneRead(paneId, posted.text);
  const html = await render.renderAppDocument(await Bun.file(join(root, "index.html")).text(), input);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** The panes a spec posted: the mirror text, or a status to refuse with. */
const panes = new Map<string, { text?: string; status?: number }>();

function paneIdOf(url: URL): string | null {
  const raw = /^\/pane\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  return raw === undefined ? null : decodeURIComponent(raw);
}

/** The read and its ETag, as the bridge's `readPane` makes them: the ETag is over the body. */
function paneRead(paneId: string, text: string): PaneDocRead {
  const read: PaneReadResponse = { paneId, text, truncated: false, revision: 1 };
  return { read, etag: `"${Bun.hash(JSON.stringify(read)).toString(16)}"` };
}

/** The bridge's frame route, over the posted panes (see the file header). */
async function serveFrame(req: Request, url: URL): Promise<Response | null> {
  const target = req.headers.get("x-remix-target");
  if (req.headers.get("x-remix-frame") !== "true" || target === null) return null;
  const paneId = paneIdOf(url);
  const posted = paneId === null ? undefined : panes.get(paneId);
  if (paneId === null || posted === undefined) return null;
  const render = await loadRenderer();
  if (!render.isPaneFrameName(target)) return new Response("no such frame", { status: 404 });
  const headers = new Headers({ "cache-control": "private, no-store", vary: "X-Remix-Frame, X-Remix-Target, X-Collie-Poll", "x-collie-frame": target });
  if (posted.text === undefined) return new Response("refused", { status: posted.status ?? 403, headers });
  const { read, etag } = paneRead(paneId, posted.text);
  headers.set("etag", etag);
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const poll = req.headers.get("x-collie-poll");
  const asked = render.pollTargets(poll);
  const targets = poll === null || asked.length === 0 ? [target] : asked;
  const frames = await render.renderPaneFrames({ text: posted.text, agent: url.searchParams.get("agent") ?? undefined }, targets);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(poll === null ? (frames[target] ?? "") : render.pollAnswer(read, frames), { headers });
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
    if (url.pathname === "/__pane" && req.method === "POST") {
      // SAFETY: only a spec posts here, with a pane id and either its text or a status, or a reset.
      const body = (await req.json()) as { paneId: string; text?: string; status?: number } | { reset: true };
      if ("reset" in body) panes.clear();
      else panes.set(body.paneId, body);
      return new Response(null, { status: 204 });
    }
    const frame = await serveFrame(req, url);
    if (frame !== null) return frame;
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

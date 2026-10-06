// A static server for web-remix/dist, standing in for the bridge's file half: the built files off
// disk, `index.html` for any path without an extension (the SPA fallback), 127.0.0.1 only.
//
// With PROXY set, `/api/*` goes to that bridge with the Host header rewritten to the bridge's own
// address, which is how the live screenshot reads a real instance. Without it, `/api/*` answers 501
// so a Playwright stub (`page.route`) is the only thing that can answer it.
//
//   PORT=5192 bun e2e/serve.ts
//   PORT=5193 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts
import { join, normalize } from "node:path";

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

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (proxy) return forward(req, url, proxy);
      return new Response("no stub for this path", { status: 501 });
    }
    return serveFile(url.pathname);
  },
});
console.log(`web-remix dist on http://127.0.0.1:${String(port)}${proxy ? ` (api → ${proxy})` : ""}`);

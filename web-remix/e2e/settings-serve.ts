// The settings e2e's static server: bundle A or bundle B off /tmp, whichever the pointer names, read
// per request so a deploy is one file write. 127.0.0.1:5196 only. `/api/*` answers 501, so the
// spec's route stub is the only thing that can answer it; `/__served` says which bundle is live.
import { join, normalize } from "node:path";

import { SETTINGS_PORT, buildDir, servedBuild } from "./settings-builds";

async function serveFile(pathname: string): Promise<Response> {
  const root = buildDir(servedBuild());
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(root, safe));
  // `no-cache` on everything: a deploy must be visible on the next request, as the bridge serves it.
  const headers = { "cache-control": "no-cache" };
  if (safe !== "/" && (await file.exists())) return new Response(file, { headers });
  if (/\.[a-z0-9]+$/i.test(safe)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(root, "index.html")), {
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: SETTINGS_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__served") return new Response(servedBuild());
    if (url.pathname.startsWith("/api/")) return new Response("no stub for this path", { status: 501 });
    return serveFile(url.pathname);
  },
});
console.log(`settings e2e on http://127.0.0.1:${String(SETTINGS_PORT)}`);

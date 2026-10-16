import { createServer } from "node:http";
import { resolve } from "node:path";

// A MOUNTED BUNDLE SERVER (M57). Serves `web/dist` the way the bridge does under
// `COLLIE_BASE_PATH=/collie/` (ADR 0052): the bridge's own `serveStatic` and `stripMount`, so the
// app shell goes through the bridge's own `mountIndexHtml`, and nothing is restated here. It is not
// a bridge: there is no API, no auth and no poll, which is all a first-paint case needs.
//
// The bridge file is loaded with a computed specifier on purpose. `web/tsconfig.json` type-checks
// `e2e/` with the DOM and Node libraries, and the bridge is Bun code; a literal import would pull
// the whole bridge into that project. `bun e2e/serve-mount.ts` is what runs this file, as the
// config's `webServer` does for `serve-builds.ts`.

export const MOUNT = "/collie/";
const PORT = 4175;

const web = resolve(import.meta.dirname, "..");
const bridge: string = resolve(web, "..", "bridge", "server.ts");

interface Bridge {
  serveStatic(pathname: string, acceptEncoding: string | null, webDir: string, basePath: string): Promise<Response>;
  stripMount(pathname: string, basePath: string): string;
}
// SAFETY: `serveStatic` and `stripMount` are exported by bridge/server.ts with exactly these
// signatures (see their doc comments there); this interface restates only the two it calls.
const { serveStatic, stripMount } = (await import(bridge)) as Bridge;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  void (async () => {
    const out = await serveStatic(stripMount(url.pathname, MOUNT), null, resolve(web, "dist"), MOUNT);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  })();
}).listen(PORT, "127.0.0.1");

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

import { NAVIGATION_NETWORK_ONLY } from "../src/lib/sw-routes";

import {
  BUILDS_DIR,
  SERVER_ONLY_MARKER,
  SWAP_BASE_URL,
  SWAP_PORT,
  buildBoth,
  buildsExist,
  readDelay,
  readFail,
  servedBuild,
  spendFail,
} from "./fixtures/builds";

// The SWAPPABLE BUNDLE SERVER (M26/04). Stands in for the bridge for one job only: it serves the
// shipped bundle off disk, and WHICH bundle it serves can change mid-flight.
//
// It is a separate server from the `app` target's `vite preview` on 4173 on purpose. The swap is
// destructive to every other case on the origin (a case that swapped the bundle under the smoke
// test would be a spooky action at a distance), and a service worker's scope is an ORIGIN, so the
// only clean separation is a second port.
//
// Four behaviours the bridge has and `vite preview` does not, all four load-bearing here:
//   1. the served directory is a pointer, so a deploy is one file write (`fixtures/builds.ts`);
//   2. nothing is ever cached by the HTTP layer, so the only cache in play is the service worker's,
//      which is the thing under test;
//   3. one response can be held back, or failed, on the case's instruction — the two things a case
//      cannot do with `page.route`, because a service worker's own fetches never go through the
//      page's network stack;
//   4. a navigation to a path in `NAVIGATION_NETWORK_ONLY` gets a real, identifiable page, so case
//      four can tell "the server answered" from "the precache answered". The list is imported from
//      `src/lib/sw-routes.ts` rather than restated, so the case and the worker cannot drift.
//
// `node:http` rather than `Bun.serve`, even though `bun` is what runs this file: `web/`'s tsconfig
// types Node and not Bun, and one static server is not worth a second type package.

const HTML = "text/html; charset=utf-8";

/** What the bridge would say a file is. A switch rather than a dictionary, so an extension nobody
 *  listed is a decision (`application/octet-stream`) and not a lookup that came back undefined. */
function contentType(ext: string): string {
  switch (ext) {
    case ".html":
      return HTML;
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

interface Answer {
  readonly status: number;
  readonly type: string;
  readonly body: string | Buffer;
}

function isDenylisted(pathAndSearch: string): boolean {
  // pathname + search, exactly as workbox's NavigationRoute matches it (`sw-routes.ts:33-38`).
  return NAVIGATION_NETWORK_ONLY.some((re) => re.test(pathAndSearch));
}

function serverOnlyPage(pathAndSearch: string): Answer {
  // Echoes what it was asked for, so the case can assert the query string survived the trip
  // instead of only asserting that the precache stayed out of the way.
  return {
    status: 200,
    type: HTML,
    body:
      `<!doctype html><html><head><title>${SERVER_ONLY_MARKER}</title></head>` +
      `<body><h1>${SERVER_ONLY_MARKER}</h1><p>${pathAndSearch}</p></body></html>`,
  };
}

function file(dir: string, pathname: string): string | undefined {
  // `normalize` then a prefix check: the served directory is the boundary, and `..` in a request
  // path must not walk out of it even on a test server.
  const candidate = normalize(join(dir, pathname));
  if (!candidate.startsWith(dir)) return undefined;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  return candidate;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Hold this response for as long as the directive says, OR until the case takes the directive away.
 *
 * The directive is re-read while waiting rather than captured once, so `clearDelay()` RELEASES what
 * is already in flight instead of only exempting the next request. That is what a case needs: the
 * hold's length is slack for the steps before the tap — three round trips to a browser, which a
 * loaded machine stretches — and the moment the tap is in, the case wants the install to finish as
 * fast as the machine can, because the app's eight-second guard is running from then on. A hold that
 * could only be waited out made those two needs pull against each other, and case three failed both
 * ways on a machine at a load average of 26 (2026-09-09).
 */
async function hold(pathAndSearch: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const delay = readDelay();
    if (!delay || !pathAndSearch.includes(delay.match)) return; // released, or never held
    if (Date.now() - started >= delay.ms) return; // time served
    await sleep(50);
  }
}

async function answer(pathname: string, search: string): Promise<Answer> {
  const pathAndSearch = pathname + search;
  if (isDenylisted(pathAndSearch)) return serverOnlyPage(pathAndSearch);

  // The case's own network failure, spent one request at a time. Answered before the file is even
  // looked up: this is the wire breaking, not the file missing.
  const fail = readFail();
  if (fail && pathAndSearch.includes(fail.match)) {
    spendFail(fail);
    return { status: fail.status, type: "text/plain", body: "e2e: the case took this path down" };
  }

  const dir = join(BUILDS_DIR, servedBuild());
  const hit = file(dir, pathname) ?? (extname(pathname) === "" ? file(dir, "/index.html") : undefined);
  if (!hit) return { status: 404, type: "text/plain", body: "not found" };

  // The case's own hold on a response. Applied AFTER the file is resolved and before it is handed
  // over, so a held asset is a slow 200 and never a failure — a worker that is installing has to
  // stay installing, not error out.
  await hold(pathAndSearch);

  return { status: 200, type: contentType(extname(hit)), body: readFileSync(hit) };
}

// Rebuild on every start. A directory left over from an older commit would run the cases against
// code nobody is looking at any more, and the pair takes seconds. `E2E_REUSE_BUILDS=1` is the
// escape hatch for a tight local loop on the case bodies themselves.
if (!(process.env.E2E_REUSE_BUILDS === "1" && buildsExist())) buildBoth();

createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", SWAP_BASE_URL);
    const out = await answer(url.pathname, url.search);
    res.writeHead(out.status, {
      "content-type": out.type,
      // Never the HTTP cache. The service worker's precache is the only cache this tier reasons
      // about, and a 304 on `sw.js` or `index.html` would hide a swap that did happen.
      "cache-control": "no-store",
      // What the bridge stamps on every static response, so `sw.js` is allowed the root scope.
      "service-worker-allowed": "/",
    });
    res.end(out.body);
  })();
}).listen(SWAP_PORT, "127.0.0.1", () => {
  console.log(`e2e: swappable bundle server on ${SWAP_BASE_URL} (serving ${servedBuild()})`);
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// TWO BUNDLES, ONE DIRECTORY (M26/04).
//
// The service-worker cases need a browser that is holding the precached shell of one build to be
// handed a different build — a deploy, from the browser's point of view. Nothing about that is
// fakeable: `vite.config.ts` sets `devOptions: { enabled: false }`, so the worker exists only in a
// real build, and the reload it triggers is a real navigation.
//
// So the suite builds twice, into `e2e/.builds/a` and `e2e/.builds/b`, with NO source edit between
// the runs. It does not need one: the build stamp mixes version + git sha + build time
// (`vite.config.ts:63-68` and `:121-126`), so the second run stamps a different id, which changes
// the entry chunk, which changes its hash, which changes the precache manifest, which changes
// `sw.js`. That is the shape of a real deploy, produced by the build system itself.
//
// The server (`e2e/serve-builds.ts`) reads `.builds/serving` on every request, so swapping which
// build an origin serves is one file write — {@link serveBuild} — and it is what "the bridge got
// rebuilt" looks like to a browser that is already running.

/**
 * The swappable server's port and origin. 4174 sits next to the `app` target's 4173 and collides
 * with no Collie instance (8787-8790, 8799, 5198, 5199). `127.0.0.1` over plain HTTP is a secure
 * context, so the worker registers — proven by a case of its own in `e2e/smoke.spec.ts`.
 *
 * The number is repeated once, in `playwright.config.ts`'s `webServer` entry, because a config that
 * imported this module would run its `node:child_process` import at config-load time for one
 * integer. Change it here and there.
 */
export const SWAP_PORT = 4174;
export const SWAP_BASE_URL = `http://127.0.0.1:${SWAP_PORT}`;

/** The marker a denylisted navigation must show. Nothing in the app bundle prints this string. */
export const SERVER_ONLY_MARKER = "e2e-server-answered";

/** `web/`, wherever the checkout sits. This file is `web/e2e/fixtures/`, so two levels up. */
export const WEB_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

/** Where the two builds live. Git-ignored (root `.gitignore`, `web/e2e/.builds/`). */
export const BUILDS_DIR = join(WEB_ROOT, "e2e", ".builds");

/** The two builds. `a` is the bundle a browser starts on; `b` is the one it must end up running. */
export type BuildName = "a" | "b";
export const BUILD_NAMES: readonly BuildName[] = ["a", "b"];

/** The pointer the server reads per request. One line, the name of the build being served. */
const POINTER = join(BUILDS_DIR, "serving");

/**
 * The delay directive, honoured by the server for as long as the file exists.
 *
 * Cases six and seven have to hold a service-worker INSTALL open — the precache download — and
 * those fetches are issued by the worker, not by the page, so no `page.route` sees them (checked
 * first-hand on 2026-09-09: a `page.route` on `**\/assets/*.js` never fires while a worker
 * installs). The delay therefore lives one hop further out, in the static server, and the case
 * still owns it completely: it writes the directive, it clears it, and nothing sleeps on a
 * wall-clock guess.
 */
const DELAY = join(BUILDS_DIR, "delay.json");

export interface DelayDirective {
  /** Substring of the request path to delay, e.g. `/assets/` or `.js`. */
  readonly match: string;
  /** How long to hold each matching response, in milliseconds. */
  readonly ms: number;
}

/**
 * The failure directive, honoured for a fixed number of requests and then removed.
 *
 * Case five needs `reg.update()` to THROW, which is the 2026-09-09 incident's first candidate path
 * (`src/lib/pwa.ts:178`). A `page.route(..., abort)` on `**\/sw.js` cannot do it: the browser fetches
 * the worker script through the service-worker machinery, not through the page, and the route never
 * fires (checked first-hand on 2026-09-09 — zero hits, and `update()` resolved). A bad status from
 * the server does it honestly, and it is also what a real network failure looks like to that call.
 */
const FAIL = join(BUILDS_DIR, "fail.json");

export interface FailDirective {
  /** Substring of the request path to fail, e.g. `/sw.js`. */
  readonly match: string;
  /** The status to answer with. Anything outside 2xx fails a worker-script fetch. */
  readonly status: number;
  /** How many matching requests to fail. `Infinity` is spelled as a big number, not as a keyword,
   *  because the directive travels through JSON. */
  readonly times: number;
}

/** Fail every matching request until {@link clearFail}, or until `times` is used up. */
export function setFail(directive: FailDirective): void {
  writeFileSync(FAIL, JSON.stringify(directive));
}

/** Let the failing path answer normally again. */
export function clearFail(): void {
  rmSync(FAIL, { force: true });
}

/** The server's own read of the directive. `undefined` when the file is absent. */
export function readFail(): FailDirective | undefined {
  try {
    // SAFETY: this file has one writer, {@link setFail}, three lines up, and it writes exactly a
    // FailDirective. A hand-edited or truncated file lands in the catch below as "no directive".
    return JSON.parse(readFileSync(FAIL, "utf8")) as FailDirective;
  } catch {
    return undefined;
  }
}

/** The server's own write-back, one request spent. */
export function spendFail(directive: FailDirective): void {
  if (directive.times <= 1) clearFail();
  else setFail({ ...directive, times: directive.times - 1 });
}

/**
 * The throttle directive: a response served SLOWLY rather than held back whole.
 *
 * {@link DelayDirective} stops a response dead and then hands it over in one piece, which is the
 * right shape for "this asset is wedged". It is the wrong shape for the 2026-09-12 incident, where
 * nothing was wedged at all: the phone's precache install took 125 seconds because an 869 kB chunk
 * was coming down a slow link with the tab in the background. A worker in that state is not stuck,
 * it is downloading, and the difference is the whole point of the fix — so the reproduction needs a
 * server that dribbles a real response out at a real rate.
 */
const THROTTLE = join(BUILDS_DIR, "throttle.json");

export interface ThrottleDirective {
  /** Substring of the request path to slow down, e.g. build B's entry chunk. */
  readonly match: string;
  /** The rate to write it at. 8192 is roughly the phone's link on the day. */
  readonly bytesPerSecond: number;
}

/** Serve every matching response at `bytesPerSecond` until {@link clearThrottle}. */
export function setThrottle(directive: ThrottleDirective): void {
  writeFileSync(THROTTLE, JSON.stringify(directive));
}

/** Let the throttled path run at full speed again, INCLUDING a response already mid-flight. */
export function clearThrottle(): void {
  rmSync(THROTTLE, { force: true });
}

/** The server's own read of the directive. `undefined` when the file is absent. */
export function readThrottle(): ThrottleDirective | undefined {
  try {
    // SAFETY: as with the other two directives — one writer, {@link setThrottle}, and anything else
    // in the file throws in JSON.parse and reads as "no directive".
    return JSON.parse(readFileSync(THROTTLE, "utf8")) as ThrottleDirective;
  } catch {
    return undefined;
  }
}

export interface BuildStamp {
  readonly version: string;
  readonly sha: string;
  readonly time: string;
  readonly id: string;
}

/** The build id the bridge would stamp on `X-Collie-Build` for this directory. */
export function readBuildStamp(name: BuildName): BuildStamp {
  const file = join(BUILDS_DIR, name, "build-info.json");
  // SAFETY: `buildInfoPlugin` in vite.config.ts emits this file, and it emits the four fields of
  // BuildStamp and nothing else. A missing file throws, which is the right answer for a case that
  // is about to compare two builds that were never made.
  return JSON.parse(readFileSync(file, "utf8")) as BuildStamp;
}

/**
 * The entry script of a build, e.g. `/assets/index-D4tGqQ.js`.
 *
 * This is how a case asks "which bundle is this page actually running". The baked build id is not
 * reachable from the page — vite `define` inlines `__BUILD_INFO__` into module scope, and nothing
 * puts it on `window` — while the entry chunk's name is both in the served `index.html` and in the
 * live DOM. Its hash covers the chunk's content, and the build id is IN that content, so two builds
 * never share it. The footer label is not usable for this: it prints the stamp to the minute
 * (`build.ts:14`) and two builds a few seconds apart share a minute.
 */
export function readEntryScript(name: BuildName): string {
  const html = readFileSync(join(BUILDS_DIR, name, "index.html"), "utf8");
  const src = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
  if (!src) throw new Error(`e2e: no module script in build ${name}'s index.html`);
  return src;
}

/** Serve this build from now on. One write; the server reads the pointer per request. */
export function serveBuild(name: BuildName): void {
  writeFileSync(POINTER, `${name}\n`);
}

/** Which build the server is handing out right now. */
export function servedBuild(): BuildName {
  return readFileSync(POINTER, "utf8").trim() === "b" ? "b" : "a";
}

/** Hold every matching response back by `ms`, until {@link clearDelay}. */
export function setDelay(directive: DelayDirective): void {
  writeFileSync(DELAY, JSON.stringify(directive));
}

/** Let the held responses through again. */
export function clearDelay(): void {
  rmSync(DELAY, { force: true });
}

/** The server's own read of the directive. `undefined` when the file is absent. */
export function readDelay(): DelayDirective | undefined {
  try {
    // SAFETY: as with the fail directive above — one writer, {@link setDelay}, and anything else in
    // the file throws in JSON.parse and reads as "no directive".
    return JSON.parse(readFileSync(DELAY, "utf8")) as DelayDirective;
  } catch {
    return undefined;
  }
}

/**
 * Produce both builds, then point the server at A.
 *
 * Called by the server script before it listens, so Playwright's `webServer` wait covers the two
 * builds and no case can start against a half-written directory. Two real `vite build` runs: not
 * `build:cli`, not a copy of `dist`, and not one build copied twice — a copy would carry the SAME
 * stamp and the whole tier would prove nothing.
 */
/**
 * Sit out the rest of the current wall-clock second.
 *
 * The build id ends in `Math.floor(Date.parse(buildTime) / 1000)` (`vite.config.ts:125`), so its
 * resolution is ONE SECOND, and a machine that runs two builds inside the same second would stamp
 * them identically. A build takes longer than that today, which is luck, not a guarantee. Waiting
 * out the second makes the two ids differ by construction. This is the build helper, not a case: no
 * case in this suite sleeps.
 */
function waitOutTheSecond(): void {
  const rest = 1_000 - (Date.now() % 1_000) + 20;
  execFileSync("sleep", [(rest / 1_000).toFixed(3)]);
}

export function buildBoth(): void {
  mkdirSync(BUILDS_DIR, { recursive: true });
  clearDelay();
  clearFail();
  clearThrottle();
  for (const name of BUILD_NAMES) {
    if (name !== BUILD_NAMES[0]) waitOutTheSecond();
    execFileSync("bunx", ["vite", "build", "--outDir", join("e2e", ".builds", name), "--emptyOutDir"], {
      cwd: WEB_ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, COLLIE_PLAYGROUND: "" },
    });
  }
  const [a, b] = [readBuildStamp("a"), readBuildStamp("b")];
  // Loud, here, at the source: a build system that started producing identical stamps would make
  // every case in the file pass while proving nothing, and the failure would read as a timeout in a
  // browser rather than as what it is.
  if (a.id === b.id) {
    throw new Error(
      `e2e: build A and build B share the id ${a.id}. Two builds must differ; see vite.config.ts:63-68.`,
    );
  }
  serveBuild("a");
}

/** True when both directories are present and stamped. Used by the server's reuse path. */
export function buildsExist(): boolean {
  return BUILD_NAMES.every((n) => existsSync(join(BUILDS_DIR, n, "build-info.json")));
}

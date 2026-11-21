import { isReloadHeld } from "./reload-guard";

// A page that outlives its build asks for a chunk the new build no longer has. The service worker
// activates at once (src/sw.ts skipWaiting + clientsClaim) and drops the old precache, so a language
// dictionary, the diff highlighter or the speech engine can answer 404 to an old page. `import()`
// then throws, and with nothing to catch it the app goes blank. One reload fetches the new build,
// which names the new chunks.
//
// Two doors lead here. Vite fires `vite:preloadError` for an import it wrapped in its preload helper.
// An import with no CSS or sibling chunks to preload is NOT wrapped and fires nothing, so the call
// sites that matter go through `reloadOnChunkError` instead. Both end in the same decision.

/** sessionStorage key holding the time of the last reload this guard made. */
export const PRELOAD_RELOAD_KEY = "collie:preload-reload";

/** A chunk that is truly gone cannot loop the page: no second reload inside this window. */
export const PRELOAD_RELOAD_WINDOW_MS = 60_000;

export type PreloadReloadDecision = "reload" | "recent" | "held";

/**
 * Whether a failed chunk earns a reload now. Pure.
 *
 * `held` is the app's own reload guard (lib/reload-guard.ts: unsent composer text, an upload, an open
 * sheet): a reload over it would lose what the person typed. `recent` is the loop stop.
 */
export function decidePreloadReload(input: {
  now: number;
  last: number | null;
  held: boolean;
}): PreloadReloadDecision {
  if (input.held) return "held";
  if (input.last !== null && input.now - input.last < PRELOAD_RELOAD_WINDOW_MS) return "recent";
  return "reload";
}

/** The reload itself. lib/pwa.ts registers `reloadOnce("auto")`, so this guard shares its latch. */
let reloader: (() => void) | null = null;

export function setChunkReloader(fn: (() => void) | null): void {
  reloader = fn;
}

function readLast(): number | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PRELOAD_RELOAD_KEY) ?? null;
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** True when the stamp is stored. A page that cannot store it must not reload: it could not stop. */
function writeLast(now: number): boolean {
  try {
    globalThis.sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now));
    return globalThis.sessionStorage.getItem(PRELOAD_RELOAD_KEY) === String(now);
  } catch {
    return false;
  }
}

// ONLY A CHUNK THAT COULD NOT BE FETCHED EARNS A RELOAD. A screen module that throws in its own top-level
// code fails the same `import()`, and Vite's helper fires `vite:preloadError` for it too
// (`baseModule().catch(handlePreloadError)`), but a reload brings back the same module and the same throw.
// Each engine names a failed fetch in its own words; anything else is the module's own error and goes to
// the route's error screen.
const CHUNK_FETCH_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/u;

/** Whether `error` says a chunk could not be fetched (Chromium, WebKit, Firefox, Vite's CSS preload). */
export function isChunkFetchError<E>(error: E): boolean {
  return CHUNK_FETCH_FAILURE.test(String(error));
}

/** Reload once for a missing chunk, if the decision allows. Returns whether it reloaded. */
export function reloadForMissingChunk(): boolean {
  if (reloader === null) return false;
  const now = Date.now();
  if (decidePreloadReload({ now, last: readLast(), held: isReloadHeld() }) !== "reload") return false;
  if (!writeLast(now)) return false;
  reloader();
  return true;
}

// A BACKGROUND PRELOAD NEVER RELOADS THE PAGE (lib/route-preload.ts, ADR 0169). It imports the lazy
// screens while the app is idle, and a chunk it cannot fetch is the real navigation's business later.
// Vite fires `vite:preloadError` synchronously inside the failed import, before it rethrows, so a count
// of the preloads in flight tells this listener the event is theirs. A real navigation in the same moment
// still reloads: every lazy screen goes through `reloadOnChunkError`, which decides on its own.
let preloadsInFlight = 0;

/** One chunk's import, for a background preload: it settles when the chunk is in or has failed. */
export type ChunkPreload = () => Promise<void>;

/**
 * Run `load` as a background preload: its failure is swallowed and never reloads the page. Resolves true
 * when the chunk is in, false when it failed (the preload retries it, lib/route-preload.ts).
 */
export async function preloadQuietly(load: ChunkPreload): Promise<boolean> {
  preloadsInFlight += 1;
  try {
    await load();
    return true;
  } catch {
    // The navigation that needs this chunk fetches it again, with its own reload.
    return false;
  } finally {
    preloadsInFlight -= 1;
  }
}

/** What Vite dispatches: `payload` is the error of the failed import. */
export interface PreloadErrorEvent extends Event {
  readonly payload?: Error;
}

/**
 * The `vite:preloadError` listener. Cancels Vite's rethrow only when it reloads, and reloads only for a
 * chunk that could not be fetched. A held tab (lib/reload-guard.ts) gets `held` from the decision: no
 * reload, no cancel, so Vite rethrows and the route's error screen shows at once.
 */
export function onPreloadError(event: PreloadErrorEvent): void {
  if (preloadsInFlight > 0) return;
  if (!isChunkFetchError(event.payload)) return;
  if (reloadForMissingChunk()) event.preventDefault();
}

/** Run a dynamic `import()` that Vite may not have wrapped; a failed fetch reloads once, then it rethrows. */
export async function reloadOnChunkError<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isChunkFetchError(error)) reloadForMissingChunk();
    throw error;
  }
}

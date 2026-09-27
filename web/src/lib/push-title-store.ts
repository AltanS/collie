// ── WHERE THE PAGE LEAVES ITS PUSH TITLES FOR THE SERVICE WORKER (ADR 0071) ────────────────────────
//
// A push wakes the service worker, and the worker is what decides the words on the lock screen. It
// cannot read the language the operator chose — that lives in `localStorage`, which a worker has no
// access to — and it cannot load the translated dictionaries, which are lazy chunks a worker cannot
// `import()`. The PAGE can do both. So the page renders the one table the worker needs, the title
// template for every push title code in the active language, and leaves it in Cache Storage, which
// both sides can reach. The worker reads it on each push and fills the `{slot}`s.
//
// Cache Storage and not IndexedDB: one small JSON value, keyed by a URL, is exactly what a Cache holds,
// and `lib/sw-routes`' fonts already live there. The entry is never fetched from the network; the key
// is a URL only because a Cache is keyed by one.
//
// Imported by both sides, so this module holds no state and has no side effect at load.

import { parseJsonObject, asJsonObject, asJsonString } from "./json";
import { isPushTitleCode } from "./push-title-codes";

/**
 * A title template per push title code, `{slot}`s unfilled. Keyed by the code; a code missing here
 * shows its English. Only codes `isPushTitleCode` accepts are ever written into one.
 */
export interface PushTitleTemplates {
  [code: string]: string;
}

/**
 * The Cache the table lives in, named per mount (ADR 0052) for the reason the font cache is: two
 * collies mounted at two paths on one origin share one Cache Storage, and must not read each other's
 * language.
 */
export function pushTitlesCacheName(mount: string): string {
  return mount === "/" ? "collie-push-titles" : `collie-push-titles:${mount}`;
}

/** The entry's key: a URL under the mount, on the given origin. Never requested. */
export function pushTitlesKey(origin: string, mount: string): string {
  return `${origin}${mount}push-titles.json`;
}

/**
 * The stored shape. `locale` is not read back by the worker — the templates are already in it — but
 * it is what makes the entry legible to anyone inspecting storage.
 */
export interface StoredPushTitles {
  readonly locale: string;
  readonly titles: PushTitleTemplates;
}

/** Serialise a table for the Cache. */
export function serialisePushTitles(stored: StoredPushTitles): string {
  return JSON.stringify(stored);
}

/**
 * Read a table back, keeping only what this build can use: a known code with a string template.
 * Anything else — a body that is not JSON, a code from another build, a non-string — is dropped, and
 * a dropped code simply shows its English.
 */
export function parsePushTitles(text: string): PushTitleTemplates {
  const titles = asJsonObject(parseJsonObject(text)?.titles);
  const out: PushTitleTemplates = {};
  if (titles === undefined) return out;
  for (const [code, value] of Object.entries(titles)) {
    const template = asJsonString(value);
    if (isPushTitleCode(code) && template !== undefined) out[code] = template;
  }
  return out;
}

/** What the table is stored in: the one slice of Cache Storage this module needs, so a test can fake it. */
export interface PushTitleCaches {
  open(cacheName: string): Promise<Pick<Cache, "match" | "put">>;
}

/** The worker's read. An empty table on any failure: the push still shows, in English. */
export async function readPushTitles(caches: PushTitleCaches, origin: string, mount: string): Promise<PushTitleTemplates> {
  try {
    const cache = await caches.open(pushTitlesCacheName(mount));
    const hit = await cache.match(pushTitlesKey(origin, mount));
    return hit === undefined ? {} : parsePushTitles(await hit.text());
  } catch {
    return {};
  }
}

/** The page's write. */
export async function writePushTitles(
  caches: PushTitleCaches,
  origin: string,
  mount: string,
  stored: StoredPushTitles,
): Promise<void> {
  const cache = await caches.open(pushTitlesCacheName(mount));
  const body = new Response(serialisePushTitles(stored), { headers: { "content-type": "application/json" } });
  await cache.put(pushTitlesKey(origin, mount), body);
}

// The document prefetch (S3; research note 10, section 1). A finger on a row starts the fetch of the
// page the tap will open; the tap's soft navigation then finds the answer here and costs no round trip
// (`resolveIslandFrame`, islands/resolver.ts). Measured in the probe: tap to commit 31 to 66 ms down to
// 3 to 5 ms after release.
//
// THE RESPONSE IS KEPT UNREAD. The runtime needs an unread body (it calls `getReader()` at once), and a
// `Response` whose body was read throws there and leaves the URL and the content out of step (note 10,
// trap 1). A string or a rebuilt `Response` loses `redirected`, so a redirect would not be followed
// (trap 2). So the entry keeps the original and every user gets `clone()`. The resolver also needs the
// text (the data block, islands/document-data.ts): a second clone is read as soon as the answer
// arrives, while the finger is still down, so that read is not inside the tap's commit.
//
// SHORT LIVED AND SMALL. A prefetched document is one moment of the panes; the frame poll corrects it
// after the commit. An entry lives PREFETCH_TTL_MS, at most PREFETCH_MAX entries are kept, and an
// entry is DELETED when a navigation takes it. A pointerdown also starts every scroll that begins on a
// row, so `pointercancel` (the browser sends it when the scroll takes over) cancels the fetch.
//
// THE WARM ENTRY (Back is a refetch, note 10, 5.6). On a pane page the document Back would land on is
// fetched once after the page settled and kept WARM_TTL_MS, so a Back costs the diff and not the round
// trip. Its age is bounded; the first beat after Back corrects what moved.

/** The request headers of a top-frame navigation (C/src/runtime/run.ts `defaultResolveFrame`). */
export const DOCUMENT_HEADERS = { Accept: "text/html", "X-Remix-Frame": "true" } as const;

export const PREFETCH_TTL_MS = 5_000;
export const WARM_TTL_MS = 60_000;
export const PREFETCH_MAX = 3;

interface Entry {
  href: string;
  at: number;
  ttl: number;
  controller: AbortController;
  response: Promise<Response | null>;
  /** The answer's text, read off a clone as soon as it arrived; null when the fetch failed. */
  text: Promise<string | null>;
}

/** A prefetched answer: an unread clone for the runtime, and the text read off another. */
export interface Prefetched {
  response: Response;
  text: Promise<string | null>;
}

const entries: Entry[] = [];

/** The cache key: the absolute URL without its hash. */
export function prefetchKey(href: string): string {
  const url = new URL(href, document.baseURI);
  url.hash = "";
  return url.href;
}

function live(entry: Entry, now: number): boolean {
  return now - entry.at < entry.ttl;
}

function drop(entry: Entry): void {
  const at = entries.indexOf(entry);
  if (at !== -1) entries.splice(at, 1);
}

/** Start fetching `href` as a top-frame navigation would; a fresh entry for it is reused. */
export function prefetchDocument(href: string, ttl: number = PREFETCH_TTL_MS): void {
  const key = prefetchKey(href);
  const now = Date.now();
  const held = entries.find((e) => e.href === key);
  if (held !== undefined && live(held, now) && now - held.at < PREFETCH_TTL_MS) {
    held.ttl = Math.max(held.ttl, ttl);
    return;
  }
  if (held !== undefined) drop(held);
  const controller = new AbortController();
  const response = fetch(key, { headers: DOCUMENT_HEADERS, mode: "same-origin", signal: controller.signal }).catch(() => null);
  const text = response.then((answer) => (answer === null ? null : answer.clone().text())).catch(() => null);
  entries.unshift({ href: key, at: now, ttl, controller, response, text });
  while (entries.length > PREFETCH_MAX) entries.pop()?.controller.abort();
}

/** The finger left for a scroll: stop the fetch it started, unless a tap already took it. */
export function cancelPrefetch(href: string): void {
  const key = prefetchKey(href);
  const held = entries.find((e) => e.href === key);
  if (held === undefined || held.ttl > PREFETCH_TTL_MS) return;
  held.controller.abort();
  drop(held);
}

/**
 * Take the entry for `href` off the cache. Resolves to a CLONE of the unread answer and its text, or
 * null when there is no live entry or its fetch failed (the caller then fetches itself).
 */
export async function takePrefetched(href: string): Promise<Prefetched | null> {
  const key = prefetchKey(href);
  const now = Date.now();
  const held = entries.find((e) => e.href === key);
  if (held === undefined) return null;
  drop(held);
  if (!live(held, now)) {
    held.controller.abort();
    return null;
  }
  const response = await held.response;
  return response === null ? null : { response: response.clone(), text: held.text };
}

/** Whether a live entry for `href` exists (tests and the glide's wait). */
export function hasPrefetched(href: string): boolean {
  const key = prefetchKey(href);
  const held = entries.find((e) => e.href === key);
  return held !== undefined && live(held, Date.now());
}

/** The fetch for `href`, settled, if there is a live entry: the glide waits on it at most 120 ms. */
export function prefetchSettled(href: string): Promise<void> {
  const key = prefetchKey(href);
  const held = entries.find((e) => e.href === key);
  return held === undefined ? Promise.resolve() : held.response.then(() => undefined);
}

/** Forget everything (a test, a build change). */
export function clearPrefetched(): void {
  for (const entry of entries.splice(0)) entry.controller.abort();
}

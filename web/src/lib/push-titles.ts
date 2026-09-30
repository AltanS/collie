// ── THE PAGE'S HALF OF A TRANSLATED PUSH TITLE (ADR 0074) ───────────────────────────────────────────
//
// Keeps the service worker's title table (`lib/push-title-store.ts`) in the language this device
// shows. Written at boot and again on every change to the locale store, which notifies both when the
// operator picks a language and when that language's lazy dictionary lands.
//
// Every write waits for the chosen language's dictionary first, so the table is never written in the
// English `t()` serves during the loading gap and then left that way. A dictionary that fails to load
// leaves `t()` in English, and the table follows it: the fallback the rest of the app already has.

import { basePath } from "./base-path";
import { cacheStorage } from "./env";
import { getLocaleSnapshot, subscribeLocale, t, whenLocaleReady, type Locale } from "./i18n";
import { PUSH_TITLE_CODES } from "./push-title-codes";
import {
  serialisePushTitles,
  writePushTitles,
  type PushTitleTemplates,
  type StoredPushTitles,
} from "./push-title-store";

/**
 * Every push title template in the active language, `{slot}`s left for the worker to fill.
 *
 * The template-literal key is what makes the table complete by construction: a code in
 * `lib/push-title-codes.ts` with no `pushTitle.<code>` in `en.ts` does not compile.
 */
export function pushTitleTemplates(): PushTitleTemplates {
  const titles: PushTitleTemplates = {};
  for (const code of PUSH_TITLE_CODES) titles[code] = t(`pushTitle.${code}`);
  return titles;
}

// Writes are chained so two quick locale changes can never land out of order, and the last one
// written is remembered so a repeat notification (a re-render with nothing new) writes nothing.
let chain: Promise<void> = Promise.resolve();
let lastWritten = "";

/** Write the table for `locale`, once its dictionary is in — unless a newer choice has replaced it. */
async function writeFor(storage: CacheStorage, locale: Locale): Promise<void> {
  await whenLocaleReady(locale);
  // A newer choice arrived while this one loaded; its own write is queued behind this one.
  if (getLocaleSnapshot().locale !== locale) return;
  const stored: StoredPushTitles = { locale, titles: pushTitleTemplates() };
  const serialised = serialisePushTitles(stored);
  if (serialised === lastWritten) return;
  await writePushTitles(storage, location.origin, basePath(), stored);
  lastWritten = serialised;
}

function scheduleWrite(storage: CacheStorage): void {
  const { locale } = getLocaleSnapshot();
  chain = chain
    .then(() => writeFor(storage, locale))
    // Best-effort: a full quota or a refused write costs the translation (the push shows its
    // English), never the page.
    .catch(() => undefined);
}

/**
 * Start keeping the table current. A no-op without Cache Storage — an insecure context, where there
 * is no service worker and no push to translate either.
 */
export function startPushTitleSync(): void {
  const storage = cacheStorage();
  if (storage === null) return;
  scheduleWrite(storage);
  subscribeLocale(() => scheduleWrite(storage));
}

// The locale as a store, so a language change re-renders every screen that reads it.
//
// web/src/lib/i18n is the runtime (`t()`, `setLocale()`, the lazy dictionaries, the pin in
// localStorage under `collie:locale:v1`) and it is React-free, so this shell uses it as it stands.
// What it lacks for Remix is a `Store` (lib/store.ts): its own subscribe/snapshot pair was shaped for
// `useSyncExternalStore`. This module mirrors that snapshot into one store and nothing else, so the
// language has ONE source of truth (the runtime) and one way to re-render (`useStore`).
//
// The runtime notifies twice for a change to a lazy language: once on the choice (English serves in
// the gap) and once when the dictionary lands. Its `revision` counter changes both times, and the
// store's equality compares it, so the second paint is never skipped.
import {
  getLocaleSnapshot,
  setLocale as setRuntimeLocale,
  subscribeLocale,
  type Locale,
  type LocaleState,
} from "@web/lib/i18n";
import { startPushTitleSync } from "@web/lib/push-titles";

import { createStore, useStore, type Store, type Updatable } from "./store";

/** The active language and the runtime's revision counter. */
export const locale: Store<LocaleState> = createStore<LocaleState>(
  getLocaleSnapshot(),
  (a, b) => a.locale === b.locale && a.revision === b.revision,
);

subscribeLocale(() => locale.set(getLocaleSnapshot()));

/**
 * Subscribe a component to the language for its lifetime. Call it in the SETUP function, like any
 * `useStore`; the render function then calls the returned reader (or just `t()`, which reads the
 * runtime) and is re-run on every change.
 */
export function useLocale(handle: Updatable): () => LocaleState {
  return useStore(handle, locale);
}

/** Switch languages. The runtime persists the pin and stamps `<html lang>`; the store follows it. */
export function setLocale(next: Locale): void {
  setRuntimeLocale(next);
}

let pushTitlesStarted = false;

/**
 * Keep the service worker's push title table in the active language (ADR 0074). The page writes it
 * to Cache Storage at boot and on every locale change, through web/'s own writer, so a push the
 * worker renders reads the same table under the same cache name as it does for the React app.
 */
export function startLocaleSync(): void {
  if (pushTitlesStarted) return;
  pushTitlesStarted = true;
  startPushTitleSync();
}

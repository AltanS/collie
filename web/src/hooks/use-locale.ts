import { useSyncExternalStore } from "react";

import { getLocaleSnapshot, setLocale, subscribeLocale, type Locale } from "@/lib/i18n";

// The React face of the locale store (`lib/i18n`), shaped exactly like `use-theme.ts`: no context,
// no provider, one module singleton behind `useSyncExternalStore`.
//
// Subscribing is what makes `t()` work from inside a component. `t()` reads the store at call time,
// so a component that calls it during render needs a reason to render AGAIN when the answer
// changes — this hook is that reason. Calling `useLocale()` and ignoring the return value is
// therefore legitimate in a component that only calls `t()`; the subscription is the point.
//
// The store's snapshot carries a revision counter, so a lazily-loaded dictionary ARRIVING notifies
// too, not just a locale switch. Without that, choosing German would repaint once (in English,
// because the chunk had not landed) and then never again.

export interface UseLocaleReturn {
  locale: Locale;
  /**
   * Bumped on every change that alters rendered text, INCLUDING a lazy dictionary arriving.
   *
   * A component that only calls `t()` never needs this — re-rendering is enough. A component that
   * MEMOISES a derived string does: `locale` alone is the wrong dependency, because choosing German
   * changes it once, paints English (the bundle has not landed), and never changes again when the
   * bundle does. The revision moves on both events, so it is the only honest key for a memo whose
   * value came out of `t()`.
   */
  revision: number;
  setLocale: (locale: Locale) => void;
}

export function useLocale(): UseLocaleReturn {
  const snapshot = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  return { locale: snapshot.locale, revision: snapshot.revision, setLocale };
}

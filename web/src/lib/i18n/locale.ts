// The locale vocabulary: which languages Collie speaks, and how to recognise one.
//
// This module holds no state and imports nothing — the runtime (./index.ts), the hook
// (../../hooks/use-locale.ts) and the message bundles all agree on these names, and a bundle can
// import the type without dragging the store's module-load side effects into its graph.

export type Locale = "en" | "de" | "es" | "ko" | "ja" | "zh" | "zh-TW";

/** What Collie falls back to: the source-of-truth dictionary, always present in the main chunk. */
export const DEFAULT_LOCALE = "en" satisfies Locale;

export interface LocaleOption {
  readonly code: Locale;
  /** The language's name IN that language — a selector row is read by someone who cannot yet read
   *  the current UI language, so "Deutsch" is the only label that helps them. */
  readonly nativeName: string;
}

/** Selector order: English first (the fallback), then the rest as they were added. */
export const LOCALES: readonly LocaleOption[] = [
  { code: "en", nativeName: "English" },
  { code: "de", nativeName: "Deutsch" },
  { code: "es", nativeName: "Español" },
  { code: "ko", nativeName: "한국어" },
  { code: "ja", nativeName: "日本語" },
  { code: "zh", nativeName: "简体中文" },
  { code: "zh-TW", nativeName: "繁體中文" },
];

/** Narrow a string of unknown provenance (localStorage, a URL, a header) to a Locale. */
export function isLocale(value: string): value is Locale {
  return LOCALES.some((option) => option.code === value);
}

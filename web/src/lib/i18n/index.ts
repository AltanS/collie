import { hasDocument } from "../env";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locale";
import { en, type Dictionary, type MessageKey } from "./messages/en";
import { interpolate, type TemplateVars } from "./template";

// The translation runtime: one module-scoped store, one lookup function, one plural function.
//
// Shaped after `hooks/use-theme.ts` deliberately — module-scope state, a listeners Set, a
// subscribe/getSnapshot pair for `useSyncExternalStore`, a bare (not JSON) localStorage value. The
// reasons are the same ones stated there: the store must survive App.tsx unmounting the router, and
// any number of readers must agree without prop-drilling, so the selector can live in Settings
// alone without the rest of the app being told.
//
// Two things are different from the theme, and both come from the bundles being LAZY:
//
//   1. English is the only dictionary in the main chunk. Every other locale arrives through a
//      dynamic import, so `t()` has to answer correctly during the gap — it serves English, and the
//      screen re-renders into the translation when the bundle lands. A missing translation is never
//      a blank label.
//   2. The snapshot therefore carries a `revision` counter as well as the locale name. The arrival
//      of a dictionary changes no locale name, but every rendered string just changed, so it must
//      still notify. Without the counter the app would sit in English until something else
//      re-rendered it.

export type { Locale } from "./locale";
export { LOCALES, DEFAULT_LOCALE, isLocale, type LocaleOption } from "./locale";
export type { MessageKey, Messages, Dictionary } from "./messages/en";

export type { TemplateVars } from "./template";

/** The bases of the `.one`/`.other` pairs in English — the only keys `tn()` accepts. Extracting
 *  them from `MessageKey` means adding a plural pair to `en.ts` is all it takes to make it
 *  callable, and asking `tn()` for a key that has no pair is a compile error. */
type PluralBaseOf<K> = K extends `${infer Base}.one`
  ? `${Base}.other` extends MessageKey
    ? Base
    : never
  : never;
export type PluralKey = PluralBaseOf<MessageKey>;

const STORAGE_KEY = "collie:locale:v1";

/** Every non-English bundle, behind a dynamic import so it is a separate chunk. Adding a locale is
 *  a row here plus a row in `LOCALES` — the exhaustive `Record` makes forgetting this one an
 *  error. */
const LOADERS = {
  de: async () => (await import("./messages/de")).de,
  es: async () => (await import("./messages/es")).es,
  ko: async () => (await import("./messages/ko")).ko,
  ja: async () => (await import("./messages/ja")).ja,
  zh: async () => (await import("./messages/zh")).zh,
  "zh-TW": async () => (await import("./messages/zh-TW")).zhTW,
  ru: async () => (await import("./messages/ru")).ru,
  it: async () => (await import("./messages/it")).it,
  fr: async () => (await import("./messages/fr")).fr,
  pt: async () => (await import("./messages/pt")).pt,
  tr: async () => (await import("./messages/tr")).tr,
} satisfies Record<Exclude<Locale, typeof DEFAULT_LOCALE>, () => Promise<Dictionary>>;

const loaded = new Map<Locale, Dictionary>();
const loading = new Map<Locale, Promise<void>>();

function storage(): Storage | null {
  return globalThis.localStorage ?? null;
}

/** Read the pin. BARE string, not JSON — same as the theme's, and for the same reason. */
function loadLocale(): Locale {
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;
    return raw !== null && isLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function saveLocale(locale: Locale): void {
  try {
    // Absent means English, so choosing the default removes the key rather than storing a sentinel.
    if (locale === DEFAULT_LOCALE) storage()?.removeItem(STORAGE_KEY);
    else storage()?.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore quota / private-mode write errors: the choice still applies for this session.
  }
}

/** `<html lang>` — screen readers pick pronunciation from it, and so does the browser's translate
 *  offer. Wrong here is worse than absent, so it tracks the ACTIVE choice, not the loaded bundle. */
function applyDocumentLang(locale: Locale): void {
  if (!hasDocument()) return;
  document.documentElement.lang = locale;
}

export interface LocaleState {
  /** What the user chose — the answer a selector renders as checked, translated or not yet. */
  readonly locale: Locale;
  /** Bumped on every change that alters rendered text, INCLUDING a bundle arriving. */
  readonly revision: number;
}

// useSyncExternalStore demands a stable snapshot reference, so this object is replaced only on a
// real change and returned as-is otherwise.
let state: LocaleState = { locale: loadLocale(), revision: 0 };
const listeners = new Set<() => void>();

function notify(locale: Locale): void {
  state = { locale, revision: state.revision + 1 };
  for (const listener of listeners) listener();
}

/** Kick (or join) the load of a locale's bundle. English is already here; a failed import leaves
 *  English serving, which is exactly the degraded state the fallback exists for. */
async function fetchDictionary(locale: Exclude<Locale, typeof DEFAULT_LOCALE>): Promise<void> {
  try {
    const dictionary = await LOADERS[locale]();
    loaded.set(locale, dictionary);
    // Only notify if this is still the locale on screen — a fast en→de→en toggle must not repaint
    // the app in German because the German chunk finally arrived.
    if (state.locale === locale) notify(locale);
  } catch {
    // Swallowed on purpose: `t()` keeps answering in English and the UI stays usable offline.
  }
}

function ensureDictionary(locale: Locale): Promise<void> {
  if (locale === DEFAULT_LOCALE || loaded.has(locale)) return Promise.resolve();
  const inFlight = loading.get(locale);
  if (inFlight !== undefined) return inFlight;

  const load = fetchDictionary(locale).finally(() => {
    loading.delete(locale);
  });
  loading.set(locale, load);
  return load;
}

/** The dictionary `t()` is actually reading: the active locale's if it has landed, else English. */
function activeDictionary(): Dictionary | typeof en {
  return loaded.get(state.locale) ?? en;
}

/** The locale whose grammar matches the strings being served — see `activeDictionary`. Plural
 *  category and text must come from the same language, or "1 languages" ships. */
function activeLocale(): Locale {
  return loaded.has(state.locale) ? state.locale : DEFAULT_LOCALE;
}


/** Translate one key into the active language, filling any `{slot}`s. */
export function t(key: MessageKey, vars?: TemplateVars): string {
  return interpolate(activeDictionary()[key], vars);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** The CLDR plural category Intl reports for `count` in `locale`: `one`, `few`, `many`, `other` and so
 *  on. Which categories a language has is the language's business, not ours: English and German
 *  have `one`/`other`, Japanese only `other`, Russian `one`/`few`/`many`/`other`. */
function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Translate a plural set. `keyBase` names the set, not a key: `tn("a.b.count", 2)` reads
 * `a.b.count.other` in English. The category comes from `Intl.PluralRules` for the active language,
 * and the key is `${keyBase}.${category}`. A dictionary carries only the categories its language
 * needs beyond `.other`: English has `.one`, Russian adds `.few` and `.many`. A category the
 * dictionary has no key for (French `many` for a million, a fraction in any language) falls back to
 * `.other`, which every dictionary carries. `count` is injected as the `{count}` slot, so the
 * message never has to repeat it at the call site, and it wins over an explicit `vars.count`,
 * which would only ever disagree.
 */
export function tn(keyBase: PluralKey, count: number, vars?: TemplateVars): string {
  const dictionary: Readonly<Record<string, string | undefined>> = activeDictionary();
  const template =
    dictionary[`${keyBase}.${pluralCategory(activeLocale(), count)}`] ?? dictionary[`${keyBase}.other`];
  // `.other` exists for every PluralKey in every dictionary (the type and the parity test see to
  // it), so this only fires if that contract is broken.
  if (template === undefined) throw new Error(`tn: no plural form for ${keyBase}`);
  return interpolate(template, { ...vars, count });
}

/** Switch languages: persist, stamp `<html lang>`, repaint now in whatever is available, and start
 *  the bundle fetch — which repaints again when it lands. */
export function setLocale(locale: Locale): void {
  saveLocale(locale);
  applyDocumentLang(locale);
  notify(locale);
  void ensureDictionary(locale);
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocaleSnapshot(): LocaleState {
  return state;
}

/** Resolves when `locale`'s bundle has landed (or failed). The test seam for the loading gap; also
 *  usable by a caller that must not paint a half-translated first frame. */
export function whenLocaleReady(locale: Locale = state.locale): Promise<void> {
  return ensureDictionary(locale);
}

// Boot: honour the persisted choice. A non-English pin starts its fetch here, at module load,
// rather than waiting for the first component to ask.
applyDocumentLang(state.locale);
void ensureDictionary(state.locale);

/** Test seam — forget every loaded bundle and re-read the pin, as if the page had just opened. */
export function __resetLocale(): void {
  loaded.clear();
  loading.clear();
  pluralRules.clear();
  state = { locale: loadLocale(), revision: state.revision + 1 };
  applyDocumentLang(state.locale);
  for (const listener of listeners) listener();
}

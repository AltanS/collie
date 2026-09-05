import { hasDocument } from "../env";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locale";
import { en, type Dictionary, type MessageKey } from "./messages/en";

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

/** Values for a message's `{slot}`s. An interface (not `Record<string, …>`) so the index signature
 *  has a named owner — see ADR 0019, `no-known-value-widening`. */
export interface TemplateVars {
  readonly [slot: string]: string | number;
}

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

/**
 * Fill a message's `{slot}`s.
 *
 * split/join, NOT `String.replaceAll` — the replacement half of `replaceAll` interprets `$&`, `$'`
 * and `$1`, so a value containing a dollar sign would be mangled into a capture reference. Nor is a
 * `RegExp` built from the slot name, which would let a key's punctuation become syntax.
 */
function interpolate(template: string, vars: TemplateVars | undefined): string {
  if (vars === undefined) return template;
  let out = template;
  for (const [slot, value] of Object.entries(vars)) {
    out = out.split(`{${slot}}`).join(String(value));
  }
  return out;
}

/** Translate one key into the active language, filling any `{slot}`s. */
export function t(key: MessageKey, vars?: TemplateVars): string {
  return interpolate(activeDictionary()[key], vars);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** `one` or `other` — the only two categories our seven languages need. Anything else Intl reports
 *  (`few`, `many`, `zero`, `two`) maps to `other`, which is the correct bucket for a dictionary
 *  that only carries the pair. */
function pluralSuffix(locale: Locale, count: number): "one" | "other" {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count) === "one" ? "one" : "other";
}

/**
 * Translate a plural pair. `keyBase` names the pair, not a key: `tn("a.b.count", 2)` reads
 * `a.b.count.other`. `count` is injected as the `{count}` slot, so the message never has to repeat
 * it at the call site — and it wins over an explicit `vars.count`, which would only ever disagree.
 */
export function tn(keyBase: PluralKey, count: number, vars?: TemplateVars): string {
  const key: MessageKey = `${keyBase}.${pluralSuffix(activeLocale(), count)}`;
  return interpolate(activeDictionary()[key], { ...vars, count });
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

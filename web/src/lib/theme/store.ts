// The device's colour theme (M57): which one is active, the library of imported ones, and the one
// function that touches the page. The file format is `schema.ts`; the look of the app is
// `index.css` and `themes.css`; this module is what joins them on a phone.
//
// THREE KINDS OF THEME, ONE RULE EACH.
//   * `collie`, the app's own look, is the stylesheet as it stands. Applying it writes NOTHING: no
//     attribute, no inline property. That is what keeps the pixels of the current look unchanged.
//   * A shipped theme (nightwatch, daylight, harbour) is a generated block in `themes.css`. Applying
//     it sets `data-theme="<id>"` on <html> and nothing else.
//   * An imported theme lives in the library (localStorage, validated) and is applied as inline
//     custom properties on <html>, one per token, each a `light-dark()` pair, plus the declarations
//     of the shape words its `surface` block names, its display face and its terminal palette
//     (surface.ts `versionTwoDeclarations`), and only those.
//
// STORAGE IS NOT TRUSTED, TWICE. A library entry goes through `parseTheme` when it is loaded, and
// the theme goes through it again inside `applyTheme`, because the only way to be sure that nothing
// unchecked reaches `style.setProperty` is that the function holding it checks. Three more rules
// close the door on the page: the property NAME always comes from `THEME_TOKENS`, never from the
// file; only the validated OBJECT is applied, never stored CSS text; and `name` and `author` are
// text for a text node, never HTML (that is Settings' to keep, and it is spelled here so it is not
// forgotten).
//
// THE DESIGN STORE OWNS "WHICH". The active id is the field `theme` of `collie:design:v1`
// (lib/design.ts), so the pre-paint script reads one key for the face and the theme. This module owns
// the library (`collie:themes:v1`) and the DOM.

import { useSyncExternalStore } from "react";

import { setMetaColours, type MetaColours } from "@/hooks/use-theme";
import { designPrefs, setDesignFont, setDesignTheme, subscribeDesign } from "@/lib/design";
import { hasDocument, hasWindow } from "@/lib/env";
import { isShippedFont } from "@/lib/shipped-fonts";
import { asJsonObject, parseJsonObject } from "@/lib/json";

import {
  DEFAULT_THEME_ID,
  SHIPPED_THEME_IDS,
  ALL_THEME_TOKENS,
  OPTIONAL_THEME_TOKENS,
  THEME_MAX_BYTES,
  THEME_TOKENS,
  fillHalves,
  isShippedThemeId,
  lightDark,
  parseTheme,
  setsOptionalToken,
  toSrgbHex,
  type Theme,
} from "./schema";
import { isThemeEscape, withoutThemeEscape } from "./escape";
import { readOrigin, type ThemeOrigin } from "./origin";
import { VERSION_TWO_PROPERTIES, omittedGroundDeclarations, resolveSurface, versionTwoDeclarations } from "./surface";

/** The library's storage key. `public/theme-init.js` reads the same string; `theme-init.test.ts` holds them equal. */
export const LIBRARY_STORAGE_KEY = "collie:themes:v1";

/** Imported themes per device. */
export const LIBRARY_MAX = 8;

/** The size cap on an imported file, and on a theme the store re-reads. It lives in `schema.ts`, beside the parser. */
export { THEME_MAX_BYTES };

/** An imported theme: the same shape as any theme, from the library and never from the build. */
export type ImportedTheme = Theme;

export type ThemeSource = "shipped" | "imported";

export interface ActiveTheme {
  id: string;
  theme: Theme;
  source: ThemeSource;
}

// ── The shipped themes ──────────────────────────────────────────────────────────────────────────
//
// Read from `src/themes/*.json` as text and parsed with the same parser an import goes through, so a
// shipped file the schema would refuse fails loudly here too. The glob means a new shipped theme is
// one new file, and `themes.test.ts` checks the file list against `SHIPPED_THEME_IDS`.

const SHIPPED_FILES = import.meta.glob<string>("../../themes/*.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

function loadShipped(): ReadonlyMap<string, Theme> {
  const themes = new Map<string, Theme>();
  for (const [path, raw] of Object.entries(SHIPPED_FILES)) {
    const parsed = parseTheme(raw, { maxBytes: THEME_MAX_BYTES, allowReservedId: true });
    if (!parsed.ok) {
      console.warn(`[theme] the shipped file ${path} is refused: ${parsed.refusals[0]?.detail ?? ""}`);
      continue;
    }
    if (!isShippedThemeId(parsed.theme.id)) {
      console.warn(`[theme] the shipped file ${path} has an id that is not a shipped id`);
      continue;
    }
    themes.set(parsed.theme.id, parsed.theme);
  }
  return themes;
}

const SHIPPED = loadShipped();

function defaultTheme(): Theme {
  const theme = SHIPPED.get(DEFAULT_THEME_ID);
  if (theme === undefined) throw new Error(`the shipped theme ${DEFAULT_THEME_ID} is missing`);
  return theme;
}

/** The shipped themes, in the order of `SHIPPED_THEME_IDS`, that exist as files in this build. */
export function shippedThemes(): Theme[] {
  const found: Theme[] = [];
  for (const id of SHIPPED_THEME_IDS) {
    const theme = SHIPPED.get(id);
    if (theme !== undefined) found.push(theme);
  }
  return found;
}

// ── The library ─────────────────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

interface StoredLibrary {
  themes: readonly ImportedTheme[];
  /** Where each kept theme came from (origin.ts), by id. A theme with no entry reads "Added on this device". */
  origins: ReadonlyMap<string, ThemeOrigin>;
}

const EMPTY_LIBRARY: StoredLibrary = { themes: [], origins: new Map() };

let { themes: imported, origins } = loadLibrary();

function loadLibrary(): StoredLibrary {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    if (raw === null) return EMPTY_LIBRARY;
    return readLibrary(raw);
  } catch {
    return EMPTY_LIBRARY; // private mode / SSR
  }
}

/**
 * The themes of a stored library blob, each one re-validated. One that no longer validates (a
 * future version wrote it, the schema tightened, a person edited the blob) is dropped with a warning
 * and never applied. A repeated id and anything past the cap are dropped the same way.
 *
 * Then the origins beside them, each one checked (origin.ts). An origin that fails, or whose theme is
 * not kept, is dropped; its theme stays. Nothing here throws on a bad blob: boot must not.
 */
function readLibrary(raw: string): StoredLibrary {
  const doc = parseJsonObject(raw);
  const list = doc === undefined ? undefined : doc.themes;
  if (doc === undefined || doc.version !== 1 || !Array.isArray(list)) return EMPTY_LIBRARY;
  const themes: ImportedTheme[] = [];
  for (const entry of list) {
    const parsed = parseTheme(JSON.stringify(entry), { maxBytes: THEME_MAX_BYTES });
    if (!parsed.ok) {
      console.warn(`[theme] a stored theme is dropped: ${parsed.refusals[0]?.detail ?? ""}`);
      continue;
    }
    if (themes.some((t) => t.id === parsed.theme.id) || themes.length >= LIBRARY_MAX) {
      console.warn(`[theme] a stored theme is dropped: "${parsed.theme.id}" is a repeat or past the cap`);
      continue;
    }
    themes.push(parsed.theme);
  }
  const stored = asJsonObject(doc.origins);
  const kept = new Map<string, ThemeOrigin>();
  for (const theme of themes) {
    // `Object.hasOwn`: an id such as `constructor` must never read a prototype's member.
    const origin = stored !== undefined && Object.hasOwn(stored, theme.id) ? readOrigin(stored[theme.id]) : undefined;
    if (origin !== undefined) kept.set(theme.id, origin);
  }
  return { themes, origins: kept };
}

function persistLibrary(): void {
  try {
    if (imported.length === 0) localStorage.removeItem(LIBRARY_STORAGE_KEY);
    else localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(libraryBlob()));
  } catch {
    // Ignore quota / SSR write errors: the in-memory library still works for this session.
  }
}

/** The library as it is written to storage. `origins` is absent while no theme has one. */
interface LibraryBlob {
  version: 1;
  themes: readonly ImportedTheme[];
  origins?: Record<string, ThemeOrigin>;
}

/** The stored blob: the themes, and their origins only when there are any, so a library without one writes what it always wrote. */
function libraryBlob(): LibraryBlob {
  const blob: LibraryBlob = { version: 1, themes: imported };
  if (origins.size > 0) blob.origins = Object.fromEntries(origins);
  return blob;
}

/** The imported themes, in the order they were added. */
export function library(): readonly ImportedTheme[] {
  return imported;
}

/** Where an imported theme came from, or undefined for a shipped theme and one kept before origins. */
export function originOf(id: string): ThemeOrigin | undefined {
  return origins.get(id);
}

function withOrigin(map: ReadonlyMap<string, ThemeOrigin>, id: string, origin: ThemeOrigin | undefined): ReadonlyMap<string, ThemeOrigin> {
  const next = new Map(map);
  if (origin === undefined) next.delete(id);
  else next.set(id, origin);
  return next;
}

export type AddResult = { ok: true } | { ok: false; reason: "full" | "reserved-id" | "duplicate" | "invalid" };

/**
 * Keep an imported theme. The caller has parsed the file already; the theme is parsed once more here
 * because this is the door to storage. `invalid` can only mean a caller skipped `parseTheme`.
 */
export function addImported(theme: Theme, origin?: ThemeOrigin): AddResult {
  if (isShippedThemeId(theme.id)) return { ok: false, reason: "reserved-id" };
  const parsed = parseTheme(JSON.stringify(theme), { maxBytes: THEME_MAX_BYTES });
  if (!parsed.ok) return { ok: false, reason: "invalid" };
  if (imported.some((t) => t.id === parsed.theme.id)) return { ok: false, reason: "duplicate" };
  if (imported.length >= LIBRARY_MAX) return { ok: false, reason: "full" };
  imported = [...imported, parsed.theme];
  origins = withOrigin(origins, parsed.theme.id, origin);
  persistLibrary();
  emit();
  return { ok: true };
}

/**
 * Update: put `theme` in the slot of the imported theme `oldId`, with its new origin. The cap never
 * refuses an update, because the library does not grow. A new id takes the old slot and the active
 * choice follows it; a new id that another kept theme holds is a duplicate, and a shipped id is
 * refused as an import's is. The theme is parsed again here, as `addImported` parses it.
 */
export function replaceImported(oldId: string, theme: Theme, origin: ThemeOrigin): AddResult {
  const slot = imported.findIndex((t) => t.id === oldId);
  if (slot < 0) return { ok: false, reason: "invalid" };
  if (isShippedThemeId(theme.id)) return { ok: false, reason: "reserved-id" };
  const parsed = parseTheme(JSON.stringify(theme), { maxBytes: THEME_MAX_BYTES });
  if (!parsed.ok) return { ok: false, reason: "invalid" };
  const next = parsed.theme;
  if (next.id !== oldId && imported.some((t) => t.id === next.id)) return { ok: false, reason: "duplicate" };
  const wasActive = designPrefs().theme === oldId;
  imported = imported.map((t, i) => (i === slot ? next : t));
  origins = withOrigin(withOrigin(origins, oldId, undefined), next.id, origin);
  persistLibrary();
  // The active choice follows the slot. Applied directly, not through `setActiveTheme`: an update is
  // not a pick, so it leaves the Typeface card alone.
  if (wasActive) {
    setDesignTheme(next.id);
    applyTheme(next, "imported");
  }
  emit();
  return { ok: true };
}

/**
 * Keep a theme and switch to it: the one path an import's Apply and a trial's Keep both take
 * (M59 spec 08), so the cap, the shipped-id rule and the duplicate check cannot differ between them.
 */
export function installTheme(theme: Theme, origin?: ThemeOrigin): AddResult {
  const added = addImported(theme, origin);
  if (added.ok) setActiveTheme(theme.id);
  return added;
}

/**
 * Delete an imported theme. When it is the one on screen, the device goes back to `collie` in the
 * same call. The typeface is left alone: removing a file is not a request to change the face.
 */
export function removeImported(id: string): void {
  if (!imported.some((t) => t.id === id)) return;
  const wasActive = designPrefs().theme === id;
  imported = imported.filter((t) => t.id !== id);
  origins = withOrigin(origins, id, undefined);
  persistLibrary();
  if (wasActive) {
    setDesignTheme(DEFAULT_THEME_ID);
    applyTheme(defaultTheme(), "shipped");
  }
  emit();
}

// ── The active theme ────────────────────────────────────────────────────────────────────────────

/** The id on screen: the stored one when a shipped theme or a library entry has it, else `collie`. */
export function activeThemeId(): string {
  const stored = designPrefs().theme;
  if (stored === undefined) return DEFAULT_THEME_ID;
  if (SHIPPED.has(stored) || imported.some((t) => t.id === stored)) return stored;
  return DEFAULT_THEME_ID;
}

function resolveActive(): ActiveTheme {
  const id = activeThemeId();
  const shipped = SHIPPED.get(id);
  if (shipped !== undefined) return { id, theme: shipped, source: "shipped" };
  const entry = imported.find((t) => t.id === id);
  if (entry !== undefined) return { id, theme: entry, source: "imported" };
  return { id: DEFAULT_THEME_ID, theme: defaultTheme(), source: "shipped" };
}

/**
 * Pick a theme. Writes the id into the design store, applies it, and, when the theme names a
 * bundled face, writes that face into `design.font` once; the Typeface card works as before after.
 * An id that is neither shipped nor in the library does nothing.
 */
export function setActiveTheme(id: string): void {
  const shipped = SHIPPED.get(id);
  const entry = imported.find((t) => t.id === id);
  const theme = shipped ?? entry;
  if (theme === undefined) return;
  setDesignTheme(id);
  applyTheme(theme, shipped === undefined ? "imported" : "shipped");
  const face = theme.fonts?.ui;
  if (face !== undefined && isShippedFont(face)) setDesignFont(face);
  emit();
}

/**
 * Reconcile the page with the stored choice, once, at startup (main.tsx). `public/theme-init.js`
 * has already done the same before first paint; this covers what it deliberately cannot (a missing
 * half of an imported theme, the theme-color metas) and Safari private mode, where it threw.
 */
export function initTheme(): void {
  if (takeThemeEscape()) setDesignTheme(DEFAULT_THEME_ID);
  const active = resolveActive();
  applyTheme(active.theme, active.source);
}

let escaped = false;

/**
 * `#theme=collie` on the address (escape.ts): true once per page when the hash asked for Collie, and
 * the hash is taken off the address so a reload does not ask again. `resumeTrial` reads
 * {@link themeEscaped} to drop a trial on the same page load.
 */
function takeThemeEscape(): boolean {
  if (!hasWindow() || !isThemeEscape(location.hash)) return false;
  escaped = true;
  try {
    history.replaceState(history.state, "", `${location.pathname}${location.search}${withoutThemeEscape(location.hash)}`);
  } catch {
    // A page that refuses replaceState keeps the hash; the next load puts Collie on again, no harm.
  }
  return true;
}

/** True when this page load opened with `#theme=collie`. */
export function themeEscaped(): boolean {
  return escaped;
}

// ── The one place the DOM is touched ────────────────────────────────────────────────────────────

/**
 * Put a theme on <html>.
 *
 *   * `collie`: no attribute and no inline property.
 *   * shipped: `data-theme="<id>"`, the id taken from `SHIPPED_THEME_IDS` and not from the file.
 *   * imported: no attribute, and one inline custom property per token in `THEME_TOKENS`, each
 *     `light-dark(<light>, <dark>)`, a half the theme leaves out filled from `collie`, and the same
 *     for each optional token the theme names (the others set nothing); then the
 *     declarations of each shape word the theme names, its display face and its palette. A part it
 *     leaves out sets nothing, so the stylesheet's default holds.
 *
 * The theme is validated here again, whoever calls and wherever it came from. A theme that does not
 * validate is not applied: the device shows `collie`, and the console says why.
 */
export function applyTheme(theme: Theme, source: ThemeSource): void {
  if (!hasDocument()) return;
  const parsed = parseTheme(JSON.stringify(theme), {
    maxBytes: THEME_MAX_BYTES,
    allowReservedId: source === "shipped",
  });
  if (!parsed.ok || (source === "shipped") !== isShippedThemeId(parsed.theme.id)) {
    console.warn(`[theme] "${theme.id}" is not applied: it does not validate`);
    return reset();
  }
  const root = document.documentElement;
  clearInline(root);
  const checked = parsed.theme;

  if (source === "shipped") {
    const id = SHIPPED_THEME_IDS.find((shipped) => shipped === checked.id);
    if (id === undefined || id === DEFAULT_THEME_ID) delete root.dataset.theme;
    else root.dataset.theme = id;
    setMetaColours(id === undefined || id === DEFAULT_THEME_ID ? undefined : metaOf(checked));
    return;
  }

  delete root.dataset.theme;
  const filled = fillHalves(checked, defaultTheme());
  for (const token of THEME_TOKENS) root.style.setProperty(`--${token}`, lightDark(filled, token));
  // An optional token is set only when the theme names it; otherwise the stylesheet's pair holds.
  for (const token of OPTIONAL_THEME_TOKENS) {
    if (setsOptionalToken(checked, token)) root.style.setProperty(`--${token}`, lightDark(filled, token));
  }
  // The property names come from surface.ts; the file only picked the words, the face and the
  // palette's colours, which the parser has checked.
  for (const [property, value] of versionTwoDeclarations(checked)) root.style.setProperty(property, value);
  // index.css paints Collie's grain on :root, so a theme that names no ground says `flat` itself.
  for (const [property, value] of omittedGroundDeclarations(checked.surface)) root.style.setProperty(property, value);
  setMetaColours(metaOf(checked));
}

/** `collie` on the page: the attribute and every inline token gone, the default metas back. */
function reset(): void {
  const root = document.documentElement;
  delete root.dataset.theme;
  clearInline(root);
  setMetaColours(undefined);
}

function clearInline(root: HTMLElement): void {
  for (const token of ALL_THEME_TOKENS) root.style.removeProperty(`--${token}`);
  for (const property of VERSION_TWO_PROPERTIES) root.style.removeProperty(property);
}

/**
 * The browser-chrome colours of a theme, filled from `collie`, as sRGB hex: the colour of the band the
 * header stands on, so the status bar above it shows no seam. That is `background` under `chrome:
 * page` (the default) and `secondary` under `chrome: band`. A gradient or grain ground starts at
 * `background` at the top edge, so the ground word does not move it.
 */
function metaOf(theme: Theme): MetaColours {
  const filled = fillHalves(theme, defaultTheme());
  const edge = resolveSurface(theme.surface).chrome === "band" ? "secondary" : "background";
  return {
    light: toSrgbHex(filled.light[edge] ?? ""),
    dark: toSrgbHex(filled.dark[edge] ?? ""),
  };
}

// ── React ───────────────────────────────────────────────────────────────────────────────────────

let snapshot: ActiveTheme = resolveActive();

function emit(): void {
  for (const fn of listeners) fn();
}

/** The theme on screen, read once and not reactive: for code that is not a component (the startup preload). */
export function activeTheme(): ActiveTheme {
  return getSnapshot();
}

function getSnapshot(): ActiveTheme {
  const next = resolveActive();
  if (next.id === snapshot.id && next.theme === snapshot.theme && next.source === snapshot.source) {
    return snapshot;
  }
  snapshot = next;
  return snapshot;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const stopDesign = subscribeDesign(fn);
  return () => {
    listeners.delete(fn);
    stopDesign();
  };
}

/** The theme on screen. A new object only when the id, the body or the source changed. */
export function useActiveTheme(): ActiveTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function getLibrary(): readonly ImportedTheme[] {
  return imported;
}

/** The imported themes, reactive. A new array on every add and remove. */
export function useLibrary(): readonly ImportedTheme[] {
  return useSyncExternalStore(subscribe, getLibrary, getLibrary);
}

function getOrigins(): ReadonlyMap<string, ThemeOrigin> {
  return origins;
}

/** Where each imported theme came from, reactive. A new map on every add, update and remove. */
export function useThemeOrigins(): ReadonlyMap<string, ThemeOrigin> {
  return useSyncExternalStore(subscribe, getOrigins, getOrigins);
}

/**
 * Test seam: re-read the library from storage, as if the page had just opened, and re-apply the
 * active theme. After `localStorage.clear()` this lands on an empty library.
 */
export function __resetThemeStore(): void {
  ({ themes: imported, origins } = loadLibrary());
  if (hasDocument()) {
    const active = resolveActive();
    applyTheme(active.theme, active.source);
  }
  emit();
}

// The per-device preferences, as module stores over the SAME localStorage keys and value shapes as
// web/. One phone can run either shell on one origin, so a choice made in one is the choice in the
// other: same key, same JSON, same defaults, same repair rules.
//
// THREE RULES (REMIX3.md, "Where state lives"; "Collie-specific mapping", row 15):
//   1. Load synchronously at module evaluation, before the first render. main.tsx imports this
//      module, so a cold open paints the stored choice and never the default first.
//   2. Write-through: `set` writes storage, then wakes subscribers. A failed write (quota, private
//      mode) keeps the in-memory value for this session, as web/ does.
//   3. A `storage` event from another tab re-reads the key and wakes subscribers, writing nothing back.
//
// Theme and locale already have their stores (`routes/settings/theme.ts`, `lib/i18n-store.ts`) and
// stay there.
//
// web/'s readers are reused where they are pure and exported (`coerceDashPrefs`, `parseDesignPrefs`,
// the json helpers). Where web/ keeps its decoder private (display prefs, pins, hidden machines), the
// decoder is ported here line for line and the round-trip tests pin the shapes.
import { coerceDashPrefs, type DashPrefs } from "@web/hooks/use-dash-prefs";
import type { DisplayPrefs, FontFamily } from "@web/hooks/use-display-prefs";
import { isLegacyDashView } from "@web/lib/dash-view";
import { parseDesignPrefs, type DesignPrefs } from "@web/lib/design";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson, parseJsonObject } from "@web/lib/json";
import type { Pin } from "@web/lib/pins";

import { createStore, type Store } from "./store";

export type { DashPrefs, DesignPrefs, DisplayPrefs, Pin };

export const PREF_KEYS = {
  dash: "collie:dash-prefs:v1",
  display: "collie:display-prefs:v4",
  design: "collie:design:v1",
  haptics: "collie:haptics:v1",
  zen: "collie:zen-enabled:v1",
  stripsCollapsed: "collie:strips-collapsed:v1",
  harnessBar: "collie:harness-bar:v1",
  pins: "collie:pins:v1",
  hiddenMachines: "collie:hidden-machines:v1",
} as const;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked or partitioned storage
  }
}

export interface PrefStore<T> extends Store<T> {
  readonly key: string;
  /** Re-read the key from storage and wake subscribers on a change. Writes nothing. */
  reload(): void;
  /** Take `raw` as if storage held it (a server render, from the prefs cookie). Writes nothing. */
  prime(raw: string | null): void;
}

interface Codec<T> {
  /** `raw` is the stored string, or null when the key is absent. Total: never throws. */
  decode(raw: string | null): T;
  encode(value: T): string;
}

/** What the cross-tab sync needs from each store. */
const registry: Array<Pick<PrefStore<unknown>, "key" | "reload" | "prime" | "subscribe">> = [];

function persisted<T>(key: string, codec: Codec<T>): PrefStore<T> {
  const read = (): T => {
    try {
      return codec.decode(storage()?.getItem(key) ?? null);
    } catch {
      return codec.decode(null);
    }
  };
  // Equal when the stored form is equal: no wake and no write for a value that would save the same.
  const inner = createStore<T>(read(), (a, b) => codec.encode(a) === codec.encode(b));
  const set = (next: T): void => {
    if (codec.encode(next) === codec.encode(inner.get())) return;
    try {
      storage()?.setItem(key, codec.encode(next));
    } catch {
      // Quota or private mode: the in-memory value still applies for this session.
    }
    inner.set(next);
  };
  const store: PrefStore<T> = {
    key,
    get: inner.get,
    set,
    update: (change) => set(change(inner.get())),
    subscribe: inner.subscribe,
    version: inner.version,
    reload: () => inner.set(read()),
    prime: (raw) => inner.set(codec.decode(raw)),
  };
  registry.push(store);
  return store;
}

/** web/'s boolean prefs store "1" or "0"; anything else, or nothing, reads as the default. */
function flag(fallback: boolean): Codec<boolean> {
  return {
    decode: (raw) => (raw === null ? fallback : raw === "1"),
    encode: (on) => (on ? "1" : "0"),
  };
}

// ── collie:dash-prefs:v1 (web/src/hooks/use-dash-prefs.ts) ─────────────────────────────────────────

const dashCodec: Codec<DashPrefs> = {
  decode: (raw) => {
    if (!raw) return coerceDashPrefs(undefined);
    return coerceDashPrefs(parseJson(raw));
  },
  encode: (value) => JSON.stringify(value),
};

export const dashPrefs = persisted(PREF_KEYS.dash, dashCodec);

// web/ writes a retired tab name back migrated, once, on load. Same here, so the two shells agree on
// what is stored after either one opened.
(() => {
  const raw = storage()?.getItem(PREF_KEYS.dash);
  if (!raw) return;
  if (!isLegacyDashView(asJsonObject(parseJson(raw))?.dashView)) return;
  try {
    storage()?.setItem(PREF_KEYS.dash, dashCodec.encode(dashPrefs.get()));
  } catch {
    // ignore
  }
})();

export function setDashPref<K extends keyof DashPrefs>(field: K, value: DashPrefs[K]): void {
  dashPrefs.update((p) => ({ ...p, [field]: value }));
}

// ── collie:display-prefs:v4 (web/src/hooks/use-display-prefs.ts, `loadPrefs`) ─────────────────────

const FONT_FAMILIES: readonly FontFamily[] = ["system", "jetbrains", "cascadia", "menlo", "roboto", "dejavu", "courier"];
const DISPLAY_DEFAULTS: DisplayPrefs = {
  wrap: true,
  fontSize: 10,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
};
const clamp = (lo: number, hi: number) => (n: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const clampFont = clamp(9, 16);
const clampDraftFont = clamp(13, 16);
const clampChatFont = clamp(12, 20);

export function decodeDisplayPrefs(raw: string | null): DisplayPrefs {
  if (!raw) return DISPLAY_DEFAULTS;
  const p = parseJsonObject(raw);
  if (!p) return DISPLAY_DEFAULTS;
  const fontSize = asJsonNumber(p.fontSize);
  const draftFontSize = asJsonNumber(p.draftFontSize);
  const chatFontSize = asJsonNumber(p.chatFontSize);
  const family = asJsonString(p.fontFamily);
  return {
    wrap: asJsonBoolean(p.wrap) ?? DISPLAY_DEFAULTS.wrap,
    fontSize: fontSize === undefined ? DISPLAY_DEFAULTS.fontSize : clampFont(fontSize),
    draftFontSize: draftFontSize === undefined ? DISPLAY_DEFAULTS.draftFontSize : clampDraftFont(draftFontSize),
    chatFontSize: chatFontSize === undefined ? DISPLAY_DEFAULTS.chatFontSize : clampChatFont(chatFontSize),
    fontFamily: FONT_FAMILIES.find((f) => f === family) ?? DISPLAY_DEFAULTS.fontFamily,
    rawTerminal: asJsonBoolean(p.rawTerminal) ?? DISPLAY_DEFAULTS.rawTerminal,
    tapToFocus: asJsonBoolean(p.tapToFocus) ?? DISPLAY_DEFAULTS.tapToFocus,
    expandClippedReply: asJsonBoolean(p.expandClippedReply) ?? DISPLAY_DEFAULTS.expandClippedReply,
  };
}

export const displayPrefs = persisted<DisplayPrefs>(PREF_KEYS.display, {
  decode: decodeDisplayPrefs,
  encode: (value) => JSON.stringify(value),
});

// ── collie:design:v1 (web/src/lib/design.ts) ───────────────────────────────────────────────────────

export const designPrefs = persisted<DesignPrefs>(PREF_KEYS.design, {
  decode: (raw) => parseDesignPrefs(raw ?? ""),
  encode: (value) => JSON.stringify(value),
});

// ── The "1"/"0" flags ──────────────────────────────────────────────────────────────────────────────

/** web/src/lib/haptics.ts: on by default. */
export const haptics = persisted(PREF_KEYS.haptics, flag(true));
/** web/src/lib/zen.ts: opt-in. */
export const zen = persisted(PREF_KEYS.zen, flag(false));
/** web/src/lib/strips-collapsed.ts: the pane strips' fold. */
export const stripsCollapsed = persisted(PREF_KEYS.stripsCollapsed, flag(false));
/** web/src/lib/harness-bar-pref.ts: on by default. */
export const harnessBar = persisted(PREF_KEYS.harnessBar, flag(true));

/**
 * The pane's server frames (S2, routes/pane/frames.ts): on, the open pane's beat reloads two server
 * frames instead of reading `/api/pane/:id` as JSON; off, the shell draws every row itself, as before
 * S2. A device switch, carried to the bridge in the prefs cookie so a server document draws the same
 * mode; `?frames=0` or `?frames=1` on a page load sets it (`applyFramesParam`). The default is the
 * measured verdict (experiments/remix-v3/COMPARE.md, round 8).
 */
export const PANE_FRAMES_DEFAULT = true;
/** This shell's own key: web/ has no frames, so it is not in `PREF_KEYS` (the keys web/ uses). */
export const PANE_FRAMES_KEY = "collie:pane-frames:v1";
export const paneFrames = persisted(PANE_FRAMES_KEY, flag(PANE_FRAMES_DEFAULT));

/**
 * `?frames=0|1` on the page's URL sets the switch: stored in the browser, primed for one render on the
 * server (which has no storage), so both sides draw the same mode for that load.
 */
export function applyFramesParam(url: URL, onServer: boolean): void {
  const asked = url.searchParams.get("frames");
  if (asked !== "0" && asked !== "1") return;
  if (onServer) paneFrames.prime(asked);
  else paneFrames.set(asked === "1");
}

/** Duration of one press tick (web/src/lib/haptics.ts `TICK_MS`). */
const TICK_MS = 10;

/**
 * One haptic tick, if the operator left haptics on and the platform has `vibrate` (Android; iOS has
 * none, and the optional call is the feature test). Fire-and-forget, never throws, never per repeat
 * tick (web/src/lib/haptics.ts).
 */
export function buzz(ms: number = TICK_MS): void {
  if (!haptics.get()) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // a blocked call is not an error
  }
}

// ── collie:pins:v1 (web/src/lib/pins.ts, `decode`) ─────────────────────────────────────────────────

const NO_PINS: readonly Pin[] = [];

export function decodePins(raw: string | null): readonly Pin[] {
  if (raw === null) return NO_PINS;
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return NO_PINS;
  const out: Pin[] = [];
  for (const item of doc) {
    const rec = asJsonObject(item);
    const row = asJsonString(rec?.row);
    const space = asJsonString(rec?.space);
    const at = asJsonNumber(rec?.at);
    if (row === undefined || space === undefined || at === undefined) continue;
    if (out.some((p) => p.row === row && p.space === space)) continue;
    out.push({ row, space, at });
  }
  return out;
}

export const pins = persisted<readonly Pin[]>(PREF_KEYS.pins, {
  decode: decodePins,
  encode: (value) => JSON.stringify(value),
});

// ── collie:hidden-machines:v1 (web/src/lib/hidden-machines.ts, `decode`) ───────────────────────────

const NONE: readonly string[] = [];

export function decodeHiddenMachines(raw: string | null): readonly string[] {
  if (raw === null) return NONE;
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return NONE;
  const out: string[] = [];
  for (const item of doc) {
    const id = asJsonString(item);
    if (id === undefined || id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out.length === 0 ? NONE : out;
}

export const hiddenMachines = persisted<readonly string[]>(PREF_KEYS.hiddenMachines, {
  decode: decodeHiddenMachines,
  encode: (value) => JSON.stringify(value),
});

// ── Cross-tab sync ─────────────────────────────────────────────────────────────────────────────────

let syncing = false;

/** Where `storage` events come from: the window, or a test's fake. Only `key` is read. */
export interface StorageEventSource {
  addEventListener(type: "storage", listener: (event: { readonly key: string | null }) => void): void;
}

/**
 * Re-read a key when another tab writes it (`key === null` is a `localStorage.clear()`). Started once
 * from main.tsx for the page's life; idempotent.
 */
export function startPrefSync(target: StorageEventSource = window): void {
  if (syncing) return;
  syncing = true;
  target.addEventListener("storage", (event) => {
    for (const store of registry) {
      if (event.key === null || event.key === store.key) store.reload();
    }
  });
}

// ── The prefs cookie (S1, the server document) ────────────────────────────────────────────────────

/**
 * The cookie that carries this device's prefs to the bridge, so a server document draws the stored
 * choices and the hydrating tree finds the same markup (no flash of the defaults). It holds the RAW
 * stored strings by key, `{ "collie:dash-prefs:v1": "...", ... }`, URI-encoded; the bridge hands it to
 * {@link primePrefs} untouched, and the same total decoders as storage read it.
 */
export const PREFS_COOKIE = "collie-prefs";

/** Above this many encoded bytes the cookie is not written: a server render then draws the defaults. */
export const PREFS_COOKIE_MAX = 3000;

/** The cookie's value for the stored prefs, or null when it would be too long to send. */
export function prefsCookieValue(read: (key: string) => string | null): string | null {
  const raw: Record<string, string> = {};
  for (const store of registry) {
    const value = read(store.key);
    if (value !== null) raw[store.key] = value;
  }
  const value = encodeURIComponent(JSON.stringify(raw));
  return value.length > PREFS_COOKIE_MAX ? null : value;
}

/**
 * Prime every pref store from the cookie's JSON (already URI-decoded), for one server render. A key
 * that is absent, or not a string, reads as absent: the store takes its default.
 */
export function primePrefs(json: string | null): void {
  const raw = json === null ? undefined : parseJsonObject(json);
  for (const store of registry) {
    const value = raw === undefined ? undefined : asJsonString(raw[store.key]);
    store.prime(value ?? null);
  }
}

let cookieStarted = false;

/**
 * Write the prefs cookie now and after every change of a pref, for the page's life (main.tsx).
 * `path` is the mount, so the cookie goes only to this collie. `SameSite=Strict`: only a navigation
 * from this origin carries it. Never `Secure`, because the tailnet origin can be plain HTTP.
 */
export function startPrefCookie(path: string): void {
  if (cookieStarted) return;
  cookieStarted = true;
  const write = (): void => {
    const value = prefsCookieValue((key) => storage()?.getItem(key) ?? null);
    const attrs = `; Path=${path}; Max-Age=${value === null ? 0 : 31_536_000}; SameSite=Strict`;
    document.cookie = `${PREFS_COOKIE}=${value ?? ""}${attrs}`;
  };
  write();
  for (const store of registry) store.subscribe(write);
}

// THE NEUTRAL KEY SPELLING — Collie's own, owned by the contract, translated by every adapter.
//
// Three multiplexers, three grammars, and no two agree:
//
//   Collie (here)   ctrl+c      shift+Tab      alt+Up      a      Escape
//   Herdr           ctrl+c      shift+tab      alt+Up      a      Escape    (HERDR_API.md § key grammar)
//   tmux            C-c         BTab / S-Tab   M-Up        a      Escape    (probe, M10/04)
//   zellij          "Ctrl c"    "Alt Shift b"  —           a      Esc       (probe, M10/05)
//
// So a key name is a translation, and the contract owns the source language. It looks close to
// Herdr's because Herdr's is the most explicit of the three, and being close is worth a great deal
// to the reference adapter — but it is NOT Herdr's, on three deliberate points:
//
//  1. **The modifier is `meta`, never `cmd`/`super`.** One spelling for the one key; the adapter
//     picks whichever word its multiplexer answers to.
//  2. **The alphabet is closed and complete**, including the paging and edit keys Herdr refuses
//     outright (HERDR_API.md § key grammar: PageUp/PageDown/Home/End/Insert/Delete → `invalid_key`).
//     A key a multiplexer cannot send is declared in its capability declaration's `unsupportedKeys`,
//     not left out of the contract — otherwise the first adapter that CAN send Home would have to
//     widen the contract to say so.
//  3. **Modifier order is canonical** (`ctrl` `alt` `shift` `meta`), so two spellings of one chord
//     compare equal. Without that, an adapter's translation table has to be written per permutation
//     and a test comparing sent keys is a coin toss.
//
// The grammar itself: modifiers joined to the key with `+`, lower-case; the key is either one
// literal character (typed as itself — `a`, `A`, `1`, `+`) or one name from {@link MUX_NAMED_KEYS},
// which are CapitalCase. `ctrl+c`, `shift+Tab`, `ctrl+alt+Delete`, `F7`, `/`.

/** Modifiers, in the order a canonical spelling puts them. */
export const MUX_MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

/** One modifier. */
export type MuxModifier = (typeof MUX_MODIFIERS)[number];

/**
 * Every named key. Closed on purpose: an adapter translating an open set has no way to be total, and
 * a typo in a Keys-tray row would reach a live terminal as a literal string.
 */
export const MUX_NAMED_KEYS = [
  "Up",
  "Down",
  "Left",
  "Right",
  "Tab",
  "Enter",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

/** One named key. */
export type MuxNamedKey = (typeof MUX_NAMED_KEYS)[number];

/**
 * One keystroke, parsed. `key` is a named key or a single character; `modifiers` is canonically
 * ordered and free of duplicates.
 */
export interface MuxKey {
  readonly modifiers: readonly MuxModifier[];
  readonly key: string;
}

const MODIFIER_BY_NAME = new Map<string, MuxModifier>(MUX_MODIFIERS.map((mod) => [mod, mod]));
// Keyed on the lower-cased name so input casing is forgiving while output is not: `escape`,
// `ESCAPE` and `Escape` all parse, and all format back as `Escape`.
const NAMED_BY_LOWER = new Map<string, MuxNamedKey>(MUX_NAMED_KEYS.map((name) => [name.toLowerCase(), name]));

/**
 * Parse a neutral spelling, or `null` when it is not one.
 *
 * `null` rather than a throw because the callers are parse boundaries — an operator's `keys.toml`
 * row and a request body — and both want to reject the row, not crash the read.
 */
export function parseMuxKey(spelling: string): MuxKey | null {
  // A lone character is itself, `+` included — so this must be checked before the split.
  if ([...spelling].length === 1) return { modifiers: [], key: spelling };
  const parts = spelling.split("+");
  // An unmodified named key: `Escape`, `PageDown`, `F7`.
  if (parts.length === 1) {
    const bare = canonicalKeyName(spelling);
    return bare === null ? null : { modifiers: [], key: bare };
  }
  // `ctrl++` splits to ["ctrl", "", ""] — the trailing empty pair IS the `+` key.
  const plusKey = parts.at(-1) === "" && parts.at(-2) === "";
  const tail = plusKey ? "+" : parts.at(-1);
  const head = plusKey ? parts.slice(0, -2) : parts.slice(0, -1);
  if (tail === undefined || tail === "" || head.length === 0) return null;
  const key = canonicalKeyName(tail);
  if (key === null) return null;
  const seen = new Set<MuxModifier>();
  for (const part of head) {
    const mod = MODIFIER_BY_NAME.get(part.toLowerCase());
    if (mod === undefined || seen.has(mod)) return null;
    seen.add(mod);
  }
  return { modifiers: MUX_MODIFIERS.filter((mod) => seen.has(mod)), key };
}

/** The canonical spelling of a key name or single character, or `null` if it is neither. */
function canonicalKeyName(raw: string): string | null {
  if ([...raw].length === 1) return raw;
  return NAMED_BY_LOWER.get(raw.toLowerCase()) ?? null;
}

/** The canonical spelling of a parsed key. `parse ∘ format` is the identity on every valid key. */
export function formatMuxKey(key: MuxKey): string {
  return [...key.modifiers, key.key].join("+");
}

/**
 * Canonicalise a spelling, or `null` when it is not a valid one.
 *
 * This is what an operator-supplied row and a request body go through before anything compares,
 * stores or translates them — two spellings of one chord must never survive as two strings.
 */
export function canonicalMuxKey(spelling: string): string | null {
  const parsed = parseMuxKey(spelling);
  return parsed === null ? null : formatMuxKey(parsed);
}

/** Whether `spelling` is a valid neutral key. */
export function isMuxKey(spelling: string): boolean {
  return parseMuxKey(spelling) !== null;
}

// Neutral key spelling → Herdr's `pane.send_keys` grammar.
//
// The two grammars are close by design (bridge/mux/keys.ts says why), so this is a small
// translation and not a table. Three differences, and they are the whole file:
//
//  1. **`meta` is Herdr's `cmd`.** The contract has ONE word for the key; Herdr answers to `cmd` and
//     `super` (HERDR_API.md § key grammar). `cmd` is emitted, and both are ACCEPTED on input — a
//     `keys.toml` row written before this seam existed spells the modifier Herdr's way, and
//     `operator-keys.ts` still normalises to that spelling, so refusing it here would take an
//     operator's working preset away for no gain.
//  2. **Six named keys Herdr refuses outright** — the paging and edit block. They are in the
//     contract's alphabet because another multiplexer can send them; here they are declared in
//     `unsupportedKeys` so the Keys tray can grey exactly those instead of discovering them by
//     failing.
//  3. **Case.** Herdr matches modifiers and named keys case-insensitively, so the canonical neutral
//     spelling (`shift+Tab`, `alt+Up`) goes on the wire unchanged. A single literal character keeps
//     its case — that IS the character typed.

import { MUX_NAMED_KEYS, parseMuxKey, type MuxNamedKey } from "../keys.ts";

/**
 * The named keys `pane.send_keys` answers `invalid_key` to, in any spelling and with any modifier
 * (HERDR_API.md § key grammar, empirically enumerated). There is no forward-delete and no
 * scrollback paging by key — the web mirror scrolls instead.
 */
export const HERDR_UNSENDABLE_KEYS: readonly MuxNamedKey[] = [
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Insert",
  "Delete",
];

const UNSENDABLE = new Set<string>(HERDR_UNSENDABLE_KEYS);

// A compile-time tie between the list above and the contract's alphabet: a named key renamed in
// keys.ts stops being assignable here, rather than silently dropping out of the refusal set.
const _EVERY_UNSENDABLE_IS_A_NAMED_KEY: readonly (typeof MUX_NAMED_KEYS)[number][] = HERDR_UNSENDABLE_KEYS;
void _EVERY_UNSENDABLE_IS_A_NAMED_KEY;

/** Modifier spellings Herdr uses for the contract's `meta`. Accepted on input, never emitted. */
const META_ALIASES = new Set(["cmd", "super"]);

/**
 * Rewrite `cmd`/`super` in a chord's modifier head to the contract's `meta`, leaving the base key
 * alone — so `cmd+k` parses as the neutral chord it means rather than as nothing at all.
 *
 * The base is the last `+`-separated segment, except for the `+` key itself, which splits to two
 * trailing empties (`ctrl++` → `["ctrl","",""]`) exactly as {@link parseMuxKey} reads it.
 */
function withNeutralModifiers(spelling: string): string {
  const parts = spelling.split("+");
  if (parts.length < 2) return spelling;
  const plusKey = parts.at(-1) === "" && parts.at(-2) === "";
  const headLength = plusKey ? parts.length - 2 : parts.length - 1;
  const head = parts
    .slice(0, headLength)
    .map((part) => (META_ALIASES.has(part.toLowerCase()) ? "meta" : part));
  return [...head, ...parts.slice(headLength)].join("+");
}

/** Why a key never reached the socket, in the words the refusal detail prints. */
export type HerdrKeyRejection = "unparsed" | "unsendable";

/** A translated chord, or the reason Herdr will not be asked for it. */
export type HerdrKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: HerdrKeyRejection };

/**
 * One neutral chord in Herdr's spelling.
 *
 * Rejected here rather than on the wire: a chord Herdr cannot express is a `refused` outcome the
 * route can explain, where the socket would answer `invalid_key` after the connection was already
 * open. Nothing is sent for a batch containing one of these — see the adapter's `sendKeys`.
 */
export function toHerdrKey(spelling: string): HerdrKeyResult {
  const parsed = parseMuxKey(withNeutralModifiers(spelling));
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (UNSENDABLE.has(parsed.key)) return { ok: false, reason: "unsendable" };
  const modifiers = parsed.modifiers.map((modifier) => (modifier === "meta" ? "cmd" : modifier));
  return { ok: true, key: [...modifiers, parsed.key].join("+") };
}

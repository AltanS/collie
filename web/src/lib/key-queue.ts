// Pure model for the nav-tray key queue: compose a one-shot modifier onto a base key, label a key
// for a chip, flag danger keys, and normalise the one-char key input. No React, no I/O — every
// string this produces is what goes on the wire to Herdr's `pane.send_keys` (see HERDR_API.md).

// The two Herdr-verified modifiers Collie surfaces. The grammar also allows `alt`/`cmd`/`super`, and
// multi-modifier chords like `ctrl+shift+x` exist in principle — but multi-mod is UNVERIFIED against
// Herdr, so compose stays single-mod for now. `Modifier | null` (rather than a bare `Modifier`)
// leaves room to widen to a modifier list later without churning every caller.
export type Modifier = "ctrl" | "shift";

// Join a one-shot modifier onto a base key. Casing is deliberate: the base passes through VERBATIM —
// `("shift","Tab") → "shift+Tab"`, `("ctrl","g") → "ctrl+g"` — because those are the exact strings
// the tray has always sent and Herdr verified (keys are case-insensitive on the wire, so we don't
// rewrite what already works). A base that already carries a "+" is a preset chord (`ctrl+c`,
// `shift+tab`) and passes through untouched, so we never stack a second modifier (no `shift+ctrl+c`).
// A null modifier returns the base unchanged.
export function composeKey(mod: Modifier | null, base: string): string {
  if (base.includes("+")) return base;
  if (mod === null) return base;
  return `${mod}+${base}`;
}

// Friendly display for a base token: special keys get short/glyph labels, a lone printable char is
// upper-cased, everything else is returned as-is (Tab, Up, Space, …).
function baseLabel(base: string): string {
  const lower = base.toLowerCase();
  if (lower === "escape") return "Esc";
  if (lower === "enter") return "⏎";
  if (base.length === 1) return base.toUpperCase();
  return base;
}

// Human chip label for a full key token: `"ctrl+g" → "Ctrl G"`, `"shift+Tab" → "⇧ Tab"`,
// `"Escape" → "Esc"`, `"Enter" → "⏎"`, `"g" → "G"`. Total — an unknown token falls back to itself.
export function keyLabel(key: string): string {
  const plus = key.indexOf("+");
  if (plus === -1) return baseLabel(key);
  const mod = key.slice(0, plus).toLowerCase();
  const base = key.slice(plus + 1);
  const modLabel = mod === "shift" ? "⇧" : mod === "ctrl" ? "Ctrl" : mod;
  return `${modLabel} ${baseLabel(base)}`;
}

// The chords that interrupt / suspend / kill a running agent. NOTE: ctrl+c counts as danger HERE —
// on the queued review-then-send path the Send button warns (destructive styling) for any of these.
// This is intentionally broader than the nav-tray's *immediate* preset list, which two-tap-confirms
// only ctrl+d / ctrl+z: for a preset, the two-tap IS the guard; for a queued chord, the visible Send
// review is the guard, and c/d/z all deserve the destructive cue.
const DANGER_KEYS = new Set(["ctrl+c", "ctrl+d", "ctrl+z"]);

export function isDangerKey(key: string): boolean {
  return DANGER_KEYS.has(key.toLowerCase());
}

// Normalise the one-char key input into a single base char. Takes the LAST char of the raw input
// (so a paste or a fast burst still yields one key), lower-cases it, and only accepts a printable
// non-space ASCII char (0x21–0x7e). Anything else (empty, whitespace, control, non-ASCII) → null.
export function normalizeBaseChar(raw: string): string | null {
  if (raw.length === 0) return null;
  const ch = raw[raw.length - 1];
  const code = ch.charCodeAt(0);
  if (code < 0x21 || code > 0x7e) return null;
  return ch.toLowerCase();
}

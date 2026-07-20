// Pure model for the nav-tray key queue: compose a set of modifiers onto a base key, label a key
// for a chip, flag danger keys, cycle a modifier's three-state mode, and normalise the one-char key
// input. No React, no I/O — every string this produces is what goes on the wire to Herdr's
// `pane.send_keys` (see HERDR_API.md).

// The modifiers Collie surfaces in the tray. Multi-modifier chords in ANY order — `ctrl+shift+p`,
// the triple `ctrl+alt+shift+p`, `alt+Up` — are now LIVE-VERIFIED against Herdr (0.7.3 sandbox +
// 0.7.4 by the issue reporter), so compose freely combines them. The wire grammar also accepts
// `cmd`/`super`, which we don't surface here (keyLabel still labels them if they ever appear).
export type Modifier = "ctrl" | "alt" | "shift";

// Canonical compose order. The wire accepts modifiers in any order, but we pick ONE so display is
// stable and dedupe is trivial (filtering MODIFIER_ORDER by membership both orders and de-dupes).
export const MODIFIER_ORDER: readonly Modifier[] = ["ctrl", "alt", "shift"];

// A modifier's arm state in the tray. Tapping cycles off → once → locked → off: `once` is the
// classic one-shot (consumed by the next staged key), `locked` stays armed across presses and Sends
// until you cycle it back off or Clear the queue.
export type ModMode = "off" | "once" | "locked";

// The pure three-state cycle a tap advances a modifier through. Lives here (not in the hook) so it's
// unit-testable without React.
export function nextModMode(m: ModMode): ModMode {
  if (m === "off") return "once";
  if (m === "once") return "locked";
  return "off";
}

// Join a set of modifiers onto a base key. Casing is deliberate: the base passes through VERBATIM —
// `(["shift"],"Tab") → "shift+Tab"`, `(["ctrl"],"g") → "ctrl+g"` — because those are the exact
// strings the tray has always sent and Herdr verified (keys are case-insensitive on the wire, so we
// don't rewrite what already works). Modifiers are ordered + de-duped by MODIFIER_ORDER so the wire
// string is stable regardless of tap order. A base that already carries a "+" is a preset chord
// (`ctrl+c`, `shift+tab`) and passes through untouched, so we never stack modifiers onto a preset.
// Empty modifiers returns the base unchanged.
export function composeKey(mods: readonly Modifier[], base: string): string {
  if (base.includes("+")) return base;
  if (mods.length === 0) return base;
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  return `${ordered.join("+")}+${base}`;
}

// Display label for a single surfaced modifier: `ctrl → "Ctrl"`, `alt → "Alt"`, `shift → "⇧"`.
// Shared by keyLabel and the strip's ghost chip so the mapping lives in one place.
export function modifierLabel(m: Modifier): string {
  if (m === "ctrl") return "Ctrl";
  if (m === "alt") return "Alt";
  return "⇧"; // shift
}

// Label a leading modifier TOKEN off the wire, or null if the token isn't a modifier. Broader than
// modifierLabel: also covers the `cmd`/`super` the grammar allows but we don't surface, so a chord
// that arrives with them still reads nicely.
function leadingModLabel(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower === "ctrl" || lower === "alt" || lower === "shift") return modifierLabel(lower);
  if (lower === "cmd") return "Cmd";
  if (lower === "super") return "Super";
  return null;
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

// Human chip label for a full key token: `"ctrl+g" → "Ctrl G"`, `"ctrl+shift+p" → "Ctrl ⇧ P"`,
// `"shift+Tab" → "⇧ Tab"`, `"Escape" → "Esc"`, `"g" → "G"`. Consumes LEADING modifier tokens (in
// order) and runs the remainder through baseLabel. Total — `"+"` has no leading modifier so it falls
// straight through to baseLabel ("+"), and an unknown token falls back to itself.
export function keyLabel(key: string): string {
  const tokens = key.split("+");
  const labels: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const ml = leadingModLabel(tokens[i]);
    if (ml === null) break;
    labels.push(ml);
    i++;
  }
  const rest = tokens.slice(i).join("+");
  if (rest.length > 0 || labels.length === 0) labels.push(baseLabel(rest));
  return labels.join(" ");
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

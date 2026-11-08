// The glyphs omp draws for its keycaps and its pointer, per symbol preset (`symbolPreset` in omp's
// settings: `unicode`, the default, `nerd` or `ascii`). omp builds every footer of its dialogs from
// these (`jb.unicode` / `jb.nerd` in omp's bundle, `key.enter`, `key.esc`, `key.tab`), and every list
// draws `nav.cursor` in front of the pointed row. So a reader that matches a footer exactly matches it
// once per preset, with that preset's glyphs in BOTH the footer and the pointer column: a pair from two
// presets is a screen omp never draws.
//
// Read off omp 18.18.0 captures with `symbolPreset: nerd` (`omp--v18-18-0-nerd-*`, 2026-11-08) and the
// same screens under `unicode`. The arrows (`↑/↓`, `←/→`) are the same in both presets. The `ascii`
// preset draws no box omp's modal check knows (`Esc`, `Enter` and `|` frames), so no reader lists it.
//
// Pure data. omp only: no shared reader imports this file.

export interface OmpGlyphPreset {
  /** The preset's name in omp's settings. */
  readonly name: "unicode" | "nerd";
  /** `key.enter`. */
  readonly enter: string;
  /** `key.esc`. */
  readonly escape: string;
  /** `key.tab`. */
  readonly tab: string;
  /** `nav.cursor`, in front of the pointed row of a list. */
  readonly pointer: string;
  /** `radio.unselected`, in front of every option of a single-select question. */
  readonly radio: string;
  /** `radio.selected`, in front of the answer a revisited question already holds. */
  readonly radioSelected: string;
  /** `sep.powerlineRight` and `sep.powerlineLeft`: the plan review's model slider wraps its active tier
   *  in them, opening then closing. */
  readonly activeOpen: string;
  readonly activeClose: string;
}

/** omp's default preset. */
export const OMP_UNICODE: OmpGlyphPreset = {
  name: "unicode",
  enter: "⏎",
  escape: "⎋",
  tab: "⇥",
  pointer: "❯",
  radio: "○",
  radioSelected: "◉",
  activeOpen: "◀",
  activeClose: "▶",
};

/** omp's Nerd Font preset: private-use glyphs. U+F0311 (nf-md-keyboard_return), U+F12B7
 *  (nf-md-keyboard_esc), U+F0312 (nf-md-keyboard_tab), U+F054 (nf-fa-chevron_right), U+F10C
 *  (nf-fa-circle_o), U+F192 (nf-fa-dot_circle_o), and the powerline arrows U+E0B2 and U+E0B0. */
export const OMP_NERD: OmpGlyphPreset = {
  name: "nerd",
  enter: "\u{F0311}",
  escape: "\u{F12B7}",
  tab: "\u{F0312}",
  pointer: "\u{F054}",
  radio: "\u{F10C}",
  radioSelected: "\u{F192}",
  activeOpen: "\u{E0B2}",
  activeClose: "\u{E0B0}",
};

/** The glyph presets, default first. */
export const OMP_GLYPH_PRESETS: readonly OmpGlyphPreset[] = [OMP_UNICODE, OMP_NERD];

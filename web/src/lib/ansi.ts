// Minimal, safe ANSI SGR parser. Herdr's `pane.read(format:"ansi")` emits ONLY SGR color/style
// sequences (verified against a live pane — no cursor moves, no OSC), so we don't need a terminal
// emulator, just SGR. Every run of text is returned as a plain string; the renderer puts it in a
// React text node (never innerHTML), so this adds no XSS surface — we only derive colors/weights.
// Any non-SGR escape sequence is defensively skipped.

import type { CSSProperties } from "react";

export interface AnsiSegment {
  text: string;
  // Raw SGR fields — preserved for testing/inspection and external consumers.
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  // Pre-computed presentation — consumed by AnsiOutput to avoid per-render allocation.
  style: CSSProperties;
  /** True when the segment contains only box-drawing/rule glyphs; the renderer mutes it. */
  muted: boolean;
}

// 16-color palette (VS Code integrated-terminal dark) — readable on our dark background.
const BASE16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function color256(n: number): string {
  if (n < 16) return BASE16[n] ?? "#ffffff";
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

interface State {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

function applySgr(state: State, codes: number[]): void {
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) {
      state.fg = state.bg = undefined;
      state.bold = state.dim = state.italic = state.underline = state.strike = state.inverse = false;
    } else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 7) state.inverse = true;
    else if (c === 9) state.strike = true;
    else if (c === 22) state.bold = state.dim = false;
    else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c === 27) state.inverse = false;
    else if (c === 29) state.strike = false;
    else if (c >= 30 && c <= 37) state.fg = BASE16[c - 30];
    else if (c === 39) state.fg = undefined;
    else if (c >= 40 && c <= 47) state.bg = BASE16[c - 40];
    else if (c === 49) state.bg = undefined;
    else if (c >= 90 && c <= 97) state.fg = BASE16[8 + c - 90];
    else if (c >= 100 && c <= 107) state.bg = BASE16[8 + c - 100];
    else if (c === 38 || c === 48) {
      const isFg = c === 38;
      const mode = codes[i + 1];
      if (mode === 5) {
        const col = color256(codes[i + 2] ?? 0);
        if (isFg) state.fg = col;
        else state.bg = col;
        i += 2;
      } else if (mode === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (isFg) state.fg = col;
        else state.bg = col;
        i += 4;
      }
    }
  }
}

// A segment that's nothing but box-drawing / horizontal-rule glyphs (ignoring spaces) — i.e. a TUI
// border or separator, not real content. Conservative on purpose: only Unicode box-drawing and
// dashes count (not ASCII `-`/`=`), so code and markdown rules in real output stay untouched.
const RULE_GLYPHS = /^[─-╿‒-―]+$/;
function checkMuted(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 2 && RULE_GLYPHS.test(compact);
}

/** Build a CSSProperties object from SGR state and the effective (inverse-resolved) fg/bg. */
function buildStyle(state: State, fg: string | undefined, bg: string | undefined): CSSProperties {
  const st: CSSProperties = {};
  if (fg) st.color = fg;
  if (bg) st.backgroundColor = bg;
  if (state.bold) st.fontWeight = 600;
  if (state.italic) st.fontStyle = "italic";
  if (state.dim) st.opacity = 0.6;
  const deco = [state.underline ? "underline" : "", state.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (deco) st.textDecoration = deco;
  return st;
}

/**
 * Parse an ANSI-SGR string into styled segments.
 *
 * CR (`\r`) semantics: **last-write-wins per line** — when a `\r` is encountered, all segments
 * accumulated since the start of the current line are discarded and the buffer is reset to column 0.
 * The SGR state is intentionally preserved (a real terminal keeps its colour context across CR).
 * This turns progress-bar / spinner output (which redraws via `\r`) into its final frame only.
 *
 * CSI scanning: the parameter field now accepts `:` (sub-parameter separator per ISO 8613-6),
 * and private-marker bytes (`<`, `=`, `>`, `?`) are recognised so DEC-private sequences are
 * consumed in full and never leak text. Colon-delimited truecolor (`38:2:r:g:b`, `38:5:n`, and
 * the ISO `38:2::r:g:b` form with an empty colorspace field) is treated identically to the
 * common semicolon forms.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segs: AnsiSegment[] = [];
  const state: State = {};
  let buf = "";
  // Index into segs where the current visual line starts; used for \r overwrite.
  let lineSegStart = 0;

  const flush = () => {
    if (!buf) return;
    const fg = state.inverse ? (state.bg ?? "var(--background)") : state.fg;
    const bg = state.inverse ? (state.fg ?? "var(--foreground)") : state.bg;
    segs.push({
      text: buf,
      fg,
      bg,
      bold: state.bold,
      dim: state.dim,
      italic: state.italic,
      underline: state.underline,
      strike: state.strike,
      style: buildStyle(state, fg, bg),
      muted: checkMuted(buf),
    });
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch === "\r") {
      // A CR immediately followed by LF (CRLF line ending) or the end of input is just a line
      // terminator — it overwrites nothing, so leave the line's content alone. Herdr's pane buffer
      // is CRLF, so treating every CR as an overwrite would wipe every line to blank (the empty
      // mirror bug). Only a CR with more text after it on the same line is a real carriage-return
      // redraw (progress bars / spinners): overwrite from column 0 (last-write-wins) by flushing
      // the current run and dropping every segment added since this line began. SGR state is kept.
      const next = input[i + 1];
      if (next === undefined || next === "\n") continue;
      flush();
      segs.splice(lineSegStart);
      buf = "";
      continue;
    }

    if (ch === "\n") {
      // LF: a real newline. Commit the current run (including the \n) then advance line tracking
      // so a subsequent \r cannot roll back past this line boundary.
      buf += "\n";
      flush();
      lineSegStart = segs.length;
      continue;
    }

    if (ch === "\x1b") {
      const next = input[i + 1];
      if (next === "[") {
        // CSI sequence: ESC [ [private]* [params]* [intermediates]* <final>
        //
        // Phase 1 — private-indicator bytes (0x3C–0x3F: < = > ?).
        //   Their presence means the sequence is a private command; if the final byte happens to
        //   be 'm' we must NOT treat it as SGR.
        // Phase 2 — parameter bytes (0x30–0x3B plus ':' 0x3A): digits, ';', ':'.
        // Phase 3 — intermediate bytes (0x20–0x2F).
        // Final byte (0x40–0x7E) determines the command.
        let j = i + 2;
        let hasPrivate = false;
        while (j < input.length && /[<=>?]/.test(input[j]!)) {
          hasPrivate = true;
          j++;
        }
        while (j < input.length && /[0-9;:]/.test(input[j]!)) j++;
        while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        const final = input[j];
        if (final === "m" && !hasPrivate) {
          flush();
          const raw = input.slice(i + 2, j);
          // Split by both ';' (common form) and ':' (ISO sub-parameter separator).
          // Filter empty strings to absorb the empty colorspace field in 38:2::r:g:b.
          const codes = raw
            .split(/[;:]/)
            .filter((s) => s !== "")
            .map((p) => Number.parseInt(p, 10) || 0);
          // Empty params (ESC[m) → treat as full reset (code 0).
          applySgr(state, codes.length ? codes : [0]);
        }
        i = j; // for-loop ++ will move past the final byte
        continue;
      }
      if (next === "]") {
        // OSC: ESC ] ... (BEL or ST) — skip entirely
        let j = i + 2;
        while (
          j < input.length &&
          input[j] !== "\x07" &&
          !(input[j] === "\x1b" && input[j + 1] === "\\")
        )
          j++;
        if (input[j] === "\x1b") j++;
        i = j;
        continue;
      }
      i += 1; // unknown ESC + one char — skip
      continue;
    }

    buf += ch;
  }
  flush();
  return segs;
}

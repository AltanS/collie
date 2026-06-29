// Minimal, safe ANSI SGR parser. Herdr's `pane.read(format:"ansi")` emits ONLY SGR color/style
// sequences (verified against a live pane — no cursor moves, no OSC), so we don't need a terminal
// emulator, just SGR. Every run of text is returned as a plain string; the renderer puts it in a
// React text node (never innerHTML), so this adds no XSS surface — we only derive colors/weights.
// Any non-SGR escape sequence is defensively skipped.

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
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

export function parseAnsi(input: string): AnsiSegment[] {
  const segs: AnsiSegment[] = [];
  const state: State = {};
  let buf = "";

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
    });
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\x1b") {
      const next = input[i + 1];
      if (next === "[") {
        // CSI: ESC [ params <final>
        let j = i + 2;
        while (j < input.length && /[0-9;?]/.test(input[j]!)) j++;
        const final = input[j];
        if (final === "m") {
          flush();
          const params = input.slice(i + 2, j);
          applySgr(state, params.split(";").map((p) => (p === "" ? 0 : Number.parseInt(p, 10))));
        }
        i = j; // skip through final (for-loop ++ moves past it)
        continue;
      }
      if (next === "]") {
        // OSC: ESC ] ... (BEL or ST) — skip entirely
        let j = i + 2;
        while (j < input.length && input[j] !== "\x07" && !(input[j] === "\x1b" && input[j + 1] === "\\")) j++;
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

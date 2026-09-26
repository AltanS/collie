// The canary's own Herdr client: the terminal a person would be looking through.
//
// A headless Herdr session answers no colour query. Codex 0.156.1 asks for the terminal's
// background at start, and without an answer it paints its composer with no background and its
// status separators with no colour: a screen no person sees, because a person's terminal always
// answers (measured 2026-09-26, README: "Why the canary attaches a client"). Herdr answers a pane's
// query from what its attached client reported, so the canary attaches one client of its own, in a
// PTY this process hosts, and answers that client's colour queries with a fixed dark palette. The
// client views the placeholder workspace the session starts with, never an agent pane, and nothing
// is ever typed into it except those answers.

import type { Subprocess } from "bun";

/** Client terminal size. Herdr sizes the panes it creates from it: 147 x 41 minus the sidebar and
 *  the status row gives 120 x 40 panes, the size the hand runs of 2026-09-26 used. */
export const CLIENT_COLS = 147;
export const CLIENT_ROWS = 41;

const FG = [0xcd, 0xd6, 0xf4] as const;
const BG = [0x1e, 0x1e, 0x2e] as const;

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function cubeLevel(n: number): number {
  return n === 0 ? 0 : 55 + n * 40;
}

function hex16(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(2);
}

/** xterm's 16 base colours, then the 6x6x6 cube, then the grey ramp. */
function paletteColor(index: number): readonly [number, number, number] {
  const base: readonly (readonly [number, number, number])[] = [
    [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
    [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];
  if (index < 16) return base[index]!;
  if (index < 232) {
    const i = index - 16;
    return [cubeLevel(Math.floor(i / 36)), cubeLevel(Math.floor(i / 6) % 6), cubeLevel(i % 6)];
  }
  const grey = 8 + (index - 232) * 10;
  return [grey, grey, grey];
}

function rgb(c: readonly [number, number, number]): string {
  return `rgb:${hex16(c[0])}/${hex16(c[1])}/${hex16(c[2])}`;
}

/** OSC 10 (foreground), 11 (background) and 4;n (palette) queries, with their terminator. */
const QUERY = new RegExp(`${ESC}\\]((?:10|11)|4;(\\d{1,3}));\\?(${BEL}|${ESC}\\\\)`, "g");

/** The answers to every colour query in `chunk`, in order. Pure, so it is unit-tested. */
export function colorAnswers(chunk: string): string[] {
  const out: string[] = [];
  for (const m of chunk.matchAll(QUERY)) {
    const [, code, index, end] = m;
    const color = code === "10" ? FG : code === "11" ? BG : paletteColor(Math.min(255, Number(index)));
    out.push(`${ESC}]${code};${rgb(color)}${end}`);
  }
  return out;
}

/** The start of an escape sequence at the end of `text` that has not ended yet, or "". */
export function unfinishedTail(text: string): string {
  const at = text.lastIndexOf(ESC);
  if (at < 0 || text.length - at >= 16) return "";
  const tail = text.slice(at);
  if (tail.startsWith(`${ESC}\\`) || tail.includes(BEL)) return "";
  return tail;
}

export interface CanaryClient {
  /** Whether the client has asked for colours and been answered at least once. */
  answered(): boolean;
  close(): void;
}

/** Attach the client to `session`. `env` is the canary's cleaned environment. */
export function attachClient(session: string, env: Record<string, string>): CanaryClient {
  let carry = "";
  let answered = 0;
  const decoder = new TextDecoder();
  const proc: Subprocess = Bun.spawn(["herdr", "session", "attach", session], {
    env: { ...env, TERM: "xterm-256color", HERDR_DISABLE_SOUND: "1" },
    terminal: {
      cols: CLIENT_COLS,
      rows: CLIENT_ROWS,
      data(terminal, data) {
        // A query can straddle two reads; keep a short tail so it is still seen whole.
        const text = carry + decoder.decode(data, { stream: true });
        const answers = colorAnswers(text);
        for (const answer of answers) terminal.write(answer);
        answered += answers.length;
        carry = unfinishedTail(text);
      },
    },
  });
  return {
    answered: () => answered > 0,
    close() {
      proc.kill();
    },
  };
}

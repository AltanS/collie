// The pane frames' fragments (S2, routes/pane/frames.ts says what they are), drawn on Bun from one pane
// read. The bridge's frame route answers with them (bridge/http/controllers/frames.ts), and the server
// document draws the same nodes inline (ssr/render.tsx), so a document and a reload carry the same rows.
//
// PURE. Every input is an argument: the read's text and unwrapped text, and the agent whose adapter
// parses the screen (the frame src carries it). No store is read or written, so a fragment needs no
// priming and leaks nothing between requests; `frames.test.tsx` renders two reads back to back and
// interleaved to prove it. The rows are the browser's own, through the same parse (routes/pane/parse.ts),
// the same row model (screen/rows.ts) and the same autolinks (screen/decorate.ts, web's `findLinks`);
// find marks never come from here (find is the browser's, and the mirror leaves the frame while it is
// open, routes/pane/terminal.tsx). For the same reason the native-mirror bit (ADR 0047) is not in the
// src: in a row it only picks the find marks' colours, and the `<pre>` around the frame is the browser's.
//
// THE TAIL. Every row carries `data-rmx-key`: a content key (screen/rows.ts), except the last
// FRAME_TAIL_ROWS rows, whose key is their place from the bottom (`tail-0` is the last row). The
// runtime's HTML diff (diff-dom.ts `diffSiblingUnits`) matches keys, places the rows from the end,
// and removes what is left over only after placing: a row that changed IN THE MIDDLE leaves its old
// node in place while the rows above it are placed, so every one of them is moved (measured: 922
// mutation records in 30 s for one changed last line). A working agent changes the bottom of its
// screen (the spinner line, the input box, the footer) and appends above it, so the bottom rows keep
// a place key and are diffed in place (their text only), while the rows above keep content keys, so
// a scroll is one row in and one row out. A row that changes above the tail still moves the rows above
// it; that is the runtime's diff, noted in REMIX3.md "Frames".
import type { RemixNode } from "remix/component";
import { renderToString } from "remix/component/server";

import { findLinks } from "@web/lib/links";

import type { PaneReadLite } from "../lib/pane-read";
import { SCREEN_FRAME, STATUS_FRAME, type PaneFrameName, type ReplyProbe } from "../routes/pane/frames";
import { parseScreen } from "../routes/pane/parse";
import { screenOfText } from "../routes/pane/screen-model";
import { StatusRows } from "../routes/pane/statusline";
import { decorateRows, haystackOf } from "../screen/decorate";
import { toRows } from "../screen/rows";
import { ScreenRows } from "../screen/screen";

/** The bottom rows keyed by place, not content (see THE TAIL). */
export const FRAME_TAIL_ROWS = 8;

/** The rows with the tail's place keys (see THE TAIL). */
function withTailKeys<T extends { key: string }>(rows: readonly T[]): T[] {
  const from = Math.max(0, rows.length - FRAME_TAIL_ROWS);
  return rows.map((row, i) => (i < from ? row : { ...row, key: `tail-${String(rows.length - 1 - i)}` }));
}

export interface PaneFramesInput {
  /** The pane read's ANSI text. */
  text: string;
  /** The read's unwrapped text, when the bridge read one (a URL the column edge cut). */
  logicalText?: string;
  /** The agent whose adapter parses the screen; undefined for none (raw terminal, a bare shell). */
  agent: string | undefined;
}

/** The node each pane frame draws. */
export interface PaneFrameNodes {
  "pane-screen": RemixNode;
  "pane-status": RemixNode;
}

/** The node each frame draws for `input`. */
export function paneFrameNodes(input: PaneFramesInput): PaneFrameNodes {
  const parse = parseScreen(input.text, input.agent);
  const lines = parse.mirror;
  const hay = haystackOf(lines);
  const drawn = decorateRows(toRows(lines), lines, hay.starts, [], -1, findLinks(hay.text, input.logicalText));
  return {
    [SCREEN_FRAME]: <ScreenRows rows={withTailKeys(drawn)} />,
    [STATUS_FRAME]: <StatusRows rows={parse.statusLines} />,
  };
}

/** The HTML of each asked frame for `input`. */
export async function renderPaneFrames(input: PaneFramesInput, targets: readonly PaneFrameName[]): Promise<Partial<Record<PaneFrameName, string>>> {
  const nodes = paneFrameNodes(input);
  const out: Partial<Record<PaneFrameName, string>> = {};
  for (const name of targets) out[name] = await renderToString(nodes[name]);
  return out;
}

/** What a poll asked of the read: its text as well (the find bar), and where the newest reply sits. */
export interface PollReadAsk {
  text: boolean;
  probe?: ReplyProbe;
}

/**
 * The read a poll answer carries (routes/pane/frames.ts, THE POLL ANSWER): the bridge's read as it is
 * when the poll asked for the text, else the same read without `text` and `logicalText` and with the
 * screen model computed from them. The route's own JSON never passes through here.
 */
export function pollRead<T extends { text: string; logicalText?: string }>(
  read: T,
  agent: string | undefined,
  ask: PollReadAsk,
): T | (Omit<T, "text" | "logicalText"> & Pick<PaneReadLite, "screen">) {
  if (ask.text) return read;
  const { text, logicalText: _unwrapped, ...rest } = read;
  return { ...rest, screen: screenOfText(text, agent, ask.probe) };
}

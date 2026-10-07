// One screen's parse: the blocks, the docked card, the mirror rows and the three tail reads, built
// ONCE per (text, agent) and shared by whoever asks first.
//
// WHY A SHARED CACHE. Building the blocks is the heaviest step of opening a pane (about 35 ms at 4x
// CPU, mostly the Claude adapter's input-box search; research note 05, rank 3). The dashboard's
// pointerdown prefetch already holds the screen's own first read (routes/home/open-pane.ts), so it
// parses it here as soon as it lands, between the finger going down and the tap. The pane's first
// render then finds the parse waiting and only draws. One read per tap stays one read: this module
// fetches nothing.
//
// The agent is the key's other half: `undefined` with the raw-terminal pref on (no adapter runs at
// all, web's `grammarsOn`), else the pane's agent string as the snapshot carries it.
import { parseAnsi } from "@web/lib/ansi";
import { splitLines, type Block, type StyledLine } from "@web/lib/blocks";
import { adapterFor, buildBlocks } from "@web/lib/harness";

import type { PaneRead, PaneScreen } from "../../lib/pane-read";
import { dialogCardOf, mirrorLines, type DialogCard } from "./cards";

export interface ScreenParse {
  blocks: Block[];
  card: DialogCard | null;
  mirror: StyledLine[];
  /** The agent's own input draft (agent-chat.tsx `rawDraft`), or null. */
  rawDraft: string | null;
  /** The agent's statusline rows and background-agents block (agent-chat.tsx). */
  statusLines: StyledLine[];
  agentsFooter: StyledLine[];
  /** How many rows the mirror draws, and how many the statusline draws (the counts the framed screen sizes by). */
  mirrorRows: number;
  statusRows: number;
}

/** The pane on screen, the one being prefetched, and a little slack for a sideways move. */
const CACHE_MAX = 4;
const cache: { text: string; agent: string | undefined; parse: ScreenParse }[] = [];

/** The agent a parse is keyed by: none with the raw-terminal pref on. */
export function parseAgent(agent: string | undefined, rawTerminal: boolean): string | undefined {
  return rawTerminal ? undefined : agent;
}

function build(text: string, agent: string | undefined): ScreenParse {
  const blocks = buildBlocks(splitLines(parseAnsi(text)), { agent });
  // The three tail reads go through the same adapter whose buildBlocks stripped them, over their own
  // parse of the text (agent-chat.tsx), and none of them without an adapter.
  const adapter = adapterFor(agent);
  const screen = adapter === undefined ? [] : splitLines(parseAnsi(text));
  const mirror = mirrorLines(blocks);
  const statusLines = adapter?.extractStatusLines(screen) ?? [];
  return {
    blocks,
    card: dialogCardOf(blocks),
    mirror,
    rawDraft: adapter?.extractInputDraft(screen) ?? null,
    statusLines,
    agentsFooter: adapter?.extractAgentsFooter?.(screen) ?? [],
    mirrorRows: mirror.length,
    statusRows: statusLines.length,
  };
}

/** The parse of `text` for `agent` (see `parseAgent`): the same object while neither moves. */
export function parseScreen(text: string, agent: string | undefined): ScreenParse {
  const at = cache.findIndex((entry) => entry.agent === agent && entry.text === text);
  if (at === 0) return cache[0]!.parse;
  if (at > 0) {
    const [entry] = cache.splice(at, 1);
    cache.unshift(entry!);
    return entry!.parse;
  }
  const parse = build(text, agent);
  cache.unshift({ text, agent, parse });
  if (cache.length > CACHE_MAX) cache.pop();
  return parse;
}

/** Parse ahead of the screen (the prefetch); a parse that throws is left for the screen to report. */
export function warmParse(text: string, agent: string | undefined): void {
  try {
    parseScreen(text, agent);
  } catch {
    // the pane's own render runs the same parse and surfaces the failure there
  }
}

// ── A read that left its text out ───────────────────────────────────────────────────────────────────

/**
 * The parse of a poll answer's screen model (lib/pane-read.ts). The mirror's lines and the statusline's
 * rows are not in it, because the server frames draw them: `mirror` and `statusLines` stay empty, and
 * `mirrorRows` and `statusRows` say how many rows those frames hold. The card is derived from the
 * model's blocks by the same `dialogCardOf` that runs over a parse of the text, so its wording is the
 * browser's own locale. One parse per model object: a quiet poll keeps the held read, and the same
 * object comes back.
 */
const NONE: StyledLine[] = [];
const modelParses = new WeakMap<PaneScreen, ScreenParse>();

function parseModel(screen: PaneScreen): ScreenParse {
  const held = modelParses.get(screen);
  if (held !== undefined) return held;
  const parse: ScreenParse = {
    blocks: screen.blocks,
    card: dialogCardOf(screen.blocks),
    mirror: NONE,
    rawDraft: screen.rawDraft,
    statusLines: NONE,
    agentsFooter: screen.footer,
    mirrorRows: screen.rows,
    statusRows: screen.statusRows,
  };
  modelParses.set(screen, parse);
  return parse;
}

/** The parse of a pane read: from its screen model when it has one, else from its text. */
export function parseRead(read: PaneRead | undefined, agent: string | undefined): ScreenParse {
  if (read?.screen !== undefined) return parseModel(read.screen);
  return parseScreen(read?.text ?? "", agent);
}

/**
 * A token that changes when the screen does: "" for a blank screen, else the text itself, or the
 * model's stamp. Only ever compared for equality (the composer's send echo, the reply reader, the
 * cadence's "did it move").
 */
export function screenToken(read: PaneRead | undefined): string {
  if (read === undefined) return "";
  if (read.screen !== undefined) return read.screen.blank ? "" : read.screen.stamp;
  return read.text;
}

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
import { splitLines } from "@web/lib/blocks";
import { adapterFor, buildBlocks } from "@web/lib/harness";

import type { PaneRead } from "../../lib/pane-read";
import { dialogCardOf, mirrorLines } from "./cards";
import { parseAgent, parseModel, screenToken, type ScreenParse } from "./parse-model";

export { parseAgent, parseModel, screenToken, type ScreenParse };

/** The pane on screen, the one being prefetched, and a little slack for a sideways move. */
const CACHE_MAX = 4;
const cache: { text: string; agent: string | undefined; parse: ScreenParse }[] = [];

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

/** The parse of a pane read: from its screen model when it has one, else from its text. */
export function parseRead(read: PaneRead | undefined, agent: string | undefined): ScreenParse {
  if (read?.screen !== undefined) return parseModel(read.screen);
  return parseScreen(read?.text ?? "", agent);
}


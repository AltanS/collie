// The half of a screen's parse that needs no harness (S3): the shape, the parse of a poll answer's
// screen model, the token and the parse's agent. A frames read carries the model in place of its text,
// so an islands pane page draws from this module alone and loads the harness (routes/pane/parse.ts,
// about 120 KB) only for a read that carries its text (the find bar) or a write.
import type { Block, StyledLine } from "@web/lib/blocks";

import type { PaneRead, PaneScreen } from "../../lib/pane-read";
import { dialogCardOf, type DialogCard } from "./cards";

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

/** The agent a parse is keyed by: none with the raw-terminal pref on. */
export function parseAgent(agent: string | undefined, rawTerminal: boolean): string | undefined {
  return rawTerminal ? undefined : agent;
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

export function parseModel(screen: PaneScreen): ScreenParse {
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

// The pane read as the shell holds it, and the screen model that stands in for its text.
//
// A pane read is the bridge's `PaneReadResponse`: the pane's ANSI text and a few counters. The shell
// draws everything on the pane screen from that text: the mirror's rows, the dialog card, the
// composer's draft, the statusline, the agents footer. With the pane's server frames on (S2,
// routes/pane/frames.ts) the rows are the SERVER's, so a poll answer that carried the text as well
// carried the screen twice. A poll answer therefore leaves the text out and carries `screen` instead:
// what the browser would have derived from the text, computed on the bridge with the same pure
// functions (routes/pane/screen-model.ts). Types only: no browser API, safe on Bun and in the browser.
import type { Block, StyledLine } from "@web/lib/blocks";
import type { ReplyFit } from "@web/lib/latest-reply";
import type { PaneReadResponse } from "@web/lib/types";

/** Where the newest reply sits on the mirror, as the bridge located it for the probe the browser sent. */
export interface ReplyAt {
  /** The probe this was located for (routes/pane/screen-model.ts `ReplyAsk`): an answer for another probe is stale. */
  key: string;
  fit: ReplyFit;
  endLine: number;
}

/** What the browser derives from a pane's text, computed on the bridge (see the file header). */
export interface PaneScreen {
  /** A digest of the text and the parsing agent: equal stamps are equal screens, as equal texts are. */
  stamp: string;
  /** The agent whose adapter parsed it (absent for none): a model parsed for another agent than the page's is stale. */
  agent?: string;
  /** The raw screen is empty (web's `!display`): the only case that says "(no recent output)". */
  blank: boolean;
  /** How many rows the mirror draws, so the framed Terminal can size and compare what it shows. */
  rows: number;
  /** How many rows the statusline draws; the rows themselves are the `pane-status` frame's. */
  statusRows: number;
  /** The agent's own input draft (agent-chat.tsx `rawDraft`), or null. */
  rawDraft: string | null;
  /** Every block that is not raw output or a completion popup: the dialog the card, the guard and the question note read. */
  blocks: Block[];
  /** The background-agents block (agent-chat.tsx `agentsFooter`). */
  footer: StyledLine[];
  /** Present when the request carried a reply probe. */
  reply?: ReplyAt;
}

/** A pane read as held by the shell: the bridge's body, plus `screen` when the text was left out. */
export type PaneRead = PaneReadResponse & { screen?: PaneScreen };

/**
 * A pane read as a poll answer carries it when the text is left out: no `text` and no `logicalText`.
 * The browser fills `text` with "" when it holds one (frames.ts `parsePollAnswer`), so `screen` is what
 * tells such a read from a screen that is really blank.
 */
export type PaneReadLite = Omit<PaneReadResponse, "text" | "logicalText"> & { screen: PaneScreen };

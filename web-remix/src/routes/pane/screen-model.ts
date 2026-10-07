// The pane screen model (lib/pane-read.ts says what it is for): what the browser derives from a pane's
// text, computed once on the bridge for a poll answer that leaves the text out, and the reply probe
// that stands in for the one consumer which compares the newest reply against the whole text.
//
// PURE and shared. The bridge's renderer calls `screenOfText`; the browser reads the model back
// through `parseRead` (parse.ts) with the SAME card, guard and note functions it runs over a parse of
// the text, so a model and the text it came from cannot disagree on what is on screen (the round trip
// is tested, screen-model.test.ts). No browser API: this runs on Bun.
import type { Block } from "@web/lib/blocks";
import { fold, locateReply, PROBE_CHARS, replyProse, type ReplyPlacement } from "@web/lib/latest-reply";
import type { TranscriptEntry } from "@web/lib/types";

import type { PaneScreen } from "../../lib/pane-read";
import { encodeProbe, type ReplyProbe } from "./frames";
import { parseScreen } from "./parse";

/** A 53-bit string hash (cyrb53), in base 36: equal texts hash equal, and a collision needs two
 *  different screens to meet in 2^53, which one pane's polls never do. No `Bun` API, so the browser can use it. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The stamp of a screen: its text and the agent whose adapter parsed it. */
export function screenStamp(text: string, agent: string | undefined): string {
  return `${hash53(text)}.${String(text.length)}.${hash53(agent ?? "")}`;
}

/** The blocks the model keeps: every one a card, the guard or the question note can read. */
export function interactiveBlocks(blocks: readonly Block[]): Block[] {
  return blocks.filter((block) => block.kind !== "raw" && block.kind !== "autocomplete");
}

/** Where the probe's reply sits on `text`, by web's own `locateReply` over a stand-in turn that holds the two probes. */
export function locateProbe(text: string, probe: ReplyProbe): ReplyPlacement {
  const standIn: TranscriptEntry = {
    uuid: "probe",
    ts: "",
    role: "assistant",
    parts: [{ kind: "text", text: `${probe.head}${probe.tail}` }],
  };
  return locateReply(text, standIn);
}

/** The model of `text` as parsed for `agent`, with the reply located when the request carried a probe. */
export function screenOfText(text: string, agent: string | undefined, probe?: ReplyProbe): PaneScreen {
  const parse = parseScreen(text, agent);
  const screen: PaneScreen = {
    stamp: screenStamp(text, agent),
    blank: text === "",
    rows: parse.mirror.length,
    statusRows: parse.statusLines.length,
    rawDraft: parse.rawDraft,
    blocks: interactiveBlocks(parse.blocks),
    footer: parse.agentsFooter,
  };
  if (agent !== undefined) screen.agent = agent;
  if (probe !== undefined) screen.reply = { key: encodeProbe(probe), ...locateProbe(text, probe) };
  return screen;
}

// ── The browser's side of the reply probe ───────────────────────────────────────────────────────────

/** What the browser needs to know about the newest reply's place: settled already, or ask the bridge. */
export type ReplyAsk = { kind: "settled"; placement: ReplyPlacement } | { kind: "probe"; probe: ReplyProbe; key: string };

/** True when the bridge capped one of the reply's text parts (web's `proseTruncated`, private there). */
function proseTruncated(entry: TranscriptEntry): boolean {
  return entry.parts.some((part) => part.kind === "text" && part.truncated === true);
}

/**
 * The reply's ask, with web's `locateReply` order of verdicts kept: a reply shorter than two probes is
 * whole, a capped one is off screen, and only a reply that needs the screen to be placed makes a probe.
 */
export function askForReply(entry: TranscriptEntry): ReplyAsk {
  const reply = fold(replyProse(entry));
  if (reply.length < PROBE_CHARS * 2) return { kind: "settled", placement: { fit: "whole", endLine: -1 } };
  if (proseTruncated(entry)) return { kind: "settled", placement: { fit: "off-screen", endLine: -1 } };
  const probe: ReplyProbe = { head: reply.slice(0, PROBE_CHARS), tail: reply.slice(-PROBE_CHARS) };
  return { kind: "probe", probe, key: encodeProbe(probe) };
}

/** The placement the model carries for `ask`, or null while the bridge has not answered for this probe. */
export function placementOf(screen: PaneScreen, ask: ReplyAsk): ReplyPlacement | null {
  if (ask.kind === "settled") return ask.placement;
  const at = screen.reply;
  return at !== undefined && at.key === ask.key ? { fit: at.fit, endLine: at.endLine } : null;
}

// The browser's side of the reply probe (screen-model.ts says what the probe is): which reply needs the
// screen to be placed, and the placement a model carries for it. Its own module, with no parse, so the
// islands pane page (islands/screen.tsx) reads it without loading the harness (S3).
import { fold, PROBE_CHARS, replyProse, type ReplyPlacement } from "@web/lib/latest-reply";
import type { TranscriptEntry } from "@web/lib/types";

import type { PaneScreen } from "../../lib/pane-read";
import { encodeProbe, type ReplyProbe } from "./frames";


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

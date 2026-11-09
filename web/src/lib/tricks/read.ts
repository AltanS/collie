// THE TRICKS REPLIES, READ ONE PART AT A TIME (M94 review).
//
// `readTricksReply` and `readTapReply` (wire.ts) refuse a whole reply when one part in it is malformed.
// For the list that means one bad part keeps the phone from every other part until the bridge's rev
// moves again, and for a tap it turns a run that happened into "unknown". The wire readers are the
// contract and stay as they are. This is the door the routes read through: a reply the wire reader
// takes whole is taken whole; one it refuses is read again with each part alone, the bad parts dropped
// and the good ones kept. A reply that is bad outside its parts (no rev, no `present`) is still refused.
//
// A dropped part's key stays in `present`, so the phone keeps the last good version of it, if it holds
// one. One console warning per rev says how many went.

import { asJsonObject, type JsonObject, type JsonValue } from "../json";
import type { TrickTapReply, TricksReply, WireTrickPart } from "./schema";
import { readTapReply, readTricksReply } from "./wire";

/** The last rev a drop was logged for, so a poll that sees the same bad reply does not log it again. */
let loggedRev: number | undefined;

function warnOnce(rev: number | undefined, dropped: number): void {
  if (dropped === 0 || loggedRev === rev) return;
  loggedRev = rev;
  console.warn(`[tricks] ${dropped} malformed part(s) dropped from the reply${rev === undefined ? "" : ` at rev ${rev}`}`);
}

/** A reply with nothing in it but the parts, so a part is read alone and nothing else is read again. */
const BARE: JsonObject = { rev: 0, tricks: [], present: [] };

/** One entry of a `parts` list as a part, or `undefined` when the wire reader refuses it alone. */
function readOnePart(entry: JsonValue): WireTrickPart | undefined {
  return readTricksReply({ ...BARE, parts: [entry] })?.parts[0];
}

/** The parts of a list that read alone, and how many did not. `undefined` when `parts` is not a list. */
function goodParts(raw: JsonValue | undefined): { parts: WireTrickPart[]; dropped: number } | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts: WireTrickPart[] = [];
  for (const entry of raw) {
    const part = readOnePart(entry);
    if (part !== undefined) parts.push(part);
  }
  return { parts, dropped: raw.length - parts.length };
}

/** `GET /api/tricks` as the store merges it: a bad part is dropped, never the whole reply. */
export function readTricksReplyTolerant(raw: JsonValue | undefined): TricksReply | undefined {
  const whole = readTricksReply(raw);
  if (whole !== undefined) return whole;
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const rest = readTricksReply({ ...body, parts: [] });
  const found = goodParts(body.parts);
  if (rest === undefined || found === undefined) return undefined;
  warnOnce(rest.rev, found.dropped);
  return { ...rest, parts: found.parts };
}

/** A tap's receipt, with a bad part in it dropped instead of the receipt refused. */
export function readTapReplyTolerant(raw: JsonValue | undefined): TrickTapReply | undefined {
  const whole = readTapReply(raw);
  if (whole !== undefined) return whole;
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const found = goodParts(body.parts);
  if (found === undefined) return undefined;
  const reply = readTapReply({ ...body, parts: [] });
  if (reply === undefined) return undefined;
  warnOnce(reply.rev, found.dropped);
  return { ...reply, parts: found.parts };
}

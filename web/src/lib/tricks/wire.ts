// THE TWO TRICKS REPLIES, READ ON THE PHONE (M94 slice 02).
//
// The bridge writes `TricksReply` and `TrickTapReply` from parts its own parser accepted, so these readers
// do not parse a part again. They check the frame: the fields the store keys on and merges by. A body
// of the wrong shape (an older bridge, a proxy's page) is refused whole rather than half applied, so
// the phone never holds a part it cannot key.
//
// NOT PARSING THE PART IS ON PURPOSE. A crew member on a newer Collie may send a node kind this phone
// does not know. The schema's parser would refuse that part; the renderer instead draws it as the
// placeholder ("this Collie cannot draw this part"), which is what the design asks for, and clamps a
// core node whose numbers are out of range.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../json";
import {
  TAP_CODES,
  type TrickPart,
  type TrickTapReply,
  type TricksReply,
  type TapCode,
  type WireTrickInfo,
  type WireTrickPart,
} from "./schema";

function asJsonArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A part value the store can key and place: an object with a string `at` and a string `id`. */
function isPartValue(value: JsonObject): value is JsonObject & TrickPart {
  return asJsonString(value.at) !== undefined && asJsonString(value.id) !== undefined;
}

/** A trick entry the store can list: a host, an id, a name and the switch. */
function isTrickValue(value: JsonObject): value is JsonObject & WireTrickInfo {
  const keyed = asJsonString(value.host) !== undefined && asJsonString(value.id) !== undefined && asJsonString(value.name) !== undefined;
  return keyed && asJsonBoolean(value.on) !== undefined;
}

function readPart(raw: JsonValue | undefined): WireTrickPart | undefined {
  const part = asJsonObject(raw);
  if (part === undefined) return undefined;
  const host = asJsonString(part.host);
  const trick = asJsonString(part.trick);
  const id = asJsonString(part.part);
  const rev = asJsonNumber(part.rev);
  const value = asJsonObject(part.value);
  if (host === undefined || trick === undefined || id === undefined || rev === undefined || value === undefined) return undefined;
  if (!isPartValue(value)) return undefined;
  const out: WireTrickPart = { host, trick, part: id, rev, value };
  const asOf = asJsonString(part.asOf);
  if (asOf !== undefined) out.asOf = asOf;
  const fresh = asJsonString(part.fresh);
  if (fresh !== undefined) out.fresh = fresh;
  if (part.stale === true) out.stale = true;
  const problem = asJsonString(part.problem);
  if (problem !== undefined) out.problem = problem;
  return out;
}

function readParts(raw: JsonValue | undefined): WireTrickPart[] | undefined {
  const list = asJsonArray(raw);
  if (list === undefined) return undefined;
  const parts: WireTrickPart[] = [];
  for (const entry of list) {
    const part = readPart(entry);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return parts;
}

function readKeys(raw: JsonValue | undefined): string[] | undefined {
  const list = asJsonArray(raw);
  if (list === undefined) return undefined;
  const keys: string[] = [];
  for (const entry of list) {
    const key = asJsonString(entry);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys;
}

/** One trick entry as the list and the switch route give it, or `undefined` for a body of another shape. */
export function readTrick(raw: JsonValue | undefined): WireTrickInfo | undefined {
  // The closed words (`icon`, `state`, `places`) were written by the bridge from the schema's lists; the
  // renderer falls back on an icon it does not know, and a state it does not know reads as ok.
  const trick = asJsonObject(raw);
  return trick !== undefined && isTrickValue(trick) ? trick : undefined;
}

/** `GET /api/tricks?since=` as the store merges it, or `undefined` for a body of another shape. */
export function readTricksReply(raw: JsonValue | undefined): TricksReply | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const rev = asJsonNumber(body.rev);
  const parts = readParts(body.parts);
  const present = readKeys(body.present);
  const list = asJsonArray(body.tricks);
  if (rev === undefined || parts === undefined || present === undefined || list === undefined) return undefined;
  const tricks: WireTrickInfo[] = [];
  for (const entry of list) {
    const trick = readTrick(entry);
    if (trick === undefined) return undefined;
    tricks.push(trick);
  }
  return { rev, tricks, parts, present };
}

function isTapCode(text: string | undefined): text is TapCode {
  return TAP_CODES.some((code) => code === text);
}

/**
 * A tap's receipt, or `undefined` when the body is not one. A refusal may come back on a non-2xx
 * status with a receipt in it, so the transport hands every body here before it throws.
 */
export function readTapReply(raw: JsonValue | undefined): TrickTapReply | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const rid = asJsonString(body.rid);
  const code = asJsonString(body.code);
  if (rid === undefined || !isTapCode(code)) return undefined;
  const reply: TrickTapReply = { rid, code };
  const message = asJsonString(body.message);
  if (message !== undefined) reply.message = message;
  const rev = asJsonNumber(body.rev);
  if (rev !== undefined) reply.rev = rev;
  if (body.parts !== undefined) {
    const parts = readParts(body.parts);
    if (parts === undefined) return undefined;
    reply.parts = parts;
  }
  if (body.present !== undefined) {
    const present = readKeys(body.present);
    if (present === undefined) return undefined;
    reply.present = present;
  }
  return reply;
}

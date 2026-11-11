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
  ABOUT_MAX,
  DESCRIPTION_MAX,
  INPUTS_MAX,
  INPUT_GLOB_MAX,
  isHostName,
  isTrickId,
  isTrickText,
  NAME_MAX,
  OFFICIAL_STATES,
  TAP_CODES,
  TRICK_WARNINGS_MAX,
  type OfficialState,
  type OfficialTricksReply,
  type TrickPart,
  type TrickTapReply,
  type TricksReply,
  type TricksRunsOn,
  type TapCode,
  type WireTrickInfo,
  type WireTrickPart,
  type WireTrickPending,
  type WireTrickWarning,
  type WireOfficialTrick,
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

/**
 * A trick's warnings (review 15), read tolerantly: each `{ kind, text }` with two strings is kept, any
 * other entry is left out, at most `TRICK_WARNINGS_MAX`. A bridge that sends none (an older one) gives [].
 */
export function readWarnings(raw: JsonValue | undefined): WireTrickWarning[] {
  const out: WireTrickWarning[] = [];
  for (const entry of asJsonArray(raw) ?? []) {
    const warning = asJsonObject(entry);
    const kind = asJsonString(warning?.kind);
    const text = asJsonString(warning?.text);
    if (kind !== undefined && text !== undefined) out.push({ kind, text });
  }
  return out.slice(0, TRICK_WARNINGS_MAX);
}

/** A count of files on the wire: a whole number from 0. */
function readCount(raw: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(raw);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * A trick's waiting version (crew slice 2), read tolerantly: kept only with a hash, three counts and the
 * powers flag; its warnings are read like the row's. Anything else is left out, as from an older bridge.
 */
export function readPending(raw: JsonValue | undefined): WireTrickPending | undefined {
  const body = asJsonObject(raw);
  const files = asJsonObject(body?.files);
  const hash = asJsonString(body?.hash);
  const powersChanged = asJsonBoolean(body?.powersChanged);
  const added = readCount(files?.added);
  const changed = readCount(files?.changed);
  const removed = readCount(files?.removed);
  if (body === undefined || hash === undefined || powersChanged === undefined || added === undefined || changed === undefined || removed === undefined) return undefined;
  return { hash, files: { added, changed, removed }, powersChanged, warnings: readWarnings(body.warnings) };
}

/**
 * What a trick's inputs read (contract 2), read tolerantly: kept only with 1 to `INPUTS_MAX` globs, each a
 * string of at most `INPUT_GLOB_MAX` characters, and the crew flag. Anything else is left out, as from an
 * older bridge.
 */
export function readInputs(raw: JsonValue | undefined): WireTrickInfo["inputs"] {
  const body = asJsonObject(raw);
  const crew = asJsonBoolean(body?.crew);
  const list = asJsonArray(body?.globs);
  if (crew === undefined || list === undefined || list.length === 0 || list.length > INPUTS_MAX) return undefined;
  const globs: string[] = [];
  for (const entry of list) {
    const glob = asJsonString(entry);
    if (glob === undefined || glob === "" || [...glob].length > INPUT_GLOB_MAX) return undefined;
    globs.push(glob);
  }
  return { globs, crew };
}

/**
 * A trick's `description` or `about`, read tolerantly: kept only as a string within its cap with no control
 * or invisible character. Anything else is left out, as from an older bridge. `about` may hold line breaks.
 */
export function readTrickText(raw: JsonValue | undefined, kind: "description" | "about"): string | undefined {
  const text = asJsonString(raw);
  if (text === undefined) return undefined;
  const rule = kind === "about" ? { max: ABOUT_MAX, multiline: true } : { max: DESCRIPTION_MAX };
  return isTrickText(text, rule) ? text : undefined;
}

/** One trick entry as the list and the switch route give it, or `undefined` for a body of another shape. */
export function readTrick(raw: JsonValue | undefined): WireTrickInfo | undefined {
  // The closed words (`icon`, `state`, `places`) were written by the bridge from the schema's lists; the
  // renderer falls back on an icon it does not know, and a state it does not know reads as ok.
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  // Read as JSON before the frame check narrows the body to the wire type.
  const sent = body.warnings;
  const waiting = body.pending;
  const reads = body.inputs;
  const described = body.description;
  const told = body.about;
  const auto = asJsonBoolean(body.auto);
  const autoAt = asJsonString(body.autoAt);
  if (!isTrickValue(body)) return undefined;
  if (sent === undefined && waiting === undefined && reads === undefined && body.auto === undefined && body.autoAt === undefined && described === undefined && told === undefined) return body;
  // The fields read past the frame: the Tricks card lists them, so their shapes are held here. One of
  // another shape is left out, as from an older bridge.
  const warnings = readWarnings(sent);
  const pending = readPending(waiting);
  const inputs = readInputs(reads);
  const description = readTrickText(described, "description");
  const about = readTrickText(told, "about");
  const { warnings: _sent, pending: _waiting, auto: _auto, autoAt: _autoAt, inputs: _reads, description: _described, about: _told, ...rest } = body;
  const out: WireTrickInfo = warnings.length === 0 ? rest : { ...rest, warnings };
  if (pending !== undefined) out.pending = pending;
  if (inputs !== undefined) out.inputs = inputs;
  if (description !== undefined) out.description = description;
  if (about !== undefined) out.about = about;
  if (auto !== undefined) out.auto = auto;
  if (autoAt !== undefined && Number.isFinite(Date.parse(autoAt))) out.autoAt = autoAt;
  return out;
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
  const reply: TricksReply = { rev, tricks, parts, present };
  const runsOn = readRunsOn(body.runsOn);
  if (runsOn !== undefined) reply.runsOn = runsOn;
  return reply;
}

/**
 * Where a bridge that runs no tricks says they run, read tolerantly: a word of another shape is left
 * out and the reply kept, and a lead that is no host name reads as not known (`{}`).
 */
function readRunsOn(raw: JsonValue | undefined): TricksRunsOn | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const lead = asJsonString(body.lead);
  return lead !== undefined && isHostName(lead) ? { lead } : {};
}

function isOfficialState(text: string | undefined): text is OfficialState {
  return OFFICIAL_STATES.some((state) => state === text);
}

/** One entry of the From Collie list, or `undefined` when a field is of another shape. */
function readOfficialTrick(raw: JsonValue | undefined): WireOfficialTrick | undefined {
  const body = asJsonObject(raw);
  if (body === undefined) return undefined;
  const id = asJsonString(body.id);
  const name = asJsonString(body.name);
  const description = readTrickText(body.description, "description");
  const repo = asJsonString(body.repo);
  const repoName = asJsonString(body.repoName);
  const commit = asJsonString(body.commit);
  const state = asJsonString(body.state);
  if (id === undefined || !isTrickId(id) || name === undefined || !isTrickText(name, { max: NAME_MAX })) return undefined;
  if (description === undefined || repo === undefined || repoName === undefined || !isTrickText(repoName, { max: NAME_MAX * 2 })) return undefined;
  if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit) || !isOfficialState(state)) return undefined;
  return { id, name, description, repo, repoName, commit, state };
}

/**
 * `GET /api/tricks/official` (the From Collie list), or `undefined` for a body of another shape. An entry
 * of another shape is left out and the rest kept: the list only offers, so one odd entry hides itself.
 */
export function readOfficialTricksReply(raw: JsonValue | undefined): OfficialTricksReply | undefined {
  const body = asJsonObject(raw);
  const list = asJsonArray(body?.tricks);
  if (body === undefined || list === undefined) return undefined;
  const tricks = list.map(readOfficialTrick).filter((entry) => entry !== undefined);
  const reply: OfficialTricksReply = { tricks };
  const runsOn = readRunsOn(body.runsOn);
  if (runsOn !== undefined) reply.runsOn = runsOn;
  return reply;
}

/** The answer to an add or an update from the list: `{ id, state }`, or `undefined`. */
export function readOfficialAddReply(raw: JsonValue | undefined): { id: string; state: OfficialState } | undefined {
  const body = asJsonObject(raw);
  const id = asJsonString(body?.id);
  const state = asJsonString(body?.state);
  return id === undefined || !isOfficialState(state) ? undefined : { id, state };
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

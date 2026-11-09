// THE HILL'S READER (M96): the bridge's answers, checked field by field before the phone draws them.
//
// The hill's list and its receipts cross the wire as JSON, and a bridge one release ahead or behind
// may send a shape this build does not know: a new state, a field that changed type. So nothing from
// the wire is cast. Each decision is read on its own, and one that does not fit the contract
// (`lib/hill/wire.ts`) is DROPPED: a card drawn from half a decision could put a button on screen
// that answers something else. One console warning per read says how many went, never one per
// decision, so a bridge that is wrong about every row does not flood the console on every poll.
//
// The caps of the contract are not checked here. The bridge cleans and caps every string before it
// stores one, and a long title is still a title: the card truncates it. What is checked is what
// would make a card lie: an unknown state, a priority or a text mode outside the closed lists, an
// option without an intent, a link that is not http or https.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "@/lib/json";

import {
  HILL_MEDIA_BYTES_MAX,
  HILL_MEDIA_ID_RE,
  HILL_MEDIA_MAX,
  HILL_MEDIA_MIMES,
  HILL_PRIORITIES,
  HILL_RESERVED_INTENTS,
  HILL_STATES,
  HILL_TEXT_MODES,
  HILL_TRICK_DELIVERIES,
  type HillDecision,
  type HillList,
  type HillMedia,
  type HillOption,
  type HillPriority,
  type HillReceipt,
  type HillState,
  type HillTextMode,
} from "./wire";

const RECEIPT_CODES: readonly HillReceipt["code"][] = ["ok", "rejected", "gone", "denied", "unknown"];
const DELIVERIES: readonly NonNullable<HillReceipt["delivery"]>[] = ["typed", "held", "unknown", "none"];
const ANSWER_DELIVERIES: readonly NonNullable<HillDecision["answer"]>["delivery"][] = ["typed", "held", "unknown", "none"];
/** The most pixels one side of an image may have: a picture past it is left out, as one past the bytes cap is. */
const HILL_MEDIA_PX_MAX = 8192;
const FROM_KINDS: readonly HillDecision["from"]["kind"][] = ["agent", "trick"];

/** A string field, or null when the field is null or absent. `undefined` when it is there and is not a string. */
function nullableString(value: JsonValue | undefined): string | null | undefined {
  if (value === null || value === undefined) return null;
  return asJsonString(value);
}

/** A number field, or null when the field is null or absent. `undefined` when it is there and is not a number. */
function nullableNumber(value: JsonValue | undefined): number | null | undefined {
  if (value === null || value === undefined) return null;
  return asJsonNumber(value);
}

/** One of a closed list of words, or undefined. */
function oneOf<T extends string>(list: readonly T[], value: JsonValue | undefined): T | undefined {
  const word = asJsonString(value);
  return list.find((item) => item === word);
}

/** The array a field holds, or an empty one when the field is absent. `undefined` when it is there and is not an array. */
function arrayOf(value: JsonValue | undefined): JsonValue[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : undefined;
}

/**
 * An option is dropped, and the decision stays, when its intent is one the answer route owns (`answer` and
 * `dismiss`) or repeats an earlier option's: a second button for one intent would send the same answer
 * under two labels, and `answer` or `dismiss` would be sent as a choice.
 */
function distinctOptions(options: readonly HillOption[]): HillOption[] {
  const seen = new Set(HILL_RESERVED_INTENTS);
  const kept: HillOption[] = [];
  for (const option of options) {
    if (seen.has(option.intent)) continue;
    seen.add(option.intent);
    kept.push(option);
  }
  return kept;
}

function readOption(value: JsonValue): HillOption | null {
  const o = asJsonObject(value);
  if (o === undefined) return null;
  const intent = asJsonString(o.intent);
  const label = asJsonString(o.label);
  if (intent === undefined || intent === "" || label === undefined || label === "") return null;
  const option: HillOption = { intent, label };
  const detail = asJsonString(o.detail);
  if (detail !== undefined && detail !== "") option.detail = detail;
  const confirm = asJsonString(o.confirm);
  if (confirm !== undefined && confirm !== "") option.confirm = confirm;
  return option;
}

/** The parsed address, or null when `href` is not an absolute URL. */
function parseUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** True for an absolute http or https address. Anything else never becomes an anchor on the card. */
export function isWebLink(href: string): boolean {
  const url = parseUrl(href);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:");
}

/** The host a link goes to, as the card prints it beside the label: `github.com`. Empty when it has none. */
export function linkHost(href: string): string {
  return parseUrl(href)?.host ?? "";
}

function readLink(value: JsonValue): { label: string; href: string } | null {
  const o = asJsonObject(value);
  if (o === undefined) return null;
  const label = asJsonString(o.label);
  const href = asJsonString(o.href);
  if (label === undefined || label === "" || href === undefined || !isWebLink(href)) return null;
  return { label, href };
}

/** A whole number of at least 1, or null for null or absent; undefined for anything else. */
function nullableDimension(value: JsonValue | undefined): number | null | undefined {
  const n = nullableNumber(value);
  if (n === null || n === undefined) return n;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * One image of a decision, or null when it does not fit. The id must match its pattern, because the
 * phone builds the bytes' route from it; the type must be one of the three the bridge keeps.
 */
function readMedia(value: JsonValue): HillMedia | null {
  const o = asJsonObject(value);
  if (o === undefined || o.kind !== "image") return null;
  const id = asJsonString(o.id);
  const mime = oneOf(HILL_MEDIA_MIMES, o.mime);
  const bytes = asJsonNumber(o.bytes);
  const width = nullableDimension(o.width);
  const height = nullableDimension(o.height);
  if (id === undefined || !HILL_MEDIA_ID_RE.test(id) || mime === undefined || bytes === undefined || width === undefined || height === undefined) return null;
  // The bridge caps an image's bytes and the phone sizes a box by its sides: one past either is left out.
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > HILL_MEDIA_BYTES_MAX) return null;
  if ((width !== null && width > HILL_MEDIA_PX_MAX) || (height !== null && height > HILL_MEDIA_PX_MAX)) return null;
  const media: HillMedia = { id, kind: "image", mime, bytes, width, height };
  const caption = asJsonString(o.caption);
  if (caption !== undefined && caption.trim() !== "") media.caption = caption;
  return media;
}

function readFrom(value: JsonValue | undefined): HillDecision["from"] | null {
  const o = asJsonObject(value);
  if (o === undefined) return null;
  const kind = oneOf(FROM_KINDS, o.kind);
  const label = asJsonString(o.label);
  const address = nullableString(o.address);
  const trickId = nullableString(o.trickId);
  const memberId = nullableString(o.memberId);
  const harness = nullableString(o.harness);
  const host = nullableString(o.host);
  const trickKey = nullableString(o.trickKey);
  const trickHost = nullableString(o.trickHost);
  if (kind === undefined || label === undefined) return null;
  if (address === undefined || trickId === undefined || memberId === undefined || harness === undefined || host === undefined) return null;
  if (trickKey === undefined || trickHost === undefined) return null;
  return { kind, address, trickId, trickKey, memberId, harness, label, host, trickHost };
}

function readTarget(value: JsonValue | undefined): HillDecision["target"] | undefined {
  if (value === null || value === undefined) return null;
  const o = asJsonObject(value);
  if (o === undefined) return undefined;
  const label = asJsonString(o.label);
  const host = nullableString(o.host);
  if (label === undefined || host === undefined) return undefined;
  return { label, host, unattended: asJsonBoolean(o.unattended) === true };
}

function readRecommends(value: JsonValue | undefined, options: readonly HillOption[]): HillDecision["recommends"] | undefined {
  if (value === null || value === undefined) return null;
  const o = asJsonObject(value);
  if (o === undefined) return undefined;
  const intent = asJsonString(o.intent);
  const why = asJsonString(o.why);
  if (intent === undefined || why === undefined) return undefined;
  // The contract says the intent names an option. One that names none would draw a "Recommended"
  // line over buttons that hold no such choice, so the line goes and the decision stays.
  if (!options.some((option) => option.intent === intent)) return null;
  return { intent, why };
}

function readAnswer(value: JsonValue | undefined): HillDecision["answer"] | undefined {
  if (value === null || value === undefined) return null;
  const o = asJsonObject(value);
  if (o === undefined) return undefined;
  const rid = asJsonString(o.rid);
  const intent = asJsonString(o.intent);
  const label = nullableString(o.label);
  const text = nullableString(o.text);
  const by = asJsonString(o.by);
  const at = asJsonNumber(o.at);
  const delivery = oneOf(ANSWER_DELIVERIES, o.delivery);
  const trick = oneOf(HILL_TRICK_DELIVERIES, o.trick);
  if (rid === undefined || intent === undefined || label === undefined || text === undefined) return undefined;
  if (by === undefined || at === undefined || delivery === undefined || trick === undefined) return undefined;
  return { rid, intent, label, text, by, at, delivery, trick };
}

/** One decision as the contract shapes it, or null when it does not fit. */
export function readHillDecision(value: JsonValue): HillDecision | null {
  const o = asJsonObject(value);
  if (o === undefined || o.v !== 1) return null;
  const id = asJsonString(o.id);
  const requestId = asJsonString(o.requestId);
  const from = readFrom(o.from);
  const priority: HillPriority | undefined = oneOf(HILL_PRIORITIES, o.priority);
  const priorityAsked: HillPriority | undefined = oneOf(HILL_PRIORITIES, o.priorityAsked) ?? priority;
  const title = asJsonString(o.title);
  const summary = asJsonString(o.summary);
  const body = o.body === undefined ? "" : asJsonString(o.body);
  const text: HillTextMode | undefined = o.text === undefined ? "optional" : oneOf(HILL_TEXT_MODES, o.text);
  const state: HillState | undefined = oneOf(HILL_STATES, o.state);
  const at = asJsonNumber(o.at);
  if (id === undefined || requestId === undefined || from === null || priority === undefined || priorityAsked === undefined) return null;
  if (title === undefined || title === "" || summary === undefined || body === undefined || text === undefined) return null;
  if (state === undefined || at === undefined) return null;

  const rawOptions = arrayOf(o.options);
  if (rawOptions === undefined) return null;
  const options = rawOptions.map(readOption);
  if (options.some((option) => option === null)) return null;
  const okOptions = distinctOptions(options.filter((option) => option !== null));
  // A decision with no button and no field has no way to be answered: the bridge refuses one.
  if (okOptions.length === 0 && text === "none") return null;

  const rawLinks = arrayOf(o.links);
  if (rawLinks === undefined) return null;
  const links = rawLinks.map(readLink).filter((link) => link !== null);

  // An image that does not fit is left out and the decision stays, as a link is: the card loses a
  // picture, never a button. An older bridge sends `[]`; one before images, nothing.
  const rawMedia = arrayOf(o.media) ?? [];
  const media = rawMedia
    .map(readMedia)
    .filter((item) => item !== null)
    .slice(0, HILL_MEDIA_MAX);

  const recommends = readRecommends(o.recommends, okOptions);
  const target = readTarget(o.target);
  const answer = readAnswer(o.answer);
  const about = nullableString(o.about);
  const replyTo = nullableString(o.replyTo);
  const supersedes = nullableString(o.supersedes);
  const supersededBy = nullableString(o.supersededBy);
  const expiresAt = nullableNumber(o.expiresAt);
  const closedAt = nullableNumber(o.closedAt);
  const closedReason = nullableString(o.closedReason);
  if (recommends === undefined || target === undefined || answer === undefined) return null;
  if (about === undefined || replyTo === undefined || supersedes === undefined || supersededBy === undefined) return null;
  if (expiresAt === undefined || closedAt === undefined || closedReason === undefined) return null;

  return {
    v: 1,
    id,
    requestId,
    from,
    about,
    priority,
    priorityAsked,
    title,
    summary,
    body,
    options: okOptions,
    text,
    recommends,
    media,
    links,
    replyTo,
    target,
    supersedes,
    supersededBy,
    expiresAt,
    at,
    state,
    closedAt,
    closedReason,
    answer,
  };
}

/** The decisions of one list that fit, and how many did not. */
interface DecisionsRead {
  list: HillDecision[];
  dropped: number;
}

/** Read a list of decisions, keeping the ones that fit. Returns the count it dropped beside them. */
function readDecisions(value: JsonValue | undefined, wanted: (state: HillState) => boolean): DecisionsRead {
  const raw = arrayOf(value) ?? [];
  const list: HillDecision[] = [];
  let dropped = 0;
  for (const item of raw) {
    const decision = readHillDecision(item);
    if (decision === null || !wanted(decision.state)) dropped += 1;
    else list.push(decision);
  }
  return { list, dropped };
}

/**
 * The hill's list, or null when the answer is not a list at all (no `rev`). An `unchanged` answer
 * carries no decisions. An open decision in the closed list, or the other way round, is dropped
 * with the malformed ones: the two lists are the two halves of the view, and a row in the wrong half
 * would offer buttons for something closed.
 */
export function readHillList(value: JsonValue | undefined): HillList | null {
  const o = asJsonObject(value);
  if (o === undefined) return null;
  const rev = asJsonNumber(o.rev);
  if (rev === undefined) return null;
  if (asJsonBoolean(o.unchanged) === true) return { rev, unchanged: true, open: [], closed: [] };
  const open = readDecisions(o.open, (state) => state === "open");
  const closed = readDecisions(o.closed, (state) => state !== "open");
  const dropped = open.dropped + closed.dropped;
  if (dropped > 0) console.warn(`hill: dropped ${dropped} decision(s) this build cannot read`);
  return { rev, open: open.list, closed: closed.list };
}

/** A receipt as the contract shapes it, or null when it does not fit. */
export function readHillReceipt(value: JsonValue | undefined): HillReceipt | null {
  const o: JsonObject | undefined = asJsonObject(value);
  if (o === undefined) return null;
  const rid = asJsonString(o.rid);
  const code = oneOf(RECEIPT_CODES, o.code);
  const reason = nullableString(o.reason);
  const at = asJsonNumber(o.at);
  const state = o.state === null || o.state === undefined ? null : oneOf(HILL_STATES, o.state);
  const delivery = o.delivery === null || o.delivery === undefined ? null : oneOf(DELIVERIES, o.delivery);
  const trick = o.trick === null ? null : oneOf(HILL_TRICK_DELIVERIES, o.trick);
  if (rid === undefined || code === undefined || reason === undefined || at === undefined) return null;
  if (state === undefined || delivery === undefined || trick === undefined) return null;
  return { rid, code, reason, state, delivery, trick, at };
}

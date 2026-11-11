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
// option without an intent, a link that is not http or https. A view (M96) is the one exception: it is
// read with the same rules the bridge holds a post to (`parseDecisionView`). One that fails whole is
// read again node by node (`readDecisionView`): a top-level node the rules refuse is dropped, the rest
// draws, and the card keeps its question and its options either way.
//
// AN IMAGE NODE FOLLOWS ITS PICTURE (2026-11-10). A view's `image` names one of the decision's images by
// its place in the bridge's list (`ref`). The phone may leave a picture out of that list (past the bytes
// or the pixel cap), which moves the ones after it, so each `ref` is mapped onto the list the phone kept,
// and an image whose picture was left out leaves the view with it (a `compare` missing one goes whole).

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "@/lib/json";
import { DECISION_VIEW_LIMITS, parseDecisionView, type View } from "@/lib/tricks/schema";

import {
  HILL_GROUP_HASH_RE,
  HILL_GROUP_PARTS,
  HILL_MEDIA_BYTES_MAX,
  HILL_MEDIA_ID_RE,
  HILL_MEDIA_MAX,
  HILL_MEDIA_MIMES,
  HILL_PRIORITIES,
  HILL_RESERVED_INTENTS,
  HILL_STATES,
  HILL_TEXT_MODES,
  HILL_TRICK_DELIVERIES,
  hillCollieRef,
  isHillCrewState,
  type HillCrewStateView,
  type HillDecision,
  type HillGroup,
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
const FROM_KINDS: readonly HillDecision["from"]["kind"][] = ["agent", "trick", "collie"];

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
  const from = { kind, address, trickId, trickKey, memberId, harness, label, host, trickHost };
  if (kind !== "collie") return from;
  // Collie's own Decision names what it is about; one without a readable `ref` is not drawn.
  const ref = asJsonObject(o.ref);
  const read = hillCollieRef(asJsonString(ref?.type), asJsonString(ref?.id), asJsonString(ref?.hash));
  return read === null ? null : { ...from, ref: read };
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
  const media: HillMedia[] = [];
  // Where each of the bridge's images sits in the list the phone keeps, or null when it was left out.
  const placeOf: (number | null)[] = rawMedia.map((raw) => {
    const item = readMedia(raw);
    if (item === null || media.length >= HILL_MEDIA_MAX) return null;
    media.push(item);
    return media.length - 1;
  });

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

  const decision: HillDecision = {
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
  // A view that does not fit is left out and the decision stays: the facts under the summary go, the
  // question and its options do not. An older bridge sends none.
  const view = o.view === undefined || o.view === null ? undefined : readDecisionView(o.view, placeOf);
  if (view !== undefined) decision.view = view;
  // A group of cards (crew slice 8) only on Collie's own Decision, whole or not at all: a card left out
  // would hide code, so a group with any card the reader refuses is dropped, and the yes is then refused.
  const group = from.kind === "collie" && o.group !== undefined ? readHillGroup(o.group, okOptions) : null;
  if (group !== null) decision.group = group;
  return decision;
}

/**
 * A Decision's group of cards, or null: a digest, the decline among the options, and 2 to 8 cards, each
 * a view the schema reads whole. The phone keeps the digest it was given and sends it back with the
 * answer; it does not hash the cards again (the bridge does, and a page over plain HTTP has no
 * `crypto.subtle`).
 */
export function readHillGroup(value: JsonValue, options: readonly HillOption[]): HillGroup | null {
  const o = asJsonObject(value);
  const digest = asJsonString(o?.digest);
  const decline = asJsonString(o?.decline);
  const rawParts = arrayOf(o?.parts);
  if (digest === undefined || !HILL_GROUP_HASH_RE.test(digest) || decline === undefined || rawParts === undefined) return null;
  if (rawParts.length < HILL_GROUP_PARTS.min || rawParts.length > HILL_GROUP_PARTS.max) return null;
  if (!options.some((option) => option.intent === decline)) return null;
  const parts: HillGroup["parts"] = [];
  for (const raw of rawParts) {
    const part = asJsonObject(raw);
    const sha256 = asJsonString(part?.sha256);
    const read = part?.view === undefined ? undefined : parseDecisionView(part.view, "/group").view;
    if (sha256 === undefined || !HILL_GROUP_HASH_RE.test(sha256) || read === undefined) return null;
    parts.push({ view: read, sha256 });
  }
  return { digest, decline, parts };
}

/** Every node of a view, kids counted, as `parseDecisionView` counts them against its cap. */
function nodeCount(value: JsonValue | undefined): number {
  const node = asJsonObject(value);
  if (node === undefined) return 1;
  const kids = arrayOf(node.kids) ?? [];
  return 1 + kids.reduce<number>((sum, kid) => sum + nodeCount(kid), 0);
}

/**
 * A node with each image's `ref` moved onto the phone's list of images (`placeOf`), or null when the node
 * is an image whose picture the phone left out. A node with a kid list keeps the kids that stay; a
 * `compare` that loses one keeps one, which its own rule then refuses, so it goes whole.
 */
function mapImageRefs(value: JsonValue, placeOf: readonly (number | null)[]): JsonValue | null {
  const node = asJsonObject(value);
  if (node === undefined) return value;
  if (node.kind === "image") {
    const attrs = asJsonObject(node.attrs);
    const ref = asJsonString(attrs?.ref);
    if (attrs === undefined || ref === undefined) return value;
    const place = /^\d+$/.test(ref) ? placeOf[Number(ref)] : undefined;
    if (place === null || place === undefined) return null;
    return { ...node, attrs: { ...attrs, ref: String(place) } };
  }
  const kids = node.kids === undefined ? undefined : arrayOf(node.kids);
  if (kids === undefined) return value;
  return { ...node, kids: kids.map((kid) => mapImageRefs(kid, placeOf)).filter((kid) => kid !== null) };
}

/**
 * A decision's view as the phone draws it, or undefined when nothing of it reads. Read whole first, with
 * the bridge's rules; one that fails is read again one top-level node at a time, each node that passes
 * kept in order while the whole stays inside the node cap. A view past the byte cap is not read at all.
 */
export function readDecisionView(raw: JsonValue, placeOf: readonly (number | null)[]): View | undefined {
  const list = arrayOf(raw);
  if (list === undefined) return undefined;
  const images = placeOf.filter((place) => place !== null).length;
  const mapped = list.map((node) => mapImageRefs(node, placeOf)).filter((node) => node !== null);
  const whole = parseDecisionView(mapped, "/view", { images });
  if (whole.view !== undefined) return whole.view;
  if (whole.refusals.some((refusal) => refusal.code === "size")) return undefined;
  const view: View = [];
  let nodes = 0;
  for (const node of mapped) {
    const one = parseDecisionView([node], "/view", { images }).view;
    const count = nodeCount(node);
    if (one === undefined || nodes + count > DECISION_VIEW_LIMITS.nodes) continue;
    nodes += count;
    view.push(...one);
  }
  return view.length === 0 ? undefined : view;
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
  const total = asJsonNumber(o.closedTotal);
  const list: HillList = { rev, open: open.list, closed: closed.list };
  // How many closed ones the bridge holds: never fewer than the rows it sent.
  if (total !== undefined && Number.isInteger(total)) list.closedTotal = Math.max(total, closed.list.length);
  // The crew state (1.29.0): an older bridge sends none, and a value this build does not know is left out.
  const crewState = readHillCrewStateView(o.crewState);
  if (crewState !== null) list.crewState = crewState;
  return list;
}

/** The longest `by` a crew state shows: a device or "terminal". */
const CREW_STATE_BY_MAX = 80;

/**
 * The crew state as `GET /api/hill/state` and `GET /api/hill` carry it, or null when it does not fit. A
 * state this build does not know is null, never a guess.
 */
export function readHillCrewStateView(value: JsonValue | undefined): HillCrewStateView | null {
  const o = asJsonObject(value);
  const state = o?.state;
  if (o === undefined || !isHillCrewState(state)) return null;
  const at = o.at === null ? null : asJsonNumber(o.at);
  const by = o.by === null ? null : asJsonString(o.by);
  const told = o.told === null || o.told === undefined ? null : asJsonNumber(o.told);
  if (at === undefined || by === undefined || told === undefined) return null;
  return { state, at, by: by === null ? null : by.slice(0, CREW_STATE_BY_MAX), told };
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
  const receipt: HillReceipt = { rid, code, reason, state, delivery, trick, at };
  // The crew machine that is not answering (CREW_PROTOCOL §22): a short printable name, else left out.
  const machine = asJsonString(o.machine);
  return machine !== undefined && MACHINE_NAME.test(machine) ? { ...receipt, machine } : receipt;
}

/** A crew machine's name as a receipt may carry it: a member id or a host name, short and printable. */
const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

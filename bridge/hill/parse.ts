// The ONE file under bridge/hill/ that reads an unvalidated value (the hill, M96): a post's fields off
// the walky socket, a phone's answer body, and the decisions file on disk. Every reader is total over
// garbage: no input makes one throw, and a field that fails its rule fails the record. What a field
// MEANS (caps, cleaning, live addresses) is the service's to judge (service.ts); here only the shape.

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import {
  HILL_DEVICE_ID_RE,
  HILL_ID_RE,
  HILL_IMAGE_PATH_MAX,
  HILL_MEDIA_ID_RE,
  HILL_MEDIA_MAX,
  HILL_MEDIA_MIMES,
  HILL_PRIORITIES,
  HILL_STATES,
  HILL_TEXT_MODES,
  HILL_TRICK_DELIVERIES,
  hillIdOfNode,
  type HillAnswerRequest,
  type HillDecision,
  type HillImageInput,
  type HillMedia,
  type HillOption,
  type HillPostInput,
  type HillPriority,
  type HillRefusalCode,
  type HillState,
  type HillTextMode,
} from "../../web/src/lib/hill/wire.ts";
import { isRequestId } from "../worktree-receipts.ts";
import { isHillPushTag } from "./push.ts";
import { parseDecisionView, type View } from "../../web/src/lib/tricks/schema.ts";

/** What the socket answers a status or withdraw whose id is not a decision id. */
export const HILL_BAD_ID = "bad request: a decision id is dc_ and 12 characters";

/** The longest raw string a post or an answer may carry before cleaning. Longer is refused, not cut. */
export const HILL_RAW_MAX = 32 * 1024;

/** The most entries a raw list (options, links) is read for. More is refused, never cut. */
const RAW_LIST_MAX = 50;

/** A post that is not a post: the plain words, and the contract's code when one names the field. */
export interface HillPostRefusal {
  readonly ok: false;
  readonly code: HillRefusalCode | null;
  readonly error: string;
}

/** What `readPostFields` answers. */
export type HillPostRead = { readonly ok: true; readonly input: HillPostInput } | HillPostRefusal;

function refused(code: HillRefusalCode | null, error: string): HillPostRefusal {
  return { ok: false, code, error };
}

/** A string field that is absent, null, or a string within the raw cap. Undefined: none of those. */
function optionalText(row: JsonObject, key: string): string | null | undefined {
  const value = row[key];
  if (value === undefined || value === null) return null;
  const text = asJsonString(value);
  return text === undefined || text.length > HILL_RAW_MAX ? undefined : text;
}

function isPriority(value: string | undefined): value is HillPriority {
  return HILL_PRIORITIES.some((priority) => priority === value);
}

function isTextMode(value: string | undefined): value is HillTextMode {
  return HILL_TEXT_MODES.some((mode) => mode === value);
}

function isState(value: string | undefined): value is HillState {
  return HILL_STATES.some((state) => state === value);
}

/** One option as posted: `{ intent, label, detail?, confirm? }`, every part a string. */
function readOption(value: JsonValue | undefined): HillOption | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const intent = asJsonString(row.intent);
  const label = asJsonString(row.label);
  const detail = optionalText(row, "detail");
  const confirm = optionalText(row, "confirm");
  if (intent === undefined || label === undefined || label.length > HILL_RAW_MAX || detail === undefined || confirm === undefined) return null;
  const base: HillOption = { intent, label };
  const withDetail = detail === null ? base : { ...base, detail };
  return confirm === null ? withDetail : { ...withDetail, confirm };
}

/** One image as posted: `{ path, caption? }`. What the path names is the service's to check. */
function readImage(value: JsonValue | undefined): HillImageInput | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const path = asJsonString(row.path);
  const caption = optionalText(row, "caption");
  if (path === undefined || path.length > HILL_IMAGE_PATH_MAX || caption === undefined) return null;
  return caption === null ? { path } : { path, caption };
}

function readLink(value: JsonValue | undefined): { label: string; href: string } | null {
  const row = asJsonObject(value);
  const label = asJsonString(row?.label);
  const href = asJsonString(row?.href);
  if (label === undefined || href === undefined || label.length > HILL_RAW_MAX || href.length > HILL_RAW_MAX) return null;
  return { label, href };
}

/**
 * The post fields of a `hill.post` socket request, typed. The bridge fills `from` itself, so a `from`
 * in the request is ignored. A field of the wrong type is refused with the code of its field where the
 * contract has one; a request id, a priority or an expiry of the wrong shape has none (the CLI checks
 * all three before it asks), and the words say so.
 */
export function readPostFields(row: JsonObject): HillPostRead {
  const requestId = asJsonString(row.requestId);
  if (!isRequestId(requestId)) return refused(null, "bad request: a decision's request id is a UUID");
  const title = asJsonString(row.title);
  if (title === undefined || title.length > HILL_RAW_MAX) return refused("bad_title", "a decision needs a title");
  const summary = asJsonString(row.summary);
  if (summary === undefined || summary.length > HILL_RAW_MAX) return refused("bad_summary", "a decision needs a summary");
  const body = optionalText(row, "body");
  if (body === undefined) return refused("bad_body", "the body is text");
  const rawOptions = row.options ?? [];
  if (!Array.isArray(rawOptions) || rawOptions.length > RAW_LIST_MAX) return refused("bad_option", "options are a list");
  const options: HillOption[] = [];
  for (const entry of rawOptions) {
    const option = readOption(entry);
    if (option === null) return refused("bad_option", "an option is an intent and a label");
    options.push(option);
  }
  const textRaw = row.text ?? "optional";
  const text = asJsonString(textRaw);
  if (!isTextMode(text)) return refused("bad_text_mode", "text is none, optional or required");
  let recommends: HillPostInput["recommends"] = null;
  if (row.recommends !== undefined && row.recommends !== null) {
    const rec = asJsonObject(row.recommends);
    const intent = asJsonString(rec?.intent);
    const why = asJsonString(rec?.why);
    if (intent === undefined || why === undefined || why.length > HILL_RAW_MAX) return refused("bad_recommends", "a recommendation is an option's intent and a why");
    recommends = { intent, why };
  }
  const rawLinks = row.links ?? [];
  if (!Array.isArray(rawLinks) || rawLinks.length > RAW_LIST_MAX) return refused("bad_link", "links are a list");
  const links: Array<{ label: string; href: string }> = [];
  for (const entry of rawLinks) {
    const link = readLink(entry);
    if (link === null) return refused("bad_link", "a link is a label and an address");
    links.push(link);
  }
  const priorityRaw = row.priority ?? "today";
  const priority = asJsonString(priorityRaw);
  if (!isPriority(priority)) return refused(null, "bad request: a priority is now, today or later");
  const about = optionalText(row, "about");
  const replyTo = optionalText(row, "replyTo");
  if (about === undefined || replyTo === undefined) return refused("bad_target", "an address is text");
  const supersedes = optionalText(row, "supersedes");
  if (supersedes === undefined || (supersedes !== null && !HILL_ID_RE.test(supersedes))) return refused("bad_supersedes", "supersedes names a decision id, dc_ and 12 characters");
  let expiresAt: number | null = null;
  if (row.expiresAt !== undefined && row.expiresAt !== null) {
    const at = asJsonNumber(row.expiresAt);
    if (at === undefined || !Number.isSafeInteger(at)) return refused(null, "bad request: an expiry is epoch milliseconds");
    expiresAt = at;
  }
  const rawImages = row.images ?? [];
  if (!Array.isArray(rawImages)) return refused("bad_image", "images are a list");
  if (rawImages.length > HILL_MEDIA_MAX) return refused("too_many_images", `a decision has at most ${String(HILL_MEDIA_MAX)} images`);
  const images: HillImageInput[] = [];
  for (const entry of rawImages) {
    const image = readImage(entry);
    if (image === null) return refused("bad_image", "an image is a path and an optional caption");
    images.push(image);
  }
  const input: HillPostInput = { requestId, title, summary, body: body ?? "", options, text, recommends, links, priority, about, replyTo, supersedes, expiresAt, images };
  // The view is the one field read with the schema's own view parser: its refusal names the node.
  if (row.view !== undefined && row.view !== null) {
    // An image node's `ref` names one of this post's images, so the count goes with the view.
    const read = parseDecisionView(row.view, "/view", { images: images.length });
    const first = read.refusals[0];
    if (read.view === undefined) return refused("bad_body", first === undefined ? "the view is refused" : `the view is refused at ${first.path}: ${first.reason}`);
    input.view = read.view;
  }
  return { ok: true, input };
}

/** What `readAnswerRequest` answers: the request, or the words of the 400. */
export type HillAnswerRead = { readonly ok: true; readonly request: HillAnswerRequest; readonly id: string } | { readonly ok: false; readonly error: string };

/**
 * A phone's `POST /api/hill/answer` body, or why it is not one: `rid` a canonical UUID, `node`
 * `hill/<decision id>`, `intent` a string of at most 32 characters, `value.text` a string or null. A body
 * of another shape is a 400 and writes no receipt.
 */
export function readAnswerRequest(value: JsonValue | undefined): HillAnswerRead {
  const row = asJsonObject(value);
  if (row === undefined) return { ok: false, error: "bad body" };
  const rid = asJsonString(row.rid);
  if (!isRequestId(rid)) return { ok: false, error: "bad rid" };
  const node = asJsonString(row.node);
  const id = node === undefined ? null : hillIdOfNode(node);
  if (node === undefined || id === null) return { ok: false, error: "bad node" };
  const intent = asJsonString(row.intent);
  if (intent === undefined || intent === "" || intent.length > 32) return { ok: false, error: "bad intent" };
  const box = asJsonObject(row.value);
  if (box === undefined) return { ok: false, error: "bad value" };
  const text = box.text === null || box.text === undefined ? null : asJsonString(box.text);
  if (text === undefined || (text !== null && text.length > HILL_RAW_MAX)) return { ok: false, error: "bad value" };
  return { ok: true, id, request: { rid, node, intent, value: { text } } };
}

// ── The decisions file ──────────────────────────────────────────────────────────────────────────

function stringOrNull(row: JsonObject, key: string): string | null | undefined {
  if (row[key] === null) return null;
  return asJsonString(row[key]);
}

function numberOrNull(row: JsonObject, key: string): number | null | undefined {
  if (row[key] === null) return null;
  const n = asJsonNumber(row[key]);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}

function readFrom(value: JsonValue | undefined): HillDecision["from"] | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const kind = asJsonString(row.kind);
  const address = stringOrNull(row, "address");
  const trickId = stringOrNull(row, "trickId");
  const memberId = stringOrNull(row, "memberId");
  const harness = stringOrNull(row, "harness");
  const label = asJsonString(row.label);
  const host = stringOrNull(row, "host");
  const trickKey = stringOrNull(row, "trickKey");
  const trickHost = stringOrNull(row, "trickHost");
  if ((kind !== "agent" && kind !== "trick") || address === undefined || trickId === undefined || memberId === undefined) return null;
  if (harness === undefined || label === undefined || host === undefined || trickKey === undefined || trickHost === undefined) return null;
  // A trick's decision names its trick, its key and the bridge its tap goes to. One without them (the dev
  // lane stored some before `trickHost` existed) does not read: the store keeps it raw (store.ts).
  if (kind === "trick" && (trickId === null || trickKey === null || trickHost === null)) return null;
  return { kind, address, trickId, trickKey, memberId, harness, label, host, trickHost };
}

function readTarget(value: JsonValue | undefined): HillDecision["target"] | undefined {
  if (value === null) return null;
  const row = asJsonObject(value);
  const label = asJsonString(row?.label);
  const host = row === undefined ? undefined : stringOrNull(row, "host");
  const unattended = asJsonBoolean(row?.unattended);
  if (label === undefined || host === undefined || unattended === undefined) return undefined;
  return { label, host, unattended };
}

const DELIVERIES = ["typed", "held", "unknown", "none"] as const;

function readAnswer(value: JsonValue | undefined): HillDecision["answer"] | undefined {
  if (value === null) return null;
  const row = asJsonObject(value);
  if (row === undefined) return undefined;
  const rid = asJsonString(row.rid);
  const intent = asJsonString(row.intent);
  const label = stringOrNull(row, "label");
  const text = stringOrNull(row, "text");
  const by = asJsonString(row.by);
  const at = asJsonNumber(row.at);
  const deliveryText = asJsonString(row.delivery);
  const delivery = DELIVERIES.find((candidate) => candidate === deliveryText);
  const trickText = asJsonString(row.trick);
  const trick = HILL_TRICK_DELIVERIES.find((candidate) => candidate === trickText);
  if (rid === undefined || intent === undefined || label === undefined || text === undefined || by === undefined) return undefined;
  if (at === undefined || !Number.isSafeInteger(at) || delivery === undefined || trick === undefined) return undefined;
  // Absent on an answer stored before answers carried the device's record id.
  const deviceId = row.deviceId === undefined ? undefined : asJsonString(row.deviceId);
  if (row.deviceId !== undefined && (deviceId === undefined || !HILL_DEVICE_ID_RE.test(deviceId))) return undefined;
  const answer = { rid, intent, label, text, by, at, delivery, trick };
  return deviceId === undefined ? answer : { ...answer, deviceId };
}

function readStoredOptions(value: JsonValue | undefined): HillOption[] | null {
  if (!Array.isArray(value)) return null;
  const out: HillOption[] = [];
  for (const entry of value) {
    const option = readOption(entry);
    if (option === null) return null;
    out.push(option);
  }
  return out;
}

function readStoredLinks(value: JsonValue | undefined): Array<{ label: string; href: string }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ label: string; href: string }> = [];
  for (const entry of value) {
    const link = readLink(entry);
    if (link === null) return null;
    out.push(link);
  }
  return out;
}

const MEDIA_FIELD_MAX = 4096;

function readOneMedia(value: JsonValue | undefined): HillMedia | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const id = asJsonString(row.id);
  const mimeText = asJsonString(row.mime);
  const mime = HILL_MEDIA_MIMES.find((candidate) => candidate === mimeText);
  const bytes = asJsonNumber(row.bytes);
  const width = numberOrNull(row, "width");
  const height = numberOrNull(row, "height");
  const caption = row.caption === undefined ? undefined : asJsonString(row.caption);
  if (id === undefined || !HILL_MEDIA_ID_RE.test(id) || row.kind !== "image" || mime === undefined) return null;
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0 || width === undefined || height === undefined) return null;
  if (row.caption !== undefined && (caption === undefined || caption.length > MEDIA_FIELD_MAX)) return null;
  const media: HillMedia = { id, kind: "image", mime, bytes, width, height };
  return caption === undefined ? media : { ...media, caption };
}

/** A stored decision's images. Absent reads as none (a file written before images); any bad entry fails the decision. */
function readStoredMedia(value: JsonValue | undefined): HillMedia[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > HILL_MEDIA_MAX) return null;
  const out: HillMedia[] = [];
  for (const entry of value) {
    const media = readOneMedia(entry);
    if (media === null || out.some((held) => held.id === media.id)) return null;
    out.push(media);
  }
  return out;
}

/**
 * A stored decision's view: absent reads as none (a file written before views). One the schema's
 * parser refuses now (a rule a later build tightened) is left out and the decision stays, as the phone
 * does with a view it cannot draw: the person still sees the question and its options.
 *
 * Its image `ref`s are NOT counted against the stored media here. The post checked them against its own
 * images (strict at write); a media entry pruned or lost since must not drop the whole view on read.
 * The phone leaves out an image node whose `ref` has no picture and draws the rest.
 */
function storedView(value: JsonValue | undefined): View | undefined {
  if (value === undefined) return undefined;
  return parseDecisionView(value, "/view").view;
}

/** One decision as the file stored it, or null when any field fails. */
export function readDecision(value: JsonValue | undefined): HillDecision | null {
  const row = asJsonObject(value);
  if (row === undefined || row.v !== 1) return null;
  const id = asJsonString(row.id);
  const requestId = asJsonString(row.requestId);
  const from = readFrom(row.from);
  const about = stringOrNull(row, "about");
  const priority = asJsonString(row.priority);
  const priorityAsked = asJsonString(row.priorityAsked);
  const title = asJsonString(row.title);
  const summary = asJsonString(row.summary);
  const body = asJsonString(row.body);
  const options = readStoredOptions(row.options);
  const text = asJsonString(row.text);
  if (id === undefined || !HILL_ID_RE.test(id) || !isRequestId(requestId) || from === null || about === undefined) return null;
  if (!isPriority(priority) || !isPriority(priorityAsked) || title === undefined || summary === undefined || body === undefined) return null;
  if (options === null || !isTextMode(text)) return null;
  let recommends: HillDecision["recommends"] = null;
  if (row.recommends !== null) {
    const rec = asJsonObject(row.recommends);
    const intent = asJsonString(rec?.intent);
    const why = asJsonString(rec?.why);
    if (intent === undefined || why === undefined) return null;
    recommends = { intent, why };
  }
  const links = readStoredLinks(row.links);
  const replyTo = stringOrNull(row, "replyTo");
  const target = readTarget(row.target);
  const supersedes = stringOrNull(row, "supersedes");
  const supersededBy = stringOrNull(row, "supersededBy");
  const expiresAt = numberOrNull(row, "expiresAt");
  const at = asJsonNumber(row.at);
  const stateText = asJsonString(row.state);
  const closedAt = numberOrNull(row, "closedAt");
  const closedReason = stringOrNull(row, "closedReason");
  const answer = readAnswer(row.answer);
  const media = readStoredMedia(row.media);
  // Absent on a decision stored before posts carried a digest: kept absent.
  const postDigest = row.postDigest === undefined ? undefined : asJsonString(row.postDigest);
  if (media === null || (row.postDigest !== undefined && (postDigest === undefined || !/^[0-9a-f]{64}$/u.test(postDigest)))) return null;
  // Absent on a decision that holds no notification slot: kept absent.
  const pushTag = row.pushTag === undefined ? undefined : asJsonString(row.pushTag);
  if (row.pushTag !== undefined && (pushTag === undefined || !isHillPushTag(pushTag))) return null;
  if (links === null || replyTo === undefined || target === undefined || supersedes === undefined || supersededBy === undefined) return null;
  if (expiresAt === undefined || at === undefined || !Number.isSafeInteger(at) || !isState(stateText)) return null;
  if (closedAt === undefined || closedReason === undefined || answer === undefined) return null;
  const view = storedView(row.view);
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
    options,
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
    state: stateText,
    closedAt,
    closedReason,
    answer,
  };
  if (view !== undefined) decision.view = view;
  if (pushTag !== undefined) decision.pushTag = pushTag;
  return postDigest === undefined ? decision : { ...decision, postDigest };
}

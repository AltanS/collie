// The wire of Morph: a third view of an agent session beside Terminal and Chat. The agent answers a
// request by drawing ONE screen (`collie morph show <file.json>`), in the trick node vocabulary. The
// bridge, the CLI and the web app all import this file by relative path, so it holds types, constants
// and small pure, total readers only. No I/O, no React, no runtime dependency, no `@/` alias.
//
// A SESSION IS ITS WALKY ADDRESS. Morph names a session the way the hill names one (`about`, the
// poster's `from.address`): the walky address of the pane, a plain string. The bridge fills it from
// the local socket for the CLI, never from the request.
//
// A VIEW IS A TRICK PART'S VIEW. `parseMorphView` reads it with the trick parser's full part
// vocabulary (buttons allowed, the `VIEW_LIMITS` caps, a part's byte cap), not the display-only
// Decision reader, and holds it strictly: a node or an attribute the parser would only drop or ignore
// is refused here, so what the agent drew is what the phone draws.
//
// PICTURES ARE THE HILL'S. A screen may carry up to four pictures (`collie morph show --image`), kept by
// the bridge in a second instance of the hill's media store and named by an opaque set id of the hill's
// decision id shape. The view places one with `image` and a `ref` (the index into the pictures), or two
// with `compare`, exactly as a Decision's view does. The trick part parser refuses a `ref` and the
// Decision parser refuses a button, so `parseMorphView` reads every picture subtree with the Decision
// parser and the rest with the part parser, the pictures swapped for a neutral `spacer` (see there).
//
// THE DECISION BLOCK. Beside its view a screen may carry one `choice`: a question and one to five
// options, drawn under the view with the hill's option buttons. Its caps are the hill's option caps.
//
// A SCREEN IS A LIST OF BLOCKS. A block is one top-level node of the view plus a stable id, so an agent
// changes one block (`morph set <id>`) instead of redrawing the screen. In a `morph show` file a
// top-level node may carry `"id"`; the schema refuses `id` on a node, so `parseMorphView` strips the
// top-level ids before it validates and answers them beside the view. The wire carries them in
// `MorphView.blocks`, same length and order as `view`, each with the time it was last set, kept or
// shown (`at`): the phone calls a block older than the operator's latest request STALE. A pending block
// (`morph pending`) holds a `spacer` in the view, so every index stays aligned, and its label in `blocks`.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../json";
import {
  HILL_ID_RE,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_ID_RE,
  HILL_MEDIA_MIMES,
  HILL_OPTION_CONFIRM_MAX,
  HILL_OPTION_DETAIL_MAX,
  HILL_OPTION_LABEL_MAX,
  HILL_OPTIONS_MAX,
  HILL_TITLE_MAX,
  HILL_WHY_MAX,
  type HillMedia,
} from "../hill/wire";
import { DOCUMENT_VERSION, PART_MAX_BYTES, parseDecisionView, parseTrickDocument, VALUE_MAX_BYTES, VIEW_LIMITS, type Refusal, type View, type ViewNode } from "../tricks/schema";

/** A Morph title, in characters. */
export const MORPH_TITLE_MAX = 80;
/**
 * The tail the phone appends to a request sent from Morph: `[rules: <bin> morph help --session <addr>]`,
 * naming the binary's absolute path and the session's own address. The lane path (58 characters) with an
 * address of 30 is about 120, so there is room for a quoted path and a longer address.
 */
export const MORPH_HINT_MAX = 160;
/**
 * The head the phone puts in front of a request sent from Morph, `[morph <address>] from operator:`, in
 * characters. The bridge owns the words, and falls back to `[morph] from operator:` past this cap.
 */
export const MORPH_HEAD_MAX = 120;
/** A `morph start` note, in characters: what the agent does, one line. */
export const MORPH_NOTE_MAX = 80;
/** How long a `start` counts as morphing, in ms. The bridge stops serving an older one; the phone ignores it too. */
export const MORPH_DRAWING_MAX_MS = 10 * 60 * 1000;
/** The longest session key the wire carries. */
export const MORPH_SESSION_MAX = 256;
/** The read route. `?since=<rev>` gives the short answer when nothing moved. */
export const MORPH_ROUTE = "/api/morph";
/** The switch route, a paired device's write. */
export const MORPH_SWITCH_ROUTE = "/api/morph/switch";

/** Pictures one screen carries, in all: a show's and every later block's together. Morph's own cap. */
export const MORPH_MEDIA_MAX = 4;
/** The largest picture Morph keeps, in bytes actually read. Morph's own cap, checked before and after the read. */
export const MORPH_MEDIA_BYTES_MAX = 2 * 1024 * 1024;
/** The bytes one session's picture set may hold on disk. */
export const MORPH_SET_BYTES_MAX = 8 * 1024 * 1024;
/** A picture's caption, in characters: the hill's. */
export const MORPH_CAPTION_MAX = HILL_MEDIA_CAPTION_MAX;
/** A picture set's id: the hill's decision id shape (`dc_` and 12 characters), minted by the bridge per set. */
export const MORPH_SET_RE = HILL_ID_RE;
/** A picture's id: the hill's media id shape, minted by the bridge. */
export const MORPH_MEDIA_ID_RE = HILL_MEDIA_ID_RE;
/** Where the phone reads a picture's bytes: `${MORPH_MEDIA_ROUTE}<set id>/<media id>`. */
export const MORPH_MEDIA_ROUTE = "/api/morph/media/";

/** One picture of a screen, as the bridge kept it: the hill's media shape. */
export type MorphMedia = HillMedia;

/** The route a picture's bytes are read at. Both ids are checked by the bridge before any path is built. */
export function morphMediaPath(set: string, mediaId: string): string {
  return `${MORPH_MEDIA_ROUTE}${encodeURIComponent(set)}/${encodeURIComponent(mediaId)}`;
}

/** The decision block's question, in characters: the hill's title cap. */
export const MORPH_QUESTION_MAX = HILL_TITLE_MAX;
/** Options in one decision block: the hill's. */
export const MORPH_OPTIONS_MAX = HILL_OPTIONS_MAX;

/** One option of the decision block. */
export interface MorphOption {
  /** At most {@link HILL_OPTION_LABEL_MAX} characters, one line. */
  label: string;
  /** At most {@link HILL_OPTION_DETAIL_MAX} characters, one line. */
  detail?: string;
  /** The text sent back after the label; absent, the label alone is sent. At most 1 KiB, one line. */
  value?: string;
  /** A short word for the second tap, at most {@link HILL_OPTION_CONFIRM_MAX} characters. */
  confirm?: string;
  /** A picture ref: this option's preview. */
  preview?: number;
}

/** The decision block a screen may carry beside its view: one decision per screen. */
export interface MorphChoice {
  /** At most {@link MORPH_QUESTION_MAX} characters, drawn as the block's heading. */
  question?: string;
  /** One to {@link MORPH_OPTIONS_MAX}. */
  options: MorphOption[];
  /** The option the agent suggests (an index into `options`), and why. Never pre-selected. */
  recommends?: { option: number; why?: string };
  /** A settled decision: the option that was picked. The block then draws as done and takes no tap. */
  picked?: number;
}

/** A block id: 1 to 32 of a-z, 0-9 and `-`. `choice` names the decision block in `morph keep`, never a block. */
export const MORPH_BLOCK_ID_RE = /^[a-z0-9-]{1,32}$/u;
/** The word `morph keep` names the decision block with. */
export const MORPH_CHOICE_BLOCK = "choice";
/** A pending block's label, in characters. */
export const MORPH_PENDING_MAX = 40;
/** The `morph start` notes one drawing run keeps, newest last. */
export const MORPH_NOTES_MAX = 8;

/** One block of a screen: the top-level node at the same index of `view`. */
export interface MorphBlock {
  /** Stable across `set`, `keep` and `pending`; minted `b1`, `b2`… for a node shown without one. */
  id: string;
  /** ISO time the bridge last set, kept or showed this block. Older than the latest request: stale. */
  at: string;
  /** A placeholder's label, at most {@link MORPH_PENDING_MAX} characters: the block is in work, its view node is a `spacer`. */
  pending?: string;
}

/** The screen the agent drew last for one session. */
export interface MorphView {
  /** Rises with every show for this session. */
  rev: number;
  /** ISO time of the show. */
  at: string;
  /** At most {@link MORPH_TITLE_MAX} characters, one line. */
  title?: string;
  /** A trick part's view, checked by {@link parseMorphView}. Buttons allowed, pictures by `ref`. */
  view: View;
  /** The picture set's id, present exactly when `media` is. */
  set?: string;
  /** Up to {@link MORPH_MEDIA_MAX} pictures, in the order given. A view's `ref` and an option's `preview` index into it. */
  media?: MorphMedia[];
  /** The decision block under the view. */
  choice?: MorphChoice;
  /** ISO time the decision block was last set, kept or shown. Present with `choice`. */
  choiceAt?: string;
  /** One per top-level node of `view`, same order. Absent on a screen stored before blocks: {@link morphBlocksOf} derives them. */
  blocks?: MorphBlock[];
}

/** One `morph start` note, with the time it came. */
export interface MorphNote {
  at: string;
  note: string;
}

/** The agent called `morph start`: it is drawing, and has not shown yet. */
export interface MorphDrawing {
  /** ISO time of the start. */
  at: string;
  /** What the agent says it does, at most {@link MORPH_NOTE_MAX} characters, one line. */
  note?: string;
  /**
   * The notes of this drawing run, oldest first, at most {@link MORPH_NOTES_MAX}: every `start` with a note
   * appends one; a run ends with a `show`, a `clear`, the switch going off, or ten minutes. Each carries
   * its time, so the phone lists only the notes of the operator's latest request.
   */
  notes?: MorphNote[];
}

/** One session's Morph. */
export interface MorphSession {
  /** The session's walky address, the key the hill names a session with. */
  session: string;
  on: boolean;
  /**
   * The head the phone puts in front of a request sent from Morph (`[morph <address>] from operator:`), so
   * the terminal shows who wrote and for which session. Absent from an older bridge: the phone then sends no head.
   */
  head?: string;
  /**
   * The tail the phone appends to a request sent from Morph (`[rules: ...]`). The bridge owns the wording.
   * Absent while the session holds the rules (its last `morph start --rules` carried the bridge's id): the
   * request then goes with the head alone.
   */
  hint?: string;
  /** The current view. Absent before the first show and after a clear. */
  view?: MorphView;
  /** The agent's `morph start`, until the next show, a clear, the switch going off, or ten minutes. Optional: an older reader ignores it. */
  drawing?: MorphDrawing;
}

/** What `GET /api/morph[?since=<rev>]` answers. */
export interface MorphAnswer {
  /** The Morph revision. It also rides on the snapshot as `morphRev`. */
  rev: number;
  /** True when the caller's `since` equals `rev`. Then `sessions` is empty and means nothing. */
  unchanged?: true;
  sessions: MorphSession[];
}

/** What the phone sends to `POST /api/morph/switch`. */
export interface MorphSwitchBody {
  session: string;
  on: boolean;
}

/** What `parseMorphView` answers: the view when it passed, else every refusal with a pointer under `path`. */
export interface ParsedMorphView {
  view?: View;
  refusals: Refusal[];
  /** The top-level block ids the view named, one per node, null where a node named none. */
  ids?: (string | null)[];
}

/** What `parseMorphView` may know of the screen around the view. */
export interface MorphViewOptions {
  /** How many pictures the screen holds. Given, a `ref` past them is refused; absent, any `ref` from 0 to 3 passes. */
  images?: number;
}

const PROBE_PART_ID = "morph";
const PROBE_PREFIX = "/parts/0/view";
/** The path a picture subtree is read under by the Decision parser; its refusals are mapped back. */
const PICTURE_PROBE = "/~picture";
/** The node a picture subtree is swapped for while the part parser reads the rest: valid wherever a picture is. */
const NEUTRAL_NODE: JsonObject = { kind: "spacer" };
/** How deep the picture walk looks. Past the part parser's own depth cap the part parser refuses anyway. */
const PICTURE_WALK_DEPTH = VIEW_LIMITS.depth.max + 1;

/** Map a refusal's pointer inside the probe document onto the caller's own `path`. */
function rebase(refusal: Refusal, path: string): Refusal {
  const inner = refusal.path.startsWith(PROBE_PREFIX) ? refusal.path.slice(PROBE_PREFIX.length) : "";
  return { code: refusal.code, path: `${path}${inner}`, reason: refusal.reason };
}

/** A picture subtree: where it sits (index steps through `kids`) and the raw node. */
interface PictureAt {
  readonly steps: readonly number[];
  readonly node: JsonValue;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The node's `kids` as a JSON list, or undefined. */
function rawKids(node: JsonValue | undefined): JsonValue[] | undefined {
  const obj = asJsonObject(node);
  return obj !== undefined && Array.isArray(obj.kids) ? obj.kids : undefined;
}

/** An `image` that names a picture by `ref` (the Decision form), not a trick file by `src`. */
function isRefImage(node: JsonValue | undefined): boolean {
  const obj = asJsonObject(node);
  return obj?.kind === "image" && asJsonObject(obj.attrs)?.ref !== undefined;
}

/** A picture subtree: an image by `ref`, or a `compare` with at least one such image. A compare of `src` images stays the part's. */
function isPictureNode(node: JsonValue | undefined): boolean {
  if (isRefImage(node)) return true;
  return asJsonObject(node)?.kind === "compare" && (rawKids(node) ?? []).some(isRefImage);
}

/** Every picture subtree of a raw view, outermost only, with its place. Total on any JSON. */
function picturesIn(raw: readonly JsonValue[]): PictureAt[] {
  const found: PictureAt[] = [];
  const walk = (nodes: readonly JsonValue[], steps: readonly number[]): void => {
    if (steps.length >= PICTURE_WALK_DEPTH) return;
    nodes.forEach((node, i) => {
      const at = [...steps, i];
      if (isPictureNode(node)) {
        found.push({ steps: at, node });
        return;
      }
      const kids = rawKids(node);
      if (kids !== undefined) walk(kids, at);
    });
  };
  walk(raw, []);
  return found;
}

/** The JSON pointer of a place under `path`: `/0/kids/2`. */
function pointerOf(path: string, steps: readonly number[]): string {
  return steps.reduce((acc, step, depth) => `${acc}${depth === 0 ? "" : "/kids"}/${String(step)}`, path);
}

/** A raw list with the node at `steps` replaced, every list on the way copied. */
function replacedRaw(nodes: readonly JsonValue[], steps: readonly number[], next: JsonValue): JsonValue[] {
  const [head, ...rest] = steps;
  if (head === undefined) return [...nodes];
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) return next;
    const obj = asJsonObject(node);
    const kids = rawKids(node);
    if (obj === undefined || kids === undefined) return node;
    return { ...obj, kids: replacedRaw(kids, rest, next) };
  });
}

/** A parsed list with the node at `steps` replaced, every list on the way copied. */
function replacedNode(nodes: readonly ViewNode[], steps: readonly number[], next: ViewNode): ViewNode[] {
  const [head, ...rest] = steps;
  if (head === undefined) return [...nodes];
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) return next;
    if (!("kids" in node) || !Array.isArray(node.kids)) return node;
    return Object.assign({}, node, { kids: replacedNode(node.kids, rest, next) });
  });
}

/** Every node of a raw view, kids counted, as far as the walk depth. */
function rawNodeCount(nodes: readonly JsonValue[], depth = 0): number {
  if (depth > PICTURE_WALK_DEPTH) return 0;
  return nodes.reduce<number>((sum, node) => sum + 1 + rawNodeCount(rawKids(node) ?? [], depth + 1), 0);
}

/** Read the view as a trick part's view, through the parser's only public way in. */
function parseAsPart(raw: JsonValue, path: string): ParsedMorphView {
  const doc: JsonValue = { v: DOCUMENT_VERSION, parts: [{ at: "session", id: PROBE_PART_ID, view: raw }] };
  const parsed = parseTrickDocument(doc);
  const refusals = [...parsed.refusals, ...parsed.notes].map((r) => rebase(r, path));
  if (refusals.length > 0) return { refusals };
  const part = parsed.parts[0];
  if (part?.place !== "session") return { refusals: [{ code: "type", path, reason: "The view did not read as a screen." }] };
  return { view: part.part.view, refusals: [] };
}

/** Read one picture subtree with the Decision parser, as a one-node view, its refusals under its own place. */
function parsePicture(picture: PictureAt, path: string, opts: MorphViewOptions): { node?: ViewNode; refusals: Refusal[] } {
  const own = pointerOf(path, picture.steps);
  const probeNode = `${PICTURE_PROBE}/0`;
  const parsed = parseDecisionView([picture.node], PICTURE_PROBE, opts.images === undefined ? {} : { images: opts.images });
  const refusals = parsed.refusals.map((r) => {
    const inner = r.path.startsWith(probeNode) ? r.path.slice(probeNode.length) : "";
    return { code: r.code, path: `${own}${inner}`, reason: r.reason };
  });
  const node = parsed.view?.[0];
  return refusals.length > 0 || node === undefined ? { refusals } : { node, refusals: [] };
}

/**
 * Read a Morph view: a list of nodes in a trick part's vocabulary, under the part caps, with pictures
 * by `ref` as a Decision's view takes them. Total: garbage is a refusal, never a throw. Strict: what the
 * tolerant trick read would drop or ignore is refused.
 *
 * The part parser refuses a `ref` and the Decision parser refuses a button, and the schema is not
 * Morph's to change. So the view is read in two passes over the same JSON: every picture subtree (an
 * `image` with a `ref`, a `compare` holding one) is read alone by the Decision parser, with the screen's
 * picture count, and the rest by the part parser with each picture swapped for a `spacer`, which is
 * valid everywhere a picture is, so every index, path and depth stays. The part's byte and node caps are
 * checked on the ORIGINAL view, which the swap only makes smaller. The view answered holds the original
 * picture nodes in their places.
 */
export function parseMorphView(raw: JsonValue | undefined, path = "/view", opts: MorphViewOptions = {}): ParsedMorphView {
  if (raw === undefined) return { refusals: [{ code: "missing", path, reason: 'A Morph screen needs "view": a list of nodes.' }] };
  if (!Array.isArray(raw)) return parseAsPart(raw, path);
  const split = splitBlockIds(raw, path);
  const parsed = parseNodes(split.nodes, path, opts);
  const refusals = [...split.refusals, ...parsed.refusals];
  if (refusals.length > 0 || parsed.view === undefined) return { refusals };
  return { view: parsed.view, refusals: [], ids: split.ids };
}

/** The top-level nodes without their `id`, the ids in order, and a refusal for each id off its pattern or named twice. */
/** A view's top-level nodes split from their block ids. */
interface SplitBlockIds {
  nodes: JsonValue[];
  ids: (string | null)[];
  refusals: Refusal[];
}

function splitBlockIds(raw: readonly JsonValue[], path: string): SplitBlockIds {
  const refusals: Refusal[] = [];
  const ids: (string | null)[] = [];
  const nodes = raw.map((node, i) => {
    const obj = asJsonObject(node);
    if (obj === undefined || obj.id === undefined) {
      ids.push(null);
      return node;
    }
    const { id: rawId, ...rest } = obj;
    const id = asJsonString(rawId);
    const at = `${path}/${String(i)}/id`;
    const isBad = id === undefined || !MORPH_BLOCK_ID_RE.test(id) || id === MORPH_CHOICE_BLOCK;
    if (isBad) refusals.push({ code: "id", path: at, reason: `A block id is 1 to 32 of a-z, 0-9 and -, and not "${MORPH_CHOICE_BLOCK}".` });
    if (!isBad && ids.includes(id)) refusals.push({ code: "duplicate", path: at, reason: `Two blocks share the id "${id}".` });
    ids.push(id ?? null);
    return rest;
  });
  return { nodes, ids, refusals };
}

/** A view's nodes, ids already stripped: pictures by the Decision parser, the rest by the part parser. */
function parseNodes(raw: JsonValue[], path: string, opts: MorphViewOptions): ParsedMorphView {
  const pictures = picturesIn(raw);
  if (pictures.length === 0) return parseAsPart(raw, path);
  const refusals: Refusal[] = [];
  const bytes = utf8Length(JSON.stringify(raw));
  if (bytes > PART_MAX_BYTES) refusals.push({ code: "size", path, reason: `The view is ${String(bytes)} bytes. A screen holds at most ${String(PART_MAX_BYTES / 1024)} KiB of compact JSON.` });
  const nodes = rawNodeCount(raw);
  if (nodes > VIEW_LIMITS.nodes.max) refusals.push({ code: "count", path, reason: `The view holds ${String(nodes)} nodes. A screen holds at most ${String(VIEW_LIMITS.nodes.max)}.` });
  const read = pictures.map((picture) => ({ picture, ...parsePicture(picture, path, opts) }));
  const swapped = pictures.reduce<JsonValue[]>((list, picture) => replacedRaw(list, picture.steps, NEUTRAL_NODE), raw);
  const rest = parseAsPart(swapped, path);
  refusals.push(...rest.refusals, ...read.flatMap((r) => r.refusals));
  if (refusals.length > 0 || rest.view === undefined) return { refusals };
  let view: View = rest.view;
  for (const r of read) {
    if (r.node === undefined) return { refusals: [{ code: "type", path: pointerOf(path, r.picture.steps), reason: "The picture did not read." }] };
    view = replacedNode(view, r.picture.steps, r.node);
  }
  return { view, refusals: [] };
}

// ── the decision block ───────────────────────────────────────────────────────────────────────

/** What `parseMorphChoice` answers: the block when it passed, else every refusal with a pointer under `path`. */
export interface ParsedMorphChoice {
  choice?: MorphChoice;
  refusals: Refusal[];
}

const CHOICE_KEYS = ["question", "options", "recommends", "picked"] as const;
const OPTION_KEYS = ["label", "detail", "value", "confirm", "preview"] as const;
const RECOMMENDS_KEYS = ["option", "why"] as const;

/** Keys of an object outside `allowed`, each refused once. */
function unknownKeys(obj: JsonObject, allowed: readonly string[], path: string, what: string): Refusal[] {
  return Object.keys(obj)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ code: "unknown-key" as const, path: `${path}/${key}`, reason: `${what} takes ${allowed.map((k) => `"${k}"`).join(", ")}, not "${key}".` }));
}

/** A text field as read: its clean line, its refusal, or neither when it is absent. */
interface LineRead {
  value?: string;
  refusal?: Refusal;
}

/** An option as read: the option when it passed, else its refusals. */
interface OptionRead {
  option?: MorphOption;
  refusals: Refusal[];
}

/** One line of 1 to `max` characters once trimmed, or the refusal. Absent reads as undefined. */
function lineField(obj: JsonObject, key: string, max: number, path: string, what: string): LineRead {
  const raw = obj[key];
  if (raw === undefined) return {};
  const text = asJsonString(raw);
  const line = text === undefined ? null : cleanMorphLine(text, max);
  if (line === null) return { refusal: { code: "text", path: `${path}/${key}`, reason: `${what} is one line of 1 to ${String(max)} characters.` } };
  return { value: line };
}

/** A whole number from 0 below `count`, or null. */
function indexBelow(value: JsonValue | undefined, count: number): number | null {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 && n < count ? n : null;
}

function readOption(raw: JsonValue | undefined, path: string, images: number): OptionRead {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path, reason: 'An option is an object: { "label", "detail"?, "value"?, "confirm"?, "preview"? }.' }] };
  const refusals = unknownKeys(obj, OPTION_KEYS, path, "An option");
  const label = lineField(obj, "label", HILL_OPTION_LABEL_MAX, path, "An option's label");
  if (obj.label === undefined) refusals.push({ code: "missing", path: `${path}/label`, reason: `An option needs "label", 1 to ${String(HILL_OPTION_LABEL_MAX)} characters.` });
  const detail = lineField(obj, "detail", HILL_OPTION_DETAIL_MAX, path, "An option's detail");
  const confirm = lineField(obj, "confirm", HILL_OPTION_CONFIRM_MAX, path, "An option's confirm word");
  const value = lineField(obj, "value", VALUE_MAX_BYTES, path, "An option's value");
  for (const field of [label, detail, confirm, value]) if (field.refusal !== undefined) refusals.push(field.refusal);
  if (value.value !== undefined && utf8Length(value.value) > VALUE_MAX_BYTES) refusals.push({ code: "size", path: `${path}/value`, reason: `An option's value is at most ${String(VALUE_MAX_BYTES)} bytes.` });
  const preview = obj.preview === undefined ? undefined : indexBelow(obj.preview, images);
  if (preview === null) {
    const held = images === 0 ? "the screen holds no pictures; add one with --image" : `0 to ${String(images - 1)}`;
    refusals.push({ code: "range", path: `${path}/preview`, reason: `"preview" is a picture ref, a whole number: ${held}.` });
  }
  if (refusals.length > 0 || label.value === undefined) return { refusals };
  const option: MorphOption = { label: label.value };
  if (detail.value !== undefined) option.detail = detail.value;
  if (value.value !== undefined) option.value = value.value;
  if (confirm.value !== undefined) option.confirm = confirm.value;
  if (preview !== undefined && preview !== null) option.preview = preview;
  return { option, refusals: [] };
}

/**
 * Read a decision block: `{ question?, options: [1 to 5], recommends? }`, with the hill's option caps.
 * `images` is how many pictures the screen holds: an option's `preview` must name one. Total and strict,
 * as {@link parseMorphView}: an unknown key is refused, a text past its cap is refused, never cut.
 */
export function parseMorphChoice(raw: JsonValue | undefined, path = "/choice", { images }: { images: number }): ParsedMorphChoice {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { refusals: [{ code: "type", path, reason: 'A choice is an object: { "question"?, "options": [...], "recommends"? }.' }] };
  const refusals = unknownKeys(obj, CHOICE_KEYS, path, "A choice");
  const question = lineField(obj, "question", MORPH_QUESTION_MAX, path, "A choice's question");
  if (question.refusal !== undefined) refusals.push(question.refusal);
  const list = Array.isArray(obj.options) ? obj.options : null;
  if (list === null || list.length < 1 || list.length > MORPH_OPTIONS_MAX) {
    refusals.push({ code: "count", path: `${path}/options`, reason: `A choice has 1 to ${String(MORPH_OPTIONS_MAX)} options.` });
    return { refusals };
  }
  const options: MorphOption[] = [];
  list.forEach((item, i) => {
    const read = readOption(item, `${path}/options/${String(i)}`, images);
    refusals.push(...read.refusals);
    if (read.option === undefined) return;
    if (options.some((other) => other.label === read.option?.label)) {
      refusals.push({ code: "duplicate", path: `${path}/options/${String(i)}/label`, reason: `Two options share the label "${read.option.label}"; the pick is sent by its label.` });
    }
    options.push(read.option);
  });
  const recommends = obj.recommends === undefined ? undefined : readRecommends({ raw: obj.recommends, path: `${path}/recommends`, options: list.length, refusals });
  const picked = obj.picked === undefined ? undefined : indexBelow(obj.picked, list.length);
  if (picked === null) refusals.push({ code: "range", path: `${path}/picked`, reason: `"picked" is the picked option's index, 0 to ${String(list.length - 1)}.` });
  if (refusals.length > 0) return { refusals };
  const choice: MorphChoice = { options };
  if (question.value !== undefined) choice.question = question.value;
  if (recommends !== undefined) choice.recommends = recommends;
  if (picked !== undefined && picked !== null) choice.picked = picked;
  return { choice, refusals: [] };
}

/** A choice's `recommends`: `{ option, why? }`, its refusals pushed onto `refusals`; undefined when it did not pass. */
function readRecommends({ raw, path, options, refusals }: { raw: JsonValue; path: string; options: number; refusals: Refusal[] }): MorphChoice["recommends"] {
  const rec = asJsonObject(raw);
  if (rec === undefined) {
    refusals.push({ code: "type", path, reason: 'A recommendation is { "option": <index>, "why"? }.' });
    return undefined;
  }
  refusals.push(...unknownKeys(rec, RECOMMENDS_KEYS, path, "A recommendation"));
  const option = indexBelow(rec.option, options);
  if (option === null) refusals.push({ code: "range", path: `${path}/option`, reason: `"option" is an option's index, 0 to ${String(options - 1)}.` });
  const why = lineField(rec, "why", HILL_WHY_MAX, path, "The why");
  if (why.refusal !== undefined) refusals.push(why.refusal);
  if (option === null) return undefined;
  return why.value === undefined ? { option } : { option, why: why.value };
}

// ── pictures ─────────────────────────────────────────────────────────────────────────────────

/** A picture's side off its header: a whole number above 0, or null when the bridge could not read it. Undefined: it does not fit. */
function sideOf(value: JsonValue | undefined): number | null | undefined {
  if (value === null) return null;
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** One stored or served picture, or null when any field does not fit. */
export function readMorphMedia(raw: JsonValue | undefined): MorphMedia | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const id = asJsonString(obj.id);
  const mime = HILL_MEDIA_MIMES.find((m) => m === obj.mime);
  const bytes = asJsonNumber(obj.bytes);
  if (id === undefined || !MORPH_MEDIA_ID_RE.test(id) || obj.kind !== "image" || mime === undefined) return null;
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MORPH_MEDIA_BYTES_MAX) return null;
  const width = sideOf(obj.width);
  const height = sideOf(obj.height);
  if (width === undefined || height === undefined) return null;
  const media: MorphMedia = { id, kind: "image", mime, bytes, width, height };
  if (obj.caption === undefined) return media;
  const caption = asJsonString(obj.caption);
  if (caption === undefined || cleanMorphLine(caption, MORPH_CAPTION_MAX) !== caption) return null;
  media.caption = caption;
  return media;
}

/** A stored or served picture set: `{ set, media }` both, or neither. Null when it does not fit. */
function readMorphSet(obj: JsonObject): { set: string; media: MorphMedia[] } | "none" | null {
  if (obj.set === undefined && obj.media === undefined) return "none";
  const set = asJsonString(obj.set);
  if (set === undefined || !MORPH_SET_RE.test(set) || !Array.isArray(obj.media)) return null;
  if (obj.media.length < 1 || obj.media.length > MORPH_MEDIA_MAX) return null;
  const media = obj.media.map(readMorphMedia);
  if (media.some((m) => m === null)) return null;
  return { set, media: media.filter((m): m is MorphMedia => m !== null) };
}

/** One line, trimmed, no control character. Null when it is empty or longer than `max`. */
export function cleanMorphLine(text: string, max: number): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  const line = text.trim();
  if (line.length === 0 || line.length > max) return null;
  return line;
}

function isRev(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTime(text: string): boolean {
  return Number.isFinite(Date.parse(text));
}

function isSessionKey(text: string | undefined): text is string {
  return text !== undefined && cleanMorphLine(text, MORPH_SESSION_MAX) === text;
}

/** One stored or served block, or null when a field does not fit. */
function readMorphBlock(raw: JsonValue | undefined): MorphBlock | null {
  const obj = asJsonObject(raw);
  const id = asJsonString(obj?.id);
  const at = asJsonString(obj?.at);
  if (obj === undefined || id === undefined || !MORPH_BLOCK_ID_RE.test(id) || id === MORPH_CHOICE_BLOCK || at === undefined || !isIsoTime(at)) return null;
  if (obj.pending === undefined) return { id, at };
  const pending = asJsonString(obj.pending);
  if (pending === undefined || cleanMorphLine(pending, MORPH_PENDING_MAX) !== pending) return null;
  return { id, at, pending };
}

/** A view's blocks: one per node, unique ids. Null when the list does not fit the view. */
function readMorphBlocks(raw: JsonValue, length: number): MorphBlock[] | null {
  if (!Array.isArray(raw) || raw.length !== length) return null;
  const blocks = raw.map(readMorphBlock);
  if (blocks.some((block) => block === null)) return null;
  const kept = blocks.filter((block): block is MorphBlock => block !== null);
  return new Set(kept.map((block) => block.id)).size === kept.length ? kept : null;
}

/** A screen's blocks: the wire's, or `b1`, `b2`… stamped at the screen's own time for a screen stored before blocks. */
export function morphBlocksOf(view: MorphView): MorphBlock[] {
  return view.blocks ?? view.view.map((_, i) => ({ id: `b${String(i + 1)}`, at: view.at }));
}

/** The first `b<n>` id none of `taken` holds. Of `b1` to `b<size + 1>` at least one is free. */
export function nextBlockId(taken: ReadonlySet<string>): string {
  const free = Array.from({ length: taken.size + 1 }, (_, i) => `b${String(i + 1)}`).find((id) => !taken.has(id));
  if (free === undefined) throw new Error("morph: no free block id among size + 1 candidates");
  return free;
}

/** A stored or served view, or null when any field does not fit. */
export function readMorphView(raw: JsonValue | undefined): MorphView | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const rev = asJsonNumber(obj.rev);
  const at = asJsonString(obj.at);
  if (!isRev(rev) || at === undefined || !isIsoTime(at)) return null;
  const pictures = readMorphSet(obj);
  if (pictures === null) return null;
  const images = pictures === "none" ? 0 : pictures.media.length;
  const parsed = parseMorphView(obj.view, "/view", { images });
  if (parsed.view === undefined) return null;
  const out: MorphView = { rev, at, view: parsed.view };
  if (pictures !== "none") {
    out.set = pictures.set;
    out.media = pictures.media;
  }
  if (obj.choice !== undefined) {
    const choice = parseMorphChoice(obj.choice, "/choice", { images });
    if (choice.choice === undefined) return null;
    out.choice = choice.choice;
    const choiceAt = obj.choiceAt === undefined ? at : asJsonString(obj.choiceAt);
    if (choiceAt === undefined || !isIsoTime(choiceAt)) return null;
    out.choiceAt = choiceAt;
  }
  if (obj.blocks !== undefined) {
    const blocks = readMorphBlocks(obj.blocks, parsed.view.length);
    if (blocks === null) return null;
    out.blocks = blocks;
  }
  if (obj.title === undefined) return out;
  const title = asJsonString(obj.title);
  if (title === undefined || cleanMorphLine(title, MORPH_TITLE_MAX) !== title) return null;
  out.title = title;
  return out;
}

/**
 * An address as one shell word: bare when its characters are safe, in single quotes when not, null when
 * it cannot be quoted (an empty text, a control character or a quote). The hint and `morph help` print
 * it so a line can be copied as it stands.
 */
export function morphShellWord(address: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (address === "" || /[\u0000-\u001f\u007f']/u.test(address)) return null;
  return /^[\w./:%@+=,-]+(#[\w./:%@+=,-]*)*$/u.test(address) ? address : `'${address}'`;
}

/** A stored or served drawing mark, or null when any field does not fit. */
export function readMorphDrawing(raw: JsonValue | undefined): MorphDrawing | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const at = asJsonString(obj.at);
  if (at === undefined || !isIsoTime(at)) return null;
  const out: MorphDrawing = { at };
  if (obj.note !== undefined) {
    const note = asJsonString(obj.note);
    if (note === undefined || cleanMorphLine(note, MORPH_NOTE_MAX) !== note) return null;
    out.note = note;
  }
  // Notes that do not fit are left out, one by one: the drawing stays, as a view does in a session.
  const notes = Array.isArray(obj.notes) ? obj.notes.slice(-MORPH_NOTES_MAX).flatMap((item) => readMorphNote(item) ?? []) : [];
  if (notes.length > 0) out.notes = notes;
  return out;
}

function readMorphNote(raw: JsonValue | undefined): MorphNote | null {
  const obj = asJsonObject(raw);
  const at = asJsonString(obj?.at);
  const note = asJsonString(obj?.note);
  if (at === undefined || !isIsoTime(at) || note === undefined || cleanMorphLine(note, MORPH_NOTE_MAX) !== note) return null;
  return { at, note };
}

/**
 * One session, or null when its key, switch or a given hint does not fit. A view that does not fit is left out
 * and the session kept: the switch still reads, and the phone shows no screen rather than half of one.
 */
export function readMorphSession(raw: JsonValue | undefined): MorphSession | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  if (!isSessionKey(session) || on === undefined) return null;
  const out: MorphSession = { session, on };
  // No hint is a session that holds the rules; a hint that does not fit drops the session, as before.
  if (obj.hint !== undefined) {
    const hint = asJsonString(obj.hint);
    if (hint === undefined || cleanMorphLine(hint, MORPH_HINT_MAX) !== hint) return null;
    out.hint = hint;
  }
  // A head that does not fit is left out, as an older bridge's would be: the request goes without one.
  const head = obj.head === undefined ? undefined : asJsonString(obj.head);
  if (head !== undefined && cleanMorphLine(head, MORPH_HEAD_MAX) === head) out.head = head;
  const view = obj.view === undefined ? null : readMorphView(obj.view);
  if (view !== null) out.view = view;
  // A drawing that does not fit is left out, as a view is: the session stays.
  const drawing = obj.drawing === undefined ? null : readMorphDrawing(obj.drawing);
  if (drawing !== null) out.drawing = drawing;
  return out;
}

/** The read route's answer, or null when its rev or list does not fit. A session that does not fit is dropped. */
export function readMorphAnswer(raw: JsonValue | undefined): MorphAnswer | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const rev = asJsonNumber(obj.rev);
  if (!isRev(rev)) return null;
  if (obj.unchanged === true) return { rev, unchanged: true, sessions: [] };
  if (!Array.isArray(obj.sessions)) return null;
  const sessions: MorphSession[] = [];
  for (const item of obj.sessions) {
    const session = readMorphSession(item);
    if (session !== null) sessions.push(session);
  }
  return { rev, sessions };
}

/** The switch body, or null when it is not exactly `{ session, on }`. */
export function readMorphSwitchBody(raw: JsonValue | undefined): MorphSwitchBody | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  if (Object.keys(obj).some((key) => key !== "session" && key !== "on")) return null;
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  if (!isSessionKey(session) || on === undefined) return null;
  return { session, on };
}

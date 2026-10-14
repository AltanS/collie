// The id rule, the string cleaning and the caps of the wire (WIRE.md sections 6). Pure functions, no I/O, no
// runtime import: this file runs in Bun and in a Cloudflare Worker.

import { sha256Hex } from "./hash.ts";
import type { Json, JsonObject, Progress, ProgressStep } from "./types.ts";

/** Bytes per field. UTF-8 bytes, not code points. */
export const CAPS = {
  id: 128,
  hostName: 64,
  title: 256,
  askTitle: 256,
  starterLabel: 128,
  optionLabel: 128,
  harness: 64,
  cwd: 4096,
  reason: 2048,
  toolName: 128,
  summary: 1024,
  output: 16384,
  text: 65536,
  /** `markdown` and `code` item text. */
  richText: 32768,
  ts: 40,
  settledReason: 128,
  message: 512,
  sendText: 32768,
  note: 2048,
  body: 65536,
  /** A history cursor (WIRE.md 7.16): printable ASCII, no space. */
  historyCursor: 512,
  /** The smallest `sun_path` limit of the platforms Collie runs on (macOS 104), less the closing NUL. */
  socketPath: 103,
} as const;

/** List caps. */
export const LIMITS = {
  /** Options of a `choice` ask or of a choice field (WIRE.md 7.14). A `permission` has `options`. */
  choiceOptions: 8,
  /** Fields of a `form` ask. */
  formFields: 6,
  workspaces: 64,
  tabs: 256,
  panes: 256,
  openAsksPerPane: 50,
  options: 6,
  starters: 50,
  /** Belt actions per pane (WIRE.md section 4, `PaneAction`). */
  actions: 4,
  eventsPerReply: 1000,
  resetItems: 2000,
  /** The program keeps at least this many request ids per epoch. */
  requestIds: 500,
  /** Conversations per page of `GET /conversations` (WIRE.md 7.16). */
  conversationsPerPage: 100,
  /** Items per page of `GET /conversation/:id/items` (WIRE.md 7.16). */
  historyItems: 1000,
  /** The events reply may not pass 8 MiB. This leaves room for the envelope. */
  replyBytes: 8_000_000,
} as const;

/** UTF-8 bytes of a string, without encoding it. A lone surrogate counts 3, as its U+FFFD replacement does. */
export function bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ── Reading untyped input ──────────────────────────────────────────────────────
// A request body, a model's tool arguments and a value a JavaScript caller passes past the types all arrive here
// unchecked. The guards below are the one place a `typeof` reads such a value: each is a type predicate, so the
// check IS the decode, and every reader after them branches on what they established.

/** A string. */
export function isText(value: Json | undefined): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the rule's allowInTypeGuards case: in a type guard, "external values must be decoded into meaningful types at their I/O boundary".
  return typeof value === "string";
}

/** A JSON object: not null and not a list. */
export function isRecord(value: Json | undefined): value is JsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the rule's allowInTypeGuards case: in a type guard, "external values must be decoded into meaningful types at their I/O boundary".
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list. */
export function isList(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

/** `true` or `false`. */
export function isFlag(value: Json | undefined): value is boolean {
  return value === true || value === false;
}

/** A whole number no larger than 2^53 - 1 either way. */
export function isSafeInteger(value: Json | undefined): value is number {
  return Number.isSafeInteger(value);
}

// The mux id rule (isValidMuxId): control characters, whitespace, `/`, `?` and `#` are out.
const UNSAFE_ID_CHAR = /[\p{C}\s/?#]/u;

/** 1 to 128 bytes, no control character, no whitespace, none of `/`, `?` or `#`. */
export function idOk(id: Json | undefined): boolean {
  return isText(id) && id.length > 0 && bytes(id) <= CAPS.id && !UNSAFE_ID_CHAR.test(id);
}

/** A history cursor: 1 to 512 bytes of printable ASCII with no space (WIRE.md 7.16). */
export function cursorOk(cursor: Json | undefined): cursor is string {
  return isText(cursor) && cursor.length > 0 && cursor.length <= CAPS.historyCursor && /^[\x21-\x7e]+$/.test(cursor);
}

export function assertId(id: Json | undefined, what: string): string {
  if (!isText(id) || !idOk(id)) throw new TypeError(`${what} breaks the id rule (1-128 bytes, no control character, no whitespace, no / ? #): ${JSON.stringify(id)}`);
  return id;
}

/**
 * An id a program may use for something it did not mint itself (a tool call id from a model, say).
 * A valid id comes back unchanged. Anything else maps to a valid id, the same one every time.
 */
export function safeId(raw: Json | undefined): string {
  const s = String(raw ?? "");
  if (idOk(s)) return s;
  const hash = sha256Hex(s).slice(0, 16);
  const body = s.replace(/[\p{C}\s/?#]/gu, "_");
  let head = "";
  for (const ch of body) {
    if (bytes(head + ch) > CAPS.id - 17) break;
    head += ch;
  }
  return `${head}~${hash}`;
}

const TAB = 0x09;
const NEWLINE = 0x0a;

/** A C0 control, DEL or a C1 control: U+0000 to U+001F and U+007F to U+009F. */
function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

// Direction marks and overrides, zero-width characters, the word joiner, the byte order mark, and the tag
// characters (U+E0000 to U+E007F, which can carry a whole invisible sentence). WIRE.md section 6, step 2.
function isInvisible(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

/** The characters of `text` that `keep` lets through, walked by code point. A lone surrogate is one character. */
function keepOnly(text: string, keep: (codePoint: number) => boolean): string {
  let out = "";
  for (const ch of text) if (keep(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

/** True when `text` holds a control character. */
function hasControl(text: string): boolean {
  for (const ch of text) if (isControl(ch.codePointAt(0) ?? 0)) return true;
  return false;
}

/**
 * Clean a display string, then cut it to `max` bytes at the last whole code point that leaves room
 * for the 3-byte `…`. Multi-line fields keep `\n` and `\t`; every other string keeps neither.
 */
export function cut(text: Json | undefined, max: number, multiline = false): string {
  // Controls go first and invisible characters second, in two walks: two halves of a pair that meet once a control
  // between them is gone make one character, and that character is read in the second walk.
  const visible = keepOnly(String(text ?? ""), (codePoint) => !isControl(codePoint) || (multiline && (codePoint === TAB || codePoint === NEWLINE)));
  const clean = keepOnly(visible, (codePoint) => !isInvisible(codePoint));
  if (bytes(clean) <= max) return clean;
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const n = bytes(ch);
    if (used + n > max - 3) break;
    out += ch;
    used += n;
  }
  return `${out}…`;
}

/**
 * An absolute path inside the cap, else undefined (it reads as absent). Absolute is the POSIX rule, a leading
 * `/`, which is what `node:path` says on Linux, the one system the local example runs on.
 */
export function cwdOf(cwd: Json | undefined): string | undefined {
  if (!isText(cwd) || cwd === "" || bytes(cwd) > CAPS.cwd || hasControl(cwd)) return undefined;
  return cwd.startsWith("/") ? cwd : undefined;
}

/** The longest title a rename may carry, in characters (code points). WIRE.md 7.8. */
export const RENAME_TITLE_MAX = 120;

/**
 * The title a rename asked for: trimmed, 1 to {@link RENAME_TITLE_MAX} characters, no control character.
 * A title that fails is undefined (the wire answers 400 `bad-body`). Direction marks and zero-width
 * characters are not refused; `cut` removes them like it does from every display string, and a title
 * that is nothing but those reads as empty and is refused too.
 */
export function renameTitleOf(title: Json | undefined): string | undefined {
  if (!isText(title)) return undefined;
  const trimmed = title.trim();
  if (trimmed === "" || hasControl(trimmed) || [...trimmed].length > RENAME_TITLE_MAX) return undefined;
  const clean = cut(trimmed, CAPS.title).trim();
  return clean === "" ? undefined : clean;
}

/** The longest subtitle, in characters (code points). WIRE.md 7.11. */
export const SUBTITLE_MAX = 120;
/** The longest text badge, in characters. */
export const BADGE_TEXT_MAX = 12;
/** The largest count badge. */
export const BADGE_COUNT_MAX = 9999;

/** Clean a display string capped in characters: controls and invisibles out, trimmed, cut with `…` as the last character. Empty after cleaning: undefined. */
export function shortLine(text: Json | undefined, maxChars: number): string | undefined {
  const clean = cut(text, maxChars * 4 + 3).trim();
  if (clean === "") return undefined;
  const symbols = [...clean];
  return symbols.length <= maxChars ? clean : `${symbols.slice(0, maxChars - 1).join("")}…`;
}

/** A pane's subtitle as the wire carries it (WIRE.md 7.11), or undefined when nothing is left of it. */
export function subtitleOf(text: Json | undefined): string | undefined {
  return shortLine(text, SUBTITLE_MAX);
}

/**
 * A pane's badge as the wire carries it (WIRE.md 7.11): `{ count }` with an integer from 0 to 9999, or `{ text }` cut to
 * 12 characters. A program that passes a count out of range or a shape with both keys made a mistake: it is a TypeError
 * here, so the wire never carries what the adapter would drop. A text with nothing left after cleaning is undefined.
 */
export function badgeOf(value: { count?: number; text?: string }): { count: number } | { text: string } | undefined {
  const { count, text } = value;
  if ((count === undefined) === (text === undefined)) throw new TypeError("a badge has exactly one of count and text");
  if (count !== undefined) {
    // `Number.isInteger` is false for anything but a number, so a caller past the types that passes a string is refused too.
    if (!Number.isInteger(count) || count < 0 || count > BADGE_COUNT_MAX) {
      throw new RangeError(`a badge count is an integer from 0 to ${BADGE_COUNT_MAX}`);
    }
    return { count };
  }
  const word = shortLine(text, BADGE_TEXT_MAX);
  return word === undefined ? undefined : { text: word };
}

/** The longest `placeholder` of a text ask, in characters. WIRE.md 7.14. */
export const PLACEHOLDER_MAX = 60;
/** The largest `maxLength` of a text ask or field. */
export const ANSWER_TEXT_MAX = 2000;
/** The `maxLength` of a text ask or field that names none. */
export const ANSWER_TEXT_DEFAULT = 500;
/** The most bytes of an answer's text or field value: {@link ANSWER_TEXT_MAX} characters at four bytes each. */
export const ANSWER_TEXT_BYTES = ANSWER_TEXT_MAX * 4;

/** A `maxLength` as a program passes it: a whole number from 1 to 2000, else a RangeError (WIRE.md 7.14). */
export function maxLengthOf(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > ANSWER_TEXT_MAX) {
    throw new RangeError(`a maxLength is a whole number from 1 to ${ANSWER_TEXT_MAX} (WIRE.md 7.14)`);
  }
  return value;
}

/** The longest code language, in characters. WIRE.md 7.13. */
export const LANG_MAX = 24;
/** The longest link target, in characters. */
export const HREF_MAX = 2048;
/** The longest link label, in characters. */
export const LINK_LABEL_MAX = 120;

const LANG_RULE = /^[A-Za-z0-9_+#.-]+$/u;

/** A code item's language (WIRE.md 7.13): 1 to 24 of letters, digits and `_ + # . -`. Anything else is a TypeError, because the adapter would drop the name. */
export function langOf(lang: Json | undefined): string {
  const trimmed = isText(lang) ? lang.trim() : "";
  if (trimmed.length < 1 || trimmed.length > LANG_MAX || !LANG_RULE.test(trimmed)) {
    throw new TypeError(`a code language is 1 to ${LANG_MAX} of letters, digits and _ + # . -`);
  }
  return trimmed;
}

/**
 * A link item's target (WIRE.md 7.13): an `https://` URL of at most 2048 characters, with a host, no user or password
 * and no whitespace, control or invisible character. Anything else is a TypeError, because the adapter would drop the
 * whole item.
 */
export function hrefOf(href: Json | undefined): string {
  const text = isText(href) ? href : "";
  const bad = text === "" || text.length > HREF_MAX || /\s/u.test(text) || cut(text, HREF_MAX * 4) !== text;
  if (!bad && URL.canParse(text)) {
    const url = new URL(text);
    if (url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "") return text;
  }
  throw new TypeError("a link href is an https:// address without spaces, a user or a password, at most 2048 characters");
}

/** The most steps a progress carries. WIRE.md 7.12. */
export const PROGRESS_STEPS_MAX = 12;
/** The longest step or percent label, in characters. */
export const PROGRESS_LABEL_MAX = 60;

const STEP_STATES: ReadonlySet<string> = new Set(["done", "running", "todo"]);

function isStepState(value: Json | undefined): value is ProgressStep["state"] {
  return isText(value) && STEP_STATES.has(value);
}

/**
 * A pane's progress as the wire carries it (WIRE.md 7.12). Steps past the 12th are left out. A program that passes an
 * unknown kind, no steps, a step with an unknown state or with no label left, or a value outside 0 to 100 made a
 * mistake: it is a TypeError or RangeError here, so the wire never carries what the adapter would drop. A percent
 * label with nothing left after cleaning is left out alone.
 */
export function progressOf(value: Progress): Progress {
  if (value.kind === "steps") {
    const list = value.steps;
    if (!Array.isArray(list) || list.length === 0) throw new TypeError("a steps progress has at least one step");
    const steps = list.slice(0, PROGRESS_STEPS_MAX).map((entry) => {
      const label = shortLine(entry?.label, PROGRESS_LABEL_MAX);
      const state = entry.state;
      if (label === undefined || !isStepState(state)) {
        throw new TypeError("a step has a label and a state of done, running or todo");
      }
      return { label, state };
    });
    return { kind: "steps", steps };
  }
  if (value.kind === "percent") {
    const { value: percent, label: text } = value;
    // `Number.isFinite` is false for anything but a number, so a caller past the types that passes a string is refused too.
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new RangeError("a percent progress has a value from 0 to 100");
    }
    const label = text === undefined ? undefined : shortLine(text, PROGRESS_LABEL_MAX);
    return label === undefined ? { kind: "percent", value: percent } : { kind: "percent", value: percent, label };
  }
  throw new TypeError("a progress is steps or percent");
}

/** The longest belt action label, in characters (code points). WIRE.md section 4. */
export const ACTION_LABEL_MAX = 16;

/** A belt action label: cleaned, trimmed and cut to {@link ACTION_LABEL_MAX} characters. Empty when nothing is left. */
export function actionLabelOf(label: Json | undefined): string {
  return [...cut(label, CAPS.title).trim()].slice(0, ACTION_LABEL_MAX).join("").trim();
}

/** The longest push title and push line an ask may carry, in characters (code points). WIRE.md section 6. */
export const PUSH_TITLE_MAX = 60;
export const PUSH_LINE_MAX = 120;

/** The push words of an ask, each part cleaned and cut. A part with nothing left is absent. */
export interface PushText {
  title?: string;
  line?: string;
}

/**
 * The words a program wants a notification for its ask to use (WIRE.md section 6): each cleaned, trimmed and cut
 * to its limit in characters. A part that is empty once cleaned is left out; undefined when neither is left.
 */
export function pushTextOf(push: Json | undefined): PushText | undefined {
  if (!isRecord(push)) return undefined;
  const out: PushText = {};
  const title = pushPartOf(push.title, PUSH_TITLE_MAX);
  const line = pushPartOf(push.line, PUSH_LINE_MAX);
  if (title !== "") out.title = title;
  if (line !== "") out.line = line;
  return out.title === undefined && out.line === undefined ? undefined : out;
}

function pushPartOf(value: Json | undefined, max: number): string {
  if (!isText(value)) return "";
  return [...cut(value, CAPS.askTitle).trim()].slice(0, max).join("").trim();
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
/** ISO 8601 with a zone, at most 40 bytes, else undefined (it reads as absent). */
export function tsOf(ts: Json | undefined): string | undefined {
  return isText(ts) && bytes(ts) <= CAPS.ts && ISO.test(ts) ? ts : undefined;
}

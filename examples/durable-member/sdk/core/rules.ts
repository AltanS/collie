// The id rule, the string cleaning and the caps of the wire (WIRE.md sections 6). Pure functions, no I/O, no
// runtime import: this file runs in Bun and in a Cloudflare Worker.

import { sha256Hex } from "./hash.ts";
import type { Progress, ProgressStep } from "./types.ts";

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

// The mux id rule (isValidMuxId): control characters, whitespace, `/`, `?` and `#` are out.
const UNSAFE_ID_CHAR = /[\p{C}\s/?#]/u;

/** 1 to 128 bytes, no control character, no whitespace, none of `/`, `?` or `#`. */
export function idOk(id: unknown): boolean {
  return typeof id === "string" && id.length > 0 && bytes(id) <= CAPS.id && !UNSAFE_ID_CHAR.test(id);
}

/** A history cursor: 1 to 512 bytes of printable ASCII with no space (WIRE.md 7.16). */
export function cursorOk(cursor: unknown): cursor is string {
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= CAPS.historyCursor && /^[\x21-\x7e]+$/.test(cursor);
}

export function assertId(id: unknown, what: string): string {
  if (!idOk(id)) throw new TypeError(`${what} breaks the id rule (1-128 bytes, no control character, no whitespace, no / ? #): ${JSON.stringify(id)}`);
  return id as string;
}

/**
 * An id a program may use for something it did not mint itself (a tool call id from a model, say).
 * A valid id comes back unchanged. Anything else maps to a valid id, the same one every time.
 */
export function safeId(raw: unknown): string {
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

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROLS_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Direction marks and overrides, zero-width characters, the word joiner, the byte order mark, and the tag
// characters (U+E0000 to U+E007F, which can carry a whole invisible sentence). WIRE.md section 6, step 2.
const INVISIBLE = /[\u200b-\u200f\u061c\u202a-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/**
 * Clean a display string, then cut it to `max` bytes at the last whole code point that leaves room
 * for the 3-byte `…`. Multi-line fields keep `\n` and `\t`; every other string keeps neither.
 */
export function cut(text: unknown, max: number, multiline = false): string {
  const clean = String(text ?? "")
    .replace(multiline ? CONTROLS_MULTILINE : CONTROLS, "")
    .replace(INVISIBLE, "");
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
export function cwdOf(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd === "" || bytes(cwd) > CAPS.cwd || HAS_CONTROL.test(cwd)) return undefined;
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
export function renameTitleOf(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const trimmed = title.trim();
  if (trimmed === "" || HAS_CONTROL.test(trimmed) || [...trimmed].length > RENAME_TITLE_MAX) return undefined;
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
export function shortLine(text: unknown, maxChars: number): string | undefined {
  const clean = cut(text, maxChars * 4 + 3).trim();
  if (clean === "") return undefined;
  const symbols = [...clean];
  return symbols.length <= maxChars ? clean : `${symbols.slice(0, maxChars - 1).join("")}…`;
}

/** A pane's subtitle as the wire carries it (WIRE.md 7.11), or undefined when nothing is left of it. */
export function subtitleOf(text: unknown): string | undefined {
  return shortLine(text, SUBTITLE_MAX);
}

/**
 * A pane's badge as the wire carries it (WIRE.md 7.11): `{ count }` with an integer from 0 to 9999, or `{ text }` cut to
 * 12 characters. A program that passes a count out of range or a shape with both keys made a mistake: it is a TypeError
 * here, so the wire never carries what the adapter would drop. A text with nothing left after cleaning is undefined.
 */
export function badgeOf(value: { count: number } | { text: string }): { count: number } | { text: string } | undefined {
  const { count, text } = value as { count?: unknown; text?: unknown };
  if ((count === undefined) === (text === undefined)) throw new TypeError("a badge has exactly one of count and text");
  if (count !== undefined) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > BADGE_COUNT_MAX) {
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
export function maxLengthOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ANSWER_TEXT_MAX) {
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
export function langOf(lang: unknown): string {
  const trimmed = typeof lang === "string" ? lang.trim() : "";
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
export function hrefOf(href: unknown): string {
  const text = typeof href === "string" ? href : "";
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

/**
 * A pane's progress as the wire carries it (WIRE.md 7.12). Steps past the 12th are left out. A program that passes an
 * unknown kind, no steps, a step with an unknown state or with no label left, or a value outside 0 to 100 made a
 * mistake: it is a TypeError or RangeError here, so the wire never carries what the adapter would drop. A percent
 * label with nothing left after cleaning is left out alone.
 */
export function progressOf(value: Progress): Progress {
  const { kind } = value as { kind?: unknown };
  if (kind === "steps") {
    const list = (value as { steps?: unknown }).steps;
    if (!Array.isArray(list) || list.length === 0) throw new TypeError("a steps progress has at least one step");
    const steps = list.slice(0, PROGRESS_STEPS_MAX).map((entry: { label?: unknown; state?: unknown }) => {
      const label = shortLine(entry?.label, PROGRESS_LABEL_MAX);
      if (label === undefined || typeof entry.state !== "string" || !STEP_STATES.has(entry.state)) {
        throw new TypeError("a step has a label and a state of done, running or todo");
      }
      return { label, state: entry.state as ProgressStep["state"] };
    });
    return { kind: "steps", steps };
  }
  if (kind === "percent") {
    const { value: percent, label: text } = value as { value?: unknown; label?: unknown };
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
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
export function actionLabelOf(label: unknown): string {
  return [...cut(label, CAPS.title).trim()].slice(0, ACTION_LABEL_MAX).join("").trim();
}

/** The longest push title and push line an ask may carry, in characters (code points). WIRE.md section 6. */
export const PUSH_TITLE_MAX = 60;
export const PUSH_LINE_MAX = 120;

/**
 * The words a program wants a notification for its ask to use (WIRE.md section 6): each cleaned, trimmed and cut
 * to its limit in characters. A part that is empty once cleaned is left out; undefined when neither is left.
 */
export function pushTextOf(push: unknown): { title?: string; line?: string } | undefined {
  if (typeof push !== "object" || push === null) return undefined;
  const out: { title?: string; line?: string } = {};
  const title = pushPartOf(Reflect.get(push, "title"), PUSH_TITLE_MAX);
  const line = pushPartOf(Reflect.get(push, "line"), PUSH_LINE_MAX);
  if (title !== "") out.title = title;
  if (line !== "") out.line = line;
  return out.title === undefined && out.line === undefined ? undefined : out;
}

function pushPartOf(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return [...cut(value, CAPS.askTitle).trim()].slice(0, max).join("").trim();
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
/** ISO 8601 with a zone, at most 40 bytes, else undefined (it reads as absent). */
export function tsOf(ts: unknown): string | undefined {
  return typeof ts === "string" && bytes(ts) <= CAPS.ts && ISO.test(ts) ? ts : undefined;
}

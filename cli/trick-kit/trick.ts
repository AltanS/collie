// collie trick helper v2
// The helper of a Collie trick: it reads the facts, collects the parts and the Decisions, and prints the
// one document the bridge reads. `collie trick init` writes it into the trick folder, and
// `collie trick helper <id>` rewrites it with the newest version. It imports only node: built-ins and
// Bun, so the trick needs no install. Edit your program, not this file: a rewrite replaces it.
//
// Two test hooks, which only `collie trick dev`, `collie trick check --run` and a test of your own pass
// (the bridge never passes a TRICK_* variable): TRICK_NOW (epoch seconds) fixes the clock `now()` reads,
// and TRICK_TOOLS_ONLY_PATH=1 makes `t.tool` look on PATH alone.

import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// Collie's runtime switch is for this process only. A program the trick starts must not inherit it.
delete process.env.BUN_BE_BUN;

// ── The words of the schema (web/src/lib/tricks/schema.ts in Collie) ───────────────────────────────
export type Tone = "plain" | "accent" | "warn" | "danger" | "ok" | "muted";
export type Icon =
  | "archive" | "back" | "bell" | "branch" | "camera" | "chat" | "check" | "clock" | "close" | "copy" | "crew" | "delete"
  | "down" | "download" | "edit" | "eye" | "file" | "flag" | "flask" | "folder" | "image" | "info" | "key" | "link"
  | "lock" | "machine" | "menu" | "mic" | "minus" | "more" | "move" | "next" | "note" | "pause" | "pin" | "play"
  | "plug" | "plus" | "refresh" | "search" | "send" | "settings" | "share" | "star" | "tag" | "terminal" | "up"
  | "upload" | "warn" | "x";
export type Clock = "ago" | "elapsed" | "left" | "time";
/** A number attribute: written as a number or as digits; the helper prints it as text. */
type Num = number | string;
/** A value a JSON file holds: what `t.state` reads and writes. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** A value of `config.toml`. */
export type TomlValue = string | number | boolean | Date | TomlValue[] | { [key: string]: TomlValue };

/** One node of a view. Build it with the functions in `v`, never by hand. */
export interface Node {
  kind: string;
  text?: string;
  attrs?: Record<string, string>;
  kids?: Node[];
}

/** A node, its attributes as text: a number as digits, `true` as "" (a flag on), `false` and undefined left out. */
function node(kind: string, text: string | undefined, attrs: Record<string, Num | boolean | undefined> = {}, kids?: Node[]): Node {
  const out: Node = { kind };
  if (text !== undefined) out.text = text;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    kept[name] = value === true ? "" : String(value);
  }
  if (Object.keys(kept).length > 0) out.attrs = kept;
  if (kids !== undefined) out.kids = kids;
  return out;
}

/** A number as the schema writes one: up to six places, no exponent, no trailing zeros ("4.2", "-3", "0.125"). */
function decimal(n: number): string {
  const text = n.toFixed(6).replace(/\.?0+$/u, "");
  return text === "-0" ? "0" : text;
}

/** The point of a picture to keep in view, in percent across (`x`) and down (`y`), and a zoom of 1 to 8 about it. */
export interface Focus {
  x: number;
  y: number;
  zoom?: number;
}

/** How a picture sits in its frame: its words under it, `cover` to fill the frame, and the point to keep. */
export interface ImageLook {
  caption?: string;
  fit?: "contain" | "cover";
  focus?: Focus;
}

/** A `focus` as the schema's text: "50 20", or "50 20 2" with a zoom. */
function focusText(focus: Focus | undefined): string | undefined {
  if (focus === undefined) return undefined;
  const point = `${decimal(focus.x)} ${decimal(focus.y)}`;
  return focus.zoom === undefined || focus.zoom === 1 ? point : `${point} ${decimal(focus.zoom)}`;
}

/**
 * A picture. On a Decision's view, `image(ref)` names one of the Decision's own `media` by its place
 * (0 is the first): the card draws it among the facts, and not again in the row above. In a Session,
 * `image(src, alt, w, h)` is an image file of the trick folder (.png or .jpg), `w` by `h`. Both take a
 * caption, a fit and a focus, which crops the picture on the phone: no image tool needed.
 */
function image(ref: number, look?: ImageLook): Node;
function image(src: string, alt: string, w: Num, h: Num, look?: ImageLook): Node;
function image(first: number | string, second?: string | ImageLook, w?: Num, h?: Num, look: ImageLook = {}): Node {
  if (typeof first === "number") {
    const own = typeof second === "object" ? second : {};
    return node("image", undefined, { ref: first, caption: own.caption, fit: own.fit, focus: focusText(own.focus) });
  }
  const alt = typeof second === "string" ? second : "";
  return node("image", undefined, { src: first, alt, w, h, caption: look.caption, fit: look.fit, focus: focusText(look.focus) });
}

/** One side of a `compare`: a Decision's picture by its place, with a label and a crop, or an image node of the trick folder. */
export type CompareSide = number | { ref: number; label?: string; fit?: "contain" | "cover"; focus?: Focus } | Node;

function compareSide(side: CompareSide): Node {
  if (typeof side === "number") return image(side);
  if ("kind" in side) return side;
  return image(side.ref, { caption: side.label, fit: side.fit, focus: side.focus });
}

/** A table's column: its head, and `end` for a column of figures (a column whose cells all read as figures keeps the end side anyway). */
export type TableColumn = string | { label: string; align?: "start" | "end" };
/** A table's cell: its words or a figure, or words with a tone. */
export type TableCell = string | number | { text: string; tone?: Tone };

/** Text or inline kids (runs and links), for a para and a line. */
function inline(kind: "para" | "line", body: string | Node[], attrs: Record<string, Num | boolean | undefined>): Node {
  return Array.isArray(body) ? node(kind, undefined, attrs, body) : node(kind, body, attrs);
}

/** The view builders, one per node kind. Each returns a plain node; a view is a list of them. */
export const v = {
  /** A framed box. Holds para, line, chip, button, meter, image, bar, group, number, spacer, compare, table, diff, spark. Not on a Decision's view. */
  card: (kids: Node[], attrs: { tone?: Tone } = {}): Node => node("card", undefined, attrs, kids),
  /** A labelled section (no label: a plain run of facts). Holds row, group, bar, para, line, link, meter, number, spacer, image, compare, table, diff, spark. */
  group: (kids: Node[], attrs: { label?: string; fold?: "open" | "closed"; badge?: Num } = {}): Node => node("group", undefined, attrs, kids),
  /** Rows framed together. Holds row and group. */
  list: (kids: Node[] = []): Node => node("list", undefined, {}, kids),
  /** One row: a title, an optional para (its second line), chips, at most one trailing button. */
  row: (text: string, attrs: { href?: string; end?: string; badge?: Num; tone?: Tone; cut?: "end" | "mid"; icon?: Icon; disabled?: string } = {}, kids?: Node[]): Node =>
    node("row", text, attrs, kids),
  /** One row of buttons, chips and links. Chips with `state` draw a step strip. */
  bar: (kids: Node[], attrs: { role?: "strip"; scroll?: "x"; label?: string } = {}): Node => node("bar", undefined, attrs, kids),
  /** A small label. With `at` and `clock` it is a live time and needs no text. */
  chip: (text: string | undefined, attrs: { tone?: Tone; icon?: Icon; at?: Num; clock?: Clock; state?: "working" | "waiting" | "idle" | "done" | "gone"; current?: boolean; short?: string } = {}): Node =>
    node("chip", text, attrs),
  /** A button: sends `intent` on a tap, or copies `value` with `does: "copy"`. Not on a Decision's view. */
  button: (attrs: { label: string; intent?: string; tone?: Tone; disabled?: string; pressed?: "true" | "false" | "mixed"; confirm?: string; badge?: Num; icon?: Icon; hint?: string; does?: "copy"; value?: string }): Node =>
    node("button", undefined, attrs),
  /** A paragraph: text, or a list of runs and links. */
  para: (body: string | Node[], attrs: { role?: "heading" | "quote"; bullet?: string; term?: string } = {}): Node => inline("para", body, attrs),
  /** One mono screen line: text, or a list of runs and links. */
  line: (body: string | Node[], attrs: { style?: string; role?: "text" | "status" | "note" } = {}): Node => inline("line", body, attrs),
  /** A run of text inside a para or a line. */
  run: (text: string, attrs: { style?: string; code?: boolean; href?: string; at?: Num; clock?: Clock } = {}): Node => node("run", text, attrs),
  /** A code block: a text, one line per line (a blank line stays blank), or a list of line nodes (for styled lines). */
  code: (body: string | Node[], attrs: { lang?: string; max?: Num } = {}): Node =>
    node("code", undefined, attrs, Array.isArray(body) ? body : body.split("\n").map((l) => node("line", l.trim() === "" ? undefined : l))),
  /** A link: an https address, or a session's `id` from the facts. */
  link: (text: string, href: string, attrs: { rel?: "url" | "pane"; badge?: Num; icon?: Icon } = {}): Node => node("link", text, { href, ...attrs }),
  image,
  /** Two pictures side by side at one height, labelled "Before" and "After" unless a side names its own label. They stack on a narrow phone; a tap pages through both. */
  compare: (a: CompareSide, b: CompareSide): Node => node("compare", undefined, {}, [compareSide(a), compareSide(b)]),
  /**
   * A small table: 1 to 4 columns and at most 12 rows, every row as long as the heads. A cell takes at
   * most two lines on the phone; it never scrolls sideways.
   */
  table: (t: { columns: TableColumn[]; rows: TableCell[][] }): Node =>
    node("table", undefined, {}, [
      ...t.columns.map((col) => (typeof col === "string" ? node("col", col) : node("col", col.label, { align: col.align }))),
      ...t.rows.flat().map((cell) => {
        if (typeof cell === "number") return node("cell", decimal(cell));
        return typeof cell === "string" ? node("cell", cell) : node("cell", cell.text, { tone: cell.tone });
      }),
    ]),
  /** A few lines of a diff (at most 40, each at most 200 characters): `+` added, `-` removed, `@@` a hunk's head. Mono; a long line scrolls inside its block. */
  diff: (lines: string | string[], attrs: { file?: string } = {}): Node => node("diff", Array.isArray(lines) ? lines.join("\n") : lines, attrs),
  /** A trend as a small line: 2 to 32 numbers, oldest first, the last one marked and written beside the label. */
  spark: (values: number[], attrs: { tone?: Tone; label?: string } = {}): Node => node("spark", undefined, { values: values.map(decimal).join(" "), ...attrs }),
  /** An amount (`role` meter, the default) or a task (`role` progress). */
  meter: (attrs: { value?: Num; max?: Num; tone?: Tone; label?: string; role?: "progress" | "meter" }): Node => node("meter", undefined, attrs),
  /** Air between nodes; with a label, a divider with words. */
  spacer: (label?: string): Node => node("spacer", undefined, { label }),
  /** A big figure ("23/34") with a label. */
  number: (text: Num, attrs: { label?: string; tone?: Tone; unit?: string } = {}): Node => node("number", String(text), attrs),

  // ── Recipes: the kinds above, put together ──
  /** Two of the Decision's pictures as before and after, cropped to the same point. */
  beforeAfter: (aRef: number, bRef: number, opts: { before?: string; after?: string; fit?: "contain" | "cover"; focus?: Focus } = {}): Node =>
    node("compare", undefined, {}, [image(aRef, { caption: opts.before, fit: opts.fit, focus: opts.focus }), image(bRef, { caption: opts.after, fit: opts.fit, focus: opts.focus })]),
  /** Checks as rows: a green check or a red cross, the note as the row's second line. */
  checks: (list: { label: string; ok: boolean; note?: string }[]): Node =>
    node(
      "list",
      undefined,
      {},
      list.map((c) => node("row", c.label, { icon: c.ok ? "check" : "x", tone: c.ok ? "ok" : "danger" }, c.note === undefined ? undefined : [node("para", c.note)])),
    ),
  /** A figure with its label, and its trend under it when `trend` gives the numbers. */
  stat: (value: Num, label: string, opts: { trend?: number[]; tone?: Tone; unit?: string } = {}): Node => {
    const figure = node("number", String(value), { label, tone: opts.tone, unit: opts.unit });
    return opts.trend === undefined ? figure : node("group", undefined, {}, [figure, node("spark", undefined, { values: opts.trend.map(decimal).join(" "), tone: opts.tone })]);
  },
};

// ── Time and words ──────────────────────────────────────────────────────────────────────────────
export const MINUTE_MS = 60_000;
export const DAY_MS = 1440 * MINUTE_MS;
/** Now, in epoch ms: TRICK_NOW (epoch seconds) when a test sets it, else the clock. */
export function now(): number {
  const fixed = Number(process.env.TRICK_NOW ?? "");
  return Number.isFinite(fixed) && fixed > 0 ? fixed * 1000 : Date.now();
}
/** An instant as ISO 8601 to the second, "2026-11-09T12:30:00Z"; now by default. */
export const iso = (ms: number = now()): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** An instant to the minute, for a line a person reads: "2026-11-09 12:30 UTC". */
export const minute = (ms: number): string => `${iso(ms).slice(0, 16).replace("T", " ")} UTC`;
/** A span of time in ms as short words: "just now", "12 min", "5 h", "3 d". */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
}

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}\b|AIza[0-9A-Za-z_-]{35,}|glpat-[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{36,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
/** The home folder in each spelling (/var/home/x is also /home/x), the longest first. */
const HOMES = ((home: string): string[] => {
  if (home.length < 2) return [];
  return [...new Set([home, home.startsWith("/var/home/") ? home.slice(4) : home, real(home)])].toSorted((a, b) => b.length - a.length);
})(process.env.HOME ?? "");
/** A text with each key or token cut to its first four characters and the home folder written as ~. */
export function mask(text: string): string {
  let out = text.replace(SECRET, (m) => `${m.slice(0, 4)}****`).replace(/\b([Bb]earer[ \t]+)[A-Za-z0-9._~+/=-]{20,}/g, "$1****");
  for (const h of HOMES) out = out.split(`${h}/`).join("~/").split(h).join("~");
  return out;
}
/** One line: masked first, control characters out, whitespace folded, cut to `max` characters with "...". */
export function clip(text: string, max: number): string {
  const one = mask(text).replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}
/** The first sentence of a text, on one line. */
export function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return /^.*?[.!?](?=\s|$)/.exec(one)?.[0] ?? one;
}
/** Every string inside a JSON value passed through `fn`, the keys left as they are: a tool for `t.onPrint`. */
export function mapText<T extends object>(value: T, fn: (text: string) => string): T {
  // SAFETY: JSON.parse rebuilds the value JSON.stringify was given, with each string through `fn` and the shape kept.
  return JSON.parse(JSON.stringify(value), (_key: string, x: Json) => (typeof x === "string" ? fn(x) : x)) as T;
}

// ── The facts ───────────────────────────────────────────────────────────────────────────────────
export interface Session {
  id: string; memberId: string; sessionId: string; paneId: string; host: string;
  name?: string; agent?: string; status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd?: string; space?: string; tab?: string; lastActiveAt?: string;
}
export type TapValue = string | { text: string | null };
export type Trigger = { kind: "start" } | { kind: "timer" } | { kind: "tap"; rid: string; node: string; intent: string; value?: TapValue; seen?: string };
export interface Facts {
  v: 1; trigger: Trigger; trick: { id: string; dir: string; state: string };
  host: string; memberId: string; sessions: Session[]; spaces: { name: string; folder?: string }[];
}
export interface Tap { intent: string; value: TapValue | null; node: string; rid: string; seen?: string }
export interface HillAnswer { key: string; intent: string; text: string | null }

// ── Parts and Decisions ─────────────────────────────────────────────────────────────────────────
export interface Item { label: string; icon?: Icon; badge?: Num; tone?: Tone }
export interface Action { id: string; label: string; intent: string; value?: string; icon?: "play" | "pause" | "check" | "x" | "refresh" | "archive" | "flag" | "star" | "send" | "note" | "search" | "more"; disabled?: boolean }
export interface SessionPart { id?: string; name?: string; icon?: Icon; tone?: Tone; subtitle?: string; badge?: { count: number } | { text: string }; progress?: { value?: number; max?: number }; actions?: Action[]; view: Node[] }
export type Part =
  | { at: "status"; id: "status"; chip: { text: string; icon?: Icon; tone?: Tone } }
  | { at: "belt"; id: "belt"; mark: { label: string; icon?: Icon; tone?: Tone; badge?: string; intent?: string } }
  | { at: "dashboard" | "tabbar"; id: "dashboard" | "tabbar"; item: Item }
  | ({ at: "session"; id: string } & Omit<SessionPart, "id">);
export interface Decision {
  key: string; title: string; summary: string;
  options?: { intent: string; label: string; detail?: string; confirm?: string }[];
  recommends?: { intent: string; why: string };
  body?: string; text?: "none" | "optional" | "required"; priority?: "now" | "today" | "later";
  about?: string; replyTo?: string; media?: { file: string; caption?: string }[];
  links?: { label: string; href: string }[];
  /** Facts drawn under the summary: display kinds only (no button, no card), 8 KiB, 100 nodes, depth 4. An `image(ref)` or a `compare` names a picture of `media` by its place. */
  view?: Node[];
}
export interface ShResult { ok: boolean; code: number; stdout: string; stderr: string }
/** What a run prints. `decisions` is left out only after `keepDecisions()`. */
export interface Document { v: 1; parts: Part[]; decisions?: Decision[]; asOf?: string; fresh?: string }
/** An append-only JSON-lines file in the state folder (`t.log`). A torn line from a killed run is skipped. */
export interface Log<T extends object> {
  append(entry: T): void;
  /** Every entry, oldest first; `last(n)` the newest n, oldest first; `has(rid)` whether an entry has that rid. */
  all(): T[];
  last(n: number): T[];
  has(rid: string): boolean;
  /** Appends `{ ...entry, rid }` once per rid: false, and nothing written, when the rid is there already (a retried tap) or empty. */
  once(rid: string, entry: T): boolean;
}
/** What `t.cached` answers. `value` is null when no read ever worked; `stale` says it is an old value served because the read failed with `error`. */
export interface Cached<T> { value: T | null; at: number; stale: boolean; error: string | null }
/** The places a count can stand in, the words of `show` in config.toml. */
export type ItemPlace = "dashboard" | "tabbar" | "status" | "belt";
const ITEM_PLACES: readonly ItemPlace[] = ["dashboard", "tabbar", "status", "belt"];
/** Where a tool may sit when the bridge's PATH is short, after PATH itself. */
const TOOL_DIRS = ["~/.local/bin", "~/.bun/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** The most bytes of stdout and of stderr `t.sh` keeps. */
const SH_CAP = 256 * 1024;
/** A stream read to its end, at most `cap` bytes kept. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for await (const chunk of stream) {
    const part = chunk.subarray(0, Math.max(0, cap - kept));
    chunks.push(part);
    kept += part.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The real path of a folder, or the path as given when it cannot be resolved. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
/** A file's text, or null when it cannot be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The places `trick.toml` lists, or [] when it cannot be read. */
function declaredPlaces(dir: string): string[] {
  try {
    // SAFETY: only `places` is read, and only as a list of strings.
    const places = (Bun.TOML.parse(readText(join(dir, "trick.toml")) ?? "") as { places?: unknown }).places;
    return Array.isArray(places) ? places.map(String) : [];
  } catch {
    return [];
  }
}

/** A file in the state folder: plain names joined by "/" (`cache/ci`), none starting with a dot, so no "..". */
function statePath(root: string, name: string, ext: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(name)) throw new Error(`state name "${name}" is not plain names joined by "/"`);
  return join(root, name.endsWith(ext) ? name : `${name}${ext}`);
}
/** A file written whole: a temp file, then a rename. Its folder is made owner only. */
function writeWhole(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, `${json}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** One run of the trick: what the program reads, and the places it fills. */
export class Trick {
  readonly facts: Facts;
  /** `config.toml` of the trick folder, parsed; {} when there is none. */
  readonly config: { [key: string]: TomlValue };
  /** The tap that started this run, or null. */
  readonly tap: Tap | null;
  /** The person's answer to one of this trick's Decisions, or null. */
  readonly hillAnswer: HillAnswer | null;
  /** Small JSON files in the trick's own state folder. A name may hold folders: `cache/ci`. */
  readonly state: { get<T extends Json>(name: string, fallback: T): T; set(name: string, value: Json): void };
  /** What this run collected, in order. `document()` prints them. */
  readonly parts: Part[] = [];
  readonly decisions: Decision[] = [];
  /** The id of the session part, once `session()` named one: the error card and the config.toml row go there. */
  sessionId: string | null = null;
  private keep = false;
  private freshFor: string | undefined;
  private asOfAt: string | undefined;
  private readonly hooks: ((doc: Document) => Document | void)[] = [];
  private readonly configProblems: string[] = [];

  constructor(facts: Facts) {
    this.facts = facts;
    const text = readText(join(facts.trick.dir, "config.toml"));
    // SAFETY: Bun.TOML.parse answers with a table; the program reads each setting it names.
    this.config = text === null ? {} : (Bun.TOML.parse(text) as { [key: string]: TomlValue });
    const t = facts.trigger;
    const tap: Tap | null = t.kind === "tap" ? { intent: t.intent, value: t.value ?? null, node: t.node, rid: t.rid } : null;
    if (tap !== null && t.kind === "tap" && t.seen !== undefined) tap.seen = t.seen;
    this.tap = tap;
    // An answer's value is always `{ text }`: the person's words, or null.
    const words = tap?.value ?? null;
    this.hillAnswer = tap?.node.startsWith("hill/") === true ? { key: tap.node.slice(5), intent: tap.intent, text: words instanceof Object ? words.text : null } : null;
    const root = facts.trick.state;
    this.state = {
      get<T extends Json>(name: string, fallback: T): T {
        try {
          // SAFETY: the file holds what `set` wrote for this name, and the caller names its shape.
          return JSON.parse(readText(statePath(root, name, ".json")) ?? "") as T;
        } catch {
          return fallback;
        }
      },
      set: (name: string, value: Json): void => writeWhole(statePath(root, name, ".json"), JSON.stringify(value)),
    };
  }

  /** One chip in the status line above the Belt (1 to 12 characters). */
  status(chip: { text: string; icon?: Icon; tone?: Tone }): void {
    this.parts.push({ at: "status", id: "status", chip });
  }
  /** One mark at the end of the Belt. `intent` makes a tap run the trick. */
  belt(mark: { label: string; icon?: Icon; tone?: Tone; badge?: Num; intent?: string }): void {
    const { badge, ...rest } = mark;
    this.parts.push({ at: "belt", id: "belt", mark: badge === undefined ? rest : { ...rest, badge: String(badge) } });
  }
  /** One tile in the strip at the top of the Dashboard. */
  dashboard(item: Item): void {
    this.parts.push({ at: "dashboard", id: "dashboard", item });
  }
  /** One item in the Dashboard's bottom bar, after the Hill. */
  tabbar(item: Item): void {
    this.parts.push({ at: "tabbar", id: "tabbar", item });
  }
  /** A session of the trick's own: a Dashboard row and a screen with `view`. Keep the default id "main". */
  session(part: SessionPart): void {
    const { id = "main", ...rest } = part;
    this.sessionId = id;
    this.parts.push({ at: "session", id, ...rest });
  }
  /** Ask the person on the Hill. The answer comes back as a tap: read it in `t.hillAnswer`. */
  decide(decision: Decision): void {
    this.decisions.push(decision);
  }
  /** Leave this trick's open Decisions as they are. Without it, the Decisions not asked for this run are withdrawn. */
  keepDecisions(): void {
    this.keep = true;
  }
  /** How long the parts stay fresh, such as "90s" or "10m"; past it the phone shows their age. */
  fresh(duration: string): void {
    this.freshFor = duration;
  }
  /** When the data was true, when it is older than this run (a cached read). */
  asOf(when: Date | number | string): void {
    this.asOfAt = new Date(when).toISOString();
  }

  /**
   * `show` in config.toml (or in the table `from`): the places it names that `places` in trick.toml lists,
   * `defaults` when it is not set. A word it cannot use goes in one warn row at the end of the session.
   */
  show(defaults: ItemPlace[], from: { [key: string]: TomlValue } = this.config): Set<ItemPlace> {
    const raw = from.show;
    const words = Array.isArray(raw) ? raw.map(String) : raw === undefined ? defaults : [String(raw)];
    const declared = declaredPlaces(this.facts.trick.dir);
    const can = ITEM_PLACES.filter((p) => declared.includes(p));
    const bad = words.filter((w) => !can.some((p) => p === w));
    if (bad.length > 0) this.configWarn(`show names ${bad.map((w) => JSON.stringify(w)).join(", ")}, which this trick ignores: use ${can.join(", ")}`);
    return new Set(can.filter((p) => words.includes(p)));
  }
  /**
   * One count in each place of `places` (from `t.show`): the tile and the bar item always, with no badge at
   * 0 or "", and the status chip and the Belt mark only while `word` is set. `tone` inks the chip and the
   * mark, `itemTone` the tile and the bar item.
   */
  put(places: Set<ItemPlace>, o: { label: string; icon?: Icon; badge?: Num; word?: string | null; tone?: Tone; itemTone?: Tone }): void {
    const item: Item = { label: o.label, icon: o.icon, tone: o.itemTone, badge: o.badge === 0 || o.badge === "" ? undefined : o.badge };
    if (places.has("dashboard")) this.dashboard(item);
    if (places.has("tabbar")) this.tabbar(item);
    if (o.word === undefined || o.word === null) return;
    if (places.has("status")) this.status({ text: o.word, icon: o.icon, tone: o.tone });
    if (places.has("belt")) this.belt({ label: o.word, icon: o.icon, tone: o.tone });
  }
  /** One more problem for the config.toml warn row the session ends with (on stderr when there is no session). */
  configWarn(text: string): void {
    this.configProblems.push(text);
  }

  /** An append-only JSON-lines file `<name>.jsonl` in the state folder, for records: one line per answer. */
  log<T extends object = Record<string, Json>>(name: string): Log<T> {
    const path = statePath(this.facts.trick.state, name, ".jsonl");
    const all = (): T[] =>
      (readText(path) ?? "").split("\n").flatMap((line) => {
        try {
          // SAFETY: each line is an entry `append` wrote to this log.
          return line.trim() === "" ? [] : [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
    const append = (entry: T): void => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    };
    const has = (rid: string): boolean => all().some((e) => "rid" in e && e.rid === rid);
    const once = (rid: string, entry: T): boolean => {
      if (rid === "" || has(rid)) return false;
      append({ ...entry, rid });
      return true;
    };
    return { append, all, has, once, last: (n) => (n <= 0 ? [] : all().slice(-n)) };
  }

  /**
   * A read kept in the state file `<name>.json` with its time. A kept value younger than `ttlMs` is served
   * as it is; else `loader` runs, and its value is kept and served. When the loader throws, the kept value
   * is served with `stale: true` and the error, or `value: null` when there is none. Pass `Infinity` as
   * `ttlMs` on a tap run so a tap never waits on the network.
   */
  async cached<T>(name: string, ttlMs: number, loader: () => T | Promise<T>): Promise<Cached<T>> {
    const at = now();
    const path = statePath(this.facts.trick.state, name, ".json");
    let old: { value: T; at: number } | null = null;
    try {
      // SAFETY: the file holds what this method wrote for this name; a file without both keys counts as none.
      const kept = JSON.parse(readText(path) ?? "{}") as { at?: number; value?: T };
      if (Number.isFinite(kept.at) && kept.value !== undefined) old = { value: kept.value, at: kept.at ?? 0 };
    } catch {
      old = null;
    }
    if (old !== null && at - old.at < ttlMs) return { ...old, stale: false, error: null };
    try {
      const value = await loader();
      writeWhole(path, JSON.stringify({ at, value }));
      return { value, at, stale: false, error: null };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return old === null ? { value: null, at, stale: false, error } : { ...old, stale: true, error };
    }
  }

  /** Close `key` until `untilMs` (epoch ms), such as a Decision held for a day. Kept in the state file closed.json. */
  closedUntil(key: string, untilMs: number): void {
    const open = Object.entries(this.state.get<Record<string, number>>("closed", {})).filter(([, until]) => until > now());
    this.state.set("closed", { ...Object.fromEntries(open), [key]: untilMs });
  }
  /** When a closed key opens again (epoch ms), or null when it is open. */
  isClosed(key: string): number | null {
    const until = this.state.get<Record<string, number>>("closed", {})[key];
    return until !== undefined && until > now() ? until : null;
  }

  /** A path from config.toml, made absolute: `~/` is the home folder, and a relative path is taken from the trick folder. */
  path(p: string): string {
    if (p === "" || p.startsWith("/")) return p;
    return p === "~" || p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(1)) : join(this.facts.trick.dir, p);
  }
  /** The absolute path of a program on PATH, else in `extraDirs` or a common user tool folder (~/.local/bin, ~/.bun/bin, ...), else null. */
  tool(name: string, extraDirs: string[] = []): string | null {
    const onPath = Bun.which(name, { PATH: process.env.PATH ?? "" });
    if (onPath !== null || process.env.TRICK_TOOLS_ONLY_PATH === "1") return onPath;
    const home = process.env.HOME ?? "";
    return Bun.which(name, { PATH: [...extraDirs, ...TOOL_DIRS].map((d) => (d.startsWith("~/") ? join(home, d.slice(2)) : d)).join(delimiter) });
  }
  /** Run a program without a shell: a name, a path, or what `t.tool` found. Never throws: a failure to start (or null) is `ok: false` with the reason in `stderr`. */
  async sh(cmd: string | null, args: string[] = [], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ShResult> {
    if (cmd === null) return { ok: false, code: -1, stdout: "", stderr: "the program was not found" };
    try {
      // The environment as this process holds it now, so BUN_BE_BUN (deleted above) stays out of the child.
      const env = { ...process.env };
      const child = Bun.spawn([cmd, ...args], { cwd: opts.cwd ?? this.facts.trick.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 5000);
      const [stdout, stderr, code] = await Promise.all([readCapped(child.stdout, SH_CAP), readCapped(child.stderr, SH_CAP), child.exited]);
      clearTimeout(timer);
      return { ok: code === 0, code, stdout, stderr };
    } catch (err) {
      return { ok: false, code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The session whose folder is `folder` (real paths compared), or null. */
  sessionAt(folder: string): Session | null {
    const want = real(folder);
    return this.facts.sessions.find((s) => s.cwd !== undefined && real(s.cwd) === want) ?? null;
  }
  /** The session with this name, or null. */
  sessionNamed(name: string): Session | null {
    return this.facts.sessions.find((s) => s.name === name) ?? null;
  }

  /** Change the document just before it prints: `fn` gets it whole, the error card too, and returns a changed one or nothing. */
  onPrint(fn: (doc: Document) => Document | void): void {
    this.hooks.push(fn);
  }
  /** The document this run prints, before the `onPrint` hooks. The config.toml row ends the session's view. */
  document(): Document {
    const problems = this.configProblems;
    const row = v.list([v.row("config.toml", { tone: "warn", icon: "warn" }, [v.para(clip(`${problems.join(". ")}.`, 400))])]);
    const at = this.parts.findIndex((p) => p.at === "session" && p.id === (this.sessionId ?? "main"));
    if (problems.length > 0 && at < 0) process.stderr.write(`config.toml: ${clip(problems.join(". "), 400)}\n`);
    const parts = this.parts.map((p, i) => (i === at && p.at === "session" && problems.length > 0 ? { ...p, view: [...p.view, row] } : p));
    const doc: Document = { v: 1, parts };
    if (!this.keep) doc.decisions = this.decisions;
    if (this.asOfAt !== undefined) doc.asOf = this.asOfAt;
    if (this.freshFor !== undefined) doc.fresh = this.freshFor;
    return doc;
  }
  /** `doc` (by default this run's document) through every `onPrint` hook, in order: what `run` prints. */
  printed(doc: Document = this.document()): Document {
    return this.hooks.reduce<Document>((out, fn) => fn(out) ?? out, doc);
  }
}

/**
 * The trick's main: read the facts from stdin, call `handler`, print the document once, exit 0. A thrown
 * error prints one warn card in the trick's session and exits 0 when the trick has a session; with
 * none it exits 1, so the bridge's backoff applies. The stack goes to stderr, the masked message last.
 */
export function run(handler: (t: Trick) => void | Promise<void>): void {
  void (async () => {
    let t: Trick | null = null;
    let facts: Facts | null = null;
    try {
      const text = await Bun.stdin.text();
      if (text.trim() === "") throw new Error("no facts on stdin: try it with collie trick dev <folder>");
      // SAFETY: the bridge writes one facts document (schema.ts `TrickFacts`) on stdin.
      facts = JSON.parse(text) as Facts;
      t = new Trick(facts);
      await handler(t);
      await Bun.write(Bun.stdout, `${JSON.stringify(t.printed())}\n`);
      process.exit(0);
    } catch (err) {
      const message = mask(err instanceof Error ? err.message : String(err)).replace(/[\s\p{Cc}]+/gu, " ").trim() || "the trick failed";
      process.stderr.write(`${err instanceof Error ? mask(err.stack ?? "") : ""}\nerror: ${message}\n`);
      const id = t?.sessionId ?? (facts !== null && declaredPlaces(facts.trick.dir).includes("session") ? "main" : null);
      if (id === null) process.exit(1);
      const card = v.card([v.para(message.slice(0, 2000))], { tone: "warn" });
      let doc: Document = { v: 1, parts: [{ at: "session", id, subtitle: message.slice(0, 120), tone: "warn", view: [card] }] };
      try {
        if (t !== null) doc = t.printed(doc);
      } catch {
        // A hook that fails on the error card too: the card prints as it is (the bridge masks keys anyway).
      }
      await Bun.write(Bun.stdout, `${JSON.stringify(doc)}\n`);
      process.exit(0);
    }
  })();
}

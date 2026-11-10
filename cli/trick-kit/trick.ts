// collie trick helper v1
// The helper of a Collie trick: it reads the facts, collects the parts and the Decisions, and prints the
// one document the bridge reads. `collie trick init` writes it into the trick folder, and
// `collie trick helper <id>` rewrites it with the newest version. It imports only node: built-ins and
// Bun, so the trick needs no install. Edit your program, not this file: a rewrite replaces it.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Text or inline kids (runs and links), for a para and a line. */
function inline(kind: "para" | "line", body: string | Node[], attrs: Record<string, Num | boolean | undefined>): Node {
  return Array.isArray(body) ? node(kind, undefined, attrs, body) : node(kind, body, attrs);
}

/** The view builders, one per node kind. Each returns a plain node; a view is a list of them. */
export const v = {
  /** A framed box. Holds para, line, chip, button, meter, image, bar, group, number, spacer. */
  card: (kids: Node[], attrs: { tone?: Tone } = {}): Node => node("card", undefined, attrs, kids),
  /** A labelled section. Holds row, group, bar, para, line, meter, number, spacer. */
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
  /** An image file of the trick folder (.png or .jpg), `w` by `h`. Not on a Decision's view. */
  image: (src: string, alt: string, w: Num, h: Num): Node => node("image", undefined, { src, alt, w, h }),
  /** An amount (`role` meter, the default) or a task (`role` progress). */
  meter: (attrs: { value?: Num; max?: Num; tone?: Tone; label?: string; role?: "progress" | "meter" }): Node => node("meter", undefined, attrs),
  /** Air between nodes; with a label, a divider with words. */
  spacer: (label?: string): Node => node("spacer", undefined, { label }),
  /** A big figure ("23/34") with a label. */
  number: (text: Num, attrs: { label?: string; tone?: Tone; unit?: string } = {}): Node => node("number", String(text), attrs),
};

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
  /** Facts drawn under the summary: display kinds only (no button, card or image), 8 KiB, 100 nodes, depth 4. */
  view?: Node[];
}
export interface ShResult { ok: boolean; code: number; stdout: string; stderr: string }
/** What a run prints. `decisions` is left out only after `keepDecisions()`. */
export interface Document { v: 1; parts: Part[]; decisions?: Decision[]; asOf?: string; fresh?: string }

/** The most bytes of stdout and of stderr `t.sh` keeps. */
const SH_CAP = 256 * 1024;

/** A stream read to its end, at most `cap` bytes kept. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for await (const chunk of stream) {
    if (kept >= cap) continue;
    const part = chunk.subarray(0, cap - kept);
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

/** One run of the trick: what the program reads, and the places it fills. */
export class Trick {
  readonly facts: Facts;
  /** `config.toml` of the trick folder, parsed; {} when there is none. */
  readonly config: { [key: string]: TomlValue };
  /** The tap that started this run, or null. */
  readonly tap: Tap | null;
  /** The person's answer to one of this trick's Decisions, or null. */
  readonly hillAnswer: HillAnswer | null;
  /** Small JSON files in the trick's own state folder. */
  readonly state: { get<T extends Json>(name: string, fallback: T): T; set(name: string, value: Json): void };
  /** What this run collected, in order. `document()` prints them. */
  readonly parts: Part[] = [];
  readonly decisions: Decision[] = [];
  /** The id of the session part, once `session()` named one: the error card goes there. */
  sessionId: string | null = null;
  private keep = false;
  private freshFor: string | undefined;
  private asOfAt: string | undefined;

  constructor(facts: Facts) {
    this.facts = facts;
    const configFile = join(facts.trick.dir, "config.toml");
    let text: string | null = null;
    try {
      text = readFileSync(configFile, "utf8");
    } catch {
      text = null;
    }
    // SAFETY: Bun.TOML.parse answers with a table; the program reads each setting it names.
    this.config = text === null ? {} : (Bun.TOML.parse(text) as { [key: string]: TomlValue });
    const t = facts.trigger;
    const tap: Tap | null = t.kind === "tap" ? { intent: t.intent, value: t.value ?? null, node: t.node, rid: t.rid } : null;
    if (tap !== null && t.kind === "tap" && t.seen !== undefined) tap.seen = t.seen;
    this.tap = tap;
    // An answer's value is always `{ text }`: the person's words, or null.
    const words = tap?.value ?? null;
    this.hillAnswer = tap?.node.startsWith("hill/") === true ? { key: tap.node.slice(5), intent: tap.intent, text: words instanceof Object ? words.text : null } : null;
    const file = (name: string): string => {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) throw new Error(`state name "${name}" is not a plain file name`);
      return join(facts.trick.state, name.endsWith(".json") ? name : `${name}.json`);
    };
    this.state = {
      get<T extends Json>(name: string, fallback: T): T {
        try {
          // SAFETY: the file holds what `set` wrote for this name, and the caller names its shape.
          return JSON.parse(readFileSync(file(name), "utf8")) as T;
        } catch {
          return fallback;
        }
      },
      set(name: string, value: Json): void {
        const path = file(name);
        mkdirSync(facts.trick.state, { recursive: true, mode: 0o700 });
        writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      },
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

  /** Run a program without a shell. Never throws: a failure to start is `ok: false` with the reason in `stderr`. */
  async sh(cmd: string, args: string[] = [], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ShResult> {
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

  /** The document this run prints. */
  document(): Document {
    const doc: Document = { v: 1, parts: this.parts };
    if (!this.keep) doc.decisions = this.decisions;
    if (this.asOfAt !== undefined) doc.asOf = this.asOfAt;
    if (this.freshFor !== undefined) doc.fresh = this.freshFor;
    return doc;
  }
}

/** Whether the trick's manifest lists the `session` place. */
function declaresSession(dir: string): boolean {
  try {
    // SAFETY: only `places` is read, and only as a list of strings.
    const places = (Bun.TOML.parse(readFileSync(join(dir, "trick.toml"), "utf8")) as { places?: unknown }).places;
    return Array.isArray(places) && places.includes("session");
  } catch {
    return false;
  }
}

/**
 * The trick's main: read the facts from stdin, call `handler`, print the document once, exit 0. A thrown
 * error prints one warn card in the trick's session and exits 0 when the trick has a session; with
 * none it exits 1, so the bridge's backoff applies. The stack goes to stderr, the message last.
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
      await Bun.write(Bun.stdout, `${JSON.stringify(t.document())}\n`);
      process.exit(0);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/[\s\p{Cc}]+/gu, " ").trim() || "the trick failed";
      process.stderr.write(`${err instanceof Error ? (err.stack ?? "") : ""}\nerror: ${message}\n`);
      const id = t?.sessionId ?? (facts !== null && declaresSession(facts.trick.dir) ? "main" : null);
      if (id === null) process.exit(1);
      const card = v.card([v.para(message.slice(0, 2000))], { tone: "warn" });
      await Bun.write(Bun.stdout, `${JSON.stringify({ v: 1, parts: [{ at: "session", id, subtitle: message.slice(0, 120), tone: "warn", view: [card] }] })}\n`);
      process.exit(0);
    }
  })();
}

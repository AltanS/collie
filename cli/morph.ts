import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { edgeStateDirs, readEnvMarkers } from "./beacon.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { NO_SOCKET_TEXT, shown, type WalkyDeps } from "./walky.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject, asJsonString, parseJson, parseJsonObject } from "../web/src/lib/json.ts";
import { BARE_BAD_REQUEST, unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { MORPH_NOTE_MAX, MORPH_TITLE_MAX, morphShellWord, readMorphSession, type MorphSession } from "../web/src/lib/morph/wire.ts";
import {
  BAR_ROLES,
  BAR_SCROLLS,
  BUTTON_DOES,
  CHIP_STATES,
  CLOCKS,
  COL_ALIGNS,
  CUTS,
  FOLDS,
  IMAGE_FITS,
  LINE_ROLES,
  LINK_RELS,
  METER_ROLES,
  PARA_ROLES,
  PRESSED_STATES,
  STYLE_WORDS,
  TONES,
  TRICK_ICONS,
  NODE_ATTRS,
  NODE_KIDS,
  NODE_KINDS,
  NODE_REQUIRED_ATTRS,
  NODE_TEXT,
  PART_MAX_BYTES,
  VALUE_MAX_BYTES,
  VIEW_LIMITS,
  VIEW_ROOT_KINDS,
  type NodeKind,
} from "../web/src/lib/tricks/schema.ts";

// `collie morph`: Morph from an agent's terminal. Morph is a third view of a session beside Terminal and
// Chat: the operator sends a request from it, and the agent answers by drawing ONE screen. The verb
// talks to the running bridge over the walky socket (`<stateDir>/walky/sock`), one JSON request per
// connection, as `collie hill` does: no token, the socket's mode is the credential, and the bridge names
// the session from the multiplexer's markers this process carries. `--session <address>` may NAME the
// session as well, so a command says which session it is for; the bridge checks the name against the
// markers and refuses `wrong_session` when they differ. An argument never takes the markers' place.
//
// Several bridges may run on one machine. The CLI asks each live one in turn, this install's own first:
// a bridge that does not know the pane answers `not here`, and one built without Morph answers as it
// answers any op it cannot read; both lead to the next.

export const MORPH_SUBCOMMANDS = ["start", "show", "clear", "on", "off", "status", "help"] as const;
type MorphVerb = (typeof MORPH_SUBCOMMANDS)[number];

/** What the CLI prints when no bridge on this machine answered a Morph operation as one it knows. */
export const MORPH_UNKNOWN = "no running Collie on this machine knows Morph";
/** What it prints when a bridge that knows Morph answered, and none of them drives this pane. */
export const MORPH_NOT_HERE = "no Collie bridge on this machine knows this pane";
/** The most bytes `show` reads of its file or stdin. The bridge holds the view to the part cap itself. */
export const MORPH_FILE_MAX = 64 * 1024;

const SESSION_USAGE = "[--session <address>]";

const USAGE = {
  start: [
    `usage: collie morph start ${SESSION_USAGE} ["<what you do>"] [--json]`,
    `  Say first that you are drawing: the phone shows "Morphing…" and your note (3 to 6 words, at most ${String(MORPH_NOTE_MAX)} characters) until your show lands.`,
  ],
  show: [
    `usage: collie morph show ${SESSION_USAGE} <file.json | -> [--title "<one line, at most ${String(MORPH_TITLE_MAX)}>"] [--json]`,
    "  The file holds the view (a list of nodes), or { \"title\": ..., \"view\": [...] }. `-` reads stdin.",
  ],
  clear: [`usage: collie morph clear ${SESSION_USAGE} [--json]   (the screen goes; the switch stays)`],
  on: [`usage: collie morph on ${SESSION_USAGE} [--json]   (turn Morph on for this session)`],
  off: [`usage: collie morph off ${SESSION_USAGE} [--json]`],
  status: [`usage: collie morph status ${SESSION_USAGE} [--json]   (the session, the switch, the screen, and the hint line)`],
  help: [`usage: collie morph help ${SESSION_USAGE}   (what Morph is, your commands with the session filled in, the rules, the kinds, an example)`],
} as const satisfies Record<MorphVerb, readonly string[]>;

/** What Morph is, for an agent with no other context. */
export const MORPH_ABOUT: readonly string[] = [
  "Morph is a third view of your session on Collie, the operator's phone app, beside Terminal and Chat.",
  "When the operator writes to you from Morph, the message starts with [morph] from operator: and ends with a [rules: ...] tail, and you answer by drawing one screen.",
  "A tap on a button reaches you the same way, as tapped \"<label>\" (with the button's value after a colon when it has one, and the group's label after in when the button sits in a labelled group).",
];

/** Where an address stands in a command when none was given: copy it from the request line. */
export const MORPH_SESSION_PLACEHOLDER = "<session>";

/**
 * The two commands an agent runs, in order, as they stand. With a session they are ready to copy; without,
 * the address is a placeholder and the lines say where to copy it from.
 */
export function morphCommandLines(session: string | null): string[] {
  const word = session === null ? null : morphShellWord(session);
  const address = word ?? MORPH_SESSION_PLACEHOLDER;
  const intro =
    word === null
      ? "Your commands (replace <session> with the address after --session in the [rules: ...] line of the request; copy it, never invent one):"
      : `Your commands (the session is filled in; copy them as they stand, with the collie path the [rules: ...] line names when \`collie\` is not on your PATH):`;
  return [
    intro,
    `  1. collie morph start --session ${address} "<3 to 6 words on what you are doing>"`,
    `  2. collie morph show --session ${address} <file.json>`,
  ];
}

/** The rules an agent keeps when it draws. The first one is the one that makes the phone say "Morphing…". */
export const MORPH_RULES: readonly string[] = [
  "Rules:",
  '- FIRST, as the very first thing when a message starts with [morph] from operator: run command 1 above, `morph start`, with 3 to 6 words on what you are doing. Run it again with a new note when the work takes long. Then run command 2, `morph show`. Until the show lands, the phone says "Morphing…" with your note, so the operator knows you read the request.',
  "- Copy the session from the request line (the address after --session), never invent one. A command that names another session than yours is refused.",
  "- One screen per answer. A new show replaces the last one.",
  "- Ask one decision per screen when you can. With several choice groups, redraw after each pick.",
  '- After the operator picks, redraw the screen with "pressed": "true" on the chosen option, or move on to the next screen. Collie marks a tapped button until your next screen arrives, but your redraw is what carries the pick.',
  "- Show only what the operator needs now: the answer, the facts behind it, and the next choices. No logs, no essays.",
  "- Write sentences as `para` nodes. Use `line` only for short monospace text, such as a path or a command.",
  "- For a UI choice, show a preview per option. Pictures are not drawn yet: use a `code` node as a monospace mock.",
  `- A button needs the attrs "label" and "intent" (use "intent": "reply"). "value" is the text sent back to you after the tapped "<label>" words, at most ${String(VALUE_MAX_BYTES)} bytes; without a value, only the label is sent. A button takes no "text".`,
  '- Give a button "confirm" (a short second label) for anything risky: deleting, pushing, spending, anything you cannot undo.',
  '- An attribute with a closed set of values takes one of those and no other, or the whole screen is refused (see Closed sets). A tone for success is "ok", for failure "danger".',
  "- Never imitate a permission dialog, a login, or any part of Collie. A screen is yours, and it reads as yours.",
  `- Stay under the caps: ${String(VIEW_LIMITS.root.max)} top-level nodes, ${String(VIEW_LIMITS.nodes.max)} nodes, ${String(VIEW_LIMITS.depth.max)} levels, ${String(PART_MAX_BYTES / 1024)} KiB of compact JSON. A refusal names the node's path and the reason.`,
  "- Keep answering in the terminal as well when the operator asked there; Morph is only for messages that carry the [morph] from operator: head.",
];

/** Kinds the parser takes that Morph draws no picture for yet: there is no media route in Morph. */
const UNDRAWN_KINDS: readonly NodeKind[] = ["image", "compare"];

/** A kind's row in one of the schema's partial tables, or undefined when the table does not list it. */
function rowOf<T>(table: Readonly<Record<string, T>>, kind: NodeKind): T | undefined {
  return Object.entries(table).find(([key]) => key === kind)?.[1];
}

function kindLine(kind: NodeKind): string {
  const required: readonly string[] = rowOf(NODE_REQUIRED_ATTRS, kind) ?? [];
  const attrs = NODE_ATTRS[kind].map((name) => (required.includes(name) ? `${name}*` : name));
  const text = rowOf(NODE_TEXT, kind);
  const kids = rowOf(NODE_KIDS, kind);
  const parts = [`  ${kind}`];
  if (text !== undefined) parts.push("required" in text && text.required ? "text*" : "text");
  if (attrs.length > 0) parts.push(`attrs: ${attrs.join(", ")}`);
  if (kids !== undefined) parts.push(`kids: ${kids.join(", ")}`);
  return parts.join("  ");
}

/** The kinds and their main attributes, generated from the trick schema's own tables, so it cannot drift. */
export function morphKindLines(): string[] {
  const drawn = NODE_KINDS.filter((kind) => !UNDRAWN_KINDS.includes(kind));
  return [
    "Kinds (* is required; a node is { \"kind\", \"text\"?, \"attrs\"?, \"kids\"? }, every attribute value is text):",
    `  top level: ${VIEW_ROOT_KINDS.filter((kind) => !UNDRAWN_KINDS.includes(kind)).join(", ")}`,
    ...drawn.map(kindLine),
    `  ${UNDRAWN_KINDS.join(", ")}: accepted, but Morph draws no picture yet.`,
  ];
}

/** A closed set: the attribute, the kinds that take it, and its values. The values are the schema's own exports. */
interface ClosedSet {
  readonly attr: string;
  readonly kinds: readonly NodeKind[];
  readonly values: readonly string[];
}

/** The attributes a kind takes, as plain names. */
export function attrsOf(kind: NodeKind): readonly string[] {
  return NODE_ATTRS[kind];
}

function kindsWith(attr: string): NodeKind[] {
  return NODE_KINDS.filter((kind) => attrsOf(kind).includes(attr));
}

/**
 * Every attribute that takes a closed set of values, with its values. Each list is an export of the trick
 * schema, so it cannot drift; the kinds of an attribute that several kinds share (`tone`, `clock`) are read
 * from the schema's attribute table, the others are named here and `cli/morph.test.ts` checks that each
 * pair exists.
 */
export const MORPH_CLOSED_SETS: readonly ClosedSet[] = [
  { attr: "tone", kinds: kindsWith("tone"), values: TONES },
  { attr: "pressed", kinds: ["button"], values: PRESSED_STATES },
  { attr: "does", kinds: ["button"], values: BUTTON_DOES },
  { attr: "role", kinds: ["para"], values: PARA_ROLES },
  { attr: "role", kinds: ["line"], values: LINE_ROLES },
  { attr: "role", kinds: ["meter"], values: METER_ROLES },
  { attr: "role", kinds: ["bar"], values: BAR_ROLES },
  { attr: "scroll", kinds: ["bar"], values: BAR_SCROLLS },
  { attr: "fold", kinds: ["group"], values: FOLDS },
  { attr: "cut", kinds: ["row"], values: CUTS },
  { attr: "clock", kinds: kindsWith("clock"), values: CLOCKS },
  { attr: "state", kinds: ["chip"], values: CHIP_STATES },
  { attr: "rel", kinds: ["link"], values: LINK_RELS },
  { attr: "fit", kinds: ["image"], values: IMAGE_FITS },
  { attr: "align", kinds: ["col"], values: COL_ALIGNS },
  { attr: "icon", kinds: kindsWith("icon"), values: TRICK_ICONS },
  { attr: "style", kinds: kindsWith("style"), values: STYLE_WORDS },
];

/** The closed sets as help lines: `tone (card, row, ...): plain, accent, ...`. */
export function morphClosedSetLines(): string[] {
  return [
    "Closed sets (an attribute with any other value refuses the whole screen; `style` takes several of its words, space separated):",
    ...MORPH_CLOSED_SETS.map((set) => `  ${set.attr} (${set.kinds.join(", ")}): ${set.values.join(", ")}`),
  ];
}

/** One compact, valid screen: a heading, a list of rows, a diff, and a bar of two buttons. */
export const MORPH_EXAMPLE: JsonValue = [
  { kind: "para", text: "Two tests fail after the rename", attrs: { role: "heading" } },
  {
    kind: "list",
    kids: [
      { kind: "row", text: "auth/login.test.ts", attrs: { end: "1 fail", tone: "danger" } },
      { kind: "row", text: "auth/token.test.ts", attrs: { end: "1 fail", tone: "danger" } },
    ],
  },
  { kind: "diff", text: "-  const user = getUser(id)\n+  const user = loadUser(id)", attrs: { file: "src/auth/login.ts" } },
  {
    kind: "bar",
    kids: [
      { kind: "button", attrs: { label: "Fix both", intent: "reply", value: "Fix both failing tests.", tone: "accent" } },
      { kind: "button", attrs: { label: "Revert", intent: "reply", value: "Revert the rename.", confirm: "Revert?" } },
    ],
  },
];

/**
 * `collie morph help [--session <address>]`: what Morph is, your commands, the rules, the kinds with their
 * closed sets, one example, and the sub-verbs. With a session the commands carry it, ready to copy.
 */
export function morphHelp(session: string | null = null): string[] {
  const commands = MORPH_SUBCOMMANDS.flatMap((verb) => USAGE[verb].map((line) => `  ${line.replace(/^usage: /u, "")}`));
  const address = (session === null ? null : morphShellWord(session)) ?? MORPH_SESSION_PLACEHOLDER;
  return [
    ...MORPH_ABOUT,
    "",
    ...morphCommandLines(session),
    "",
    ...MORPH_RULES,
    "",
    ...morphKindLines(),
    "",
    ...morphClosedSetLines(),
    "",
    `Example (save as screen.json, run command 1, then \`collie morph show --session ${address} screen.json\`):`,
    JSON.stringify(MORPH_EXAMPLE),
    "",
    "Commands:",
    ...commands,
  ];
}

/** What `collie morph` needs: walky's own deps (the socket, the markers, stdin). */
export type MorphDeps = Omit<WalkyDeps, "mintId" | "sleep"> & {
  /** The folder a relative file path is read from. Defaults to the process's own. */
  readonly cwd?: () => string;
};

type Answer = { readonly ok: true; readonly body: JsonObject } | { readonly ok: false; readonly error: string; readonly code: string | null; readonly exit: number; readonly refusals: readonly string[] };

function socketPaths(deps: MorphDeps): string[] {
  const own = walkySocketPath(deps.ctx.stateDir);
  const listed = deps.sockets?.() ?? [own, ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

function refusalLines(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asJsonObject(entry);
    const reason = asJsonString(row?.reason);
    return reason === undefined ? [] : [`${asJsonString(row?.path) || "/"}: ${reason}`];
  });
}

/** The request body for an op: the fields, and the session the caller named, when it named one. */
function bodyOf({ op, session, fields }: { op: string; session: string | null; fields?: JsonObject }): JsonObject {
  const body: JsonObject = { op, ...fields };
  if (session !== null) body.session = session;
  return body;
}

/** Ask the bridges in turn until one answers as one that knows Morph and this pane. */
async function request(deps: MorphDeps, body: JsonObject): Promise<Answer> {
  const op = asJsonString(body.op) ?? "";
  const line = `${JSON.stringify({ v: 1, markers: readEnvMarkers(deps.ctx.env), ...body })}\n`;
  let knows = false;
  for (const path of socketPaths(deps)) {
    const raw = await deps.ask(path, line).catch(() => null);
    const answer = raw === null ? undefined : parseJsonObject(raw);
    if (answer === undefined) continue;
    if (answer.ok === true) return { ok: true, body: answer };
    const error = asJsonString(answer.error) ?? "failed";
    if (answer.morph === true) knows = true;
    if (error === "not here" || unknownToBridge(error, op) || answer.morph !== true) continue;
    const code = asJsonString(answer.code) ?? null;
    return { ok: false, error, code, exit: code === null ? EXIT.STATE : EXIT.REFUSED, refusals: refusalLines(answer.refusals) };
  }
  if (knows) return { ok: false, error: MORPH_NOT_HERE, code: null, exit: EXIT.STATE, refusals: [] };
  return { ok: false, error: MORPH_UNKNOWN, code: null, exit: EXIT.UNREACHABLE, refusals: [] };
}

function unknownToBridge(error: string, op: string): boolean {
  return error === BARE_BAD_REQUEST || error === unknownOp(op);
}

function failed(deps: MorphDeps, answer: Extract<Answer, { ok: false }>): number {
  deps.io.err(`morph: ${shown(answer.error)}${answer.code === null ? "" : ` (${shown(answer.code)})`}`);
  for (const line of answer.refusals) deps.io.err(`  ${shown(line)}`);
  return answer.error.startsWith(BARE_BAD_REQUEST) ? EXIT.USAGE : answer.exit;
}

function usage(deps: Pick<MorphDeps, "io">, verb: MorphVerb, why: string): number {
  deps.io.err(`error: ${why}`);
  for (const line of USAGE[verb]) deps.io.err(line);
  return EXIT.USAGE;
}

function windows(deps: MorphDeps): boolean {
  if (deps.platform !== "win32") return false;
  deps.io.err(NO_SOCKET_TEXT);
  return true;
}

/** `show`'s arguments: the source (a path or `-`), the title, and `--json`. */
export interface ShowArgs {
  readonly source: string;
  readonly title: string | null;
  readonly json: boolean;
  readonly session: string | null;
}

/** A `--session` value: one line of text with no blank, the address as the request line spells it. */
function sessionValue(value: string | undefined): { readonly session: string } | { readonly error: string } {
  if (value === undefined) return { error: "`--session` needs the session address from the request line" };
  if (value === "" || /\s/u.test(value) || value.startsWith("-")) return { error: `\`--session\` needs the session address from the request line, not \`${value}\`` };
  return { session: value };
}

/** `show`'s arguments, checked as far as the CLI can check them. An error is the one-line reason. */
export function parseShowArgs(args: readonly string[]): ShowArgs | { readonly error: string } {
  let source: string | null = null;
  let title: string | null = null;
  let json = false;
  let session: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--session") {
      const value = sessionValue(args[i + 1]);
      if ("error" in value) return value;
      if (session !== null) return { error: "`--session` is given twice" };
      session = value.session;
      i += 1;
      continue;
    }
    if (arg === "--title") {
      const value = args[i + 1];
      if (value === undefined) return { error: "`--title` needs a value" };
      if (title !== null) return { error: "`--title` is given twice" };
      title = value;
      i += 1;
      continue;
    }
    if (arg !== "-" && arg.startsWith("-")) return { error: `unknown flag \`${arg}\`` };
    if (source !== null) return { error: `name one file, got \`${source}\` and \`${arg}\`` };
    source = arg;
  }
  if (source === null) return { error: "name the screen's JSON file, or - for stdin" };
  return { source, title, json, session };
}

/** The screen file's text as JSON: a list of nodes, or `{ title?, view }`. An error is the one-line reason. */
export function readScreen(text: string, flagTitle: string | null): { readonly view: JsonValue; readonly title: string | null } | { readonly error: string } {
  if (new TextEncoder().encode(text).length > MORPH_FILE_MAX) return { error: `the screen is larger than ${String(MORPH_FILE_MAX / 1024)} KiB` };
  const parsed = parseJson(text);
  if (parsed === undefined) return { error: "the screen is not JSON" };
  if (Array.isArray(parsed)) return { view: parsed, title: flagTitle };
  const obj = asJsonObject(parsed);
  if (obj === undefined || obj.view === undefined) return { error: 'the screen is a list of nodes, or an object with "view" (and "title")' };
  const extra = Object.keys(obj).find((key) => key !== "view" && key !== "title");
  if (extra !== undefined) return { error: `the screen object takes "view" and "title" only, not "${extra}"` };
  const fileTitle = obj.title === undefined ? null : asJsonString(obj.title);
  if (fileTitle === undefined) return { error: '"title" is text' };
  if (fileTitle !== null && flagTitle !== null) return { error: "the title is given twice: in the file and with `--title`" };
  return { view: obj.view, title: flagTitle ?? fileTitle };
}

function readSource(deps: MorphDeps, source: string): Promise<string> | { readonly error: string } {
  if (source === "-") {
    if (deps.stdinIsTty) return { error: "`-` reads the screen from stdin, and stdin is a terminal" };
    return deps.readStdin();
  }
  const path = resolve((deps.cwd ?? (() => process.cwd()))(), source);
  try {
    const st = statSync(path);
    if (!st.isFile()) return { error: `\`${source}\` is not a file` };
    if (st.size > MORPH_FILE_MAX) return { error: `\`${source}\` is larger than ${String(MORPH_FILE_MAX / 1024)} KiB` };
  } catch {
    return { error: `\`${source}\`: no such file` };
  }
  return Promise.resolve(readFileSync(path, "utf8"));
}

/** The session the bridge answered with, or a failure when it answered without one. */
function sessionOf(answer: Extract<Answer, { ok: true }>): MorphSession | null {
  return readMorphSession(answer.body.morph);
}

const NO_SESSION: Extract<Answer, { ok: false }> = { ok: false, error: "the bridge answered without a session", code: null, exit: EXIT.FAIL, refusals: [] };

/** The lines `status` prints, and the tail of the others. */
export function statusLines(session: MorphSession): string[] {
  const lines = [`session: ${shown(session.session)}`, `morph: ${session.on ? "on" : "off"}`];
  const view = session.view;
  if (view === undefined) lines.push("screen: none");
  else lines.push(`screen: rev ${String(view.rev)} at ${view.at}${view.title === undefined ? "" : `, ${shown(view.title)}`}`);
  if (session.drawing !== undefined) lines.push(`drawing: since ${session.drawing.at}${session.drawing.note === undefined ? "" : `, ${shown(session.drawing.note)}`}`);
  lines.push(`sent as: ${[session.head, "<text>", session.hint].filter((part) => part !== undefined).map((part) => shown(part)).join(" ")}`);
  return lines;
}

function printSession(deps: MorphDeps, session: MorphSession, json: boolean, lead: string | null): number {
  if (json) {
    deps.io.out(JSON.stringify({ morph: session }));
    return EXIT.OK;
  }
  if (lead !== null) deps.io.out(lead);
  for (const line of statusLines(session)) deps.io.out(line);
  return EXIT.OK;
}

/** `morph show <file.json | -> [--title ...]`: draw one screen for this session. */
export async function cmdMorphShow(deps: MorphDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parseShowArgs(args);
  if ("error" in parsed) return usage(deps, "show", parsed.error);
  const text = readSource(deps, parsed.source);
  if ("error" in text) return usage(deps, "show", text.error);
  const screen = readScreen(await text, parsed.title);
  if ("error" in screen) return usage(deps, "show", screen.error);
  const fields: JsonObject = screen.title === null ? { view: screen.view } : { view: screen.view, title: screen.title };
  const answer = await request(deps, bodyOf({ op: "morph.show", session: parsed.session, fields }));
  if (!answer.ok) return failed(deps, answer);
  const session = sessionOf(answer);
  if (session?.view === undefined) return failed(deps, NO_SESSION);
  const lead = session.on
    ? `shown: rev ${String(session.view.rev)}`
    : `stored: rev ${String(session.view.rev)}. Morph is off for this session, so the phone shows it once the operator turns Morph on.`;
  return printSession(deps, session, parsed.json, lead);
}

/** The first line each simple verb prints before the session's lines. */
const SIMPLE_LEADS = { clear: "cleared", on: "turned on", off: "turned off", status: null } as const satisfies Record<"clear" | "on" | "off" | "status", string | null>;

/** The arguments of a verb with no file: `--json` and `--session <address>`, and the words that are neither. */
interface PlainArgs {
  readonly json: boolean;
  readonly session: string | null;
  readonly words: readonly string[];
}

function parsePlainArgs(args: readonly string[]): PlainArgs | { readonly error: string } {
  let json = false;
  let session: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--session") {
      const value = sessionValue(args[i + 1]);
      if ("error" in value) return value;
      if (session !== null) return { error: "`--session` is given twice" };
      session = value.session;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return { error: `unknown flag \`${arg}\`` };
    words.push(arg);
  }
  return { json, session, words };
}

async function simple(deps: MorphDeps, verb: "clear" | "on" | "off" | "status", args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parsePlainArgs(args);
  if ("error" in parsed) return usage(deps, verb, parsed.error);
  if (parsed.words[0] !== undefined) return usage(deps, verb, `unknown argument \`${parsed.words[0]}\``);
  const answer = await request(deps, bodyOf({ op: `morph.${verb}`, session: parsed.session }));
  if (!answer.ok) return failed(deps, answer);
  const session = sessionOf(answer);
  if (session === null) return failed(deps, NO_SESSION);
  return printSession(deps, session, parsed.json, SIMPLE_LEADS[verb]);
}

/**
 * `morph start [--session <address>] [note words...]`: say that you are drawing. The phone shows
 * "Morphing…" and the note until the show lands. Taken while Morph is off, as a show is.
 */
export async function cmdMorphStart(deps: MorphDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parsePlainArgs(args);
  if ("error" in parsed) return usage(deps, "start", parsed.error);
  const note = parsed.words.join(" ").trim();
  const fields: JsonObject = note === "" ? {} : { note };
  const answer = await request(deps, bodyOf({ op: "morph.start", session: parsed.session, fields }));
  if (!answer.ok) return failed(deps, answer);
  const session = sessionOf(answer);
  if (session?.drawing === undefined) return failed(deps, NO_SESSION);
  const lead = session.on ? "started" : "started. Morph is off for this session, so the phone shows it once the operator turns Morph on.";
  return printSession(deps, session, parsed.json, lead);
}

/** `morph clear`: the screen goes, the switch stays. */
export function cmdMorphClear(deps: MorphDeps, args: readonly string[]): Promise<number> {
  return simple(deps, "clear", args);
}

/** `morph on`: turn Morph on for this session. */
export function cmdMorphOn(deps: MorphDeps, args: readonly string[]): Promise<number> {
  return simple(deps, "on", args);
}

/** `morph off`: turn Morph off for this session. The screen is kept. */
export function cmdMorphOff(deps: MorphDeps, args: readonly string[]): Promise<number> {
  return simple(deps, "off", args);
}

/** `morph status`: the switch, the screen, and the hint line. */
export function cmdMorphStatus(deps: MorphDeps, args: readonly string[]): Promise<number> {
  return simple(deps, "status", args);
}

/**
 * `morph help [--session <address>]`: what Morph is, your commands, the rules, the kinds and an example. No
 * bridge is asked: the address only fills the commands in, and any address-shaped text will do.
 */
export function cmdMorphHelp(deps: Pick<MorphDeps, "io">, args: readonly string[] = []): number {
  const parsed = parsePlainArgs(args);
  if ("error" in parsed) return usage(deps, "help", parsed.error);
  if (parsed.json || parsed.words[0] !== undefined) return usage(deps, "help", `unknown argument \`${parsed.json ? "--json" : parsed.words[0]}\``);
  if (parsed.session !== null && morphShellWord(parsed.session) === null) return usage(deps, "help", `\`${parsed.session}\` is not an address`);
  for (const line of morphHelp(parsed.session)) deps.io.out(line);
  return EXIT.OK;
}

/** A bare, misspelt or `--help` `collie morph`: the help. `--help` exits 0, the others 2. */
export function cmdMorph(deps: Pick<MorphDeps, "io">, args: readonly string[]): number {
  const help = args[0] === "--help" || args[0] === "-h";
  if (!help && args[0] !== undefined) deps.io.err(`error: unknown morph command \`${args[0]}\``);
  const print = help ? deps.io.out : deps.io.err;
  for (const line of morphHelp()) print(line);
  return help ? EXIT.OK : EXIT.USAGE;
}

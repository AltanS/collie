import { once } from "node:events";
import { createConnection } from "node:net";

import { readEnvMarkers, edgeStateDirs, type EdgeTargetDeps } from "./beacon.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT, type Io } from "./io.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { inScope, LOCAL_MEMBER, parseAddress, type WalkyScope } from "../bridge/walky/address.ts";
import { OUTSIDE_YOUR_SPACE } from "../bridge/walky/border.ts";
import { readMessage, readReceipt, readSpace } from "../bridge/walky/parse.ts";
import { BARE_BAD_REQUEST, UNREAD_BY_OLDER_BRIDGE } from "../bridge/walky/refusals.ts";
import type { WalkyTotals } from "../bridge/walky/service.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import type { WalkySpace } from "../bridge/walky/space.ts";
import { formatRead, mintWalkyId, OUTCOME_ON_LEAD, RESTING, SENDER_OFF, WALKY_ID, WALKY_OFF, type WalkyMessage, type WalkyReceipt } from "../bridge/walky/types.ts";

// `collie walky`: walky talky from a terminal (M62 spec 02). It talks to the
// running bridge over its local socket, `<stateDir>/walky/sock`, one JSON request per connection.
// No token: the socket's mode is the credential, as the hold socket's is.
//
// Inside a pane the CLI sends the multiplexer's own markers (`readEnvMarkers`, cli/beacon.ts), and
// the bridge that drives that pane names it, so the message is an agent's. Outside any pane the bridge
// refuses a send: the operator sends from the phone, where the paired device proves who it is. Several
// bridges may run on one machine: the CLI asks each live one (the hook target registry, as the hold
// does) until one knows its pane.

export const WALKY_SUBCOMMANDS = ["who", "send", "reply", "inbox", "status", "cancel", "off", "on"] as const;

/** How long `send` waits for the receipt to leave `accepted`. */
export const SEND_WAIT_MS = 15_000;
/** How often `send` asks while it waits. */
export const SEND_POLL_MS = 500;
/** How long one request may take. A send answers at `accepted`, before any key is typed. */
export const ASK_MS = 10_000;

export const NO_SOCKET_TEXT = "walky talky needs a Unix socket on this host";

export interface WalkyDeps extends EdgeTargetDeps {
  readonly io: Io;
  readonly platform: string;
  /** stdin as text, for a body given on no command line. */
  readStdin(): Promise<string>;
  /** Whether stdin is a terminal: then no body on the command line is a usage error, not a wait. */
  readonly stdinIsTty: boolean;
  /**
   * One request line to one socket: the answer line, or null when nothing answered. `ms` is the wait,
   * {@link ASK_MS} when absent. Rejects with {@link AskLate} when the socket took the line and did not
   * answer in time: the request may still run there.
   */
  ask(path: string, line: string, ms?: number): Promise<string | null>;
  /** The socket of every live bridge. Defaults to the hook target registry, then this install's own. */
  sockets?(): readonly string[];
  readonly mintId?: () => string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Every bridge socket on this machine worth asking, this install's own first. */
function socketPaths(deps: WalkyDeps): string[] {
  const own = walkySocketPath(deps.ctx.stateDir);
  const listed = deps.sockets?.() ?? [own, ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

type Answer = { readonly ok: true; readonly body: JsonObject; readonly path: string } | { readonly ok: false; readonly error: string };

/**
 * Ask the bridges in turn. A bridge that answers `not here` does not drive this pane: the next one is
 * asked. So is one that answers the bare `bad request` (added 2026-10-30): a bridge before that day
 * says it to any request it cannot read, before it looks at the markers, so an older release lane
 * asked first (this install's own socket) stopped a `here` send the pane's newer bridge would take.
 * It is reported, in words, only when no other bridge took the request. So is one that holds no message
 * with the id (added 2026-10-30): a machine can run two Collies on one multiplexer, both know the
 * pane, and only one holds the message. A bridge before that day answers `no message <id> ...` as an
 * error, a newer one answers `not here` with the sentence in `missing`; the sentence is printed only
 * when no bridge held the message, the last one asked wins. With `path` set only that bridge is asked
 * (the one that took a send). With `first` set that bridge is asked first and the rest follow.
 */
async function request(deps: WalkyDeps, body: JsonObject, path?: string, first?: string): Promise<Answer> {
  const line = `${JSON.stringify({ v: 1, markers: readEnvMarkers(deps.ctx.env), ...body })}\n`;
  const listed = socketPaths(deps);
  const paths = path !== undefined ? [path] : first === undefined ? listed : [first, ...listed.filter((candidate) => candidate !== first)];
  let notHere = false;
  let unread = false;
  let missing: string | null = null;
  for (const candidate of paths) {
    const raw = await deps.ask(candidate, line).catch(() => null);
    if (raw === null) continue;
    const answer = parseJsonObject(raw);
    if (answer === undefined) continue;
    if (answer.ok === true) return { ok: true, body: answer, path: candidate };
    const error = asJsonString(answer.error) ?? "failed";
    if (error === "not here") {
      notHere = true;
      missing = asJsonString(answer.missing) ?? missing;
      continue;
    }
    if (error.startsWith("no message ")) {
      missing = error;
      continue;
    }
    if (error === BARE_BAD_REQUEST) {
      unread = true;
      continue;
    }
    return { ok: false, error };
  }
  if (missing !== null) return { ok: false, error: missing };
  if (unread) return { ok: false, error: UNREAD_BY_OLDER_BRIDGE };
  if (notHere) return { ok: false, error: "no Collie bridge on this machine knows this pane" };
  return { ok: false, error: "no running Collie bridge answers on this machine" };
}

/** What the bridge says of the pane the CLI runs in. `unknown`: no pane, no bridge, or a bridge before the `pane` op. */
export type PaneKind = "agent" | "shell" | "unknown";

/**
 * Ask the local bridges whether this pane runs an agent (crew slice 3). Outside a pane, with no bridge
 * answering, or with only bridges that do not know the op, the answer is `unknown`: the caller decides
 * what that means. `collie trick on` treats it as a shell, a speed bump and not a wall.
 */
export async function askPaneKind(deps: WalkyDeps): Promise<PaneKind> {
  return (await askPanePlace(deps)).kind;
}

/**
 * Where the bridge placed this pane, with {@link PaneKind}. `session` and `paneId` are set only when the
 * bridge named them (a bridge before 2026-11-11 answers `agent` alone): `collie pair` writes them on the
 * pending code so the pairing's audit line can say which pane made it.
 */
export interface PanePlace {
  readonly kind: PaneKind;
  readonly session?: string;
  readonly paneId?: string;
}

/**
 * Ask the local bridges whether this pane runs an agent, and where they placed it. Outside a pane, with
 * no bridge answering, or with a bridge that does not know the op (1.28.1 and older answer `unknown op`
 * or the bare `bad request`), the answer is `unknown`: the caller decides what that means. `collie pair`
 * treats it as a shell, a speed bump and not a wall.
 */
export async function askPanePlace(deps: WalkyDeps): Promise<PanePlace> {
  if (readEnvMarkers(deps.ctx.env).length === 0) return { kind: "unknown" };
  const answer = await request(deps, { op: "pane" }).catch(() => null);
  if (answer?.ok !== true) return { kind: "unknown" };
  const agent = asJsonBoolean(answer.body.agent);
  if (agent === undefined) return { kind: "unknown" };
  const session = asJsonString(answer.body.session);
  const paneId = asJsonString(answer.body.paneId);
  const kind = agent ? "agent" : "shell";
  return session === undefined || paneId === undefined ? { kind } : { kind, session, paneId };
}

/**
 * A string another machine may have written, as this CLI prints it into a terminal (often an agent's):
 * every control character (C0, DEL, C1) and every bidirectional override becomes `?`, so no escape
 * sequence, line break or reordering reaches the screen. The one place a crew-supplied string is
 * printed through: a receipt's target, reason and writer, `who`'s columns, the target line, an error.
 */
export function shown(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const bidi = (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    out += control || bidi ? "?" : ch;
  }
  return out;
}

function failure(deps: WalkyDeps, answer: { readonly error: string }): number {
  deps.io.err(`walky talky: ${shown(answer.error)}`);
  if (answer.error.startsWith("no running")) return EXIT.UNREACHABLE;
  if (answer.error === "empty body" || answer.error.startsWith(BARE_BAD_REQUEST)) return EXIT.USAGE;
  return EXIT.STATE;
}

function receiptsOf(value: JsonValue | undefined): WalkyReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const receipt = readReceipt(entry);
    return receipt === null ? [] : [receipt];
  });
}

/** The line under a held receipt (M62 spec 02): when it will be typed, and not to send it again. */
export const HELD_HINT = "typed when the box clears or the turn ends, up to 60 minutes. Do not send it again.";

/** What an `inbox-only: resting` receipt reads (M85): a scope or `all` left the message for a session that rests. */
export const RESTING_WORDS = "waiting in the inbox, not typed: the session rests";

/** What a refusal from a session that turned its walky talky off reads (M89): the sender's next step is the operator. */
export const WALKY_OFF_WORDS = `not sent: ${WALKY_OFF}. This session takes messages from its operator only. Ask your operator.`;

/** What a refusal across the space border reads (M98, README decision 10): the three ways through. */
export const OUTSIDE_SPACE_WORDS = `not sent: ${OUTSIDE_YOUR_SPACE}. Use here, reply to a message, or add --outside if your operator asked for it.`;

/** What a refusal reads when the sender's own session is off (M89): the fix is one command. */
export const SENDER_OFF_WORDS = `not sent: ${SENDER_OFF}. Turn it on: collie walky on`;

/** What `collie walky off` prints. */
export const OFF_WORDS = "walky talky off for this session. Other agents cannot message it; your operator still can. Turn it on: collie walky on";

/** The warning beside `off` or `on` when another bridge on this machine is too old to read the verb. */
export const OLDER_BRIDGE_SWITCH = "an older Collie bridge on this machine cannot read this switch; update it, or its panes still take agent messages";

/** What `collie walky on` prints. */
export const ON_WORDS = "walky talky on for this session.";

/** The line under `who`'s table when the asker's own session is off. */
export const YOU_ARE_OFF_WORDS = "Your walky talky is off. Turn it on: collie walky on";

/** `who`'s STATE cell: the pane's state, and that its walky talky is off when it is. */
function stateCell(row: JsonObject): string {
  const state = asJsonString(row.state) ?? "-";
  return row.walky === "off" ? `${state}, walky off` : state;
}

/** Whether a receipt is a held send: `accepted` with the reason that holds it (`draft present`, `turn running`). */
export function isHeld(receipt: WalkyReceipt): boolean {
  return receipt.state === "accepted" && receipt.reason !== undefined;
}

/**
 * A receipt's state in the words a person reads (M62 hardening I). The wire names stay as they are;
 * only what is printed changes. `elsewhere`: the lead keeps this receipt's outcome. A held send reads
 * `held: <reason>`.
 */
export function stateWords(receipt: WalkyReceipt, elsewhere = false): string {
  const reason = receipt.reason === undefined ? undefined : shown(receipt.reason);
  switch (receipt.state) {
    case "accepted":
      if (reason !== undefined) return `held: ${reason}`;
      return elsewhere ? `queued (${OUTCOME_ON_LEAD})` : "queued";
    case "delivered":
      return "typed into the pane";
    case "inbox-only":
      if (receipt.reason === RESTING) return RESTING_WORDS;
      return reason === undefined ? "waiting in the inbox, not typed" : `waiting in the inbox, not typed: ${reason}`;
    case "unknown":
      return reason === undefined ? "may have arrived, will not be sent again" : `may have arrived, will not be sent again (${reason})`;
    case "refused":
      if (receipt.reason === WALKY_OFF) return WALKY_OFF_WORDS;
      if (receipt.reason === SENDER_OFF) return SENDER_OFF_WORDS;
      if (receipt.reason === OUTSIDE_YOUR_SPACE) return OUTSIDE_SPACE_WORDS;
      return reason === undefined ? "not sent" : `not sent: ${reason}`;
    case "expired":
      return "expired";
  }
}

/** How this machine knew the sender, in words. `signer`: the member whose key signed the message. */
export function verifiedWords(receipt: WalkyReceipt, signer: string | null): string {
  switch (receipt.verified) {
    case "origin":
      return `signed by ${shown(signer ?? receipt.by)}`;
    case "lead":
      return "relayed by the lead";
    case "local":
      return "this machine";
    case "none":
      return "not verified";
  }
}

/** One receipt as one line: its target when asked, then its state in words. */
export function receiptLine(receipt: WalkyReceipt, withTarget: boolean, elsewhere: ReadonlySet<string> = new Set()): string {
  const words = stateWords(receipt, receipt.state === "accepted" && elsewhere.has(receipt.target));
  return withTarget ? `${shown(receipt.target)}: ${words}` : words;
}

/** Whether a receipt may still change, so `send` points at `status`: anything not typed and not refused. */
function notTypedYet(receipt: WalkyReceipt): boolean {
  return receipt.state !== "delivered" && receipt.state !== "refused";
}

/** The targets a status answer says only the lead learns the outcome of. */
function elsewhereOf(value: JsonValue | undefined): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((entry) => {
    const target = asJsonString(entry);
    return target === undefined ? [] : [target];
  }));
}

/** The exit code a set of receipts stands for: a refusal is REFUSED, an unknown or expired is FAIL. */
function exitOf(receipts: readonly WalkyReceipt[]): number {
  if (receipts.some((receipt) => receipt.state === "refused")) return EXIT.REFUSED;
  if (receipts.some((receipt) => receipt.state === "unknown" || receipt.state === "expired")) return EXIT.FAIL;
  return EXIT.OK;
}

function windows(deps: WalkyDeps): boolean {
  if (deps.platform !== "win32") return false;
  deps.io.err(NO_SOCKET_TEXT);
  return true;
}

/** What `who` was asked to list (M98): the flags, and the folder filter inside what is listed. */
interface WhoArgs {
  readonly json: boolean;
  /** `--all`: every pane, not only the asking pane's space. */
  readonly all: boolean;
  /** `--here`: the asking pane's space. It is the default from an agent pane; the flag says so, and needs a pane. */
  readonly here: boolean;
  /** `--workspace <repo>[#<branch>]`: a folder, inside the panes listed. */
  readonly folder: WalkyScope | null;
}

/** The scope in words, as the person typed it: `<repo>` or `<repo>#<branch>`. */
function scopeWords(scope: WalkyScope): string {
  return scope.branch === null ? scope.repo : `${scope.repo}#${scope.branch}`;
}

/** `who`'s flags: `--json`, `--all`, `--here`, `--workspace <repo>[#<branch>]`. An error is the one-line reason. */
function parseWhoArgs(args: readonly string[]): WhoArgs | { readonly error: string } {
  let json = false;
  let all = false;
  let here = false;
  let folder: WalkyScope | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--here") {
      here = true;
      continue;
    }
    if (arg !== "--workspace") return { error: `unknown argument \`${arg}\`` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: "`--workspace` needs a folder name: <repo> or <repo>#<branch>" };
    const address = parseAddress(value);
    if (address === null || address.kind !== "workspace") return { error: `\`${value}\` is not a workspace: give a folder name, <repo> or <repo>#<branch>` };
    folder = { repo: address.repo, branch: address.branch };
    i += 1;
  }
  if (all && here) return { error: "`--all` lists every pane and `--here` lists your space: use one of them" };
  return { json, all, here, folder };
}

/** The panes a folder filter keeps. The same rule as the bridge's scope (`inScope`), read over the label column. */
function inFilter(rows: readonly JsonObject[], scope: WalkyScope): JsonObject[] {
  return rows.filter((row) => {
    const address = parseAddress(asJsonString(row.address) ?? "");
    if (address === null || address.kind !== "pane") return false;
    return inScope(asJsonString(row.label) ?? "", address.paneId, scope);
  });
}

/** A space as the bridge sent it, or null when there is none or it is not one (a bridge before 1.29.0 sends none). */
function spaceFromWire(value: JsonValue | undefined): WalkySpace | null {
  const space = readSpace(value);
  if (space === undefined || space === null || space === false) return null;
  return space;
}

/** A row's space, or null for a row from a bridge that sends none. */
function spaceOfRow(row: JsonObject | undefined): WalkySpace | null {
  return spaceFromWire(row?.space);
}

/** The SPACE cell: the label, and for a space with no name of its own that it is this machine's alone. */
function spaceCell(row: JsonObject): string {
  const space = spaceOfRow(row);
  if (space === null) return "-";
  return space.named ? space.label : `${space.label} (this machine)`;
}

/** The line under `who`'s table when panes sit outside the asker's space: how many, and how to list them. */
export function outsideLine(count: number): string {
  return `${String(count)} ${count === 1 ? "pane is" : "panes are"} outside your space. List every pane: collie walky who --all`;
}

/**
 * `walky who [--all] [--workspace <repo>[#<branch>]] [--json]` (M98): from an agent pane, the panes of
 * its own space, with a last line for the ones outside it; `--all` lists every pane. A shell that is no
 * agent pane lists every pane. On a crew member the bridge lists the crew as its lead does.
 */
export async function cmdWalkyWho(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parseWhoArgs(args);
  if ("error" in parsed) return usage(deps, "who", parsed.error);
  const { json, all, here, folder } = parsed;
  const answer = await request(deps, { op: "who" });
  if (!answer.ok) return failure(deps, answer);
  const everyone = Array.isArray(answer.body.targets) ? answer.body.targets.flatMap((entry) => {
    const row = asJsonObject(entry);
    return row === undefined ? [] : [row];
  }) : [];
  const note = asJsonString(answer.body.note);
  const self = asJsonString(answer.body.self);
  // The asker's space: the bridge's word, else the asker's own row. A bridge before 1.29.0 says neither.
  const own = spaceFromWire(answer.body.ownSpace) ?? spaceOfRow(everyone.find((row) => self !== undefined && asJsonString(row.address) === self));
  if (here && own === null) {
    deps.io.err(`walky talky: ${self === undefined ? "`--here` needs a pane: run it inside an agent's pane, or use `--all`" : "this bridge does not say which space this pane is in: use `--all`"}`);
    return EXIT.STATE;
  }
  const bySpace = !all && own !== null;
  const inSpace = own === null ? everyone : everyone.filter((row) => spaceOfRow(row)?.key === own.key);
  const outside = bySpace ? everyone.length - inSpace.length : 0;
  const listed = bySpace ? inSpace : everyone;
  const targets = folder === null ? listed : inFilter(listed, folder);
  if (json) {
    deps.io.out(JSON.stringify(note === undefined ? { self: answer.body.self ?? null, ownSpace: own, targets } : { self: answer.body.self ?? null, ownSpace: own, targets, note }));
    return EXIT.OK;
  }
  if (targets.length === 0) {
    deps.io.out(folder === null ? "no agent panes to message" : `no agent panes in ${shown(scopeWords(folder))}${bySpace ? " (your space)" : ""}`);
    if (note !== undefined) deps.io.out(note);
    if (outside > 0) deps.io.out(outsideLine(outside));
    return EXIT.OK;
  }
  // A solo install with this one agent pane: nobody to message yet, and the reason in one line.
  if (folder === null && note === undefined && outside === 0 && self !== undefined && self.startsWith(`${LOCAL_MEMBER}/`) && targets.length === 1 && asJsonString(targets[0]!.address) === self) {
    deps.io.out(`You are ${shown(self)}. No other agent pane yet. A message needs two.`);
    if (answer.body.selfOff === true) deps.io.out(YOU_ARE_OFF_WORDS);
    return EXIT.OK;
  }
  const rows = targets.map((row) => [asJsonString(row.address), asJsonString(row.machine), asJsonString(row.harness), asJsonString(row.label), spaceCell(row), stateCell(row)].map((cell) => shown(cell ?? "-")));
  const head = ["ADDRESS", "MACHINE", "HARNESS", "LABEL", "SPACE", "STATE"];
  const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  deps.io.out(line(head));
  for (const row of rows) deps.io.out(`${line(row)}${row[0] === self ? "  (you)" : ""}`);
  if (note !== undefined) deps.io.out(note);
  if (outside > 0) deps.io.out(outsideLine(outside));
  if (answer.body.selfOff === true) deps.io.out(YOU_ARE_OFF_WORDS);
  return EXIT.OK;
}

interface SendArgs {
  readonly to: string | null;
  readonly replyTo: string | null;
  readonly text: string | null;
  readonly json: boolean;
  /** `--wake` (M85): a scope or `all` also types into sessions that rest. */
  readonly wake: boolean;
  /** `--outside` (M98): the message may leave the sender's space. */
  readonly outside: boolean;
}

/** `send <address> [text...]`, `--to` and `--reply-to` as aliases, `--wake`, `--outside`, `--` before a text that starts with a dash. */
export function parseSendArgs(args: readonly string[]): SendArgs | { readonly error: string } {
  let to: string | null = null;
  let replyTo: string | null = null;
  let json = false;
  let wake = false;
  let outside = false;
  const words: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      i += 1;
      break;
    }
    // Once the address (or the id) is named, the first word that is not a flag starts the text.
    if (to !== null && !arg.startsWith("--")) break;
    if (arg === "--to" || arg === "--reply-to") {
      const value = args[i + 1];
      if (value === undefined) return { error: `\`${arg}\` needs a value` };
      if (arg === "--to") to = value;
      else replyTo = value;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--wake") {
      wake = true;
      continue;
    }
    if (arg === "--outside") {
      outside = true;
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown flag \`${arg}\`` };
    to = arg;
  }
  words.push(...args.slice(i));
  if (replyTo !== null && !WALKY_ID.test(replyTo)) return { error: `\`${replyTo}\` is not a message id` };
  return { to, replyTo, text: words.length === 0 ? null : words.join(" "), json, wake, outside };
}

function usage(deps: WalkyDeps, verb: (typeof WALKY_SUBCOMMANDS)[number], why: string): number {
  deps.io.err(`error: ${why}`);
  deps.io.err(USAGE[verb]);
  return EXIT.USAGE;
}

const USAGE = {
  who: "usage: collie walky who [--all | --here] [--workspace <repo>[#<branch>]] [--json]   (from an agent pane the list is your space, the default; --all lists every pane)",
  send: "usage: collie walky send <address> [--wake] [--outside] [text...]   (no text: the body is read from stdin; --wake types a scope or all into sessions that rest too; --outside lets the message leave your space, only when your operator asked)",
  reply: "usage: collie walky reply <id> [--outside] [text...]   (no text: the body is read from stdin)",
  inbox: "usage: collie walky inbox [<id>] [--all] [--keep] [--json]",
  status: "usage: collie walky status <id> [--json]",
  cancel: "usage: collie walky cancel <id> [--json]   (a held message you sent; it stays in the inbox, not typed)",
  off: "usage: collie walky off [--json]   (this session: other agents cannot message it, and it cannot message them)",
  on: "usage: collie walky on [--json]   (this session: agents can message it again)",
} as const satisfies Record<(typeof WALKY_SUBCOMMANDS)[number], string>;

/** The body: the words on the command line, or stdin when there are none. */
async function bodyOf(deps: WalkyDeps, text: string | null): Promise<string | null> {
  if (text !== null) return text;
  if (deps.stdinIsTty) return null;
  const read = await deps.readStdin();
  return read.trim() === "" ? null : read;
}

/** The line that names where a message went: `to <address>, <harness>, <label>` when the bridge knows the pane. */
function targetLine(target: JsonValue | undefined, fallback: string): string {
  const row = asJsonObject(target);
  const address = asJsonString(row?.address);
  if (row === undefined || address === undefined) return `to ${shown(fallback)}`;
  const harness = asJsonString(row.harness);
  const label = asJsonString(row.label);
  return `to ${shown([address, harness, label].filter((part): part is string => part !== undefined && part !== "").join(", "))}`;
}

/**
 * Send, then wait up to 15 s for each receipt to leave `accepted`, and print three lines: the id, the
 * pane it went to, and the state in words. A message not typed yet adds where to look later.
 */
async function sendAndWait(deps: WalkyDeps, to: string | null, replyTo: string | null, body: string, json: boolean, first?: string, wake = false, outside = false): Promise<number> {
  const id = (deps.mintId ?? mintWalkyId)();
  // `wake` and `outside` ride the request only when true: a request without them is the one every bridge reads.
  const line: JsonObject = { op: "send", id, to, body, replyTo };
  if (wake) line.wake = true;
  if (outside) line.outside = true;
  const answer = await request(deps, line, undefined, first);
  if (!answer.ok) return failure(deps, answer);
  let receipts = receiptsOf(answer.body.receipts);
  let elsewhere = new Set<string>();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + SEND_WAIT_MS;
  // A receipt for another machine waits the same way: on a member, the lead pushes its outcome back
  // (CREW_PROTOCOL §21). Past the bound it prints as queued, with where to look later.
  while (receipts.some((receipt) => receipt.state === "accepted") && now() < until) {
    await sleep(SEND_POLL_MS);
    const status = await request(deps, { op: "status", id }, answer.path);
    if (!status.ok) break;
    const fresh = receiptsOf(status.body.receipts);
    elsewhere = elsewhereOf(status.body.elsewhere);
    if (fresh.length > 0) receipts = fresh;
  }
  if (json) {
    deps.io.out(JSON.stringify({ id, receipts }));
    return exitOf(receipts);
  }
  deps.io.out(id);
  deps.io.out(targetLine(answer.body.target, to ?? receipts[0]?.target ?? "-"));
  if (receipts.length === 0) deps.io.out("queued");
  else if (receipts.length === 1) deps.io.out(receiptLine(receipts[0]!, false, elsewhere));
  else for (const receipt of receipts) deps.io.out(receiptLine(receipt, true, elsewhere));
  if (receipts.some(isHeld)) deps.io.out(HELD_HINT);
  if (receipts.length === 0 || receipts.some(notTypedYet)) deps.io.out(`check later: collie walky status ${id}`);
  return exitOf(receipts);
}

/** What `--outside` answers from a shell that is no agent pane: an operator's message is not bound to a space. */
export const OUTSIDE_NEEDS_A_PANE = "`--outside` is for an agent's message: run it inside an agent's pane. An operator's message is not bound to a space, so the flag changes nothing";

/** Whether this process runs inside a multiplexer pane (its environment carries a marker), so the bridge takes it for an agent. */
function inAgentPane(deps: WalkyDeps): boolean {
  return readEnvMarkers(deps.ctx.env).length > 0;
}

/** `walky send <address> [text...]`. */
export async function cmdWalkySend(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return usage(deps, "send", parsed.error);
  if (parsed.to === null) return usage(deps, "send", "name an address (see `collie walky who`)");
  if (parseAddress(parsed.to) === null) return usage(deps, "send", `\`${parsed.to}\` is not an address: <member>/<pane>, <member>/<pane>#<token> as \`who\` prints it, <member>/all, all, <repo>, <repo>#<branch> or here`);
  if (parsed.outside && !inAgentPane(deps)) return usage(deps, "send", OUTSIDE_NEEDS_A_PANE);
  const body = await bodyOf(deps, parsed.text);
  if (body === null) return usage(deps, "send", "no text: give it after the address, or on stdin");
  // `here` is the sender's space whatever else is said: the flag is accepted and not sent, so nothing about it changes.
  const outside = parsed.outside && parseAddress(parsed.to)?.kind !== "here";
  return sendAndWait(deps, parsed.to, parsed.replyTo, body, parsed.json, undefined, parsed.wake, outside);
}

/** The first bridge that holds a message, and the message; else the words for why none does. */
async function holderOf(deps: WalkyDeps, id: string): Promise<{ readonly ok: true; readonly message: WalkyMessage; readonly path: string } | { readonly ok: false; readonly error: string }> {
  let reached = false;
  let failed = "no running Collie bridge answers on this machine";
  for (const path of socketPaths(deps)) {
    const asked = await request(deps, { op: "status", id }, path);
    if (!asked.ok) {
      failed = asked.error;
      continue;
    }
    reached = true;
    const message = readMessage(asked.body.message);
    if (message !== null) return { ok: true, message, path };
  }
  return { ok: false, error: reached ? `no message ${id} on this machine` : failed };
}

/** `walky reply <id> [text...]`: send to the pane the message came from, as a reply to it. */
export async function cmdWalkyReply(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return usage(deps, "reply", parsed.error);
  if (parsed.wake) return usage(deps, "reply", "a reply goes to one pane: `--wake` is for a scope or `all`");
  if (parsed.outside && !inAgentPane(deps)) return usage(deps, "reply", OUTSIDE_NEEDS_A_PANE);
  const id = parsed.replyTo ?? parsed.to;
  if (id === null || !WALKY_ID.test(id)) return usage(deps, "reply", "name the message id to reply to (wt_ and 12 characters)");
  // The bridge that holds the message answers the reply: an older one asked first may know this pane
  // and hold no such message (2026-10-30), so every bridge is asked until one holds it.
  const found = await holderOf(deps, id);
  if (!found.ok) return failure(deps, found);
  const { message, path: holder } = found;
  if (message.from.address === null) return failure(deps, { error: `${id} came from an operator, who has no address to reply to` });
  const body = await bodyOf(deps, parsed.text);
  if (body === null) return usage(deps, "reply", "no text: give it after the id, or on stdin");
  // No address: the bridge sends a reply to the stored sender of what it answers, never elsewhere.
  return sendAndWait(deps, null, id, body, parsed.json, holder, false, parsed.outside);
}

/**
 * `walky inbox [<id>] [--all] [--keep] [--json]`. With an id: that one message, header then body (how
 * an agent reads the body its nudge line named). Without: this pane's unread messages, marked read
 * unless `--keep`. `--all`: the last 50 that reached the pane, marked nothing.
 */
export async function cmdWalkyInbox(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const flags = new Set(["--all", "--keep", "--json"]);
  const words = args.filter((arg) => !flags.has(arg));
  const unknown = words.find((arg) => arg.startsWith("-") || !WALKY_ID.test(arg));
  if (unknown !== undefined) return usage(deps, "inbox", WALKY_ID.test(unknown) ? `unknown argument \`${unknown}\`` : `\`${unknown}\` is not a message id`);
  if (words.length > 1) return usage(deps, "inbox", "name at most one message id");
  const id = words[0] ?? null;
  const all = args.includes("--all");
  if (id !== null && all) return usage(deps, "inbox", "an id names one message: drop `--all`");
  const answer = await request(deps, { op: "inbox", all, ack: !args.includes("--keep") && !all, id });
  if (!answer.ok) {
    if (answer.error === "needs a pane") return failure(deps, { error: "an inbox belongs to a pane: run it inside an agent's pane, or use `inbox --all`" });
    return failure(deps, answer);
  }
  const entries = Array.isArray(answer.body.messages) ? answer.body.messages : [];
  if (args.includes("--json")) {
    deps.io.out(JSON.stringify({ pane: answer.body.pane ?? null, messages: entries }));
    return EXIT.OK;
  }
  const messages = entries.flatMap((entry) => {
    const message = readMessage(entry);
    return message === null ? [] : [{ message, receipt: readReceipt(asJsonObject(entry)?.receipt) }];
  });
  if (messages.length === 0) {
    deps.io.out("no messages");
    return EXIT.OK;
  }
  messages.forEach(({ message, receipt }, index) => {
    if (index > 0) deps.io.out("");
    for (const line of formatRead(message, receipt?.via).split("\n")) deps.io.out(line);
    if (all && receipt !== null) deps.io.out(`-- ${receiptLine(receipt, true)}`);
  });
  return EXIT.OK;
}

/** `walky status <id> [--json]`: a message's receipts on this machine. */
export async function cmdWalkyStatus(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const id = rest[0];
  if (id === undefined || rest.length > 1 || !WALKY_ID.test(id)) return usage(deps, "status", "name one message id (wt_ and 12 characters)");
  // Every bridge is asked until one holds receipts for the id: the sender's bridge wrote them.
  let receipts: WalkyReceipt[] = [];
  let elsewhere = new Set<string>();
  let signer: string | null = null;
  let reached = false;
  // A scope send (M75): one line per delivery and the parent's totals, as the bridge counted them.
  let scope: ScopeAnswer | null = null;
  for (const path of socketPaths(deps)) {
    const answer = await request(deps, { op: "status", id }, path);
    if (!answer.ok) continue;
    reached = true;
    receipts = receiptsOf(answer.body.receipts);
    elsewhere = elsewhereOf(answer.body.elsewhere);
    const message = readMessage(answer.body.message);
    signer = message?.signer ?? message?.from.memberId ?? null;
    scope = message === null || !Array.isArray(answer.body.deliveries) ? null : { to: message.to, deliveries: answer.body.deliveries, totals: totalsOf(answer.body.totals) };
    if (receipts.length > 0) break;
  }
  if (!reached) return failure(deps, { error: "no running Collie bridge answers on this machine" });
  if (json) {
    deps.io.out(JSON.stringify(scope === null ? { id, receipts } : { id, receipts, deliveries: scope.deliveries, totals: scope.totals }));
    return receipts.length === 0 ? EXIT.STATE : exitOf(receipts);
  }
  if (receipts.length === 0) {
    deps.io.out(`no record of ${id} on this machine`);
    return EXIT.STATE;
  }
  deps.io.out(id);
  if (scope !== null) deps.io.out(`to ${shown(scope.to)}`);
  for (const receipt of receipts) deps.io.out(`${receiptLine(receipt, true, elsewhere)} (${verifiedWords(receipt, signer)})`);
  if (scope !== null) deps.io.out(totalsLine(scope.totals));
  if (receipts.some(isHeld)) deps.io.out(HELD_HINT);
  return exitOf(receipts);
}

/** What a status answer adds for a scope send (M75): the scope as typed, its deliveries as sent, and the totals. */
interface ScopeAnswer {
  readonly to: string;
  readonly deliveries: JsonValue;
  readonly totals: WalkyTotals;
}

/** A scope's totals per outcome as the bridge sent them: whole counts only, anything else dropped. */
function totalsOf(value: JsonValue | undefined): WalkyTotals {
  const out: WalkyTotals = {};
  for (const [outcome, raw] of Object.entries(asJsonObject(value) ?? {})) {
    const count = asJsonNumber(raw);
    if (count !== undefined && Number.isSafeInteger(count) && count > 0) out[outcome] = count;
  }
  return out;
}

/** The parent's totals of a scope send (M75), one line: `3 deliveries: delivered 2, unreachable 1`. */
export function totalsLine(totals: Readonly<Record<string, number>>): string {
  const entries = Object.entries(totals).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const count = entries.reduce((sum, [, n]) => sum + n, 0);
  const parts = entries.map(([outcome, n]) => `${shown(outcome)} ${String(n)}`).join(", ");
  return `${String(count)} ${count === 1 ? "delivery" : "deliveries"}${parts === "" ? "" : `: ${parts}`}`;
}

/** One target's answer to a take-back, as `cancel` prints it (M62 spec 03). */
export function takeBackLine(result: string, receipt: WalkyReceipt, withTarget: boolean): string {
  const words = receiptLine(receipt, withTarget);
  switch (result) {
    case "taken":
    case "repeat":
      return words;
    case "already typed":
      return `${withTarget ? `${shown(receipt.target)}: ` : ""}already typed, nothing to take back (${stateWords(receipt)})`;
    case "not held":
      return `${withTarget ? `${shown(receipt.target)}: ` : ""}not held, nothing to take back (${stateWords(receipt)})`;
    case "elsewhere":
      return `${withTarget ? `${shown(receipt.target)}: ` : ""}held on another machine: run this on that machine, or drop it from the phone on that pane. It is not cancelled`;
    default:
      return words;
  }
}

/**
 * `walky cancel <id> [--json]` (M62 spec 03): take back a held message this pane sent. The bridge
 * that drives this pane checks it is the sender. A message already typed, or going out now, keeps its
 * receipt and the line says so; a message that waits in the inbox already is printed as it stands.
 */
export async function cmdWalkyCancel(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const id = rest[0];
  if (id === undefined || rest.length > 1 || !WALKY_ID.test(id)) return usage(deps, "cancel", "name one message id (wt_ and 12 characters)");
  const answer = await request(deps, { op: "cancel", id });
  if (!answer.ok) {
    if (answer.error.startsWith("no message ")) {
      deps.io.err(`walky talky: ${shown(answer.error)}`);
      return EXIT.STATE;
    }
    if (answer.error.startsWith("only the sender")) {
      deps.io.err(`walky talky: ${shown(answer.error)}`);
      return EXIT.REFUSED;
    }
    return failure(deps, answer);
  }
  const results = (Array.isArray(answer.body.results) ? answer.body.results : []).flatMap((entry) => {
    const row = asJsonObject(entry);
    const receipt = readReceipt(row?.receipt);
    const result = asJsonString(row?.result);
    return row === undefined || receipt === null || result === undefined ? [] : [{ result, receipt }];
  });
  if (json) {
    deps.io.out(JSON.stringify({ id, results }));
    return results.every((entry) => entry.result === "taken" || entry.result === "repeat") ? EXIT.OK : EXIT.STATE;
  }
  deps.io.out(id);
  if (results.length === 0) deps.io.out("nothing to take back");
  else if (results.length === 1) deps.io.out(takeBackLine(results[0]!.result, results[0]!.receipt, false));
  else for (const entry of results) deps.io.out(takeBackLine(entry.result, entry.receipt, true));
  return results.length > 0 && results.every((entry) => entry.result === "taken" || entry.result === "repeat") ? EXIT.OK : EXIT.STATE;
}

/** Whether a bridge's answer says it could not read the request: a build before the verb. */
function unreadVerb(error: string): boolean {
  return error === UNREAD_BY_OLDER_BRIDGE || error.startsWith(BARE_BAD_REQUEST);
}

/**
 * `walky off|on [--json]`: this pane's own flag (M89). Every bridge is asked, not only the first that
 * takes it: a machine can run two Collies on one multiplexer, both know the pane, and either could type
 * into it. A bridge that does not know the pane answers `not here` and changes nothing.
 */
async function cmdWalkySwitch(deps: WalkyDeps, verb: "off" | "on", args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) return usage(deps, verb, `unknown argument \`${unknown}\``);
  const answers = await Promise.all(socketPaths(deps).map((path) => request(deps, { op: verb }, path)));
  if (!answers.some((answer) => answer.ok)) {
    // The usual walk over the bridges, for the one reason it reports.
    const answer = await request(deps, { op: verb });
    if (!answer.ok) return failure(deps, answer);
  }
  // A bridge that cannot read the verb may still type into this pane: say so, never claim it.
  if (answers.some((answer) => !answer.ok && unreadVerb(answer.error))) deps.io.err(`walky talky: ${OLDER_BRIDGE_SWITCH}`);
  // The socket sets exactly the value asked for (an idempotent set), so the verb is the value held.
  const off = verb === "off";
  if (args.includes("--json")) deps.io.out(JSON.stringify({ off }));
  else deps.io.out(off ? OFF_WORDS : ON_WORDS);
  return EXIT.OK;
}

/** `walky off [--json]`: turn this session's walky talky off. */
export function cmdWalkyOff(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  return cmdWalkySwitch(deps, "off", args);
}

/** `walky on [--json]`: turn this session's walky talky on again. */
export function cmdWalkyOn(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  return cmdWalkySwitch(deps, "on", args);
}

/** A bare or misspelt `collie walky`: the sub-verbs, and a usage exit. */
export function cmdWalky(deps: Pick<WalkyDeps, "io">, args: readonly string[]): number {
  if (args[0] !== undefined) deps.io.err(`error: unknown walky command \`${args[0]}\``);
  deps.io.err(`usage: collie walky {${WALKY_SUBCOMMANDS.join("|")}}`);
  for (const verb of WALKY_SUBCOMMANDS) deps.io.err(`  ${USAGE[verb].replace(/^usage: /u, "")}`);
  return EXIT.USAGE;
}

/** Thrown by {@link askSocket} when a socket took the request line and gave no answer within the wait. */
export class AskLate extends Error {
  constructor(readonly ms: number) {
    super(`no answer within ${String(Math.round(ms / 1000))} s`);
  }
}

/**
 * One request line to a socket, and its one answer line. Null when nothing accepts it or the connection
 * ends without an answer. Rejects with {@link AskLate} when the line was written and no answer came
 * within `ms`: the request may still be running on the other side, so it is not "nothing answered".
 */
export async function askSocket(path: string, line: string, ms = ASK_MS): Promise<string | null> {
  const conn = createConnection({ path });
  conn.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let written = false;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), ms);
  });
  const answered = (async (): Promise<string | null> => {
    const connected = await once(conn, "connect").then(() => true, () => false);
    if (!connected) return null;
    conn.setEncoding("utf8");
    conn.write(line);
    written = true;
    let text = "";
    for await (const chunk of conn) {
      text += String(chunk);
      const at = text.indexOf("\n");
      if (at >= 0) return text.slice(0, at);
      if (text.length > 4 * 1024 * 1024) return null;
    }
    return text === "" ? null : text;
  })();
  const result = await Promise.race([answered, late]);
  clearTimeout(timer);
  conn.destroy();
  if (result !== "late") return result;
  if (written) throw new AskLate(ms);
  return null;
}

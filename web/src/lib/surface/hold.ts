// A hook-held permission (M56 spec 12; the contract is in the M56 README, "Ask", and
// experiments/reader-stability/ARCHITECTURE.md section 3). The harness's permission hook connects to
// the bridge's local socket, posts the request, and waits. The bridge publishes the request as an ask
// with `channel: hook`. A person's tap on the phone becomes the hook's decision. No key is sent.
//
// This module holds the wire shapes between the hook and the bridge, the profile block that says how a
// harness holds, and the pure rules both sides share: the input shown, the hash, and the decision an
// option label stands for. The bridge runs the hold (bridge/surface/hold.ts). The hook runs in the
// harness (cli/hold.ts).
//
// Rules that live here:
//  - The hash binds the kind, the tool, the input shown and the option labels in order. An answer
//    with another hash never becomes a decision.
//  - A label maps to `allow` or `deny`, or to nothing. A label with no decision is never answered
//    through the hook: Collie never grants more or other than the hook can state exactly.
//  - Never auto-allow, never auto-deny. A decision is only ever a person's tap.
//
// Pure: no DOM, no Bun API, no harness name.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "../json";
import { shortHash, type Ask, type AskOption } from "./surface";

/** The version of the hook-to-bridge lines. Bump it when a line changes shape. */
export const HOLD_WIRE_VERSION = 1;

/** The most bytes one request line may hold. A longer line is dropped unread. */
export const HOLD_LINE_MAX = 16 * 1024;

/** The most characters of the input shown that travel to the bridge and the phone. */
export const HOLD_INPUT_MAX = 1000;

/** How long the hook waits for each socket to accept, in ms. */
export const HOLD_CONNECT_MS = 200;

/** The decision a person's tap stands for. */
export type HoldDecision = "allow" | "deny";
export const HOLD_DECISIONS = ["allow", "deny"] as const;

/** One multiplexer marker, as the hook saw it in its environment (cli/beacon.ts `readEnvMarkers`). */
export interface HoldMarker {
  readonly namespace: string;
  readonly scope: string;
  readonly pane: string;
}

/**
 * What the hook posts: one JSON line. `hold: false` says "a dialog is up, but this tool is answered on
 * the screen" (the profile's `screenOnly` list): the bridge takes it as an edge and the hook exits.
 */
export interface HoldRequest {
  readonly v: number;
  readonly harness: string;
  /** The harness pid (the hook's parent) and its start time, for the placement. */
  readonly pid: number;
  readonly pidStartTime: number;
  readonly markers: readonly HoldMarker[];
  readonly tool: string;
  /** The input shown, cut at {@link HOLD_INPUT_MAX}. */
  readonly input: string;
  /** True when the input shown was cut. A cut request is an edge only: nothing is held. */
  readonly cut?: boolean;
  /** The subagent id the request came from, or null for the main session. */
  readonly agent: string | null;
  /** The subagent's type, as the dialog's mark names it. Absent for the main session, or from an older hook. */
  readonly agentType?: string;
  /** The agent's working folder. A dialog names a file in it by the path below it. */
  readonly cwd?: string;
  readonly hold: boolean;
  /** Epoch ms when the hook ran. */
  readonly at: number;
}

/** What the bridge answers on the socket. Anything else, or a closed socket, means "no decision". */
export interface HoldReply {
  readonly decision: HoldDecision;
}

/** What the hook says to a bridge whose ask lost: another bridge answered first. */
export interface HoldElsewhere {
  readonly done: "elsewhere";
}

/** A label pattern and the decision it stands for. */
export interface HoldDecisionRule {
  /** A regular expression source, tested against the option label the screen shows. */
  readonly match: string;
  readonly decision: HoldDecision;
}

/** One option the bridge offers when the screen shows no dialog (a subagent's request). */
export interface HoldOption {
  readonly label: string;
  readonly decision: HoldDecision;
}

/**
 * More of one tool's input the card must show (profile field `hold.inputDetails`, by tool name).
 * `flags`: input keys that change what the tool may do (a sandbox switch, a background run). Each one
 * present shows on its own line with its value. `body`: input keys of the text a tool writes. Each
 * one present shows its size and its start.
 */
export interface HoldInputDetail {
  readonly flags: readonly string[];
  readonly body: readonly string[];
}

/** How a harness holds a permission (profile field `hold`). */
export interface HoldProfile {
  /** The hook event that holds. */
  readonly event: string;
  /** The event that says a tool finished, the edge that ends a "Sent" card. */
  readonly toolEvent: string;
  /** The most ms the bridge holds one request. Below the hook timeout. */
  readonly limitMs: number;
  /** The timeout, in seconds, the install writes on the hook entry. */
  readonly hookTimeoutS: number;
  /** The first harness version that runs the hold event. The install refuses an older one. */
  readonly minVersion: string;
  /** The keys of the tool input shown on the card, first present wins. */
  readonly inputShown: readonly string[];
  /** More input to show for some tools, by tool name. */
  readonly inputDetails: Readonly<Record<string, HoldInputDetail>>;
  /** Tools whose dialog the hook cannot answer: the screen answers them through keys. */
  readonly screenOnly: readonly string[];
  /**
   * The header a permission dialog shows for each tool, by tool name. A hold adopts a dialog only
   * when the header names its own tool. A tool with no entry never adopts: its hold card answers it.
   */
  readonly headers: Readonly<Record<string, readonly string[]>>;
  /**
   * A regular expression source for the header's subagent mark. It shows exactly on a subagent's
   * dialog, and its first group is the subagent's type, which must equal the request's.
   */
  readonly agentMark: string;
  /** The options when no dialog is on the screen. */
  readonly options: readonly HoldOption[];
  /** The rules that map a screen label to a decision, first match wins. */
  readonly decisions: readonly HoldDecisionRule[];
  /** A regular expression source for the screen line that says an allow took effect. */
  readonly decidedLine: string;
  /**
   * The same for a deny. On Claude Code 2.1.301 a deny that stops the turn prints the same line as a
   * No at the desk: the two cannot be told apart on the screen, and they do the same thing.
   */
  readonly deniedLine: string;
  /** The message a deny carries back to the agent. */
  readonly denyMessage: string;
}

/** The ms the hook may run past the bridge's limit before it gives up on its own. */
export const HOLD_GRACE_MS = 2000;

/** The kind of every hook-held ask. */
export const HOLD_ASK_KIND = "permission";

/** The mark at the end of a cut input shown. */
export const HOLD_CUT_MARK = " [cut]";

// Characters that hide text or turn it around on the screen. A command that holds one can show one
// thing and run another, so they go before display and before the hash: the C1 controls (U+0080 to
// U+009F), the soft hyphen (U+00AD), the combining grapheme joiner (U+034F), the Arabic letter mark
// (U+061C), the Mongolian vowel separator and variation selectors (U+180B to U+180F), the zero-width
// marks (U+200B to U+200F), the bidirectional embeddings and overrides (U+202A to U+202E), the word
// joiner and invisible operators (U+2060 to U+2064), the isolates (U+2066 to U+2069), the variation
// selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF), the byte order mark (U+FEFF), the interlinear
// annotation marks (U+FFF9 to U+FFFB) and the tag characters (U+E0000 to U+E007F).
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- each mark stands alone here, written as an escape
  /[\u0080-\u009f\u00ad\u034f\u061c\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** Text with the hiding characters dropped and the control characters made spaces. */
export function cleanShown(text: string): string {
  return text.replace(INVISIBLE, "").replace(CONTROL, " ");
}

/** The input shown, and whether it was cut at {@link HOLD_INPUT_MAX}. */
export interface ShownInput {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * The input shown for a tool input: the first key of `keys` that holds text, else the whole input as
 * compact JSON. Then the tool's details from the profile: each risky flag that is present, and each
 * written body in full, after a line with its size. Hiding characters are dropped, control characters
 * become spaces, and the whole is cut at {@link HOLD_INPUT_MAX} characters. A cut input is marked: the
 * hook then holds nothing, because a person cannot judge what the card does not show.
 */
export function shownInputOf(toolInput: JsonValue | undefined, keys: readonly string[], detail?: HoldInputDetail): ShownInput {
  const node = asJsonObject(toolInput);
  let text = "";
  if (node !== undefined) {
    for (const key of keys) {
      const value = asJsonString(node[key]);
      if (value !== undefined && value.trim().length > 0) {
        text = value;
        break;
      }
    }
    if (text === "") text = JSON.stringify(node);
  } else if (toolInput !== undefined) {
    text = JSON.stringify(toolInput);
  }
  const lines = [text];
  if (node !== undefined && detail !== undefined) {
    for (const flag of detail.flags) {
      const value = node[flag];
      if (value !== undefined && value !== null && value !== false) lines.push(`[${flag}: ${JSON.stringify(value)}]`);
    }
    // The whole body counts against the limit: a longer one makes the input cut, so the screen answers it.
    for (const key of detail.body) {
      const body = asJsonString(node[key]);
      if (body === undefined) continue;
      lines.push(`[${key}: ${String(body.length)} characters, ${String(body.split("\n").length)} lines]`, body);
    }
  }
  const clean = cleanShown(lines.join("\n"));
  // A cut input ends in the cut mark, so every place that shows it says so.
  return clean.length > HOLD_INPUT_MAX ? { text: `${clean.slice(0, HOLD_INPUT_MAX - HOLD_CUT_MARK.length)}${HOLD_CUT_MARK}`, cut: true } : { text: clean, cut: false };
}

/** The input shown as text alone. See {@link shownInputOf}. */
export function shownInput(toolInput: JsonValue | undefined, keys: readonly string[], detail?: HoldInputDetail): string {
  return shownInputOf(toolInput, keys, detail).text;
}

/** The hash of the input shown, which a tool edge carries so the bridge ends only its own hold. */
export function holdInputHash(tool: string, input: string): string {
  return shortHash(["input", tool, cleanShown(input)].join("\n"));
}

/** The hash of a held request: the kind, the tool, the input shown and the option labels in order. */
export function holdHash(tool: string, input: string, labels: readonly string[]): string {
  return shortHash([HOLD_ASK_KIND, tool, input, ...labels].join("\n"));
}

/** Text with every white space dropped. */
function squash(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** The fewest characters a match key may have: shorter text shows up on any screen by chance. */
const MATCH_KEY_MIN = 3;
/** A row that holds only a frame rule, or nothing. */
const RULE_ROW = /^[\s─━═╌┄┈╭╮╰╯┌┐└┘]*$/u;

/** What {@link dialogShowsRequest} compares of a request. */
export type DialogMatchRequest = Pick<HoldRequest, "tool" | "input" | "agent" | "agentType" | "cwd">;

/**
 * The lines of the input shown that come from the tool input itself: every line before the first
 * line the tool's details add (a `[flag: …]` or `[body: …]` line of the profile).
 */
export function inputLinesOf(input: string, detail: HoldInputDetail | undefined): string[] {
  const lines = input.split("\n");
  const names = detail === undefined ? [] : [...detail.flags, ...detail.body];
  const end = lines.findIndex((line, i) => i > 0 && names.some((name) => line.startsWith(`[${name}: `)));
  return end === -1 ? lines : lines.slice(0, end);
}

/**
 * Whether a permission dialog shows this very request, so the hold may take the dialog as its own.
 * Four things must agree. The header names the request's tool (profile `headers`). The header has the
 * subagent mark exactly when the request comes from a subagent. The mark names the request's subagent
 * type; a name on one side only is no match. And every line of the input, in order, fills whole rows
 * of the dialog, each line right after the one before. White space and the `│` gutter are dropped,
 * because the dialog wraps a long line. A path below the agent's folder also matches as the path the
 * dialog prints, relative to that folder. An input too short to tell, or a dialog with no text, never
 * matches: the dialog then stays the screen's own keys ask.
 */
export function dialogShowsRequest(
  dialogText: string | null,
  request: DialogMatchRequest,
  hold: Pick<HoldProfile, "headers" | "agentMark" | "inputDetails">,
): boolean {
  if (dialogText === null) return false;
  const rows = dialogText.split("\n").filter((row) => !RULE_ROW.test(row));
  const header = (rows[0] ?? "").trim();
  const mark = new RegExp(hold.agentMark, "u").exec(header);
  const named = (mark === null ? header : header.slice(0, mark.index)).trim();
  if (!(hold.headers[request.tool] ?? []).includes(named)) return false;
  if ((mark !== null) !== (request.agent !== null)) return false;
  if (mark !== null && (mark[1] ?? "").trim() !== (request.agentType ?? "")) return false;
  const lines = inputLinesOf(request.input, hold.inputDetails[request.tool])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [first, ...rest] = lines;
  if (first === undefined) return false;
  const firsts = [first];
  const cwd = request.cwd === undefined ? "" : request.cwd.replace(/\/+$/u, "");
  if (cwd !== "" && first.startsWith(`${cwd}/`)) firsts.push(first.slice(cwd.length + 1));
  const body = rows.slice(1).map((row) => squash(row.replace(/│/gu, "")));
  return firsts.some((line) => squash(line).length >= MATCH_KEY_MIN && fillsInOrder(body, [line, ...rest].map(squash)));
}

/** Whether the keys fill whole rows in order, each key starting on the row after the one before. */
function fillsInOrder(rows: readonly string[], keys: readonly string[]): boolean {
  for (let start = 0; start < rows.length; start += 1) {
    let at = start;
    for (const key of keys) {
      at = rowsAfter(rows, at, key);
      if (at === -1) break;
    }
    if (at !== -1) return true;
  }
  return false;
}

/** The row after a run from `start` whose rows, joined, read exactly `key`, or -1. */
function rowsAfter(rows: readonly string[], start: number, key: string): number {
  let joined = "";
  for (let end = start; end < rows.length && joined.length < key.length; end += 1) {
    joined += rows[end];
    if (joined === key) return end + 1;
  }
  return -1;
}

/** The decision an option label stands for under the profile, or null when no rule names it. */
export function decisionOf(rules: readonly HoldDecisionRule[], label: string): HoldDecision | null {
  for (const rule of rules) {
    if (new RegExp(rule.match, "u").test(label)) return rule.decision;
  }
  return null;
}

/** The ask a hold publishes. Option ids are the 1-based positions, as a keys ask numbers them. */
export function holdAsk(id: string, tool: string, input: string, labels: readonly string[]): Ask {
  const options: AskOption[] = labels.map((label, index) => ({ id: String(index + 1), label }));
  return { id, kind: HOLD_ASK_KIND, options, channel: "hook", hash: holdHash(tool, input, labels) };
}

/** The hook's stdout for a decision, in the shape the harness reads. */
export function decisionOutput(event: string, decision: HoldDecision, denyMessage: string): string {
  const body = decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: denyMessage, interrupt: true };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, decision: body } });
}

const TEXT_FIELD = /^[\x20-\x7e]{1,128}$/u;
// eslint-disable-next-line no-control-regex -- a marker must hold no control character
const MARKER_FIELD = /^[^\u0000-\u001f]{1,512}$/u;

function readMarkers(value: JsonValue | undefined): HoldMarker[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const out: HoldMarker[] = [];
  for (const item of value) {
    const node = asJsonObject(item);
    const namespace = asJsonString(node?.namespace);
    const scope = asJsonString(node?.scope);
    const pane = asJsonString(node?.pane);
    if (namespace === undefined || scope === undefined || pane === undefined) return null;
    if (!TEXT_FIELD.test(namespace) || !MARKER_FIELD.test(scope) || !MARKER_FIELD.test(pane)) return null;
    out.push({ namespace, scope, pane });
  }
  return out;
}

/** The most characters of an agent's working folder a request carries. */
const CWD_MAX = 4096;

/** Whether a working folder is fit for a request: an absolute path, one line, no hiding character. */
export function isCwd(cwd: string): boolean {
  return cwd.startsWith("/") && cwd.length <= CWD_MAX && cleanShown(cwd) === cwd && !cwd.includes("\n");
}

/** A request line, every field checked, or null. */
export function parseHoldRequest(line: string): HoldRequest | null {
  if (line.length > HOLD_LINE_MAX) return null;
  const node = parseJsonObject(line);
  if (node === undefined || asJsonNumber(node.v) !== HOLD_WIRE_VERSION) return null;
  const harness = asJsonString(node.harness);
  const pid = asJsonNumber(node.pid);
  const pidStartTime = asJsonNumber(node.pidStartTime);
  const tool = asJsonString(node.tool);
  const input = asJsonString(node.input);
  const at = asJsonNumber(node.at);
  const hold = asJsonBoolean(node.hold);
  const agent = node.agent === null || node.agent === undefined ? null : asJsonString(node.agent);
  const markers = readMarkers(node.markers);
  if (harness === undefined || !/^[a-z][a-z0-9-]{0,31}$/u.test(harness)) return null;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return null;
  if (pidStartTime === undefined || !Number.isFinite(pidStartTime)) return null;
  if (tool === undefined || !TEXT_FIELD.test(tool)) return null;
  if (input === undefined || input.length > HOLD_INPUT_MAX) return null;
  if (at === undefined || !Number.isFinite(at) || hold === undefined || markers === null) return null;
  if (agent === undefined || (agent !== null && !TEXT_FIELD.test(agent))) return null;
  if (node.cut !== undefined && asJsonBoolean(node.cut) === undefined) return null;
  const cwd = node.cwd === undefined ? undefined : asJsonString(node.cwd);
  if (node.cwd !== undefined && (cwd === undefined || !isCwd(cwd))) return null;
  const agentType = node.agentType === undefined ? undefined : asJsonString(node.agentType);
  if (node.agentType !== undefined && (agentType === undefined || !TEXT_FIELD.test(agentType) || agent === null)) return null;
  // The hook cleaned the input already; an older hook did not drop the hiding characters.
  const base: HoldRequest = { v: HOLD_WIRE_VERSION, harness, pid, pidStartTime, markers, tool, input: cleanShown(input), agent, hold, at };
  const withType = agentType === undefined ? base : { ...base, agentType };
  const withCwd = cwd === undefined ? withType : { ...withType, cwd };
  return node.cut === true ? { ...withCwd, cut: true } : withCwd;
}

/** A reply line, or null when it is not a decision. */
export function parseHoldReply(line: string): HoldDecision | null {
  const decision = parseJsonObject(line)?.decision;
  return HOLD_DECISIONS.find((word) => word === decision) ?? null;
}

/** Whether a line from the hook says another bridge answered first. */
export function isElsewhereLine(line: string): boolean {
  return parseJsonObject(line)?.done === "elsewhere";
}

/**
 * What the phone shows about a pane's hold, beside the ask on the Surface:
 *  - `held`: the hook waits for a tap.
 *  - `sent`: the tap went to the hook. The card says Sent until a tool edge or the screen moves on.
 *  - `desk`: the desk answered first (or another hook did). The phone's tap, if any, was not used.
 *  - `elsewhere`: another Collie answered first.
 *  - `void`: the hook stopped without a decision. The dialog on the screen is a new card.
 *  - `timeout`: the hold reached its limit. The dialog on the screen is a new card.
 *  - `mismatch`: an answer came with another hash. Collie let the hook go.
 */
export const HOLD_STATES = ["held", "sent", "desk", "keys", "elsewhere", "void", "timeout", "mismatch"] as const;
export type HoldState = (typeof HOLD_STATES)[number];

/** A pane's hold note on the snapshot (`PaneWire.hold`). */
export interface HoldNote {
  readonly askId: string;
  readonly state: HoldState;
  readonly tool: string;
  /** The input shown. The bridge masks it like the mirror when redaction is on. */
  readonly input: string;
  /** True when the request came from a subagent. */
  readonly agent: boolean;
  /** The hold ask's option labels, in order: the hold card draws them and answers by position. */
  readonly options: readonly string[];
  /** The hold ask's hash, which a tap from the hold card carries. */
  readonly hash: string;
  /**
   * True when the hold took the permission dialog on the screen as its own: the screen's card
   * answers it. False: the screen shows no dialog for it, or another one. Only the hold card answers
   * it then, and the phone never maps a screen card onto it.
   */
  readonly adopted: boolean;
  /** When the hold took this state, in epoch ms. */
  readonly since: number;
}

/** A hold note read from the wire, field by field, or null. */
export function readHoldNote(value: JsonValue | undefined): HoldNote | null {
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const askId = asJsonString(node.askId);
  const state = HOLD_STATES.find((word) => word === node.state);
  const tool = asJsonString(node.tool);
  const input = asJsonString(node.input);
  const agent = asJsonBoolean(node.agent);
  const since = asJsonNumber(node.since);
  const hash = asJsonString(node.hash);
  const adopted = asJsonBoolean(node.adopted);
  const options = Array.isArray(node.options) && node.options.length <= 9 ? node.options.map((label) => asJsonString(label)) : undefined;
  if (askId === undefined || state === undefined || tool === undefined || input === undefined || agent === undefined || since === undefined) return null;
  if (hash === undefined || adopted === undefined || options === undefined || options.some((label) => label === undefined)) return null;
  return { askId, state, tool, input, agent, options: options.filter((label): label is string => label !== undefined), hash, adopted, since };
}

/** The hold ask a note names, for a tap from the hold card. Option ids are the 1-based positions. */
export function holdAskOfNote(note: HoldNote): Ask {
  return { id: note.askId, kind: HOLD_ASK_KIND, options: note.options.map((label, index) => ({ id: String(index + 1), label })), channel: "hook", hash: note.hash };
}

/**
 * Whether a tap on a screen card may answer the pane's ask. A keys ask: yes, the screen card is its
 * own. A hook ask: only when the hold took that very dialog as its own (`adopted`) and the note names
 * the same ask. Else the screen card shows another dialog, or a stale one, and its tap must never
 * become a decision for the held request.
 */
export function screenCardMayAnswer(ask: Ask, note: HoldNote | undefined): boolean {
  if (ask.channel !== "hook") return true;
  return note !== undefined && note.state === "held" && note.adopted && note.askId === ask.id;
}

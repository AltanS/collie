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
  /** The subagent id the request came from, or null for the main session. */
  readonly agent: string | null;
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
  /** The keys of the tool input shown on the card, first present wins. */
  readonly inputShown: readonly string[];
  /** Tools whose dialog the hook cannot answer: the screen answers them through keys. */
  readonly screenOnly: readonly string[];
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

/**
 * The input shown for a tool input: the first key of `keys` that holds text, else the whole input as
 * compact JSON. Cut at {@link HOLD_INPUT_MAX} characters. Control characters become spaces.
 */
export function shownInput(toolInput: JsonValue | undefined, keys: readonly string[]): string {
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
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ");
  return clean.length > HOLD_INPUT_MAX ? clean.slice(0, HOLD_INPUT_MAX) : clean;
}

/** The hash of a held request: the kind, the tool, the input shown and the option labels in order. */
export function holdHash(tool: string, input: string, labels: readonly string[]): string {
  return shortHash([HOLD_ASK_KIND, tool, input, ...labels].join("\n"));
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
  return { v: HOLD_WIRE_VERSION, harness, pid, pidStartTime, markers, tool, input, agent, hold, at };
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
export const HOLD_STATES = ["held", "sent", "desk", "elsewhere", "void", "timeout", "mismatch"] as const;
export type HoldState = (typeof HOLD_STATES)[number];

/** A pane's hold note on the snapshot (`PaneWire.hold`). */
export interface HoldNote {
  readonly askId: string;
  readonly state: HoldState;
  readonly tool: string;
  /** The input shown. The bridge masks it like the mirror when redaction is on. */
  readonly input: string;
  /** True when the request came from a subagent: the screen shows no dialog for it. */
  readonly agent: boolean;
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
  if (askId === undefined || state === undefined || tool === undefined || input === undefined || agent === undefined || since === undefined) return null;
  return { askId, state, tool, input, agent, since };
}

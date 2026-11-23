import type { JsonObject } from "../bridge/json.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { HILL_ASK_ID_RE } from "../web/src/lib/hill/wire.ts";
import { edgeStateDirs, promptHashOf, readEnvMarkers, type EdgeTargetDeps } from "./beacon.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { askSocket } from "./walky.ts";

// `collie beacon asks`: the reminder of open asks that rides on the prompt (.adr/0178). One entry of
// Collie's own group for Claude Code's `UserPromptSubmit` and one for `SessionStart`, that
// `collie hooks install claude` writes beside `beacon emit`, which runs at the same time and prints nothing.
//
// THIS RUNS IN EVERY CLAUDE CODE SESSION OF THE USER, at every prompt and every session start. A bug here
// can slow each prompt, leak text into a model's context or close a person's open question, so each rule
// is absolute:
//  - It reads the hook's payload from stdin. It prints NOTHING, or exactly ONE JSON object with
//    `hookSpecificOutput` (`hookEventName` and `additionalContext`). It always exits 0 and never throws to
//    the terminal. It never prints a `decision`, never blocks a prompt, never changes the prompt.
//  - It has a hard time limit of its own, {@link ASKS_LIMIT_MS}, for the whole verb (the socket walk too),
//    below the timeout the install writes. After it, it prints nothing and exits, whatever is still pending.
//  - The gates, in this order, each one silent with exit 0: the payload is not JSON; the event is neither
//    `UserPromptSubmit` nor `SessionStart`; the payload names a subagent or a teammate (`agent_id`); a
//    session start whose source gets nothing (`startup`, or any other than clear, compact, resume, fork);
//    no multiplexer markers; no bridge answers a valid list (every other answer, a refusal or "none" too,
//    leads to the next bridge, since bridges of different releases can share a machine and a pane).
//  - It never decides. The bridge decides (bridge/hill/service.ts `askRemind`), and only it closes asks on
//    `/clear`. The prompt text never leaves this process: the bridge gets only its salted hash, salted with
//    that bridge's own send salt, as `beacon emit` hashes it for the prompt edge.
//
// The facts it relies on, from code.claude.com/docs/en/hooks (read 2026-11-23), are listed in .adr/0178.

/** The hook's own time limit, for the whole verb. The install writes `timeout: 3` (seconds). */
export const ASKS_LIMIT_MS = 1000;

/** How many asks the text lists, and how long a question may be in it. */
const LISTED_MAX = 5;
const QUESTION_SHOWN_MAX = 90;

/** The two events the verb answers. */
const ASKS_EVENTS = ["UserPromptSubmit", "SessionStart"] as const;
type AsksEvent = (typeof ASKS_EVENTS)[number];

/** The `SessionStart` sources the bridge is asked about. Every other source (`startup` too) gets nothing. */
export const ASKS_START_SOURCES: readonly string[] = ["clear", "compact", "resume", "fork"];

/** One ask the bridge listed. */
export interface ListedAsk {
  readonly id: string;
  readonly title: string;
}

/** One live bridge: its walky socket and its state folder (whose send salt hashes the prompt). */
export interface AsksBridge {
  readonly socket: string;
  readonly stateDir: string;
}

export interface BeaconAsksDeps extends EdgeTargetDeps {
  readStdin(): Promise<string>;
  /** The live bridges. Defaults to this install's own, then every bridge the hook target registry lists. */
  bridges?(): readonly AsksBridge[];
  /** One request line, one answer line, within `ms`; null on any failure. Never throws. */
  ask(path: string, line: string, ms: number): Promise<string | null>;
  /** Write the one line to stdout. */
  print(text: string): Promise<void>;
  /** The binary the commands in the text name: the one the skill names for this install. */
  binary(): string;
  readonly now?: () => number;
  /** Defaults to a real timer. */
  readonly after?: (ms: number, run: () => void) => () => void;
}

/** Whether a code point is a control character (C0, DEL, C1), a bidi control or a line or paragraph separator. */
function controlPoint(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  return (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** A question as the text shows it: control characters removed, white space folded, quotes made safe, cut to 90 characters. */
export function shownQuestion(title: string): string {
  let clean = "";
  for (const ch of title) clean += controlPoint(ch.codePointAt(0) ?? 0) ? " " : ch;
  const flat = clean.replace(/\s+/gu, " ").trim().replaceAll('"', "'");
  const points = [...flat];
  return points.length <= QUESTION_SHOWN_MAX ? flat : `${points.slice(0, QUESTION_SHOWN_MAX - 1).join("")}…`;
}

/** The full form: each ask with its question, and how to close one. */
export function fullReminder(asks: readonly ListedAsk[], binary: string): string {
  const lines = ["Collie: your open asks."];
  for (const ask of asks.slice(0, LISTED_MAX)) lines.push(`  ${ask.id} "${shownQuestion(ask.title)}"`);
  lines.push(
    "If this message or your work settles one, close it with your next command:",
    `  ${binary} walky cancel <id>... --answered   (or --because "<reason>", or ask --replaces <id>)`,
    "Still true: do nothing.",
  );
  return lines.join("\n");
}

/** The short form, for the set the session was shown last time: the ids only. */
export function shortReminder(asks: readonly ListedAsk[]): string {
  const ids = asks.slice(0, LISTED_MAX).map((ask) => ask.id);
  return `Collie: ${ids.length === 1 ? "ask" : "asks"} ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} still open. Close what this turn settles.`;
}

/** The one line the hook prints: the event's context, and nothing else. */
export function asksOutput(event: AsksEvent, context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

/** The form and the asks of a list answer, each checked; null when the answer is anything else. */
export function remindListOf(raw: string | null): { readonly form: "full" | "short"; readonly asks: ListedAsk[] } | null {
  const answer = raw === null ? undefined : parseJsonObject(raw);
  if (answer === undefined || answer.ok !== true || (answer.remind !== "full" && answer.remind !== "short") || !Array.isArray(answer.asks)) return null;
  if (answer.asks.length === 0 || answer.asks.length > LISTED_MAX) return null;
  const asks: ListedAsk[] = [];
  for (const entry of answer.asks) {
    const row = asJsonObject(entry);
    const id = row === undefined ? undefined : asJsonString(row.id);
    const title = row === undefined ? undefined : asJsonString(row.title);
    if (id === undefined || !HILL_ASK_ID_RE.test(id) || title === undefined) return null;
    asks.push({ id, title });
  }
  return { form: answer.remind, asks };
}

/** What the payload asks of the bridges, or null when the verb stays silent without asking any. */
export type AsksAsk = { readonly event: "UserPromptSubmit" } | { readonly event: "SessionStart"; readonly source: string };

/** The payload's question for the bridges, or null for every payload the verb answers with silence at once. */
export function asksOfPayload(payload: JsonObject): AsksAsk | null {
  const event = ASKS_EVENTS.find((name) => name === payload.hook_event_name);
  if (event === undefined) return null;
  // A subagent or a teammate is not the pane's session: its prompt and its start get nothing.
  if (payload.agent_id !== undefined && payload.agent_id !== null) return null;
  if (event === "UserPromptSubmit") return { event };
  const source = asJsonString(payload.source);
  return source !== undefined && ASKS_START_SOURCES.includes(source) ? { event, source } : null;
}

/** This install's own bridge first, then every bridge the hook target registry lists, as the hold walks them. */
function bridgesOf(deps: BeaconAsksDeps): AsksBridge[] {
  const listed = deps.bridges?.() ?? [deps.ctx.stateDir, ...edgeStateDirs(deps)].map((stateDir) => ({ socket: walkySocketPath(stateDir), stateDir }));
  const seen = new Set<string>();
  return listed.filter((bridge) => {
    if (seen.has(bridge.socket)) return false;
    seen.add(bridge.socket);
    return holdSocketSafe(deps, bridge.socket);
  });
}

/**
 * The whole verb, without the time limit. The line to print, or null for silence.
 *
 * Only a valid list ends the walk. Every other answer leads to the next bridge: no answer, a late answer,
 * text that is not JSON, `not here`, a refusal, `remind: "none"`, a list that fails its checks. The walk
 * stays bounded by the list of bridges and by the one deadline of the whole verb.
 */
async function decide(deps: BeaconAsksDeps, deadline: number): Promise<string | null> {
  const payload = parseJsonObject(await deps.readStdin());
  if (payload === undefined) return null;
  const asked = asksOfPayload(payload);
  if (asked === null) return null;
  const markers = readEnvMarkers(deps.ctx.env);
  if (markers.length === 0) return null;
  const now = deps.now ?? Date.now;
  for (const bridge of bridgesOf(deps)) {
    const left = deadline - now();
    if (left <= 0) return null;
    const event: JsonObject = asked.event === "SessionStart" ? { event: "start", source: asked.source } : { event: "prompt", promptHash: promptHashOf(deps, bridge.stateDir, payload), at: now() };
    const line = `${JSON.stringify({ v: 1, markers, op: "ask.remind", ...event })}\n`;
    const list = remindListOf(await deps.ask(bridge.socket, line, left).catch(() => null));
    if (list === null) continue;
    const text = list.form === "short" ? shortReminder(list.asks) : fullReminder(list.asks, deps.binary());
    return asksOutput(asked.event, text);
  }
  return null;
}

/**
 * `collie beacon asks`: one hook payload in, at most one line out. ALWAYS returns `EXIT.OK`; prints only what
 * a bridge listed, within {@link ASKS_LIMIT_MS}.
 */
export async function cmdBeaconAsks(deps: BeaconAsksDeps): Promise<number> {
  try {
    const now = deps.now ?? Date.now;
    const after = deps.after ?? realAfter;
    const stops: Array<() => void> = [];
    const late = new Promise<null>((done) => {
      stops.push(after(ASKS_LIMIT_MS, () => done(null)));
    });
    const out = await Promise.race([decide(deps, now() + ASKS_LIMIT_MS).catch(() => null), late]);
    for (const stop of stops) stop();
    if (out !== null) await deps.print(out);
    return EXIT.OK;
  } catch {
    return EXIT.OK;
  }
}

/** A real timer, cancelled by the function it returns. */
function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

/** The verb, with its dependency construction inside the same guarantee. */
export async function runBeaconAsks(build: () => BeaconAsksDeps): Promise<number> {
  try {
    return await cmdBeaconAsks(build());
  } catch {
    return EXIT.OK;
  }
}

/** One request line, one answer line over a Unix socket, within `ms`; null on any failure, a late answer too. Never throws. */
export function socketAsk(path: string, line: string, ms: number): Promise<string | null> {
  return askSocket(path, line, Math.max(1, ms)).catch(() => null);
}

import type { JsonObject } from "../bridge/json.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { HILL_ID_RE } from "../web/src/lib/hill/wire.ts";
import { edgeStateDirs, readEnvMarkers, type EdgeTargetDeps } from "./beacon.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { askSocket } from "./walky.ts";

// `collie beacon check`: the check at the end of a turn (.adr/0177). The second entry of the Claude Code
// `Stop` hook group that `collie hooks install claude` writes, beside `beacon emit`, which runs at the same
// time and still prints nothing.
//
// THIS RUNS IN EVERY CLAUDE CODE SESSION OF THE USER, at every end of a turn. A bug here can wedge an agent or
// loop a paid model call, so each rule is absolute:
//  - It reads the hook's payload from stdin. It prints NOTHING, or exactly ONE line: the JSON object that
//    blocks the stop with a reason. It always exits 0, and never throws to the terminal.
//  - It has a hard time limit of its own, {@link CHECK_LIMIT_MS}, well below the 10 s the install gives the
//    hook. After it, it prints nothing and exits, whatever is still pending.
//  - The gates, in this order, each one silent with exit 0: a stop hook already continued this stop
//    (`stop_hook_active`); the payload is not a main agent's `Stop` (a subagent, a teammate); no multiplexer
//    markers; no bridge answers; the bridge's answer is anything but "check".
//  - It never decides. The bridge decides (bridge/hill/check.ts): once per operator turn, the brake, the
//    Hill's switch. This verb only prints what the bridge listed.
//
// The facts it relies on, from code.claude.com/docs/en/hooks.md (read 2026-11-23): a `Stop` hook gets
// `stop_hook_active`, true when Claude Code already continues because of a stop hook; it prints
// `{"decision":"block","reason":"..."}` on exit 0 to keep Claude going with the reason as its next
// instruction; stdout counts as that JSON only when it is the one object on stdout; the hooks of one event
// run in parallel; a subagent's end fires `SubagentStop`, and `agent_id` names a subagent or teammate.

/** The hook's own time limit. The install writes `timeout: 10` (seconds). */
export const CHECK_LIMIT_MS = 3000;

/** How many asks the text lists, and how long a question may be in it. */
const LISTED_MAX = 5;
const QUESTION_SHOWN_MAX = 90;

/** One ask the bridge listed. */
export interface CheckAsk {
  readonly id: string;
  readonly title: string;
  readonly at: number;
}

export interface BeaconCheckDeps extends EdgeTargetDeps {
  readStdin(): Promise<string>;
  /** The socket paths of the live bridges. Defaults to this install's own, then every listed bridge's. */
  sockets?(): readonly string[];
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

/** A question as the text shows it: control characters removed, white space folded, cut to 90 characters. */
export function shownQuestion(title: string): string {
  let clean = "";
  for (const ch of title) clean += controlPoint(ch.codePointAt(0) ?? 0) ? " " : ch;
  const flat = clean.replace(/\s+/gu, " ").trim().replaceAll('"', "'");
  const points = [...flat];
  return points.length <= QUESTION_SHOWN_MAX ? flat : `${points.slice(0, QUESTION_SHOWN_MAX - 1).join("")}…`;
}

/** How long an ask has been open, in one short phrase. */
export function openFor(ms: number): string {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} hours`;
  return `${String(Math.floor(hours / 24))} days`;
}

/** The reason the agent reads: the asks, the four ways to answer each, the question about the reply. */
export function checkReason(asks: readonly CheckAsk[], binary: string, now: number): string {
  const listed = asks.slice(0, LISTED_MAX);
  const lines = [`Collie: you have ${String(listed.length)} open ask${listed.length === 1 ? "" : "s"}. Check each one now.`];
  for (const ask of listed) lines.push(`  ${ask.id}  "${shownQuestion(ask.title)}"  open ${openFor(now - ask.at)}`);
  lines.push(
    "For each ask do one thing:",
    `  still true            ${binary} walky keep <id>`,
    `  changed               ${binary} walky ask "..." --replaces <id> ...`,
    `  no longer true        ${binary} walky cancel <id>`,
    `  answered in this session   ${binary} walky cancel <id> --answered`,
    "Did your reply or your notes leave a question to your operator? Send it as an ask.",
    "Then stop. Write no other text.",
  );
  return lines.join("\n");
}

/** The one line the hook prints: the block answer. */
export function checkOutput(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

/** The asks of a "check" answer, each checked; null when the answer is anything else. */
export function checkAsksOf(raw: string | null): CheckAsk[] | null {
  const answer = raw === null ? undefined : parseJsonObject(raw);
  if (answer === undefined || answer.ok !== true || answer.check !== "check" || !Array.isArray(answer.asks)) return null;
  const asks: CheckAsk[] = [];
  for (const entry of answer.asks.slice(0, LISTED_MAX)) {
    const row = asJsonObject(entry);
    const id = row === undefined ? undefined : asJsonString(row.id);
    const title = row === undefined ? undefined : asJsonString(row.title);
    const at = row === undefined ? undefined : asJsonNumber(row.at);
    if (id === undefined || !HILL_ID_RE.test(id) || title === undefined || at === undefined || !Number.isFinite(at)) return null;
    asks.push({ id, title, at });
  }
  return asks.length === 0 ? null : asks;
}

/** Whether the payload is a main agent's `Stop` that no stop hook continued yet: the only one the check answers. */
export function checkablePayload(payload: JsonObject): boolean {
  // Absent or false, nothing else: a value we cannot read counts as "already continued".
  if (payload.stop_hook_active !== undefined && payload.stop_hook_active !== false) return false;
  if (payload.hook_event_name !== "Stop") return false;
  return payload.agent_id === undefined || payload.agent_id === null;
}

/** This install's own socket first, then every bridge the hook target registry lists, as the hold walks them. */
function socketPaths(deps: BeaconCheckDeps): string[] {
  const listed = deps.sockets?.() ?? [walkySocketPath(deps.ctx.stateDir), ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

/** The whole check, without the time limit. The line to print, or null for silence. */
async function decide(deps: BeaconCheckDeps, deadline: number): Promise<string | null> {
  const payload = parseJsonObject(await deps.readStdin());
  if (payload === undefined || !checkablePayload(payload)) return null;
  const markers = readEnvMarkers(deps.ctx.env);
  if (markers.length === 0) return null;
  const now = deps.now ?? Date.now;
  const line = `${JSON.stringify({ v: 1, markers, op: "ask.check" })}\n`;
  for (const path of socketPaths(deps)) {
    const left = deadline - now();
    if (left <= 0) return null;
    const raw = await deps.ask(path, line, left).catch(() => null);
    const answer = raw === null ? undefined : parseJsonObject(raw);
    if (answer === undefined) continue;
    // Another bridge on this machine may hold the pane.
    if (answer.ok === false && answer.error === "not here") continue;
    const asks = checkAsksOf(raw);
    return asks === null ? null : checkOutput(checkReason(asks, deps.binary(), now()));
  }
  return null;
}

/**
 * `collie beacon check`: one Stop payload in, at most one line out. ALWAYS returns `EXIT.OK`; prints only
 * what a bridge listed, within {@link CHECK_LIMIT_MS}.
 */
export async function cmdBeaconCheck(deps: BeaconCheckDeps): Promise<number> {
  try {
    const now = deps.now ?? Date.now;
    const after = deps.after ?? realAfter;
    const stops: Array<() => void> = [];
    const late = new Promise<null>((done) => {
      stops.push(after(CHECK_LIMIT_MS, () => done(null)));
    });
    const out = await Promise.race([decide(deps, now() + CHECK_LIMIT_MS).catch(() => null), late]);
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
export async function runBeaconCheck(build: () => BeaconCheckDeps): Promise<number> {
  try {
    return await cmdBeaconCheck(build());
  } catch {
    return EXIT.OK;
  }
}

/** One request line, one answer line over a Unix socket, within `ms`; null on any failure, a late answer too. Never throws. */
export function socketAsk(path: string, line: string, ms: number): Promise<string | null> {
  return askSocket(path, line, Math.max(1, ms)).catch(() => null);
}

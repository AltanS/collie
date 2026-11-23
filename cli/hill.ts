import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { edgeStateDirs, readEnvMarkers } from "./beacon.ts";
import { HILL_WRITING } from "./hill-rules.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { AskLate, NO_SOCKET_TEXT, paneNotProvenShell, shown, type PaneKind, type WalkyDeps } from "./walky.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { HILL_POST_ASK_MS } from "../bridge/hill/crew.ts";
import { readDecision } from "../bridge/hill/parse.ts";
import { HILL_STATE_ON_LEAD } from "../bridge/hill/service.ts";
import { deriveMode } from "../bridge/crew/mode.ts";
import { enrollmentOf, parseTrustStore, trustStorePath } from "../bridge/crew/trust-store.ts";
import { readHillSwitch, setHillSwitch, type SwitchFollower } from "../bridge/hill/switch.ts";
import { hillCrewStatePath, readHillCrewState, writeHillCrewState } from "../bridge/hill/crew-state.ts";
import { readCrewStateView } from "../bridge/hill/crew.ts";
import { BARE_BAD_REQUEST, unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import {
  HILL_MEDIA_CAPTION_MAX,
  crewStateLine,
  isHillCrewState,
  type HillCrewState,
  type HillCrewStateView,
  type HillDecision,
  type HillImageInput,
} from "../web/src/lib/hill/wire.ts";

// `collie asks` (the person's verbs) and the socket walk `collie walky ask` shares (cli/ask.ts). Until the
// clean slate of ADR 0179 this was `collie hill` (M96); every old `collie hill` verb now fails with one line
// that names its new verb, and nothing of it runs. The verbs talk to the running
// bridge over the walky socket (`<stateDir>/walky/sock`), one JSON request per connection, exactly as
// `collie walky` does: no token, the socket's mode is the credential, and the bridge names the poster
// from the multiplexer's markers this process carries.
//
// Several bridges may run on one machine, of different releases. The CLI asks each live one in turn: a
// bridge that does not know the pane answers `not here`, and one that does not know the hill answers as
// it answers any op it cannot read; both lead to the next. When no bridge knows the hill, it says so.

/** The verbs of `collie asks`: the person's own. An agent asks with `collie walky ask`. */
export const ASKS_SUBCOMMANDS = ["clear", "state", "on", "off"] as const;

export { HILL_WRITING };

/** What the CLI prints when no bridge on this machine answered a hill operation as one it knows. */
export const HILL_UNKNOWN = "no running Collie on this machine knows Asks";
/** What it prints when a bridge took the post and gave no answer in time: it may still post. */
export const HILL_NOT_CONFIRMED = `the bridge took the post and did not answer within ${String(HILL_POST_ASK_MS / 1000)} s; the post is not confirmed and may still reach Asks`;
/** What it prints when a bridge that knows the hill answered, and none of them drives this pane. */
export const HILL_NOT_HERE = "no Collie bridge on this machine knows this pane";

/** The old verbs of `collie hill`, gone with the clean slate (ADR 0179), and the verb that took each one's place. */
export const OLD_HILL_VERBS = {
  post: "collie walky ask",
  status: "collie walky status",
  withdraw: "collie walky cancel",
  list: "collie walky asks",
  clear: "collie asks clear",
  state: "collie asks state",
  on: "collie asks on",
  off: "collie asks off",
} as const;

/** Each verb as one line of the help, and after `usage: collie asks ` as the line of a usage error. */
const VERB_LINES = {
  clear: "clear [--spoken]",
  state: "state [here|quiet|away]",
  on: "on",
  off: "off",
} as const satisfies Record<(typeof ASKS_SUBCOMMANDS)[number], string>;

/** What a usage error prints for a verb. */
const USAGE = {
  clear: [`usage: collie asks ${VERB_LINES.clear} [--json]`],
  state: [`usage: collie asks ${VERB_LINES.state} [--json]`],
  on: ["usage: collie asks on"],
  off: ["usage: collie asks off"],
} as const satisfies Record<(typeof ASKS_SUBCOMMANDS)[number], readonly string[]>;

/** The one line `collie asks --help` opens with: what the verb is, apart from `collie walky asks`. */
export const ASKS_WHAT = "Asks: your own verbs for the open questions your agents and tricks send you. An agent's own list is collie walky asks.";

/** `collie asks --help`, and the same text for a bare or misspelt `collie asks`. */
export function asksHelp(): string[] {
  return [`usage: collie asks {${ASKS_SUBCOMMANDS.join("|")}} [--json]`, ASKS_WHAT, ...ASKS_SUBCOMMANDS.map((verb) => `  ${VERB_LINES[verb]}`)];
}

/** What `collie hill` needs: walky's own deps (the socket, the markers, stdin), and a request id mint. */
export type HillDeps = Omit<WalkyDeps, "mintId" | "sleep"> & {
  readonly mintRequestId?: () => string;
  /** The folder a relative `--image` path is read from. Defaults to the process's own. */
  readonly cwd?: () => string;
  /** Where a picture under /tmp is copied for the bridge. Defaults to `<XDG_CACHE_HOME or ~/.cache>/collie/image-staging`. */
  readonly stagingRoot?: () => string;
  /**
   * What the local bridge says of the pane this runs in (`askPaneKind`, cli/walky.ts), for the person's
   * verbs (`state <word>`, `clear --spoken`), as `collie trick on` asks it. None: not asked, so allowed.
   */
  readonly paneKind?: () => Promise<PaneKind>;
};

/** Every bridge socket on this machine worth asking, this install's own first, as `collie walky` asks them. */
function socketPaths(deps: HillDeps): string[] {
  const own = walkySocketPath(deps.ctx.stateDir);
  const listed = deps.sockets?.() ?? [own, ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

export type HillAnswer = { readonly ok: true; readonly body: JsonObject; readonly path: string } | { readonly ok: false; readonly error: string; readonly code: string | null; readonly exit: number };

/** Whether a refusal says the bridge does not know this op: today's words for it, or the bare word of a bridge before 2026-10-30. */
export function unknownToBridge(error: string, op: string): boolean {
  return error === BARE_BAD_REQUEST || error === unknownOp(op);
}

/**
 * Ask the bridges in turn until one answers. `not here` leads to the next bridge, and so does an answer
 * that does not know the op (an older bridge); a `missing` sentence is kept and printed only when no
 * bridge held the decision. With `all`, every bridge is asked and the ok answers are all returned.
 */
export async function walk(deps: HillDeps, body: JsonObject, all = false, ms?: number): Promise<{ readonly answers: Extract<HillAnswer, { ok: true }>[]; readonly failure: Extract<HillAnswer, { ok: false }> }> {
  const op = asJsonString(body.op) ?? "";
  const line = `${JSON.stringify({ v: 1, markers: readEnvMarkers(deps.ctx.env), ...body })}\n`;
  const answers: Extract<HillAnswer, { ok: true }>[] = [];
  let knows = false;
  let notHere = false;
  let missing: string | null = null;
  for (const path of socketPaths(deps)) {
    const { raw, late } = await deps.ask(path, line, ms).then(
      (text) => ({ raw: text, late: false }),
      (err) => ({ raw: null, late: err instanceof AskLate }),
    );
    // A bridge took the request and did not answer in time: it may still be posting. Asking the next
    // bridge could post twice, and "no Collie answers" would be untrue, so the walk ends here.
    if (late) return { answers, failure: { ok: false, error: HILL_NOT_CONFIRMED, code: null, exit: EXIT.UNREACHABLE } };
    const answer = raw === null ? undefined : parseJsonObject(raw);
    if (answer === undefined) continue;
    if (answer.ok === true) {
      answers.push({ ok: true, body: answer, path });
      if (!all) break;
      continue;
    }
    const error = asJsonString(answer.error) ?? "failed";
    if (answer.hill === true) knows = true;
    if (error === "not here") {
      notHere = true;
      missing = asJsonString(answer.missing) ?? missing;
      continue;
    }
    if (unknownToBridge(error, op)) continue;
    if (answer.hill !== true) continue;
    const code = asJsonString(answer.code) ?? null;
    return { answers, failure: { ok: false, error, code, exit: refusalExit(code) } };
  }
  if (missing !== null) return { answers, failure: { ok: false, error: missing, code: null, exit: EXIT.STATE } };
  if (knows && notHere) return { answers, failure: { ok: false, error: HILL_NOT_HERE, code: null, exit: EXIT.STATE } };
  return { answers, failure: { ok: false, error: HILL_UNKNOWN, code: null, exit: EXIT.UNREACHABLE } };
}

/**
 * The exit code of a bridge's refusal. A post the bridge refused for its content is `REFUSED` (4); a
 * refusal with no code, and the Hill switched off on this Collie, are a state of the machine, `STATE`
 * (3): a retry of the same post can pass once the person switches the Hill on. A crew member whose lead
 * did not answer the forwarded post is `UNREACHABLE` (5): the same post with the same `--request-id`
 * may go again, and the lead keeps one decision for it (CREW_PROTOCOL §22).
 */
export function refusalExit(code: string | null): number {
  if (code === "lead_unreachable") return EXIT.UNREACHABLE;
  return code === null || code === "hill_off" ? EXIT.STATE : EXIT.REFUSED;
}

export async function request(deps: HillDeps, body: JsonObject, ms?: number): Promise<HillAnswer> {
  const { answers, failure } = await walk(deps, body, false, ms);
  return answers[0] ?? failure;
}

export function failed(deps: HillDeps, answer: Extract<HillAnswer, { ok: false }>): number {
  deps.io.err(`asks: ${shown(answer.error)}${answer.code === null ? "" : ` (${shown(answer.code)})`}`);
  return answer.error.startsWith(BARE_BAD_REQUEST) ? EXIT.USAGE : answer.exit;
}

function usage(deps: HillDeps, verb: (typeof ASKS_SUBCOMMANDS)[number], why: string): number {
  deps.io.err(`error: ${why}`);
  for (const line of USAGE[verb]) deps.io.err(line);
  return EXIT.USAGE;
}

export function windows(deps: HillDeps): boolean {
  if (deps.platform !== "win32") return false;
  deps.io.err(NO_SOCKET_TEXT);
  return true;
}

/** One `--image` value: `<path>` or `<path>=<caption>`, split at the first `=`. An error is the one-line reason. */
export function parseImageArg(raw: string): HillImageInput | { readonly error: string } {
  const at = raw.indexOf("=");
  const path = at < 0 ? raw : raw.slice(0, at);
  if (path.trim() === "") return { error: `\`--image\` takes <path> or <path>="<caption>", got \`${raw}\`` };
  if (at < 0) return { path };
  const caption = raw.slice(at + 1).trim();
  if (caption === "") return { error: `\`--image ${raw}\` has an empty caption; leave out the = for none` };
  if ([...caption].length > HILL_MEDIA_CAPTION_MAX) return { error: `an image caption is at most ${String(HILL_MEDIA_CAPTION_MAX)} characters` };
  return { path, caption };
}

/**
 * The path the bridge is sent for an `--image`: absolute, with every folder on the way resolved to
 * its real path, so the bridge's own "no symlink in the path" rule holds for a home reached through a
 * link (`/home` on some systems). The file's own name is kept as given, never followed: a symlink
 * named as the image is still a symlink, and the bridge refuses it with the reason.
 */
export function imagePathOf(raw: string, cwd: string, realpath: (path: string) => string = (path) => realpathSync(path)): { readonly path: string } | { readonly error: string } {
  const absolute = resolve(cwd, raw);
  try {
    return { path: join(realpath(dirname(absolute)), basename(absolute)) };
  } catch {
    return { error: `\`--image ${raw}\`: no such folder` };
  }
}

/** The body: the words after `--`, else stdin when it is not a terminal, else none. */
export async function bodyOf(deps: HillDeps, body: string | null): Promise<string> {
  if (body !== null) return body;
  if (deps.stdinIsTty) return "";
  return (await deps.readStdin()).trim();
}

/** Where the answer goes, as the card's "goes to" line names it: the session's name, and its machine. */
function targetWords(target: NonNullable<HillDecision["target"]>): string {
  return target.host === null ? shown(target.label) : `${shown(target.label)} on ${shown(target.host)}`;
}

/**
 * An ask's state as `walky status` prints it: the state, the question, where the answer goes, why it
 * closed, and the answer with its delivery when there is one. A session that missed the typed answer,
 * or got one with no title (it went to a session other than the poster's), reads it here.
 */
export function statusLines(decision: HillDecision): string[] {
  const lines = [`${decision.id} ${decision.state}`, `title: ${shown(decision.title)}`];
  if (decision.target !== null) lines.push(`goes to: ${targetWords(decision.target)}`);
  if (decision.closedReason !== null) lines.push(`reason: ${shown(decision.closedReason)}`);
  if (decision.supersededBy !== null) lines.push(`replaced by: ${decision.supersededBy}`);
  const answer = decision.answer;
  if (answer === null) return lines;
  const picked = answer.intent === "answer" || answer.intent === "dismiss" ? answer.intent : `${answer.intent}${answer.label === null ? "" : ` (${shown(answer.label)})`}`;
  lines.push(`answer: ${picked}`);
  if (answer.text !== null) for (const line of answer.text.split("\n")) lines.push(`  ${shown(line)}`);
  lines.push(`by: ${shown(answer.by)}`, `delivery: ${answer.delivery}`);
  return lines;
}

export function decisionsOf(value: JsonValue | undefined): HillDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const decision = readDecision(asJsonObject(entry));
    return decision === null ? [] : [decision];
  });
}

/** What `collie asks clear` prints for a count. */
export function clearedWords(count: number): string {
  if (count === 0) return "Nothing to clear: no closed asks.";
  return `Cleared ${String(count)} closed ${count === 1 ? "ask" : "asks"}.`;
}

/**
 * `asks clear`: remove every closed ask from Asks, through the running bridge's socket. It names
 * no pane and no id, and never removes an open ask. Prints one line with the count.
 */
export async function cmdHillClear(deps: HillDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const unknown = args.find((arg) => arg !== "--json" && arg !== "--spoken");
  if (unknown !== undefined) return usage(deps, "clear", `unknown argument \`${unknown}\``);
  const spoken = args.includes("--spoken");
  // The second Clear is the person's choice: refused in an agent's pane, here and again by the bridge.
  if (spoken && (await inAgentPane(deps))) {
    for (const line of personOnlyRefusal("collie asks clear --spoken")) deps.io.err(line);
    return EXIT.REFUSED;
  }
  const answer = await request(deps, { op: spoken ? "hill.spoken.clear" : "hill.clear" });
  if (!answer.ok) return failed(deps, answer);
  const count = asJsonNumber(answer.body.cleared);
  if (count === undefined) return failed(deps, { ok: false, error: "the bridge answered without a count", code: null, exit: EXIT.FAIL });
  deps.io.out(args.includes("--json") ? JSON.stringify({ cleared: count }) : spoken ? spokenClearedWords(count) : clearedWords(count));
  return EXIT.OK;
}

/** What `collie asks clear --spoken` prints for a count. */
export function spokenClearedWords(count: number): string {
  if (count === 0) return "Nothing to clear: no open card you answered in its session.";
  return `Withdrew and cleared ${String(count)} ${count === 1 ? "card" : "cards"} you answered in the session. Nothing was typed.`;
}

// ── The crew state (1.29.0) ──────────────────────────────────────────────────────────────────────────

/** What each crew state means, one line, the words the phone shows under its control. */
export const CREW_STATE_MEANING = {
  here: "Agents ask as usual.",
  quiet: "Agents ask, but do not wait for your answer.",
  away: "Agents keep back questions that need an answer now.",
} as const satisfies Record<HillCrewState, string>;

/**
 * The line a person's verb refuses with inside an agent's pane: the crew state and the Clear of the
 * cards answered in the session are the person's choice. A SPEED BUMP, NOT A WALL, as `collie trick on`'s
 * (cli/trick.ts `agentPaneRefusal`): the bridge is asked whether this pane runs an agent, and only a yes refuses.
 */
export function personOnlyRefusal(command: string, where = "in Asks"): string[] {
  return [
    `error: ${command} is your person's choice, and this runs in a pane where an agent works.`,
    `Tell your operator what you would change and why. They do it on the phone, ${where}, or with this command in a shell pane or a terminal.`,
  ];
}

/**
 * Whether a person-only verb refuses in this pane. Outside a pane it does not. In a pane it refuses unless the
 * bridge proves the pane a shell: an `unknown` answer or a failed check refuses too (`paneNotProvenShell`).
 */
async function inAgentPane(deps: Pick<HillDeps, "ctx" | "paneKind">): Promise<boolean> {
  return await paneNotProvenShell(deps.ctx.env, deps.paneKind);
}

/** The second line of `collie asks state`: since when, and who set it. */
export function crewStateSince(view: HillCrewStateView): string {
  if (view.at === null) return "since always: nobody set it, so it is the default";
  const when = `${new Date(view.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return view.by === null ? `since ${when}` : `since ${when}, set by ${shown(view.by)}`;
}

/** The crew state of this machine's file, for when no bridge answers. */
function localCrewState(deps: HillDeps): HillCrewStateView {
  return readHillCrewState(deps.ctx.stateDir).view;
}

/**
 * Why `collie asks state` says `unknown` on a crew member no running bridge answers for (C-N3, review 8):
 * the state is the lead's, and this machine's own file is not it. An agent reads this before each post.
 */
export const HILL_STATE_UNKNOWN_ON_MEMBER = "no running Collie here could ask the crew's lead, and the crew state lives there; start Collie, or look on the phone";

/** Whether this machine is a crew member by its trust store on disk (cli/serve.ts `crewModeOnDisk`). */
function memberOnDisk(deps: HillDeps): boolean {
  const raw = deps.files.read(trustStorePath(deps.ctx.stateDir));
  return deriveMode(enrollmentOf(raw === null ? null : parseTrustStore(raw))).mode === "peer";
}

/**
 * `asks state [here|quiet|away] [--json]`: with no word, the crew state, read from the running bridge (on
 * a crew member, from its lead), else this machine's file: one word, then a line with since when. A lead
 * too old to say is a plain line and exit 4; so is a crew member no running bridge answers for, which
 * prints `unknown` (its own file is not the lead's). With a word, the person sets it: refused inside an agent's
 * pane (exit 4, as `collie trick on`), refused on a crew member (the state is the lead's), written by the
 * running bridge, which audits it, or into the file when no bridge answers.
 */
export async function cmdHillState(deps: HillDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const word = words[0];
  if (words.length > 1 || (word !== undefined && !isHillCrewState(word))) return usage(deps, "state", word === undefined ? `unexpected \`${words[1] ?? ""}\`` : `\`${words.join(" ")}\` is not a crew state: here, quiet or away`);
  const print = (view: HillCrewStateView): void => {
    if (json) deps.io.out(JSON.stringify({ crewState: view }));
    else {
      deps.io.out(view.state);
      deps.io.out(crewStateSince(view));
    }
  };
  const socket = deps.platform !== "win32";
  // The file fallback for a read: on a member it is not the lead's state, so the answer is `unknown`.
  const fallback = (): number => {
    if (!memberOnDisk(deps)) {
      print(localCrewState(deps));
      return EXIT.OK;
    }
    deps.io.out(json ? JSON.stringify({ crewState: null }) : "unknown");
    if (!json) deps.io.err(`asks: ${HILL_STATE_UNKNOWN_ON_MEMBER}`);
    return EXIT.REFUSED;
  };
  if (word === undefined) {
    if (!socket) return fallback();
    const answer = await request(deps, { op: "hill.state" });
    if (answer.ok) {
      const view = readCrewStateView(answer.body.crewState);
      if (view === null) return failed(deps, { ok: false, error: "the bridge answered without a crew state", code: null, exit: EXIT.FAIL });
      print(view);
      return EXIT.OK;
    }
    // No running Collie here knows the crew state: this machine's own file is the answer, on a lead.
    if (answer.error === HILL_UNKNOWN) return fallback();
    return failed(deps, answer);
  }
  if (await inAgentPane(deps)) {
    for (const line of personOnlyRefusal(`collie asks state ${word}`)) deps.io.err(line);
    return EXIT.REFUSED;
  }
  const said = (view: HillCrewStateView): number => {
    if (json) deps.io.out(JSON.stringify({ crewState: view }));
    else {
      deps.io.out(`${crewStateLine(view.state)} ${CREW_STATE_MEANING[view.state]}`);
      if (view.state !== "here") deps.io.out("To tell the sessions that wait for an answer now, tap Tell all sessions now in Asks.");
    }
    return EXIT.OK;
  };
  if (socket) {
    const answer = await request(deps, { op: "hill.state", state: word });
    if (answer.ok) {
      const view = readCrewStateView(answer.body.crewState);
      if (view === null) return failed(deps, { ok: false, error: "the bridge answered without a crew state", code: null, exit: EXIT.FAIL });
      return said(view);
    }
    if (answer.error !== HILL_UNKNOWN) return failed(deps, answer);
  }
  // No running Collie here knows the crew state: write this machine's file, as `collie asks on|off` does.
  // Not on a member: the state is the lead's, and a file here would only mislead its next read.
  if (memberOnDisk(deps)) return failed(deps, { ok: false, error: HILL_STATE_ON_LEAD, code: "not_on_lead", exit: EXIT.REFUSED });
  try {
    writeHillCrewState(deps.ctx.stateDir, { state: word, by: "terminal" }, (deps.now ?? Date.now)());
  } catch (err) {
    deps.io.err(`asks: could not write ${hillCrewStatePath(deps.ctx.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  if (!json) deps.io.err(`asks: no running Collie answered; written to ${hillCrewStatePath(deps.ctx.stateDir)}, which the bridge reads when it runs`);
  return said(localCrewState(deps));
}

/** What `collie asks off` says once the switch is written. */
export const HILL_OFF_WORDS = "Asks is off on this Collie. Agents and tricks cannot ask you, and Asks leaves the phone's bar. The open asks stay and show again when you switch it on: collie asks on";
/** What `collie asks on` says once the switch is written. */
export const HILL_ON_WORDS = "Asks is on. Agents and tricks can ask you again, and the open asks are back on the phone.";

/**
 * `asks on|off`: the switch of Asks for this Collie (bridge/hill/switch.ts). Written straight into this
 * instance's state folder, as `collie trick on|off` writes the tricks' switch; the running bridge reads
 * it again within seconds, with no restart. Works with no bridge running. A real change lets the
 * WalkyTalky skill follow (`followSkill`, cli/skill-install.ts `skillFollowsSwitch`); a fault of that is
 * one line on stderr and does not change the exit.
 */
export function cmdHillSwitch(
  deps: Pick<HillDeps, "ctx" | "io" | "now"> & { readonly followSkill: SwitchFollower | null },
  verb: "on" | "off",
  args: readonly string[],
): number {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    deps.io.err(`error: unknown argument \`${unknown}\``);
    for (const line of USAGE[verb]) deps.io.err(line);
    return EXIT.USAGE;
  }
  const on = verb === "on";
  const json = args.includes("--json");
  const held = readHillSwitch(deps.ctx.stateDir);
  if (held.on === on && held.problem === null) {
    if (json) deps.io.out(JSON.stringify({ on }));
    else deps.io.out(on ? "Asks is already on." : "Asks is already off.");
    return EXIT.OK;
  }
  try {
    setHillSwitch(deps.ctx.stateDir, on, { now: (deps.now ?? Date.now)(), follow: deps.followSkill, warn: (line) => deps.io.err(`asks: ${line}`) });
  } catch (err) {
    deps.io.err(`asks: could not write the switch in ${deps.ctx.stateDir}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  if (json) deps.io.out(JSON.stringify({ on }));
  else deps.io.out(on ? HILL_ON_WORDS : HILL_OFF_WORDS);
  return EXIT.OK;
}

/**
 * `asks on` from the CLI: switching Asks on is the person's choice, so it is refused in an agent's pane
 * (the speed bump of {@link personOnlyRefusal}); anywhere else it is {@link cmdHillSwitch}. `off` needs no check.
 */
export async function cmdHillOn(deps: Pick<HillDeps, "ctx" | "io" | "now" | "paneKind"> & { readonly followSkill: SwitchFollower | null }, args: readonly string[]): Promise<number> {
  if (await inAgentPane(deps)) {
    for (const line of personOnlyRefusal("collie asks on", "in Settings, Tricks")) deps.io.err(line);
    return EXIT.REFUSED;
  }
  return cmdHillSwitch(deps, "on", args);
}

/** A bare, misspelt or `--help` `collie asks`: the sub-verbs. `--help` exits 0, the others 2. */
export function cmdAsks(deps: Pick<HillDeps, "io">, args: readonly string[]): number {
  const help = args[0] === "--help" || args[0] === "-h";
  if (!help && args[0] !== undefined) deps.io.err(`error: unknown asks command \`${args[0]}\``);
  const print = help ? deps.io.out : deps.io.err;
  for (const line of asksHelp()) print(line);
  return help ? EXIT.OK : EXIT.USAGE;
}

/** The line an old `collie hill` verb fails with: the verb that took its place (ADR 0179). No alias runs. */
export function oldHillLine(verb: string | undefined): string {
  const known = Object.entries(OLD_HILL_VERBS).find(([old]) => old === verb);
  if (known !== undefined) return `collie hill ${known[0]} is now: ${known[1]}`;
  return "collie hill is now: collie asks (your verbs) and collie walky ask (an agent's)";
}

/** `collie hill ...`, any sub-verb, `--help` too: gone. One line on stderr, the usage exit. Nothing runs. */
export function cmdOldHill(deps: Pick<HillDeps, "io">, args: readonly string[]): number {
  deps.io.err(oldHillLine(args[0]));
  return EXIT.USAGE;
}

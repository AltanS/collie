import { join } from "node:path";

import { HERDR_MUX } from "../bridge/mux/herdr/adapter.ts";
import { buildMuxRegistry, muxEndpointVar, muxNames } from "../bridge/mux/registry.ts";
import { TMUX_MUX } from "../bridge/mux/tmux/adapter.ts";
import { resolveTmuxBinary, tmuxServerArgs, tmuxServerLabel } from "../bridge/mux/tmux/exec.ts";
import { ZELLIJ_MUX } from "../bridge/mux/zellij/adapter.ts";
import { resolveZellijBinary, zellijBinaryCandidates } from "../bridge/mux/zellij/exec.ts";
import { chooseSession, parseSessionList, ZELLIJ_LIST_SESSIONS_ARGS } from "../bridge/mux/zellij/protocol.ts";
import { upsertEnvVars, type CliContext, type EnvVars } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";

// WHICH MULTIPLEXER THIS COLLIE DRIVES, WHEN NOBODY HAS SAID YET (M14/03).
//
// `COLLIE_MUX` used to be allowed to be absent: `DEFAULT_MUX` answered "herdr" and the bridge came
// up mirroring a socket the operator may never have had. That default was correct while Herdr was
// the only adapter and is a silent wrong answer now that there are three — a tmux user's first
// `collie start` produced an empty home screen and no line naming the reason.
//
// So the decision is made ONCE, out loud, at `collie start`, and it is written down. What follows is
// the whole of it:
//
//  • **The probe is a READ, exactly as `collie doctor`'s is.** `tmux list-sessions` and
//    `zellij list-sessions` are the cheapest question each one answers, and neither starts a server,
//    attaches a client or creates a session. Herdr is the socket file's existence — the same probe
//    `doctor`'s `herdr-socket` check makes, for the reason it gives there (dialling would need a
//    `Bun.connect` seam this suite cannot exercise). NOTHING HERE MAY SPAWN A MULTIPLEXER: a server
//    this verb started would be evidence it manufactured.
//  • **Every name and every argv comes from `bridge/mux/`.** The binary resolution, the server flags,
//    the session listing and its parser are imported, never restated, so a fourth multiplexer cannot
//    leave this file quietly probing a stale set. What is written out per mux is exactly what cannot
//    be shared: each one has its own CLI.
//  • **An explicit `COLLIE_MUX` wins outright and the probe never runs.** Not "probes and discards" —
//    an operator who has chosen is not asked, and pays for nothing.
//  • **The choice is PERSISTED, on both branches.** A supervised bridge reads its environment from
//    the config-dir `.env` (`EnvironmentFile=` in the generated unit), so a selection this process
//    only held in memory would not reach the process it selected for. Auto-selected and picked both
//    land in the same file the install flow writes.

/** Where this module reaches the world. Satisfied structurally by `LifecycleDeps` and `DoctorDeps`. */
export interface MuxProbeDeps {
  readonly ctx: Pick<CliContext, "env" | "home" | "socket" | "configDir">;
  readonly exec: Exec;
  readonly files: Files;
}

/**
 * One multiplexer the probe found running, in that adapter's own words.
 *
 * `endpoint` is what {@link muxEndpointVar} would carry for it, and `""` means the adapter's own
 * default target is the answer — Herdr's endpoint is never written here at all, because it IS
 * `HERDR_SOCKET_PATH` (`bridge/config.ts`).
 */
export interface MuxSighting {
  readonly mux: string;
  readonly endpoint: string;
  /** What was seen, phrased for an operator to read: "a tmux server on socket /run/x — 2 sessions". */
  readonly evidence: string;
}

/** The trimmed `COLLIE_MUX`, or `null` when nobody has chosen. The one reading of "explicit". */
export function explicitMux(env: Pick<CliContext, "env">["env"]): string | null {
  const named = (env.COLLIE_MUX ?? "").trim();
  return named === "" ? null : named;
}

/**
 * Every multiplexer that is running on this box right now, in registry order.
 *
 * Read-only and total: an adapter that is not installed, whose binary cannot be run, or that has
 * nothing running is simply absent from the list — none of those is an error, because the question
 * being asked is "what is here", not "is this one healthy".
 */
export function probeMuxes(deps: MuxProbeDeps): MuxSighting[] {
  return [probeHerdr(deps), probeTmux(deps), probeZellij(deps)].filter(
    (sighting): sighting is MuxSighting => sighting !== null,
  );
}

function probeHerdr(deps: MuxProbeDeps): MuxSighting | null {
  const socket = deps.ctx.socket;
  if (!deps.files.exists(socket)) return null;
  return { mux: HERDR_MUX, endpoint: "", evidence: `a Herdr socket at ${socket}` };
}

function probeTmux(deps: MuxProbeDeps): MuxSighting | null {
  const binary = resolveTmuxBinary((deps.ctx.env.COLLIE_TMUX_BIN ?? "").trim(), (p) => deps.files.exists(p));
  if (binary === null) return null;
  const endpoint = (deps.ctx.env[muxEndpointVar(TMUX_MUX)] ?? "").trim();
  // `list-sessions` against a server that is not there exits non-zero and says so; it never starts
  // one. That refusal is the whole "no tmux here" answer.
  const asked = deps.exec.capture(binary, [...tmuxServerArgs(endpoint), "list-sessions", "-F", "#{session_name}"]);
  if (!asked.found || asked.code !== 0) return null;
  const sessions = asked.stdout.split("\n").filter((line) => line.trim() !== "").length;
  return {
    mux: TMUX_MUX,
    endpoint,
    evidence: `a tmux server on ${tmuxServerLabel(endpoint)} — ${String(sessions)} session${sessions === 1 ? "" : "s"}`,
  };
}

function probeZellij(deps: MuxProbeDeps): MuxSighting | null {
  const configured = (deps.ctx.env.COLLIE_ZELLIJ_BIN ?? "").trim();
  const binary = resolveZellijBinary(
    configured,
    (p) => deps.files.exists(p),
    zellijBinaryCandidates(deps.ctx.home),
  );
  if (binary === null) return null;
  const asked = deps.exec.capture(binary, [...ZELLIJ_LIST_SESSIONS_ARGS]);
  if (!asked.found) return null;
  // A box with no sessions exits non-zero and explains itself on stderr; that is not a listing.
  const sessions = parseSessionList(asked.code === 0 ? asked.stdout : "");
  const running = sessions.filter((session) => session.running);
  if (running.length === 0) return null;
  // The endpoint is decided by the ADAPTER's own chooser, so what gets written into `.env` here is
  // the session the bridge would have bound to anyway. Ambiguity leaves it empty rather than picking
  // one — `chooseSession` refuses that case at boot, in a sentence naming the sessions.
  const choice = chooseSession(sessions, (deps.ctx.env[muxEndpointVar(ZELLIJ_MUX)] ?? "").trim());
  return {
    mux: ZELLIJ_MUX,
    endpoint: choice.ok ? choice.session : "",
    evidence: `${String(running.length)} running zellij session${running.length === 1 ? "" : "s"}: ${running
      .map((session) => session.name)
      .join(", ")}`,
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

/** What the first-run flow settled on, and how. `refused` is the only one that stops `start`. */
export type MuxDecision =
  | { readonly kind: "explicit"; readonly mux: string }
  | { readonly kind: "auto"; readonly sighting: MuxSighting }
  | { readonly kind: "picked"; readonly sighting: MuxSighting }
  | {
      readonly kind: "refused";
      readonly detail: string;
      readonly remedy: string;
      /** The refusal as an operator reads it: headline, then one indented line each. */
      readonly lines: readonly string[];
    };

export interface MuxChoiceDeps extends MuxProbeDeps {
  readonly io: Io;
  /**
   * Whether there is a terminal to ask at all.
   *
   * Asked BEFORE the question is printed, exactly as `stt setup` asks it and for the same reason: an
   * unattended run must not have a question nobody can answer scrolling past in its log. Absent
   * reads as "nobody is there", which is the safe half — it refuses instead of guessing.
   */
  readonly interactive?: boolean;
  /** The free-text ask, behind a seam. `null` is "nobody answered". */
  prompt?(question: string): string | null | Promise<string | null>;
}

/** How many typos the picker forgives before it gives up. Bounded, so no run can hang on a pipe. */
const PICKER_ATTEMPTS = 3;

/**
 * Which multiplexer this collie drives — asked, or deduced, or refused.
 *
 * The three branches are the whole policy. An explicit `COLLIE_MUX` returns before the probe runs.
 * With a terminal, everything found is presented with its evidence and the operator picks. Without
 * one, EXACTLY ONE sighting is auto-selected and said out loud; zero or several refuse, because
 * "the only multiplexer running" is a fact and "probably that one" is a guess — and a guess here
 * puts a bridge in front of somebody else's terminals.
 */
export async function chooseMux(deps: MuxChoiceDeps): Promise<MuxDecision> {
  const explicit = explicitMux(deps.ctx.env);
  if (explicit !== null) return { kind: "explicit", mux: explicit };

  const found = probeMuxes(deps);
  if (deps.interactive === true && found.length > 0) {
    const picked = await pick(deps, found);
    return picked === null ? refusal(deps, found) : { kind: "picked", sighting: picked };
  }
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) return refusal(deps, found);
  return { kind: "auto", sighting: only };
}

/**
 * The variable that already names a multiplexer, per multiplexer.
 *
 * An operator who set one of these has told this install where that multiplexer lives. That is not
 * consent to drive it — `COLLIE_MUX` is the only sentence that says which one — but it IS the
 * strongest thing on the box about which of several was meant, so the refusal says it out loud.
 * Herdr's is not `muxEndpointVar(HERDR_MUX)`: its endpoint IS `HERDR_SOCKET_PATH` (`bridge/config.ts`).
 */
function namingVar(mux: string): string {
  return mux === HERDR_MUX ? "HERDR_SOCKET_PATH" : muxEndpointVar(mux);
}

/**
 * The one multiplexer this environment already names, or `null`.
 *
 * Only the FOUND ones are candidates: a `COLLIE_MUX_ENDPOINT_TMUX` left over from a box that no
 * longer runs tmux points at nothing. Two names is no name at all — a hint that has to be chosen
 * between is the same standoff one level down, so that case says nothing rather than picking.
 */
function hintedMux(found: readonly MuxSighting[], env: CliContext["env"]): MuxSighting | null {
  const named = found.filter((sighting) => (env[namingVar(sighting.mux)] ?? "").trim() !== "");
  return named.length === 1 ? (named[0] ?? null) : null;
}

/** What an operator has to type to end the standoff, ready to paste. */
function fixCommand(mux: string, configDir: string): string {
  return `printf 'COLLIE_MUX=${mux}\\n' >> ${join(configDir, ".env")} && collie start`;
}

/**
 * The standoff, in the two shapes it is read in.
 *
 * `detail` and `remedy` are the one-line pair a `collie doctor` finding carries. `lines` is the same
 * answer as a block for `start` and `restart` to print: the headline first, then one line per
 * multiplexer, then the hint if there is one, then the command. Both shapes are built here, so a
 * change to either cannot leave the other saying something else.
 */
export interface MuxRefusal {
  readonly detail: string;
  readonly remedy: string;
  readonly lines: readonly string[];
}

/**
 * Why an unset `COLLIE_MUX` cannot be resolved, what was found, and the line that resolves it.
 *
 * Exported because `collie doctor` reports the same standoff a `start` would refuse on, and two
 * wordings of it would be two answers to the operator's one question.
 */
export function refusedMux(
  found: readonly MuxSighting[],
  configDir: string,
  env: CliContext["env"] = {},
): MuxRefusal {
  const placeholder = `<${muxNames(buildMuxRegistry()).join("|")}>`;
  const hint = hintedMux(found, env);
  const command = fixCommand(hint?.mux ?? placeholder, configDir);
  if (found.length === 0) {
    const detail = "no COLLIE_MUX is set, and no multiplexers are running. Collie has nothing to mirror";
    return {
      detail,
      remedy: command,
      lines: [`${detail}.`, "", "Start a multiplexer or set the variable, then run the command again:", `  ${command}`],
    };
  }
  const headline =
    `no COLLIE_MUX is set, and ${String(found.length)} multiplexer${found.length === 1 ? " is" : "s are"} ` +
    "running. Collie will not guess which one to use.";
  const rows = found.map((sighting) => `  ${sighting.mux.padEnd(8)} ${sighting.evidence}`);
  const named = hint === null ? null : `${namingVar(hint.mux)} is already set, so ${hint.mux} is probably the one`;
  // Blank lines between the blocks: what was found, the hint, the fix. `ensureMuxChosen` prints an
  // empty entry as an empty line, not as seven spaces.
  return {
    detail: `${headline} Found: ${found.map((s) => `${s.mux} (${s.evidence})`).join("; ")}`,
    remedy: named === null ? command : `${named}: ${command}`,
    lines: [
      headline,
      "",
      ...rows,
      "",
      ...(hint === null ? [] : [`This instance already sets ${namingVar(hint.mux)}. You probably want ${hint.mux}.`, ""]),
      "Add this line to your config file, then run the command again:",
      `  ${command}`,
    ],
  };
}

function refusal(deps: MuxChoiceDeps, found: readonly MuxSighting[]): MuxDecision {
  return { kind: "refused", ...refusedMux(found, deps.ctx.configDir, deps.ctx.env) };
}

/** The interactive half: print what was found, take a number or a name, or `null` for no answer. */
async function pick(deps: MuxChoiceDeps, found: readonly MuxSighting[]): Promise<MuxSighting | null> {
  const ask = deps.prompt;
  if (ask === undefined) return null;
  deps.io.out("Collie has no COLLIE_MUX yet. These multiplexers are running here:");
  deps.io.out("");
  for (const [index, sighting] of found.entries()) {
    deps.io.out(`  ${String(index + 1)}) ${sighting.mux.padEnd(7)} ${sighting.evidence}`);
  }
  deps.io.out("");
  for (let attempt = 1; attempt <= PICKER_ATTEMPTS; attempt++) {
    const answer = await ask(`which one should Collie drive? [1-${String(found.length)}] `);
    // `null` is the seam saying nobody is there — not the same as an answer that made no sense, and
    // it must not be retried against a closed stdin.
    if (answer === null || answer === undefined) return null;
    const chosen = matchAnswer(found, answer.trim());
    if (chosen !== undefined) return chosen;
    if (attempt < PICKER_ATTEMPTS) deps.io.err(`"${answer.trim()}" is not one of them.`);
  }
  return null;
}

/** A row number, or the multiplexer's own name. Both are on the screen; neither is a prefix match. */
function matchAnswer(found: readonly MuxSighting[], answer: string): MuxSighting | undefined {
  if (/^\d+$/.test(answer)) return found[Number(answer) - 1];
  return found.find((sighting) => sighting.mux === answer.toLowerCase());
}

// ── Landing it ───────────────────────────────────────────────────────────────

/**
 * The variables a sighting settles: `COLLIE_MUX`, plus that adapter's endpoint var when the adapter
 * needs one. An empty endpoint is left UNWRITTEN rather than written empty — for tmux it already
 * means "your own default server", and a key present with no value is a key an operator has to
 * reason about.
 */
export function muxVars(sighting: MuxSighting): EnvVars {
  const vars: EnvVars = { COLLIE_MUX: sighting.mux };
  if (sighting.endpoint !== "") vars[muxEndpointVar(sighting.mux)] = sighting.endpoint;
  return vars;
}

export interface MuxSettleDeps extends MuxChoiceDeps {
  readonly ctx: CliContext;
}

/**
 * `collie start`'s first-run gate: decide the multiplexer, write it down, and put it in the
 * environment this run will hand the bridge.
 *
 * Both halves of the write matter. The `.env` is what a SUPERVISED bridge reads (the generated unit
 * carries `EnvironmentFile=`), and `ctx.env` is what the unsupervised one is spawned with — a
 * selection that landed in only one of the two would be a `start` that announced a choice the bridge
 * never made. `EXIT.FAIL` is returned only for the refusal, which is the one case where continuing
 * would mean starting a bridge with no multiplexer behind it.
 */
export async function ensureMuxChosen(deps: MuxSettleDeps): Promise<number> {
  const decision = await chooseMux(deps);
  if (decision.kind === "explicit") return EXIT.OK;
  if (decision.kind === "refused") {
    for (const [index, line] of decision.lines.entries()) {
      deps.io.err(index === 0 ? `error: ${line}` : line === "" ? "" : `       ${line}`);
    }
    return EXIT.FAIL;
  }
  const { sighting } = decision;
  const vars = muxVars(sighting);
  const envPath = join(deps.ctx.configDir, ".env");
  deps.files.write(envPath, upsertEnvVars(deps.files.read(envPath) ?? "", vars), 0o600);
  Object.assign(deps.ctx.env, vars);
  const how = decision.kind === "auto" ? "auto-selected" : "chose";
  deps.io.out(`${how} ${sighting.mux} — ${sighting.evidence}; wrote COLLIE_MUX=${sighting.mux} to ${envPath}`);
  // The one thing a written `COLLIE_MUX` cannot settle: which of several zellij sessions. The bridge
  // refuses that at boot in a sentence naming them, so say it here, where the operator is standing.
  if (sighting.mux === ZELLIJ_MUX && sighting.endpoint === "") {
    deps.io.err(
      `note: more than one zellij session is running — name the one to drive in ` +
        `${muxEndpointVar(ZELLIJ_MUX)} in ${envPath}, then \`collie restart\`.`,
    );
  }
  return EXIT.OK;
}

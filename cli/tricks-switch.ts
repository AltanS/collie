import { readTricksFeature, tricksFeaturePath, writeTricksFeature } from "../bridge/tricks/feature-switch.ts";
import { TRICKS_OFF_LINE, TRICKS_WINDOWS_LINE, tricksGated } from "../web/src/lib/tricks/schema.ts";
import type { CliContext } from "./context.ts";
import { personOnlyRefusal } from "./hill.ts";
import { paneNotProvenShell, type PaneKind } from "./walky.ts";
import { EXIT, type Io } from "./io.ts";

// `collie tricks on|off|status`: the switch for tricks as a whole on this machine (bridge/tricks/
// feature-switch.ts). The plural is the feature; `collie trick on <id>` stays the one trick. Written straight
// into this instance's state folder, as `collie hill on|off` writes the Hill's; the running bridge reads it
// again within a second, with no restart. Works with no bridge running. It never changes a trick's own switch.

export interface TricksSwitchDeps {
  readonly ctx: Pick<CliContext, "stateDir">;
  readonly io: Io;
  readonly now?: () => number;
  /** This machine's platform, for the Windows gate. Absent: no gate. */
  readonly platform?: NodeJS.Platform;
}

/** The sub-verbs of `collie tricks`, in the order the CLI and the reference list them. */
export const TRICKS_SUBCOMMANDS = ["on", "off", "status"] as const;

/** What `collie tricks on` says once tricks are on. */
export const TRICKS_ON_WORDS = "Tricks are on on this machine. Each trick runs again only if its own switch is on: collie trick list";
/** What `collie tricks off` says once tricks are off. */
export const TRICKS_OFF_WORDS = "Tricks are off on this machine. No trick runs or draws, and each trick keeps its own switch for when you switch them on: collie tricks on";

/** The sub-verbs and their one line each, for a bare or misspelt `collie tricks`. */
export const TRICKS_HELP = [
  "usage: collie tricks <on|off|status> [--json]",
  "  on      switch tricks on for this machine (they are off until switched on)",
  "  off     switch tricks off: no trick runs or draws; each trick keeps its own switch",
  "  status  whether tricks are on, and whether the switch was ever written",
  "Tricks are an experiment: they may change, lose settings, or be withdrawn in a patch release.",
  "One trick: collie trick on <id> and collie trick off <id>.",
] as const;

function unknownArgument(deps: Pick<TricksSwitchDeps, "io">, args: readonly string[]): boolean {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown === undefined) return false;
  deps.io.err(`error: unknown argument \`${unknown}\``);
  for (const line of TRICKS_HELP) deps.io.err(line);
  return true;
}

/** `collie tricks on|off`. On a Windows machine `on` says the Windows line (the gate stays first); `off` still writes. */
export function cmdTricksSwitch(deps: TricksSwitchDeps, verb: "on" | "off", args: readonly string[]): number {
  if (unknownArgument(deps, args)) return EXIT.USAGE;
  const on = verb === "on";
  if (on && tricksGated(deps.platform)) {
    deps.io.err(`error: ${TRICKS_WINDOWS_LINE}`);
    return EXIT.FAIL;
  }
  const json = args.includes("--json");
  const held = readTricksFeature(deps.ctx.stateDir);
  if (held.reading === verb && held.problem === null) {
    if (json) deps.io.out(JSON.stringify({ on }));
    else deps.io.out(on ? "Tricks are already on." : "Tricks are already off.");
    return EXIT.OK;
  }
  try {
    writeTricksFeature(deps.ctx.stateDir, on, (deps.now ?? Date.now)());
  } catch (err) {
    deps.io.err(`tricks: could not write ${tricksFeaturePath(deps.ctx.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  if (json) deps.io.out(JSON.stringify({ on }));
  else deps.io.out(on ? TRICKS_ON_WORDS : TRICKS_OFF_WORDS);
  return EXIT.OK;
}

/** What `collie tricks on` needs to know where it runs: the pane markers and the bridge's answer. */
export interface TricksOnDeps extends TricksSwitchDeps {
  readonly ctx: Pick<CliContext, "stateDir" | "env">;
  readonly paneKind?: (() => Promise<PaneKind>) | undefined;
}

/**
 * `collie tricks on`: switching tricks on is the person's choice, so it is refused in an agent's pane, with
 * the sentence the other person-only verbs use (cli/hill.ts `personOnlyRefusal`), the same speed bump as
 * `collie trick on` (cli/trick.ts `agentPaneRefusal`). `off` needs no check: a person can always switch off.
 */
export async function cmdTricksOn(deps: TricksOnDeps, args: readonly string[]): Promise<number> {
  if (await paneNotProvenShell(deps.ctx.env, deps.paneKind)) {
    for (const line of personOnlyRefusal("collie tricks on", "in Settings, Experiments")) deps.io.err(line);
    return EXIT.REFUSED;
  }
  return cmdTricksSwitch(deps, "on", args);
}

/** `collie tricks status`: on or off, and `unset` when no switch was ever written (that reads as off). */
export function cmdTricksStatus(deps: TricksSwitchDeps, args: readonly string[]): number {
  if (unknownArgument(deps, args)) return EXIT.USAGE;
  const held = readTricksFeature(deps.ctx.stateDir);
  const windows = tricksGated(deps.platform);
  if (args.includes("--json")) {
    deps.io.out(JSON.stringify(windows ? { on: false, reading: held.reading, gate: "windows" } : { on: held.on, reading: held.reading }));
    return EXIT.OK;
  }
  if (held.problem !== null) deps.io.err(`warn: ${held.problem}`);
  if (windows) deps.io.out(TRICKS_WINDOWS_LINE);
  else if (held.on) deps.io.out("Tricks are on on this machine.");
  else if (held.reading === "unset") deps.io.out(`${TRICKS_OFF_LINE} (No switch was written yet; tricks are off by default.)`);
  else deps.io.out(TRICKS_OFF_LINE);
  return EXIT.OK;
}

/** A bare, misspelt or `--help` `collie tricks`: the sub-verbs. `--help` exits 0, the others 2. */
export function cmdTricks(deps: Pick<TricksSwitchDeps, "io">, args: readonly string[]): number {
  const help = args[0] === "--help" || args[0] === "-h";
  if (!help && args[0] !== undefined) deps.io.err(`error: unknown tricks command \`${args[0]}\``);
  const print = help ? deps.io.out : deps.io.err;
  for (const line of TRICKS_HELP) print(line);
  return help ? EXIT.OK : EXIT.USAGE;
}

import { collieVersion, loadContext } from "./context.ts";
import { EXIT, type Io, realIo } from "./io.ts";
import {
  cmdExecBridge,
  cmdLogs,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUrl,
  type LifecycleDeps,
} from "./lifecycle.ts";
import { realExec, realFiles, waitReady } from "./sys.ts";

// The `collie` binary: argv in, exit code out. This module owns ONLY the dispatch — every verb's
// behaviour lives in its own module under `cli/`, taking the resolved context as an argument.

export { EXIT, realIo, type Io };

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Internal verbs are dispatchable but stay out of the usage line, as in the shell. */
  readonly internal?: boolean;
  run(args: readonly string[], io: Io): number | Promise<number>;
}

/**
 * A verb the shell still owns. The binary is being filled in one spec at a time, and a verb that
 * silently did nothing would be worse than one that says where the behaviour still lives.
 */
function notYetPorted(name: string, summary: string, internal = false): Command {
  return {
    name,
    summary,
    internal,
    run(_args, io) {
      io.err(
        `error: \`collie ${name}\` is not in the binary yet — run \`scripts/collie-ctl.sh ${name}\` for now.`,
      );
      return EXIT.FAIL;
    },
  };
}

/**
 * Everything a lifecycle verb needs, resolved once per invocation: the context, the process and
 * filesystem seams, and the clock. Real implementations here; `cli/lifecycle.test.ts` supplies
 * fakes for the same interfaces.
 */
export function lifecycleDeps(io: Io): LifecycleDeps {
  const ctx = loadContext(io.err);
  return {
    ctx,
    io,
    exec: realExec(ctx.env, ctx.home),
    files: realFiles,
    ready: (port) => waitReady(port),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uid: () => process.getuid?.() ?? 0,
    platform: process.platform,
    // `serve` lands in M3/03. Until then it is the not-yet-ported verb and fails — and `start`
    // surviving that failure is itself ported behaviour, so this wiring is exercised, not stubbed.
    serve: async () => {
      const serve = findCommand("serve");
      return serve === undefined ? EXIT.FAIL : await serve.run([], io);
    },
  };
}

/** A verb whose body is a lifecycle function over {@link lifecycleDeps}. */
function lifecycleCommand(
  name: string,
  summary: string,
  body: (deps: LifecycleDeps, args: readonly string[]) => number | Promise<number>,
  internal = false,
): Command {
  return { name, summary, internal, run: (args, io) => body(lifecycleDeps(io), args) };
}

// Declaration order is the order of the usage line — the shell's dispatch order
// (scripts/collie-ctl.sh:862-879), so the two read the same.
export const COMMANDS: readonly Command[] = [
  lifecycleCommand("start", "start the bridge service (and publish the front door)", cmdStart),
  lifecycleCommand("stop", "stop the bridge service", cmdStop),
  lifecycleCommand("restart", "stop then start", cmdRestart),
  notYetPorted("uninstall", "remove the service, the front door and its ownership record"),
  notYetPorted("update", "advance the checkout, rebuild, restart"),
  notYetPorted("_apply-update", "internal: the second half of `update`, run post-pull", true),
  lifecycleCommand(
    "_exec-bridge",
    "internal: the process the supervisor watches",
    cmdExecBridge,
    true,
  ),
  notYetPorted("build", "typecheck both sides and build the PWA (staged, atomic swap)"),
  notYetPorted("serve", "publish the single managed `tailscale serve` front door"),
  notYetPorted("unserve", "tear down the front door we published"),
  lifecycleCommand("status", "is it running, and on what URLs", cmdStatus),
  lifecycleCommand("url", "print the bridge URL", cmdUrl),
  {
    name: "version",
    summary: "print the version actually being served",
    run(_args, io) {
      const ctx = loadContext(io.err);
      io.out(collieVersion(ctx.root));
      return EXIT.OK;
    },
  },
  notYetPorted("push-test", "send a one-off Web Push to every subscribed device"),
  lifecycleCommand("logs", "tail the service log (default 50 lines)", (deps, args) =>
    cmdLogs(deps, args),
  ),
  {
    name: "help",
    summary: "print this help",
    run(_args, io) {
      io.out(usageLine());
      io.out("");
      for (const c of COMMANDS) {
        if (c.internal === true) continue;
        io.out(`  ${c.name.padEnd(12)} ${c.summary}`);
      }
      return EXIT.OK;
    },
  },
];

export function findCommand(
  name: string,
  commands: readonly Command[] = COMMANDS,
): Command | undefined {
  return commands.find((c) => c.name === name);
}

/** The one-line usage, naming every non-internal verb. */
export function usageLine(commands: readonly Command[] = COMMANDS): string {
  const names = commands.filter((c) => c.internal !== true).map((c) => c.name);
  return `usage: collie {${names.join("|")}}`;
}

export type Parsed =
  | { kind: "verb"; name: string; args: string[] }
  | { kind: "help" }
  | { kind: "unknown"; name: string };

/**
 * argv (already sliced past the executable) → what to do. `help` / `-h` / `--help` is help; an
 * empty argv and an unrecognised verb are both usage errors, as in the shell's `case`.
 */
export function parseArgv(argv: readonly string[], commands: readonly Command[] = COMMANDS): Parsed {
  const first = argv[0];
  if (first === undefined || first === "") return { kind: "unknown", name: "" };
  if (first === "help" || first === "-h" || first === "--help") return { kind: "help" };
  if (findCommand(first, commands) === undefined) return { kind: "unknown", name: first };
  return { kind: "verb", name: first, args: argv.slice(1) };
}

export async function run(
  argv: readonly string[],
  io: Io,
  commands: readonly Command[] = COMMANDS,
): Promise<number> {
  const parsed = parseArgv(argv, commands);
  if (parsed.kind === "unknown") {
    if (parsed.name !== "") io.err(`error: unknown command \`${parsed.name}\``);
    io.err(usageLine(commands));
    return EXIT.USAGE;
  }
  const name = parsed.kind === "help" ? "help" : parsed.name;
  const args = parsed.kind === "help" ? [] : parsed.args;
  const command = findCommand(name, commands);
  if (command === undefined) {
    io.err(usageLine(commands));
    return EXIT.USAGE;
  }
  try {
    return await command.run(args, io);
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), realIo);
}

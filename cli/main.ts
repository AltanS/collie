import { collieVersion, loadContext } from "./context.ts";

// The `collie` binary: argv in, exit code out. This module owns ONLY the dispatch — every verb's
// behaviour lives in its own module under `cli/`, taking the resolved context as an argument.
//
// Exit codes are a contract, ported from `scripts/collie-ctl.sh`:
//   0  success
//   1  operational failure — something we tried, that failed
//   2  usage error — unknown verb, bad argument (scripts/collie-ctl.sh:878)
// Diagnostics go to stderr; machine-readable output (`url`, `version`) to stdout, undecorated.

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2 } as const;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const realIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

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

// Declaration order is the order of the usage line — the shell's dispatch order
// (scripts/collie-ctl.sh:862-879), so the two read the same.
export const COMMANDS: readonly Command[] = [
  notYetPorted("start", "start the bridge service (and publish the front door)"),
  notYetPorted("stop", "stop the bridge service"),
  notYetPorted("restart", "stop then start"),
  notYetPorted("uninstall", "remove the service, the front door and its ownership record"),
  notYetPorted("update", "advance the checkout, rebuild, restart"),
  notYetPorted("_apply-update", "internal: the second half of `update`, run post-pull", true),
  notYetPorted("_exec-bridge", "internal: the process the supervisor watches", true),
  notYetPorted("build", "typecheck both sides and build the PWA (staged, atomic swap)"),
  notYetPorted("serve", "publish the single managed `tailscale serve` front door"),
  notYetPorted("unserve", "tear down the front door we published"),
  notYetPorted("status", "is it running, and on what URLs"),
  notYetPorted("url", "print the bridge URL"),
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
  notYetPorted("logs", "tail the service log (default 50 lines)"),
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

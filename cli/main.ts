import { cmdBuild } from "./build.ts";
import { collieVersion, loadContext } from "./context.ts";
import { cmdDoctor, doctorDeps } from "./doctor.ts";
import { EXIT, type Io, realIo } from "./io.ts";
import {
  cmdExecBridge,
  cmdLogs,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUninstall,
  cmdUrl,
  type LifecycleDeps,
} from "./lifecycle.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdPack,
  cmdPromote,
  cmdReconnect,
  packAudit,
  packDeps,
  PACK_SUBCOMMANDS,
  type PackDeps,
} from "./pack.ts";
import { cmdPushTest } from "./push.ts";
import { cmdQr } from "./qr.ts";
import { cmdServe, cmdUnserve } from "./serve.ts";
import { realExec, realFiles, waitReady } from "./sys.ts";
import { bridgeUrl } from "./tailnet.ts";
import { cmdApplyUpdate, cmdUpdate, type UpdateDeps } from "./update.ts";

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
 * Everything a lifecycle verb needs, resolved once per invocation: the context, the process and
 * filesystem seams, and the clock. Real implementations here; `cli/lifecycle.test.ts` supplies
 * fakes for the same interfaces.
 */
export function lifecycleDeps(io: Io): LifecycleDeps {
  const ctx = loadContext(io.err);
  const deps: LifecycleDeps = {
    ctx,
    io,
    exec: realExec(ctx.env, ctx.home),
    files: realFiles,
    ready: (port) => waitReady(port),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uid: () => process.getuid?.() ?? 0,
    platform: process.platform,
    // The front door, over the same resolved context. `start` calls this and tolerates its failure;
    // `collie serve` is the same function plus the `open:` line.
    serve: () => Promise.resolve(cmdServe(deps)),
  };
  return deps;
}

/**
 * `update`'s dependencies: the lifecycle set plus `restart`, injected so the update tests can drive
 * the whole post-pull half without a service manager anywhere near them.
 */
function updateDeps(io: Io): UpdateDeps {
  const deps = lifecycleDeps(io);
  return { ...deps, restart: () => cmdRestart(deps) };
}

/**
 * A pack verb's dependencies: the lifecycle set's seams, plus the trust store, the transport, the
 * clock and the audit log (`cli/pack.ts`'s `packDeps`).
 *
 * `restart`, `serve` and `unserve` are passed as the real lifecycle verbs because a membership change
 * is not complete until the running bridge has it: the trust store is read once per process, and mode,
 * push gate and roster are resolved at construction.
 */
async function packVerbDeps(io: Io): Promise<PackDeps> {
  const deps = lifecycleDeps(io);
  return packDeps(
    {
      ctx: deps.ctx,
      io,
      exec: deps.exec,
      files: deps.files,
      restart: () => cmdRestart(deps),
      serve: () => Promise.resolve(cmdServe(deps)),
      unserve: () => cmdUnserve(deps),
    },
    await packAudit(deps.ctx),
  );
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

// Declaration order is the order of the usage line, and it is the order `scripts/collie-ctl.sh`
// dispatched in before M6/01 turned that script into a bootstrap shim — so muscle memory carried
// over from `collie-ctl.sh <verb>` still finds every verb where it was.
export const COMMANDS: readonly Command[] = [
  lifecycleCommand("start", "start the bridge service (and publish the front door)", cmdStart),
  lifecycleCommand("stop", "stop the bridge service", cmdStop),
  lifecycleCommand("restart", "stop then start", cmdRestart),
  lifecycleCommand(
    "uninstall",
    "remove the service, the front door and its ownership record",
    cmdUninstall,
  ),
  {
    name: "update",
    summary: "advance the checkout, rebuild, restart",
    run: (_args, io) => cmdUpdate(updateDeps(io)),
  },
  {
    name: "_apply-update",
    summary: "internal: the second half of `update`, run post-pull",
    internal: true,
    run: (_args, io) => cmdApplyUpdate(updateDeps(io)),
  },
  lifecycleCommand(
    "_exec-bridge",
    "internal: the process the supervisor watches",
    cmdExecBridge,
    true,
  ),
  lifecycleCommand(
    "build",
    "typecheck both sides, compile the binary and build the PWA (staged, atomic swap)",
    cmdBuild,
  ),
  // Invoked directly, `serve` also prints where to point a phone (the pre-shim collie-ctl.sh) —
  // `start` does not, because its banner already carries the URL.
  lifecycleCommand("serve", "publish the single managed `tailscale serve` front door", (deps) => {
    const code = cmdServe(deps);
    if (code !== EXIT.OK) return code;
    deps.io.out(`open: ${bridgeUrl(deps.exec, deps.ctx.serveMode, deps.ctx.port)}`);
    return EXIT.OK;
  }),
  lifecycleCommand("unserve", "tear down the front door we published", cmdUnserve),
  lifecycleCommand("status", "is it running, and on what URLs", cmdStatus),
  lifecycleCommand("url", "print the bridge URL", cmdUrl),
  lifecycleCommand("qr", "print the bridge URL as a scannable QR code", (deps) => cmdQr(deps)),
  {
    name: "version",
    summary: "print the version actually being served",
    run(_args, io) {
      const ctx = loadContext(io.err);
      io.out(collieVersion(ctx.root));
      return EXIT.OK;
    },
  },
  {
    name: "push-test",
    summary: "send a one-off Web Push to every subscribed device",
    run: (args, io) => {
      const ctx = loadContext(io.err);
      return cmdPushTest({ ctx, io, files: realFiles }, args);
    },
  },
  lifecycleCommand("logs", "tail the service log (default 50 lines)", (deps, args) =>
    cmdLogs(deps, args),
  ),
  // Read-only by contract (cli/doctor.ts), so its deps are the lifecycle seams with every mutating
  // one left out — no service manager, no front door, no store write.
  {
    name: "doctor",
    summary: "check this install for the traps that fail silently",
    run: (args, io) => {
      const deps = lifecycleDeps(io);
      return cmdDoctor(doctorDeps({ ctx: deps.ctx, io, exec: deps.exec, files: deps.files }), args);
    },
  },
  // ── The pack (M4/07) ───────────────────────────────────────────────────────
  // The only way a machine enters or leaves a pack. Every one of them resolves its seams through
  // `packVerbDeps`, so the dispatcher stays a table and `cli/pack.ts` owns the behaviour.
  {
    name: "join",
    summary: "join a pack: `join <lead-address> <token|-|@file>` (run on the joining machine)",
    run: async (args, io) => cmdJoin(await packVerbDeps(io), args),
  },
  {
    name: "leave",
    summary: "leave the pack — drops the pack secret and every pin on this machine",
    run: async (_args, io) => cmdLeave(await packVerbDeps(io)),
  },
  {
    name: "pack",
    summary: `pack administration: ${PACK_SUBCOMMANDS.join(", ")}`,
    run: async (args, io) => cmdPack(await packVerbDeps(io), args),
  },
  {
    name: "promote",
    summary: "make THIS machine the lead (run on the peer taking over; --force if the lead is gone)",
    run: async (args, io) => cmdPromote(await packVerbDeps(io), args),
  },
  {
    name: "reconnect",
    summary: "a member moved: re-point at its new address without re-enrolling anything",
    run: async (args, io) => cmdReconnect(await packVerbDeps(io), args),
  },
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

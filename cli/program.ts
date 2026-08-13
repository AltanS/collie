import { Command as Program, CommanderError } from "commander";

import { cmdBuild } from "./build.ts";
import { collieVersion, loadContext } from "./context.ts";
import { lifecycleDeps, updateDeps } from "./deps.ts";
import { cmdDoctor, doctorDeps } from "./doctor.ts";
import { EXIT, type Io, realIo } from "./io.ts";
import {
  cmdExecBridge,
  cmdLogs,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUninstall,
  cmdRestart,
  cmdUrl,
  type LifecycleDeps,
} from "./lifecycle.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdPack,
  cmdPackApprovePromote,
  cmdPackInvite,
  cmdPackRemove,
  cmdPackRotate,
  cmdPackStatus,
  cmdPromote,
  cmdReconnect,
  packAudit,
  packDeps,
  PACK_SUBCOMMANDS,
} from "./pack.ts";
import { cmdPushTest } from "./push.ts";
import { cmdQr } from "./qr.ts";
import { loadUi, renderInputs, takePlainFlag, type Ui, wantsRich } from "./render.ts";
import { cmdPackAdd, packAddDeps, type PackAddDeps } from "./remote.ts";
import { cmdServe, cmdUnserve } from "./serve.ts";
import { realFiles } from "./sys.ts";
import { bridgeUrl } from "./tailnet.ts";
import { cmdApplyUpdate, cmdUpdate } from "./update.ts";

// The `collie` binary's dispatch: argv in, exit code out. This module owns ONLY the dispatch —
// every verb's behaviour lives in its own module under `cli/`, taking the resolved context as an
// argument.
//
// It is reached through a dynamic `import()` from `cli/main.ts`, which is what keeps commander off
// the path a bare checkout takes to `build` — see that file's header. `build` and `_apply-update`
// are therefore dispatched BEFORE this module loads; they stay in {@link COMMANDS} because the
// table is the single declaration of the verb list, and `cli/main.test.ts` pins the two together.
//
// ── COMMANDER PARSES; THE TABLE STILL DECLARES ───────────────────────────────
// `commander` owns argv → verb, the subcommand tree and the usage errors. It does NOT own the verb
// list: {@link COMMANDS} is still the single declaration, in the order the usage line prints, and
// the program is built from it. That keeps two things true that a hand-written `program.command(…)`
// wall would quietly break — the usage line can't drift from the table, and a verb can't be added
// without a summary.
//
// Everything about the grammar is byte-for-byte what the hand-rolled dispatcher did, because the
// spellings are a contract: a README recipe, muscle memory from `collie-ctl.sh <verb>`, and a
// <0.8.0 Herdr install's cached action set (ADR 0006) all land on this table. So commander is
// configured to never exit the process itself (`exitOverride`), never write to the real streams
// (`configureOutput` → the {@link Io} seam), and never print its own help text (`configureHelp`) —
// the exit-code families of `cli/io.ts` and the help layout below are what callers already parse.

export { EXIT, realIo, type Io };

/**
 * One invocation's presentation decision, resolved once in {@link run} and handed to every verb.
 *
 * `rich` is the answer to "did this land on a terminal a TTY view is worth drawing on?" — see
 * `cli/render.ts` for why it is decided here rather than at each point of output.
 */
export interface Session {
  readonly io: Io;
  /**
   * The terminal renderer, or `null`. Lazy and memoised, and called ONLY by the three verbs that
   * have a surface — resolving it is what pulls react, ink and yoga into the process, and a piped
   * or plain `collie url` must not pay for a UI it will never draw.
   */
  ui(): Promise<Ui | null>;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Internal verbs are dispatchable but stay out of the usage line, as in the shell. */
  readonly internal?: boolean;
  /**
   * A verb that owns a subcommand tree declares it here, and commander builds real child commands
   * from it. The parent's own `run` stays the fallback — it is what answers a bare `collie pack`
   * and an unknown subcommand, with the usage block those two have always printed.
   */
  readonly subcommands?: readonly Subcommand[];
  run(args: readonly string[], session: Session): number | Promise<number>;
}

export interface Subcommand {
  readonly name: string;
  readonly summary: string;
  run(args: readonly string[], session: Session): number | Promise<number>;
}

/**
 * A pack verb's dependencies: the lifecycle set's seams, plus the trust store, the transport, the
 * clock and the audit log (`cli/pack.ts`'s `packDeps`).
 *
 * `restart`, `serve` and `unserve` are passed as the real lifecycle verbs because a membership change
 * is not complete until the running bridge has it: the trust store is read once per process, and mode,
 * push gate and roster are resolved at construction.
 */
async function packVerbDeps(io: Io, ui: Ui | null = null): Promise<PackAddDeps> {
  const deps = lifecycleDeps(io);
  // `packAddDeps` layers the SSH transport, the two prompts and the bundle on top — `pack add` is
  // the one verb that reaches another machine, and every one of those is a seam its tests replace.
  return packAddDeps(
    packDeps(
      {
        ctx: deps.ctx,
        io,
        ui,
        exec: deps.exec,
        files: deps.files,
        restart: (into?: Io) => cmdRestart(into === undefined ? deps : { ...deps, io: into }),
        serve: () => Promise.resolve(cmdServe(deps)),
        unserve: () => cmdUnserve(deps),
      },
      await packAudit(deps.ctx),
    ),
  );
}

/** A verb whose body is a lifecycle function over {@link lifecycleDeps}. */
function lifecycleCommand(
  name: string,
  summary: string,
  body: (deps: LifecycleDeps, args: readonly string[]) => number | Promise<number>,
  opts: { internal?: boolean; rich?: boolean } = {},
): Command {
  return {
    name,
    summary,
    internal: opts.internal === true,
    // `rich` is what marks a verb as having a terminal surface. Without it the renderer is never
    // even loaded — see `Session.ui`.
    run: async (args, s) => body(lifecycleDeps(s.io, opts.rich === true ? await s.ui() : null), args),
  };
}

/** A `pack` sub-verb whose body takes the pack dependency set; `rich` marks a surface in `cli/ui/`. */
function packSubcommand(
  name: (typeof PACK_SUBCOMMANDS)[number],
  summary: string,
  body: (deps: PackAddDeps, args: readonly string[]) => number | Promise<number>,
  rich = false,
): Subcommand {
  return {
    name,
    summary,
    run: async (args, s) => body(await packVerbDeps(s.io, rich ? await s.ui() : null), args),
  };
}

// Declaration order is the order of the usage line, and it is the order `scripts/collie-ctl.sh`
// dispatched in before M6/01 turned that script into a bootstrap shim — so muscle memory carried
// over from `collie-ctl.sh <verb>` still finds every verb where it was.
export const COMMANDS: readonly Command[] = [
  // `start` and `status` share one banner (`statusBanner`), so they share its surface too.
  lifecycleCommand("start", "start the bridge service (and publish the front door)", cmdStart, { rich: true }),
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
    run: (_args, s) => cmdUpdate(updateDeps(s.io)),
  },
  {
    name: "_apply-update",
    summary: "internal: the second half of `update`, run post-pull",
    internal: true,
    run: (_args, s) => cmdApplyUpdate(updateDeps(s.io)),
  },
  lifecycleCommand(
    "_exec-bridge",
    "internal: the process the supervisor watches",
    cmdExecBridge,
    { internal: true },
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
  lifecycleCommand("status", "is it running, and on what URLs", cmdStatus, { rich: true }),
  lifecycleCommand("url", "print the bridge URL", cmdUrl),
  lifecycleCommand("qr", "print the bridge URL as a scannable QR code", (deps) => cmdQr(deps)),
  {
    name: "version",
    summary: "print the version actually being served",
    run(_args, s) {
      const ctx = loadContext(s.io.err);
      s.io.out(collieVersion(ctx.root));
      return EXIT.OK;
    },
  },
  {
    name: "push-test",
    summary: "send a one-off Web Push to every subscribed device",
    run: (args, s) => {
      const ctx = loadContext(s.io.err);
      return cmdPushTest({ ctx, io: s.io, files: realFiles }, args);
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
    run: async (args, s) => {
      const deps = lifecycleDeps(s.io);
      return cmdDoctor(
        doctorDeps({ ctx: deps.ctx, io: s.io, exec: deps.exec, files: deps.files, ui: await s.ui() }),
        args,
      );
    },
  },
  // ── The pack (M4/07) ───────────────────────────────────────────────────────
  // The only way a machine enters or leaves a pack. Every one of them resolves its seams through
  // `packVerbDeps`, so the dispatcher stays a table and `cli/pack.ts` owns the behaviour.
  {
    name: "join",
    summary: "join a pack: `join <lead-address> <token|-|@file>` (run on the joining machine)",
    run: async (args, s) => cmdJoin(await packVerbDeps(s.io), args),
  },
  {
    name: "leave",
    summary: "leave the pack — drops the pack secret and every pin on this machine",
    run: async (_args, s) => cmdLeave(await packVerbDeps(s.io)),
  },
  {
    name: "pack",
    summary: `pack administration: ${PACK_SUBCOMMANDS.join(", ")}`,
    // The tree commander builds. Order is `PACK_SUBCOMMANDS`' order, which is the order
    // `cli/pack.ts`'s own usage block prints — the two are pinned to each other in cli/main.test.ts.
    subcommands: [
      packSubcommand("invite", "mint a single-use, 10-minute enrollment token (on the lead)", cmdPackInvite),
      packSubcommand("add", "install and enroll a peer over SSH: `pack add <ssh-host>` (on the lead)", cmdPackAdd, true),
      packSubcommand("status", "mode, members, reachability, secret pickup and why a link is refused", cmdPackStatus, true),
      packSubcommand("rotate", "reissue the pack secret and hand it to every reachable peer", (deps) =>
        cmdPackRotate(deps),
      ),
      packSubcommand("remove", "unpin and forget a member (on the lead)", cmdPackRemove),
      packSubcommand(
        "approve-promote",
        "consent, on the lead, for one member to take over (10 minutes, single-use)",
        cmdPackApprovePromote,
      ),
    ],
    // Reached only when no subcommand matched — a bare `collie pack`, or a misspelt one. `cmdPack`
    // owns that message, and has since before commander: it names every sub-verb with its own
    // one-line summary, which is more than an "unknown command" line would say.
    run: async (args, s) => cmdPack(await packVerbDeps(s.io), args),
  },
  {
    name: "promote",
    summary: "make THIS machine the lead (run on the peer taking over; --force if the lead is gone)",
    run: async (args, s) => cmdPromote(await packVerbDeps(s.io), args),
  },
  {
    name: "reconnect",
    summary: "a member moved: re-point at its new address without re-enrolling anything",
    run: async (args, s) => cmdReconnect(await packVerbDeps(s.io), args),
  },
  {
    name: "help",
    summary: "print this help",
    run(_args, s) {
      for (const line of helpText()) s.io.out(line);
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

/**
 * The help body, as lines. Commander is told to print exactly this instead of its own layout
 * (`configureHelp({ formatHelp })`), so `collie help`, `collie -h` and `collie --help` are one text
 * with one exit code, and the shape a script may already be grepping does not move.
 */
export function helpText(commands: readonly Command[] = COMMANDS): string[] {
  const lines = [usageLine(commands), ""];
  for (const c of commands) {
    if (c.internal === true) continue;
    lines.push(`  ${c.name.padEnd(12)} ${c.summary}`);
  }
  lines.push("");
  lines.push(`  ${"--plain".padEnd(12)} never draw the terminal view — print the lines a pipe would get`);
  return lines;
}

/** Feed a commander write (one string, possibly multi-line, usually newline-terminated) to `Io`. */
function emit(sink: (line: string) => void, chunk: string): void {
  const lines = chunk.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) sink(line);
}

/**
 * Build the commander program for one invocation. The exit code is not commander's to decide, so
 * every action stashes its verb's return value here and {@link run} reads it back out.
 */
function buildProgram(
  session: Session,
  commands: readonly Command[],
  setCode: (code: number) => void,
): Program {
  const program = new Program();
  program
    .name("collie")
    // Nothing in this process may `process.exit()` — the binary's exit code is `run`'s return value,
    // and a library that exits behind our back would take the 3/4/5 pack codes with it.
    .exitOverride()
    .configureOutput({
      writeOut: (chunk) => emit(session.io.out, chunk),
      writeErr: (chunk) => emit(session.io.err, chunk),
      // Commander's own error prose never reaches the user: every usage error this CLI can produce
      // is written by the code that knows what the operator was reaching for.
      outputError: () => {},
    })
    // The root's help is this file's `helpText`; a subcommand keeps commander's own layout, which
    // nothing has ever pinned.
    .configureHelp({ formatHelp: (cmd) => (cmd === program ? `${helpText(commands).join("\n")}\n` : "") })
    // An unrecognised verb is not commander's error to report — it falls through to the root action
    // below, which names it in the words the shell dispatcher used.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[verb...]")
    .action((verb: string[]) => {
      const name = verb[0];
      if (name !== undefined && name !== "") session.io.err(`error: unknown command \`${name}\``);
      session.io.err(usageLine(commands));
      setCode(EXIT.USAGE);
    });

  for (const c of commands) {
    const leaf = program
      .command(c.name, { hidden: c.internal === true })
      .description(c.summary)
      // Every verb still receives its argv verbatim: the flag grammars live in the verbs (and are
      // pinned there, against fake deps), so commander forwards rather than re-parses. `-h` is off
      // for the same reason — today `collie logs --help` is a `logs` argument, not a help request.
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .helpOption(false)
      .argument("[args...]");
    if (c.subcommands === undefined) {
      leaf.action(async (args: string[]) => setCode(await c.run(args, session)));
      continue;
    }
    // A parent with children: commander matches a child by name, and anything else — including
    // nothing at all — reaches the parent's own action.
    leaf.action(async (args: string[]) => setCode(await c.run(args, session)));
    for (const sub of c.subcommands) {
      leaf
        .command(sub.name)
        .description(sub.summary)
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .helpOption(false)
        .argument("[args...]")
        .action(async (args: string[]) => setCode(await sub.run(args, session)));
    }
  }
  return program;
}

export async function run(
  argv: readonly string[],
  io: Io,
  commands: readonly Command[] = COMMANDS,
  isTTY = false,
): Promise<number> {
  const { plain, rest } = takePlainFlag(argv);
  const rich = wantsRich(renderInputs(process.env, isTTY, plain));
  let loaded: Ui | null = null;
  const session: Session = {
    io,
    async ui() {
      if (!rich) return null;
      loaded ??= await loadUi();
      return loaded;
    },
  };
  let code: number = EXIT.OK;
  const program = buildProgram(session, commands, (c) => {
    code = c;
  });
  try {
    await program.parseAsync(rest, { from: "user" });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help is output, not a diagnostic: commander has already written it through `writeOut`.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.help") return EXIT.OK;
      io.err(usageLine(commands));
      return EXIT.USAGE;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
}

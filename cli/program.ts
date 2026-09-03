import { Command as Program, CommanderError } from "commander";

import { type BeaconEmitDeps, runBeaconEmit } from "./beacon.ts";
import { cmdBuild } from "./build.ts";
import { collieVersion, loadContext } from "./context.ts";
import {
  cmdHooks,
  cmdHooksInstall,
  cmdHooksStatus,
  cmdHooksUninstall,
  type HooksDeps,
  HOOKS_SUBCOMMANDS,
} from "./hooks.ts";
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
import { cmdLink, cmdUnlink, type LinkDeps, realLinkFs } from "./link.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdPack,
  cmdPackApprovePromote,
  cmdPackInvite,
  cmdPackRemove,
  cmdPackRotate,
  cmdPackSetAddress,
  cmdPackStatus,
  cmdPromote,
  cmdReconnect,
  packAudit,
  packDeps,
  PACK_SUBCOMMANDS,
} from "./pack.ts";
import {
  cmdDevices,
  cmdDevicesList,
  cmdDevicesRevoke,
  cmdPair,
  DEVICES_SUBCOMMANDS,
  type PairingDeps,
} from "./pairing.ts";
import {
  cmdPush,
  cmdPushForget,
  cmdPushList,
  cmdPushTest,
  type PushDeps,
  PUSH_SUBCOMMANDS,
} from "./push.ts";
import { cmdPushKeys } from "./push-keys.ts";
import { cmdQr } from "./qr.ts";
import { loadUi, renderInputs, takePlainFlag, type Ui, wantsRich } from "./render.ts";
import { cmdPackDeputy } from "./pack-deputy.ts";
import { cmdPackUpdate } from "./pack-update.ts";
import { cmdPackAdd, packAddDeps, type PackAddDeps } from "./remote.ts";
import { cmdServe, cmdServeVerb, cmdUnserve } from "./serve.ts";
import {
  cmdStt,
  cmdSttOff,
  cmdSttSetup,
  cmdSttStatus,
  cmdSttTest,
  STT_SUBCOMMANDS,
  type SttDeps,
} from "./stt.ts";
import { realExec, realFiles } from "./sys.ts";
import { cmdApplyUpdate, cmdUpdate } from "./update.ts";
import { cmdUpdateCheck, updateCheckDeps, wantsCheck } from "./update-check.ts";

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
        // Threaded exactly like `restart`: `cmdStart` (reached through `restart` on the rich `pack
        // add` path) calls this with the SAME swapped `io` it was given, so a serve republish that
        // happens mid-restart lands on the surface's held-chatter `Io` instead of escaping to the
        // real terminal (the bug this comment used to have no fix for — see cli/lifecycle.ts).
        serve: (into?: Io) => Promise.resolve(cmdServe(into === undefined ? deps : { ...deps, io: into })),
        unserve: () => cmdUnserve(deps),
      },
      await packAudit(deps.ctx),
    ),
  );
}

/**
 * The pairing verbs' seams: the resolved context (for `stateDir` — the SAME directory the bridge
 * resolves, which is the whole reason an enrolment made here is visible to the running service), the
 * output seam, and the filesystem. No service manager and no network: neither verb has either.
 */
function pairingDeps(io: Io): PairingDeps {
  return { ctx: loadContext(io.err), io, files: realFiles };
}

/**
 * The push verbs' seams: the resolved context and the output seam, nothing else. The subscription
 * store is read and written by `bridge/push.ts` — the CLI holds no second parser for it.
 */
function pushDeps(io: Io): PushDeps {
  return { ctx: loadContext(io.err), io };
}

/**
 * `link` / `unlink`: where the checkout is, the output seam, the filesystem (only to answer "has this
 * been built?"), and the symlink seam. No service manager and no network — publishing a name touches
 * one entry in `~/.local/bin` and nothing else.
 */
function linkDeps(io: Io): LinkDeps {
  return { ctx: loadContext(io.err), io, files: realFiles, fs: realLinkFs };
}

/**
 * `hooks`: the same three seams as `link` — it edits the agent's `settings.json` and reads the
 * published PATH name to decide what command to write into it (ADR 0021). No service manager, no
 * network, and nothing under the state dir.
 */
function hooksDeps(io: Io): HooksDeps {
  return { ctx: loadContext(io.err), io, files: realFiles, fs: realLinkFs };
}

/**
 * `stt`: the pairing set (context + filesystem — `stt.json` lives beside the pairing files, under the
 * state dir the bridge resolves), plus `exec` to locate the operator's `codex` binary and the two
 * prompts `setup` asks its questions through.
 *
 * The prompts are Bun's built-ins behind a tty check, exactly as `pack add` guards them: a question
 * nobody can answer must abort legibly rather than read EOF as consent — and on the codex path that
 * question IS the consent (ADR 0029).
 */
function sttDeps(io: Io): SttDeps {
  const ctx = loadContext(io.err);
  return {
    ctx,
    io,
    files: realFiles,
    exec: realExec(ctx.env, ctx.home),
    interactive: process.stdin.isTTY === true,
    prompt: (question) => (process.stdin.isTTY === true ? prompt(question) : null),
  };
}

/**
 * `beacon emit`: the state dir, the filesystem, stdin, and the AGENT's pid.
 *
 * There is no `Io` in this set, and that is the point — a hook's stdout is injected into the
 * conversation, so the verb has no way to print even by accident. The context's own stderr notes are
 * dropped for the same reason. `process.ppid` is the `claude` process: a hook command runs as its
 * direct child (probed 2026-08-20 — see `cli/beacon.ts`).
 */
function beaconDeps(): BeaconEmitDeps {
  return {
    ctx: loadContext(() => {}),
    files: realFiles,
    readStdin: () => Bun.stdin.text(),
    agentPid: process.ppid,
  };
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
    summary:
      "advance to the newest release of this major (--check is a read-only preflight, and --check --local checks this instance only, skipping pack members; --major crosses one; --rollback flips current back to the previous version; --status shows the run)",
    // `--check` is a different verb wearing `update`'s name: a read-only preflight that answers
    // "could this update succeed right now?" and touches nothing (`cli/update-check.ts`). It is
    // routed HERE, before `cmdUpdate` is ever constructed, so no part of the real update path can
    // run behind it.
    run: (args, s) =>
      wantsCheck(args) ? cmdUpdateCheck(updateCheckDeps(s.io), args) : cmdUpdate(updateDeps(s.io), args),
  },
  {
    name: "_apply-update",
    summary: "internal: the second half of `update`, run post-pull",
    internal: true,
    run: (args, s) => cmdApplyUpdate(updateDeps(s.io), args),
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
  // `start` does not, because its banner already carries the URL. That extra line is `cmdServeVerb`,
  // which lives beside the publish decision it depends on (a peer prints none — F24).
  lifecycleCommand("serve", "publish the single managed `tailscale serve` front door", cmdServeVerb),
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
  // `push-keys` and `push-test` keep their hyphenated spellings because the Herdr action set cached
  // at install time names them (ADR 0006) — the shim delegates both here. `push keys` / `push test`
  // below are the same functions under the parent verb.
  {
    name: "push-keys",
    summary: "generate the VAPID keypair and write it into this install's .env",
    run: (args, s) => cmdPushKeys(pushDeps(s.io), args),
  },
  {
    name: "push-test",
    summary: "send a one-off Web Push to every subscribed device",
    run: (args, s) => cmdPushTest(pushDeps(s.io), args),
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
  // ── The name on PATH (ADR 0021) ────────────────────────────────────────────
  // The other publish/tear-down pair: `serve` publishes a URL, `link` publishes a NAME. Both only
  // ever tear down what matches their own record — the handler file there, the link's target here
  // (ADR 0001). Declared beside `doctor` rather than beside `serve` because, like it, they are verbs
  // the shell dispatcher never had.
  {
    name: "link",
    summary: "put `collie` on your PATH: ~/.local/bin/collie → this checkout's binary",
    run: (_args, s) => cmdLink(linkDeps(s.io)),
  },
  {
    name: "unlink",
    summary: "remove that name again (only when it points at THIS checkout)",
    run: (_args, s) => cmdUnlink(linkDeps(s.io)),
  },
  // ── Agent beacons (M11) ────────────────────────────────────────────────────
  // Declared beside `link` because they share its subject: `hooks install` writes the published PATH
  // name into the agent's own settings, and that name is a symlink to this checkout (ADR 0021). The
  // emitter is internal — it is spelled by a hook, never typed — and its whole contract is that it
  // prints nothing and exits 0 (cli/beacon.ts).
  {
    name: "hooks",
    summary: `agent hooks that report a pane's identity: ${HOOKS_SUBCOMMANDS.join(", ")}`,
    subcommands: [
      {
        name: "install",
        summary: "register the beacon hooks: `hooks install claude`",
        run: (args, s) => cmdHooksInstall(hooksDeps(s.io), args),
      },
      {
        name: "uninstall",
        summary: "remove only the entries collie owns: `hooks uninstall claude`",
        run: (args, s) => cmdHooksUninstall(hooksDeps(s.io), args),
      },
      {
        name: "status",
        summary: "what each settings file carries right now (reads only)",
        run: (args, s) => cmdHooksStatus(hooksDeps(s.io), args),
      },
    ],
    run: (args, s) => cmdHooks(hooksDeps(s.io), args),
  },
  {
    name: "beacon",
    summary: "internal: `beacon emit` — an agent hook's payload in, one beacon file out",
    internal: true,
    subcommands: [
      {
        name: "emit",
        summary: "internal: write this pane's beacon from the hook payload on stdin",
        run: () => runBeaconEmit(beaconDeps),
      },
    ],
    // A bare `collie beacon`, or a misspelt sub-verb, is still an invocation from a hook — so it gets
    // the same silence and the same exit 0 as every other path through the emitter.
    run: () => EXIT.OK,
  },
  // ── Device pairing ─────────────────────────────────────────────────────────
  // The operator's terminal is the out-of-band channel enrolment bootstraps from — see the header of
  // `cli/pairing.ts`. Both verbs touch only the two files under the state dir, which the bridge
  // re-reads per request, so neither restarts anything.
  {
    name: "pair",
    summary: "mint a one-time code for a phone to pair with (enter it in Collie's Settings)",
    run: (_args, s) => cmdPair(pairingDeps(s.io)),
  },
  {
    name: "devices",
    summary: `paired devices: ${DEVICES_SUBCOMMANDS.join(", ")}`,
    subcommands: [
      {
        name: "list",
        summary: "the paired devices, with when each was paired and last seen",
        run: (_args, s) => cmdDevicesList(pairingDeps(s.io)),
      },
      {
        name: "revoke",
        summary: "drop one device by label: `devices revoke <label>`",
        run: (args, s) => cmdDevicesRevoke(pairingDeps(s.io), args),
      },
    ],
    // Bare or misspelt lands here, and `cmdDevices` owns that message — as `cmdPack` does.
    run: (args, s) => cmdDevices(pairingDeps(s.io), args),
  },
  // ── Push subscriptions ─────────────────────────────────────────────────────
  // Next to `devices` because it answers the same shape of question — who is registered with this
  // bridge, and how do I drop one. `list` and `forget` need no VAPID: the store is a file.
  {
    name: "push",
    summary: `subscribed devices: ${PUSH_SUBCOMMANDS.join(", ")}`,
    subcommands: [
      {
        name: "list",
        summary: "the subscribed devices, with when each subscribed and from what",
        run: (_args, s) => cmdPushList(pushDeps(s.io)),
      },
      {
        name: "forget",
        summary: "drop rows by endpoint substring: `push forget <substring>|--all`",
        run: (args, s) => cmdPushForget(pushDeps(s.io), args),
      },
      {
        name: "keys",
        summary: "generate the VAPID keypair into this install's .env (also spelled `push-keys`)",
        run: (args, s) => cmdPushKeys(pushDeps(s.io), args),
      },
      {
        name: "test",
        summary: "send a one-off Web Push to every subscribed device (also spelled `push-test`)",
        run: (args, s) => cmdPushTest(pushDeps(s.io), args),
      },
    ],
    run: (args, s) => cmdPush(pushDeps(s.io), args),
  },
  // ── Speech-to-text (ADR 0029) ──────────────────────────────────────────────
  // Declared beside `pair` and `push` because it is the third thing the operator's own terminal is
  // the only right place for: `stt setup` writes a provider credential — or records a consent to
  // impersonate — into the state dir, and the bridge picks it up per request with no restart.
  {
    name: "stt",
    summary: `speech-to-text (off until you run it): ${STT_SUBCOMMANDS.join(", ")}`,
    subcommands: [
      {
        name: "setup",
        summary: "pick a provider and write it into the state dir (interactive, or all by flag)",
        run: (args, s) => cmdSttSetup(sttDeps(s.io), args),
      },
      {
        name: "test",
        summary: "one real round trip through what is configured",
        run: (_args, s) => cmdSttTest(sttDeps(s.io)),
      },
      {
        name: "status",
        summary: "the provider, where each setting came from, and whether it is on",
        run: (_args, s) => cmdSttStatus(sttDeps(s.io)),
      },
      {
        name: "off",
        summary: "remove stt.json — speech-to-text is absent again",
        run: (_args, s) => cmdSttOff(sttDeps(s.io)),
      },
    ],
    // Bare or misspelt lands here, and `cmdStt` owns that message — as `cmdDevices` does.
    run: (args, s) => cmdStt(sttDeps(s.io), args),
  },
  // ── The pack (M4/07) ───────────────────────────────────────────────────────
  // The only way a machine enters or leaves a pack. Every one of them resolves its seams through
  // `packVerbDeps`, so the dispatcher stays a table and `cli/pack.ts` owns the behaviour.
  // The two ALIASES. `pack join` and `pack leave` are the canonical spellings — every other pack
  // verb is a `pack` sub-verb, and these two were the exception for no reason anyone could state.
  // They stay because 1.0.0 documented them and scripts type them: same function, same seams, same
  // exit codes, one name each. `cli/pack.test.ts` pins that the two spellings are one code path.
  {
    name: "join",
    summary: "same as `pack join`",
    run: async (args, s) => cmdJoin(await packVerbDeps(s.io), args),
  },
  {
    name: "leave",
    summary: "same as `pack leave`",
    run: async (_args, s) => cmdLeave(await packVerbDeps(s.io)),
  },
  {
    name: "pack",
    summary: `pack administration: ${PACK_SUBCOMMANDS.join(", ")}`,
    // The tree commander builds. Order is `PACK_SUBCOMMANDS`' order, which is the order
    // `cli/pack.ts`'s own usage block prints — the two are pinned to each other in cli/main.test.ts.
    subcommands: [
      packSubcommand("invite", "mint a single-use, 10-minute enrollment token (on the lead)", cmdPackInvite),
      packSubcommand("join", "join a pack: `pack join <lead-address>` (run on the joining machine)", cmdJoin),
      packSubcommand("leave", "leave the pack — drops the pack secret and every pin on this machine", (deps) =>
        cmdLeave(deps),
      ),
      packSubcommand("add", "install and enroll a peer over SSH: `pack add <ssh-host>` (on the lead)", cmdPackAdd, true),
      packSubcommand(
        "update",
        "level peers to this lead's build over SSH: `pack update <member>… | --all` (on the lead)",
        cmdPackUpdate,
        true,
      ),
      packSubcommand("status", "mode, members, reachability, secret pickup and why a link is refused", cmdPackStatus, true),
      packSubcommand("rotate", "reissue the pack secret and hand it to every reachable peer", (deps) =>
        cmdPackRotate(deps),
      ),
      packSubcommand("remove", "unpin and forget a member (on the lead)", cmdPackRemove),
      packSubcommand(
        "set-address",
        "correct where this lead dials a member: `pack set-address <member> <host:port>`",
        cmdPackSetAddress,
      ),
      packSubcommand(
        "deputy",
        "name the ONE peer that may take over and arm it over ssh: `pack deputy <member> | --revoke`",
        (deps, args) => cmdPackDeputy(deps, args),
      ),
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

/**
 * The two reflexes every operator has, spelled as the verbs they mean.
 *
 * `collie --version` used to print `error: unknown command \`--version\`` and the usage line — a verb
 * table where `version` exists and `--version` is a typo is a distinction only the implementer cares
 * about. `-V` is the long option's conventional short form; `-v` is left alone, because it is the one
 * a future `--verbose` would want and a flag that changed meaning later is worse than one that never
 * existed.
 *
 * Only the FIRST argument is rewritten. `collie logs --version` is an argument to `logs`, exactly as
 * every other flag reaching a verb is (`buildProgram` turns commander's own `-h` off for the same
 * reason), and this must not start guessing at it.
 */
export function normalizeArgv(argv: readonly string[]): readonly string[] {
  const first = argv[0];
  if (first === "--version" || first === "-V") return ["version", ...argv.slice(1)];
  return argv;
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
    await program.parseAsync(normalizeArgv(rest), { from: "user" });
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

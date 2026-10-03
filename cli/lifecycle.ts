import { join } from "node:path";

import type { Host } from "../bridge/host.ts";
import { ensureBuild } from "./build.ts";
import { collieVersion, type CliContext, type Environment, type EnvVars } from "./context.ts";
import { binaryLayout, publishedRoot } from "./install-kind.ts";
import { EXIT, type Io } from "./io.ts";
import type { LinkReader } from "./link.ts";
import { ensureMuxChosen } from "./mux.ts";
import type { StatusView, Ui } from "./render.ts";
import { cmdUnserve, crewModeOnDisk, type ServeDeps } from "./serve.ts";
import { type Exec, type Files, PROCESS_QUERY_SLOW_START_MS, type ProcessLookup, type ProcessRow } from "./sys.ts";
import {
  formatRestartMarker,
  isTaskBridge,
  isTaskLauncher,
  parseTaskRecord,
  queryTask,
  taskOwner,
  type TaskRecord,
  taskRecordPath,
  taskRestartPath,
} from "./task-scheduler.ts";
import { healthTimeoutMs } from "./update-run.ts";
import {
  bridgeUrl,
  configuredPublicUrl,
  dialableBridgeHost,
  localBridgeHostPort,
  localBridgeUrl,
  tailnetHosts,
} from "./tailnet.ts";
import {
  AGENT_FILE_MODE,
  agentFilePath,
  agentLabel,
  bridgeCommand,
  bakedTailscaleHosts,
  bridgeEnvironment,
  collieBinary,
  launchAgentPlist,
  logFileName,
  pidFileName,
  type ServiceSpec,
  serviceSpec,
  systemdUnit,
  taskFilePath,
  type TaskOptions,
  taskPercentPath,
  taskXml,
  unitFilePath,
  unitName,
} from "./unit.ts";

// `start`, `stop`, `restart`, `status`, `url`, `logs`, `_exec-bridge` — ported from
// scripts/collie-ctl.sh, translation not redesign. Where the shell's behaviour looks odd, the
// comment above it names the outage it prevents; those comments came along with the code.
//
// Everything reaches the world through the injected seams (cli/sys.ts), so the whole lifecycle is
// exercised in `bun test` without a service manager.

export interface LifecycleDeps extends ServeDeps {
  ctx: CliContext;
  io: Io;
  exec: Exec;
  files: Files;
  /** Readiness with the full ~5s budget. Injected so tests don't pay for it. */
  ready: (port: number, host: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /**
   * A clock in milliseconds that only moves forward. Absent: `performance.now`, which a change of the
   * system time does not move. Bounds the Windows restart's wait.
   */
  now?: () => number;
  uid: () => number;
  host: Host;
  /**
   * Reads `current` on a binary install, so the Windows task is registered on it (see
   * {@link taskServiceSpec}). Absent reads as "no `current`": the task then runs `ctx.root`, as a
   * checkout's does.
   */
  link?: LinkReader;
  /**
   * Publish the front door — `cmdServe` in production (wired in cli/main.ts). It stays a seam
   * because what `start` is asserted on here is its TOLERANCE of a front door that won't come up
   * (the pre-shim collie-ctl.sh), which has nothing to say about serve-status fixtures.
   * `uninstall`, whose relationship to `unserve` is the opposite — it aborts — calls it directly.
   *
   * The optional `io` mirrors `restart`'s: on the rich `crew add` path this whole call happens
   * INSIDE the restart bracket (`cmdRestart` → `cmdStart` → here), so the teardown/republish lines
   * `cmdServe` prints must land on the same held-chatter `Io` as the rest of that restart, not on
   * whatever `Io` this seam was originally built with. `start` passes its own `deps.io` — a no-op
   * off the rich path, since there `io` and `deps.io` are the same object.
   */
  serve: (io?: Io) => Promise<number>;
  /** The terminal renderer, when this run landed on one (`cli/render.ts`). Absent ⇒ plain lines. */
  ui?: Ui | null;
  /**
   * Whether there is a terminal to ask the first-run multiplexer question at (`cli/mux.ts`).
   *
   * Optional, and absent reads as "nobody is there" — the branch that refuses rather than the one
   * that asks. Every verb here but `start` ignores it.
   */
  interactive?: boolean;
  /** The free-text ask the first-run picker uses. `null` means nobody answered. */
  prompt?(question: string): string | null | Promise<string | null>;
}

export type Tier = "systemd" | "launchd" | "taskscheduler" | "unsupervised";

const TIERS: readonly Tier[] = ["systemd", "launchd", "taskscheduler", "unsupervised"];

/** `/run/user/<uid>`, and its bus socket when `withBus`. See {@link systemdUserReachable}. */
function derivedSessionEnv(uid: number, withBus: boolean): EnvVars {
  const runtimeDir: EnvVars = { XDG_RUNTIME_DIR: `/run/user/${uid}` };
  if (!withBus) return runtimeDir;
  return { ...runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
}

/**
 * Whether the systemd user manager is actually reachable — `systemctl --user show-environment`
 * succeeding, not merely `systemctl`/`systemd-run` existing on disk. A container commonly ships
 * the systemd package (so the binaries are on `PATH`) without ever running a user instance or
 * session bus, and `capture` fails distinctly from "not found": found, nonzero, `$DBUS_SESSION_BUS_
 * ADDRESS` unset. Exported so every caller that needs "can I actually ask systemd to do something"
 * — not just "is a binary present" — asks the same question the same way; `cli/update.ts`'s
 * `handOff` learned the difference the hard way, retrying a doomed `systemd-run` forever.
 *
 * `systemctl --user` locates the manager through `XDG_RUNTIME_DIR` (or `DBUS_SESSION_BUS_ADDRESS`)
 * in `env`. A Herdr plugin action injects neither (`HERDR_SOCKET_PATH` / `HERDR_PLUGIN_CONFIG_DIR`
 * and nothing else — no login shell), so a healthy host would fail this probe and read as
 * "unsupervised" on that spawn path alone (#194). When `env` lacks `XDG_RUNTIME_DIR`, a failed
 * first probe is retried once with a derived default (`/run/user/<uid>`, plus a derived
 * `DBUS_SESSION_BUS_ADDRESS` when that is ALSO unset) layered under the probe's own env via
 * {@link Exec.capture}'s `envAdd` — never into `process.env`, and never overriding a name `env`
 * already carries, so an operator's own value (or the `.env` workaround) still wins. The container
 * case is preserved: with no user manager at all, the retry fails too, and this still reports false.
 */
export function systemdUserReachable(exec: Exec, env: Environment = {}): boolean {
  const probe = exec.capture("systemctl", ["--user", "show-environment"]);
  if (probe.found && probe.code === 0) return true;
  if (env.XDG_RUNTIME_DIR !== undefined) return false;
  const uid = process.getuid?.() ?? 0;
  const envAdd =
    env.DBUS_SESSION_BUS_ADDRESS === undefined
      ? derivedSessionEnv(uid, true)
      : derivedSessionEnv(uid, false);
  const retried = exec.capture("systemctl", ["--user", "show-environment"], undefined, envAdd);
  return retried.found && retried.code === 0;
}

/**
 * Which supervisor runs the bridge. {@link systemdUserReachable} is the gate, because a container
 * or a machine with no user instance has the binary and no bus (the pre-shim collie-ctl.sh).
 * launchd is gated on Darwin too: its GUI and background user domains are Darwin-only.
 *
 * `COLLIE_SUPERVISOR` pins the answer. The shell had no such knob because its tests could redefine
 * `have_launchd` in a heredoc; a compiled binary cannot be monkey-patched, so without this the
 * launchd branch would be untestable anywhere but a Mac — i.e. never on CI, which is worse than the
 * knob. An unrecognised value is ignored rather than fatal: this decides where the bridge runs, and
 * a typo must not take the host down.
 *
 * Windows asks no systemd question at all: its supervisor is Task Scheduler, present on every
 * Windows install `schtasks.exe` is on.
 */
export function supervisionTier(
  exec: Exec,
  host: Host,
  env: Environment = {},
): Tier {
  const pinned = env.COLLIE_SUPERVISOR?.trim();
  const named = TIERS.find((tier) => tier === pinned);
  if (named !== undefined) return named;
  if (host.platform === "win32") return exec.which("schtasks") === null ? "unsupervised" : "taskscheduler";
  if (systemdUserReachable(exec, env)) return "systemd";
  if (host.platform === "darwin" && exec.which("launchctl") !== null) return "launchd";
  return "unsupervised";
}

const launchdDomain = (uid: number): string => `gui/${uid}`;
const launchdTarget = (uid: number, instance: string | null): string =>
  `gui/${uid}/${agentLabel(instance)}`;

// Both are per-instance, and both default to today's names. Two instances may legitimately share one
// config dir (the knob invents no dirs), so an unsuffixed `collie.pid` shared between them would have
// each `start` reading the other's pid.
export const pidFilePath = (configDir: string, instance: string | null = null): string =>
  join(configDir, pidFileName(instance));
export const logFilePath = (configDir: string, instance: string | null = null): string =>
  join(configDir, logFileName(instance));

// ── The pidfile guard ────────────────────────────────────────────────────────

/**
 * A binary install's own path names the version directory it runs from
 * (`<installRoot>/versions/<version>/bin/collie`), and that segment is exactly what a restart
 * changes: `pluginRoot()` resolves `ctx.root` from `process.execPath`, so the process carrying out
 * a post-flip restart names ITS OWN (new) version, never the prior one it needs to recognise as its
 * own bridge in order to stop it. Collapsing the version segment answers "same install" without
 * caring which version either side is — a checkout's binary has no such segment and is untouched.
 */
function collapseVersionDir(path: string): string {
  return path.replace(/\/versions\/[^/\s]+\//, "/");
}

/**
 * Is `commandLine` one of our own bridges? The pidfile outlives its process (SIGKILL, a panic, a
 * reboot) and pids get recycled, so a kill has to be justified by the process table — and this also
 * runs on `start`, where a wrong guess kills a bystander (the pre-shim collie-ctl.sh).
 *
 * The shell matched `bridge/index.ts`, the tail of its `ExecStart`. That string does not appear in
 * the compiled binary's command line, so the predicate moves in lockstep with `ExecStart`: the
 * program we launch, plus the role argument that distinguishes the daemon from a CLI invocation.
 *
 * The comparison runs on both sides with their version directory collapsed (see
 * {@link collapseVersionDir}), so a binary install's post-flip restart recognises the bridge it is
 * about to replace even though that bridge names a different version than this process does — the
 * one case `process.execPath`-derived paths never agree on, and a self-update wedges forever if this
 * predicate cannot see past it. Everything outside that one segment still has to match exactly, so a
 * bystander under a different install root is refused exactly as before.
 *
 * And, since two instances can run out of ONE checkout, plus the instance marker `bridgeCommand`
 * puts there. It is checked in both directions: a suffixed instance demands its own `--instance
 * <name>`, and the unsuffixed one demands the absence of any marker — otherwise the stable Collie's
 * `start` would look at v1's pidfile entry, recognise the shared binary path, and kill it.
 */
export function isOurBridge(
  commandLine: string,
  binary: string,
  instance: string | null = null,
): boolean {
  if (
    !collapseVersionDir(commandLine).includes(collapseVersionDir(binary)) ||
    !commandLine.includes("_exec-bridge")
  ) {
    return false;
  }
  return instance === null
    ? !/--instance(\s|=)/.test(commandLine)
    : new RegExp(`--instance(\\s+|=)${instance}(\\s|$)`).test(commandLine);
}

/**
 * Stop a bridge started by the unsupervised fallback and drop its pidfile. Also the migration path
 * for installs predating supervision, whose bridge still owns the port when a supervised one first
 * starts. The pidfile always goes, even when nothing was killed — otherwise a stale record is
 * re-examined on every future `start`.
 */
export function stopPidfileProcess(deps: LifecycleDeps): void {
  const pidFile = pidFilePath(deps.ctx.configDir, deps.ctx.instance);
  const raw = deps.files.read(pidFile);
  if (raw === null) return;
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    if (pid > 1) {
      const command = deps.exec.processCommand(pid);
      if (command !== null && isOurBridge(command, collieBinary(deps.ctx.root, deps.host), deps.ctx.instance)) {
        deps.exec.kill(pid);
      }
    }
  }
  deps.files.remove(pidFile);
}

// ── Writing the service definition ───────────────────────────────────────────

/**
 * The compiled binary is what the supervisor runs, so it has to exist before we write a unit
 * pointing at it — the direct analogue of the shell's "bun not found" guard, and the same
 * contract: say so, and exit non-zero, rather than installing a unit that can never start.
 */
function requireBinary(deps: LifecycleDeps): boolean {
  const binary = collieBinary(deps.ctx.root, deps.host);
  if (deps.files.exists(binary)) return true;
  deps.io.err(`error: no collie binary at ${binary} — build one with \`bun run build:cli\``);
  return false;
}

/**
 * The Host allowlist this machine answers on, for the unit and for the bridge's own environment.
 *
 * The bridge's Host gate fails closed, so an EMPTY allowlist is a lockout rather than a default —
 * which is what makes each branch here load-bearing:
 *
 *  - **The operator's own `COLLIE_TAILSCALE_HOSTS` wins and is never probed over.** They named it;
 *    a discovery that disagreed would silently overrule a deliberate value.
 *  - **`COLLIE_SKIP_SERVE=1` discovers nothing.** Variants C/E put the operator's own ingress in
 *    front, so the host they serve on is theirs to declare (`COLLIE_PUBLIC_HOSTS`); baking a
 *    MagicDNS name nothing answers on would be a guess dressed as configuration.
 *  - **A failed probe keeps what the unit already carried**, loudly. `tailscale status` fails for
 *    reasons that have nothing to do with this install, and that must not cost a working front door.
 *  - **With nothing to keep, it says the gate will refuse everything** and names the two settings
 *    that fix it. Silence here would read as a Collie that simply stopped working.
 */
export function resolveTailscaleHosts(deps: LifecycleDeps): string {
  const declared = deps.ctx.env.COLLIE_TAILSCALE_HOSTS?.trim();
  if (declared !== undefined && declared !== "") return declared;
  if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") return "";
  const found = tailnetHosts(deps.exec);
  if (found.length > 0) return found.join(",");
  const kept = bakedTailscaleHosts(
    deps.files.read(unitFilePath(deps.ctx.home, deps.ctx.instance)) ??
      deps.files.read(agentFilePath(deps.ctx.home, deps.ctx.instance)),
  );
  deps.io.err(
    "error: 'tailscale status' named no host for this node — the allowlist was not discovered.",
  );
  if (kept !== "") {
    deps.io.err(`       keeping the one already in the unit: ${kept}`);
    return kept;
  }
  deps.io.err("       no allowlist is set, so the Host gate will refuse every request. Set");
  deps.io.err(
    "       COLLIE_TAILSCALE_HOSTS (or COLLIE_PUBLIC_HOSTS) in .env, or fix Tailscale and retry.",
  );
  return "";
}

export function writeUnit(deps: LifecycleDeps): boolean {
  if (!requireBinary(deps)) return false;
  const spec = serviceSpec(deps.ctx, resolveTailscaleHosts(deps), deps.host);
  deps.files.mkdirp(deps.ctx.configDir);
  deps.files.write(unitFilePath(deps.ctx.home, deps.ctx.instance), systemdUnit(spec));
  deps.exec.capture("systemctl", ["--user", "daemon-reload"]);
  return true;
}

export function writeAgent(deps: LifecycleDeps): boolean {
  if (!requireBinary(deps)) return false;
  const spec = serviceSpec(deps.ctx, resolveTailscaleHosts(deps), deps.host);
  deps.files.mkdirp(deps.ctx.configDir);
  deps.files.write(
    agentFilePath(deps.ctx.home, deps.ctx.instance),
    launchAgentPlist(spec),
    AGENT_FILE_MODE,
  );
  return true;
}

// ── The tiers ────────────────────────────────────────────────────────────────

/**
 * The unsupervised tier: a background bridge with a pidfile, no restart-on-crash, nothing at login.
 * Reached two ways — a host with neither supervisor, and a Mac whose launchd bootstrap refused
 * (see {@link startLaunchd}). Both want the identical process, so it lives here rather than being
 * written twice and drifting.
 */
export function startUnsupervised(deps: LifecycleDeps): number {
  if (!requireBinary(deps)) return EXIT.FAIL;
  const spec = serviceSpec(deps.ctx, resolveTailscaleHosts(deps), deps.host);
  deps.files.mkdirp(deps.ctx.configDir);
  const pid = deps.exec.spawnDetached(bridgeCommand(spec), {
    cwd: deps.ctx.root,
    env: { ...stringEnv(deps.ctx.env), ...bridgeEnvironment(spec) },
    logPath: logFilePath(deps.ctx.configDir, deps.ctx.instance),
  });
  if (pid === null) {
    deps.io.err("error: could not start the bridge");
    return EXIT.FAIL;
  }
  deps.files.write(pidFilePath(deps.ctx.configDir, deps.ctx.instance), `${pid}\n`);
  deps.io.out(`bridge started (pid ${pid}, unsupervised)`);
  return EXIT.OK;
}

function startSystemd(deps: LifecycleDeps): number {
  if (!writeUnit(deps)) return EXIT.FAIL;
  const unit = unitName(deps.ctx.instance);
  const r = deps.exec.capture("systemctl", ["--user", "enable", "--now", unit]);
  if (!r.found || r.code !== 0) {
    if (r.stderr.trim() !== "") deps.io.err(r.stderr.trimEnd());
    deps.io.err(`error: systemctl --user enable --now ${unit} failed`);
    return EXIT.FAIL;
  }
  deps.io.out(`bridge started (systemd --user: ${unit})`);
  return EXIT.OK;
}

async function startLaunchd(deps: LifecycleDeps): Promise<number> {
  if (!writeAgent(deps)) return EXIT.FAIL;
  const uid = deps.uid();
  const target = launchdTarget(uid, deps.ctx.instance);
  // Release the port if this install predates launchd support. The old bridge drains async, so the
  // new one can still lose a race for the port — it exits nonzero and KeepAlive brings it back
  // after ThrottleInterval, so the migration self-heals; `start` may just warn once on the way.
  stopPidfileProcess(deps);
  // Bootout first so `start` is idempotent: bootstrap on a loaded label errors, and quietly running
  // a second bridge is the failure this branch removes. `enable` undoes a previous `stop`.
  deps.exec.capture("launchctl", ["bootout", target]);
  deps.exec.capture("launchctl", ["enable", target]);

  // `bootout` does not promise to wait for teardown, and the bridge drains connections before it
  // exits — bootstrapping into that window fails with "Bootstrap failed: 5: Input/output error",
  // which would end `start` with the bridge DOWN: the outage this branch exists to remove, on the
  // path (`restart`, and so `update`) an operator hits most. Retry across the window.
  const plist = agentFilePath(deps.ctx.home, deps.ctx.instance);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = deps.exec.capture("launchctl", ["bootstrap", launchdDomain(uid), plist]);
    if (r.found && r.code === 0) {
      deps.io.out(`bridge started (launchd: ${agentLabel(deps.ctx.instance)})`);
      return EXIT.OK;
    }
    if (attempt === 3) {
      // Out of retries. The likeliest cause is not a race at all: `gui/<uid>` exists only with a
      // console session, so a Mac administered purely over SSH has no domain to bootstrap into and
      // never will. Exiting here would leave that host with NO bridge — `stop` already killed the
      // unsupervised one on the way in — and 0.20.x served it fine. So degrade to the unsupervised
      // path instead: no restart-on-crash and nothing at login, but a running bridge, and `start`
      // after a console login upgrades it to the agent.
      deps.io.err("warn: launchctl bootstrap failed after 3 attempts — falling back to an unsupervised");
      deps.io.err(`      bridge. If this Mac has no console login, gui/${uid} does not exist; log in`);
      deps.io.err("      once and re-run start to get login-start and restart-on-failure.");
      return startUnsupervised(deps);
    }
    await deps.sleep(1000);
  }
  /* c8 ignore next */
  return EXIT.FAIL;
}

// ── Windows: Task Scheduler ──────────────────────────────────────────────────
//
// The task runs `collie _supervise` (cli/task-scheduler.ts), and the launcher runs the bridge and
// records both pids. What this tier owns that the other three do not is that record: ending the
// task kills its `conhost.exe` and nothing below it (Windows 11, 2026-10-02), so `stop` and `start`
// find the launcher and the bridge through the record, and kill each only when the process table
// says it is still this checkout's.

const taskName = (deps: LifecycleDeps): string => agentLabel(deps.ctx.instance);

/** The record's path, its text, and what that text says (null when it says nothing usable). */
interface TaskRecordRead {
  path: string;
  raw: string | null;
  record: TaskRecord | null;
}

function readTaskRecord(deps: LifecycleDeps): TaskRecordRead {
  const path = taskRecordPath(deps.ctx.configDir, deps.ctx.instance, deps.host);
  const raw = deps.files.read(path);
  return { path, raw, record: raw === null ? null : parseTaskRecord(raw) };
}

/**
 * The process table's answer for a recorded pid. PowerShell can take tens of seconds to start. Kept
 * as three answers: a table that did not answer is `unknown`, never "gone", so `stop` cannot report
 * a bridge stopped that it never saw.
 */
const recordedLookup = (deps: LifecycleDeps, pid: number): ProcessLookup =>
  pid > 1 ? deps.exec.processLookup(pid, PROCESS_QUERY_SLOW_START_MS) : { kind: "gone" };

/** What {@link stopTaskProcesses} found: whether a launcher was alive, or that the table did not answer. */
type TaskStop =
  | { readonly kind: "done"; readonly launcherAlive: boolean }
  | { readonly kind: "unreadable"; readonly why: string }
  /** Killed, and still there a moment later: Windows refused the kill (another account, or elevated). */
  | { readonly kind: "survived"; readonly rows: readonly ProcessRow[] };

/** The verb an operator typed that ends up stopping the bridge: the next step names it back. */
export type StopVerb = "stop" | "start" | "restart" | "uninstall";

/** `High Mandatory Level` (or System) in this process's token: an elevated shell. */
function isElevated(exec: Exec): boolean {
  const r = exec.capture("whoami", ["/groups"]);
  return r.found && r.code === 0 && /S-1-16-(12288|16384)\b/.test(r.stdout);
}

/**
 * The run level the task registers with: limited, unless the operator asked for `highest`.
 *
 * `highest` is an explicit opt-in for a host whose Herdr itself runs as Administrator, and every
 * action taken from the phone then inherits Administrator. So it is refused outside an elevated
 * shell, where the operator could not have meant it, and any other value is refused too: this knob
 * decides a privilege, so a typo fails closed, unlike `COLLIE_SUPERVISOR`'s. `null` means refused,
 * and the reason is printed.
 */
export function taskRunLevel(deps: LifecycleDeps): TaskOptions["runLevel"] | null {
  const raw = deps.ctx.env.COLLIE_TASK_RUN_LEVEL?.trim() ?? "";
  const asked = raw.toLowerCase();
  if (asked === "" || asked === "limited") return "LeastPrivilege";
  if (asked !== "highest") {
    deps.io.err(`error: COLLIE_TASK_RUN_LEVEL must be 'limited' or 'highest', not '${raw}'`);
    return null;
  }
  if (!isElevated(deps.exec)) {
    deps.io.err("error: COLLIE_TASK_RUN_LEVEL=highest needs an elevated (Administrator) shell");
    deps.io.err("       run this from one, or unset it to keep the task at limited privilege");
    return null;
  }
  return "HighestAvailable";
}

/**
 * The service the Windows task runs. On a binary install that is `<install-root>\current`, the
 * junction `collie update` moves, and never the version folder this process runs from: the task
 * outlives every update, and a task on a version folder relaunches the old version after the
 * `restart` an update ends with (M43 spec 05, the hard gate for spec 06). The launcher resolves the
 * junction again before every launch (`cmdSupervise`). A checkout keeps its own root, as before.
 */
export function taskServiceSpec(deps: LifecycleDeps, tailscaleHosts: string): ServiceSpec {
  const spec = serviceSpec(deps.ctx, tailscaleHosts, deps.host);
  if (deps.link === undefined) return spec;
  const root = publishedRoot(deps.ctx.root, deps.link, deps.host);
  return root === spec.root ? spec : { ...spec, root, binary: collieBinary(root, deps.host) };
}

/**
 * Write the task file and register it under the task name, replacing a task of that name. Replacing
 * is the adoption: a task the community script registered under `herdr.collie` becomes this one, and
 * a running instance of it keeps running (Windows 11, 2026-10-02), so registering never interrupts
 * the bridge. Prints its own reason on failure.
 */
function registerTask(deps: LifecycleDeps): boolean {
  if (!requireBinary(deps)) return false;
  const runLevel = taskRunLevel(deps);
  if (runLevel === null) return false;
  // One Collie per Windows machine. A task of this name that runs another install is that install's,
  // and registering over it would silently take its bridge away: refuse, and name it.
  const existing = queryTask(deps.exec, taskName(deps), deps.host);
  if (existing !== null && existing !== undefined && taskOwner(existing, deps.ctx.root, deps.host) === "foreign") {
    deps.io.err(`error: the task ${taskName(deps)} runs ${existing.program}, not this Collie (${deps.ctx.root})`);
    deps.io.err("       one Collie per Windows machine: run `collie uninstall` from that install first");
    return false;
  }
  const who = deps.exec.capture("whoami", []);
  const user = who.found && who.code === 0 ? who.stdout.trim() : "";
  if (user === "") {
    deps.io.err("error: `whoami` named no user, and the task starts at that user's logon");
    return false;
  }
  const spec = taskServiceSpec(deps, resolveTailscaleHosts(deps));
  const conhost = deps.exec.which("conhost");
  const percent = taskPercentPath(spec, conhost);
  if (percent !== null) {
    deps.io.err(
      `error: Collie cannot start from ${percent}, because that path has a % sign. Windows replaces %NAME% in a scheduled task's settings with the value of a variable, so the task would use the wrong path.`,
    );
    deps.io.err("       Move Collie, and its config folder, to a folder whose path has no % sign, for example C:\\collie. Then run: collie start");
    return false;
  }
  const file = taskFilePath(deps.ctx.configDir, deps.ctx.instance, deps.host);
  deps.files.mkdirp(deps.ctx.configDir);
  deps.files.write(file, taskXml(spec, { user, runLevel, conhost }));
  const name = taskName(deps);
  const r = deps.exec.capture("schtasks", ["/Create", "/TN", name, "/XML", file, "/F"]);
  if (r.found && r.code === 0) return true;
  const said = `${r.stdout}${r.stderr}`.trim();
  if (said !== "") deps.io.err(said);
  deps.io.err(`error: schtasks /Create /TN ${name} failed`);
  if (BATCH_LOGON_REFUSED.test(said)) {
    deps.io.err(`       Windows did not let ${user} log on to run a task: that account lacks the right "Log on as a batch job".`);
    deps.io.err("       An administrator grants it in Local Security Policy > Local Policies > User Rights Assignment >");
    deps.io.err(`       "Log on as a batch job", by adding ${user}. Then run: collie start`);
  }
  return false;
}

/** What Windows says when an account may not log on as a batch job: 0x80070569, in any language's text. */
const BATCH_LOGON_REFUSED = /0x80070569|not been granted the requested logon type/i;

/** The executables a launcher or bridge of either supervisor runs as. */
const TASK_PROCESS_NAMES = ["collie.exe", "bun.exe", "powershell.exe"] as const;

/** How long `stop` lets a just-killed launcher's last spawn settle before its final sweep. */
export const STOP_SETTLE_MS = 500;

/** A launcher of this install, Collie's own or the community script's. */
const isOurLauncher = (deps: LifecycleDeps, command: string): boolean =>
  isTaskLauncher(command, 2, deps.ctx.root, deps.ctx.instance, deps.host) ||
  isTaskLauncher(command, 1, deps.ctx.root, deps.ctx.instance, deps.host);

const isOurBridgeOnWindows = (deps: LifecycleDeps, command: string): boolean =>
  isTaskBridge(command, deps.ctx.root, deps.ctx.instance, deps.host);

/**
 * Stop the launcher and the bridge of this install, in the order that leaves nothing to relaunch:
 *
 *   1. the recorded LAUNCHER first, so its loop cannot start a bridge after we kill one;
 *   2. the record READ AGAIN, because the launcher may have written a fresh bridge pid between our
 *      first read and its death, then every recorded bridge (old and fresh);
 *   3. after {@link STOP_SETTLE_MS}, one sweep of the process table: any launcher or bridge of this
 *      checkout still there (a spawn that was in flight, a launcher the record never named) goes too.
 *
 * Every kill is justified by the process table, never by the record alone: pids are recycled. Either
 * launcher shape is accepted, so the community script's loop dies here too and cannot respawn. The
 * record does not carry start times: the command-line identity is the pid-reuse guard (a recycled pid
 * would have to be another `collie.exe _exec-bridge` of this same checkout to be killed).
 *
 * Answers whether a launcher was alive. When the process table does not answer, at any of the three
 * steps, it answers `unreadable` at once: what was not seen was not stopped, and the caller keeps the
 * record and says so.
 */
async function stopTaskProcesses(deps: LifecycleDeps, first: TaskRecord | null): Promise<TaskStop> {
  const killed = new Set<number>();
  const kill = (pid: number): void => {
    if (killed.has(pid)) return;
    killed.add(pid);
    deps.exec.kill(pid);
  };
  let launcherAlive = false;
  if (first !== null) {
    const launcher = recordedLookup(deps, first.launcher);
    if (launcher.kind === "unknown") return { kind: "unreadable", why: launcher.why };
    if (launcher.kind === "running" && isOurLauncher(deps, launcher.command)) {
      kill(first.launcher);
      launcherAlive = true;
    }
  }
  const again = readTaskRecord(deps).record;
  for (const pid of new Set([first?.bridge ?? 0, again?.bridge ?? 0])) {
    if (pid <= 1) continue;
    const bridge = recordedLookup(deps, pid);
    if (bridge.kind === "unknown") return { kind: "unreadable", why: bridge.why };
    if (bridge.kind === "running" && isOurBridgeOnWindows(deps, bridge.command)) kill(pid);
  }
  await deps.sleep(STOP_SETTLE_MS);
  const left = deps.exec.listProcesses(TASK_PROCESS_NAMES, PROCESS_QUERY_SLOW_START_MS);
  if (left === null) return { kind: "unreadable", why: "the process list did not answer" };
  for (const row of left) {
    if (isOurLauncher(deps, row.command)) {
      kill(row.pid);
      launcherAlive = true;
    }
  }
  for (const row of left) if (isOurBridgeOnWindows(deps, row.command)) kill(row.pid);
  // `kill` swallows every error, access denied included, so the table is read once more: a launcher
  // or bridge of this install that is still there was not stopped, whatever `kill` said.
  if (killed.size === 0) return { kind: "done", launcherAlive };
  await deps.sleep(STOP_SETTLE_MS);
  const after = deps.exec.listProcesses(TASK_PROCESS_NAMES, PROCESS_QUERY_SLOW_START_MS);
  if (after === null) return { kind: "unreadable", why: "the process list did not answer" };
  const rows = after.filter((row) => isOurLauncher(deps, row.command) || isOurBridgeOnWindows(deps, row.command));
  return rows.length > 0 ? { kind: "survived", rows } : { kind: "done", launcherAlive };
}

/** The executable name a process row runs: `collie.exe`, `bun.exe` or `powershell.exe`. */
function processName(command: string): string {
  const first = /^"([^"]+)"|^(\S+)/.exec(command.trim());
  const program = first?.[1] ?? first?.[2] ?? command;
  return program.split(/[\\/]/).at(-1) ?? program;
}

/**
 * `stop` could not see, or could not end, the processes it must stop. The record stays, so the next
 * try still knows which pids to look at, and the verb fails: "bridge stopped" would be a guess. The
 * next step names the verb the operator ran.
 */
function stopFailed(deps: LifecycleDeps, verb: StopVerb, stopped: Exclude<TaskStop, { kind: "done" }>): number {
  if (stopped.kind === "unreadable") {
    deps.io.err(`error: Collie could not read the list of running programs on this PC (${stopped.why}).`);
  } else {
    const named = stopped.rows.map((row) => `${processName(row.command)} (pid ${row.pid})`).join(", ");
    deps.io.err(`error: Windows did not let Collie stop ${named}. It may run as another account or as administrator.`);
  }
  deps.io.err(
    `       The bridge may still be running. Collie did not change its record. Close it in Task Manager, then run \`collie ${verb}\` again.`,
  );
  return EXIT.FAIL;
}

async function startTaskScheduler(deps: LifecycleDeps): Promise<number> {
  const name = taskName(deps);
  if (deps.ctx.instance !== null) {
    deps.io.err(`warn: one Collie per Windows machine is supported; instance ${deps.ctx.instance} gets its own task ${name}, untested`);
  }
  if (!registerTask(deps)) return EXIT.FAIL;
  deps.io.out(`Registered Task Scheduler job ${name} (starts at logon)`);
  // Release the port if this host ran the unsupervised fallback before, as launchd's start does.
  stopPidfileProcess(deps);
  // A launcher of ours that is already running stays: `/Run` on a running task does nothing, so
  // `start` is idempotent, as `systemctl enable --now` is. The community script's launcher is
  // replaced now, so from here on the record and both processes are Collie's own.
  const { path, record } = readTaskRecord(deps);
  if (record?.format === 1) {
    deps.exec.capture("schtasks", ["/End", "/TN", name]);
    const stopped = await stopTaskProcesses(deps, record);
    if (stopped.kind !== "done") return stopFailed(deps, "start", stopped);
    // Said only when there was a launcher to replace: a record left by a reboot names dead pids.
    if (stopped.launcherAlive) deps.io.out("replaced the contrib\\windows\\collie-ctl.ps1 launcher with Collie's own");
    deps.files.remove(path);
  }
  const r = deps.exec.capture("schtasks", ["/Run", "/TN", name]);
  if (!r.found || r.code !== 0) {
    const said = `${r.stdout}${r.stderr}`.trim();
    if (said !== "") deps.io.err(said);
    deps.io.err(`error: schtasks /Run /TN ${name} failed`);
    return EXIT.FAIL;
  }
  // `/Run` returns once the task is asked to run, not once a bridge answers: a launcher that cannot
  // start one (a broken build, a port in use) would otherwise read as a started Collie.
  const waited = await awaitTaskBridge(deps, false);
  if (!waited.answered) return taskBridgeSilent(deps, waited.waitS);
  deps.io.out(`bridge started (Task Scheduler: ${name})`);
  return EXIT.OK;
}

async function stopTaskScheduler(deps: LifecycleDeps, verb: StopVerb = "stop"): Promise<number> {
  const name = taskName(deps);
  // Disabled FIRST: an ended task is one logon, or one RestartOnFailure, from running again. Together
  // with `/End` this is systemd's `disable --now`. Both fail on a task that is not there, which is fine.
  deps.exec.capture("schtasks", ["/Change", "/TN", name, "/DISABLE"]);
  deps.exec.capture("schtasks", ["/End", "/TN", name]);
  const { path, raw, record } = readTaskRecord(deps);
  if (record === null && raw !== null) deps.io.err(`warn: ${path} names no process (${raw.trim()}); nothing in it was stopped`);
  const stopped = await stopTaskProcesses(deps, record);
  if (stopped.kind !== "done") return stopFailed(deps, verb, stopped);
  // The record goes now: it describes processes that are gone or were never ours.
  deps.files.remove(path);
  stopPidfileProcess(deps);
  return EXIT.OK;
}

function removeTaskScheduler(deps: LifecycleDeps): void {
  deps.exec.capture("schtasks", ["/Delete", "/TN", taskName(deps), "/F"]);
  deps.files.remove(taskFilePath(deps.ctx.configDir, deps.ctx.instance, deps.host));
  deps.files.remove(taskRecordPath(deps.ctx.configDir, deps.ctx.instance, deps.host));
}

/** `probe`'s answer, or `false` once `ms` have passed without one. */
async function within(probe: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([probe, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long `restart` lets a killed bridge go before it asks whether the new one answers. */
export const KILL_SETTLE_MS = 1_000;

/**
 * The process table did not answer, so nothing can be identified, and nothing is stopped. Its own
 * sentence: neither "not this checkout's bridge" nor "did not answer on the port" is true here.
 */
function tableUnreadable(deps: LifecycleDeps, why: string): number {
  deps.io.err(`error: could not read the Windows process table (${why}); nothing was stopped`);
  deps.io.err("       run `collie restart` again in a minute");
  return EXIT.FAIL;
}

/**
 * Restart the bridge the launcher supervises, by killing the bridge process ALONE and letting the
 * launcher's loop relaunch it from this install. Ending the task, or killing the launcher with its
 * tree, would end the phone's `collie update` with it: that update runs as a detached child of the
 * bridge and calls this restart half way through (#213 on macOS, PR 309 on Windows).
 *
 * `null` when there is no live launcher to lean on (no record, a stale one, a reboot without a
 * logon): the caller then takes `stop` + `start`, which registers the task and starts it. When the
 * launcher is the community script's, the task is registered again first, so its next logon runs
 * Collie's launcher and not a script this release deleted; the running loop keeps the bridge up.
 */
async function restartTaskScheduler(deps: LifecycleDeps): Promise<number | null> {
  const { path, raw, record } = readTaskRecord(deps);
  if (raw === null) return null;
  if (record === null) {
    // A torn or foreign record is no record: `stop` + `start` find the processes by the table.
    deps.io.err(`warn: ${path} names no process (${raw.trim()}); restarting through stop and start`);
    return null;
  }
  const { root, instance } = deps.ctx;
  // The launcher must be alive and this install's before anything is killed: it is what brings the
  // bridge back. A dead or foreign one sends the caller to `stop` + `start`, which registers the task
  // and starts it, so a stale record never leaves the machine with no bridge at all.
  const launcher = deps.exec.processLookup(record.launcher, PROCESS_QUERY_SLOW_START_MS);
  if (launcher.kind === "unknown") return tableUnreadable(deps, launcher.why);
  if (launcher.kind === "gone" || !isTaskLauncher(launcher.command, record.format, root, instance, deps.host)) return null;
  if (record.format === 1 && registerTask(deps)) {
    deps.io.out("the task now runs Collie's own launcher from the next logon; until then the old one keeps the bridge up");
  }

  // Said to the launcher before the kill: a killed bridge reads as a crash on Windows, and a crash
  // backs off. Written when no bridge is killed too, so a launcher in its pause relaunches now.
  const tellLauncher = (): void =>
    deps.files.write(taskRestartPath(deps.ctx.configDir, deps.ctx.instance, deps.host), formatRestartMarker(Date.now()));
  let settled = false;
  if (record.bridge > 1) {
    const bridge = deps.exec.processLookup(record.bridge, PROCESS_QUERY_SLOW_START_MS);
    if (bridge.kind === "unknown") return tableUnreadable(deps, bridge.why);
    if (bridge.kind === "running" && !isTaskBridge(bridge.command, root, instance, deps.host)) {
      deps.io.err(`error: the recorded bridge (pid ${record.bridge}) is not this checkout's bridge — not stopping it`);
      deps.io.err("       run `collie stop`, then `collie start`");
      return EXIT.FAIL;
    }
    tellLauncher();
    if (bridge.kind === "running") {
      deps.exec.kill(record.bridge);
      // The killed bridge can answer one more probe while Windows tears it down, and that answer
      // would be taken for the new bridge. This pause is the first second of the wait below.
      await deps.sleep(KILL_SETTLE_MS);
      settled = true;
      // A kill Windows refused (access denied: another account's process, or an elevated one) throws
      // nothing here, and the old bridge would go on answering the health wait below as if it were
      // the new one. So the pid is looked at again. A table that does not answer now says nothing new.
      const after = deps.exec.processLookup(record.bridge, PROCESS_QUERY_SLOW_START_MS);
      if (after.kind === "running" && isTaskBridge(after.command, root, instance, deps.host)) {
        deps.files.remove(taskRestartPath(deps.ctx.configDir, deps.ctx.instance, deps.host));
        deps.io.err(`error: Windows did not let Collie stop the old bridge, collie.exe (pid ${record.bridge}). It may run as another account or as administrator.`);
        deps.io.err(`       Close collie.exe (pid ${record.bridge}) in Task Manager, then run \`collie restart\` again.`);
        return EXIT.FAIL;
      }
      deps.io.out(`bridge stopped (pid ${record.bridge}); the Task Scheduler supervisor relaunches it`);
    } else {
      deps.io.out(`the recorded bridge (pid ${record.bridge}) has exited already; the Task Scheduler supervisor relaunches it`);
    }
  } else {
    // `0` is the loop between two launches: the next one already reads this install.
    tellLauncher();
    deps.io.out("the Task Scheduler supervisor is already relaunching the bridge");
  }

  // The loop waits a few seconds before it relaunches, and the bridge then has to come up. Say
  // whether it did, rather than printing a banner over a bridge that is still starting.
  const waited = await awaitTaskBridge(deps, settled);
  await printStatusBanner(deps);
  if (waited.answered) return EXIT.OK;
  // A FAILURE, because this tier waited and saw no bridge, which the other tiers cannot know. The
  // in-place update stops here instead of recording a `pass` and printing `✓ update complete` over a
  // dead bridge. The detached runner does not read this code: it polls its own health gate and rolls
  // back once whatever the restart returned (`driveApply` in `cli/update-run.ts`).
  return taskBridgeSilent(deps, waited.waitS);
}

/**
 * Wait for the bridge the task runs to answer, after a `/Run` or a restart's kill. The update health
 * gate's own budget, so a slow machine that raised `COLLIE_UPDATE_HEALTH_TIMEOUT_MS` is waited for
 * here too, and both call the same silence a failure. Bounded by the clock as well as by the count:
 * one `ready` probe is itself a poll of about five seconds, so thirty of them waited three minutes,
 * not thirty seconds (M43 spec 08 rehearsal: a broken update took 221 s to roll back). A kill's
 * pause (`settled`) counts as part of the wait.
 */
async function awaitTaskBridge(deps: LifecycleDeps, settled: boolean): Promise<{ answered: boolean; waitS: number }> {
  const waitS = Math.max(1, Math.ceil(healthTimeoutMs(deps.ctx.env) / 1000));
  const now = deps.now ?? ((): number => performance.now());
  const deadline = now() + waitS * 1000 - (settled ? KILL_SETTLE_MS : 0);
  let answered = false;
  for (let attempt = settled ? 1 : 0; attempt < waitS && !answered; attempt++) {
    try {
      // Each probe gets what is left of the budget and no more, so the worst case is the budget.
      answered = await within(deps.ready(deps.ctx.port, dialableBridgeHost(deps.ctx.env)), deadline - now());
    } catch {
      answered = false; // a probe that throws is a bridge that did not answer, not a crashed restart
    }
    if (answered || now() >= deadline) break;
    await deps.sleep(1000);
  }
  return { answered, waitS };
}

/** No bridge answered within the budget: say so loudly, with the two next steps, and fail. */
function taskBridgeSilent(deps: LifecycleDeps, waitS: number): number {
  deps.io.err(
    `error: Collie did not answer on ${localBridgeHostPort(deps.ctx.env, deps.ctx.port)} within ${waitS}s; it may still be starting`,
  );
  deps.io.err("       wait a minute, then run `collie status`. If it stays down, read why with:");
  deps.io.err("       collie logs");
  return EXIT.FAIL;
}

/**
 * The task's state as Task Scheduler names it (`Ready`, `Running`, `Disabled`), and whose launcher
 * runs: Collie's, the community script's loop still alive from before `collie start`, or a task that
 * still points at the old script, whose file this release deleted.
 */
function describeTaskScheduler(deps: LifecycleDeps): string {
  const name = taskName(deps);
  const head = `Task Scheduler (${name})`;
  const query = queryTask(deps.exec, name, deps.host);
  if (query === undefined) return `${head} · unknown`;
  if (query === null) {
    const pid = deps.files.read(pidFilePath(deps.ctx.configDir, deps.ctx.instance))?.trim();
    return pid !== undefined ? `pid ${pid} (unsupervised)` : `${head} · not registered`;
  }
  const status = `${head} · ${query.state}`;
  switch (taskOwner(query, deps.ctx.root, deps.host)) {
    case "legacy":
      return `${status} · Task ${name} still runs the old script. Run: collie restart`;
    case "foreign":
      return `${status} · runs another install: ${query.program}`;
    case "collie":
      return readTaskRecord(deps).record?.format === 1
        ? `${status} · launcher: the legacy collie-ctl.ps1 loop, until \`collie start\``
        : `${status} · launcher: Collie's`;
  }
}

// ── One interface, four supervisors ──────────────────────────────────────────

/**
 * A supervisor as every verb sees it. `start`, `stop`, `restart`, `uninstall`, `status` and `logs`
 * pick one with {@link serviceBackend} and call it, so a fifth supervisor is one more entry below and
 * no new branch in any verb.
 */
export interface ServiceBackend {
  /** Write the service definition and start it. Prints its own `bridge started (…)` line. */
  start(deps: LifecycleDeps): number | Promise<number>;
  /**
   * Stop the bridge, and keep it stopped across a login. A number other than `EXIT.OK` is a stop
   * that could not tell whether the bridge stopped; it printed its own reason.
   */
  stop(deps: LifecycleDeps, verb?: StopVerb): void | number | Promise<void | number>;
  /** After `stop`: remove the service definition and every record of it. */
  remove(deps: LifecycleDeps): void;
  /** The banner's `service` value. */
  describe(deps: LifecycleDeps): string;
  /** A restart of its own; `null` (or no method) takes `stop` then `start`. */
  restart?(deps: LifecycleDeps): Promise<number | null>;
  /** `collie logs` from the supervisor's own store (the journal); without it, the log file. */
  logs?(deps: LifecycleDeps, lines: number): number;
  /**
   * Whether `start` publishes the front door. Not on Windows, where Collie publishes no ingress
   * yet (M43 spec 09) and the community script never did.
   */
  readonly publishesFrontDoor: boolean;
}

const pidfileDescription = (deps: LifecycleDeps): string | undefined =>
  deps.files.read(pidFilePath(deps.ctx.configDir, deps.ctx.instance))?.trim();

const BACKENDS = {
  systemd: {
    start: startSystemd,
    stop(deps) {
      deps.exec.capture("systemctl", ["--user", "disable", "--now", unitName(deps.ctx.instance)]);
    },
    remove(deps) {
      deps.files.remove(unitFilePath(deps.ctx.home, deps.ctx.instance));
      deps.exec.capture("systemctl", ["--user", "daemon-reload"]);
      deps.exec.capture("systemctl", ["--user", "reset-failed", unitName(deps.ctx.instance)]);
    },
    describe(deps) {
      const unit = unitName(deps.ctx.instance);
      const r = deps.exec.capture("systemctl", ["--user", "is-active", unit]);
      const state = r.found && r.stdout.trim() !== "" ? r.stdout.trim() : "unknown";
      return `systemd --user (${unit}) · ${state}`;
    },
    logs(deps, lines) {
      const r = deps.exec.inherit("journalctl", [
        "--user",
        "-u",
        unitName(deps.ctx.instance),
        "-n",
        String(lines),
        "--no-pager",
      ]);
      if (!r.found) {
        deps.io.err("error: journalctl not found");
        return EXIT.FAIL;
      }
      return r.code === 0 ? EXIT.OK : EXIT.FAIL;
    },
    publishesFrontDoor: true,
  },
  launchd: {
    start: startLaunchd,
    stop(deps) {
      // bootout stops it now; `disable` is what makes that survive a login, since RunAtLoad would
      // otherwise bring it back. Together they are systemd's `disable --now`.
      const target = launchdTarget(deps.uid(), deps.ctx.instance);
      deps.exec.capture("launchctl", ["disable", target]);
      deps.exec.capture("launchctl", ["bootout", target]);
      stopPidfileProcess(deps);
    },
    remove(deps) {
      // Plist first: while it is on disk an enabled label is one login from loading again.
      deps.files.remove(agentFilePath(deps.ctx.home, deps.ctx.instance));
      // `stop`'s `disable` is a record in launchd's per-user database and outlives the plist, so clear
      // it or a reinstall inherits a disabled label. `enable` resets that state; it can't delete the row.
      deps.exec.capture("launchctl", ["enable", launchdTarget(deps.uid(), deps.ctx.instance)]);
    },
    describe(deps) {
      const pid = pidfileDescription(deps);
      const descriptions = launchdServiceDescriptions(deps);
      if (descriptions.length > 0) return descriptions.join("; ");
      // Neither domain has the agent, but the unsupervised fallback may still be serving.
      if (pid !== undefined) return `pid ${pid} (unsupervised — launchd bootstrap refused)`;
      return `launchd (${agentLabel(deps.ctx.instance)}) · not loaded`;
    },
    publishesFrontDoor: true,
  },
  taskscheduler: {
    start: startTaskScheduler,
    stop: stopTaskScheduler,
    remove: removeTaskScheduler,
    describe: describeTaskScheduler,
    restart: restartTaskScheduler,
    publishesFrontDoor: false,
  },
  unsupervised: {
    start: startUnsupervised,
    stop: stopPidfileProcess,
    remove() {
      // Nothing beyond the pidfile, which `uninstall` drops for every tier.
    },
    describe(deps) {
      const pid = pidfileDescription(deps);
      return pid !== undefined ? `pid ${pid} (unsupervised)` : "not supervised";
    },
    publishesFrontDoor: true,
  },
} satisfies Readonly<Record<Tier, ServiceBackend>>;

/** The supervisor this host runs the bridge under, per {@link supervisionTier}. */
export function serviceBackend(deps: LifecycleDeps): ServiceBackend {
  return BACKENDS[supervisionTier(deps.exec, deps.host, deps.ctx.env)];
}

// ── Verbs ────────────────────────────────────────────────────────────────────

export async function cmdStart(deps: LifecycleDeps): Promise<number> {
  // Which multiplexer, decided BEFORE anything is written or launched (M14/03). It returns
  // immediately when `COLLIE_MUX` is set, which is every run after the first; when it is not, this
  // is the one place the question gets asked, and a `start` that cannot answer it must not go on to
  // put a bridge in front of no panes at all.
  const chosen = await ensureMuxChosen(deps);
  if (chosen !== EXIT.OK) return chosen;

  // The lazy first build. It warns rather than fails: a host whose UI won't build still gets its
  // API, and the 503 is legible where a refused `start` is not.
  ensureBuild(deps);
  const backend = serviceBackend(deps);
  const started = await backend.start(deps);
  if (started !== EXIT.OK) return started;

  // A front door that won't come up must not abort `start`. The bridge is already running on
  // loopback, and the banner is what the README's troubleshooting flow tells people to read.
  // `serve` reports its own reason.
  if (!backend.publishesFrontDoor) {
    deps.io.out(
      `note: Collie publishes no front door here; the bridge is on ${localBridgeHostPort(deps.ctx.env, deps.ctx.port)}`,
    );
  } else if ((await deps.serve(deps.io)) !== EXIT.OK) {
    deps.io.err(
      `note: the tailnet front door did not come up; the bridge is still on ${localBridgeHostPort(deps.ctx.env, deps.ctx.port)}`,
    );
  }
  await printStatusBanner(deps);
  return EXIT.OK;
}

export async function cmdStop(deps: LifecycleDeps, verb: StopVerb = "stop"): Promise<number> {
  const stopped = await serviceBackend(deps).stop(deps, verb);
  if (stopped !== undefined && stopped !== EXIT.OK) return stopped;
  deps.io.out("bridge stopped");
  return EXIT.OK;
}

/**
 * The inverse of `start`, and NO MORE (the pre-shim collie-ctl.sh): stop + disable the service,
 * remove the service definition, remove Collie's own tailscale serve mapping, drop the pidfile.
 *
 * It deliberately keeps `${CONFIG_DIR}/.env` and the checkout — an operator uninstalling the
 * service has not asked to lose their config, and the closing summary says so. To remove the plugin
 * registration too, `herdr plugin uninstall herdr.collie` (or delete a linked clone's checkout).
 *
 * `unserve` failing ABORTS: it failed by refusing to touch a mapping it could not prove is ours, and
 * carrying on would report a clean uninstall over a front door that is still published.
 */
export async function cmdUninstall(deps: LifecycleDeps): Promise<number> {
  const stopped = await cmdStop(deps, "uninstall");
  if (stopped !== EXIT.OK) return stopped;
  const unserved = cmdUnserve(deps);
  if (unserved !== EXIT.OK) return unserved;

  serviceBackend(deps).remove(deps);
  deps.files.remove(pidFilePath(deps.ctx.configDir, deps.ctx.instance));
  deps.io.out(
    "✓ uninstalled: service stopped & disabled, service definition removed, Collie's tailscale serve mapping removed",
  );
  deps.io.out(
    `  kept: ${join(deps.ctx.configDir, ".env")} and the checkout — delete those to remove every trace`,
  );
  for (const line of windowsBinaryRemoval(deps)) deps.io.out(line);
  return EXIT.OK;
}

/**
 * A Windows binary install (`scripts/install.ps1`) keeps its folder and its user PATH entry after
 * `uninstall`, as every install keeps its files. These lines say how to remove both, and are printed
 * there only: anywhere else the list is empty, so the Linux and macOS output stays as it was.
 *
 * The folder goes with `rmdir /s`, which removes the `current` junction by itself and never walks
 * through it. The PATH entry goes through the registry, so the value keeps its type
 * (REG_EXPAND_SZ) and every other entry byte for byte; `[Environment]::SetEnvironmentVariable`
 * would store REG_SZ and expand the rest.
 */
export function windowsBinaryRemoval(deps: Pick<LifecycleDeps, "ctx" | "host" | "link">): string[] {
  if (deps.host.platform !== "win32" || deps.link === undefined) return [];
  if (publishedRoot(deps.ctx.root, deps.link, deps.host) === deps.ctx.root) return [];
  const installRoot = binaryLayout(deps.ctx.root, deps.host).installRoot;
  const bin = deps.host.path.join(installRoot, "current", "bin");
  const quoted = bin.replaceAll("'", "''");
  return [
    "  To remove Collie itself too, run these two lines in PowerShell:",
    `    cmd /c rmdir /s /q "${installRoot}"`,
    `    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', (($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_.TrimEnd('\\') -ne '${quoted}' }) -join ';'), $k.GetValueKind('Path')); $k.Close()`,
  ];
}

export async function cmdRestart(deps: LifecycleDeps): Promise<number> {
  // The multiplexer question is asked BEFORE anything is stopped, and it is the whole reason this
  // verb is not `cmdStop` + `cmdStart`. `start` asks it too, and on every run after the first both
  // calls return at once on an explicit `COLLIE_MUX`. It is the FIRST run that matters: a refusal
  // reached from inside `start` arrives after `stop` has already disabled the unit, so an operator
  // who cannot answer it right now is left with no bridge at all, on a verb whose name promises one.
  const chosen = await ensureMuxChosen(deps);
  if (chosen !== EXIT.OK) return chosen;

  // A supervisor with a restart of its own (Task Scheduler: kill the bridge, let the launcher bring
  // it back) answers first; `null` means it has nothing to lean on, and `stop` + `start` follow.
  const own = await serviceBackend(deps).restart?.(deps);
  if (own !== undefined && own !== null) return own;

  const stopped = await cmdStop(deps, "restart");
  if (stopped !== EXIT.OK) return stopped;
  return cmdStart(deps);
}

export async function cmdStatus(deps: LifecycleDeps): Promise<number> {
  await printStatusBanner(deps);
  if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") {
    deps.io.out("  serve config: skipped (COLLIE_SKIP_SERVE=1)");
    return EXIT.OK;
  }
  deps.io.out("  serve config:");
  const r = deps.exec.capture("tailscale", ["serve", "status"]);
  if (r.found && r.code === 0) {
    for (const line of r.stdout.replace(/\n$/, "").split("\n")) {
      if (line !== "") deps.io.out(`    ${line}`);
    }
  }
  return EXIT.OK;
}

export function cmdUrl(deps: LifecycleDeps): number {
  deps.io.out(bridgeUrl(deps.exec, deps.ctx));
  return EXIT.OK;
}

/** `logs [n]` — the journal under systemd, the log file every other supervisor appends to. */
export function cmdLogs(deps: LifecycleDeps, args: readonly string[]): number {
  const raw = args[0];
  const lines = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 50;
  const own = serviceBackend(deps).logs?.(deps, lines);
  if (own !== undefined) return own;
  // The shell shelled out to `tail`; reading the file is the same answer with one fewer tool on
  // the runtime path.
  const text = deps.files.read(logFilePath(deps.ctx.configDir, deps.ctx.instance));
  if (text === null) {
    deps.io.out("(no log)");
    return EXIT.OK;
  }
  const all = text.replace(/\n$/, "").split("\n");
  for (const line of all.slice(Math.max(0, all.length - lines))) deps.io.out(line);
  return EXIT.OK;
}

/**
 * The process the supervisor watches. The shell `exec`'d Bun here, because launchd watches the pid
 * it spawned — a wrapper would make `KeepAlive` guard the wrapper and a crashed bridge look alive
 * (the pre-shim collie-ctl.sh). In the binary that means the bridge runs IN THIS PROCESS after
 * argv dispatch: no child, nothing to outlive it.
 *
 * The plist carries paths only, so the merged `.env` is applied here — this is where a
 * `COLLIE_VAPID_PRIVATE` in the mode-600 file reaches the bridge.
 */
export async function cmdExecBridge(deps: LifecycleDeps): Promise<number> {
  // Discovered here as well as at write time: an unsupervised or hand-written unit carries no baked
  // allowlist, and a MagicDNS name can change under a unit that was written months ago.
  const spec = serviceSpec(deps.ctx, resolveTailscaleHosts(deps), deps.host);
  const env = { ...stringEnv(deps.ctx.env), ...bridgeEnvironment(spec) };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  await import("../bridge/index.ts");
  return EXIT.OK;
}

// ── The banner ───────────────────────────────────────────────────────────────

/** Discover both domains without adopting an agent another service manager owns. */
function launchdServiceDescriptions(deps: LifecycleDeps): string[] {
  const uid = deps.uid();
  const label = agentLabel(deps.ctx.instance);
  const descriptions: string[] = [];
  for (const domain of ["gui", "user"]) {
    const target = `${domain}/${uid}/${label}`;
    const result = deps.exec.capture("launchctl", ["print", target]);
    if (!result.found || result.code !== 0 || result.stdout.trim() === "") continue;
    // A loaded-but-stopped agent has no pid line. Report both registrations if both exist,
    // rather than hiding a background service behind a stopped GUI agent after a migration.
    const pid = /^[ \t]*pid = (\d+)/m.exec(result.stdout)?.[1];
    const state = pid === undefined ? "loaded, not running" : `active (pid ${pid})`;
    descriptions.push(`launchd (${target}) · ${state}`);
  }
  return descriptions;
}

/** How the bridge is supervised right now, as the banner's `service` line says it. */
export function serviceDescription(deps: LifecycleDeps): string {
  return serviceBackend(deps).describe(deps);
}

/**
 * One scannable "is Collie up?" summary — readiness, how it's supervised, and both URLs. Shared by
 * `start` (post-launch confirmation) and `status` (on demand) so the two can never disagree.
 */
export async function statusBanner(deps: LifecycleDeps): Promise<string[]> {
  return bannerLines(await statusView(deps));
}

/**
 * The banner as a value: one verdict and a label/value block. Both renderings read this — the plain
 * lines below, and the boxed terminal view in `cli/ui/` — so "is it up", the instance, the service
 * and the URLs can never say two different things depending on where you looked.
 */
export async function statusView(deps: LifecycleDeps): Promise<StatusView> {
  const version = collieVersion(deps.ctx.root);
  // The bridge does not always bind loopback (a peer sets COLLIE_HOST to its tailnet address — the
  // documented Variant-E shape). Probing 127.0.0.1 there would find nothing home and print "isn't
  // answering" against a bridge that is in fact up; probe — and, in the warning, name — whatever
  // address it actually bound.
  //
  // Resolved ONCE, through F13's `dialableBridgeHost`, which is also what the `local` row three
  // lines down reads: the two halves of this banner must never name two different addresses, and a
  // WILDCARD bind has to probe loopback rather than the literal `0.0.0.0` the operator wrote.
  //
  // It reads the env as it stands NOW. `collie leave` rewrites COLLIE_HOST out of both the `.env`
  // and this process's env before it restarts (F12/F22), so the banner that closes a tear-down
  // describes the machine the tear-down left behind — not the peer it used to be.
  const host = dialableBridgeHost(deps.ctx.env);
  const probedAddress = host === "127.0.0.1" ? `:${deps.ctx.port}` : `${host}:${deps.ctx.port}`;
  const running = await deps.ready(deps.ctx.port, host);
  const rows: { label: string; value: string }[] = [];
  // Only a suffixed instance says so — a solo host's banner is unchanged, and on a host running two
  // this is the line that says WHICH Collie answered (the unit name on the next line agrees).
  if (deps.ctx.instance !== null) rows.push({ label: "instance", value: deps.ctx.instance });
  rows.push({ label: "service", value: serviceDescription(deps) });
  // F13: the address the bridge BOUND, not a hardcoded loopback string — see `localBridgeUrl`.
  rows.push({ label: "local", value: localBridgeUrl(deps.ctx.env, deps.ctx.port) });
  // The front-door row, and the one machine that has no front door to describe. A PEER publishes
  // none (ADR 0013) — `cmdServe` refuses the publish and says so — so a `tailnet` row here was a row
  // about a door that is not there, offering a loopback URL that is not even a peer's bind (the
  // `local` row above says what is). Asked of the same function that takes the publish decision, so
  // the banner and the refusal can never disagree. The crew's door is named instead, because "where
  // do I point my phone?" still has an answer on a peer: the lead's (F24).
  if (crewModeOnDisk(deps) === "peer") {
    rows.push({ label: "crew", value: "peer — no front door here; the lead's door serves the crew (ADR 0013)" });
  } else if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") {
    const url = configuredPublicUrl(deps.ctx.env);
    rows.push({
      label: "proxy",
      value: url ?? "(COLLIE_SKIP_SERVE=1 — set COLLIE_PUBLIC_URL to your reverse-proxy URL)",
    });
  } else {
    rows.push({ label: "tailnet", value: bridgeUrl(deps.exec, deps.ctx) });
  }
  return {
    running,
    headline: running
      ? `✓ Collie is running  ·  v${version}`
      : `⚠ Collie isn't answering on ${probedAddress} yet (v${version}) — check 'collie logs'`,
    rows,
  };
}

/**
 * The plain banner, byte for byte what it has always been: a blank line, the verdict indented two,
 * each row indented four with its label padded to ten, a blank line. Pinned in
 * `cli/lifecycle.test.ts` and grepped by `scripts/collie-cli.test.sh`.
 */
export function bannerLines(view: StatusView): string[] {
  return [
    "",
    `  ${view.headline}`,
    ...view.rows.map((r) => `    ${r.label.padEnd(10)}${r.value}`),
    "",
  ];
}

async function printStatusBanner(deps: LifecycleDeps): Promise<void> {
  const view = await statusView(deps);
  if (deps.ui != null) {
    await deps.ui.status(view);
    return;
  }
  for (const line of bannerLines(view)) deps.io.out(line);
}

function stringEnv(env: Environment): EnvVars {
  const out: EnvVars = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

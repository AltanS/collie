import { join } from "node:path";

import { collieVersion, type CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { cmdUnserve, type ServeDeps } from "./serve.ts";
import type { Exec, Files } from "./sys.ts";
import { bridgeUrl } from "./tailnet.ts";
import {
  AGENT_FILE_MODE,
  AGENT_LABEL,
  agentFilePath,
  bridgeCommand,
  bridgeEnvironment,
  collieBinary,
  launchAgentPlist,
  serviceSpec,
  systemdUnit,
  UNIT_NAME,
  unitFilePath,
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
  ready: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  uid: () => number;
  platform: NodeJS.Platform;
  /**
   * Publish the front door — `cmdServe` in production (wired in cli/main.ts). It stays a seam
   * because what `start` is asserted on here is its TOLERANCE of a front door that won't come up
   * (scripts/collie-ctl.sh:431-434), which has nothing to say about serve-status fixtures.
   * `uninstall`, whose relationship to `unserve` is the opposite — it aborts — calls it directly.
   */
  serve: () => Promise<number>;
}

export type Tier = "systemd" | "launchd" | "unsupervised";

const TIERS: readonly Tier[] = ["systemd", "launchd", "unsupervised"];

/**
 * Which supervisor runs the bridge. `systemctl --user show-environment` succeeding — not merely
 * `systemctl` existing — is the gate, because a container or a machine with no user instance has
 * the binary and no bus (scripts/collie-ctl.sh:100). launchd is gated on Darwin too: the
 * `gui/<uid>` domain is Darwin-only.
 *
 * `COLLIE_SUPERVISOR` pins the answer. The shell had no such knob because its tests could redefine
 * `have_launchd` in a heredoc; a compiled binary cannot be monkey-patched, so without this the
 * launchd branch would be untestable anywhere but a Mac — i.e. never on CI, which is worse than the
 * knob. An unrecognised value is ignored rather than fatal: this decides where the bridge runs, and
 * a typo must not take the host down.
 */
export function supervisionTier(
  exec: Exec,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): Tier {
  const pinned = env.COLLIE_SUPERVISOR?.trim();
  if (pinned !== undefined && TIERS.includes(pinned as Tier)) return pinned as Tier;
  const probe = exec.capture("systemctl", ["--user", "show-environment"]);
  if (probe.found && probe.code === 0) return "systemd";
  if (platform === "darwin" && exec.which("launchctl") !== null) return "launchd";
  return "unsupervised";
}

const launchdDomain = (uid: number): string => `gui/${uid}`;
const launchdTarget = (uid: number): string => `gui/${uid}/${AGENT_LABEL}`;

export const pidFilePath = (configDir: string): string => join(configDir, "collie.pid");
export const logFilePath = (configDir: string): string => join(configDir, "collie.log");

// ── The pidfile guard ────────────────────────────────────────────────────────

/**
 * Is `commandLine` one of our own bridges? The pidfile outlives its process (SIGKILL, a panic, a
 * reboot) and pids get recycled, so a kill has to be justified by the process table — and this also
 * runs on `start`, where a wrong guess kills a bystander (scripts/collie-ctl.sh:118-122).
 *
 * The shell matched `bridge/index.ts`, the tail of its `ExecStart`. That string does not appear in
 * the compiled binary's command line, so the predicate moves in lockstep with `ExecStart`: the
 * program we launch, plus the role argument that distinguishes the daemon from a CLI invocation.
 */
export function isOurBridge(commandLine: string, binary: string): boolean {
  return commandLine.includes(binary) && commandLine.includes("_exec-bridge");
}

/**
 * Stop a bridge started by the unsupervised fallback and drop its pidfile. Also the migration path
 * for installs predating supervision, whose bridge still owns the port when a supervised one first
 * starts. The pidfile always goes, even when nothing was killed — otherwise a stale record is
 * re-examined on every future `start`.
 */
export function stopPidfileProcess(deps: LifecycleDeps): void {
  const pidFile = pidFilePath(deps.ctx.configDir);
  const raw = deps.files.read(pidFile);
  if (raw === null) return;
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    if (pid > 1) {
      const command = deps.exec.processCommand(pid);
      if (command !== null && isOurBridge(command, collieBinary(deps.ctx.root))) {
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
  const binary = collieBinary(deps.ctx.root);
  if (deps.files.exists(binary)) return true;
  deps.io.err(`error: no collie binary at ${binary} — build one with \`bun run build:cli\``);
  return false;
}

export function writeUnit(deps: LifecycleDeps): boolean {
  if (!requireBinary(deps)) return false;
  const spec = serviceSpec(deps.ctx);
  deps.files.mkdirp(deps.ctx.configDir);
  deps.files.write(unitFilePath(deps.ctx.home), systemdUnit(spec));
  deps.exec.capture("systemctl", ["--user", "daemon-reload"]);
  return true;
}

export function writeAgent(deps: LifecycleDeps): boolean {
  if (!requireBinary(deps)) return false;
  const spec = serviceSpec(deps.ctx);
  deps.files.mkdirp(deps.ctx.configDir);
  deps.files.write(agentFilePath(deps.ctx.home), launchAgentPlist(spec), AGENT_FILE_MODE);
  return true;
}

// ── The three tiers ──────────────────────────────────────────────────────────

/**
 * The unsupervised tier: a background bridge with a pidfile, no restart-on-crash, nothing at login.
 * Reached two ways — a host with neither supervisor, and a Mac whose launchd bootstrap refused
 * (see {@link startLaunchd}). Both want the identical process, so it lives here rather than being
 * written twice and drifting.
 */
export function startUnsupervised(deps: LifecycleDeps): number {
  if (!requireBinary(deps)) return EXIT.FAIL;
  const spec = serviceSpec(deps.ctx);
  deps.files.mkdirp(deps.ctx.configDir);
  const pid = deps.exec.spawnDetached(bridgeCommand(spec), {
    cwd: deps.ctx.root,
    env: { ...stringEnv(deps.ctx.env), ...bridgeEnvironment(spec) },
    logPath: logFilePath(deps.ctx.configDir),
  });
  if (pid === null) {
    deps.io.err("error: could not start the bridge");
    return EXIT.FAIL;
  }
  deps.files.write(pidFilePath(deps.ctx.configDir), `${pid}\n`);
  deps.io.out(`bridge started (pid ${pid}, unsupervised)`);
  return EXIT.OK;
}

function startSystemd(deps: LifecycleDeps): number {
  if (!writeUnit(deps)) return EXIT.FAIL;
  const r = deps.exec.capture("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
  if (!r.found || r.code !== 0) {
    if (r.stderr.trim() !== "") deps.io.err(r.stderr.trimEnd());
    deps.io.err(`error: systemctl --user enable --now ${UNIT_NAME} failed`);
    return EXIT.FAIL;
  }
  deps.io.out(`bridge started (systemd --user: ${UNIT_NAME})`);
  return EXIT.OK;
}

async function startLaunchd(deps: LifecycleDeps): Promise<number> {
  if (!writeAgent(deps)) return EXIT.FAIL;
  const uid = deps.uid();
  const target = launchdTarget(uid);
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
  const plist = agentFilePath(deps.ctx.home);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = deps.exec.capture("launchctl", ["bootstrap", launchdDomain(uid), plist]);
    if (r.found && r.code === 0) {
      deps.io.out(`bridge started (launchd: ${AGENT_LABEL})`);
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

// ── Verbs ────────────────────────────────────────────────────────────────────

export async function cmdStart(deps: LifecycleDeps): Promise<number> {
  warnIfUnbuilt(deps);
  const tier = supervisionTier(deps.exec, deps.platform, deps.ctx.env);
  const started =
    tier === "systemd"
      ? startSystemd(deps)
      : tier === "launchd"
        ? await startLaunchd(deps)
        : startUnsupervised(deps);
  if (started !== EXIT.OK) return started;

  // A front door that won't come up must not abort `start`. The bridge is already running on
  // loopback, and the banner is what the README's troubleshooting flow tells people to read.
  // `serve` reports its own reason.
  if ((await deps.serve()) !== EXIT.OK) {
    deps.io.err(
      `note: the tailnet front door did not come up; the bridge is still on 127.0.0.1:${deps.ctx.port}`,
    );
  }
  await printStatusBanner(deps);
  return EXIT.OK;
}

export function cmdStop(deps: LifecycleDeps): number {
  const tier = supervisionTier(deps.exec, deps.platform, deps.ctx.env);
  if (tier === "systemd") {
    deps.exec.capture("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
  } else if (tier === "launchd") {
    // bootout stops it now; `disable` is what makes that survive a login, since RunAtLoad would
    // otherwise bring it back. Together they are systemd's `disable --now`.
    const target = launchdTarget(deps.uid());
    deps.exec.capture("launchctl", ["disable", target]);
    deps.exec.capture("launchctl", ["bootout", target]);
    stopPidfileProcess(deps);
  } else {
    stopPidfileProcess(deps);
  }
  deps.io.out("bridge stopped");
  return EXIT.OK;
}

/**
 * The inverse of `start`, and NO MORE (scripts/collie-ctl.sh:455-477): stop + disable the service,
 * remove the service definition, remove Collie's own tailscale serve mapping, drop the pidfile.
 *
 * It deliberately keeps `${CONFIG_DIR}/.env` and the checkout — an operator uninstalling the
 * service has not asked to lose their config, and the closing summary says so. To remove the plugin
 * registration too, `herdr plugin uninstall herdr.collie` (or delete a linked clone's checkout).
 *
 * `unserve` failing ABORTS: it failed by refusing to touch a mapping it could not prove is ours, and
 * carrying on would report a clean uninstall over a front door that is still published.
 */
export function cmdUninstall(deps: LifecycleDeps): number {
  const stopped = cmdStop(deps);
  if (stopped !== EXIT.OK) return stopped;
  const unserved = cmdUnserve(deps);
  if (unserved !== EXIT.OK) return unserved;

  const tier = supervisionTier(deps.exec, deps.platform, deps.ctx.env);
  if (tier === "systemd") {
    deps.files.remove(unitFilePath(deps.ctx.home));
    deps.exec.capture("systemctl", ["--user", "daemon-reload"]);
    deps.exec.capture("systemctl", ["--user", "reset-failed", UNIT_NAME]);
  } else if (tier === "launchd") {
    // Plist first: while it is on disk an enabled label is one login from loading again.
    deps.files.remove(agentFilePath(deps.ctx.home));
    // `stop`'s `disable` is a record in launchd's per-user database and outlives the plist, so clear
    // it or a reinstall inherits a disabled label. `enable` resets that state; it can't delete the row.
    deps.exec.capture("launchctl", ["enable", launchdTarget(deps.uid())]);
  }
  deps.files.remove(pidFilePath(deps.ctx.configDir));
  deps.io.out(
    "✓ uninstalled: service stopped & disabled, service definition removed, Collie's tailscale serve mapping removed",
  );
  deps.io.out(
    `  kept: ${join(deps.ctx.configDir, ".env")} and the checkout — delete those to remove every trace`,
  );
  return EXIT.OK;
}

export async function cmdRestart(deps: LifecycleDeps): Promise<number> {
  const stopped = cmdStop(deps);
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
  deps.io.out(bridgeUrl(deps.exec, deps.ctx.serveMode, deps.ctx.port));
  return EXIT.OK;
}

/** `logs [n]` — the journal under systemd, the unsupervised log file otherwise. */
export function cmdLogs(deps: LifecycleDeps, args: readonly string[]): number {
  const raw = args[0];
  const lines = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 50;
  if (supervisionTier(deps.exec, deps.platform, deps.ctx.env) === "systemd") {
    const r = deps.exec.inherit("journalctl", [
      "--user",
      "-u",
      UNIT_NAME,
      "-n",
      String(lines),
      "--no-pager",
    ]);
    if (!r.found) {
      deps.io.err("error: journalctl not found");
      return EXIT.FAIL;
    }
    return r.code === 0 ? EXIT.OK : EXIT.FAIL;
  }
  // The shell shelled out to `tail`; reading the file is the same answer with one fewer tool on
  // the runtime path.
  const text = deps.files.read(logFilePath(deps.ctx.configDir));
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
 * (scripts/collie-ctl.sh:362-364). In the binary that means the bridge runs IN THIS PROCESS after
 * argv dispatch: no child, nothing to outlive it.
 *
 * The plist carries paths only, so the merged `.env` is applied here — this is where a
 * `COLLIE_VAPID_PRIVATE` in the mode-600 file reaches the bridge.
 */
export async function cmdExecBridge(deps: LifecycleDeps): Promise<number> {
  const env = { ...stringEnv(deps.ctx.env), ...bridgeEnvironment(serviceSpec(deps.ctx)) };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  await import("../bridge/index.ts");
  return EXIT.OK;
}

// ── The banner ───────────────────────────────────────────────────────────────

/** How the bridge is supervised right now, as the banner's `service` line says it. */
export function serviceDescription(deps: LifecycleDeps): string {
  const tier = supervisionTier(deps.exec, deps.platform, deps.ctx.env);
  if (tier === "systemd") {
    const r = deps.exec.capture("systemctl", ["--user", "is-active", UNIT_NAME]);
    const state = r.found && r.stdout.trim() !== "" ? r.stdout.trim() : "unknown";
    return `systemd --user (${UNIT_NAME}) · ${state}`;
  }
  const pid = deps.files.read(pidFilePath(deps.ctx.configDir))?.trim();
  if (tier === "launchd") {
    // `launchctl print` fails when the label isn't loaded; a loaded-but-stopped job has no pid line.
    const r = deps.exec.capture("launchctl", ["print", launchdTarget(deps.uid())]);
    const out = r.found && r.code === 0 ? r.stdout : "";
    if (out.trim() === "") {
      // No agent — but this Mac may be on the unsupervised fallback (bootstrap refused, e.g. no
      // console login), where a bridge really is running and only supervision is missing. Reporting
      // a bare "not loaded" there would read as "nothing is up" while the phone is being served.
      if (pid !== undefined) return `pid ${pid} (unsupervised — launchd bootstrap refused)`;
      return `launchd (${AGENT_LABEL}) · not loaded`;
    }
    const running = /^[ \t]*pid = (\d+)/m.exec(out)?.[1];
    return running !== undefined
      ? `launchd (${AGENT_LABEL}) · active (pid ${running})`
      : `launchd (${AGENT_LABEL}) · loaded, not running`;
  }
  return pid !== undefined ? `pid ${pid} (unsupervised)` : "not supervised";
}

/**
 * One scannable "is Collie up?" summary — readiness, how it's supervised, and both URLs. Shared by
 * `start` (post-launch confirmation) and `status` (on demand) so the two can never disagree.
 */
export async function statusBanner(deps: LifecycleDeps): Promise<string[]> {
  const version = collieVersion(deps.ctx.root);
  const lines: string[] = [""];
  lines.push(
    (await deps.ready(deps.ctx.port))
      ? `  ✓ Collie is running  ·  v${version}`
      : `  ⚠ Collie isn't answering on :${deps.ctx.port} yet (v${version}) — check 'collie logs'`,
  );
  lines.push(`    service   ${serviceDescription(deps)}`);
  lines.push(`    local     http://127.0.0.1:${deps.ctx.port}`);
  if (deps.ctx.env.COLLIE_SKIP_SERVE === "1") {
    const url = deps.ctx.env.COLLIE_PUBLIC_URL?.trim();
    lines.push(
      url
        ? `    proxy     ${url}`
        : "    proxy     (COLLIE_SKIP_SERVE=1 — set COLLIE_PUBLIC_URL to your reverse-proxy URL)",
    );
  } else {
    lines.push(`    tailnet   ${bridgeUrl(deps.exec, deps.ctx.serveMode, deps.ctx.port)}`);
  }
  lines.push("");
  return lines;
}

async function printStatusBanner(deps: LifecycleDeps): Promise<void> {
  for (const line of await statusBanner(deps)) deps.io.out(line);
}

/**
 * The lazy first build lives in `build` (M3/04). Until then — and on any host where the UI was
 * never built — say so and carry on: the API runs, the UI 503s, which is what the shell's
 * `ensure_build` degraded to as well (scripts/collie-ctl.sh:169-174).
 */
function warnIfUnbuilt(deps: LifecycleDeps): void {
  if (deps.files.exists(join(deps.ctx.root, "web", "dist", "index.html"))) return;
  deps.io.err(
    "warn: web/dist is not built — the API will run but the UI will 503 until you build it",
  );
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

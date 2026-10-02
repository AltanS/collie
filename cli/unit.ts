import { join, win32 } from "node:path";

import { collieBinary, HOST, type Host } from "../bridge/host.ts";
import type { CliContext, EnvVars } from "./context.ts";
import { instanceSuffix, PLUGIN_ID } from "./context.ts";

// The service definition, as a pure function of where things are. The shell wrote these with a
// heredoc straight into `~/.config/systemd/user` and `~/Library/LaunchAgents`, so the only way to
// see the text was to install it; here the generators are total functions and their full output is
// pinned in `cli/unit.test.ts`.
//
// systemd unit ↔ launchd agent, kept parallel so both describe ONE service:
//   WantedBy=default.target -> RunAtLoad          Restart=on-failure -> KeepAlive/SuccessfulExit
//   RestartSec=5            -> ThrottleInterval   WorkingDirectory   -> WorkingDirectory
// No analogue on launchd: StartLimitIntervalSec (it has no start limit), NoNewPrivileges,
// PrivateTmp — the agent is simply less confined. No ProcessType either: Background throttles CPU
// and I/O, and the bridge answers a phone. The Windows task is the third, further down.

/** The systemd `--user` unit name, and the launchd label (the plugin id, so `launchctl print` names the job as `herdr plugin list` names the plugin). */
export const UNIT_NAME = "collie";
export const AGENT_LABEL = PLUGIN_ID;

// Every name below is a function of the instance suffix, and every one of them returns the constant
// above when there is none — a host that never sets `COLLIE_INSTANCE` sees the same unit, the same
// label and the same filenames it saw before the knob existed.

/** The systemd `--user` unit name for this instance: `collie`, or `collie-v1`. */
export const unitName = (instance: string | null): string => `${UNIT_NAME}${instanceSuffix(instance)}`;

/** The launchd label for this instance: `herdr.collie`, or `herdr.collie-v1`. */
export const agentLabel = (instance: string | null): string =>
  `${AGENT_LABEL}${instanceSuffix(instance)}`;

/** The pidfile's basename — the unsupervised tier's record of its own bridge. */
export const pidFileName = (instance: string | null): string => `collie${instanceSuffix(instance)}.pid`;

/** The log basename, written by the unsupervised tier and read back by `collie logs`. */
export const logFileName = (instance: string | null): string => `collie${instanceSuffix(instance)}.log`;

export interface ServiceSpec {
  /** The Collie checkout. */
  root: string;
  /** The instance suffix, or `null`. Names the unit, the label, the log and the argv marker. */
  instance: string | null;
  /** The supervised program: `<root>/bin/collie`. */
  binary: string;
  configDir: string;
  socket: string;
  port: number;
  /**
   * The discovered Host allowlist, comma-joined, or `""` when there is none.
   *
   * It is baked into the unit rather than left to `.env` because the bridge's Host gate fails closed
   * and this is the value nobody should have to type — `cli/lifecycle.ts` discovers it. `""` means
   * **write no line at all**: an empty `COLLIE_TAILSCALE_HOSTS=` in the unit would REPLACE a working
   * allowlist with a lockout the next time a probe happened to fail.
   */
  tailscaleHosts: string;
}

/**
 * Where the compiled binary lives relative to its checkout: `bin/collie`, and `bin/collie.exe` on
 * Windows. The layout is written once, in `bridge/host.ts`, and the bridge imports it too, because it
 * gates and spawns the update action on the same file.
 */
export { collieBinary };

export function serviceSpec(ctx: CliContext, tailscaleHosts = "", host: Host = HOST): ServiceSpec {
  return {
    root: ctx.root,
    instance: ctx.instance,
    binary: collieBinary(ctx.root, host),
    configDir: ctx.configDir,
    socket: ctx.socket,
    port: ctx.port,
    tailscaleHosts,
  };
}

export function unitFilePath(home: string, instance: string | null = null): string {
  return join(home, ".config", "systemd", "user", `${unitName(instance)}.service`);
}

export function agentFilePath(home: string, instance: string | null = null): string {
  return join(home, "Library", "LaunchAgents", `${agentLabel(instance)}.plist`);
}

/**
 * The argv the supervisor runs, and the same argv the unsupervised fallback spawns. One definition,
 * because `stopPidfileProcess` recognises its own bridge by this command line — a second copy would
 * drift and the liveness guard would silently degrade to killing nothing.
 */
export function bridgeCommand(spec: ServiceSpec): string[] {
  const argv = [spec.binary, "_exec-bridge"];
  // A suffixed instance carries `--instance <name>`, and that is the ONLY reason the flag exists:
  // two instances out of one checkout share a binary path, so without it the pidfile predicate
  // ({@link isOurBridge}) could not tell one bridge from the other and `start` on the second could
  // kill the first. `_exec-bridge` ignores the argument — the instance travels in the environment.
  if (spec.instance !== null) argv.push("--instance", spec.instance);
  return argv;
}

/**
 * The environment the bridge is launched with. PATHS ONLY, never config values: the plist has to be
 * world-readable (launchd refuses a world-writable one) while `.env` is mode 600 and may hold
 * `COLLIE_VAPID_PRIVATE` — so `_exec-bridge` parses `.env` itself at launch rather than anything
 * baking a Web Push signing key into a readable file.
 *
 * `HERDR_PLUGIN_CONFIG_DIR` is passed because config-dir resolution must not shell out to `herdr`
 * at login, before the server is up. `COLLIE_PLUGIN_ROOT` is passed because the compiled binary
 * cannot derive the checkout from its own module path (bridge/root.ts) and `web/dist` is served
 * from disk.
 */
export function bridgeEnvironment(spec: ServiceSpec): EnvVars {
  const env: EnvVars = {
    HERDR_SOCKET_PATH: spec.socket,
    COLLIE_PORT: String(spec.port),
    HERDR_PLUGIN_CONFIG_DIR: spec.configDir,
    COLLIE_PLUGIN_ROOT: spec.root,
  };
  // Only when there is one: an unsuffixed instance's unit and plist are unchanged by this knob's
  // existence. It is passed so the supervised process resolves the same context the CLI did —
  // notably `collie logs` and the pidfile, which are named after the instance.
  if (spec.instance !== null) env.COLLIE_INSTANCE = spec.instance;
  // Assigned, never unconditionally: see {@link ServiceSpec.tailscaleHosts} — an empty value written
  // here is a lockout, not a default, so nothing is written at all.
  if (spec.tailscaleHosts !== "") env.COLLIE_TAILSCALE_HOSTS = spec.tailscaleHosts;
  return env;
}

/**
 * The allowlist a previously written unit or plist baked in, or `""`.
 *
 * It is read back so a FAILED discovery can keep what already worked. `tailscale status` fails for
 * reasons that have nothing to do with this install — the daemon is down, the node is logged out —
 * and under a fail-closed Host gate that must not cost the operator their front door.
 *
 * One function for both files because the caller does not know which supervisor wrote the last one,
 * and reading the wrong shape simply finds nothing.
 */
export function bakedTailscaleHosts(text: string | null): string {
  if (text === null) return "";
  const unit = [...text.matchAll(/^Environment=COLLIE_TAILSCALE_HOSTS=(.*)$/gm)].at(-1);
  if (unit !== undefined) return unit[1]!.trim();
  const plist = /<key>COLLIE_TAILSCALE_HOSTS<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return plist === null ? "" : plist[1]!.trim();
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = bridgeEnvironment(spec);
  return `[Unit]
Description=Collie${spec.instance === null ? "" : ` (instance ${spec.instance})`}
After=default.target
# Never give up restarting — a phone-only operator can't run 'systemctl reset-failed'.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${spec.root}
ExecStart=${bridgeCommand(spec).join(" ")}
Restart=on-failure
RestartSec=5
# Hardening: the bridge is remote shell access, so deny privilege escalation and give it a private
# /tmp. ProtectSystem is intentionally NOT set — the only write path is the env-driven state dir,
# which Herdr may inject to an arbitrary location, so it can't be enumerated in a static ReadWritePaths.
NoNewPrivileges=yes
PrivateTmp=yes
${Object.entries(env)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join("\n")}
# Leading '-': a missing .env is not a startup failure.
EnvironmentFile=-${join(spec.configDir, ".env")}

[Install]
WantedBy=default.target
`;
}

/**
 * Escape a value for XML character data — a checkout path containing `&` or `<` would otherwise
 * emit a plist launchd can't parse. `&` first, or it re-escapes the ampersands the later rules
 * introduce.
 */
export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The plist's file mode. launchd refuses to bootstrap a world-writable plist, whatever the umask left behind. */
export const AGENT_FILE_MODE = 0o644;

export function launchAgentPlist(spec: ServiceSpec): string {
  const env = bridgeEnvironment(spec);
  const args = bridgeCommand(spec)
    .map((a) => `        <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const envEntries = Object.entries(env)
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(agentLabel(spec.instance))}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.root)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(spec.configDir, logFileName(spec.instance)))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(spec.configDir, logFileName(spec.instance)))}</string>
</dict>
</plist>
`;
}

// ── Windows: the Task Scheduler task ─────────────────────────────────────────
//
// The third service definition, kept parallel to the two above so all three describe ONE service:
//   WantedBy=default.target -> LogonTrigger (this user)    Restart=on-failure -> the launcher's loop
//   RestartSec=5            -> the launcher's 5 s pause     WorkingDirectory   -> WorkingDirectory
// The launcher is `collie _supervise` (cli/task-scheduler.ts), because Task Scheduler restarts a task
// that failed to START, not a program that exits: something Collie owns has to watch the bridge.
//
// TWO RESTART LAYERS, AND WHICH ONE WINS. The launcher's loop owns relaunching the bridge: it sees
// every exit and backs off on its own clock. `RestartOnFailure` (999 tries, one minute apart) never
// sees the bridge, and it is a narrower net than it looks. Measured on the Windows 11 VM on
// 2026-10-02: a launcher killed by hand takes its bridge with it (a child that is not detached dies
// with its parent), `conhost` then exits 0, the task reads Ready with result 0, and nothing restarts
// it in 160 s. So it covers a task that fails to START, not a launcher that dies; that case comes back
// at the next logon, or with `collie restart` (which sees no live launcher and takes stop + start).
//
// THE SETTINGS THAT ARE NOT DEFAULTS, each pinned by `cli/unit.test.ts`:
//   ExecutionTimeLimit PT0S        the default is 72 hours, after which Task Scheduler silently ends
//                                  the supervisor and the bridge stops being watched
//   MultipleInstancesPolicy IgnoreNew  a second `/Run` while one runs is a no-op, never a second launcher
//   DisallowStartIfOnBatteries false, StopIfGoingOnBatteries false  a laptop on battery keeps its bridge
//   StartWhenAvailable true        a logon that was missed (the task disabled at the time) runs later
// No analogue: NoNewPrivileges and PrivateTmp. The task runs with the user's limited token unless
// the operator asks for `COLLIE_TASK_RUN_LEVEL=highest` (see `taskRunLevel` in cli/lifecycle.ts).
//
// First written by @Pimpmuckl as `contrib/windows/collie-ctl.ps1` (#71), which this replaces.

/** What the task XML needs that the {@link ServiceSpec} does not carry. */
export interface TaskOptions {
  /** `DOMAIN\user`, as `whoami` prints it. The task starts at THIS user's logon and runs as them. */
  user: string;
  /** `LeastPrivilege` unless the operator asked for an elevated task. */
  runLevel: "LeastPrivilege" | "HighestAvailable";
  /**
   * `conhost.exe`, or null when it is not there. The task runs the launcher through
   * `conhost --headless`, so the bridge gets a pseudoconsole and no window: a console program started
   * straight from a logon task opens a Windows Terminal tab on Windows 11, and closing that tab kills
   * the bridge.
   */
  conhost: string | null;
}

/** The task file Collie registers from, kept beside `.env` like the unit beside the user units. */
export function taskFilePath(configDir: string, instance: string | null, host: Host = HOST): string {
  return host.path.join(configDir, `${agentLabel(instance)}.task.xml`);
}

/**
 * The launcher's argv after the binary. Paths only, like {@link bridgeEnvironment}, because Task
 * Scheduler has no per-task environment: the values travel as `KEY=value` words that `_supervise`
 * hands to the bridge. `--instance <name>` comes first for the same reason {@link bridgeCommand}
 * carries it: two instances out of one checkout must be told apart by their command lines.
 */
export function superviseArgs(spec: ServiceSpec): string[] {
  const argv = ["_supervise"];
  if (spec.instance !== null) argv.push("--instance", spec.instance);
  for (const [k, v] of Object.entries(bridgeEnvironment(spec))) argv.push(`${k}=${v}`);
  return argv;
}

/**
 * Quote one argument so a Windows program reads it back as one word (the MSVCRT rules every Bun and
 * Node program parses with): a backslash is literal unless a run of them ends at a quote, and then
 * each doubles. A word with no blank and no quote is left bare, so the common case stays readable.
 */
export function windowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** The program the task starts and its argument string. */
export interface TaskAction {
  command: string;
  arguments: string;
}

export function taskAction(spec: ServiceSpec, conhost: string | null): TaskAction {
  const words = superviseArgs(spec).map(windowsArg).join(" ");
  if (conhost === null) return { command: spec.binary, arguments: words };
  return { command: conhost, arguments: `--headless ${windowsArg(spec.binary)} ${words}` };
}

/**
 * XML character data in plain ASCII: {@link xmlEscape}, and every other character as a numeric
 * reference. `schtasks /XML` reads a file with no encoding declaration as UTF-8 and refuses the
 * declaration itself ("unable to switch the encoding", Windows 11, 2026-10-02), so a pure-ASCII
 * file is the one shape that keeps a non-ASCII user or folder name intact.
 */
export function xmlAscii(value: string): string {
  return xmlEscape(value).replace(/[^\x20-\x7e]/gu, (ch) => `&#x${ch.codePointAt(0)!.toString(16)};`);
}

/**
 * The folder the launcher runs in. On a binary install the task names `<install-root>\current`, a
 * junction, and a process that runs in it holds the version folder behind it open: `collie update`
 * could then never remove that version (Windows 11 VM, 2026-10-02). So the launcher runs in the
 * install root, which no update moves; the bridge still runs in its version folder (`launchRoot`).
 * A checkout keeps its own root.
 */
export function taskWorkingDirectory(root: string): string {
  return win32.basename(root).toLowerCase() === "current" ? win32.dirname(root) : root;
}

/** The Task Scheduler definition, as `schtasks /Create /XML` reads it. No XML declaration: see {@link xmlAscii}. */
export function taskXml(spec: ServiceSpec, opts: TaskOptions): string {
  const action = taskAction(spec, opts.conhost);
  return `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Collie${spec.instance === null ? "" : ` (instance ${xmlAscii(spec.instance)})`}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlAscii(opts.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlAscii(opts.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>${opts.runLevel}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlAscii(action.command)}</Command>
      <Arguments>${xmlAscii(action.arguments)}</Arguments>
      <WorkingDirectory>${xmlAscii(taskWorkingDirectory(spec.root))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * The `KEY=` directives a systemd unit declares, in order, ignoring values and comments. Used to
 * hold `systemd/collie.service` — the hand-managed reference copy an operator may install directly
 * — to the same shape as the generated one, so the two can't drift.
 */
export function unitDirectives(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    // Environment= repeats with a different variable each time, so the variable name is part of
    // the directive's identity.
    out.push(key === "Environment" ? `Environment=${line.slice(eq + 1).split("=")[0]}` : key);
  }
  return out;
}

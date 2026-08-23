/** The result returned by {@link Shell} after a child process has finished. */
export interface ShellResult {
  /** Captured standard output, decoded as UTF-8. */
  stdout: string;
  /** Captured standard error, decoded as UTF-8. */
  stderr: string;
  /** The child process exit status. A successful process returns zero. */
  exitCode: number;
}

/** Options that affect one {@link Shell} invocation without changing the caller's environment. */
export interface ShellOptions {
  /** Directory in which to start the child process. */
  cwd?: string;
}

/**
 * The command runner shared by ctl verbs and service backends.
 *
 * `command` is an executable name or path and `args` are passed as individual arguments; no shell
 * interpolation is performed. The promise resolves for non-zero exits so callers can include the
 * command's diagnostic in their own error, while a process-spawn failure rejects it.
 */
export type Shell = (
  command: string,
  args?: readonly string[],
  options?: ShellOptions,
) => Promise<ShellResult>;

/** A command and its already-separated arguments, suitable for passing to {@link Ctx.shell}. */
export interface ShellCommand {
  /** Executable name or path. */
  command: string;
  /** Arguments passed without shell parsing. */
  args: readonly string[];
}

/**
 * Runtime paths and side-effect seams shared by every ctl verb.
 *
 * `configDir` contains operator configuration such as `.env`; `stateDir` contains runtime files
 * such as logs and Tailscale ownership state; `socketPath` is Herdr's local IPC endpoint. `log` is
 * the user-facing output sink, and `shell` is the only subprocess boundary verbs should use.
 */
export interface Ctx {
  /** Directory containing Collie's operator configuration. */
  configDir: string;
  /** Directory containing Collie's runtime state and file logs. */
  stateDir: string;
  /** Herdr's local socket or named-pipe path. */
  socketPath: string;
  /** Optional checkout root used by lifecycle and operational verbs. */
  rootDir?: string;
  /** Optional environment overlay used by injected lifecycle operations. */
  env?: Record<string, string | undefined>;
  /** Write a user-facing ctl message. */
  log(...args: unknown[]): void;
  /** Run one executable without invoking a command shell. */
  shell: Shell;
}

/** The service-supervisor families supported by the ctl backend selector. */
export type BackendName = "systemd" | "launchd" | "windows-task";

/**
 * The lifecycle and log contract implemented by each service supervisor backend.
 *
 * Backends receive the shared context on every operation so they can be constructed and tested
 * without global paths. `install` creates or refreshes the supervisor definition, `start` and
 * `stop` control it, `isActive` reports the supervisor's current state, and `logsCmd` returns a
 * platform-specific command for reading the most recent log lines.
 */
export interface ServiceBackend {
  /** Install or refresh the per-user service definition. */
  install(ctx: Ctx): Promise<void>;
  /** Start the installed service. */
  start(ctx: Ctx): Promise<void>;
  /** Stop the service without deleting its definition. */
  stop(ctx: Ctx): Promise<void>;
  /** Remove the per-user service definition and registration. */
  uninstall?(ctx: Ctx): Promise<void>;
  /** Report whether the supervisor considers the service active. */
  isActive(ctx: Ctx): Promise<boolean>;
  /** Build the command used to display the requested number of recent log lines. */
  logsCmd(ctx: Ctx, lines?: number): ShellCommand;
}

/** The complete set of ctl verbs, including supervisor-only internal verbs. */
export type Verb =
  | "start"
  | "stop"
  | "restart"
  | "uninstall"
  | "update"
  | "build"
  | "serve"
  | "unserve"
  | "status"
  | "url"
  | "version"
  | "qr"
  | "logs"
  | "push-keys"
  | "push-test"
  | "exec-bridge"
  | "apply-update";

/** Whether a command-line executable can be resolved without invoking a shell. */
function commandAvailable(name: string): boolean {
  return Bun.which(name) !== null;
}

/**
 * Whether a usable per-user systemd instance is available.
 *
 * This mirrors `collie-ctl.sh`: finding `systemctl` is not enough; its user manager must answer
 * `show-environment` successfully.
 */
export function hasSystemd(): boolean {
  if (!commandAvailable("systemctl")) return false;
  try {
    return Bun.spawnSync(["systemctl", "--user", "show-environment"], {
      stdout: "ignore",
      stderr: "ignore",
    }).success;
  } catch {
    return false;
  }
}

/** Whether the Darwin per-user launchd domain and its command-line client are available. */
export function hasLaunchd(): boolean {
  return process.platform === "darwin" && commandAvailable("launchctl");
}

/** Whether Windows Task Scheduler can be addressed through its built-in command-line client. */
export function hasWindowsTask(): boolean {
  return (
    process.platform === "win32" &&
    (commandAvailable("schtasks") || commandAvailable("schtasks.exe"))
  );
}

/** Select the first available service family, or `undefined` for an unsupervised host. */
export function selectBackendName(): BackendName | undefined {
  if (hasSystemd()) return "systemd";
  if (hasLaunchd()) return "launchd";
  if (hasWindowsTask()) return "windows-task";
  return undefined;
}

/** Options for the loopback TCP readiness probe. */
export interface TcpReadinessOptions {
  host?: string;
  attempts?: number;
  intervalMs?: number;
}

/**
 * Probe the bridge's TCP listener, replacing Bash's `/dev/tcp` probe.
 *
 * A successful connection is closed immediately. The probe intentionally checks only that the
 * listener accepts TCP, not that a particular HTTP route is healthy.
 */
export async function waitForTcpReadiness(
  port: number,
  options: TcpReadinessOptions = {},
): Promise<boolean> {
  const host = options.host ?? "127.0.0.1";
  const attempts = Math.max(1, Math.floor(options.attempts ?? 25));
  const intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 200));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const socket = await Bun.connect({
        hostname: host,
        port,
        socket: {
          open() {},
          data() {},
          error() {},
          close() {},
        },
      });
      socket.end();
      return true;
    } catch {
      if (attempt + 1 < attempts && intervalMs > 0) await Bun.sleep(intervalMs);
    }
  }
  return false;
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Parse a Tailscale JSON object, returning `null` for invalid or non-object JSON. */
export function parseTailscaleJson(text: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Extract and normalize Tailscale's `Self.DNSName`. */
export function parseTailscaleDnsName(statusJson: string): string | null {
  const root = parseTailscaleJson(statusJson);
  const self = objectValue(root?.Self);
  const dnsName = self?.DNSName;
  if (typeof dnsName !== "string" || dnsName === "") return null;
  const normalized = dnsName.replace(/\.$/, "");
  return normalized === "" ? null : normalized;
}

/**
 * Read the fingerprint used to prove ownership of a Tailscale root handler.
 *
 * The result is `absent` when no `/` handler exists, `<protocol>|proxy:<target>` for a root proxy,
 * or `<protocol>|other` for a non-proxy root. `null` means the status JSON could not be trusted.
 */
export function parseTailscaleRootFingerprint(
  statusJson: string,
  hostPort: string,
  port: string | number,
): string | null {
  const config = parseTailscaleJson(statusJson);
  if (config === null) return null;

  const web = objectValue(config.Web);
  const host = objectValue(web?.[hostPort]);
  const handlers = objectValue(host?.Handlers);
  if (handlers === null || !Object.prototype.hasOwnProperty.call(handlers, "/")) {
    return "absent";
  }

  const tcp = objectValue(config.TCP);
  const listener = objectValue(tcp?.[String(port)]);
  const protocol = listener?.HTTP === true ? "http" : listener?.HTTPS === true ? "https" : "other";
  const rootHandler = objectValue(handlers["/"]);
  const proxy = rootHandler?.Proxy;
  return typeof proxy === "string" && proxy !== "" ? `${protocol}|proxy:${proxy}` : `${protocol}|other`;
}

/** A callable implementation for one parsed ctl verb. */
export type VerbHandler = (ctx: Ctx, args: readonly string[]) => Promise<void>;

import { homedir } from "node:os";
import { join } from "node:path";

import type { Ctx, ShellOptions, ShellResult, Verb, VerbHandler } from "./types.ts";
import { selectBackendName, waitForTcpReadiness } from "./types.ts";

export {
  hasLaunchd,
  hasSystemd,
  hasWindowsTask,
  parseTailscaleDnsName,
  parseTailscaleRootFingerprint,
  selectBackendName,
  waitForTcpReadiness,
} from "./types.ts";
import * as lifecycle from "./verbs-lifecycle.ts";
import * as info from "./verbs-info.ts";
import * as ops from "./verbs-ops.ts";
import type { InstalledServiceBackend } from "./backends/common.ts";
import { windowsBackend } from "./backends/windows.ts";
import { systemdBackend } from "./backends/systemd.ts";
import { launchdBackend } from "./backends/launchd.ts";

/** User-facing verbs handled by ctl. */
export const PUBLIC_VERBS = [
  "start",
  "stop",
  "restart",
  "uninstall",
  "update",
  "build",
  "serve",
  "unserve",
  "status",
  "url",
  "version",
  "qr",
  "logs",
  "push-keys",
  "push-test",
] as const satisfies readonly Verb[];

/** Verbs reserved for service supervisors and the update hand-off. */
export const INTERNAL_VERBS = ["exec-bridge", "apply-update"] as const satisfies readonly Verb[];

/** Every accepted verb, in the order shown by {@link USAGE}. */
export const ALL_VERBS = [...PUBLIC_VERBS, ...INTERNAL_VERBS] as const;

/** Stable command-line help text; it deliberately names internal verbs so dispatch is discoverable. */
export const USAGE = [
  "Usage: bun scripts/ctl/main.ts <verb> [args...]",
  "",
  "Verbs:",
  ...PUBLIC_VERBS.map((verb) => `  ${verb}`),
  "",
  "Internal verbs:",
  ...INTERNAL_VERBS.map((verb) => `  ${verb}`),
  "",
  "Use --help to show this message.",
].join("\n");

/**
 * Run an executable with separated arguments and capture both output streams.
 *
 * This is the default implementation of {@link Ctx.shell}. It intentionally does not invoke a
 * command interpreter, which keeps paths and user-controlled arguments literal on Unix and Windows.
 */
export async function runShell(
  command: string,
  args: readonly string[] = [],
  options: ShellOptions = {},
): Promise<ShellResult> {
  const child = Bun.spawn([command, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { stdout: await stdout, stderr: await stderr, exitCode };
}

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function defaultConfigDir(home: string): string {
  if (process.platform === "win32") {
    return join(envPath("APPDATA") ?? join(home, "AppData", "Roaming"), "collie");
  }
  return join(home, ".config", "collie");
}

function defaultStateDir(home: string): string {
  if (process.platform === "win32") {
    return join(envPath("LOCALAPPDATA") ?? join(home, "AppData", "Local"), "collie", "state");
  }
  return join(home, ".local", "state", "collie");
}

function defaultSocketPath(home: string): string {
  if (process.platform === "win32") {
    return join(envPath("APPDATA") ?? join(home, "AppData", "Roaming"), "herdr", "herdr.sock");
  }
  return join(home, ".config", "herdr", "herdr.sock");
}

/**
 * Create the default context used by a command-line invocation.
 *
 * Environment overrides mirror the bridge's launcher contract: injected plugin paths win over the
 * platform fallbacks, and state overrides retain the existing HERDR_PLUGIN_STATE_DIR then
 * COLLIE_STATE_DIR precedence.
 */
export function createContext(): Ctx {
  const home = homedir();
  return {
    configDir: envPath("HERDR_PLUGIN_CONFIG_DIR") ?? defaultConfigDir(home),
    stateDir:
      envPath("HERDR_PLUGIN_STATE_DIR") ?? envPath("COLLIE_STATE_DIR") ?? defaultStateDir(home),
    socketPath: envPath("HERDR_SOCKET_PATH") ?? defaultSocketPath(home),
    log: (...args) => console.log(...args),
    shell: runShell,
  };
}

/**
 * The supervisor backend for THIS machine, or undefined when no supported one is present.
 *
 * Selection order matches the shell original: systemd first (servers), then launchd (macOS),
 * then the Windows Task Scheduler.
 */
function defaultBackend(): InstalledServiceBackend | undefined {
  switch (selectBackendName()) {
    case "windows-task":
      return windowsBackend;
    case "systemd":
      return systemdBackend;
    case "launchd":
      return launchdBackend;
    default:
      return undefined;
  }
}

/** The backend the lifecycle verbs require — every ctl host runs exactly one supported supervisor. */
function requireBackend(): InstalledServiceBackend {
  const backend = defaultBackend();
  if (backend === undefined) {
    throw new Error(
      "no supported service supervisor found (systemd, launchd, or Windows Task Scheduler)",
    );
  }
  return backend;
}

/** Operational seams shared by the lifecycle verbs; build doubles as rebuild by design. */
const lifecycleOps = {
  build: (ctx: Ctx) => ops.build(ctx),
  rebuild: (ctx: Ctx) => ops.build(ctx),
  unserve: (ctx: Ctx) => ops.unserve(ctx),
};

/** Info-verb dependencies wired to the real backend when one exists, graceful otherwise. */
function infoDeps(ctx: Ctx): info.InfoDeps {
  const backend = defaultBackend();
  if (backend === undefined) return {};
  return {
    backend: {
      isActive: () => backend.isActive(ctx),
      logsCmd: async (lines?: number) => {
        const command = backend.logsCmd(ctx, lines);
        return [command.command, ...command.args].join(" ");
      },
    },
  };
}

const handlers: Record<Verb, VerbHandler> = {
  start: (ctx) =>
    lifecycle.start(ctx, {
      backend: requireBackend(),
      ops: lifecycleOps,
      ensureBuild: (c) => lifecycle.ensureBuild(c, requireBackend(), lifecycleOps),
      waitForReadiness: (port: number, options?: lifecycle.ReadinessOptions) =>
        waitForTcpReadiness(port, options),
    }),
  stop: (ctx) => lifecycle.stop(ctx, requireBackend()),
  restart: (ctx) => lifecycle.restart(ctx, requireBackend()),
  uninstall: (ctx) => lifecycle.uninstall(ctx, requireBackend()),
  update: (ctx, args) => lifecycle.update(ctx, args, { backend: requireBackend(), ...lifecycleOps }),
  build: (ctx) => ops.build(ctx),
  serve: (ctx) => ops.serve(ctx),
  unserve: (ctx) => ops.unserve(ctx),
  status: async (ctx) => ctx.log(await info.status(ctx, infoDeps(ctx))),
  url: async (ctx) => ctx.log(await info.url(ctx, infoDeps(ctx))),
  version: async (ctx) => ctx.log(await info.version()),
  qr: async (ctx) => ctx.log(await info.qr(ctx, infoDeps(ctx))),
  logs: async (ctx, args) => ctx.log(await info.logs(ctx, infoDeps(ctx), Number(args[0]) || 50)),
  "push-keys": (ctx, args) => ops.pushKeys(ctx, args),
  "push-test": (ctx, args) => ops.pushTest(ctx, args),
  "exec-bridge": (ctx) => ops.execBridge(ctx),
  // The shell implementation re-executed itself post-pull because bash could not resume cleanly;
  // this implementation performs the rebuild+restart inline inside `update`, so the internal verb
  // only exists to fail informatively if a stale service definition still invokes it.
  "apply-update": async () => {
    throw new Error("apply-update is folded into 'update' by this implementation");
  },
};

function isVerb(value: string | undefined): value is Verb {
  return value !== undefined && ALL_VERBS.some((candidate) => candidate === value);
}

/**
 * Parse and dispatch one ctl command, returning the process exit status.
 *
 * Help is handled before context creation so it is safe in a fresh checkout. Unknown verbs always
 * emit the complete usage text on standard error and return status 2; command failures return 1.
 */
export async function dispatch(argv: readonly string[], ctx?: Ctx): Promise<number> {
  const [rawVerb, ...args] = argv;
  if (rawVerb === "--help" || rawVerb === "-h" || rawVerb === "help") {
    console.log(USAGE);
    return 0;
  }
  if (!isVerb(rawVerb)) {
    if (rawVerb !== undefined) console.error(`unknown verb: ${rawVerb}`);
    console.error(USAGE);
    return 2;
  }

  try {
    await handlers[rawVerb](ctx ?? createContext(), args);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await dispatch(process.argv.slice(2));
}

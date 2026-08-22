import { homedir } from "node:os";
import { join } from "node:path";

import type { Ctx, ShellOptions, ShellResult, Verb, VerbHandler } from "./types.ts";

export {
  hasLaunchd,
  hasSystemd,
  hasWindowsTask,
  parseTailscaleDnsName,
  parseTailscaleRootFingerprint,
  selectBackendName,
  waitForTcpReadiness,
} from "./types.ts";

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

const notImplemented = (verb: Verb): VerbHandler => async () => {
  throw new Error(`ctl verb '${verb}' is not implemented in the ctl skeleton`);
};

const handlers: Record<Verb, VerbHandler> = {
  start: notImplemented("start"),
  stop: notImplemented("stop"),
  restart: notImplemented("restart"),
  uninstall: notImplemented("uninstall"),
  update: notImplemented("update"),
  build: notImplemented("build"),
  serve: notImplemented("serve"),
  unserve: notImplemented("unserve"),
  status: notImplemented("status"),
  url: notImplemented("url"),
  version: notImplemented("version"),
  qr: notImplemented("qr"),
  logs: notImplemented("logs"),
  "push-keys": notImplemented("push-keys"),
  "push-test": notImplemented("push-test"),
  "exec-bridge": notImplemented("exec-bridge"),
  "apply-update": notImplemented("apply-update"),
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

import { basename } from "node:path";
import type { Subprocess } from "bun";

import { HOST, type Host } from "./host.ts";
import { envGet } from "./tools.ts";

// ── THE LOGIN SHELL'S PATH (ADR 0091) ───────────────────────────────────────────────────────────
// A bridge under systemd, launchd or Herdr has a short PATH. The operator's shell, the one a pane
// runs, sources a profile, and that is where `~/.opencode/bin`, `~/.local/bin` or an nvm folder is
// added. So a search for an agent's binary runs over the login shell's PATH, asked once per
// process with argv only and a short cap, and falls back to the bridge's own PATH when the shell
// cannot be asked.

/** The login shell is given this long to print its PATH. */
export const LOGIN_PATH_TIMEOUT_MS = 3_000;
/** A PATH past this is not one a shell printed. */
const LOGIN_PATH_MAX_BYTES = 64 * 1024;

/** Asks a login shell for its PATH. `null` when it cannot be asked or does not answer in time. */
export type LoginPathAsk = (shell: string) => Promise<string | null>;

/**
 * The real thing: `<shell> -lc 'printf %s "$PATH"'`, argv only, no stdin, killed at the cap. `-l`
 * sources the login profile, which is where a profile adds tool folders. A shell that prints more
 * than one line (a profile that echoes) is read as its LAST line.
 */
export const askLoginPath: LoginPathAsk = async (shell) => {
  const done = await boundedRun([shell, "-lc", 'printf %s "$PATH"'], process.env, LOGIN_PATH_TIMEOUT_MS);
  if (done === null || done.code !== 0 || done.out.length > LOGIN_PATH_MAX_BYTES) return null;
  const last = done.out.split("\n").at(-1)?.trim() ?? "";
  return last === "" ? null : last;
};

/** What a {@link boundedRun} child printed, and how it exited: `code` null when it was killed at the cap (nothing it printed is kept). */
export interface BoundedRun {
  readonly out: string;
  readonly err: string;
  readonly code: number | null;
}

/**
 * Runs `argv` with no stdin and returns what it printed and its exit code, or null when it would not
 * start. One that does not finish inside `ms` is killed and answers at once with `code` null and no
 * output. The bound is real. Bun's own `timeout`, and a kill on a timer, end the child, but reading its stdout and
 * stderr still waits for both pipes to close, and a grandchild that inherited them (a wrapper's
 * `sleep`, an agent started from a login profile, a node script's helper) holds them open after the
 * kill. A version read that waited so took 20 s in the lab against a 5 s timeout (#594), and the
 * send's bound counted down behind it.
 */
export async function boundedRun(argv: readonly string[], env: Record<string, string | undefined>, ms: number): Promise<BoundedRun | null> {
  let child: Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  const started = child;
  const finished = (async (): Promise<BoundedRun> => {
    const [out, err] = await Promise.all([new Response(started.stdout).text(), new Response(started.stderr).text()]);
    return { out, err, code: await started.exited };
  })().catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BoundedRun>((done) => {
    timer = setTimeout(() => {
      try {
        started.kill("SIGKILL");
      } catch {
        // Gone already.
      }
      done({ out: "", err: "", code: null });
    }, ms);
  });
  try {
    return await Promise.race([finished, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Shells whose `-lc` takes a POSIX-quoted script. Another shell is not asked. */
const POSIX_LOGIN_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]);

export interface LoginPathDeps {
  env?: Record<string, string | undefined>;
  host?: Host;
  askPath?: LoginPathAsk;
}

/** The login shell's PATH, or the bridge's own when there is none. `undefined` when neither is set. */
export type LoginPath = () => Promise<string | undefined>;

/** A {@link LoginPath} that asks the shell on its first call and answers every later one from that. */
export function createLoginPath(deps: LoginPathDeps = {}): LoginPath {
  const env = deps.env ?? process.env;
  const host = deps.host ?? HOST;
  const askPath = deps.askPath ?? askLoginPath;
  let loginPath: Promise<string | undefined> | null = null;
  return () => {
    if (loginPath !== null) return loginPath;
    const own = envGet(env, "PATH", host);
    const shell = envGet(env, "SHELL", host);
    // Windows has no login shell to ask, and an unknown shell may not read `-lc` as a script.
    if (host.platform === "win32" || shell === undefined || !POSIX_LOGIN_SHELLS.has(basename(shell))) {
      loginPath = Promise.resolve(own);
      return loginPath;
    }
    loginPath = askPath(shell).then((asked) => asked ?? own);
    return loginPath;
  };
}

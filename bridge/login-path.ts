import { basename } from "node:path";

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
  try {
    const proc = Bun.spawn([shell, "-lc", 'printf %s "$PATH"'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), LOGIN_PATH_TIMEOUT_MS);
    try {
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0 || out.length > LOGIN_PATH_MAX_BYTES) return null;
      const last = out.split("\n").at(-1)?.trim() ?? "";
      return last === "" ? null : last;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};

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

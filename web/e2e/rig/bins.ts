// The three harness binaries the browser leg runs, by absolute path. Node builtins only, so that
// nightly.ts can read their versions from a checkout with no node_modules, and harnesses.ts starts
// the very same files. `claude` on PATH is a shell function and a cgroup shim here, so the leg never
// uses PATH for it. pi takes the first `pi` on PATH (a node version manager moves it with every
// Node), and the old fixed path only when PATH has none.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const HOME = homedir();

/** The first executable `name` on PATH, or null. Node builtins only, for the reason above. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here: the next directory
    }
  }
  return null;
}

export const BIN = {
  claude: process.env.COLLIE_RIG_CLAUDE_BIN ?? join(HOME, ".local", "bin", "claude"),
  pi: process.env.COLLIE_RIG_PI_BIN ?? onPath("pi") ?? join(HOME, ".config", "nvm", "versions", "node", "v24.8.0", "bin", "pi"),
  omp: process.env.COLLIE_RIG_OMP_BIN ?? join(HOME, ".bun", "bin", "omp"),
} as const;

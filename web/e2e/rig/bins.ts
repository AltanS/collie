// The three harness binaries the browser leg runs, by absolute path. Node builtins only, so that
// nightly.ts can read their versions from a checkout with no node_modules, and harnesses.ts starts
// the very same files. `claude` on PATH is a shell function and a cgroup shim here, so the leg never
// uses PATH for it.
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

export const BIN = {
  claude: process.env.COLLIE_RIG_CLAUDE_BIN ?? join(HOME, ".local", "bin", "claude"),
  pi: process.env.COLLIE_RIG_PI_BIN ?? join(HOME, ".config", "nvm", "versions", "node", "v24.8.0", "bin", "pi"),
  omp: process.env.COLLIE_RIG_OMP_BIN ?? join(HOME, ".bun", "bin", "omp"),
} as const;

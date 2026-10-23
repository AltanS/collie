// The three harness binaries the browser leg runs, by absolute path. Node builtins only, so that
// nightly.ts can read their versions from a checkout with no node_modules, and harnesses.ts starts
// the very same files. `claude` on PATH is a shell function and a cgroup shim here, so the leg never
// uses PATH for it. pi takes the first `pi` on PATH (a node version manager moves it with every
// Node), and the old fixed path only when PATH has none. A `node_modules/.bin` entry never counts:
// `bunx` puts every ancestor's one in front of PATH, and a stray pi under the home directory won over
// the real one (2026-10-22).
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const HOME = homedir();

/** A PATH entry that a package manager or `bunx` added: some project's `node_modules/.bin`, at any depth. */
function isLocalBin(dir: string): boolean {
  return /(^|[\\/])node_modules[\\/]\.bin[\\/]*$/u.test(dir);
}

/** The first executable `name` on `pathVar` (default: PATH), skipping `node_modules/.bin` entries, or null. Node builtins only, for the reason above. */
export function onPath(name: string, pathVar: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathVar.split(delimiter)) {
    if (dir === "" || isLocalBin(dir)) continue;
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

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** True when `dir` holds a package.json named `name`. */
function isPackageRoot(dir: string, name: string): boolean {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.name === name;
  } catch {
    return false;
  }
}

/**
 * pi's stock example extensions folder. The binary's real path lies inside the package
 * (`.../@earendil-works/pi-coding-agent/dist/.../cli.js`), so the walk goes up from there to the
 * package root, wherever the version manager or a stray install put the link. When the walk finds no
 * such package, the old guess beside the binary's own directory stands.
 */
export function piExamplesDir(bin: string): string {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    // no such file: the guess below
  }
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (isPackageRoot(dir, PI_PACKAGE)) return join(dir, "examples", "extensions");
    if (dirname(dir) === dir) break;
  }
  return join(bin, "..", "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions");
}

/** The example extension files pi is started with, and a note for each gap (empty when none is missing). */
export interface PiExtensions {
  readonly paths: string[];
  readonly notes: string[];
}

export function piExtensions(bin: string, files: readonly string[]): PiExtensions {
  const examples = piExamplesDir(bin);
  const paths = files.map((file) => join(examples, file)).filter((path) => existsSync(path));
  const missing = files.filter((file) => !existsSync(join(examples, file)));
  return { paths, notes: missing.length === 0 ? [] : [`pi examples not found at ${examples}: ${missing.join(", ")} missing`] };
}

export const BIN = {
  claude: process.env.COLLIE_RIG_CLAUDE_BIN ?? join(HOME, ".local", "bin", "claude"),
  pi: process.env.COLLIE_RIG_PI_BIN ?? onPath("pi") ?? join(HOME, ".config", "nvm", "versions", "node", "v24.8.0", "bin", "pi"),
  omp: process.env.COLLIE_RIG_OMP_BIN ?? join(HOME, ".bun", "bin", "omp"),
} as const;

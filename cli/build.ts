import { basename, dirname, join, resolve } from "node:path";

import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";
import { collieBinary } from "./unit.ts";

// `build` and the lazy `ensure_build`, ported from the pre-shim `collie-ctl.sh`. The five ordered
// steps and their reasons come along with the code, because every one of them is a production
// incident someone already paid for:
//
//   1. version gate     — a release whose four version files disagree must not go live.
//   2. install BOTH     — the root typecheck resolves @types/bun from the ROOT node_modules; a fresh
//      trees              Herdr checkout ships neither tree, so without the root install the very
//                         first build dies with TS2688 and Herdr rolls the install back (issue #9).
//   3. typecheck BOTH   — the Vite build does not typecheck, so a type error would ship silently.
//      sides
//   4. compile the CLI  — `bin/collie` is a build product, so an `update` that changed cli/ produces
//                         a binary matching the checkout it was built from.
//   5. build the web    — into `web/dist-staging`, never into `web/dist`: Vite empties its output
//      bundle             dir first, and the bridge serves `web/dist` FROM DISK at request time, so
//                         building in place would leave the served directory empty with no rollback.
//
// The swaps are LAST, after every step that can fail, and each is a same-filesystem rename. That is
// the invariant this module exists for: a build that fails leaves the previously served bundle
// byte-identical and the running binary untouched.

/** What `build` needs: where things are, the two seams, and somewhere to talk. */
export interface BuildDeps {
  ctx: CliContext;
  io: Io;
  exec: Exec;
  files: Files;
}

/** The narrow seam shared by the full build and `bun run build:cli`. */
export interface CliCompileDeps {
  /** The checkout that owns both the binary and its private compiler sandbox. */
  root: string;
  io: Io;
  exec: Exec;
  files: Files;
}

/** Optional release inputs; ordinary source builds use the local Bun, target and live binary. */
export interface CliCompileOptions {
  /** The Bun executable that becomes the compiled binary's embedded runtime. */
  bun?: string;
  /** Bun's executable target. */
  target?: string;
  /** Where the compiled binary is written. */
  outfile?: string;
}

/** The checkout-relative locations `build` writes. */
export const webDist = (root: string): string => join(root, "web", "dist");
export const webStaging = (root: string): string => join(root, "web", "dist-staging");
/**
 * Where the new binary is compiled before it is renamed onto `bin/collie`. Same directory, so the
 * rename is same-filesystem — and a new inode, so a supervised process executing the old binary
 * keeps reading the file it started with. `update` restarts the service afterwards to pick it up.
 * Writing into the live path instead can corrupt a running process mid-read: a Bun single-file
 * executable carries its payload INSIDE the file.
 */
export const collieBinaryStaging = (root: string): string => `${collieBinary(root)}.new`;

/** Prefixes for private, atomically-created directories under the checkout's real `bin`. */
export const bunCompileSandboxPrefix = (root: string): string => join(root, "bin", ".bun-compile-");
export const cliOutputStagingPrefix = (root: string): string => join(root, "bin", ".collie-cli-");

interface CompilePaths {
  readonly root: string;
  readonly bin: string;
}

/** Resolve the checkout once and refuse a linked or redirected `bin` before creating scratch there. */
function compilePaths(deps: CliCompileDeps): CompilePaths | null {
  const requestedRoot = resolve(deps.root);
  const root = deps.files.realpath(requestedRoot);
  if (root === null) {
    deps.io.err(`error: could not resolve the checkout root at ${requestedRoot}`);
    return null;
  }

  const bin = join(root, "bin");
  if (deps.files.entryType(bin) === null) {
    try {
      deps.files.mkdirp(bin);
    } catch (err) {
      deps.io.err(`error: could not create the checkout bin directory at ${bin} (${String(err)})`);
      return null;
    }
  }
  if (deps.files.entryType(bin) !== "directory") {
    deps.io.err(`error: checkout bin directory at ${bin} is not a real directory`);
    return null;
  }
  const realBin = deps.files.realpath(bin);
  if (realBin !== bin) {
    deps.io.err(`error: checkout bin directory at ${bin} resolves outside its canonical path`);
    return null;
  }
  return { root, bin };
}

/** Atomically claim one direct child of the validated `bin`; only this returned path is ours to remove. */
function createOwnedDirectory(
  deps: CliCompileDeps,
  bin: string,
  prefix: string,
  label: string,
): string | null {
  try {
    const directory = deps.files.mkdtemp(prefix);
    if (dirname(directory) !== bin || !basename(directory).startsWith(basename(prefix))) {
      deps.io.err(`error: ${label} was not created under ${bin}`);
      return null;
    }
    return directory;
  } catch (err) {
    deps.io.err(`error: could not create ${label} (${String(err)})`);
    return null;
  }
}

/** Remove only an atomically-created directory belonging to this invocation, and prove it went away. */
function cleanOwnedDirectory(deps: CliCompileDeps, directory: string, label: string): boolean {
  try {
    deps.files.removeTree(directory);
  } catch (err) {
    deps.io.err(`error: could not clean ${label} (${String(err)})`);
    return false;
  }
  if (deps.files.exists(directory)) {
    deps.io.err(`error: could not clean ${label} at ${directory}`);
    return false;
  }
  return true;
}

/** A listing failure is not evidence that the source root has no compiler residue. */
function rootSidecars(deps: CliCompileDeps, root: string): Set<string> | null {
  try {
    return new Set(deps.files.listStrict(root).filter((name) => name.endsWith(".bun-build")));
  } catch (err) {
    deps.io.err(`error: could not list the checkout root for Bun sidecars (${String(err)})`);
    return null;
  }
}

/** Existing sidecars are legacy residue; only a sidecar newly escaping this compiler is a failure. */
function verifyNewRootSidecars(
  deps: CliCompileDeps,
  root: string,
  before: ReadonlySet<string>,
): boolean {
  const after = rootSidecars(deps, root);
  if (after === null) return false;
  const escaped = [...after].filter((name) => !before.has(name));
  if (escaped.length === 0) return true;
  deps.io.err(`error: new root-level Bun sidecar escaped: ${escaped.join(", ")}`);
  return false;
}

/**
 * Bun is a hard requirement of `build` — it compiles the CLI and runs Vite — and the ONLY place the
 * binary still needs it. Say so legibly rather than dying with ENOENT halfway through.
 */
function requireBun(deps: BuildDeps): string | null {
  const bun = deps.exec.which("bun");
  if (bun !== null) return bun;
  deps.io.err(
    "error: bun not found — `collie build` needs it to compile the CLI and build the web UI.",
  );
  deps.io.err("       Install it from https://bun.sh, then re-run. (Nothing else needs Bun.)");
  return null;
}

/** Run one build step, naming it if it fails. `set -e` in the shell; an early return here. */
function step(
  deps: Pick<CliCompileDeps, "io" | "exec">,
  label: string,
  tool: string,
  args: readonly string[],
  cwd: string,
): boolean {
  const r = deps.exec.runIn(tool, args, cwd);
  if (!r.found) {
    deps.io.err(`error: ${tool} not found — cannot ${label}`);
    return false;
  }
  if (r.code !== 0) {
    deps.io.err(`error: ${label} failed (exit ${r.code})`);
    return false;
  }
  return true;
}

/**
 * Compile the CLI from an atomically-created private sandbox. This is the one compiler invocation
 * shared by the operator's CLI-only remedy and the full build; it always passes absolute input and
 * output paths so changing Bun's cwd cannot change either identity.
 */
export function compileCli(deps: CliCompileDeps, options: CliCompileOptions = {}): boolean {
  const paths = compilePaths(deps);
  if (paths === null) return false;
  const before = rootSidecars(deps, paths.root);
  if (before === null) return false;

  const sandbox = createOwnedDirectory(
    deps,
    paths.bin,
    bunCompileSandboxPrefix(paths.root),
    "Bun's compile sandbox",
  );
  if (sandbox === null) return false;

  const bun = options.bun ?? "bun";
  const target = options.target ?? "bun";
  const output = resolve(options.outfile ?? collieBinary(paths.root));
  let compiled = false;
  try {
    compiled = step(
      deps,
      "compiling the collie binary",
      bun,
      ["build", "--compile", `--target=${target}`, join(paths.root, "cli", "main.ts"), "--outfile", output],
      sandbox,
    );
  } catch (err) {
    deps.io.err(`error: compiling the collie binary failed (${String(err)})`);
  }

  // Bun may leave a sidecar on success or failure, so the owned sandbox is always torn down before
  // anything else observes the checkout. Legacy root sidecars remain in place; only new residue is
  // unsafe because it was created while this compiler was running.
  const cleaned = cleanOwnedDirectory(deps, sandbox, "Bun's compile sandbox");
  const rootClean = verifyNewRootSidecars(deps, paths.root, before);
  return compiled && cleaned && rootClean;
}

/**
 * Compile the ordinary `build:cli` output in a private staging directory, then publish it only after
 * {@link compileCli} has cleaned and verified its compiler sandbox. Explicit `--outfile` callers use
 * {@link compileCli} directly because their artifact path is not the live checkout binary.
 */
export function compileCliToLive(
  deps: CliCompileDeps,
  options: Omit<CliCompileOptions, "outfile"> = {},
): boolean {
  const paths = compilePaths(deps);
  if (paths === null) return false;
  const staging = createOwnedDirectory(
    deps,
    paths.bin,
    cliOutputStagingPrefix(paths.root),
    "CLI output staging directory",
  );
  if (staging === null) return false;

  const output = join(staging, "collie");
  if (!compileCli({ ...deps, root: paths.root }, { ...options, outfile: output })) {
    cleanOwnedDirectory(deps, staging, "CLI output staging directory");
    return false;
  }

  try {
    deps.files.rename(output, collieBinary(paths.root));
  } catch (err) {
    deps.io.err(`error: could not publish the compiled collie binary (${String(err)})`);
    cleanOwnedDirectory(deps, staging, "CLI output staging directory");
    return false;
  }

  // Publication has already succeeded. A leftover empty, invocation-owned staging directory is a
  // warning, not a retroactive build failure that would misreport the live binary's state.
  try {
    deps.files.removeTree(staging);
    if (deps.files.exists(staging)) {
      deps.io.err(`warn: published collie binary but could not remove ${staging}`);
    }
  } catch (err) {
    deps.io.err(`warn: published collie binary but could not remove ${staging} (${String(err)})`);
  }
  return true;
}

export function cmdBuild(deps: BuildDeps): number {
  const root = deps.ctx.root;
  const web = join(root, "web");
  if (requireBun(deps) === null) return EXIT.FAIL;

  // 1. The version gate stays `scripts/check-version.sh` — ONE implementation. It is also the
  // pre-commit hook's gate and runs on checkouts where no binary has been built yet, so porting the
  // rule in here would create a second copy of a rule whose whole value is that it cannot drift.
  if (deps.ctx.env.SKIP_VERSION_CHECK !== "1") {
    const gate = join(root, "scripts", "check-version.sh");
    if (!step(deps, "the version gate", "bash", [gate], root)) return EXIT.FAIL;
  }

  // 2. Both dependency trees, root first.
  for (const dir of [root, web]) {
    if (!step(deps, `bun install in ${dir}`, "bun", ["install"], dir)) return EXIT.FAIL;
  }

  // A lint gate used to sit here, between the installs and the typechecks, and it must not come
  // back. THIS FUNCTION IS THE OPERATOR'S PATH, not a developer's: a clean install runs it through
  // Herdr's `[[build]]` step, `update` runs it on the operator's own machine, and neither has any
  // way to react to a linter. oxlint's Rust allocator aborts (SIGABRT, a panic in
  // `oxc_allocator/src/pool/fixed_size.rs`) on a host with less than roughly 7 GB of RAM — bisected
  // on identical VM guests: 4 GB and 6 GB abort, 7/8/12 GB pass. So the gate ended clean installs
  // with `Plugin was not installed.` and left upgrades on a detached checkout with no `bin/collie`:
  // an ordinary 4–8 GB box was bricked by a developer gate. A gate the operator cannot pass, and did
  // not ask for, is not a gate. Lint is still enforced where a developer can act on it — CI's `Lint`
  // step (`.github/workflows/ci.yml`, full tree, the authority) and the pre-commit hook over the
  // staged files. The mux-name check left with it: it rode the same hatch by design, and CI enforces
  // it through `scripts/check-mux-names.test.ts`, which runs the script over the real `web/src`.
  // `SKIP_LINT` went too — nothing reads it, so leaving the name would be a hatch that disarms
  // nothing.

  // 3. Both typechecks. Same escape hatch the pre-push hook documents.
  if (deps.ctx.env.SKIP_TYPECHECK !== "1") {
    for (const dir of [root, web]) {
      if (!step(deps, `typecheck in ${dir}`, "bun", ["run", "typecheck"], dir)) return EXIT.FAIL;
    }
  }

  // 4. The CLI, into its staging path. `compileCli` also serves `bun run build:cli`, so neither
  // supported route can run Bun from the checkout root before Vite samples its Git identity.
  const binaryStaging = collieBinaryStaging(root);
  deps.files.remove(binaryStaging);
  if (!compileCli({ root, io: deps.io, exec: deps.exec, files: deps.files }, { outfile: binaryStaging })) {
    deps.files.remove(binaryStaging);
    return EXIT.FAIL;
  }

  // 5. The web bundle, into staging.
  const staging = webStaging(root);
  deps.files.removeTree(staging);
  const built = step(
    deps,
    "building the web UI",
    "bun",
    ["run", "build", "--", "--outDir", "dist-staging", "--emptyOutDir"],
    web,
  );
  if (!built) {
    // Neither artifact has been swapped in: `web/dist` is exactly what it was, and the running
    // binary is still the one that started this build.
    deps.files.remove(binaryStaging);
    return EXIT.FAIL;
  }

  // 6. The swaps, last. The binary first because it is the smaller window, then the served bundle.
  deps.files.rename(binaryStaging, collieBinary(root));
  deps.files.removeTree(webDist(root));
  deps.files.rename(staging, webDist(root));
  return EXIT.OK;
}

/**
 * The lazy first build (the pre-shim `collie-ctl.sh`): `start` builds the UI when `web/dist` is
 * missing, and WARNS rather than fails if it can't — the API runs, the UI 503s. `herdr-plugin.toml`
 * records why it has to exist at all: Herdr runs `[[build]]` only on `plugin install`, never on
 * `plugin link`.
 */
export function ensureBuild(deps: BuildDeps): boolean {
  if (deps.files.exists(join(webDist(deps.ctx.root), "index.html"))) return true;
  if (deps.exec.which("bun") === null) {
    deps.io.err("note: bun not found; cannot build the web UI — the API will run but the UI will 503");
    return false;
  }
  deps.io.out("building web UI (first run)…");
  if (cmdBuild(deps) !== EXIT.OK) {
    deps.io.err("warn: web build failed; the API will run but the UI will 503 until it is built");
    return false;
  }
  return true;
}

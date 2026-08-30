import { join } from "node:path";

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
  deps: BuildDeps,
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

  // 4. The CLI, into its staging path. Compiled BEFORE the web bundle so the cheaper failure
  // (a broken binary) is found first, but swapped in only at the end with everything else.
  const binaryStaging = collieBinaryStaging(root);
  deps.files.remove(binaryStaging);
  deps.files.mkdirp(join(root, "bin"));
  const compiled = step(
    deps,
    "compiling the collie binary",
    "bun",
    ["build", "--compile", "--target=bun", "./cli/main.ts", "--outfile", binaryStaging],
    root,
  );
  if (!compiled) {
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

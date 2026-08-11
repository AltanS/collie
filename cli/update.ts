import { join } from "node:path";

import { type BuildDeps, cmdBuild } from "./build.ts";
import { EXIT } from "./io.ts";
import type { Exec } from "./sys.ts";

// `update`, `_apply-update` and the checkout logic behind them, ported from
// the pre-shim `collie-ctl.sh`. ADR 0006 is this module's specification: Collie is a link-mode
// Herdr plugin, so the checkout on disk IS the plugin, and it arrives in one of TWO shapes —
//
//   `git clone` + `herdr plugin link`   → a normal clone, ON A BRANCH, full history
//   `herdr plugin install AltanS/collie` → `git init` + `fetch --depth 1` + `checkout --detach`,
//                                          i.e. DETACHED and SHALLOW, no remote-tracking refs
//
// — and a bare `git pull --ff-only` has nothing to pull into in the second, which is why every
// turnkey install from 0.1.0 to 0.23.1 could never self-update while the in-app banner kept
// advertising the release (#63).

export interface UpdateDeps extends BuildDeps {
  /** `restart` over the same context — injected because `update`'s own tests must never start a service. */
  restart: () => Promise<number>;
}

const gitArgs = (root: string, args: readonly string[]): string[] => ["-C", root, ...args];

/**
 * True when the checkout has no branch — exactly how `herdr plugin install` leaves it.
 *
 * ONE predicate decides BOTH how we advance the checkout ({@link updateCheckout}) and whether we
 * re-link ({@link refreshRegistry}). Two detections would eventually disagree, and the disagreement
 * would be silent: an install that advances correctly and then re-registers itself as `local`, after
 * which Herdr refuses `plugin install` and the operator has no way back.
 */
export function isManagedCheckout(exec: Exec, root: string): boolean {
  const r = exec.capture("git", gitArgs(root, ["symbolic-ref", "-q", "HEAD"]));
  return !r.found || r.code !== 0;
}

function isGitCheckout(exec: Exec, root: string): boolean {
  const r = exec.capture("git", gitArgs(root, ["rev-parse", "--git-dir"]));
  return r.found && r.code === 0;
}

function isShallow(exec: Exec, root: string): boolean {
  const r = exec.capture("git", gitArgs(root, ["rev-parse", "--is-shallow-repository"]));
  return r.found && r.code === 0 && r.stdout.trim() === "true";
}

/** Advance the checkout to the newest upstream commit, in whichever shape it was installed. */
export function updateCheckout(deps: UpdateDeps): number {
  const root = deps.ctx.root;
  const git = (args: readonly string[]): number => {
    const r = deps.exec.runIn("git", gitArgs(root, args), root);
    if (!r.found) {
      deps.io.err("error: git not found — cannot update the checkout");
      return EXIT.FAIL;
    }
    return r.code === 0 ? EXIT.OK : EXIT.FAIL;
  };

  if (!isGitCheckout(deps.exec, root)) {
    deps.io.err(`error: ${root} is not a git checkout — refresh it with:`);
    deps.io.err("       herdr plugin install AltanS/collie --yes");
    return EXIT.FAIL;
  }

  if (!isManagedCheckout(deps.exec, root)) {
    deps.io.out("updating Collie (git pull --ff-only)…");
    return git(["pull", "--ff-only"]);
  }

  // Detached: re-detach onto the default branch tip the same way Herdr got us here.
  deps.io.out("updating Collie (Herdr-managed checkout: fetch + detach onto origin HEAD)…");
  // `--depth 1` ONLY when we are already shallow, so an update never truncates the history of a full
  // clone someone happens to have detached.
  const fetch = isShallow(deps.exec, root)
    ? ["fetch", "--depth", "1", "origin", "HEAD"]
    : ["fetch", "origin", "HEAD"];
  if (git(fetch) !== EXIT.OK) return EXIT.FAIL;
  // `--force` because `build` runs `bun install`, which can rewrite the TRACKED lockfiles: a plain
  // checkout would then refuse on the dirty tree and re-break the very update path this fixes.
  // Discarding local edits matches Herdr's own refresh semantics — a reinstall replaces the managed
  // checkout wholesale. `-q` because otherwise checkout warns "you are leaving 1 commit behind" on
  // every single update: true, alarming, and useless — the commit we leave is the release we just
  // replaced.
  if (git(["checkout", "-q", "--detach", "--force", "FETCH_HEAD"]) !== EXIT.OK) return EXIT.FAIL;
  const head = deps.exec.capture("git", gitArgs(root, ["log", "-1", "--format=%h %s"]));
  deps.io.out(`→ now at ${head.stdout.trim()}`);
  return EXIT.OK;
}

/**
 * After an update, Herdr's plugin registry still holds the action set + version CACHED at the last
 * `plugin link`, so a newly added action returns `plugin_action_not_found` until a re-link. Re-link
 * here so `update` self-heals it. Best-effort: never fails the update — Herdr may be down, or this
 * may not be a link install — it just prints how to do it by hand.
 *
 * NEVER on a Herdr-MANAGED checkout: `plugin link` re-registers with `source.kind = local`, after
 * which Herdr REFUSES `plugin install` ("already linked from a local path"), taking away the
 * reinstall that is the operator's only other way to refresh (ADR 0006).
 */
export function refreshRegistry(deps: UpdateDeps): void {
  const root = deps.ctx.root;
  if (deps.exec.which("herdr") === null) return;
  if (isManagedCheckout(deps.exec, root)) {
    deps.io.out(
      "note: Herdr-managed install — registry left alone (re-linking would block `herdr plugin install`)",
    );
    return;
  }
  const r = deps.exec.capture("herdr", ["plugin", "link", root]);
  if (r.found && r.code === 0) {
    deps.io.out("herdr registry refreshed (re-linked) — new actions are invokable now");
    return;
  }
  deps.io.out("note: couldn't refresh the Herdr registry (is the Herdr server running?) —");
  deps.io.out(`      run: herdr plugin link "${root}"`);
}

/**
 * The second half of `update`, run FROM THE CODE THAT WAS JUST FETCHED. `build` re-runs the version
 * gate (a half-bumped release can't go live) and recompiles both the binary and `web/dist`;
 * `restart` picks up the new bridge AND the new binary (the swap gave `bin/collie` a fresh inode,
 * so the still-running service keeps executing the old one until it is restarted); `refreshRegistry`
 * re-links so Herdr learns any newly added actions.
 */
export async function cmdApplyUpdate(deps: UpdateDeps): Promise<number> {
  const built = cmdBuild(deps);
  if (built !== EXIT.OK) {
    // The checkout has already advanced, so this is the skew shape ADR 0006 exists to prevent: new
    // code on disk, the OLD artifacts still being served. `build` swaps nothing on failure, so the
    // service is untouched and consistent — but the operator has to know the update did not land.
    deps.io.err("error: update stopped — the checkout advanced but the build failed.");
    deps.io.err("       The running bridge and the served UI are unchanged. Fix the build and re-run");
    deps.io.err("       `herdr plugin action invoke update --plugin herdr.collie`.");
    return built;
  }
  const restarted = await deps.restart();
  if (restarted !== EXIT.OK) return restarted;
  refreshRegistry(deps);
  deps.io.out("✓ update complete");
  return EXIT.OK;
}

/**
 * Update to the latest release: advance the checkout, then hand the rest to the code we just
 * fetched.
 *
 * The handoff is the whole subtlety. The shell re-exec'd itself because bash reads a script by byte
 * offset and the pull rewrites that very file. A binary has the harder version of the problem: the
 * post-pull half must run the NEW build logic, and the new binary does not exist yet — `build` is
 * what produces it. So the re-exec target is the new checkout's SOURCE, run with Bun, which `build`
 * already requires and which is therefore not a new dependency. That build compiles the new
 * `bin/collie` and swaps it in; the restart that follows is what puts it into service.
 */
export async function cmdUpdate(deps: UpdateDeps): Promise<number> {
  const advanced = updateCheckout(deps);
  if (advanced !== EXIT.OK) return advanced;
  if (deps.exec.which("bun") === null) {
    deps.io.err("error: bun not found — the checkout advanced, but rebuilding needs Bun.");
    deps.io.err("       Install it from https://bun.sh and re-run update.");
    return EXIT.FAIL;
  }
  const r = deps.exec.runIn(
    "bun",
    [join(deps.ctx.root, "cli", "main.ts"), "_apply-update"],
    deps.ctx.root,
  );
  return r.found && r.code === 0 ? EXIT.OK : EXIT.FAIL;
}

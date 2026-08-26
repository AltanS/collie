import { join } from "node:path";

import { compareSemver, majorOf, parseSemverTag } from "../bridge/update.ts";
import { manifestVersionFrom } from "../bridge/version.ts";
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

/** The command that consents to a major crossing — printed wherever one is refused. */
export const MAJOR_ACTION = "herdr plugin action invoke update-major --plugin herdr.collie";

// ── Target selection (pure — ADR 0020) ───────────────────────────────────────
// A routine `update` no longer means "the tip of the default branch": it means "the newest RELEASE
// of the major this install is already on". Crossing a major is a separate act, consented to by
// `--major`. Everything that decides WHICH commit to land on is a pure function over the remote's
// tag list, so `bun test` covers the whole decision without a git remote.

/** One strict `vX.Y.Z` release tag, as the remote reports it. */
export interface ReleaseTag {
  /** The ref name (`v1.2.3`) — what we fetch by, because a bare sha may not be a valid want. */
  tag: string;
  /** Dotted version, no leading `v`. */
  version: string;
  major: number;
  /** The commit the tag resolves to — the PEELED one for an annotated tag. */
  commit: string;
}

/**
 * Strict release tags out of `git ls-remote --tags origin`. Prereleases and every non-release ref are
 * dropped by the same anchor the banner uses (`bridge/update.ts`'s `SEMVER_TAG`), so the verb can
 * never land on something the banner would not have announced.
 *
 * An ANNOTATED tag is listed twice — once at the tag object, once peeled (`^{}`) at the commit. The
 * peeled line is the one that names a commit, so it wins wherever both appear.
 */
export function parseRemoteTags(stdout: string): ReleaseTag[] {
  const byTag = new Map<string, { commit: string; peeled: boolean }>();
  for (const line of stdout.split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (commit === undefined || ref === undefined) continue;
    if (!ref.startsWith("refs/tags/")) continue;
    const raw = ref.slice("refs/tags/".length);
    const peeled = raw.endsWith("^{}");
    const name = peeled ? raw.slice(0, -3) : raw;
    if (parseSemverTag(name) === null) continue;
    const seen = byTag.get(name);
    if (seen !== undefined && seen.peeled && !peeled) continue;
    byTag.set(name, { commit, peeled });
  }
  return [...byTag].map(([tag, { commit }]) => ({
    tag,
    version: tag.slice(1),
    major: parseSemverTag(tag)![0],
    commit,
  }));
}

/** The highest release among `tags`, or null when there is none. */
export function highestRelease(tags: readonly ReleaseTag[]): ReleaseTag | null {
  let best: ReleaseTag | null = null;
  for (const t of tags) if (best === null || compareSemver(t.version, best.version) > 0) best = t;
  return best;
}

/** The highest release inside `major` — the target of a routine update. */
export function releaseInMajor(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  return highestRelease(tags.filter((t) => t.major === major));
}

/**
 * The highest release of the NEXT major that has one — the target of `update --major`.
 *
 * The next major, not the highest: an install two majors behind crosses one at a time, so each
 * crossing is the one the operator consented to and its release notes are the ones that apply.
 */
export function nextMajorRelease(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  const above = tags.filter((t) => t.major > major);
  if (above.length === 0) return null;
  const next = Math.min(...above.map((t) => t.major));
  return releaseInMajor(above, next);
}

/**
 * What `update` should do with this checkout, given the remote's tags and the version the checkout's
 * manifest names. `higher` rides along on every routine outcome so the caller can always say a major
 * is out — announcing it is not the same as taking it.
 */
export type UpdatePlan =
  | { kind: "advance"; target: ReleaseTag; crossesMajor: boolean; higher: ReleaseTag | null }
  | { kind: "current"; at: ReleaseTag; higher: ReleaseTag | null }
  | { kind: "no-release"; major: number; higher: ReleaseTag | null }
  | { kind: "no-higher-major"; major: number }
  /**
   * The manifest named no version we can read a major out of — so there is no major to gate on.
   *
   * `newest` is the highest release tag on the remote, and the caller pins to it. It used to follow
   * `origin HEAD`, which is not a release: a moved default branch would land an operator on
   * unreleased work they never asked for. `null` means the remote publishes no releases at all,
   * which is the one case where there is nothing safe to take.
   */
  | { kind: "unknown-version"; newest: ReleaseTag | null };

export function planUpdate(a: {
  tags: readonly ReleaseTag[];
  /** The version in the checkout's `herdr-plugin.toml` — the canonical one Herdr reads. */
  installed: string | null;
  /** The commit the checkout is on, or "" when git could not say. */
  head: string;
  /** `--major` was passed: the operator consents to one crossing. */
  crossMajor: boolean;
}): UpdatePlan {
  const major = a.installed === null ? null : majorOf(a.installed);
  if (major === null || a.installed === null) {
    return { kind: "unknown-version", newest: highestRelease(a.tags) };
  }
  const higher = nextMajorRelease(a.tags, major);
  if (a.crossMajor) {
    return higher === null
      ? { kind: "no-higher-major", major }
      : { kind: "advance", target: higher, crossesMajor: true, higher };
  }
  const best = releaseInMajor(a.tags, major);
  if (best === null) return { kind: "no-release", major, higher };
  // Already there — by commit (the usual case) or by version (a rebuilt tag, a rolled-forward
  // manifest). Either answer means there is nothing in this major left to take.
  if (best.commit === a.head || compareSemver(best.version, a.installed) <= 0) {
    return { kind: "current", at: best, higher };
  }
  return { kind: "advance", target: best, crossesMajor: false, higher };
}

/**
 * The gate on the LINKED-CLONE path, where the target is the branch tip rather than a tag: compare
 * the major of the manifest we just fetched against the installed one. `unknown` when either side
 * names no readable version — we proceed there, for the same reason `planUpdate` falls back.
 */
export function majorVerdict(installed: string | null, fetched: string | null): "same" | "crosses" | "unknown" {
  const a = installed === null ? null : majorOf(installed);
  const b = fetched === null ? null : majorOf(fetched);
  if (a === null || b === null) return "unknown";
  return b > a ? "crosses" : "same";
}

/** `--major` anywhere in the verb's argv. The flag IS the consent — there is no prompt (ADR 0020). */
export function wantsMajor(args: readonly string[]): boolean {
  return args.includes("--major");
}

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

/** The version in the checkout's own `herdr-plugin.toml` — the installed major is read from here. */
function installedVersion(deps: UpdateDeps): string | null {
  return manifestVersionFrom(deps.files.read(join(deps.ctx.root, "herdr-plugin.toml")));
}

/** Say a higher major is out, and name the one command that takes it. Never acts. */
function announceMajor(deps: UpdateDeps, higher: ReleaseTag | null): void {
  if (higher === null) return;
  deps.io.out(`note: Collie ${higher.version} is out — a NEW MAJOR, which a routine update never takes.`);
  deps.io.out(`      Read its release notes, then consent to it with:  ${MAJOR_ACTION}`);
}

/**
 * Advance the checkout, in whichever shape it was installed — and never across a major without
 * `--major` (ADR 0020).
 *
 * The two shapes take the gate differently, because their targets are different things. A managed
 * checkout is detached, so it can be pointed straight at a release TAG and the gate is target
 * selection itself. A linked clone is on a branch and keeps fast-forwarding it (detaching it onto a
 * tag would undo its shape, and re-linking it is what ADR 0006 forbids for managed installs), so its
 * gate is a pre-flight: fetch, read the manifest at the branch's OWN upstream, and refuse before
 * pulling.
 */
export function updateCheckout(deps: UpdateDeps, opts: { crossMajor: boolean } = { crossMajor: false }): number {
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

  const installed = installedVersion(deps);
  return isManagedCheckout(deps.exec, root)
    ? updateManaged(deps, git, installed, opts.crossMajor)
    : updateLinked(deps, git, installed, opts.crossMajor);
}

/** A linked clone keeps its branch and its `--ff-only` pull; the gate runs BEFORE the pull. */
function updateLinked(
  deps: UpdateDeps,
  git: (args: readonly string[]) => number,
  installed: string | null,
  crossMajor: boolean,
): number {
  const root = deps.ctx.root;
  // Plain `git fetch origin` — the configured refspec, so every remote-tracking ref advances. NOT
  // `fetch origin HEAD`: that resolves the remote's DEFAULT branch, and the pull below takes the
  // current branch's own upstream. On a clone kept on a maintenance or integration branch those are
  // different commits, and a gate that judged one while the pull took the other would refuse a
  // fast-forward that never leaves the major (and, after 1.0 lands on `main`, would refuse EVERY
  // pull on a 0.x branch). Judge exactly the commit the pull will land on.
  if (git(["fetch", "origin"]) !== EXIT.OK) return EXIT.FAIL;
  const upstream = deps.exec.capture(
    "git",
    gitArgs(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  );
  const ref = upstream.found && upstream.code === 0 ? upstream.stdout.trim() : "";
  // No upstream at all: there is nothing for the gate to judge, and nothing for the pull to take
  // either — `git pull --ff-only` fails with its own "no tracking information" message, which says
  // more about the checkout than anything we could add. Let it speak; a pull that cannot happen
  // cannot cross a major.
  if (ref !== "") {
    const fetched = manifestVersionFrom(
      deps.exec.capture("git", gitArgs(root, ["show", `${ref}:herdr-plugin.toml`])).stdout,
    );
    if (!crossMajor && majorVerdict(installed, fetched) === "crosses") {
      deps.io.out(`refusing to update: ${installed} → ${fetched} (${ref}) crosses a MAJOR version.`);
      deps.io.out("A major means you have to change something — so it is never taken by a routine update.");
      deps.io.out(`Read its release notes, then consent to it with:  ${MAJOR_ACTION}`);
      deps.io.out("(nothing was pulled — this checkout is unchanged)");
      return EXIT.OK;
    }
  }
  deps.io.out("updating Collie (git pull --ff-only)…");
  return git(["pull", "--ff-only"]);
}

/**
 * A Herdr-managed checkout is detached, so `update` re-detaches it — onto the newest RELEASE TAG of
 * the major it is on, never onto whatever the default branch says right now.
 */
function updateManaged(
  deps: UpdateDeps,
  git: (args: readonly string[]) => number,
  installed: string | null,
  crossMajor: boolean,
): number {
  const root = deps.ctx.root;
  const ls = deps.exec.capture("git", gitArgs(root, ["ls-remote", "--tags", "origin"]));
  if (!ls.found || ls.code !== 0) {
    deps.io.err("error: could not list the upstream release tags — is the remote reachable?");
    return EXIT.FAIL;
  }
  const head = deps.exec.capture("git", gitArgs(root, ["rev-parse", "HEAD"])).stdout.trim();
  const plan = planUpdate({ tags: parseRemoteTags(ls.stdout), installed, head, crossMajor });

  if (plan.kind === "unknown-version") {
    // No readable version on disk: still take a RELEASE, never `origin HEAD`. A checkout that cannot
    // name its major cannot be gated on one — but "ungated" must not mean "whatever the default
    // branch points at today", which is unreleased work nobody consented to.
    if (plan.newest === null) {
      deps.io.err("error: no release tags on origin — cannot pin an unversioned checkout.");
      return EXIT.FAIL;
    }
    deps.io.out(
      `updating Collie (Herdr-managed checkout: no readable version — pinning to newest release tag ${plan.newest.tag})…`,
    );
    return detachOnto(deps, git, `refs/tags/${plan.newest.tag}`);
  }
  if (plan.kind === "no-higher-major") {
    deps.io.out(`no release above major ${plan.major} exists yet — nothing to cross to.`);
    return EXIT.OK;
  }
  if (plan.kind === "no-release") {
    deps.io.out(`no release of major ${plan.major} yet — leaving this checkout where it is.`);
    announceMajor(deps, plan.higher);
    return EXIT.OK;
  }
  if (plan.kind === "current") {
    deps.io.out(`already current — v${plan.at.version} is the newest release of major ${plan.at.major}.`);
    announceMajor(deps, plan.higher);
    return EXIT.OK;
  }
  deps.io.out(
    plan.crossesMajor
      ? `crossing to Collie ${plan.target.version} (--major given: consented)…`
      : `updating Collie (Herdr-managed checkout: fetch + detach onto ${plan.target.tag})…`,
  );
  const code = detachOnto(deps, git, `refs/tags/${plan.target.tag}`);
  if (code === EXIT.OK && !plan.crossesMajor) announceMajor(deps, plan.higher);
  return code;
}

/** Fetch `ref` and re-detach onto it, the way Herdr got this checkout here. */
function detachOnto(deps: UpdateDeps, git: (args: readonly string[]) => number, ref: string): number {
  const root = deps.ctx.root;
  // `--depth 1` ONLY when we are already shallow, so an update never truncates the history of a full
  // clone someone happens to have detached.
  const fetch = isShallow(deps.exec, root)
    ? ["fetch", "--depth", "1", "origin", ref]
    : ["fetch", "origin", ref];
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
 * Update to the newest release of the major this install is on: advance the checkout, then hand the
 * rest to the code we just fetched. `--major` — the whole consent, since a Herdr plugin action has no
 * TTY to prompt on (ADR 0020) — targets the next major instead.
 *
 * The handoff is the whole subtlety. The shell re-exec'd itself because bash reads a script by byte
 * offset and the pull rewrites that very file. A binary has the harder version of the problem: the
 * post-pull half must run the NEW build logic, and the new binary does not exist yet — `build` is
 * what produces it. So the re-exec target is the new checkout's SOURCE, run with Bun, which `build`
 * already requires and which is therefore not a new dependency. That build compiles the new
 * `bin/collie` and swaps it in; the restart that follows is what puts it into service.
 */
export async function cmdUpdate(deps: UpdateDeps, args: readonly string[] = []): Promise<number> {
  const advanced = updateCheckout(deps, { crossMajor: wantsMajor(args) });
  if (advanced !== EXIT.OK) return advanced;
  // The rebuild runs even when the checkout did not move: an update whose BUILD failed last time is
  // re-run by exactly this command, and skipping the handoff there would leave the fix on disk and
  // out of service forever.
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

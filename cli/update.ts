import { basename, dirname, join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import {
  type ApiTag,
  compareSemver,
  followsTrain,
  githubTagsUrl,
  majorOf,
  MANIFEST_SCHEMA_VERSION,
  parsePrereleaseTag,
  parseReleaseManifest,
  parseTagsResponse,
} from "../bridge/update.ts";
import { STALE_AFTER_MS, type UpdateRun } from "../bridge/update-run.ts";
import { manifestVersionFrom, readBuildInfo } from "../bridge/version.ts";
import { type BuildDeps, cmdBuild } from "./build.ts";
import { logFilePath } from "./lifecycle.ts";
import {
  binaryLayout,
  type BinaryLayout,
  detectInstall,
  gitArgs,
  isGitCheckout,
  isManagedCheckout,
  originOf,
  originMatches,
  updateRepoOf,
  DEFAULT_UPDATE_REPO,
} from "./install-kind.ts";
import type { Environment, EnvVars } from "./context.ts";
import { EXIT } from "./io.ts";
import { cmdLink, isCollieBinaryPath, type LinkReader, linkPath, type LinkWriter } from "./link.ts";
import type { Exec, Files, Net, NetFailure } from "./sys.ts";
import { collieBinary, unitName } from "./unit.ts";
import {
  driveApply,
  HEALTH_POLL_MS,
  HEALTH_TIMEOUT_ENV,
  healthProbe,
  probeConfigOf,
  probeTarget,
  healthTimeoutMs,
  idleRun,
  launchPlan,
  lockVerdict,
  readLock,
  readRun,
  reduce,
  releaseLock,
  serviceLogTail,
  takeLock,
  writeRun,
} from "./update-run.ts";

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
//
// SINCE M15/02 the first of those two shapes no longer advances in place: a linked clone STAGES its
// update into a `versions/vX.Y.Z` git worktree and goes live by flipping a `current` symlink, the
// same layout and the same single rename a binary install uses. ADR 0006's 2026-09-03 amendment
// records the change and scopes it: a Herdr-managed checkout keeps advancing in place. See "The
// staged checkout path" at the foot of this file.

export interface UpdateDeps extends BuildDeps {
  /** `restart` over the same context — injected because `update`'s own tests must never start a service. */
  restart: () => Promise<number>;
  /**
   * The symlink seam (`cli/link.ts`), which the binary path flips `current` with. The same writer
   * `link` publishes the PATH name through — one implementation of "make a symlink", never two.
   */
  link: LinkWriter;
  /** The two anonymous HTTPS GETs the binary path makes (`cli/sys.ts`). No test may reach a network. */
  net: Net;
  /** `process.platform` / `process.arch`, injected so a test pins a platform rather than inheriting
   *  the host's — the artifact this install may take is decided from them. */
  platform: string;
  arch: string;
  /** The clock and the wait the detached runner's health gate is driven by (M15/04). Injected for
   *  the same reason everything else here is: a test drives a 30 s budget in no time at all. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** This process's pid — what the update lock records and the staleness rule asks about. */
  pid: number;
  /** `process.execPath` — the binary THIS process is executing, and the one the detached runner is
   *  launched as. See {@link runnerBinary} for why it is not simply `<root>/bin/collie`. */
  execPath: string;
}

// One predicate for the checkout shape, one for "is this a git checkout at all", both in
// `cli/install-kind.ts` now that `doctor` asks them too. Re-exported because every caller and test
// already spells them `from "./update.ts"`.
export { isManagedCheckout };

/** The command that consents to a major crossing — printed wherever one is refused. */
export const MAJOR_ACTION = "herdr plugin action invoke update-major --plugin herdr.collie";

// ── Target selection (pure — ADR 0020) ───────────────────────────────────────
// A routine `update` no longer means "the tip of the default branch": it means "the newest RELEASE
// of the major this install is already on". Crossing a major is a separate act, consented to by
// `--major`. One amendment since (ADR 0020, 2026-08-30): an install whose OWN version carries a
// prerelease tail may also follow its major's prerelease train — but only as a FALLBACK, when no
// strict release of that major is newer than it. Beta to beta while the release is unpublished, then
// straight onto the release the moment it exists. That is a property of the installed version, not a
// flag, so there is no switch to get wrong and a stable install cannot be pulled onto a beta.
//
// Everything that decides WHICH commit to land on is a pure function over the remote's tag list, so
// `bun test` covers the whole decision without a git remote.

/** One `vX.Y.Z` or `vX.Y.Z-<tail>` tag, as the remote reports it. */
export interface ReleaseTag {
  /** The ref name (`v1.2.3`, `v1.0.0-beta.44`) — what we fetch by, because a bare sha may not be a
   *  valid want. A prerelease name needs no special handling downstream: `refs/tags/<tag>` is a ref
   *  like any other. */
  tag: string;
  /** Dotted version, no leading `v`. */
  version: string;
  major: number;
  /** The `-` tail (`beta.44`), or null for a strict release. A prerelease tag is a candidate ONLY for
   *  an install that itself carries a tail — see {@link planUpdate}. */
  prerelease: string | null;
  /** The commit the tag resolves to — the PEELED one for an annotated tag. */
  commit: string;
}

/** Just the strict releases. The candidate set for a stable install, for `--major`, and for pinning an
 *  unversioned checkout — none of those three ever touches a prerelease. */
const strictOnly = (tags: readonly ReleaseTag[]): ReleaseTag[] => tags.filter((t) => t.prerelease === null);

/**
 * Release AND prerelease tags out of `git ls-remote --tags origin`. Every non-version ref is dropped
 * by the same anchor the banner uses (`bridge/update.ts`'s `PRERELEASE_SEMVER_TAG`), so the verb can
 * never land on something the banner would not have announced. Which of these tags an install may
 * actually take is decided later, by {@link planUpdate}, from the INSTALLED version alone.
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
    if (parsePrereleaseTag(name) === null) continue;
    const seen = byTag.get(name);
    if (seen !== undefined && seen.peeled && !peeled) continue;
    byTag.set(name, { commit, peeled });
  }
  return [...byTag].flatMap(([tag, { commit }]) => {
    const parsed = parsePrereleaseTag(tag);
    if (parsed === null) return [];
    return [
      { tag, version: tag.slice(1), major: parsed.triple[0], prerelease: parsed.prerelease, commit },
    ];
  });
}

/** The highest tag among `tags` by full semver, or null when there is none. Filter FIRST — this does
 *  not know which of them the caller is allowed to take. */
export function highestRelease(tags: readonly ReleaseTag[]): ReleaseTag | null {
  let best: ReleaseTag | null = null;
  for (const t of tags) if (best === null || compareSemver(t.version, best.version) > 0) best = t;
  return best;
}

/** The highest STRICT release inside `major` — the target of a routine update on a stable install. */
export function releaseInMajor(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  return highestRelease(strictOnly(tags).filter((t) => t.major === major));
}

/**
 * The highest tag inside `major` counting PRERELEASES — the FALLBACK target for an install that is
 * itself on a prerelease and has no newer strict release of its major to take.
 *
 * The caller asks `followsTrain` first, so this is never what a stable install sees, and never what a
 * beta install sees once its release is out: the release supersedes the betas that led to it. This is
 * only how a tester walks beta.44 → beta.45 while `v1.0.0` does not exist yet.
 */
export function trainInMajor(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  return highestRelease(tags.filter((t) => t.major === major));
}

/**
 * The highest release of the NEXT major that has one — the target of `update --major`.
 *
 * The next major, not the highest: an install two majors behind crosses one at a time, so each
 * crossing is the one the operator consented to and its release notes are the ones that apply.
 */
export function nextMajorRelease(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  // Strict only: crossing a major lands on a RELEASE. A prerelease of the next major is not something
  // `--major` may hand an operator who has not opted into that train by installing one.
  const above = strictOnly(tags).filter((t) => t.major > major);
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
    return { kind: "unknown-version", newest: highestRelease(strictOnly(a.tags)) };
  }
  const higher = nextMajorRelease(a.tags, major);
  if (a.crossMajor) {
    return higher === null
      ? { kind: "no-higher-major", major }
      : { kind: "advance", target: higher, crossesMajor: true, higher };
  }
  // Prerelease-following is decided by the INSTALLED version, never by a flag — and the rule itself
  // lives in ONE place, `followsTrain`, which the banner reads too. A stable install is offered
  // strict releases only (unchanged, byte for byte). A prerelease install PREFERS strict releases as
  // well, and drops to its major's train only when no strict release there is newer than it.
  const strict = releaseInMajor(a.tags, major);
  const best = followsTrain(a.installed, strict?.version ?? null) ? trainInMajor(a.tags, major) : strict;
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

function isShallow(exec: Exec, root: string): boolean {
  const r = exec.capture("git", gitArgs(root, ["rev-parse", "--is-shallow-repository"]));
  return r.found && r.code === 0 && r.stdout.trim() === "true";
}

/**
 * The fork guard on the git paths: `origin` must be the repo updates are configured to come from.
 *
 * Both git strategies talk to a hardcoded `origin` and one of them force-checks-out onto its tags.
 * On a fork that reads the FORK's tags and `checkout --detach --force` discards local work — which
 * is exactly what happened to youngsecurity/collie at 0.35.0+ys.2. So the check runs BEFORE
 * `git fetch origin` and before `git ls-remote origin`, and a mismatch fails there: no fetch, no
 * checkout, nothing changed. An unresolvable origin is a mismatch too — a checkout that cannot say
 * where it came from is not one to force-checkout.
 *
 * The remedy is one line of consent, not a flag to disable the guard: a fork operator sets
 * `COLLIE_UPDATE_REPO` to their own fork, which moves the banner and the updater TOGETHER.
 */
function assertOrigin(deps: UpdateDeps, root: string = deps.ctx.root): boolean {
  const configured = updateRepoOf(deps.ctx.env);
  const origin = originOf(deps.exec, root);
  if (originMatches(origin, configured)) return true;
  const named =
    origin.kind === "repo"
      ? `github.com/${origin.repo}`
      : origin.kind === "other"
        ? origin.url
        : "unreadable (no `origin` remote, or no git)";
  deps.io.err(`error: this checkout's origin is ${named}, but updates are configured to`);
  deps.io.err(`       come from github.com/${configured}.`);
  deps.io.err("       `collie update` would fetch that remote's tags and force-checkout onto them,");
  deps.io.err("       discarding local work — it will not do that.");
  if (origin.kind === "repo") {
    deps.io.err(`       If you run a fork on purpose:      set COLLIE_UPDATE_REPO=${origin.repo}`);
  }
  deps.io.err('       To take an upstream release by hand: docs/upgrading.md → "You run a fork"');
  return false;
}

/** The version in the checkout's own `herdr-plugin.toml` — the installed major is read from here. */
function installedVersion(deps: UpdateDeps): string | null {
  return manifestVersionFrom(deps.files.read(join(deps.ctx.root, "herdr-plugin.toml")));
}

// The sentences a "nothing to take" verdict prints. They live here, once, because BOTH update paths
// print them — a user must not be able to tell the git path from the binary one by its wording
// (M14/01 §3.2 step 4).

function printNoHigherMajor(deps: UpdateDeps, major: number): void {
  deps.io.out(`no release above major ${major} exists yet — nothing to cross to.`);
}

function printNoRelease(deps: UpdateDeps, major: number, tail: string): void {
  deps.io.out(`no release of major ${major} yet — ${tail}.`);
}

function printCurrent(deps: UpdateDeps, at: ReleaseTag): void {
  deps.io.out(
    at.prerelease === null
      ? `already current — v${at.version} is the newest release of major ${at.major}.`
      : `already current — v${at.version} is the newest on the major ${at.major} prerelease train.`,
  );
}

/** Say a higher major is out, and name the one command that takes it. Never acts. */
function announceMajor(deps: UpdateDeps, higher: ReleaseTag | null): void {
  if (higher === null) return;
  deps.io.out(`note: Collie ${higher.version} is out — a NEW MAJOR, which a routine update never takes.`);
  deps.io.out(`      Read its release notes, then consent to it with:  ${MAJOR_ACTION}`);
}

/**
 * What advancing the checkout came to. `code` is the verb's exit status; the other two are what
 * `cmdUpdate` needs and cannot re-derive once the git calls are behind it.
 */
export interface CheckoutOutcome {
  /** {@link EXIT.OK} or {@link EXIT.FAIL} — unchanged from what this function used to return. */
  code: number;
  /**
   * True only when a commit actually landed. False for every "nothing to take" verdict, for a
   * refused major crossing, and for a `git pull --ff-only` that found nothing to fast-forward.
   * `cmdUpdate` skips the rebuild on false, so this must never be optimistic.
   */
  moved: boolean;
  /**
   * The next major's release, when one exists and we did not just take it — re-printed at the very
   * END of the transcript, which is the part the operator reads.
   */
  higher: ReleaseTag | null;
}

/**
 * Advance the checkout, in whichever shape it was installed — and never across a major without
 * `--major` (ADR 0020).
 *
 * The two shapes take the gate differently, because their targets are different things. A managed
 * checkout is detached, so it can be pointed straight at a release TAG and the gate is target
 * selection itself. A linked clone is on a branch and fast-forwards it, so its gate is a pre-flight:
 * fetch, read the manifest at the branch's OWN upstream, and refuse before pulling.
 *
 * IN-PLACE ADVANCEMENT, which since M15/02 is what a MANAGED checkout gets. `cmdUpdate` routes a
 * linked clone to {@link updateStagedCheckout} instead, so the linked arm below is reached only
 * through this exported function — kept because it is the whole of the branch-following behaviour
 * (including the manifest pre-flight that ADR 0020's major gate is spelled in), and spec 03's
 * preflight is expected to reuse it rather than re-derive it.
 */
export function updateCheckout(
  deps: UpdateDeps,
  opts: { crossMajor: boolean } = { crossMajor: false },
): CheckoutOutcome {
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
    return { code: EXIT.FAIL, moved: false, higher: null };
  }

  // BEFORE any fetch, and therefore before any `checkout --detach --force`. See {@link assertOrigin}.
  if (!assertOrigin(deps)) return { code: EXIT.FAIL, moved: false, higher: null };

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
): CheckoutOutcome {
  const root = deps.ctx.root;
  const headNow = (): string => deps.exec.capture("git", gitArgs(root, ["rev-parse", "HEAD"])).stdout.trim();
  const before = headNow();
  // Plain `git fetch origin` — the configured refspec, so every remote-tracking ref advances. NOT
  // `fetch origin HEAD`: that resolves the remote's DEFAULT branch, and the pull below takes the
  // current branch's own upstream. On a clone kept on a maintenance or integration branch those are
  // different commits, and a gate that judged one while the pull took the other would refuse a
  // fast-forward that never leaves the major (and, after 1.0 lands on `main`, would refuse EVERY
  // pull on a 0.x branch). Judge exactly the commit the pull will land on.
  if (git(["fetch", "origin"]) !== EXIT.OK) return { code: EXIT.FAIL, moved: false, higher: null };
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
      return { code: EXIT.OK, moved: false, higher: null };
    }
  }
  deps.io.out("updating Collie (git pull --ff-only)…");
  const code = git(["pull", "--ff-only"]);
  // A `--ff-only` pull that finds nothing to take succeeds and moves no commit — the linked-clone
  // spelling of "already current". Compare HEAD across the pull rather than parsing git's wording:
  // "Already up to date." is a translated, version-dependent sentence, and the sha is neither.
  return { code, moved: code === EXIT.OK && headNow() !== before, higher: null };
}

/**
 * A Herdr-managed checkout is detached, so `update` re-detaches it — onto the newest TAG of the major
 * it is on (prereleases counting only as a fallback, for an install that is on one), never onto
 * whatever the default branch says right now. A prerelease tag needs nothing special here: it is fetched as
 * `refs/tags/<tag>` like every other.
 */
function updateManaged(
  deps: UpdateDeps,
  git: (args: readonly string[]) => number,
  installed: string | null,
  crossMajor: boolean,
): CheckoutOutcome {
  const root = deps.ctx.root;
  const ls = deps.exec.capture("git", gitArgs(root, ["ls-remote", "--tags", "origin"]));
  if (!ls.found || ls.code !== 0) {
    deps.io.err("error: could not list the upstream release tags — is the remote reachable?");
    return { code: EXIT.FAIL, moved: false, higher: null };
  }
  const head = deps.exec.capture("git", gitArgs(root, ["rev-parse", "HEAD"])).stdout.trim();
  const plan = planUpdate({ tags: parseRemoteTags(ls.stdout), installed, head, crossMajor });

  if (plan.kind === "unknown-version") {
    // No readable version on disk: still take a RELEASE, never `origin HEAD`. A checkout that cannot
    // name its major cannot be gated on one — but "ungated" must not mean "whatever the default
    // branch points at today", which is unreleased work nobody consented to.
    if (plan.newest === null) {
      deps.io.err("error: no release tags on origin — cannot pin an unversioned checkout.");
      return { code: EXIT.FAIL, moved: false, higher: null };
    }
    deps.io.out(
      `updating Collie (Herdr-managed checkout: no readable version — pinning to newest release tag ${plan.newest.tag})…`,
    );
    const pinned = detachOnto(deps, git, plan.newest.tag);
    return { code: pinned, moved: pinned === EXIT.OK, higher: null };
  }
  if (plan.kind === "no-higher-major") {
    printNoHigherMajor(deps, plan.major);
    return { code: EXIT.OK, moved: false, higher: null };
  }
  if (plan.kind === "no-release") {
    printNoRelease(deps, plan.major, "leaving this checkout where it is");
    announceMajor(deps, plan.higher);
    return { code: EXIT.OK, moved: false, higher: plan.higher };
  }
  if (plan.kind === "current") {
    printCurrent(deps, plan.at);
    announceMajor(deps, plan.higher);
    return { code: EXIT.OK, moved: false, higher: plan.higher };
  }
  deps.io.out(
    plan.crossesMajor
      ? `crossing to Collie ${plan.target.version} (--major given: consented)…`
      : `updating Collie (Herdr-managed checkout: fetch + detach onto ${plan.target.tag})…`,
  );
  const code = detachOnto(deps, git, plan.target.tag);
  if (code === EXIT.OK && !plan.crossesMajor) announceMajor(deps, plan.higher);
  // A crossing just TOOK `higher`; naming it again at the end of the transcript would advertise the
  // release the operator is now standing on.
  return { code, moved: code === EXIT.OK, higher: plan.crossesMajor ? null : plan.higher };
}

/** Fetch the release tag `tag` and re-detach onto it, the way Herdr got this checkout here. */
function detachOnto(deps: UpdateDeps, git: (args: readonly string[]) => number, tag: string): number {
  const root = deps.ctx.root;
  const ref = `refs/tags/${tag}`;
  // An EXPLICIT, STORING refspec — `+<ref>:<ref>` — so the tag exists LOCALLY afterwards.
  //
  // This used to fetch the bare ref (`git fetch origin refs/tags/v1.0.0`). Git accepts that and
  // writes FETCH_HEAD, which is all the `checkout --detach FETCH_HEAD` below needs — and stores NO
  // local tag at all. So the checkout landed on the right commit and the local tag set never learned
  // it had, leaving `refs/tags/v<version>` in one of two states, neither of them the truth:
  //
  //   ABSENT — a checkout Herdr installed and only ever updated this way carries no tags at all.
  //     `web/vite.config.ts`'s `isReleaseBuild` runs `git rev-parse -q --verify` on the tag, that
  //     FAILS, and its catch path returns true — so the stamp comes out clean. The right answer,
  //     reached by a failure rather than by evidence: git still cannot say which release this is.
  //   STALE — a checkout that DOES carry a `v<version>` tag from some earlier fetch, pointing at an
  //     older commit. Now `isReleaseBuild` compares it against HEAD, they differ, and a genuine
  //     release is stamped `<version>-dev`. Measured in the VM lab on a guest whose clone carried an
  //     older `v1.0.0`: `collie version` → `1.0.0-dev+8d57cc8`. The PWA footer and the
  //     `X-Collie-Build` header then call a release a development build, and `cli/pack-update.ts`'s
  //     `answersThisBuild` reads the `-dev` tail as "not that commit" — so a pack member updated
  //     this way looks like it never took the push it did take.
  //
  // Storing the ref replaces absent-or-stale with true, in both shapes.
  // The leading `+` forces the update. It is the right sign HERE and only here: this function
  // already discards local work wholesale (see `--force` below), because a reinstall replaces the
  // managed checkout. A tag that was moved upstream must follow the same rule, or a re-cut release
  // would fail the fetch and strand the update on the old tag object.
  //
  // `--depth 1` ONLY when we are already shallow, so an update never truncates the history of a full
  // clone someone happens to have detached.
  const spec = `+${ref}:${ref}`;
  const fetch = isShallow(deps.exec, root)
    ? ["fetch", "--depth", "1", "origin", spec]
    : ["fetch", "origin", spec];
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
export function refreshRegistry(deps: UpdateDeps, at: string = deps.ctx.root): void {
  // `at` is the path Herdr should register, which on a STAGED checkout is the `current` symlink —
  // so a plugin action always runs the version that is live, not the one that happened to be live
  // when the link was made. Whether we may re-link at all is still decided from the checkout we are
  // running in: `git -C <current>` resolves into a detached worktree, which would read as managed
  // and skip the very re-link the staged path needs.
  if (deps.exec.which("herdr") === null) return;
  if (isManagedCheckout(deps.exec, deps.ctx.root)) {
    deps.io.out(
      "note: Herdr-managed install — registry left alone (re-linking would block `herdr plugin install`)",
    );
    return;
  }
  const r = deps.exec.capture("herdr", ["plugin", "link", at]);
  if (r.found && r.code === 0) {
    deps.io.out("herdr registry refreshed (re-linked) — new actions are invokable now");
    return;
  }
  deps.io.out("note: couldn't refresh the Herdr registry (is the Herdr server running?) —");
  deps.io.out(`      run: herdr plugin link "${at}"`);
}

/**
 * The version with its BUILD METADATA and its non-release marker taken off — `1.0.0-beta.46+ab12cd3`
 * and `1.0.0-beta.46-dev` both read as `1.0.0-beta.46`.
 *
 * Both tails have to go before the built bundle can be compared against the manifest. `+<sha>` is the
 * commit the bundle came from, which the manifest never carries. `-dev`/`-dirty` are `vite.config.ts`
 * saying "this bundle is not a tagged release" — true on a linked clone mid-development, and true on
 * any checkout whose local `v<version>` tag is STALE, and in NEITHER case evidence that the build is
 * of a different version. A prerelease tail (`-beta.46`) is part of the version and stays.
 */
const releaseCore = (v: string): string => (v.split("+")[0] ?? v).replace(/-(?:dev|dirty)$/, "");

/**
 * Is there a working Collie on disk built from the version the manifest names?
 *
 * This is the second half of the "nothing to take" decision. A no-op verdict alone must not skip the
 * rebuild, because the half-crossed checkout — detached onto the new tag with a build that failed —
 * reports exactly the same verdict on the re-run the operator was TOLD to make ("Fix the build and
 * re-run"). That path has to keep repairing, so anything short of a complete, matching install
 * builds anyway.
 *
 * Both facts are read through `bridge/version.ts`, the one place that parses either file.
 */
function installIsIntact(deps: UpdateDeps): boolean {
  const root = deps.ctx.root;
  if (!deps.files.exists(collieBinary(root))) return false;
  const manifest = manifestVersionFrom(deps.files.read(join(root, "herdr-plugin.toml")));
  const built = readBuildInfo(deps.files.read(join(root, "web", "dist", "build-info.json")));
  if (manifest === null || built === null) return false;
  return releaseCore(built) === releaseCore(manifest);
}

/**
 * The closing half of the major notice. The full two-line form prints where the decision is made,
 * near the TOP of a transcript that then runs two installs, two typechecks, a Vite build and a
 * restart — about seventy lines. What the operator reads is the tail, so the tail has to say it too:
 * one line, after the final status block, where the eye lands. This is the notice the whole 1.0
 * migration depends on.
 *
 * On the short path above the two may sit next to each other. That costs one line and is not worth a
 * special case.
 */
function closeWithMajor(deps: UpdateDeps, higher: ReleaseTag | null): void {
  if (higher === null) return;
  deps.io.out(`note: Collie ${higher.version} is out — a NEW MAJOR. Take it with:  ${MAJOR_ACTION}`);
}

/** The check is `hooks status --check`, which answers in milliseconds; a longer wait is a hang. */
const HOOKS_CHECK_TIMEOUT_MS = 5_000;

/**
 * The one line a successful update prints when the new build's beacon hooks are ahead of the
 * operator's `settings.json` — a registration this build added that their file does not carry.
 *
 * IT IS ASKED OF THE NEW BINARY, and that is the whole design. This process is the OLD build, and
 * its compiled-in `BEACON_HOOKS` is exactly the list that may have grown; an in-process check would
 * therefore be the one check guaranteed to miss the case it exists for. So the freshly installed
 * binary is spawned through the stable name that was just switched, and its EXIT CODE is the verdict
 * (`EXIT.STATE` = behind — `cli/hooks.ts`).
 *
 * Silent unless the answer is "behind". A machine with no beacon hooks installed opted out, and an
 * update is not the place to sell them; a complete install has nothing to say. Every other outcome —
 * a binary too old to know the flag, a spawn that fails, a settings file nobody can read — is
 * silence too. The update already succeeded, and no afterthought may take that back.
 */
function nudgeHooks(deps: UpdateDeps, binary: string): void {
  let r;
  try {
    r = deps.exec.capture(binary, ["hooks", "status", "--check"], HOOKS_CHECK_TIMEOUT_MS);
  } catch {
    // `capture` throws when the child cannot even start (ENOEXEC, EACCES) — spawn failure, silence.
    return;
  }
  if (!r.found || r.code !== EXIT.STATE) return;
  deps.io.out(
    "note: this build registers beacon hooks your settings do not carry yet —" +
      " run `collie hooks install claude` to add them.",
  );
}

/**
 * The second half of `update`, run FROM THE CODE THAT WAS JUST FETCHED. `build` re-runs the version
 * gate (a half-bumped release can't go live) and recompiles both the binary and `web/dist`;
 * `restart` picks up the new bridge AND the new binary (the swap gave `bin/collie` a fresh inode,
 * so the still-running service keeps executing the old one until it is restarted); `refreshRegistry`
 * re-links so Herdr learns any newly added actions.
 */
export async function cmdApplyUpdate(deps: UpdateDeps, args: readonly string[] = []): Promise<number> {
  // TWO VERBS UNDER ONE NAME, told apart by `--to`. With it, this is the DETACHED RUNNER of M15/04:
  // it flips a staged version live, restarts, polls the health gate and rolls back once. Without it,
  // it is the original post-pull half below — the in-place second stage a Herdr-managed checkout
  // still takes (ADR 0006), which builds in the tree it is standing in and has nothing to flip.
  const apply = parseApplyArgs(args);
  if (apply !== null) return await runApply(deps, apply);
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
  // `build` just wrote this binary from the code we are running, so it is the new list, not ours.
  nudgeHooks(deps, collieBinary(deps.ctx.root));
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
  // The fork on install kind, and the ONLY one. Every path below it is the path that kind's shape
  // supports: a git checkout advances and rebuilds; a binary install fetches, verifies and flips a
  // symlink; an install we cannot name does neither, and says so rather than guessing (M14/01 §3.1).
  const install = detectInstall(deps);
  const isCheckout = install.kind === "linked-clone" || install.kind === "detached-checkout";
  // WHICH CHECKOUT STAGES. A checkout already living under a `versions/` layout stages, whatever its
  // HEAD says — a staged version IS a detached worktree, so reading `git symbolic-ref` there would
  // route every second update back into the in-place path it just left. A checkout that is not under
  // the layout stages only when it is a LINKED CLONE: a Herdr-managed checkout keeps ADR 0006's
  // in-place advancement for this milestone (see that ADR's 2026-09-03 amendment).
  const staged = isCheckout && (underVersions(deps.ctx.root) || install.kind === "linked-clone");
  const layout = isCheckout ? layoutForCheckout(deps.ctx.root) : null;
  // The record, not the act — `--status` reads `<state dir>/update.json` and touches nothing, so it
  // is answered before the lock, before the install kind matters and before any network call.
  if (wantsStatus(args)) return cmdUpdateStatus(deps, args);
  if (args.includes("--rollback")) {
    if (install.kind === "binary") return await rollbackBinary(deps);
    if (staged && layout !== null) return await rollbackCheckout(deps, layout);
    deps.io.err("error: `--rollback` flips the `current` symlink back to the previous version, and this");
    deps.io.err("       install has no `versions/` layout to flip inside — a Herdr-managed checkout");
    deps.io.err("       advances in place (ADR 0006), so there is no previous version on disk.");
    deps.io.err("       Take a specific release with `git checkout v<version>` and rebuild.");
    return EXIT.FAIL;
  }
  if (install.kind === "binary") return await updateBinary(deps, args);
  if (install.kind === "unknown") {
    deps.io.err(`error: cannot tell how this Collie was installed (${unknownEvidence(deps, install.why)}).`);
    deps.io.err("       `collie update` will not guess. A git checkout refreshes with:");
    deps.io.err("       herdr plugin install AltanS/collie --yes");
    deps.io.err("       A downloaded install — and a staged checkout — lives under a `versions/` layout");
    deps.io.err("       with a `current` symlink beside it; see docs/install.md.");
    return EXIT.FAIL;
  }
  if (staged && layout !== null) return await updateStagedCheckout(deps, layout, args);
  const advanced = updateCheckout(deps, { crossMajor: wantsMajor(args) });
  if (advanced.code !== EXIT.OK) return advanced.code;
  // Nothing was taken AND what is on disk is whole: stop here. This used to fall through, so
  // "already current" and "nothing to cross to" were each followed by two installs, two typechecks,
  // a full Vite build and a bridge restart — minutes of work and a service interruption for a no-op,
  // ending on `✓ update complete`, which contradicted the verb's own first line.
  //
  // The rebuild is still unconditional when the install is NOT intact. An update whose build failed
  // leaves the checkout advanced with no binary, and the recovery the operator is told to run is this
  // very command — which by then reports "already current", because the checkout really did move. So
  // the verdict alone may never be what skips the build.
  if (!advanced.moved && installIsIntact(deps)) {
    closeWithMajor(deps, advanced.higher);
    return EXIT.OK;
  }
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
  if (!r.found || r.code !== 0) return EXIT.FAIL;
  // `_apply-update` ran as a child with our own stdio, so its `✓ update complete` is already on the
  // screen. This lands after it — the last line of the transcript.
  closeWithMajor(deps, advanced.higher);
  return EXIT.OK;
}

// ── The binary install path (M14/01 §3) ──────────────────────────────────────
// A binary install has no `.git` to pull and nothing to compile: it is a versioned directory and a
// symlink. `<root>/versions/X.Y.Z/` holds a complete payload (the compiled binary, `web/dist`, the
// manifest, `package.json`, `.env.example`, `docs/`), and `<root>/current` is a RELATIVE symlink at
// exactly one of them. An update lays a new version down beside the old one and flips that symlink;
// two atomic renames, and the previous version is still on disk afterwards, which is what makes
// `--rollback` almost free.
//
// The running bridge is pinned to the version directory it was started from — `process.execPath` is
// realpath-resolved, so `resolvePluginRoot` returns `versions/X.Y.Z`, never `current` — so it keeps
// serving its own `web/dist` until the restart. There is no instant at which a new binary serves an
// old bundle or the reverse (`cli/install-kind.test.ts` pins that assumption).
//
// Nothing here re-execs. `cmdUpdate`'s `_apply-update` handoff exists because the source path must
// run the NEW build logic and the new binary does not exist yet; here nothing is compiled and the
// old binary can perform every step.

/**
 * GitHub's `/tags` payload → the same `ReleaseTag[]` {@link parseRemoteTags} produces from
 * `git ls-remote --tags`. Same anchor (`parsePrereleaseTag`), so a tag the banner would not announce
 * is a tag this can never land on, and everything downstream — `planUpdate`, `compareSemver`,
 * `followsTrain`, `releaseInMajor`, `trainInMajor` — is the code the git paths already run.
 */
export function parseApiTags(tags: readonly ApiTag[]): ReleaseTag[] {
  return tags.flatMap((t) => {
    const name = t.name.trim();
    const parsed = parsePrereleaseTag(name);
    if (parsed === null) return [];
    return [
      {
        tag: name,
        version: name.slice(1),
        major: parsed.triple[0],
        prerelease: parsed.prerelease,
        commit: t.sha,
      },
    ];
  });
}

/**
 * The canonical platform id for a running process, or null where Collie publishes no artifact.
 * `linux-x64` ships as Bun's BASELINE target: the default requires AVX2 and dies with SIGILL on
 * older hardware, which is exactly the hardware a self-hosted tool lives on, and Collie is I/O-bound
 * so the baseline penalty is not observable here.
 */
export function platformId(platform: string, arch: string): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  return os === null || cpu === null ? null : `${os}-${cpu}`;
}

/** `collie-<version>.manifest.json` — CONSTRUCTED from the version, never read from a document. */
export const manifestAssetName = (version: string): string => `collie-${version}.manifest.json`;

/** A release asset's URL, built from (repo, tag, name) alone — see `parseReleaseManifest`'s header
 *  on why the manifest carries no URLs of its own. */
export const releaseAssetUrl = (repo: string, tag: string, name: string): string =>
  `https://github.com/${repo}/releases/download/${tag}/${name}`;

/** The evidence line `doctor` and the refusal above both quote for an install we cannot name. */
function unknownEvidence(deps: UpdateDeps, why: "no-marker" | "orphan-layout" | "loose-binary"): string {
  const root = deps.ctx.root;
  switch (why) {
    case "no-marker":
      return `no herdr-plugin.toml at ${root}`;
    case "orphan-layout":
      return `a versions/ layout at ${binaryLayout(root).installRoot} with no \`current\` symlink`;
    case "loose-binary":
      // NOT "neither a checkout nor a layout": a staged checkout is BOTH, so the either/or would be
      // read as a rule rather than as the two absent shapes it actually reports.
      return `${root} has no .git of its own and no versions/ layout above it`;
  }
}

/** One sentence for a failed HTTPS GET, with the rate limit named because it is the likely one. */
function netError(deps: UpdateDeps, what: string, failure: NetFailure): void {
  if (failure.status === 403 || failure.status === 429) {
    deps.io.err(`error: GitHub rate-limited ${what} (HTTP ${failure.status}). Wait an hour, or follow`);
    deps.io.err("       docs/upgrading.md. Nothing was changed.");
    return;
  }
  if (failure.status !== null) {
    deps.io.err(`error: ${what} failed (HTTP ${failure.status}). Nothing was changed.`);
    return;
  }
  deps.io.err(`error: could not reach github.com — ${what} failed (${failure.message}). Nothing was changed.`);
}

/** Everything under `.staging`, and everything in `.trash`. A killed update leaves scratch; entering
 *  with a clean one costs nothing and removes a class of half-state. */
function sweepScratch(deps: UpdateDeps, layout: BinaryLayout): void {
  deps.files.removeTree(layout.stagingDir);
  for (const entry of deps.files.list(layout.trashDir)) {
    deps.files.removeTree(join(layout.trashDir, entry));
  }
}

/** Move a version directory out of the way before it is deleted, so a half-deleted tree can never be
 *  mistaken for an installable version. */
function toTrash(deps: UpdateDeps, layout: BinaryLayout, version: string): void {
  deps.files.mkdirp(layout.trashDir);
  const held = join(layout.trashDir, `${version}.${Date.now().toString(36)}`);
  deps.files.rename(join(layout.versionsDir, version), held);
  deps.files.removeTree(held);
}

/** The versions on disk that are actually installable — a readable version name AND a binary. */
function installedVersions(deps: UpdateDeps, layout: BinaryLayout): string[] {
  return listVersions(deps, layout, "binary")
    .filter((v) => v.complete)
    .map((v) => v.version);
}

/**
 * The version directory `current` names, or null when it points nowhere we laid down. Exported
 * because `doctor` reports the same fact and may not derive it a second way.
 */
export function currentVersionDir(deps: { readonly link: LinkReader }, layout: BinaryLayout): string | null {
  const probe = deps.link.probe(layout.currentLink);
  if (probe.kind !== "symlink") return null;
  const name = basename(probe.target);
  return name === "" ? null : name;
}

/**
 * Point `current` at `versions/<dir>` with ONE rename. `rename(2)` replaces the existing symlink
 * atomically, so no window exists in which `current` is absent — which is why the new link is built
 * beside it under a scratch name first. The target is RELATIVE, so the whole install root stays
 * movable.
 *
 * THE ONLY SWAP IN THIS MODULE, and both install kinds go through it: a binary install flips to a
 * downloaded payload directory (`versions/1.2.3`), a staged checkout to a git worktree
 * (`versions/v1.2.3`) — so `dir` is a directory NAME, never a parsed version. A second
 * implementation would be a second thing to get atomic.
 */
function flipCurrent(deps: UpdateDeps, layout: BinaryLayout, version: string): boolean {
  const staged = join(layout.installRoot, ".current.new");
  try {
    deps.link.remove(staged);
    deps.link.symlink(join("versions", version), staged);
    deps.files.rename(staged, layout.currentLink);
    return true;
  } catch (err) {
    deps.io.err(`error: could not point ${layout.currentLink} at versions/${version} — ${String(err)}`);
    return false;
  }
}

/** The design's 20 s bound on the smoke test: `version` answers in milliseconds, so a binary still
 *  silent after this long is not slow, it is hung — and a hung candidate must FAIL the smoke, not
 *  hang the update with it. */
const SMOKE_TIMEOUT_MS = 20_000;

/** `<dir>/bin/collie version` must exit 0, name `version`, and answer within the bound. This is
 *  where a wrong architecture, a truncated payload, a Gatekeeper refusal and a hang all surface. */
function smoke(deps: UpdateDeps, dir: string, version: string): boolean {
  const r = deps.exec.capture(join(dir, "bin", "collie"), ["version"], SMOKE_TIMEOUT_MS);
  return r.found && r.code === 0 && r.stdout.includes(version);
}

/**
 * `collie update` on a binary install: fetch the release tags, plan with the SAME pure functions the
 * git paths use, download and verify the platform artifact, lay it down, flip, restart, verify, and
 * only then collect old versions.
 */
async function updateBinary(deps: UpdateDeps, args: readonly string[]): Promise<number> {
  const layout = binaryLayout(deps.ctx.root);
  const repo = updateRepoOf(deps.ctx.env);
  // 1. A redirected updater is never silent — the repo IS the trust boundary on this path.
  if (repo !== DEFAULT_UPDATE_REPO) deps.io.out(`update source: github.com/${repo} (COLLIE_UPDATE_REPO)`);
  const platform = platformId(deps.platform, deps.arch);
  if (platform === null) {
    deps.io.err("error: Collie publishes no release artifact for this platform.");
    deps.io.err("       Update by pulling and rebuilding a checkout — see docs/install.md.");
    return EXIT.FAIL;
  }
  // 2. Sweep scratch before anything else.
  sweepScratch(deps, layout);

  // 3. One HTTPS GET. Never a second endpoint, never a guessed version.
  const tagsResponse = await deps.net.getJson(githubTagsUrl(repo));
  if (!tagsResponse.ok) {
    netError(deps, "the release check", tagsResponse.failure);
    return EXIT.FAIL;
  }
  // SAFETY: `Net.getJson` hands back what `Response.json()` produced, which IS a JsonValue by
  // construction; `parseTagsResponse` checks every field it keeps.
  const tags = parseApiTags(parseTagsResponse(tagsResponse.value as JsonValue));

  // 4. The same plan the git paths make. `head: ""` is correct rather than a fudge: a binary install
  //    has no checked-out commit, so `planUpdate`'s commit arm must never fire and the VERSION
  //    comparison decides — which is the right question for an install whose identity IS its version.
  const installed = installedVersion(deps);
  const plan = planUpdate({ tags, installed, head: "", crossMajor: wantsMajor(args) });
  if (plan.kind === "no-higher-major") {
    printNoHigherMajor(deps, plan.major);
    return EXIT.OK;
  }
  if (plan.kind === "no-release") {
    printNoRelease(deps, plan.major, "leaving this install where it is");
    announceMajor(deps, plan.higher);
    return EXIT.OK;
  }
  if (plan.kind === "current") {
    printCurrent(deps, plan.at);
    announceMajor(deps, plan.higher);
    return EXIT.OK;
  }
  const target = plan.kind === "unknown-version" ? plan.newest : plan.target;
  if (target === null) {
    deps.io.err(`error: github.com/${repo} publishes no release tags — there is nothing to install.`);
    return EXIT.FAIL;
  }
  const higher = plan.kind === "advance" && !plan.crossesMajor ? plan.higher : null;
  deps.io.out(
    plan.kind === "advance" && plan.crossesMajor
      ? `crossing to Collie ${target.version} (--major given: consented)…`
      : `updating Collie (binary install: ${target.tag} for ${platform})…`,
  );

  // 5. The manifest, and this platform's artifact inside it.
  const manifestUrl = releaseAssetUrl(repo, target.tag, manifestAssetName(target.version));
  const manifestResponse = await deps.net.getJson(manifestUrl);
  if (!manifestResponse.ok) {
    netError(deps, `the release manifest for ${target.version}`, manifestResponse.failure);
    return EXIT.FAIL;
  }
  // SAFETY: as above — a parsed JSON document, and `parseReleaseManifest` checks every field.
  const verdict = parseReleaseManifest(manifestResponse.value as JsonValue);
  if (!verdict.ok) {
    if (verdict.reason === "schema") {
      deps.io.err(
        `error: this Collie cannot read release ${target.version}'s manifest (schemaVersion ` +
          `${verdict.schemaVersion}; this build understands ${MANIFEST_SCHEMA_VERSION}).`,
      );
      deps.io.err("       Reinstall to get an updater that can: curl -fsSL https://colliepwa.dev/install.sh | sh");
      return EXIT.FAIL;
    }
    deps.io.err(`error: release ${target.version}'s manifest could not be read. Nothing was changed.`);
    return EXIT.FAIL;
  }
  const artifact = verdict.manifest.artifacts.find((a) => a.platform === platform);
  if (artifact === undefined) {
    deps.io.err(`error: release ${target.version} publishes no artifact for ${platform}.`);
    deps.io.err('       Build from source instead: docs/install.md → "From source". Nothing was changed.');
    return EXIT.FAIL;
  }

  // 6. Download into scratch — same filesystem as `versions/`, so every rename below is a real one.
  const tarball = join(layout.stagingDir, artifact.name);
  deps.files.mkdirp(layout.stagingDir);
  const got = await deps.net.download(releaseAssetUrl(repo, target.tag, artifact.name), tarball);
  if (!got.ok) {
    deps.files.removeTree(layout.stagingDir);
    netError(deps, `downloading ${artifact.name}`, got.failure);
    return EXIT.FAIL;
  }
  // 7. Verify. Hard fail, and there is no flag to skip it.
  if (got.sha256 !== artifact.sha256 || (artifact.size !== null && got.size !== artifact.size)) {
    deps.files.removeTree(layout.stagingDir);
    deps.io.err(`error: checksum mismatch for ${artifact.name}`);
    deps.io.err(`       expected ${artifact.sha256}  got ${got.sha256}`);
    deps.io.err("       The download was discarded. Nothing was changed. If this repeats, report it —");
    deps.io.err("       a mismatch is either a corrupt download or something worse.");
    return EXIT.FAIL;
  }

  // 8. Lay down: extract, check the payload is whole, then ONE rename into `versions/<version>`.
  const unpacked = join(layout.stagingDir, "x");
  deps.files.mkdirp(unpacked);
  const untar = deps.exec.capture("tar", ["-xzf", tarball, "-C", unpacked]);
  if (!untar.found || untar.code !== 0) {
    deps.files.removeTree(layout.stagingDir);
    deps.io.err(`error: could not unpack ${artifact.name}${untar.found ? "" : " — tar is not installed"}.`);
    deps.io.err("       Nothing was changed.");
    return EXIT.FAIL;
  }
  const payload = join(unpacked, artifact.payloadRoot);
  const required = ["bin/collie", "web/dist/index.html", "herdr-plugin.toml", "package.json"];
  const missing = required.filter((rel) => !deps.files.exists(join(payload, ...rel.split("/"))));
  if (missing.length > 0) {
    deps.files.removeTree(layout.stagingDir);
    deps.io.err(`error: ${artifact.name} is not a complete Collie payload (missing ${missing.join(", ")}).`);
    deps.io.err("       Nothing was changed.");
    return EXIT.FAIL;
  }
  // tar carries the mode, and every runner that builds one sets it — but a umask or a re-packed
  // archive can still land a non-executable binary, and the cost of being sure is one call.
  deps.exec.capture("chmod", ["0755", join(payload, "bin", "collie")]);
  const laid = join(layout.versionsDir, target.version);
  if (deps.files.exists(laid)) toTrash(deps, layout, target.version);
  deps.files.mkdirp(layout.versionsDir);
  deps.files.rename(payload, laid);
  deps.files.removeTree(layout.stagingDir);

  // 9. Smoke BEFORE the flip: nothing the operator can see has moved yet.
  if (!smoke(deps, laid, target.version)) {
    toTrash(deps, layout, target.version);
    deps.io.err(`error: ${target.version} did not run here (\`collie version\` failed before the swap).`);
    deps.io.err(`       Nothing was changed — this install is still ${installed ?? "where it was"}.`);
    return EXIT.FAIL;
  }

  // 10. HAND OFF — the same runner the staged checkout uses, because the flip is already the same
  //     single rename for both kinds (M15/04). It flips, restarts through `current`, polls
  //     `/api/health` until the new version answers, rolls back once if it does not, and only then
  //     collects the old versions. Nothing below this line runs in this process.
  const previous = currentVersionDir(deps, layout);
  const handed = handOff(deps, layout, {
    to: target.version,
    from: previous,
    version: target.version,
    commit: target.commit,
    kind: "binary",
  });
  if (handed !== EXIT.OK) return handed;
  closeWithMajor(deps, higher);
  return EXIT.OK;
}

/**
 * Keep `current` plus the newest older versions, and remove the rest. Two hard guards, checked per
 * candidate: never the target of `current`, and never the directory the running updater is executing
 * from. A failure here is a warning — a successful update must not report failure because a stale
 * directory was busy.
 */
function collectOldVersions(deps: UpdateDeps, layout: BinaryLayout, keepVersion: string): void {
  const asked = Number.parseInt(deps.ctx.env.COLLIE_KEEP_VERSIONS ?? "", 10);
  const keep = Number.isFinite(asked) && asked >= 1 ? asked : 2;
  // Newest first, the version just installed excluded — it is `current` and is retained by
  // definition, so `keep` counts it and the list below holds only the ones that follow it.
  const candidates = installedVersions(deps, layout)
    .filter((v) => v !== keepVersion)
    .toReversed();
  const guards = new Set([keepVersion, layout.version, currentVersionDir(deps, layout) ?? keepVersion]);
  const doomed = candidates.slice(Math.max(0, keep - 1)).filter((v) => !guards.has(v));
  for (const v of doomed) {
    try {
      toTrash(deps, layout, v);
    } catch (err) {
      deps.io.out(`note: could not remove the old version ${v} (${String(err)}) — it is harmless where it is.`);
    }
  }
}

/**
 * `collie update --rollback` — no network, no manifest, no tags. The version list on disk IS the
 * record; nothing is written to a state file.
 *
 * GC never runs here: the version just rolled away from is the one the operator is most likely to
 * want back once the bug is understood.
 */
async function rollbackBinary(deps: UpdateDeps): Promise<number> {
  const layout = binaryLayout(deps.ctx.root);
  const at = currentVersionDir(deps, layout) ?? layout.version;
  const older = installedVersions(deps, layout).filter((v) => compareSemver(v, at) < 0);
  const target = older[older.length - 1];
  if (target === undefined) {
    deps.io.err(`error: nothing to roll back to — ${at} is the only version installed.`);
    return EXIT.FAIL;
  }
  deps.io.out(`rolling back ${at} → ${target}…`);
  if (!flipCurrent(deps, layout, target)) return EXIT.FAIL;
  const restarted = await deps.restart();
  if (restarted !== EXIT.OK || !smoke(deps, layout.currentLink, target)) {
    // Roll FORWARD again to where this started, and say so: a rollback that half-lands is worse than
    // one that never happened.
    flipCurrent(deps, layout, at);
    await deps.restart();
    deps.io.err(`error: ${target} did not come up — rolled forward to ${at} again. Nothing was changed.`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ rolled back to ${target}`);
  return EXIT.OK;
}

// ── The staged checkout path (M15/02) ────────────────────────────────────────
// A checkout stops mutating itself in place. ONE layout serves both install kinds:
//
//   <install-root>/versions/v1.2.3/   a git WORKTREE of the release tag, built inside itself
//   <install-root>/current            a RELATIVE symlink at one of them, flipped by `flipCurrent`
//
// Every version shares the one `.git`, so a version costs a checkout of the tree and not a second
// object store. The running install is untouched for the whole build: a failure never moved
// `current`, which is the skew hazard ADR 0006 was written against and could only mitigate while an
// update advanced the live tree (its 2026-09-03 amendment records the swap).
//
// The install root of a MIGRATED checkout is the clone itself — `versions/` and `current` are
// created inside it, and the original tree stays the main worktree that owns `.git`. After the first
// staged update the running binary is `<install-root>/versions/vX.Y.Z/bin/collie`, so
// `bridge/root.ts` resolves the WORKTREE as the plugin root, exactly as a binary install resolves
// its version directory (`process.execPath` is realpath-resolved, so `current` is never the answer).
// That is the mirror the spec asks for, and it is why `binaryLayout` re-derives the same five paths
// from a staged checkout with no special case.
//
// Herdr-managed checkouts do NOT stage in this milestone: they are detached and shallow, their root
// is Herdr's own plugin directory, and re-registering them is what ADR 0006 forbids.

/** The completeness marker a finished build writes LAST into its version directory. */
export const BUILD_MARKER = ".collie-build";

/**
 * How many version directories a staged checkout keeps: `current` plus the two newest previous ones.
 * The count includes `current`, because "keep 3" is the sentence an operator can check against
 * `ls versions/`.
 */
export const KEEP_VERSIONS = 3;

/** What {@link BUILD_MARKER} carries — the version the build produced, and the commit it came from. */
export interface BuildMarker {
  readonly version: string;
  readonly commit: string;
}

/**
 * The versions layout of a checkout that has not been staged yet: the clone itself is the install
 * root. {@link binaryLayout} derives the same five paths from a version DIRECTORY, which is what the
 * running process sits in once the layout exists; this derives them from the root above it.
 */
export function checkoutLayout(installRoot: string): BinaryLayout {
  return {
    installRoot,
    versionsDir: join(installRoot, "versions"),
    currentLink: join(installRoot, "current"),
    stagingDir: join(installRoot, ".staging"),
    trashDir: join(installRoot, ".trash"),
    version: "",
  };
}

/** Does `root` sit at `<install-root>/versions/<name>` — i.e. is this install already staged? */
function underVersions(root: string): boolean {
  return basename(dirname(root)) === "versions";
}

/** The layout a checkout at `root` updates under, whether it has been migrated yet or not. */
function layoutForCheckout(root: string): BinaryLayout {
  return underVersions(root) ? binaryLayout(root) : checkoutLayout(root);
}

/** `<dir>/.collie-build`. */
const markerPath = (dir: string): string => join(dir, BUILD_MARKER);

/**
 * The marker a staged version carries, or null when it has none or it cannot be read as one.
 *
 * A malformed marker is the SAME answer as a missing one on purpose: both mean "no evidence this
 * build ran to the end", and the flip refuses on either.
 */
export function readBuildMarker(deps: { readonly files: Files }, dir: string): BuildMarker | null {
  const text = deps.files.read(markerPath(dir));
  if (text === null) return null;
  let doc: { version?: string; commit?: string };
  try {
    // SAFETY: `JSON.parse` answers a JSON value, and these are the only two fields ever read off it.
    // Neither is trusted: `version` is compared against the version being flipped to and a
    // mismatch — including a field that is not a string at all — is a refusal, and `commit` is only
    // ever printed.
    doc = JSON.parse(text) as { version?: string; commit?: string };
  } catch {
    return null;
  }
  const version = doc.version ?? "";
  if (version === "") return null;
  return { version, commit: doc.commit ?? "" };
}

/**
 * Write the marker — the LAST thing a successful build does, which is the whole design. A marker
 * present means every step before it finished, so a killed build, a full disk or a half-copied
 * directory is a REFUSAL at the flip rather than a symlink pointing at rubble.
 */
function writeBuildMarker(deps: UpdateDeps, dir: string, marker: BuildMarker): void {
  deps.files.write(markerPath(dir), `${JSON.stringify(marker, null, 2)}\n`);
}

/** One version directory under `versions/`, in the two spellings the two install kinds use. */
export interface VersionOnDisk {
  /** The directory name — `v1.2.3` on a staged checkout (the tag), `1.2.3` on a binary install. */
  readonly dir: string;
  /** The dotted version inside it. */
  readonly version: string;
  /**
   * Is this version usable? The evidence differs by kind because what a complete version IS differs:
   * a downloaded payload is complete when it carries the binary that was verified before it was laid
   * down, a staged checkout when its build wrote {@link BUILD_MARKER} as its last act.
   */
  readonly complete: boolean;
}

/**
 * Every version directory under `versions/`, oldest first — the ONE lister, for both install kinds
 * and for `doctor` as well as `update`. A name that is not a version is ignored rather than guessed
 * at: `.staging`, a stray note, an operator's backup copy.
 */
export function listVersions(
  deps: { readonly files: Files },
  layout: BinaryLayout,
  kind: "binary" | "checkout",
): VersionOnDisk[] {
  return deps.files
    .list(layout.versionsDir)
    .flatMap((dir) => {
      if (parsePrereleaseTag(kind === "checkout" ? dir : `v${dir}`) === null) return [];
      const at = join(layout.versionsDir, dir);
      const complete =
        kind === "checkout"
          ? readBuildMarker(deps, at) !== null
          : deps.files.exists(join(at, "bin", "collie"));
      return [{ dir, version: kind === "checkout" ? dir.slice(1) : dir, complete }];
    })
    .toSorted((a, b) => compareSemver(a.version, b.version));
}

/** The staged versions of a checkout install — {@link listVersions} under its own name. */
const stagedVersions = (deps: { readonly files: Files }, layout: BinaryLayout): VersionOnDisk[] =>
  listVersions(deps, layout, "checkout");

/** The staged version `current` names, or null when it names nothing we laid down. */
function stagedCurrent(deps: UpdateDeps, layout: BinaryLayout): VersionOnDisk | null {
  const at = currentVersionDir(deps, layout);
  if (at === null) return null;
  return stagedVersions(deps, layout).find((v) => v.dir === at) ?? null;
}

/** Why a flip was refused, in the words the operator reads. */
type FlipVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The gate in front of {@link flipCurrent} on a staged checkout: the marker must be there, and it
 * must name the version being flipped to. Every refusal is NAMED — a symlink that did not move for
 * an unexplained reason is the one outcome worse than not flipping at all.
 */
function flipToStaged(deps: UpdateDeps, layout: BinaryLayout, v: VersionOnDisk): FlipVerdict {
  const marker = readBuildMarker(deps, join(layout.versionsDir, v.dir));
  if (marker === null) {
    return { ok: false, reason: `${v.dir} carries no ${BUILD_MARKER} — its build never ran to the end` };
  }
  if (marker.version !== v.version) {
    return { ok: false, reason: `${v.dir}'s ${BUILD_MARKER} names ${marker.version}, not ${v.version}` };
  }
  if (!flipCurrent(deps, layout, v.dir)) return { ok: false, reason: `${layout.currentLink} could not be moved` };
  return { ok: true };
}

/** `git worktree prune` — the administrative half of removing a worktree DIRECTORY. */
function worktreePrune(deps: UpdateDeps, root: string): void {
  deps.exec.capture("git", gitArgs(root, ["worktree", "prune"]));
}

/**
 * Remove one staged version, directory and administrative entry together. Both halves, always: a
 * removed directory leaves git's `worktrees/<name>` record behind, and a stale record makes the next
 * `worktree add` of the same name fail with "already registered".
 */
function removeStagedVersion(deps: UpdateDeps, layout: BinaryLayout, dir: string, git: string): void {
  deps.files.removeTree(join(layout.versionsDir, dir));
  worktreePrune(deps, git);
}

/**
 * Keep the newest `keep` version directories — `current` among them, whatever its age — and remove
 * the rest.
 *
 * **`update` does not call this, and that is deliberate.** Pruning during staging would destroy the
 * rollback target of the very update that is about to need it. The order is stage, flip, restart,
 * health passes, *then* prune — and the health gate is spec 04, which is what will call this. Until
 * it exists a staged checkout accumulates versions, which is the safe direction to be wrong in.
 *
 * Returns the directory names removed, so the caller can report them.
 */
export function pruneVersions(
  deps: UpdateDeps,
  layout: BinaryLayout,
  keep: number = KEEP_VERSIONS,
): string[] {
  const git = deps.ctx.root;
  const at = currentVersionDir(deps, layout);
  const newestFirst = stagedVersions(deps, layout).toReversed();
  // `current` is retained by definition and counts against `keep`, so it is taken out of the
  // ordering first and the survivors are the newest `keep - 1` of what is left.
  const others = newestFirst.filter((v) => v.dir !== at);
  const doomed = at === null ? others.slice(keep) : others.slice(Math.max(0, keep - 1));
  const removed: string[] = [];
  for (const v of doomed) {
    try {
      removeStagedVersion(deps, layout, v.dir, git);
      removed.push(v.dir);
    } catch (err) {
      deps.io.out(`note: could not remove ${v.dir} (${String(err)}) — it is harmless where it is.`);
    }
  }
  return removed;
}

/**
 * Restart THROUGH `current`, with the binary the flip just published.
 *
 * This process is the OLD version, and its `restart` would rewrite the service unit from ITS OWN
 * root — pinning the supervisor to the version we just left, which would make the flip cosmetic. So
 * the new binary restarts the service, exactly as the hooks nudge asks the new binary about hooks:
 * the stable name is the one that was switched.
 */
function restartThroughCurrent(deps: UpdateDeps, layout: BinaryLayout): boolean {
  const r = deps.exec.runIn(join(layout.currentLink, "bin", "collie"), ["restart"], layout.installRoot);
  return r.found && r.code === 0;
}

/**
 * Re-point the PATH name at `current` when it still names the pre-migration tree's binary.
 *
 * ADR 0021's rule survives the migration only if the pointer follows: `~/.local/bin/collie` was
 * published at `<clone>/bin/collie`, and after the first staged update the live binary is behind
 * `current`. Touched ONLY when the name is this install's own — `cmdLink` is the one implementation
 * of publishing it, and a name pointing at somebody else's checkout stays theirs.
 */
function republishName(deps: UpdateDeps, root: string, previousBinary: string): void {
  const at = linkPath(deps.ctx.home);
  const probe = deps.link.probe(at);
  if (probe.kind !== "symlink" || probe.target !== previousBinary) return;
  if (!isCollieBinaryPath(probe.target)) return;
  cmdLink({ ctx: { ...deps.ctx, root }, io: deps.io, files: deps.files, fs: deps.link });
}

/** Fetch one release tag and STORE it locally — the refspec `detachOnto` explains at length. */
function fetchTag(deps: UpdateDeps, root: string, tag: string): boolean {
  const ref = `refs/tags/${tag}`;
  const spec = `+${ref}:${ref}`;
  const args = isShallow(deps.exec, root)
    ? ["fetch", "--depth", "1", "origin", spec]
    : ["fetch", "origin", spec];
  const r = deps.exec.runIn("git", gitArgs(root, args), root);
  if (!r.found) {
    deps.io.err("error: git not found — cannot stage a version");
    return false;
  }
  return r.code === 0;
}

/**
 * `collie update` on a checkout that stages: resolve the target tag, add a worktree for it, build
 * INSIDE that worktree, mark it complete, and only then flip `current`.
 *
 * Nothing the operator can see moves until the flip, so every failure below it is a no-op that names
 * the stage it failed at.
 */
async function updateStagedCheckout(
  deps: UpdateDeps,
  layout: BinaryLayout,
  args: readonly string[],
): Promise<number> {
  const root = deps.ctx.root;
  // Every git call runs against the checkout we are RUNNING in. A worktree shares the repository, so
  // `ls-remote`, `fetch`, `worktree add` and `worktree prune` are all answered the same from any of
  // them — and using our own root means a migration and a re-stage spell it identically.
  const git = root;
  const migrating = !underVersions(root);

  if (!isGitCheckout(deps.exec, git)) {
    deps.io.err(`error: ${git} is not a git checkout — refresh it with:`);
    deps.io.err("       herdr plugin install AltanS/collie --yes");
    return EXIT.FAIL;
  }
  // BEFORE any fetch. See {@link assertOrigin}: a fork's tags are not this install's to take.
  if (!assertOrigin(deps, git)) return EXIT.FAIL;

  const ls = deps.exec.capture("git", gitArgs(git, ["ls-remote", "--tags", "origin"]));
  if (!ls.found || ls.code !== 0) {
    deps.io.err("error: could not list the upstream release tags — is the remote reachable?");
    return EXIT.FAIL;
  }
  const installed = installedVersion(deps);
  const head = deps.exec.capture("git", gitArgs(root, ["rev-parse", "HEAD"])).stdout.trim();
  const plan = planUpdate({ tags: parseRemoteTags(ls.stdout), installed, head, crossMajor: wantsMajor(args) });

  if (plan.kind === "no-higher-major") {
    printNoHigherMajor(deps, plan.major);
    return EXIT.OK;
  }
  if (plan.kind === "no-release") {
    printNoRelease(deps, plan.major, "leaving this checkout where it is");
    announceMajor(deps, plan.higher);
    return EXIT.OK;
  }
  // "Nothing to take" ends the verb only when what is on disk is whole. On a staged install that
  // means `current` resolves to a COMPLETE version; on one that has not migrated yet it is the same
  // question `installIsIntact` already answers, and answering it that way is what keeps an update
  // with nothing to take from staging a version nobody asked for. A half-staged install falls
  // through and re-stages the version it failed on, which is the recovery the operator is told to
  // run.
  const whole = migrating ? installIsIntact(deps) : stagedCurrent(deps, layout)?.complete === true;
  if (plan.kind === "current" && whole) {
    printCurrent(deps, plan.at);
    announceMajor(deps, plan.higher);
    return EXIT.OK;
  }
  const target = plan.kind === "current" ? plan.at : plan.kind === "unknown-version" ? plan.newest : plan.target;
  if (target === null) {
    deps.io.err("error: no release tags on origin — cannot stage an unversioned checkout.");
    return EXIT.FAIL;
  }
  // A crossing just TOOK `higher`; naming it again at the end of the transcript would advertise the
  // release the operator is now standing on. An unversioned checkout has no major to compare against.
  const higher =
    plan.kind === "unknown-version" || (plan.kind === "advance" && plan.crossesMajor) ? null : plan.higher;

  if (deps.exec.which("bun") === null) {
    deps.io.err("error: bun not found — staging a version builds it, and that needs Bun.");
    deps.io.err("       Install it from https://bun.sh and re-run update. Nothing was changed.");
    return EXIT.FAIL;
  }
  deps.io.out(
    plan.kind === "advance" && plan.crossesMajor
      ? `crossing to Collie ${target.version} (--major given: consented)…`
      : `updating Collie (staged checkout: building ${target.tag} beside the running version)…`,
  );
  if (migrating) {
    deps.io.out(`  first staged update: ${layout.versionsDir} and ${layout.currentLink} are created now.`);
  }

  // 1. The tag, stored locally — a worktree is added from a ref, and the ref has to exist here.
  if (!fetchTag(deps, git, target.tag)) {
    deps.io.err(`error: update stopped at the FETCH stage — ${target.tag} could not be fetched.`);
    deps.io.err("       Nothing was staged and nothing was swapped.");
    return EXIT.FAIL;
  }

  // 2. The worktree. A leftover directory of the same name is removed first: it is either a killed
  //    stage or the version we are re-staging after a failed build, and neither is `current`.
  const dir = target.tag;
  const at = join(layout.versionsDir, dir);
  if (currentVersionDir(deps, layout) === dir) {
    // The target is already live. This is not the `plan.kind === "current"` case above — that one is
    // decided from the manifest of the version we are RUNNING, and an install whose root still
    // names the pre-flip tree (a stale `COLLIE_PLUGIN_ROOT`, an operator running the old binary by
    // hand) reads as behind while `current` is not. Re-staging it would remove the running install.
    if (stagedCurrent(deps, layout)?.complete === true) {
      deps.io.out(`already current — ${dir} is staged and \`current\` points at it.`);
      announceMajor(deps, higher);
      return EXIT.OK;
    }
    deps.io.err(`error: ${dir} is what \`current\` points at, and it is incomplete — re-staging it`);
    deps.io.err("       would remove the running install. Roll back first, or remove it by hand.");
    return EXIT.FAIL;
  }
  if (deps.files.exists(at)) removeStagedVersion(deps, layout, dir, git);
  deps.files.mkdirp(layout.versionsDir);
  const added = deps.exec.runIn(
    "git",
    gitArgs(git, ["worktree", "add", "--detach", "--force", at, `refs/tags/${target.tag}`]),
    git,
  );
  if (!added.found || added.code !== 0) {
    deps.io.err(`error: update stopped at the STAGE stage — \`git worktree add ${at}\` failed.`);
    deps.io.err("       Nothing was swapped; the running version is untouched.");
    worktreePrune(deps, git);
    return EXIT.FAIL;
  }

  // 3. The build, INSIDE the worktree and from the NEW source — the same handoff reason the in-place
  //    path re-execs for: the build logic that must run is the one that was just fetched.
  const built = deps.exec.runIn("bun", [join(at, "cli", "main.ts"), "build"], at);
  if (!built.found || built.code !== 0) {
    deps.io.err(`error: update stopped at the BUILD stage — ${target.tag} did not build.`);
    deps.io.err("       `current` never moved: the running bridge and the served UI are unchanged.");
    deps.io.err("       The failed version was removed. Fix the build and re-run update.");
    removeStagedVersion(deps, layout, dir, git);
    return EXIT.FAIL;
  }

  // 4. The marker, LAST — the evidence the flip demands.
  writeBuildMarker(deps, at, { version: target.version, commit: target.commit });

  // 5. HAND OFF. The flip, the restart, the health gate and the one rollback all happen in the
  //    DETACHED RUNNER (M15/04) — this process may not do them, because the restart would kill the
  //    bridge that quite possibly asked for this update, and a killed updater cannot roll back.
  const previous = stagedCurrent(deps, layout);
  const handed = handOff(deps, layout, {
    to: dir,
    from: previous?.dir ?? null,
    version: target.version,
    commit: target.commit,
    kind: "checkout",
  });
  if (handed !== EXIT.OK) return handed;
  deps.io.out(
    previous === null
      ? "  nothing to roll back to yet — this was the first staged version, so a failed health check" +
          " has no target to flip back to."
      : `  a failed health check flips back to ${previous.dir} by itself.`,
  );
  closeWithMajor(deps, higher);
  return EXIT.OK;
}

/**
 * `collie update --rollback` on a staged checkout — the checkout half of {@link rollbackBinary}, and
 * the same act: flip `current` back to the newest retained previous version. No network, no build;
 * the version directories on disk ARE the record.
 *
 * Nothing is pruned here either — the version rolled away from is the one the operator is most
 * likely to want back once the bug is understood.
 */
async function rollbackCheckout(deps: UpdateDeps, layout: BinaryLayout): Promise<number> {
  const at = stagedCurrent(deps, layout);
  const kept = stagedVersions(deps, layout).filter((v) => v.complete);
  if (at === null) {
    deps.io.err(`error: nothing to roll back to — ${layout.currentLink} points at no version this`);
    deps.io.err(`       checkout staged. ${kept.length === 0 ? "No version has been staged yet: the next `collie update` creates the first." : "Re-run `collie update` to stage one."}`);
    return EXIT.FAIL;
  }
  const older = kept.filter((v) => compareSemver(v.version, at.version) < 0);
  const target = older[older.length - 1];
  if (target === undefined) {
    deps.io.err(`error: nothing to roll back to — ${at.dir} is the only complete version this checkout`);
    deps.io.err("       kept. A previous version is retained by the update that replaces it, so the");
    deps.io.err("       first staged version has none, and a pruned one is gone for good.");
    return EXIT.FAIL;
  }
  deps.io.out(`rolling back ${at.dir} → ${target.dir}…`);
  const flip = flipToStaged(deps, layout, target);
  if (!flip.ok) {
    deps.io.err(`error: ${flip.reason} — nothing was changed.`);
    return EXIT.FAIL;
  }
  if (!restartThroughCurrent(deps, layout)) {
    // Roll FORWARD again: a rollback that half-lands is worse than one that never happened.
    flipToStaged(deps, layout, at);
    restartThroughCurrent(deps, layout);
    deps.io.err(`error: ${target.dir} did not come up — rolled forward to ${at.dir} again. Nothing was changed.`);
    return EXIT.FAIL;
  }
  refreshRegistry(deps, layout.currentLink);
  deps.io.out(`✓ rolled back to ${target.version}`);
  return EXIT.OK;
}

// ── The detached updater (M15/04) ────────────────────────────────────────────
// An update is TWO PROCESSES, and the split is forced by step three of it: restart the service. The
// bridge IS the service, so a bridge that drove its own update would be killed halfway through —
// nobody left to notice the new version never answered, nobody left to flip `current` back.
//
// So `collie update` stages, and then HANDS OFF. The runner (`_apply-update --to …`) flips, restarts,
// polls `/api/health` and rolls back once if it has to; the machine it runs is `cli/update-run.ts`,
// a pure reducer over injected effects. Everything it knows goes into `<state dir>/update.json`,
// which the bridge reads at startup and the standby door serves while the main port is down.

/**
 * The binary the detached runner is launched as: the one THIS process is executing.
 *
 * Not `<root>/bin/collie`, and the difference is real. A Collie run through the PATH name, or from a
 * clone that has not been built in place, is executing a binary that path does not name — and
 * launching a file that is not there is a handoff that never happens. The fallback is for the one
 * case where `execPath` is NOT a collie: `bun cli/main.ts`, the bootstrap path, where the binary the
 * checkout owns is the right answer.
 */
function runnerBinary(deps: UpdateDeps): string {
  return isCollieBinaryPath(deps.execPath) ? deps.execPath : collieBinary(deps.ctx.root);
}

/** The one thing an operator is told to run, and it is a path, not a verb — `current` may be wrong. */
function recoveryCommand(layout: BinaryLayout, from: string | null): string {
  if (from === null) return "collie update  (there is no previous version on disk to flip back to)";
  return `${join(layout.versionsDir, from, "bin", "collie")} update --rollback`;
}

/** What the runner was asked to do, parsed out of its own argv. */
export interface ApplyArgs {
  /** The version DIRECTORY to make live — `v1.2.3` on a staged checkout, `1.2.3` on a binary install. */
  readonly to: string;
  /** The version directory to fall back to, or null when this install has none yet. */
  readonly from: string | null;
  /** The dotted version `to` must answer with, and the commit it was built from (may be ""). */
  readonly version: string;
  readonly commit: string;
  readonly kind: "checkout" | "binary";
  /** The pid of the process that staged this run and wrote the lock — see {@link handOff}. */
  readonly handoff: number;
}

const flagValue = (args: readonly string[], name: string): string | null => {
  const at = args.indexOf(name);
  return at < 0 ? null : (args[at + 1] ?? null);
};

/**
 * The runner's argv, or null when this is the OLD `_apply-update` — the in-place second half a
 * Herdr-managed checkout still takes (ADR 0006), which stages nothing and has nothing to flip.
 */
export function parseApplyArgs(args: readonly string[]): ApplyArgs | null {
  const to = flagValue(args, "--to");
  if (to === null || to === "") return null;
  const from = flagValue(args, "--from");
  return {
    to,
    from: from === null || from === "" ? null : from,
    version: flagValue(args, "--version") ?? "",
    commit: flagValue(args, "--commit") ?? "",
    kind: flagValue(args, "--kind") === "binary" ? "binary" : "checkout",
    handoff: Number.parseInt(flagValue(args, "--handoff") ?? "", 10) || 0,
  };
}

/** {@link ApplyArgs} back as argv — one spelling, so the handoff and the parser can never drift. */
export function applyArgv(a: ApplyArgs): string[] {
  return [
    "_apply-update",
    "--to",
    a.to,
    ...(a.from === null ? [] : ["--from", a.from]),
    "--version",
    a.version,
    "--commit",
    a.commit,
    "--kind",
    a.kind,
    "--handoff",
    String(a.handoff),
  ];
}

/**
 * The environment the detached runner is started with.
 *
 * A NARROW, NAMED list, and that is the point on the `systemd-run` path: `--setenv=` puts a value on
 * a command line every process on the box can read out of `ps`. None of these is a credential — they
 * are the instance's identity and its paths. Everything else the runner needs it re-reads from the
 * same `.env` this process did (`cli/context.ts`), which is where the secrets stay.
 */
export const RUNNER_ENV_KEYS = [
  "HOME",
  "PATH",
  "XDG_RUNTIME_DIR",
  "COLLIE_INSTANCE",
  // The multiplexer this install mirrors. The runner RESTARTS the service, and `restart` refuses to
  // guess a mux — so a runner without it dies on a question nobody is there to answer.
  "COLLIE_MUX",
  "COLLIE_CONFIG_DIR",
  "COLLIE_STATE_DIR",
  "COLLIE_PLUGIN_ROOT",
  "COLLIE_PORT",
  "COLLIE_KEEP_VERSIONS",
  HEALTH_TIMEOUT_ENV,
] as const;

export function runnerEnv(env: Environment): EnvVars {
  const out: EnvVars = {};
  for (const key of RUNNER_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/** The lock's verdict for this install, with the pid liveness question answered by the process table. */
function updateLockVerdict(deps: UpdateDeps): ReturnType<typeof lockVerdict> {
  const held = readLock(deps.files, deps.ctx.stateDir);
  const alive = held !== null && deps.exec.processCommand(held.pid) !== null;
  return lockVerdict(held, deps.now(), alive, STALE_AFTER_MS);
}

/** The record on disk as of now, or null — the staleness rule applied through the process table. */
function currentRun(deps: UpdateDeps): UpdateRun | null {
  return readRun(deps.files, deps.ctx.stateDir, deps.now(), (pid) => deps.exec.processCommand(pid) !== null);
}

/**
 * Stage is done: write `staging`, launch the runner with its own lifetime, and get out of the way.
 *
 * This function does not flip and does not restart. It exits 0 the moment the child is away, because
 * the thing it just started is going to kill this process's own service — and on a Herdr action or
 * an `/api/update` call, quite possibly this process's own parent.
 */
function handOff(deps: UpdateDeps, layout: BinaryLayout, a: Omit<ApplyArgs, "handoff">): number {
  const verdict = updateLockVerdict(deps);
  if (!verdict.ok) {
    deps.io.err(`error: ${verdict.reason}.`);
    deps.io.err("       Watch it with `collie update --status`; a run whose updater is gone stops");
    deps.io.err(`       blocking a retry ${Math.round(STALE_AFTER_MS / 60_000)} minutes after its last transition.`);
    return EXIT.FAIL;
  }
  const now = deps.now();
  takeLock(deps.files, deps.ctx.stateDir, deps.pid, now);
  const staging = reduce(
    reduce(idleRun(now), { kind: "begin", from: a.from, to: a.to, pid: deps.pid }, now),
    { kind: "stage" },
    now,
  );
  writeRun(deps.files, deps.ctx.stateDir, staging);

  const plan = launchPlan({
    platform: deps.platform,
    binary: runnerBinary(deps),
    args: applyArgv({ ...a, handoff: deps.pid }),
    unit: unitName(deps.ctx.instance),
    stamp: now.toString(36),
    hasSystemdRun: deps.exec.which("systemd-run") !== null,
    hasSetsid: deps.exec.which("setsid") !== null,
  });
  const pid = deps.exec.spawnDetached(plan.command, {
    cwd: layout.installRoot,
    env: runnerEnv(deps.ctx.env),
    logPath: logFilePath(deps.ctx.configDir, deps.ctx.instance),
  });
  if (pid === null) {
    releaseLock(deps.files, deps.ctx.stateDir);
    writeRun(deps.files, deps.ctx.stateDir, reduce(staging, { kind: "abort", reason: plan.note }, deps.now()));
    deps.io.err("error: the update was staged, but the detached updater could not be started.");
    deps.io.err(`       Nothing was swapped. Apply it by hand: ${runnerBinary(deps)} ${applyArgv({ ...a, handoff: 0 }).join(" ")}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ ${a.to} is staged — ${plan.note}.`);
  deps.io.out("  The swap, the restart and the health check run there, so this command is done.");
  deps.io.out("  Watch it with: collie update --status");
  return EXIT.OK;
}

/**
 * `collie update --status` — the record, read out loud. `--json` prints it verbatim for a script.
 *
 * It reads the same file, through the same staleness rule, that the bridge and the standby door do,
 * so the terminal and the phone can never tell two different stories about one run.
 */
export function cmdUpdateStatus(deps: UpdateDeps, args: readonly string[]): number {
  const run = currentRun(deps);
  if (args.includes("--json")) {
    deps.io.out(JSON.stringify(run, null, 2));
    return EXIT.OK;
  }
  if (run === null) {
    deps.io.out("no update has run on this install yet.");
    return EXIT.OK;
  }
  const target = run.to ?? "?";
  const heading =
    run.state === "done"
      ? `✓ updated to ${target}`
      : run.state === "rolled-back"
        ? `rolled back to ${run.from ?? "the previous version"} — ${target} did not come up`
        : run.state === "stuck"
          ? `STUCK — ${target} did not come up and neither did the rollback`
          : run.state === "interrupted"
            ? `interrupted — the updater is gone and ${target} was mid-flight`
            : `${run.state} — ${run.from ?? "?"} → ${target}`;
  deps.io.out(heading);
  deps.io.out(`  started ${new Date(run.startedAt).toISOString()}, last moved ${new Date(run.updatedAt).toISOString()}`);
  if (run.reason !== undefined) deps.io.out(`  reason: ${run.reason}`);
  if (run.recovery !== undefined) deps.io.out(`  recover with: ${run.recovery}`);
  if (run.logTail !== undefined && run.logTail !== "") {
    deps.io.out("  last lines of the service log:");
    for (const line of run.logTail.split("\n")) deps.io.out(`    ${line}`);
  }
  return run.state === "stuck" ? EXIT.FAIL : EXIT.OK;
}

/** `--status` anywhere in the verb's argv. */
export const wantsStatus = (args: readonly string[]): boolean => args.includes("--status");

/**
 * The runner proper: flip, restart, verify, roll back once. Everything impure is an effect handed to
 * {@link driveApply}, which is where the machine lives.
 */
async function runApply(deps: UpdateDeps, a: ApplyArgs): Promise<number> {
  const layout = a.kind === "binary" ? binaryLayout(deps.ctx.root) : layoutForCheckout(deps.ctx.root);
  const stateDir = deps.ctx.stateDir;
  // The lock this run inherits is the one the staging process took (`--handoff <pid>`). Any other
  // holder is somebody else's run and refuses us, exactly as it refuses a second `collie update`.
  const held = readLock(deps.files, stateDir);
  if (held !== null && held.pid !== a.handoff) {
    const verdict = updateLockVerdict(deps);
    if (!verdict.ok) {
      deps.io.err(`error: ${verdict.reason} — this runner will not touch \`current\`.`);
      return EXIT.FAIL;
    }
  }
  takeLock(deps.files, stateDir, deps.pid, deps.now());

  const onDisk = currentRun(deps);
  const start: UpdateRun =
    onDisk !== null && onDisk.state === "staging"
      ? { ...onDisk, pid: deps.pid }
      : reduce(
          reduce(idleRun(deps.now()), { kind: "begin", from: a.from, to: a.to, pid: deps.pid }, deps.now()),
          { kind: "stage" },
          deps.now(),
        );

  const flipTo = (dir: string): boolean =>
    a.kind === "binary"
      ? flipCurrent(deps, layout, dir)
      : flipToStaged(deps, layout, { dir, version: dir.replace(/^v/, ""), complete: true }).ok;

  const run = await driveApply(
    {
      flip: flipTo,
      // Through `current`, for BOTH install kinds. This process is the OLD version, and its own
      // `restart` would rewrite the unit from its own root — pinning the supervisor to the version
      // the flip just left, which would make the flip cosmetic.
      restart: () => Promise.resolve(restartThroughCurrent(deps, layout)),
      // Not "loopback and the front-door port": a wide bind and a peer's TLS-pinned listener are
      // both real, and both make that URL the wrong door (`cli/update-run.ts` → `probeTarget`).
      health: healthProbe(
        deps.net,
        probeTarget(probeConfigOf(deps.ctx.env, deps.files, deps.ctx.stateDir, deps.ctx.port)),
      ),
      prune: () => {
        if (a.kind === "binary") collectOldVersions(deps, layout, a.to);
        else pruneVersions(deps, layout);
      },
      logTail: () =>
        serviceLogTail(deps, unitName(deps.ctx.instance), logFilePath(deps.ctx.configDir, deps.ctx.instance)),
      now: deps.now,
      sleep: deps.sleep,
      write: (record) => writeRun(deps.files, stateDir, record),
      timeoutMs: healthTimeoutMs(deps.ctx.env),
      pollMs: HEALTH_POLL_MS,
    },
    { to: a.to, from: a.from, version: a.version, commit: a.commit, recovery: recoveryCommand(layout, a.from) },
    start,
  );
  releaseLock(deps.files, stateDir);

  if (run.state === "done") {
    // The two names that must follow a flip, and the nudge that must be asked of the NEW binary.
    if (a.kind === "checkout") {
      if (!underVersions(deps.ctx.root)) {
        republishName(deps, join(layout.versionsDir, a.to), collieBinary(deps.ctx.root));
      }
      refreshRegistry(deps, layout.currentLink);
    }
    deps.io.out(`✓ updated to ${a.version === "" ? a.to : a.version}`);
    nudgeHooks(deps, join(layout.currentLink, "bin", "collie"));
    return EXIT.OK;
  }
  if (run.state === "rolled-back") {
    deps.io.err(`error: ${a.to} did not pass its health check — rolled back to ${a.from ?? "?"}.`);
    deps.io.err(`       ${run.reason ?? "no reason recorded"}`);
    return EXIT.FAIL;
  }
  deps.io.err(`error: ${a.to} did not come up, and neither did the rollback. Nothing will restart again.`);
  deps.io.err(`       ${run.reason ?? "no reason recorded"}`);
  deps.io.err(`       Recover with: ${run.recovery ?? recoveryCommand(layout, a.from)}`);
  return EXIT.FAIL;
}

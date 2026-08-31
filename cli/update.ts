import { basename, join } from "node:path";

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
import { manifestVersionFrom, readBuildInfo } from "../bridge/version.ts";
import { type BuildDeps, cmdBuild } from "./build.ts";
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
import { EXIT } from "./io.ts";
import type { LinkWriter } from "./link.ts";
import type { Exec, Net, NetFailure } from "./sys.ts";
import { collieBinary } from "./unit.ts";

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
function assertOrigin(deps: UpdateDeps): boolean {
  const configured = updateRepoOf(deps.ctx.env);
  const origin = originOf(deps.exec, deps.ctx.root);
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
 * selection itself. A linked clone is on a branch and keeps fast-forwarding it (detaching it onto a
 * tag would undo its shape, and re-linking it is what ADR 0006 forbids for managed installs), so its
 * gate is a pre-flight: fetch, read the manifest at the branch's OWN upstream, and refuse before
 * pulling.
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
  // The fork on install kind, and the ONLY one. Every path below it is the path that kind's shape
  // supports: a git checkout advances and rebuilds; a binary install fetches, verifies and flips a
  // symlink; an install we cannot name does neither, and says so rather than guessing (M14/01 §3.1).
  const install = detectInstall(deps);
  if (args.includes("--rollback")) {
    if (install.kind !== "binary") {
      deps.io.err("error: `--rollback` is a binary install's verb — it flips the `current` symlink back to");
      deps.io.err("       the previous version, and a git checkout has no such thing.");
      deps.io.err("       On a checkout, take a specific release with `git checkout v<version>` and rebuild.");
      return EXIT.FAIL;
    }
    return await rollbackBinary(deps);
  }
  if (install.kind === "binary") return await updateBinary(deps, args);
  if (install.kind === "unknown") {
    deps.io.err(`error: cannot tell how this Collie was installed (${unknownEvidence(deps, install.why)}).`);
    deps.io.err("       `collie update` will not guess. A git checkout refreshes with:");
    deps.io.err("       herdr plugin install AltanS/collie --yes");
    deps.io.err("       A downloaded install lives under a `versions/` layout — see docs/install.md.");
    return EXIT.FAIL;
  }
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
      return `${root} is neither a git checkout nor a versions/ layout`;
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
  return deps.files
    .list(layout.versionsDir)
    .filter((name) => parsePrereleaseTag(`v${name}`) !== null)
    .filter((name) => deps.files.exists(join(layout.versionsDir, name, "bin", "collie")))
    .sort((a, b) => compareSemver(a, b));
}

/** The version `current` points at, or null when it points nowhere we laid down. */
function currentVersion(deps: UpdateDeps, layout: BinaryLayout): string | null {
  const probe = deps.link.probe(layout.currentLink);
  if (probe.kind !== "symlink") return null;
  const name = basename(probe.target);
  return name === "" ? null : name;
}

/**
 * Point `current` at `versions/<version>` with ONE rename. `rename(2)` replaces the existing symlink
 * atomically, so no window exists in which `current` is absent — which is why the new link is built
 * beside it under a scratch name first. The target is RELATIVE, so the whole install root stays
 * movable.
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

/** `<dir>/bin/collie version` must exit 0 and name `version`. This is where a wrong architecture, a
 *  truncated payload and a Gatekeeper refusal all surface.
 *
 *  The design's 20 s bound is not expressible through the `Exec` seam (`Bun.spawnSync` takes no
 *  timeout), so a binary that HANGS on `version` hangs the update instead of failing it. Recorded
 *  here rather than papered over; every other failure mode is caught. */
function smoke(deps: UpdateDeps, dir: string, version: string): boolean {
  const r = deps.exec.capture(join(dir, "bin", "collie"), ["version"]);
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

  // 10-11. Flip, then restart. The old bridge served its own pinned version until this moment.
  const previous = currentVersion(deps, layout);
  if (!flipCurrent(deps, layout, target.version)) return EXIT.FAIL;
  const restarted = await deps.restart();

  // 12. Verify after the flip, through `current` this time. Either failure rolls back.
  const live = smoke(deps, layout.currentLink, target.version);
  if (restarted !== EXIT.OK || !live) {
    if (previous === null || !flipCurrent(deps, layout, previous)) {
      deps.io.err(`error: ${target.version} failed its post-install check and there is no previous version`);
      deps.io.err(`       to fall back to. ${layout.currentLink} points at ${target.version}.`);
      return EXIT.FAIL;
    }
    await deps.restart();
    deps.io.err(`error: ${target.version} failed its post-install check — rolled back to ${previous}.`);
    deps.io.err(`       Your Collie is running ${previous} again. The failure output is above.`);
    return EXIT.FAIL;
  }

  // 13. GC, only now, and never fatally.
  collectOldVersions(deps, layout, target.version);
  deps.io.out(`✓ updated to ${target.version}`);
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
    .reverse();
  const guards = new Set([keepVersion, layout.version, currentVersion(deps, layout) ?? keepVersion]);
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
  const at = currentVersion(deps, layout) ?? layout.version;
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

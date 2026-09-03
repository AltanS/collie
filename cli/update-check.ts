import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import { PackOpsStore } from "../bridge/pack/ops-store.ts";
import { TrustStore, type TrustedMember, type TrustStoreData } from "../bridge/pack/trust-store.ts";
import { compareSemver, githubTagsUrl, parseTagsResponse } from "../bridge/update.ts";
import { collieVersionBare, manifestVersionFrom } from "../bridge/version.ts";
import { loadContext, type CliContext } from "./context.ts";
import { cmdDoctor, doctorDeps } from "./doctor.ts";
import type { Finding } from "./finding.ts";
import {
  binaryLayout,
  classifyInstall,
  gitArgs,
  type InstallKind,
  originMatches,
  originOf,
  probeInstall,
  updateRepoOf,
} from "./install-kind.ts";
import { EXIT, type Io } from "./io.ts";
import { type LinkReader, realLinkFs } from "./link.ts";
import { agentFilePath, unitFilePath, unitName } from "./unit.ts";
import { supervisionTier } from "./lifecycle.ts";
import {
  type RemoteResult,
  type RemoteRunner,
  runProbe,
  shqPath,
  sshRunner,
} from "./remote.ts";
import { realExec, realFiles, realNet, type Exec, type Files, type Net } from "./sys.ts";
import { MAJOR_ACTION, parseApiTags, parseRemoteTags, planUpdate, type ReleaseTag } from "./update.ts";

// `collie update --check` — the read-only preflight (M15/03).
//
// ── IT ANSWERS ONE QUESTION AND CHANGES NOTHING ──────────────────────────────
// "Can an update succeed here right now?" Nothing in this module writes a file, restarts a unit,
// flips `current`, fetches into a checkout or touches config. Every probe is a read, which is what
// makes it safe to poll from the phone (spec 05) and safe to ask before a pack flow acts (spec 06).
// The rule is structural, the same way `cli/doctor.ts` enforces it: the deps below name no
// lifecycle verb, no writer and no mutating store method, so there is nothing here to call.
//
// ── IT RE-USES, IT DOES NOT RE-DERIVE ────────────────────────────────────────
// The target is `cli/update.ts`'s own planner (`planUpdate` over `parseRemoteTags`/`parseApiTags`),
// the install kind is `cli/install-kind.ts`'s, the per-instance diagnosis is `collie doctor`'s
// findings, and a member is reached with `cli/remote.ts`'s probe script over the operator's ssh
// (ADR 0016). A second implementation of a probe is a second thing to drift.
//
// ── EVERY RED NAMES ITS REASON ───────────────────────────────────────────────
// `cli/doctor.ts` argues this twice in its own comments: a warning that fires on a healthy host
// trains the operator to ignore it. So a red here is specific — it names the files, the host, the
// unit or the remote — and anything merely worth knowing (version skew, an unusual install kind, a
// major that is out) is AMBER, which never blocks.

/** The JSON contract's version. Bumped only when a consumer would have to change to read it. */
export const PREFLIGHT_SCHEMA = 1;

export type Verdict = "green" | "amber" | "red";

/**
 * One check's answer. `id` is a **stable identifier** — it is what the PWA card and the pack flow
 * branch on, so it does not move when the prose does — and `remedy` is the one command that clears
 * it, present wherever one exists.
 */
export interface PreflightCheck {
  readonly id: string;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly remedy?: string;
}

/** One pack member's answer: how it was reached, and the checks that ran there. */
export interface PreflightMember {
  readonly memberId: string;
  readonly host: string;
  readonly verdict: Verdict;
  readonly checks: readonly PreflightCheck[];
}

/** The whole document `--json` prints, and the contract specs 05 and 06 read. */
export interface PreflightReport {
  readonly schema: number;
  readonly verdict: Verdict;
  readonly checks: readonly PreflightCheck[];
  readonly pack?: readonly PreflightMember[];
}

/**
 * Where the preflight reaches the world. Every member is a READ seam, and the set is deliberately
 * smaller than `UpdateDeps`: there is no `restart`, no `link` writer, no `files.write`.
 */
export interface UpdateCheckDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly exec: Exec;
  readonly files: Files;
  /** Reading the published PATH name and the `current` symlink — {@link LinkReader} cannot write. */
  readonly link: LinkReader;
  /** The one anonymous HTTPS GET the binary path makes (the tags endpoint). No test reaches it. */
  readonly net: Net;
  readonly platform: NodeJS.Platform;
  /**
   * The trust store, narrowed to the ONE method this verb calls. A `TrustStore` is assignable, and
   * nothing wider is — so the read-only contract is a type here rather than a promise in a comment.
   */
  readonly store: { load(): Promise<TrustStoreData | null> };
  /**
   * How the operator reached each member (`pack-ops.json`, ADR 0016), narrowed the same way: read
   * here, never written. A `PackOpsStore` is assignable.
   */
  readonly ops: { get(memberId: string): Promise<OpsRecord | null> };
  /** The ONE thing that spawns ssh, injected so no test ever does. */
  remote(host: string): RemoteRunner;
  /**
   * `collie doctor`'s findings, behind a seam.
   *
   * A seam rather than a call so a test can state a diagnosis in one line, and so this module never
   * has to know how doctor reaches the world (a trust store, a pack fetch, a beacon sweep).
   */
  doctor(): Promise<readonly Finding[]>;
  /** Whether the lines below may carry colour. False everywhere but a real terminal. */
  readonly colour?: boolean;
}

// ── The floors ───────────────────────────────────────────────────────────────

/**
 * The staged build of spec 02 lays a second copy of the payload down beside the live one, so the
 * floor is "room for another Collie plus its build scratch", not "room for a file".
 */
const DISK_RED_KB = 500 * 1024;
const DISK_AMBER_KB = 1024 * 1024;

/**
 * The oldest Bun this tree's own code is known to run on — the version its pack transport was
 * measured against (`bridge/pack/transport.ts`). Below it is AMBER rather than red: nothing here has
 * observed a failure at an older Bun, and a preflight that refuses on a guess is one the operator
 * learns to override.
 */
const MIN_BUN = "1.3.14";

/** The kinds that rebuild from source, and therefore need Bun. A binary install compiles nothing. */
function buildsFromSource(install: InstallKind): boolean {
  return install.kind === "linked-clone" || install.kind === "detached-checkout";
}

/** The kinds that are a git working tree, and therefore have a tracked-file state to be clean in. */
function isCheckout(install: InstallKind): boolean {
  return install.kind === "linked-clone" || install.kind === "detached-checkout";
}

// ── Verdict algebra ──────────────────────────────────────────────────────────

const RANK = { green: 0, amber: 1, red: 2 } satisfies Record<Verdict, number>;

/** The worst verdict in a set — the summary rule, used for a member and for the whole report. */
export function worst(verdicts: readonly Verdict[]): Verdict {
  let seen: Verdict = "green";
  for (const v of verdicts) if (RANK[v] > RANK[seen]) seen = v;
  return seen;
}

/**
 * A member's verdict AS IT COUNTS TOWARD THE TOP-LEVEL REPORT — distinct from
 * {@link PreflightMember.verdict}, which stays the worst of that member's own checks so the
 * terminal output and the card still show a red `ops-record` line with its remedy.
 *
 * `ops-record` red means "this lead has never been told how to reach that peer" — a fact about the
 * lead's own records, not about whether the LEAD's own update can succeed. Updating the lead needs
 * no route to its peers (`cli/pack-update.ts` already treats an `ops-record` red the same way: it
 * skips that member with its remedy, it does not abort the run). So when a member's ONLY red is
 * `ops-record`, it counts as amber here — a peer needing a route is a fact to show, not a reason to
 * refuse the lead's own update. Any OTHER red (unreachable, no Collie at the path, a red remote
 * preflight) still makes this member count red at the top, same as `cli/pack-update.ts`'s `blocks`.
 */
export function topLevelMemberVerdict(member: PreflightMember): Verdict {
  const reds = member.checks.filter((c) => c.verdict === "red");
  const onlyOpsRecord = reds.length > 0 && reds.every((c) => c.id === "ops-record");
  return onlyOpsRecord ? "amber" : member.verdict;
}

const green = (id: string, reason: string): PreflightCheck => ({ id, verdict: "green", reason });
const amber = (id: string, reason: string, remedy?: string): PreflightCheck =>
  remedy === undefined ? { id, verdict: "amber", reason } : { id, verdict: "amber", reason, remedy };
const red = (id: string, reason: string, remedy?: string): PreflightCheck =>
  remedy === undefined ? { id, verdict: "red", reason } : { id, verdict: "red", reason, remedy };

// ── Instance checks ──────────────────────────────────────────────────────────

/**
 * `doctor` — the existing per-instance diagnostic, consumed rather than re-implemented.
 *
 * Doctor's own error severity is the red: it has already decided which of its findings is
 * actionable. Its warnings ride along as amber, and its `skipped` findings say nothing at all —
 * a check that could not run is not evidence that an update would fail.
 */
export async function doctorCheck(deps: UpdateCheckDeps): Promise<PreflightCheck> {
  let findings: readonly Finding[];
  try {
    findings = await deps.doctor();
  } catch (err) {
    return amber("doctor", `could not run doctor here (${String(err)})`, "collie doctor");
  }
  const errors = findings.filter((f) => f.status === "error").map((f) => f.check);
  if (errors.length > 0) {
    return red(
      "doctor",
      `collie doctor reports ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors.join(", ")}`,
      "collie doctor — clear each error it names, then re-run this check",
    );
  }
  const warns = findings.filter((f) => f.status === "warn").map((f) => f.check);
  if (warns.length > 0) {
    return amber("doctor", `collie doctor warns about ${warns.join(", ")} — an update still proceeds`);
  }
  return green("doctor", "collie doctor is clean");
}

/** The directory whose free space matters — the install root on a binary install, else the checkout. */
export function diskRoot(ctx: CliContext, install: InstallKind): string {
  return install.kind === "binary" ? binaryLayout(ctx.root).installRoot : ctx.root;
}

/**
 * The available 1K blocks `df -Pk <dir>` reports, or null when nothing here could read it. POSIX
 * output is one header line and one row per filesystem; the AVAILABLE column is the fourth field.
 * A row wrapped over two lines (a long device name) is handled by taking the last non-empty line.
 */
export function parseDfAvailableKb(stdout: string): number | null {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  const row = lines[lines.length - 1];
  if (row === undefined || lines.length < 2) return null;
  const fields = row.trim().split(/\s+/);
  const available = fields[fields.length - 3];
  if (available === undefined) return null;
  const kb = Number.parseInt(available, 10);
  return Number.isFinite(kb) ? kb : null;
}

const gib = (kb: number): string => `${(kb / 1024 / 1024).toFixed(1)} GB`;

/** Free space at the install root, against the floor a staged build needs. */
export function diskCheck(deps: UpdateCheckDeps, install: InstallKind): PreflightCheck {
  const dir = diskRoot(deps.ctx, install);
  const r = deps.exec.capture("df", ["-Pk", dir]);
  const kb = r.found && r.code === 0 ? parseDfAvailableKb(r.stdout) : null;
  if (kb === null) {
    return amber("disk", `could not read the free space at ${dir} — proceeding blind`);
  }
  if (kb < DISK_RED_KB) {
    return red(
      "disk",
      `${gib(kb)} free at ${dir} — an update needs at least 500 MB to stage the new payload`,
      `free space under ${dir}, then re-run this check`,
    );
  }
  if (kb < DISK_AMBER_KB) {
    return amber("disk", `${gib(kb)} free at ${dir} — under 1 GB, which is tight for a staged build`);
  }
  return green("disk", `${gib(kb)} free at ${dir}`);
}

/** `bun --version`'s first line, or null when it did not answer one. */
function bunVersion(exec: Exec): string | null {
  const r = exec.capture("bun", ["--version"]);
  if (!r.found || r.code !== 0) return null;
  const line = r.stdout.trim().split("\n")[0]?.trim();
  return line === undefined || line === "" ? null : line;
}

/** Bun's presence and version — asked ONLY of an install that rebuilds from source. */
export function bunCheck(deps: UpdateCheckDeps): PreflightCheck {
  if (deps.exec.which("bun") === null) {
    return red(
      "bun",
      "bun is not installed, and this install rebuilds from source — the update would stop after the fetch",
      "install Bun from https://bun.sh, then re-run this check",
    );
  }
  const version = bunVersion(deps.exec);
  if (version === null) return amber("bun", "bun is installed but `bun --version` said nothing readable");
  if (compareSemver(version, MIN_BUN) < 0) {
    return amber("bun", `bun ${version} is older than the ${MIN_BUN} this build was measured on`);
  }
  return green("bun", `bun ${version}`);
}

/**
 * The working tree, in TRACKED FILES ONLY.
 *
 * `--untracked-files=no` is the whole check. An operator who keeps scratch files, a local `.env`,
 * notes or editor droppings beside their checkout must not get a red for it: a preflight that
 * false-positives on a normal working install is one the operator learns to override, which is the
 * failure mode `cli/doctor.ts` already warns about twice. A tracked modification is still a red, and
 * it names the files — the same refusal `cli/pack-update.ts` makes on a member's dirty checkout.
 */
export function treeCheck(deps: UpdateCheckDeps): PreflightCheck {
  const root = deps.ctx.root;
  const r = deps.exec.capture("git", gitArgs(root, ["status", "--porcelain", "--untracked-files=no"]));
  if (!r.found) return amber("tree", "git is not installed here, so the working tree could not be read");
  if (r.code !== 0) return amber("tree", `git could not read the working tree at ${root}`);
  const changed = r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((l) => l !== "");
  if (changed.length === 0) {
    return green("tree", "the checkout has no tracked-file changes (untracked files are ignored)");
  }
  const named = changed.slice(0, 5).join(", ");
  const rest = changed.length > 5 ? `, and ${changed.length - 5} more` : "";
  return red(
    "tree",
    `the checkout has uncommitted changes to tracked files: ${named}${rest}`,
    `\`git stash\` or commit them in ${root}, then re-run this check`,
  );
}

/**
 * Upstream: the fork guard, then the tag list, then the plan.
 *
 * The plan is `cli/update.ts`'s own — this must not re-derive a target, or the preflight and the
 * verb would be able to disagree about what an update is going to take.
 */
export async function upstreamCheck(deps: UpdateCheckDeps, install: InstallKind): Promise<PreflightCheck> {
  const configured = updateRepoOf(deps.ctx.env);
  const installed = manifestVersionFrom(deps.files.read(join(deps.ctx.root, "herdr-plugin.toml")));

  // The fork guard, copied in spirit from `cli/update.ts`'s `assertOrigin` (which is private there):
  // a checkout whose `origin` is not the configured update source would be force-checked-out onto a
  // stranger's tags, so `update` refuses BEFORE it fetches — and so does this.
  if (isCheckout(install)) {
    const origin = originOf(deps.exec, deps.ctx.root);
    if (!originMatches(origin, configured)) {
      const named =
        origin.kind === "repo"
          ? `github.com/${origin.repo}`
          : origin.kind === "other"
            ? origin.url
            : "unreadable (no `origin` remote, or no git)";
      return red(
        "upstream",
        `this checkout's origin is ${named}, but updates are configured to come from github.com/${configured}`,
        origin.kind === "repo"
          ? `set COLLIE_UPDATE_REPO=${origin.repo} if you run that fork on purpose`
          : 'docs/upgrading.md → "You run a fork"',
      );
    }
  }

  const listed = await listTags(deps, install, configured);
  if (!listed.ok) return red("upstream", listed.reason, listed.remedy);

  const head = isCheckout(install)
    ? deps.exec.capture("git", gitArgs(deps.ctx.root, ["rev-parse", "HEAD"])).stdout.trim()
    : "";
  const plan = planUpdate({ tags: listed.tags, installed, head, crossMajor: false });
  if (plan.kind === "unknown-version") {
    return plan.newest === null
      ? red(
          "upstream",
          `github.com/${configured} publishes no release tags, and this install names no version — there is nothing to take`,
          "reinstall from docs/install.md",
        )
      : amber("upstream", `this install names no readable version — an update would pin it to ${plan.newest.tag}`);
  }
  if (plan.kind === "no-higher-major") return green("upstream", `no release above major ${plan.major} exists yet`);
  if (plan.kind === "no-release") {
    return amber("upstream", `github.com/${configured} publishes no release of major ${plan.major} yet`);
  }
  if (plan.kind === "current") return currentOrMajor(plan.at, plan.higher);
  const target = `v${plan.target.version}`;
  if (plan.higher !== null) {
    return amber(
      "upstream",
      `${target} is available on major ${plan.target.major}, and Collie ${plan.higher.version} is out — a NEW MAJOR a routine update never takes`,
      `take the release with \`collie update\`; cross the major with \`collie update --major\` (${MAJOR_ACTION})`,
    );
  }
  return green("upstream", `${target} resolves on github.com/${configured} — an update would take it`);
}

/** "Already current" is a green with nothing to do; a major that is out on top of it is amber. */
function currentOrMajor(at: ReleaseTag, higher: ReleaseTag | null): PreflightCheck {
  if (higher === null) {
    return green("upstream", `already current — v${at.version} is the newest release of major ${at.major}`);
  }
  return amber(
    "upstream",
    `already current on major ${at.major} (v${at.version}), but Collie ${higher.version} is out — a NEW MAJOR`,
    `read its release notes, then consent with \`collie update --major\` (${MAJOR_ACTION})`,
  );
}

type TagListing =
  | { readonly ok: true; readonly tags: readonly ReleaseTag[] }
  | { readonly ok: false; readonly reason: string; readonly remedy: string };

/** How long `git ls-remote` may take before the preflight stops waiting on it. */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/**
 * The URL a READ-ONLY tag listing should use for `origin`.
 *
 * Listing the tags of a public repository must not depend on a credential. The bridge runs as a
 * systemd user service with no access to the operator's SSH agent, so `git ls-remote origin` on a
 * checkout whose origin is `git@github.com:AltanS/collie.git` fails with "Permission denied
 * (publickey)" — a red preflight that has nothing to do with whether an update could succeed.
 * A GitHub SSH remote is therefore listed over anonymous HTTPS instead. Every other URL is used
 * exactly as git reports it: a self-hosted mirror or a local path is not ours to rewrite.
 */
export function anonymousTagUrl(url: string): string {
  const raw = url.trim();
  const scp = /^git@github\.com:(.+)$/i.exec(raw);
  const ssh = /^ssh:\/\/git@github\.com\/(.+)$/i.exec(raw);
  const path = scp?.[1] ?? ssh?.[1];
  if (path === undefined) return raw;
  const repo = path.replace(/\/+$/, "").replace(/\.git$/, "");
  return repo === "" ? raw : `https://github.com/${repo}.git`;
}

/** What `origin` is called on the wire for a read-only listing — the URL, or the name as a fallback. */
function tagRemote(deps: UpdateCheckDeps): string {
  const r = deps.exec.capture("git", gitArgs(deps.ctx.root, ["remote", "get-url", "origin"]));
  const url = r.found && r.code === 0 ? r.stdout.trim() : "";
  return url === "" ? "origin" : anonymousTagUrl(url);
}

/**
 * Why a `git ls-remote` failed, in the only two families a remedy can differ on.
 *
 * `network` is the one the operator fixes by getting the machine online; everything else is the
 * machine being unable to PROVE who it is to that remote, or the remote URL being wrong. Guessing
 * "network" for both is what made a missing SSH agent read as a dead github.com.
 */
export type TagFailure = "network" | "credentials";

const NETWORK_STDERR =
  /could not resolve host|name or service not known|temporary failure in name resolution|timed out|timeout|network is unreachable|no route to host|connection refused|connection reset|unable to access/i;

/** The classifier. Empty stderr is `network`: a remote that says nothing is the silence it names. */
export function classifyTagFailure(stderr: string): TagFailure {
  const line = firstLine(stderr);
  if (line === "") return "network";
  return NETWORK_STDERR.test(line) ? "network" : "credentials";
}

const TAG_REMEDY = {
  network: "check this machine's network and its access to the remote, then re-run this check",
  credentials:
    "the listing is anonymous, so this is the remote URL or its credentials — check `git remote get-url origin`, then re-run this check",
} satisfies Record<TagFailure, string>;

/**
 * The remote's tags, by the route this install's `update` would take them: `git ls-remote` on a
 * checkout, the GitHub tags endpoint on a binary install. Same `ReleaseTag[]` either way, so the
 * planner below never learns which one answered.
 */
async function listTags(deps: UpdateCheckDeps, install: InstallKind, repo: string): Promise<TagListing> {
  if (isCheckout(install)) {
    const remote = tagRemote(deps);
    const ls = deps.exec.capture(
      "git",
      gitArgs(deps.ctx.root, ["ls-remote", "--tags", remote]),
      LS_REMOTE_TIMEOUT_MS,
    );
    if (!ls.found) {
      return { ok: false, reason: "git is not installed here, so the upstream tags cannot be listed", remedy: "install git" };
    }
    if (ls.code !== 0) {
      // git's own first line, verbatim: "Permission denied (publickey)" has to read as itself, and
      // never as a remote that did not answer.
      const said = firstLine(ls.stderr);
      const kind = classifyTagFailure(ls.stderr);
      return {
        ok: false,
        reason:
          said === ""
            ? `could not list the release tags of github.com/${repo} — the remote did not answer`
            : `could not list the release tags of github.com/${repo} — git said: ${said}`,
        remedy: TAG_REMEDY[kind],
      };
    }
    return { ok: true, tags: parseRemoteTags(ls.stdout) };
  }
  const response = await deps.net.getJson(githubTagsUrl(repo));
  if (!response.ok) {
    const status = response.failure.status;
    return {
      ok: false,
      reason:
        status === 403 || status === 429
          ? `github.com rate-limited the release check (HTTP ${status})`
          : `could not reach github.com for the release check (${response.failure.message})`,
      remedy: status === 403 || status === 429 ? "wait an hour, then re-run this check" : "check this machine's network",
    };
  }
  // SAFETY: `Net.getJson` hands back what `Response.json()` produced, which IS a JsonValue by
  // construction; `parseTagsResponse` checks every field it keeps.
  return { ok: true, tags: parseApiTags(parseTagsResponse(response.value as JsonValue)) };
}

/**
 * The service unit an update has to restart afterwards. This is not "is it running" — a stopped
 * unit restarts fine — it is "is there something here for the restart to act on".
 */
export function serviceCheck(deps: UpdateCheckDeps): PreflightCheck {
  const tier = supervisionTier(deps.exec, deps.platform, deps.ctx.env);
  if (tier === "launchd") {
    const plist = agentFilePath(deps.ctx.home, deps.ctx.instance);
    return deps.files.exists(plist)
      ? green("service", `the LaunchAgent at ${plist} is in place — the update can restart it`)
      : red(
          "service",
          `no LaunchAgent at ${plist} — an update would have nothing to restart`,
          "collie start",
        );
  }
  if (tier === "unsupervised") {
    return amber(
      "service",
      "no service manager on this host — the bridge is unsupervised, so restart it by hand after the update",
    );
  }
  const unit = unitName(deps.ctx.instance);
  const file = unitFilePath(deps.ctx.home, deps.ctx.instance);
  if (!deps.files.exists(file)) {
    return red(
      "service",
      `no systemd user unit at ${file} — an update would have nothing to restart`,
      "collie start",
    );
  }
  const r = deps.exec.capture("systemctl", ["--user", "is-active", unit]);
  const state = r.found && r.stdout.trim() !== "" ? r.stdout.trim() : "unknown";
  // `active`, `inactive` and `activating` are all states `systemctl restart` acts on. `failed` is
  // too — but a unit that is already failing is worth saying out loud before an update blames
  // itself for it.
  if (state === "failed") {
    return amber("service", `${unit} is in the failed state — an update will still try to restart it`);
  }
  return green("service", `${unit} is ${state} — the update can restart it`);
}

/** Every instance check, in the order they print. */
export async function instanceChecks(deps: UpdateCheckDeps): Promise<PreflightCheck[]> {
  const install = classifyInstall(probeInstall(deps, deps.ctx.root));
  const checks: PreflightCheck[] = [await doctorCheck(deps), diskCheck(deps, install)];
  if (buildsFromSource(install)) checks.push(bunCheck(deps));
  if (isCheckout(install)) checks.push(treeCheck(deps));
  checks.push(await upstreamCheck(deps, install));
  checks.push(serviceCheck(deps));
  return checks;
}

// ── Pack checks ──────────────────────────────────────────────────────────────

/** The script that asks a member's own Collie for its preflight. Exit 66 = no binary at that path. */
export function remoteCheckScript(root: string): string {
  return [
    "set -u",
    `ROOT=${shqPath(root)}`,
    'if [ ! -x "$ROOT/bin/collie" ]; then exit 66; fi',
    'exec "$ROOT/bin/collie" update --check --json',
    "",
  ].join("\n");
}

/**
 * A schema-1 report inside whatever the remote printed, or null.
 *
 * Null is the "peer predates preflight" signal: a Collie old enough not to know `--check` answers
 * with a usage error, and that is a version fact, not a failure of the machine.
 */
export function parseReport(stdout: string): PreflightReport | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let doc: Partial<PreflightReport> | null;
  try {
    // SAFETY: the assertion asserts NOTHING about the document — every field it names is checked
    // below before it is used, and a value that is not an object at all reads every one of them as
    // `undefined` and fails the first check. It exists only to give `JSON.parse`'s `any` a name.
    doc = JSON.parse(stdout.slice(start, end + 1)) as Partial<PreflightReport> | null;
  } catch {
    return null;
  }
  if (doc === null || doc === undefined) return null;
  if (doc.schema !== PREFLIGHT_SCHEMA || !Array.isArray(doc.checks)) return null;
  const verdict = doc.verdict;
  if (verdict !== "green" && verdict !== "amber" && verdict !== "red") return null;
  const report: PreflightReport = { schema: PREFLIGHT_SCHEMA, verdict, checks: doc.checks };
  return doc.pack === undefined ? report : { ...report, pack: doc.pack };
}

/** ssh never started, or could not connect — the transport family, distinct from a remote failure. */
const transportFailed = (r: RemoteResult): boolean => !r.spawned || r.code === 255;

/** One member's turn: reach it, prove there is a Collie there, then ask it the same question. */
async function memberChecks(
  deps: UpdateCheckDeps,
  member: TrustedMember,
  record: OpsRecord | null,
  ourVersion: string,
  port: number,
): Promise<PreflightMember> {
  const id = member.memberId;
  const host = record?.sshHost ?? "";
  const done = (checks: readonly PreflightCheck[]): PreflightMember => ({
    memberId: id,
    host,
    verdict: worst(checks.map((c) => c.verdict)),
    checks,
  });
  if (host === "") {
    return done([
      red(
        "ops-record",
        `no ssh record for "${id}" — this machine has never been told how to reach it`,
        `collie pack update ${id} --host <ssh-host> --path <remote-checkout>`,
      ),
    ]);
  }
  const runner = deps.remote(host);
  try {
    const { result, probe } = await runProbe(runner, { path: record?.path ?? null, port });
    if (transportFailed(result)) {
      return done([
        red(
          "reachable",
          `ssh could not reach ${host} (${firstLine(result.stderr) || `exit ${result.code}`})`,
          `check \`ssh ${host}\` from this machine, then re-run this check`,
        ),
      ]);
    }
    if (probe === null || result.code !== 0) {
      return done([
        red(
          "reachable",
          `${host} did not answer the probe (${probe === null ? "unreadable answer" : `exit ${result.code}`})`,
          `run \`collie pack update ${id}\` to see the full transcript`,
        ),
      ]);
    }
    const reached = green("reachable", `${host} answered over ssh`);
    if (probe.checkout === "") {
      return done([
        reached,
        red(
          "collie-present",
          `no Collie checkout at ${host}${record?.path === null || record?.path === undefined ? "" : ` (${record.path})`}`,
          `collie pack update ${id} --host ${host} --path <remote-checkout>`,
        ),
      ]);
    }
    const present = green("collie-present", `a Collie at ${host}:${probe.checkout}`);
    const skew = skewCheck(probe.version, ourVersion);
    const remote = await remoteChecks(runner, probe.checkout);
    return done([reached, present, skew, ...remote]);
  } finally {
    runner.close();
  }
}

/** PACK_PROTOCOL §7.1: skew inside a protocol version is tolerated by design, so it is never red. */
export function skewCheck(theirs: string, ours: string): PreflightCheck {
  if (theirs === "") return amber("version", "that member did not report a version");
  if (theirs === ours) return green("version", `runs ${theirs}, the same build as this lead`);
  return amber("version", `runs ${theirs} while this lead runs ${ours} — skew is tolerated, not a blocker`);
}

/** The member's own instance checks, asked of its own binary and merged in under the same ids. */
async function remoteChecks(runner: RemoteRunner, root: string): Promise<readonly PreflightCheck[]> {
  const r = await runner.run(remoteCheckScript(root));
  if (transportFailed(r)) {
    return [red("preflight", `ssh dropped while asking that member for its preflight (exit ${r.code})`)];
  }
  const report = parseReport(r.stdout);
  if (report === null) {
    return [
      amber(
        "preflight",
        "peer predates preflight — that Collie has no `update --check`, so its own checks could not be read",
        "collie pack update <member> to level it to this lead's build",
      ),
    ];
  }
  return report.checks;
}

const firstLine = (text: string): string => text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

/** Every member's answer, or `undefined` when this collie is not a lead with peers. */
export async function packChecks(deps: UpdateCheckDeps): Promise<PreflightMember[] | undefined> {
  const data = await deps.store.load();
  if (data === null || data.pack === null || data.lead !== null || data.peers.length === 0) return undefined;
  const ours = collieVersionBare(deps.ctx.root, (p) => deps.files.read(p));
  const members: PreflightMember[] = [];
  for (const member of data.peers) {
    const record = await deps.ops.get(member.memberId);
    members.push(await memberChecks(deps, member, record, ours, record?.port ?? deps.ctx.port));
  }
  return members;
}

// ── The verb ─────────────────────────────────────────────────────────────────

/**
 * What a run of the preflight is asked to cover.
 *
 * `local` is the phone's answer and only the phone's: the card updates the LEAD alone (ADR 0016 —
 * peers are levelled from a terminal), so a peer can never be a reason to refuse the lead's own
 * update. It also keeps the member walk, which runs over the operator's own SSH, out of a bridge
 * running as a service with no agent to sign with. The terminal's default is unchanged.
 */
export interface PreflightOptions {
  readonly local?: boolean;
}

/** The whole document, assembled. Pure of output — {@link cmdUpdateCheck} decides how to print it. */
export async function preflight(deps: UpdateCheckDeps, opts: PreflightOptions = {}): Promise<PreflightReport> {
  const checks = await instanceChecks(deps);
  // Skipped ENTIRELY under `--local`: no trust store read, no ssh, and no `pack` key in the report.
  const pack = opts.local === true ? undefined : await packChecks(deps);
  // A member's contribution to the TOP verdict is `topLevelMemberVerdict`, not its own `.verdict` —
  // see that function's comment: an `ops-record`-only red on a peer must not disable the lead's own
  // update button.
  const verdict = worst([
    ...checks.map((c) => c.verdict),
    ...(pack ?? []).map(topLevelMemberVerdict),
  ]);
  const report: PreflightReport = { schema: PREFLIGHT_SCHEMA, verdict, checks };
  return pack === undefined ? report : { ...report, pack };
}

const COLOURS = { green: "[32m", amber: "[33m", red: "[31m" } satisfies Record<Verdict, string>;

/** One check, one line — doctor's layout, with the verdict leading and the remedy closing it. */
export function checkLine(c: PreflightCheck, colour: boolean, indent = "  "): string {
  const head = c.verdict === "green" ? "✓" : `${c.verdict}:`;
  const painted = colour ? `${COLOURS[c.verdict]}${head}[0m` : head;
  // 8 = "amber:" + 2, so every reason starts in the same column; the pad is applied to the UNPAINTED
  // head, because an escape sequence has width in a string and none on a screen.
  const pad = " ".repeat(Math.max(1, 8 - head.length));
  const body = `${indent}${painted}${pad}${c.id.padEnd(15)}${c.reason}`;
  return c.remedy === undefined ? body : `${body} → ${c.remedy}`;
}

function render(deps: UpdateCheckDeps, report: PreflightReport): void {
  const colour = deps.colour === true;
  deps.io.out(`collie update --check — ${report.verdict}`);
  deps.io.out("");
  deps.io.out("instance:");
  for (const c of report.checks) deps.io.out(checkLine(c, colour));
  if (report.pack === undefined) return;
  deps.io.out("");
  deps.io.out("pack:");
  for (const m of report.pack) {
    deps.io.out(`  ${m.memberId} (${m.host === "" ? "no ssh record" : m.host}) — ${m.verdict}`);
    for (const c of m.checks) deps.io.out(checkLine(c, colour, "    "));
  }
}

/**
 * `collie update --check [--local] [--json]` — the read-only preflight.
 *
 * Exit 0 when nothing is red, {@link EXIT.FAIL} otherwise. Amber never moves the exit code: it is
 * "would proceed, but you should know", and a gate that blocked on it would be a gate every caller
 * learns to pass `--force` to.
 */
export async function cmdUpdateCheck(deps: UpdateCheckDeps, args: readonly string[] = []): Promise<number> {
  const report = await preflight(deps, { local: wantsLocal(args) });
  if (args.includes("--json")) {
    // stdout and nothing else: the whole point of `--json` is that spec 05 and spec 06 can read it.
    deps.io.out(JSON.stringify(report, null, 2));
  } else {
    render(deps, report);
  }
  return report.verdict === "red" ? EXIT.FAIL : EXIT.OK;
}

/** The real seams, resolved once per invocation — the mirror of `cli/deps.ts` for this one verb. */
export function updateCheckDeps(io: Io): UpdateCheckDeps {
  const ctx = loadContext(io.err);
  const exec = realExec(ctx.env, ctx.home);
  return {
    ctx,
    io,
    exec,
    files: realFiles,
    link: realLinkFs,
    net: realNet,
    platform: process.platform,
    store: new TrustStore(ctx.stateDir),
    ops: new PackOpsStore(ctx.stateDir),
    remote: (host) => sshRunner(host, ctx.env, ctx.home),
    // Doctor, asked through its OWN `--json` contract rather than through a second entry point:
    // this module never edits `cli/doctor.ts`, and the JSON is the shape that file already
    // guarantees. Its output is captured, so nothing doctor prints reaches this verb's stdout.
    doctor: async () => {
      const lines: string[] = [];
      const held: Io = { out: (l) => void lines.push(l), err: () => {} };
      await cmdDoctor(doctorDeps({ ctx, io: held, exec, files: realFiles }), ["--json"]);
      // SAFETY: `cmdDoctor --json` prints `JSON.stringify(findings)` and nothing else — the shape is
      // `cli/doctor.ts`'s own published contract, and the array check below is what rejects anything
      // that is not it.
      const parsed = JSON.parse(lines.join("\n")) as Finding[] | null;
      return Array.isArray(parsed) ? parsed : [];
    },
    colour: process.stdout.isTTY === true,
  };
}

/** `--check` anywhere in `update`'s argv — the dispatcher's predicate (`cli/program.ts`). */
export function wantsCheck(args: readonly string[]): boolean {
  return args.includes("--check");
}

/** `--local`: check this instance only, and skip the pack members. What the phone's card asks for. */
export function wantsLocal(args: readonly string[]): boolean {
  return args.includes("--local");
}

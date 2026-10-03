import { existsSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// The release job's one decision about the Windows asset (M43 spec 06), out of the YAML so it can be
// tested. The Windows set is three files the `payload-windows` job uploads together: the zip, its
// `.sha256` sidecar and `windows-x64.artifact.json`, the zip's manifest entry. It is all or nothing.
//
//   bun scripts/windows-asset.ts --dir <assets> --version <X.Y.Z> --result <payload-windows result> \
//     --repo <owner/name> [--override <the variable's value>] [--now <ISO date, tests only>]
//       decides, removes a partial set, prints a GitHub `::warning::` or `::error::`, writes
//       `present=true|false` to $GITHUB_OUTPUT, and exits 1 only on a failure
//   bun scripts/windows-asset.ts --notes <true|false>
//       prints the block the release notes end with
//
// The rules, in order:
//   * all three files there, and the three digests agree: present;
//   * all three there, and a digest disagrees: FAIL, the set is corrupt;
//   * not all there, and `payload-windows` SUCCEEDED: FAIL, a job that built the zip and lost it is
//     a bug in this pipeline, never a Windows build problem;
//   * not all there, and the tolerance is closed: FAIL;
//   * not all there otherwise (failure, skipped, cancelled): a WARNING, and the release ships without it.
//
// THE TOLERANCE CLOSES ON ITS OWN (M43, decided 2026-10-02). It is closed, so a missing Windows asset
// stops the release like any other row, from the first of these two:
//   * the day {@link WINDOWS_ASSET_MANDATORY_FROM}, read in UTC;
//   * an earlier release, neither a draft nor a prerelease, that carries a `collie-*-windows-x64.zip`.
//     The script asks the releases API with `gh` and the job's `GH_TOKEN`, as the gate job does. A
//     prerelease does not count, so an rc rehearsal that ships the zip leaves the next rehearsal free
//     to test the failure.
// When the API does not answer after {@link LOOKUP_TRIES} tries, the tolerance is CLOSED (fail closed,
// with a `::warning::`): a re-run of the job is cheap, and a release that quietly drops the Windows
// zip is not.
//
// THE ESCAPE. The repository variable {@link OVERRIDE_VARIABLE} (Settings > Secrets and variables >
// Actions > Variables), passed as `--override`, set to `optional`, opens the tolerance whatever the
// date and the earlier releases say, with a loud `::warning::` and a line in the job summary. It is
// for a Linux hotfix while the Windows job is broken. Unset it once the Windows job is fixed. Any
// other value is ignored, with a warning.
// No YAML holds a copy of either rule; release.yml only runs this file and passes the variable.

/** What is on disk, read by {@link readSet} or written by a test. `null` is a missing file. */
export interface WindowsSet {
  /** The zip's own sha256. */
  readonly zip: string | null;
  /** The first word of the sidecar. */
  readonly sidecar: string | null;
  /** The `sha256` field of the manifest entry. */
  readonly entry: string | null;
}

export type WindowsVerdict =
  | { readonly kind: "present" }
  | { readonly kind: "warn"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

export function windowsVerdict(set: WindowsSet, result: string, optional: boolean, zipName: string): WindowsVerdict {
  const complete = set.zip !== null && set.sidecar !== null && set.entry !== null;
  if (complete) {
    if (set.zip === set.sidecar && set.zip === set.entry) return { kind: "present" };
    return { kind: "fail", reason: `the Windows set disagrees with itself: zip ${set.zip}, sidecar ${set.sidecar}, manifest entry ${set.entry}` };
  }
  if (result === "success") {
    return { kind: "fail", reason: `payload-windows succeeded, and ${zipName} or its sidecar or its manifest entry is missing; that is a bug in this pipeline` };
  }
  if (!optional) {
    return { kind: "fail", reason: `${zipName} is missing (payload-windows: ${result}), and the Windows asset is no longer optional` };
  }
  return { kind: "warn", reason: `${zipName} is not in this release (payload-windows: ${result}). Linux and macOS publish as usual.` };
}

/** The block the release notes end with. Appended after the Linux and macOS part, which it never changes. */
export function windowsNotes(present: boolean): string {
  return present
    ? [
        "Windows zip: experimental and unsigned. Install it with `irm https://colliepwa.dev/install.ps1 | iex`.",
        "The setup guide is at https://github.com/AltanS/collie/blob/main/docs/windows.md.",
        "Windows 11 Smart App Control may block it. Linux and macOS are not affected.",
      ].join("\n")
    : "The Windows zip was not built for this release.";
}

// ── The tolerance ────────────────────────────────────────────────────────────

/** From this UTC day on, a release without the Windows zip fails. The one place the date is written. */
export const WINDOWS_ASSET_MANDATORY_FROM = "2026-11-15";

/** What the releases API says about earlier releases. `unknown` is an API that did not answer. */
export type PriorWindowsRelease =
  | { readonly kind: "found"; readonly tag: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string };

/** The repository variable that opens the tolerance by hand. */
export const OVERRIDE_VARIABLE = "COLLIE_WINDOWS_ASSET_OVERRIDE";

export interface Tolerance {
  /** True while a missing Windows asset only warns. */
  readonly optional: boolean;
  /** One clause for the log: why the tolerance is open or closed. */
  readonly why: string;
  /** A `::warning::` the run must print, or `null`: the override is on or ignored, or the API failed. */
  readonly warning: string | null;
  /** True when the override opened it: the job summary says so too. */
  readonly overridden: boolean;
}

/**
 * Whether a missing Windows asset is still tolerated. `now` is the clock, `ask` asks GitHub about
 * earlier releases, `override` is the repository variable's value ("" when unset). `ask` runs only
 * before the date and without the override: neither answer could change the result.
 */
export function windowsTolerance(now: Date, ask: () => PriorWindowsRelease, override = ""): Tolerance {
  const value = override.trim();
  if (value === "optional") {
    return {
      optional: true,
      why: `${OVERRIDE_VARIABLE}=optional opens it, whatever the date or earlier releases say`,
      warning: `${OVERRIDE_VARIABLE}=optional is set: a missing Windows asset does not stop this release. Unset the variable once the Windows job is fixed.`,
      overridden: true,
    };
  }
  const ignored = value === "" ? null : `${OVERRIDE_VARIABLE}=${value} is ignored: only "optional" opens the tolerance.`;
  const today = now.toISOString().slice(0, 10);
  if (today >= WINDOWS_ASSET_MANDATORY_FROM) {
    return { optional: false, why: `it is ${today}, on or after ${WINDOWS_ASSET_MANDATORY_FROM}`, warning: ignored, overridden: false };
  }
  const prior = ask();
  if (prior.kind === "found") {
    return { optional: false, why: `release ${prior.tag} already carries the Windows zip`, warning: ignored, overridden: false };
  }
  if (prior.kind === "unknown") {
    const failed =
      `the releases API did not answer (${prior.reason}), so the Windows asset is mandatory for this release (fail closed). ` +
      `Re-run the job, or set the repository variable ${OVERRIDE_VARIABLE}=optional for a hotfix.`;
    return { optional: false, why: failed, warning: ignored === null ? failed : `${failed} ${ignored}`, overridden: false };
  }
  return {
    optional: true,
    why: `no earlier release carries the Windows zip, and it is ${today}, before ${WINDOWS_ASSET_MANDATORY_FROM}`,
    warning: ignored,
    overridden: false,
  };
}

/** The asset name of a Windows zip, in any version. */
const WINDOWS_ZIP = /^collie-.+-windows-x64\.zip$/;

/**
 * The jq filter `gh api` runs over each page: one tab-separated line per release, the tag, `draft`,
 * `prerelease` and the asset names joined by commas. `--paginate` prints page after page, so a line
 * per release is what keeps more than one page readable. Tags and asset names carry no tab or comma.
 */
export const RELEASES_JQ = '.[] | [.tag_name, (.draft | tostring), (.prerelease | tostring), ([.assets[].name] | join(","))] | @tsv';

/** `true` or `false` as jq's `tostring` spells them; anything else is `null`. */
function flag(word: string | undefined): boolean | null {
  if (word === "true") return true;
  if (word === "false") return false;
  return null;
}

/**
 * The first earlier release in the API's answer that carries the Windows zip. Drafts, prereleases and
 * the tag being released now do not count. A line that is not what {@link RELEASES_JQ} prints makes
 * the whole answer `unknown`: a half-read list must not decide.
 */
export function priorWindowsRelease(lines: string, currentTag: string): PriorWindowsRelease {
  for (const line of lines.split("\n")) {
    if (line.trim() === "") continue;
    const [tag, draftWord, prereleaseWord, assetList, ...rest] = line.split("\t");
    const draft = flag(draftWord);
    const prerelease = flag(prereleaseWord);
    if (tag === undefined || tag === "" || draft === null || prerelease === null || assetList === undefined || rest.length > 0) {
      return { kind: "unknown", reason: "a line of the answer was not tag, draft, prerelease and assets" };
    }
    if (draft || prerelease || tag === currentTag) continue;
    if (assetList.split(",").some((name) => WINDOWS_ZIP.test(name))) return { kind: "found", tag };
  }
  return { kind: "none" };
}

/** One `gh` run: its exit code and output. A spawn that could not start throws. */
export interface GhResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type GhRunner = (args: readonly string[]) => GhResult;

const runGh: GhRunner = (args) => {
  const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

/** How many times the releases API is asked before it counts as not answering. */
export const LOOKUP_TRIES = 3;
/** The pause before the second try; the third waits twice as long. */
export const LOOKUP_BACKOFF_MS = 2_000;

/**
 * Ask the releases API, through `gh`, for an earlier release with the Windows zip, up to
 * {@link LOOKUP_TRIES} times with a growing pause. Never throws. `sleep` is injected for the tests.
 */
export function lookupPriorWindowsRelease(
  repo: string,
  currentTag: string,
  gh: GhRunner = runGh,
  sleep: (ms: number) => void = (ms) => Bun.sleepSync(ms),
): PriorWindowsRelease {
  let last: PriorWindowsRelease = { kind: "unknown", reason: "not asked" };
  for (let attempt = 1; attempt <= LOOKUP_TRIES; attempt++) {
    if (attempt > 1) sleep(LOOKUP_BACKOFF_MS * 2 ** (attempt - 2));
    last = askOnce(repo, currentTag, gh);
    if (last.kind !== "unknown") return last;
  }
  return last.kind === "unknown" ? { kind: "unknown", reason: `${LOOKUP_TRIES} tries; the last: ${last.reason}` } : last;
}

function askOnce(repo: string, currentTag: string, gh: GhRunner): PriorWindowsRelease {
  let result: GhResult;
  try {
    result = gh(["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", RELEASES_JQ]);
  } catch (err) {
    return { kind: "unknown", reason: `gh did not start: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.code !== 0) {
    const said = result.stderr.trim().split("\n")[0] ?? "";
    return { kind: "unknown", reason: `gh api exited ${result.code ?? "on a signal or timeout"}${said === "" ? "" : `: ${said}`}` };
  }
  return priorWindowsRelease(result.stdout, currentTag);
}

/** The three file names of the set for one version. */
export interface WindowsFileNames {
  readonly zip: string;
  readonly sidecar: string;
  readonly entry: string;
}

export function windowsFiles(version: string): WindowsFileNames {
  const zip = `collie-${version}-windows-x64.zip`;
  return { zip, sidecar: `${zip}.sha256`, entry: "windows-x64.artifact.json" };
}

function readSet(dir: string, version: string): WindowsSet {
  const f = windowsFiles(version);
  const at = (name: string): string | null => (existsSync(join(dir, name)) ? join(dir, name) : null);
  const zip = at(f.zip);
  const sidecar = at(f.sidecar);
  const entry = at(f.entry);
  // The entry is the one the build script wrote and read back; only its `sha256` value matters here,
  // so it is matched as text. A field that is not there reads as "", which disagrees with any digest.
  const entryDigest =
    entry === null ? null : (/"sha256"\s*:\s*"([0-9a-f]{64})"/.exec(readFileSync(entry, "utf8"))?.[1] ?? "");
  return {
    zip: zip === null ? null : new Bun.CryptoHasher("sha256").update(readFileSync(zip)).digest("hex"),
    sidecar: sidecar === null ? null : (readFileSync(sidecar, "utf8").split(/\s+/)[0] ?? ""),
    entry: entryDigest,
  };
}

function arg(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

function main(args: readonly string[]): number {
  const notes = arg(args, "--notes");
  if (notes !== null) {
    process.stdout.write(`${windowsNotes(notes === "true")}\n`);
    return 0;
  }
  const dir = arg(args, "--dir");
  const version = arg(args, "--version");
  const result = arg(args, "--result");
  const repo = arg(args, "--repo");
  const override = arg(args, "--override") ?? "";
  const nowArg = arg(args, "--now");
  const now = nowArg === null ? new Date() : new Date(nowArg);
  if (dir === null || version === null || result === null || Number.isNaN(now.getTime())) {
    process.stderr.write(
      "usage: windows-asset.ts --dir <assets> --version <X.Y.Z> --result <result> --repo <owner/name> [--override <value>] [--now <ISO date>]\n",
    );
    return 2;
  }
  const files = windowsFiles(version);
  const tolerance = windowsTolerance(
    now,
    () => (repo === null ? { kind: "unknown", reason: "no --repo was given" } : lookupPriorWindowsRelease(repo, `v${version}`)),
    override,
  );
  if (tolerance.warning !== null) process.stdout.write(`::warning title=Windows asset tolerance::${tolerance.warning}\n`);
  process.stdout.write(`Windows asset ${tolerance.optional ? "optional" : "mandatory"}: ${tolerance.why}.\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (tolerance.overridden && summary) {
    appendFileSync(summary, `### Windows asset optional by hand\n\n${tolerance.warning ?? ""}\n`);
  }
  const verdict = windowsVerdict(readSet(dir, version), result, tolerance.optional, files.zip);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `present=${verdict.kind === "present"}\n`);
  if (verdict.kind === "present") {
    process.stdout.write(`✓ ${files.zip} is here (payload-windows: ${result})\n`);
    return 0;
  }
  if (verdict.kind === "fail") {
    process.stdout.write(`::error title=Windows asset::${verdict.reason}\n`);
    return 1;
  }
  // All or nothing: a part of the set without the rest goes, so the manifest never names a file
  // that is not published.
  for (const name of [files.zip, files.sidecar, files.entry]) rmSync(join(dir, name), { force: true });
  process.stdout.write(`::warning title=No Windows asset::${verdict.reason}\n`);
  if (summary) {
    appendFileSync(summary, `### No Windows asset\n\n${verdict.reason}\nWindows users keep their version until the next release.\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));

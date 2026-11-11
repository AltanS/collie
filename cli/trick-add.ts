import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { redactText } from "../bridge/redact.ts";
import { CONFIG_FILE, diskTrickFs, skippedName, trickCodeHash, walkTrickCode } from "../bridge/tricks/code-hash.ts";
import { MANIFEST_BYTES_MAX, readManifestFile, readManifestText } from "../bridge/tricks/discover.ts";
import { ORIGIN_FILE, readOrigin, renderOrigin, type TrickOrigin } from "../bridge/tricks/origin.ts";
import { removeTrickCopies } from "../bridge/tricks/approved.ts";
import { MANIFEST_FILE, switchesPath, trickStateDir, tricksConfigDir, tricksStateDir } from "../bridge/tricks/paths.ts";
import { trickWarnings, warningLines, WARNINGS_HONESTY, type CheckWarning } from "../bridge/tricks/scan.ts";
import { parseSwitches } from "../bridge/tricks/switches.ts";
import type { JsonValue } from "../bridge/json.ts";
import { asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import { isTrickId, type TrickManifest } from "../web/src/lib/tricks/schema.ts";
import { checkStatic, leadsCrewOnDisk, type TrickDeps } from "./trick.ts";
import { EXIT } from "./io.ts";

// `collie trick add`, `update` and `remove` (M94 review 15): a trick from a git repository, copied into
// the tricks folder OFF. No trick ships in the binary and none is installed by default; the person picks.
//
// ── WHAT A REPOSITORY MAY NOT DO ──────────────────────────────────────────────────────────────────
// Nothing from the repository is ever executed, and git never writes a working tree. The fetch goes into
// a fresh BARE repository in a temp folder under the state folder (never the tricks folder):
//
//   git init --bare --quiet --template= <tmp>/repo.git
//   git <H> --git-dir=<tmp>/repo.git fetch --quiet --depth=1 --no-tags --no-recurse-submodules -- <url> <ref|HEAD>
//   git <H> --git-dir=<tmp>/repo.git rev-parse --verify --end-of-options FETCH_HEAD^{commit}
//   git <H> --git-dir=<tmp>/repo.git ls-tree -r -l -z --full-tree <commit>
//   git <H> --git-dir=<tmp>/repo.git cat-file --batch          (the blobs of the trick's folder, on stdin)
//
// where <H> is {@link GIT_HARDENING}: no hook (`core.hooksPath=/dev/null`, and `--template=` makes no
// hooks folder at all), no fsmonitor, https only (`protocol.allow=never`, `protocol.https.allow=always`,
// `protocol.file.allow=never`, `protocol.ext.allow=never`, and `GIT_ALLOW_PROTOCOL=https` in the
// environment, which outranks any config), no submodule, no LFS smudge, no askpass program. Every
// inherited `GIT_*` variable is dropped; `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and
// `GIT_LFS_SKIP_SMUDGE=1` are set. Each git run is argv, never a shell, killed at {@link ADD_LIMITS}
// `gitTimeoutMs`, its output capped. The operator's own global git config is trusted, as their shell
// is (a credential helper for a private repository keeps working).
//
// The tree is read from git's own objects, so its modes are git's: a symlink (120000) or a submodule
// (160000) anywhere in the trick's folder refuses the trick, on every platform. Collie writes each
// regular file itself. Then the strict manifest reader must accept `trick.toml` at this contract, the
// caps hold, and the id is free. Dot files and dot folders and `node_modules/` are not copied: they are
// outside the code hash (code-hash.ts), so they would be code the person never approved.
//
// A local folder or `file://` URL is accepted only under {@link TrickAddSeam}, the tests' seam, which the
// CLI never sets: `program.ts` builds the deps without it.

/** The official repository: `collie trick add <name>` means the folder `<name>` in it. */
export const OFFICIAL_TRICKS_REPO = "https://github.com/AltanS/collie-tricks";

/** Every cap of `add` and `update`, in one place. */
export const ADD_LIMITS = {
  /** Files in the trick's folder, all of them, dot files included. */
  files: 300,
  /** Bytes of all those files together. */
  bytes: 5 * 1024 * 1024,
  /** Folder levels inside the trick's folder. */
  depth: 8,
  /** One git run. */
  gitTimeoutMs: 60_000,
  /** What one git run may print on stdout before it is killed. */
  gitStdoutBytes: 8 * 1024 * 1024,
  /** Tricks listed from the official repository. */
  listed: 100,
} as const;

/** The `-c` settings every git run carries. `file` is `never` except under the tests' seam. */
export function gitHardening(allowFile: boolean): string[] {
  return [
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.askPass=",
    "protocol.allow=never",
    "protocol.https.allow=always",
    `protocol.file.allow=${allowFile ? "always" : "never"}`,
    "protocol.ext.allow=never",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "filter.lfs.smudge=",
    "filter.lfs.process=",
    "filter.lfs.required=false",
    "transfer.fsckObjects=true",
    "init.defaultBranch=main",
  ].flatMap((kv) => ["-c", kv]);
}

/** The settings of a production run, for the docs and the tests. */
export const GIT_HARDENING: readonly string[] = gitHardening(false);

/** One git run's result. */
export interface GitResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
  capped: boolean;
}

export interface GitRunOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: Uint8Array;
}

/** How git is run. The real one spawns `git`; a test may wrap it. */
export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitResult>;

/**
 * The tests' seam: a local folder or `file://` URL may be a source, and the official repository is
 * another URL. The CLI never sets it.
 */
export interface TrickAddSeam {
  allowLocal: boolean;
  officialRepo?: string;
}

export interface TrickAddDeps extends TrickDeps {
  git?: GitRunner;
  seam?: TrickAddSeam;
}

/** Read a child's stream up to `cap` bytes; past it, `capped`. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  // Bounded by the stream: each pass takes one chunk, and the loop ends at the end or past the cap.
  for (let pass = 0; pass < Number.MAX_SAFE_INTEGER; pass += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return { bytes: new Uint8Array(0), capped: true };
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out, capped: false };
}

/** The real runner: `git` from the PATH the run gets, argv only, killed at the timeout. */
export const spawnGit: GitRunner = async (args, opts) => {
  const git = Bun.which("git", { PATH: opts.env.PATH ?? "" });
  if (git === null) return { code: 127, stdout: new Uint8Array(0), stderr: "git is not on PATH", timedOut: false, capped: false };
  // stdin is always a pipe: written and closed at once when the run has input, closed empty when not.
  const proc = Bun.spawn([git, ...args], { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, ADD_LIMITS.gitTimeoutMs);
  try {
    if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
    await proc.stdin.end();
    const [out, err] = await Promise.all([readCapped(proc.stdout, ADD_LIMITS.gitStdoutBytes), readCapped(proc.stderr, 64 * 1024)]);
    if (out.capped) proc.kill(9);
    const code = await proc.exited;
    return { code, stdout: out.bytes, stderr: new TextDecoder().decode(err.bytes), timedOut, capped: out.capped };
  } finally {
    clearTimeout(timer);
  }
};

/** The environment of a git run: the caller's, minus every `GIT_*`, plus ours. */
export function gitRunEnv(base: Record<string, string | undefined>, allowFile: boolean) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_ALLOW_PROTOCOL = allowFile ? "https:file" : "https";
  return env;
}

// ── the source ───────────────────────────────────────────────────────────────

/** Where a trick comes from: a repository, a ref in it, a folder in it. */
export interface TrickSource {
  url: string;
  /** A branch, tag or full commit, or null for the default branch. */
  ref: string | null;
  /** The folder inside the repository, or null for its top. */
  subdir: string | null;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const SUBDIR_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u;

/** Why a ref is refused, or null. A ref never starts with `-`, holds no `..`, `//`, `:` or space. */
export function refProblem(ref: string): string | null {
  if (!REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    return `"${ref}" is not a branch, tag or commit name Collie fetches (letters, digits, . _ / -; a commit as all 40 hex digits)`;
  }
  return null;
}

/** Why a folder inside the repository is refused, or null. */
export function subdirProblem(subdir: string): string | null {
  const parts = subdir.split("/");
  if (parts.length > ADD_LIMITS.depth || !parts.every((p) => SUBDIR_SEGMENT.test(p))) {
    return `"${subdir}" is not a folder name Collie takes (letters, digits, . _ -, no step that starts with a dot, at most ${String(ADD_LIMITS.depth)} levels)`;
  }
  return null;
}

/** Why a repository URL is refused, or null. https only, no user or password in it, no query. */
export function urlProblem(url: string, seam: TrickAddSeam | undefined): string | null {
  if (seam?.allowLocal === true && (isAbsolute(url) || url.startsWith("file:///"))) return null;
  if (!url.startsWith("https://")) return `${url} is not an https URL. Collie adds a trick from an https git URL only.`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL.`;
  }
  if (parsed.username !== "" || parsed.password !== "") return "The URL holds a user name or a password. Leave them out: they would be stored in the trick's origin record.";
  if (parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "" || /\s/u.test(url)) return `${url} is not a plain https git URL.`;
  return null;
}

/**
 * Read a source: a bare trick name (`legs`, `legs#v1`) means that folder of the official repository;
 * anything else is `<url>[//<subdir>][#<ref>]`, and `#<ref>//<subdir>` reads too.
 */
export function parseTrickSource(raw: string, seam?: TrickAddSeam): TrickSource | { error: string } {
  const hash = raw.indexOf("#");
  const base = hash < 0 ? raw : raw.slice(0, hash);
  const fragment = hash < 0 ? null : raw.slice(hash + 1);
  let ref = fragment;
  let subdir: string | null = null;
  if (fragment !== null && fragment.includes("//")) {
    const cut = fragment.indexOf("//");
    ref = fragment.slice(0, cut);
    subdir = fragment.slice(cut + 2);
  }
  if (ref === "") ref = null;
  let url = base;
  if (isTrickId(base)) {
    if (subdir !== null) return { error: `A trick name takes no folder: write collie trick add ${base}` };
    url = seam?.officialRepo ?? OFFICIAL_TRICKS_REPO;
    subdir = base;
  } else {
    // The `//` after the scheme is the scheme's; a second `//` names the folder.
    const scheme = url.startsWith("https://") ? "https://".length : url.startsWith("file://") ? "file://".length : 0;
    const cut = url.indexOf("//", scheme);
    if (cut >= 0) {
      if (subdir !== null) return { error: "Name the folder once: <url>//<folder>#<ref>" };
      subdir = url.slice(cut + 2);
      url = url.slice(0, cut);
    }
    const bad = urlProblem(url, seam);
    if (bad !== null) return { error: bad };
  }
  if (subdir === "") subdir = null;
  if (subdir !== null) {
    const bad = subdirProblem(subdir);
    if (bad !== null) return { error: bad };
  }
  if (ref !== null) {
    const bad = refProblem(ref);
    if (bad !== null) return { error: bad };
  }
  return { url, ref, subdir };
}

// ── the fetch ────────────────────────────────────────────────────────────────

/** One entry of the fetched tree. */
interface TreeEntry {
  mode: string;
  oid: string;
  size: number;
  /** Relative to the repository's top. */
  path: string;
}

/** A fetched repository, read from git's objects. */
interface Fetched {
  commit: string;
  tree: TreeEntry[];
  /** The bytes of blobs, by object id. */
  blobs(oids: readonly string[]): Promise<Map<string, Uint8Array>>;
}

/** A refusal with one plain reason. */
class Refused extends Error {}

function gitLine(result: GitResult): string {
  if (result.timedOut) return `git took longer than ${String(ADD_LIMITS.gitTimeoutMs / 1000)} s`;
  if (result.capped) return "git printed more than Collie reads; the repository is too large";
  const last = result.stderr.trim().split(/\r?\n/u).findLast((l) => l.trim() !== "");
  return redactText(last ?? `git exited with ${String(result.code)}`).slice(0, 300);
}

/** Parse `ls-tree -r -l -z`: `<mode> <type> <oid> <size>\t<path>\0`. */
function parseTree(bytes: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const record of new TextDecoder().decode(bytes).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const meta = record.slice(0, tab).split(" ").filter((w) => w !== "");
    const [mode, , oid, size] = meta;
    if (tab < 0 || mode === undefined || oid === undefined || size === undefined) throw new Refused("git listed the tree in a shape Collie does not read");
    out.push({ mode, oid, size: size === "-" ? 0 : Number(size), path: record.slice(tab + 1) });
  }
  return out;
}

/** Parse `cat-file --batch`: `<oid> <type> <size>\n<bytes>\n` per object. */
function parseBatch(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let at = 0;
  // Bounded: each pass moves `at` forward past one object, or ends the loop.
  for (let pass = 0; at < bytes.length && pass <= bytes.length; pass += 1) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) break;
    const head = new TextDecoder().decode(bytes.subarray(at, nl)).split(" ");
    const [oid, type, size] = head;
    if (oid === undefined || type !== "blob" || size === undefined) throw new Refused("git did not hand over a file of the trick");
    const n = Number(size);
    out.set(oid, bytes.slice(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

/** Fetch one commit of a source into `tmp` (a fresh folder) and read its tree. Runs nothing of the repository. */
async function fetchSource(source: Pick<TrickSource, "url" | "ref">, tmp: string, deps: TrickAddDeps): Promise<Fetched> {
  const allowFile = deps.seam?.allowLocal === true;
  const run = deps.git ?? spawnGit;
  const env = gitRunEnv(deps.ctx.env, allowFile);
  const repo = join(tmp, "repo.git");
  const hard = gitHardening(allowFile);
  const git = async (args: readonly string[], stdin?: Uint8Array): Promise<GitResult> => {
    const opts: GitRunOptions = stdin === undefined ? { cwd: tmp, env } : { cwd: tmp, env, stdin };
    return await run([...hard, ...args], opts);
  };
  const init = await git(["init", "--bare", "--quiet", "--template=", repo]);
  if (init.code !== 0) throw new Refused(`could not make a temp repository: ${gitLine(init)}`);
  const fetched = await git([`--git-dir=${repo}`, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source.url, source.ref ?? "HEAD"]);
  if (fetched.code !== 0 || fetched.timedOut) throw new Refused(`could not fetch ${source.url}${source.ref === null ? "" : ` at ${source.ref}`}: ${gitLine(fetched)}`);
  const parsed = await git([`--git-dir=${repo}`, "rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"]);
  const commit = new TextDecoder().decode(parsed.stdout).trim();
  if (parsed.code !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) throw new Refused(`could not read the fetched commit: ${gitLine(parsed)}`);
  const listed = await git([`--git-dir=${repo}`, "ls-tree", "-r", "-l", "-z", "--full-tree", commit]);
  if (listed.code !== 0 || listed.capped) throw new Refused(`could not list the fetched files: ${gitLine(listed)}`);
  return {
    commit,
    tree: parseTree(listed.stdout),
    async blobs(oids) {
      if (oids.length === 0) return new Map();
      const read = await git([`--git-dir=${repo}`, "cat-file", "--batch"], new TextEncoder().encode(`${oids.join("\n")}\n`));
      if (read.code !== 0 || read.capped) throw new Refused(`could not read the fetched files: ${gitLine(read)}`);
      return parseBatch(read.stdout);
    },
  };
}

// ── the trick inside it ──────────────────────────────────────────────────────

/** A regular file of the trick, relative to its folder. */
interface TrickFile {
  rel: string;
  bytes: Uint8Array;
  executable: boolean;
}

/** A trick read out of a fetched repository and checked: its id, manifest and the files to copy. */
interface Candidate {
  id: string;
  manifest: TrickManifest;
  commit: string;
  files: TrickFile[];
  /** Files left out: dot files and folders, `node_modules/`. */
  skipped: number;
}

/** Whether a relative path is copied: no step that starts with a dot, no `node_modules` folder. */
function copied(rel: string): boolean {
  return rel.split("/").every((step) => !step.startsWith(".") && step !== "node_modules");
}

/** The trick id a manifest names, read loosely: the strict reader then checks it against the folder. */
function manifestId(text: string, fallback: string | null): string | null {
  try {
    // SAFETY: `Bun.TOML.parse` answers with a parsed document; only `id` is read here, as a string, and
    // `readManifestText` checks the whole document strictly right after.
    const doc = Bun.TOML.parse(text) as JsonValue;
    return asJsonString(asJsonObject(doc)?.id) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Check the trick folder of a fetched tree and read its files. Throws {@link Refused} with one reason. */
async function readCandidate(fetched: Fetched, subdir: string | null): Promise<Candidate> {
  const prefix = subdir === null ? "" : `${subdir}/`;
  const mine = fetched.tree.filter((e) => e.path.startsWith(prefix)).map((e) => ({ mode: e.mode, oid: e.oid, size: e.size, rel: e.path.slice(prefix.length) }));
  if (mine.length === 0) throw new Refused(subdir === null ? "the repository is empty" : `the repository has no folder ${subdir}`);
  for (const e of mine) {
    if (e.mode === "120000") throw new Refused(`${e.rel} is a symbolic link. A trick holds regular files only.`);
    if (e.mode === "160000") throw new Refused(`${e.rel} is a submodule. A trick holds regular files only.`);
    if (e.mode !== "100644" && e.mode !== "100755") throw new Refused(`${e.rel} is not a regular file.`);
    if (e.rel.split("/").length > ADD_LIMITS.depth + 1) throw new Refused(`${e.rel} sits deeper than ${String(ADD_LIMITS.depth)} folders.`);
    // A control character or a backslash in a name is refused, so no platform reads it as another path.
    if (e.rel.includes("\\") || [...e.rel].some((ch) => ch.charCodeAt(0) < 0x20)) throw new Refused("a file name in the trick holds a control character or a backslash");
  }
  if (mine.length > ADD_LIMITS.files) throw new Refused(`the trick holds ${String(mine.length)} files, more than ${String(ADD_LIMITS.files)}`);
  const total = mine.reduce((sum, e) => sum + e.size, 0);
  if (total > ADD_LIMITS.bytes) throw new Refused(`the trick holds ${(total / (1024 * 1024)).toFixed(1)} MB, more than ${String(ADD_LIMITS.bytes / (1024 * 1024))} MB`);
  const manifestEntry = mine.find((e) => e.rel === MANIFEST_FILE);
  if (manifestEntry === undefined) throw new Refused(`there is no ${MANIFEST_FILE} in ${subdir ?? "the top of the repository"}`);
  if (manifestEntry.size > MANIFEST_BYTES_MAX) throw new Refused(`${MANIFEST_FILE} is larger than ${String(MANIFEST_BYTES_MAX / 1024)} KiB`);
  const keep = mine.filter((e) => copied(e.rel));
  const blobs = await fetched.blobs(keep.map((e) => e.oid));
  const files: TrickFile[] = keep.map((e) => {
    const bytes = blobs.get(e.oid);
    if (bytes === undefined || bytes.length !== e.size) throw new Refused(`git did not hand over ${e.rel}`);
    return { rel: e.rel, bytes, executable: e.mode === "100755" };
  });
  const manifestBytes = files.find((f) => f.rel === MANIFEST_FILE)?.bytes;
  if (manifestBytes === undefined) throw new Refused(`git did not hand over ${MANIFEST_FILE}`);
  const text = new TextDecoder().decode(manifestBytes);
  const id = manifestId(text, subdir === null ? null : basename(subdir));
  if (id === null || !isTrickId(id)) throw new Refused(`${MANIFEST_FILE} names no trick id Collie takes (1 to 32 of a-z, 0-9 and -)`);
  const read = readManifestText(text, id);
  if (read.manifest === undefined) {
    const first = read.refusals.find((r) => r.code !== "later") ?? read.refusals[0];
    throw new Refused(`${MANIFEST_FILE}${first === undefined || first.path === "" ? "" : ` ${first.path}`}: ${first?.reason ?? "is refused"}`);
  }
  return { id, manifest: read.manifest, commit: fetched.commit, files, skipped: mine.length - keep.length };
}

/** Write a candidate's files into a new folder `dir` (owner only), and its origin record. */
async function writeCandidate(dir: string, candidate: Candidate, origin: TrickOrigin): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  for (const file of candidate.files) {
    const path = join(dir, file.rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // `wx`: a path written twice is a bug, never an overwrite.
    await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
  }
  await writeFile(join(dir, ORIGIN_FILE), renderOrigin(origin), { mode: 0o600 });
}

/** A fresh temp folder under the state folder for one fetch. Its name starts with a dot: never a trick's state folder. */
async function fetchFolder(deps: Pick<TrickDeps, "ctx">): Promise<string> {
  const root = tricksStateDir(deps.ctx.stateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(root, ".fetch-"));
}

/** A sibling name in the tricks folder for a staged or set-aside folder. The bridge never reads a dot folder. */
function sideName(root: string, what: "add" | "old", id: string): string {
  return join(root, `.collie-${what}-${id}-${randomBytes(4).toString("hex")}`);
}

/** Fetch a source, check the trick in it, and hand it to `use`. The temp folder goes on every path. */
async function withCandidate<T>(deps: TrickAddDeps, source: TrickSource, use: (c: Candidate) => Promise<T>): Promise<T> {
  const fetchDir = await fetchFolder(deps);
  try {
    const fetched = await fetchSource(source, fetchDir, deps);
    return await use(await readCandidate(fetched, source.subdir));
  } finally {
    await rm(fetchDir, { recursive: true, force: true });
  }
}

function originOf(source: TrickSource, commit: string, now: number): TrickOrigin {
  return { url: source.url, ref: source.ref, commit, subdir: source.subdir, at: new Date(now).toISOString() };
}

function sourceWords(source: TrickSource): string {
  const where = source.subdir === null ? source.url : `${source.url}//${source.subdir}`;
  return source.ref === null ? where : `${where}#${source.ref}`;
}

/** The check scan's word on a folder: its warnings with the honesty line, and its problems. */
async function printCheck(deps: TrickAddDeps, dir: string): Promise<void> {
  const report = await checkStatic(dir, deps.files, { crew: leadsCrewOnDisk(deps) });
  if (report.reads !== undefined) deps.io.out(`It reads files: ${report.reads}`);
  if (report.warnings.length === 0) deps.io.out("The check scan found no warnings.");
  for (const line of warningLines(report.warnings)) deps.io.out(line);
  if (report.warnings.length > 0) deps.io.out(WARNINGS_HONESTY);
  for (const p of report.problems) deps.io.out(`problem: ${p}`);
}

function refuse(deps: Pick<TrickDeps, "io">, line: string): number {
  deps.io.err(`error: ${line}`);
  return EXIT.FAIL;
}

// ── add ──────────────────────────────────────────────────────────────────────

export const ADD_USAGE = "usage: collie trick add [<name> | <https-url>[//<folder>][#<ref>]]";

/** `collie trick add [<source>]`. With no source, the official repository's list; it installs nothing. */
export async function cmdTrickAdd(deps: TrickAddDeps, args: readonly string[]): Promise<number> {
  const flags = args.filter((a) => a.startsWith("-"));
  const words = args.filter((a) => !a.startsWith("-"));
  if (flags.length > 0 || words.length > 1) {
    deps.io.err(ADD_USAGE);
    return EXIT.USAGE;
  }
  const raw = words[0];
  if (raw === undefined) return await listOfficial(deps);
  const source = parseTrickSource(raw, deps.seam);
  if ("error" in source) {
    deps.io.err(`error: ${source.error}`);
    deps.io.err(ADD_USAGE);
    return EXIT.USAGE;
  }
  const root = tricksConfigDir(deps.ctx.configDir);
  try {
    return await withCandidate(deps, source, async (candidate) => {
      const dir = join(root, candidate.id);
      if ((await lstat(dir).catch(() => null)) !== null) {
        return refuse(deps, `a trick ${candidate.id} is already in ${root}. To fetch it again: collie trick update ${candidate.id}`);
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      const staged = sideName(root, "add", candidate.id);
      try {
        await writeCandidate(staged, candidate, originOf(source, candidate.commit, deps.now()));
        await rename(staged, dir);
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
      deps.io.out(`Added ${candidate.id} (${candidate.manifest.name}) to ${dir}`);
      deps.io.out(`From ${sourceWords(source)} at commit ${candidate.commit}.`);
      deps.io.out(`${String(candidate.files.length)} files copied${candidate.skipped > 0 ? `; ${String(candidate.skipped)} dot files, dot folders and node_modules files left out` : ""}.`);
      await printCheck(deps, dir);
      deps.io.out(`The trick is off. Read it, then: collie trick on ${candidate.id}`);
      return EXIT.OK;
    });
  } catch (err) {
    if (err instanceof Refused) return refuse(deps, `${err.message.replace(/\.$/u, "")}. Nothing was added.`);
    throw err;
  }
}

/** The first comment line of a `trick.toml`: its one-line description in the list. */
export function manifestBlurb(text: string): string {
  for (const raw of text.split(/\r?\n/u)) {
    const t = raw.trim();
    if (t === "") continue;
    if (!t.startsWith("#")) return "-";
    const words = t.replace(/^#+\s*/u, "").trim();
    return words === "" ? "-" : words.slice(0, 100);
  }
  return "-";
}

/** `collie trick add` with no source: the tricks of the official repository, and how to add one. */
async function listOfficial(deps: TrickAddDeps): Promise<number> {
  const url = deps.seam?.officialRepo ?? OFFICIAL_TRICKS_REPO;
  const fetchDir = await fetchFolder(deps);
  try {
    const fetched = await fetchSource({ url, ref: null }, fetchDir, deps);
    const manifests = fetched.tree.filter((e) => /^[a-z0-9-]{1,32}\/trick\.toml$/u.test(e.path) && e.mode === "100644" && e.size <= MANIFEST_BYTES_MAX).slice(0, ADD_LIMITS.listed);
    const blobs = await fetched.blobs(manifests.map((e) => e.oid));
    const rows = manifests.map((e) => {
      const id = e.path.slice(0, e.path.indexOf("/"));
      const text = new TextDecoder().decode(blobs.get(e.oid) ?? new Uint8Array(0));
      const read = readManifestText(text, id);
      return [id, read.manifest?.name ?? "(refused by this Collie)", manifestBlurb(text)];
    });
    deps.io.out(`Tricks in ${url} at ${fetched.commit.slice(0, 7)}:`);
    if (rows.length === 0) deps.io.out("  none yet");
    const widths = [0, 1].map((i) => Math.max(2, ...rows.map((r) => (r[i] ?? "").length)));
    for (const r of rows) deps.io.out(`  ${(r[0] ?? "").padEnd(widths[0] ?? 0)}  ${(r[1] ?? "").padEnd(widths[1] ?? 0)}  ${r[2] ?? ""}`);
    deps.io.out("Add one with: collie trick add <id>. It is copied into your tricks folder, off. Nothing is installed until you add it.");
    return EXIT.OK;
  } catch (err) {
    if (err instanceof Refused) return refuse(deps, err.message);
    throw err;
  } finally {
    await rm(fetchDir, { recursive: true, force: true });
  }
}

// ── update ───────────────────────────────────────────────────────────────────

export const UPDATE_USAGE = "usage: collie trick update <id> [--ref <branch|tag|commit>] [--dry-run]";

/** The regular files of a trick folder that the code hash counts, by path, with their SHA-256. */
async function codeFiles(dir: string): Promise<Map<string, string>> {
  const walk = await walkTrickCode(diskTrickFs, dir);
  const out = new Map<string, string>();
  if (!walk.ok) return out;
  for (const e of walk.entries) {
    const bytes = e.kind === "file" ? await diskTrickFs.read(join(dir, e.rel), ADD_LIMITS.bytes + 1) : null;
    out.set(e.rel, `${e.kind}:${bytes === null ? "" : createHash("sha256").update(bytes).digest("hex")}`);
  }
  return out;
}

/** Whether a candidate's file counts in the code hash, by the walk's own rule. */
function hashed(rel: string): boolean {
  const steps = rel.split("/");
  return steps.every((step, i) => !skippedName(step, i === steps.length - 1 ? "file" : "dir", i));
}

/** Added, changed and removed code files, old folder against candidate. */
/** How many code files an update adds, changes and removes. */
interface FileCounts {
  added: number;
  changed: number;
  removed: number;
}

function fileCounts(old: Map<string, string>, candidate: Candidate): FileCounts {
  const next = new Map(candidate.files.filter((f) => hashed(f.rel)).map((f) => [f.rel, `file:${createHash("sha256").update(f.bytes).digest("hex")}`]));
  let added = 0;
  let changed = 0;
  for (const [rel, sum] of next) {
    const was = old.get(rel);
    if (was === undefined) added += 1;
    else if (was !== sum) changed += 1;
  }
  const removed = [...old.keys()].filter((rel) => !next.has(rel)).length;
  return { added, changed, removed };
}

const warningKey = (w: CheckWarning): string => `${w.kind}\0${w.file}\0${w.text}`;

/** `collie trick update <id> [--ref <ref>] [--dry-run]`: fetch the source again and replace the code, keeping config.toml. */
export async function cmdTrickUpdate(deps: TrickAddDeps, args: readonly string[]): Promise<number> {
  const dry = args.includes("--dry-run");
  const refAt = args.indexOf("--ref");
  const askedRef = refAt < 0 ? undefined : args[refAt + 1];
  const rest = args.filter((a, i) => a !== "--dry-run" && i !== refAt && (refAt < 0 || i !== refAt + 1));
  const id = rest[0];
  if (id === undefined || rest.length > 1 || rest.some((a) => a.startsWith("-")) || !isTrickId(id) || (refAt >= 0 && (askedRef === undefined || askedRef.startsWith("-")))) {
    deps.io.err(UPDATE_USAGE);
    return EXIT.USAGE;
  }
  if (askedRef !== undefined) {
    const bad = refProblem(askedRef);
    if (bad !== null) return refuse(deps, bad);
  }
  const root = tricksConfigDir(deps.ctx.configDir);
  const dir = join(root, id);
  const st = await lstat(dir).catch(() => null);
  if (st === null || !st.isDirectory()) return refuse(deps, `there is no trick folder ${dir}`);
  const origin = await readOrigin(dir);
  if (origin === null) return refuse(deps, `${id} was not added with collie trick add, so it has no source to update from`);
  const source: TrickSource = { url: origin.url, ref: askedRef ?? origin.ref, subdir: origin.subdir };
  const badUrl = urlProblem(source.url, deps.seam);
  if (badUrl !== null) return refuse(deps, `the origin record of ${id} names a source Collie does not fetch: ${badUrl}`);
  if (source.subdir !== null && subdirProblem(source.subdir) !== null) return refuse(deps, `the origin record of ${id} names a folder Collie does not take`);
  try {
    return await withCandidate(deps, source, async (candidate) => {
      if (candidate.id !== id) return refuse(deps, `the source now holds the trick ${candidate.id}, not ${id}. Nothing was changed.`);
      const staged = sideName(root, "add", id);
      try {
        await writeCandidate(staged, { ...candidate, files: candidate.files.filter((f) => f.rel !== CONFIG_FILE) }, originOf(source, candidate.commit, deps.now()));
        // The person's settings stay: config.toml is theirs, outside the code hash. With none, the repository's is taken.
        // `read` opens no symlink and only a regular file, so a link named config.toml is not followed.
        const local = await diskTrickFs.read(join(dir, CONFIG_FILE), ADD_LIMITS.bytes);
        const shipped = candidate.files.find((f) => f.rel === CONFIG_FILE)?.bytes ?? null;
        const config = local ?? shipped;
        if (config !== null) await writeFile(join(staged, CONFIG_FILE), config, { mode: 0o600 });
        const [oldHash, newHash, oldFiles] = await Promise.all([trickCodeHash(dir), trickCodeHash(staged), codeFiles(dir)]);
        const counts = fileCounts(oldFiles, candidate);
        const oldManifest = (await readManifestFile(diskTrickFs, dir, id)).manifest;
        const before = new Set((oldManifest === undefined ? [] : await trickWarnings(dir, oldManifest)).map(warningKey));
        const fresh = (await trickWarnings(staged, candidate.manifest)).filter((w) => !before.has(warningKey(w)));
        const codeMoved = !oldHash.ok || !newHash.ok || oldHash.hash !== newHash.hash;
        deps.io.out(`${id}: ${origin.commit.slice(0, 7)} -> ${candidate.commit.slice(0, 7)} (${sourceWords(source)})`);
        deps.io.out(`files: ${String(counts.added)} added, ${String(counts.changed)} changed, ${String(counts.removed)} removed`);
        if (fresh.length === 0) deps.io.out("No new warnings from the check scan.");
        else deps.io.out("New warnings from the check scan:");
        for (const line of warningLines(fresh)) deps.io.out(line);
        if (fresh.length > 0) deps.io.out(WARNINGS_HONESTY);
        if (!codeMoved && origin.commit === candidate.commit) {
          deps.io.out(`${id} is already at ${candidate.commit.slice(0, 7)}. Nothing to update.`);
          return EXIT.OK;
        }
        if (dry) {
          deps.io.out("Nothing was changed (--dry-run).");
          return EXIT.OK;
        }
        await swapFolder(root, id, dir, staged);
        deps.io.out(`Updated ${id} to ${candidate.commit}. config.toml and the trick's state folder are kept.`);
        const on = parseSwitches(deps.files.read(switchesPath(deps.ctx.stateDir))).switches.on.has(id);
        if (codeMoved && on) deps.io.out(`The code changed. ${id} keeps running the version you approved; the new one waits for your yes. Read it, then approve it on the phone or: collie trick on ${id}`);
        else if (on) deps.io.out(`The code did not change, so ${id} stays on.`);
        else deps.io.out(`The trick is off. Read it, then: collie trick on ${id}`);
        return EXIT.OK;
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
    });
  } catch (err) {
    if (err instanceof Refused) return refuse(deps, `${err.message.replace(/\.$/u, "")}. Nothing was changed.`);
    throw err;
  }
}

/**
 * Put `staged` in the place of `dir`: the old folder is renamed aside, the new one renamed in, the old one
 * removed. Two renames in one folder, so a reader sees the old trick or the new one, never half of each;
 * a failed second rename puts the old folder back.
 */
async function swapFolder(root: string, id: string, dir: string, staged: string): Promise<void> {
  const aside = sideName(root, "old", id);
  await rename(dir, aside);
  try {
    await rename(staged, dir);
  } catch (err) {
    await rename(aside, dir);
    throw err;
  }
  await chmod(dir, 0o700).catch(() => {});
  await rm(aside, { recursive: true, force: true });
}

// ── remove ───────────────────────────────────────────────────────────────────

/** `collie trick remove <id>`: only while it is off. The folder, its state folder and its approved and pending copies go; nothing is kept. */
export async function cmdTrickRemove(deps: TrickDeps, args: readonly string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (id === undefined || !isTrickId(id) || args.length !== 1) {
    deps.io.err("usage: collie trick remove <id>   (the trick must be off)");
    return EXIT.USAGE;
  }
  const dir = join(tricksConfigDir(deps.ctx.configDir), id);
  const st = await lstat(dir).catch(() => null);
  if (st === null) return refuse(deps, `there is no trick folder ${dir}`);
  if (!st.isDirectory()) return refuse(deps, `${dir} is not a folder (a link or a file), so it is left alone`);
  if (parseSwitches(deps.files.read(switchesPath(deps.ctx.stateDir))).switches.on.has(id)) {
    return refuse(deps, `${id} is on. Switch it off first: collie trick off ${id}`);
  }
  const state = trickStateDir(deps.ctx.stateDir, id);
  await rm(dir, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  await removeTrickCopies(deps.ctx.configDir, id);
  deps.io.out(`Removed ${id}: ${dir}, its state folder ${state} and its approved copies.`);
  return EXIT.OK;
}

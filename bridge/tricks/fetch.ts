import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HOST } from "../host.ts";
import { redactText } from "../redact.ts";
import type { JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { isTrickId, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { MANIFEST_BYTES_MAX, readManifestText } from "./discover.ts";
import { MANIFEST_FILE } from "./paths.ts";

// THE HARDENED GIT FETCH OF A TRICK (M94 review 15), shared by `collie trick add` and `update`
// (cli/trick-add.ts) and the From Collie list (official-install.ts). Moved here from the CLI so the
// bridge runs the very same lines; `collie trick add` behaves as it did.
//
// ── WHAT A REPOSITORY MAY NOT DO ──────────────────────────────────────────────────────────────────
// Nothing from the repository is ever executed, and git never writes a working tree. The fetch goes into
// a fresh BARE repository in a temp folder under the state folder (never the tricks folder):
//
//   git init --bare --quiet --template= <tmp>/repo.git
//   git <H> --git-dir=<tmp>/repo.git ls-remote --refs -- <url> refs/tags/<name> refs/heads/<name>   (a short name only)
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
// `gitTimeoutMs` (or sooner, at the caller's deadline), its output capped. On POSIX each run starts its own
// process group and a kill takes the whole group, so `git-remote-https` and any other helper git starts go
// with it. With `maxBytes` (the From Collie list), the temp repository is measured while the fetch runs and
// once after it: past the cap the fetch is killed and refused, before anything is read from it. git itself
// offers no size limit on a fetch (`receive.maxInputSize` is the push side only). For `collie trick add` the
// operator's own global git config is trusted, as their shell is (a credential helper for a private
// repository keeps working); the From Collie list reads none (official-install.ts `OFFICIAL_GIT`).
//
// The tree is read from git's own objects, so its modes are git's: a symlink (120000) or a submodule
// (160000) anywhere in the trick's folder refuses the trick, on every platform. Collie writes each
// regular file itself. Then the strict manifest reader must accept `trick.toml` at this contract, the
// caps hold, and the id is free. Dot files and dot folders and `node_modules/` are not copied: they are
// outside the code hash (code-hash.ts), so they would be code the person never approved.
//
// WHICH REF (security review of the From Collie list): only a branch or a tag, or a full commit id. A ref
// that starts with `refs/` must be `refs/heads/...` or `refs/tags/...`: `refs/pull/N/head` on GitHub is a
// stranger's pull request served through the repository's own URL, and is refused. A short name is never
// handed to git as it is, because git's own lookup would also try `refs/<name>` (so `pull/5/head` would be
// that pull request): it is looked up as exactly `refs/tags/<name>` or `refs/heads/<name>` (a tag first, as
// git's lookup orders them) and the fetch names the full ref it found. A full commit id is fetched as it is;
// `collie trick add` refuses one for the official repository (cli/trick-add.ts), where a fork's commit is
// reachable by its id too.
//
// A local folder or `file://` URL is accepted only with `allowFile`, which only a test seam and the
// maintainer script (scripts/official-tricks.ts, reading a local checkout) set.

/** Every cap of a fetched trick, in one place: `collie trick add`, `update` and the From Collie list. */
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
  /** Kill the run after this many ms. Default {@link ADD_LIMITS} `gitTimeoutMs`. */
  timeoutMs?: number;
  /** Kill the run when this aborts (the byte watch of a fetch). */
  signal?: AbortSignal;
}

/** How git is run. The real one spawns `git`; a test may wrap it. */
export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitResult>;

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

/** Each run leads a process group of its own on POSIX, so a kill reaches every helper git started. */
const GROUP = HOST.platform !== "win32";

/** Kill a run and, on POSIX, its whole process group. */
function killRun(proc: { pid: number; kill: (signal?: number) => void }): void {
  if (GROUP) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group is gone already; the leader below is the last thing to make sure of.
    }
  }
  proc.kill(9);
}

/** The real runner: `git` from the PATH the run gets, argv only, killed (with its group) at the timeout. */
export const spawnGit: GitRunner = async (args, opts) => {
  const git = Bun.which("git", { PATH: opts.env.PATH ?? "" });
  if (git === null) return { code: 127, stdout: new Uint8Array(0), stderr: "git is not on PATH", timedOut: false, capped: false };
  // stdin is always a pipe: written and closed at once when the run has input, closed empty when not.
  const proc = Bun.spawn([git, ...args], { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: GROUP });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      killRun(proc);
    },
    Math.max(0, opts.timeoutMs ?? ADD_LIMITS.gitTimeoutMs),
  );
  const onAbort = (): void => killRun(proc);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted === true) killRun(proc);
  try {
    if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
    await proc.stdin.end();
    const [out, err] = await Promise.all([readCapped(proc.stdout, ADD_LIMITS.gitStdoutBytes), readCapped(proc.stderr, 64 * 1024)]);
    if (out.capped) killRun(proc);
    const code = await proc.exited;
    return { code, stdout: out.bytes, stderr: new TextDecoder().decode(err.bytes), timedOut, capped: out.capped };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * The bytes under `dir`, by lstat (a link is its own size, never followed), counting stops once past
 * `cap`. Bounded by `entries` so a folder of many tiny files cannot keep it walking.
 */
export async function folderBytes(dir: string, cap: number, entries = 100_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const queue = [dir];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const names = await readdir(next).catch(() => []);
    for (const name of names) {
      seen += 1;
      if (seen > entries) return Number.POSITIVE_INFINITY;
      const path = join(next, name);
      const st = await lstat(path).catch(() => null);
      if (st === null) continue;
      if (st.isDirectory()) queue.push(path);
      total += st.size;
      if (total > cap) return total;
    }
  }
  return total;
}

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

// ── the fetch ────────────────────────────────────────────────────────────────

/**
 * Which step refused: `local` (Collie's own temp repository), `fetch` (reaching the source), `size` (the
 * source sent more than `maxBytes`), `check` (what came back).
 */
export type FetchStep = "local" | "fetch" | "size" | "check";

/** A refusal with one plain reason, and the step it came from. */
export class FetchRefused extends Error {
  readonly step: FetchStep;
  constructor(message: string, step: FetchStep = "check") {
    super(message);
    this.step = step;
  }
}

/** How one fetch runs: the caller's environment, the runner, and what the source may be. */
export interface FetchOptions {
  env: Record<string, string | undefined>;
  /** The runner; {@link spawnGit} when absent. */
  git?: GitRunner;
  /** A local folder or `file://` URL may be the source: the tests' seam and the maintainer script only. */
  allowFile: boolean;
  /** More `-c` settings after the hardening (the From Collie list's). */
  extraConfig?: readonly string[];
  /** More environment after {@link gitRunEnv} (the From Collie list's). */
  extraEnv?: Readonly<Record<string, string>>;
  /** An instant (epoch ms) by which every git run must have ended: each run is killed at the sooner of it and its own cap. */
  deadline?: number;
  now?: () => number;
  /** The most bytes the temp repository may hold after the fetch, watched while it runs. Absent: no cap. */
  maxBytes?: number;
  /** How often the byte watch measures, in ms. Default 200. */
  watchMs?: number;
}

/** One entry of the fetched tree. */
interface TreeEntry {
  mode: string;
  oid: string;
  size: number;
  /** Relative to the repository's top. */
  path: string;
}

/** A fetched repository, read from git's objects. */
export interface Fetched {
  commit: string;
  tree: TreeEntry[];
  /** The bytes of blobs, by object id. */
  blobs(oids: readonly string[]): Promise<Map<string, Uint8Array>>;
}

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
    if (tab < 0 || mode === undefined || oid === undefined || size === undefined) throw new FetchRefused("git listed the tree in a shape Collie does not read");
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
    if (oid === undefined || type !== "blob" || size === undefined) throw new FetchRefused("git did not hand over a file of the trick");
    const n = Number(size);
    out.set(oid, bytes.slice(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

/** A full commit id. */
const FULL_COMMIT = /^[0-9a-f]{40}$/u;

/** Why a ref is not one Collie fetches (a `refs/` name outside heads and tags), or null. */
export function refNamespaceProblem(ref: string): string | null {
  if (!ref.startsWith("refs/") || ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) return null;
  return `"${ref}" is not a branch or a tag. Collie fetches refs/heads/... and refs/tags/... only.`;
}

/**
 * What the fetch names for a source's ref: `HEAD` for none, a full commit id or a full branch or tag ref as
 * it is, and a short name as the one full tag or branch ref the repository has by exactly that name.
 */
async function fetchRef(source: { url: string; ref: string | null }, git: (args: readonly string[]) => Promise<GitResult>): Promise<string> {
  const ref = source.ref;
  if (ref === null) return "HEAD";
  const outside = refNamespaceProblem(ref);
  if (outside !== null) throw new FetchRefused(outside);
  if (FULL_COMMIT.test(ref) || ref.startsWith("refs/")) return ref;
  const wanted = [`refs/tags/${ref}`, `refs/heads/${ref}`];
  const listed = await git(["ls-remote", "--refs", "--", source.url, ...wanted]);
  if (listed.code !== 0 || listed.timedOut) throw new FetchRefused(`could not fetch ${source.url} at ${ref}: ${gitLine(listed)}`, "fetch");
  const names = new Set(new TextDecoder().decode(listed.stdout).split("\n").map((line) => line.split("\t")[1]?.trim()));
  const found = wanted.find((full) => names.has(full));
  if (found === undefined) throw new FetchRefused(`${source.url} has no branch or tag named ${ref}`);
  return found;
}

/** Fetch one commit of a source into `tmp` (a fresh folder) and read its tree. Runs nothing of the repository. */
export async function fetchSource(source: { url: string; ref: string | null }, tmp: string, opts: FetchOptions): Promise<Fetched> {
  const run = opts.git ?? spawnGit;
  const now = opts.now ?? Date.now;
  const env = { ...gitRunEnv(opts.env, opts.allowFile), ...opts.extraEnv };
  const repo = join(tmp, "repo.git");
  const hard = [...gitHardening(opts.allowFile), ...(opts.extraConfig ?? []).flatMap((kv) => ["-c", kv])];
  const git = async (args: readonly string[], stdin?: Uint8Array, signal?: AbortSignal): Promise<GitResult> => {
    const left = opts.deadline === undefined ? ADD_LIMITS.gitTimeoutMs : Math.min(ADD_LIMITS.gitTimeoutMs, opts.deadline - now());
    // Past the caller's deadline nothing more runs: the whole fetch took too long, as a slow source does.
    if (left <= 0) throw new FetchRefused("the fetch took longer than Collie waits", "fetch");
    const base: GitRunOptions = signal === undefined ? { cwd: tmp, env, timeoutMs: left } : { cwd: tmp, env, timeoutMs: left, signal };
    return await run([...hard, ...args], stdin === undefined ? base : { ...base, stdin });
  };
  const init = await git(["init", "--bare", "--quiet", "--template=", repo]);
  if (init.code !== 0) throw new FetchRefused(`could not make a temp repository: ${gitLine(init)}`, "local");
  const want = await fetchRef(source, (args) => git([`--git-dir=${repo}`, ...args]));
  const watch = opts.maxBytes === undefined ? null : watchBytes(repo, opts.maxBytes, opts.watchMs ?? 200);
  let fetched: GitResult;
  try {
    fetched = await git([`--git-dir=${repo}`, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source.url, want], undefined, watch?.signal);
  } finally {
    watch?.stop();
  }
  // Past the cap while it ran, or once it ended: refused before anything is read from it.
  if (opts.maxBytes !== undefined && (watch?.signal.aborted === true || (await folderBytes(repo, opts.maxBytes)) > opts.maxBytes)) {
    throw new FetchRefused(`the repository sent more than ${String(Math.round(opts.maxBytes / 1024))} KiB`, "size");
  }
  if (fetched.code !== 0 || fetched.timedOut) throw new FetchRefused(`could not fetch ${source.url}${source.ref === null ? "" : ` at ${source.ref}`}: ${gitLine(fetched)}`, "fetch");
  const parsed = await git([`--git-dir=${repo}`, "rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"]);
  const commit = new TextDecoder().decode(parsed.stdout).trim();
  if (parsed.code !== 0 || !FULL_COMMIT.test(commit)) throw new FetchRefused(`could not read the fetched commit: ${gitLine(parsed)}`);
  const listed = await git([`--git-dir=${repo}`, "ls-tree", "-r", "-l", "-z", "--full-tree", commit]);
  if (listed.code !== 0 || listed.capped) throw new FetchRefused(`could not list the fetched files: ${gitLine(listed)}`);
  return {
    commit,
    tree: parseTree(listed.stdout),
    async blobs(oids) {
      if (oids.length === 0) return new Map();
      const read = await git([`--git-dir=${repo}`, "cat-file", "--batch"], new TextEncoder().encode(`${oids.join("\n")}\n`));
      if (read.code !== 0 || read.capped) throw new FetchRefused(`could not read the fetched files: ${gitLine(read)}`);
      return parseBatch(read.stdout);
    },
  };
}

/** A running byte watch: its signal aborts past the cap; `stop` ends the measuring. */
interface ByteWatch {
  signal: AbortSignal;
  stop: () => void;
}

/** Measure `dir` every `everyMs` while a fetch runs, and abort the run once it holds more than `cap` bytes. */
function watchBytes(dir: string, cap: number, everyMs: number): ByteWatch {
  const controller = new AbortController();
  let measuring = false;
  const timer = setInterval(() => {
    if (measuring || controller.signal.aborted) return;
    measuring = true;
    void folderBytes(dir, cap).then(
      (bytes) => {
        measuring = false;
        if (bytes > cap) controller.abort();
        return bytes;
      },
      () => {
        measuring = false;
      },
    );
  }, everyMs);
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

// ── the trick inside it ──────────────────────────────────────────────────────

/** A regular file of the trick, relative to its folder. */
export interface TrickFile {
  rel: string;
  bytes: Uint8Array;
  executable: boolean;
}

/** A trick read out of a fetched repository and checked: its id, manifest and the files to copy. */
export interface Candidate {
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

/** Check the trick folder of a fetched tree and read its files. Throws {@link FetchRefused} with one reason. */
export async function readCandidate(fetched: Fetched, subdir: string | null): Promise<Candidate> {
  const prefix = subdir === null ? "" : `${subdir}/`;
  const mine = fetched.tree.filter((e) => e.path.startsWith(prefix)).map((e) => ({ mode: e.mode, oid: e.oid, size: e.size, rel: e.path.slice(prefix.length) }));
  if (mine.length === 0) throw new FetchRefused(subdir === null ? "the repository is empty" : `the repository has no folder ${subdir}`);
  for (const e of mine) {
    if (e.mode === "120000") throw new FetchRefused(`${e.rel} is a symbolic link. A trick holds regular files only.`);
    if (e.mode === "160000") throw new FetchRefused(`${e.rel} is a submodule. A trick holds regular files only.`);
    if (e.mode !== "100644" && e.mode !== "100755") throw new FetchRefused(`${e.rel} is not a regular file.`);
    if (e.rel.split("/").length > ADD_LIMITS.depth + 1) throw new FetchRefused(`${e.rel} sits deeper than ${String(ADD_LIMITS.depth)} folders.`);
    // A control character or a backslash in a name is refused, so no platform reads it as another path.
    if (e.rel.includes("\\") || [...e.rel].some((ch) => ch.charCodeAt(0) < 0x20)) throw new FetchRefused("a file name in the trick holds a control character or a backslash");
  }
  if (mine.length > ADD_LIMITS.files) throw new FetchRefused(`the trick holds ${String(mine.length)} files, more than ${String(ADD_LIMITS.files)}`);
  const total = mine.reduce((sum, e) => sum + e.size, 0);
  if (total > ADD_LIMITS.bytes) throw new FetchRefused(`the trick holds ${(total / (1024 * 1024)).toFixed(1)} MB, more than ${String(ADD_LIMITS.bytes / (1024 * 1024))} MB`);
  const manifestEntry = mine.find((e) => e.rel === MANIFEST_FILE);
  if (manifestEntry === undefined) throw new FetchRefused(`there is no ${MANIFEST_FILE} in ${subdir ?? "the top of the repository"}`);
  if (manifestEntry.size > MANIFEST_BYTES_MAX) throw new FetchRefused(`${MANIFEST_FILE} is larger than ${String(MANIFEST_BYTES_MAX / 1024)} KiB`);
  const keep = mine.filter((e) => copied(e.rel));
  const blobs = await fetched.blobs(keep.map((e) => e.oid));
  const files: TrickFile[] = keep.map((e) => {
    const bytes = blobs.get(e.oid);
    if (bytes === undefined || bytes.length !== e.size) throw new FetchRefused(`git did not hand over ${e.rel}`);
    return { rel: e.rel, bytes, executable: e.mode === "100755" };
  });
  const manifestBytes = files.find((f) => f.rel === MANIFEST_FILE)?.bytes;
  if (manifestBytes === undefined) throw new FetchRefused(`git did not hand over ${MANIFEST_FILE}`);
  const text = new TextDecoder().decode(manifestBytes);
  const id = manifestId(text, subdir === null ? null : basename(subdir));
  if (id === null || !isTrickId(id)) throw new FetchRefused(`${MANIFEST_FILE} names no trick id Collie takes (1 to 32 of a-z, 0-9 and -)`);
  const read = readManifestText(text, id);
  if (read.manifest === undefined) {
    const first = read.refusals.find((r) => r.code !== "later") ?? read.refusals[0];
    throw new FetchRefused(`${MANIFEST_FILE}${first === undefined || first.path === "" ? "" : ` ${first.path}`}: ${first?.reason ?? "is refused"}`);
  }
  return { id, manifest: read.manifest, commit: fetched.commit, files, skipped: mine.length - keep.length };
}

/**
 * Write a candidate's files into a new folder `dir` (owner only), and one dot file of `extra` beside them
 * (the origin record). A path written twice is a bug, never an overwrite (`wx`).
 */
export async function writeCandidateFiles(dir: string, files: readonly TrickFile[], extra?: { name: string; text: string }): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  for (const file of files) {
    const path = join(dir, file.rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
  }
  if (extra !== undefined) await writeFile(join(dir, extra.name), extra.text, { flag: "wx", mode: 0o600 });
}

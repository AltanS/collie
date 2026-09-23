// THE CHANGES VIEW'S BRIDGE HALF — what changed under a pane's folder since the last commit, read
// with git and nothing else (ADR 0065). Read-only by construction: no verb here stages, commits,
// checks out or writes, and every git run carries `GIT_OPTIONAL_LOCKS=0`, so not even the index's
// stat cache is refreshed on disk.
//
// ── WHAT THE CLIENT MAY NAME ────────────────────────────────────────────────────────────────────
// The request carries a pane id, a depth, a nested flag, and for a diff a `repo` and a `path`. The
// pane id is a Map lookup (the folder comes off the live snapshot, never off the request). The repo
// and the path are LOOKED UP, never joined blind: a diff is served only for a `repo` the same
// discovery (same depth, same nested flag) returns, and only for a `path` git itself listed as
// changed in that repo. Anything else is `unknown-repo` / `unknown-path` before a path exists. An
// untracked file is the one read this module does off the disk itself, and it additionally goes
// through `containedRealpath` (bridge/journal/files.ts), so a listed symlink that points out of the
// repo is refused on the real paths. That makes this the SECOND place a client-supplied value
// becomes a path; files.ts's header says so and names the bound.
//
// ── WHAT A REPO MAY NOT DO TO US ────────────────────────────────────────────────────────────────
// A repo's own config is untrusted input: an agent may have cloned anything, and `git status` on a
// hostile checkout is a known code-execution vector. Every git run here is `argv`, never a shell,
// with a timeout and an output cap, and it neutralises each repo-driven way to make git run a
// program during status or diff:
//   • `core.fsmonitor=false` — the fsmonitor hook (and the builtin daemon) would run on status.
//   • `core.hooksPath=/dev/null` — no hook runs on these verbs; set anyway, it costs nothing.
//   • `diff.external=` plus `--no-ext-diff` — an external diff driver, global or per-attribute.
//   • `--no-textconv` — a `diff.<driver>.textconv` program.
//   • filter drivers — `.gitattributes` can name a `filter.<name>` whose `clean` runs when status
//     hashes a worktree file. We READ the configured names first (`git config --get-regexp`, which
//     executes nothing) and override each driver's clean/smudge/process to empty and `required` to
//     false. Git treats an empty command as "no filter". Consequence: a Git LFS file whose stat
//     changed reads as modified against its pointer. That is the price, and it is documented.
//   • `core.pager=cat`, `--no-pager`, `color.ui=false` — no pager program, no colour codes.
//   • `status.submoduleSummary=false` and `--ignore-submodules=dirty` — status never recurses into
//     a submodule's worktree (which would run git there under THAT repo's config). A submodule's
//     own changes are shown when discovery finds it as a repo of its own.
//   • `--git-dir` + `--work-tree` are explicit, from the folder where discovery found `.git`, so a
//     repo's `core.worktree` cannot point the scan somewhere else. `--literal-pathspecs`, so a file
//     named `*` or `:(glob)x` is one path and never a pattern.
//   • The environment: every inherited `GIT_*` variable is dropped (a stray `GIT_DIR`,
//     `GIT_EXTERNAL_DIFF` or `GIT_CONFIG_PARAMETERS` in the bridge's env must not steer this), then
//     `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and `GIT_CONFIG_NOSYSTEM=1` are set.
//   • No network, ever. In a partial clone a missing blob makes git lazy-fetch from the promisor
//     remote, and the repo's config picks that remote's transport (`core.sshCommand`, `ext::`,
//     a credential helper). `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=` (empty: every transport
//     refused, whatever the repo's `protocol.<name>.allow` says), `GIT_PROTOCOL_FROM_USER=0`, and
//     `-c protocol.allow=never`, `protocol.ext.allow=never`, `credential.helper=`,
//     `core.sshCommand=`, `core.askPass=`, `fetch.recurseSubmodules=false`,
//     `submodule.recurse=false`. A missing blob then fails that one git run: the list keeps its
//     files with zero counts, and that file's diff comes back empty.
// Harmless and left alone: `core.untrackedCache` (a cache, never a program), `include.path` (it only
// reads more config, and a `-c` on the command line outranks anything it includes), trace2 (git
// reads it from system and global config only). The operator's own global config is trusted: it is
// theirs, like their shell.

import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { containedRealpath } from "./journal/files.ts";
import type {
  ChangedFile,
  ChangedRepo,
  ChangeStatus,
  PaneChangeDiffResponse,
  PaneChangesResponse,
} from "./types.ts";

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────

/** How deep discovery walks below the pane's folder when the client names no depth. */
export const DEFAULT_CHANGES_DEPTH = 2;
/** The deepest walk a client may ask for. Four levels covers `~/projects/<org>/<repo>` and more. */
export const MAX_CHANGES_DEPTH = 4;
/** Discovery stops after this many repos. */
export const MAX_REPOS = 20;
/** Discovery stops after reading this many directory entries, whatever the depth. */
export const MAX_WALK_ENTRIES = 5000;
/** Files listed per repo before the list is cut. */
export const MAX_FILES_PER_REPO = 1000;
/** Each git run is killed after this long. */
export const GIT_TIMEOUT_MS = 5000;
/** The most bytes read off one untracked file. */
export const MAX_FILE_READ_BYTES = 1024 * 1024;
/** A diff is cut at a line boundary past either of these. */
export const MAX_DIFF_LINES = 5000;
export const MAX_DIFF_BYTES = 512 * 1024;
/** Status and numstat output cap. Far past any real worktree; a hostile one stops here. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;
/** Bytes of untracked files read in one list to count their lines. Past it the count reads 0. */
const MAX_COUNT_BUDGET_BYTES = 16 * 1024 * 1024;
/** How many bytes decide "binary", git's own rule: a NUL in the first 8000. */
const BINARY_SNIFF_BYTES = 8000;
/** Repos listed at once. */
const REPO_CONCURRENCY = 4;

/** Folder names discovery never enters: build output and dependency trees hold no repo worth
 *  showing and can hold a hundred thousand entries. Dot-folders are skipped by rule as well. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "vendor", "target"]);

// ── Params ──────────────────────────────────────────────────────────────────────────────────────

export interface ChangesParams {
  depth: number;
  nested: boolean;
  repo: string | null;
  path: string | null;
}

/** The query, clamped. Pure + exported so the clamping is unit-tested without Bun.serve. */
export function changesParams(url: URL): ChangesParams {
  const raw = Number.parseInt(url.searchParams.get("depth") ?? "", 10);
  const depth = Number.isFinite(raw)
    ? Math.min(Math.max(raw, 1), MAX_CHANGES_DEPTH)
    : DEFAULT_CHANGES_DEPTH;
  // On unless the client says `0`: the default finds the repos a workspace keeps gitignored.
  const nested = url.searchParams.get("nested") !== "0";
  const repo = url.searchParams.get("repo");
  const path = url.searchParams.get("path");
  return { depth, nested, repo, path };
}

// ── Git, run safely ─────────────────────────────────────────────────────────────────────────────

/** Where git is. Fixed paths first (a systemd unit has no login PATH), then a PATH lookup. */
const GIT_CANDIDATES = [
  "/usr/bin/git",
  "/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/run/current-system/sw/bin/git",
];

let gitBinaryMemo: string | null | undefined;

export async function gitBinary(): Promise<string | null> {
  if (gitBinaryMemo !== undefined) return gitBinaryMemo;
  for (const candidate of GIT_CANDIDATES) {
    if (await isExecutableFile(candidate)) {
      gitBinaryMemo = candidate;
      return candidate;
    }
  }
  gitBinaryMemo = Bun.which("git");
  return gitBinaryMemo;
}

async function isExecutableFile(path: string): Promise<boolean> {
  const st = await stat(path).catch(() => null);
  return st !== null && st.isFile() && (st.mode & 0o111) !== 0;
}

/** The environment every git run gets: the bridge's own, minus anything git would read, plus ours. */
export function gitEnv(base: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  // Never touch the network. In a partial clone a missing blob triggers a lazy fetch from the
  // promisor remote, whose URL and transport the repo's own config names. `GIT_ALLOW_PROTOCOL`
  // empty refuses every transport and, unlike `protocol.allow`, outranks a repo's
  // `protocol.<name>.allow=always`.
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "";
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return env;
}

/** The `-c` overrides every run carries. Fixed: none of them depends on the repo. */
const HARDENING: readonly string[] = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "diff.external=",
  "core.pager=cat",
  "color.ui=false",
  "status.submoduleSummary=false",
  // The diff headers keep git's own `a/` `b/` shape whatever the operator's taste, so the phone's
  // parser reads one grammar.
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.relative=false",
  // No transport, no credential, no ssh program: we never fetch (see `gitEnv`). A repo's own
  // `protocol.<name>.allow` outranks `protocol.allow`, so `ext` (which runs a command) is named too.
  // An empty `credential.helper` resets the helper list.
  "protocol.allow=never",
  "protocol.ext.allow=never",
  "credential.helper=",
  "core.sshCommand=",
  "core.askPass=",
  "fetch.recurseSubmodules=false",
  "submodule.recurse=false",
].flatMap((kv) => ["-c", kv]);

/** A repo the way git is run against it: the folder that holds `.git`, and that `.git` entry. */
interface RepoDirs {
  /** Real path of the work tree (the folder `.git` was found in). */
  workTree: string;
  /** `<workTree>/.git` — a folder, or a gitfile git follows itself. */
  gitDir: string;
}

interface GitRun {
  code: number;
  stdout: Buffer;
  /** Output hit the cap and the process was killed. */
  capped: boolean;
  timedOut: boolean;
}

/**
 * Run one git command against one repo. argv only, no shell; killed at the timeout; stdout read up
 * to `maxBytes` and the process killed past it.
 */
async function runGit(
  git: string,
  repo: RepoDirs,
  args: readonly string[],
  extraConfig: readonly string[],
  maxBytes: number,
): Promise<GitRun> {
  const argv = [
    git,
    "--no-pager",
    "--literal-pathspecs",
    `--git-dir=${repo.gitDir}`,
    `--work-tree=${repo.workTree}`,
    ...HARDENING,
    ...extraConfig,
    ...args,
  ];
  const proc = Bun.spawn(argv, {
    cwd: repo.workTree,
    env: gitEnv(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, GIT_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let capped = false;
  try {
    for await (const chunk of proc.stdout) {
      if (size + chunk.byteLength > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        capped = true;
        proc.kill();
        break;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const code = await proc.exited;
    return { code, stdout: Buffer.concat(chunks), capped, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every configured filter driver's name, read without running any of them, and turned into the
 * `-c` pairs that switch each one off. A name that cannot be spelled safely as a `-c` key (it holds
 * `=`, which `-c` splits on) makes the repo unreadable rather than half-protected.
 */
async function filterOverrides(git: string, repo: RepoDirs): Promise<string[] | null> {
  const run = await runGit(
    git,
    repo,
    ["config", "-z", "--name-only", "--get-regexp", "^filter\\."],
    [],
    64 * 1024,
  );
  // Exit 1 is "no such key": no filters, nothing to override.
  if (run.timedOut || run.capped || (run.code !== 0 && run.code !== 1)) return null;
  const names = new Set<string>();
  for (const key of run.stdout.toString("utf8").split("\0")) {
    const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (match) names.add(match[1]!);
  }
  const overrides: string[] = [];
  for (const name of names) {
    if (name.includes("=") || name.includes("\n")) return null;
    for (const field of ["clean=", "smudge=", "process=", "required=false"]) {
      overrides.push("-c", `filter.${name}.${field}`);
    }
  }
  return overrides;
}

// ── Discovery ───────────────────────────────────────────────────────────────────────────────────

/** A repo discovery found, before anything is asked of git. */
export interface FoundRepo extends RepoDirs {
  relPath: string;
  name: string;
}

async function hasGitEntry(dir: string): Promise<boolean> {
  const st = await lstat(join(dir, ".git")).catch(() => null);
  return st !== null && (st.isDirectory() || st.isFile());
}

function toRelPath(from: string, to: string): string {
  const rel = relative(from, to);
  return rel === "" ? "." : rel.split(sep).join("/");
}

/**
 * The repos a Changes request looks at: the one that contains the folder (found by walking UP to
 * the nearest `.git`, which is where `git rev-parse --show-toplevel` would land, minus any
 * `core.worktree` a repo sets), then, when `nested`, every folder below holding a `.git` entry, down
 * to `depth` levels. The walk does not ask git, so a repo the parent gitignores is found like any
 * other. It never follows a symlink and never enters a dot-folder or a build/dependency folder.
 */
export async function discoverRepos(
  cwd: string,
  depth: number,
  nested: boolean,
): Promise<{ repos: FoundRepo[]; truncated: boolean }> {
  const root = await realpath(cwd);
  const repos: FoundRepo[] = [];
  const found = (dir: string) => {
    repos.push({
      workTree: dir,
      gitDir: join(dir, ".git"),
      relPath: toRelPath(root, dir),
      name: basename(dir),
    });
  };

  for (let dir = root; ; dir = dirname(dir)) {
    if (await hasGitEntry(dir)) {
      found(dir);
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!nested) return { repos, truncated: false };

  let truncated = false;
  let entries = 0;
  let level: string[] = [root];
  for (let d = 1; d <= depth && level.length > 0 && !truncated; d++) {
    const next: string[] = [];
    for (const parent of level) {
      const children = await readdir(parent, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        entries++;
        if (entries > MAX_WALK_ENTRIES) {
          truncated = true;
          break;
        }
        // `isDirectory()` on a Dirent is false for a symlink, so a link is never followed.
        if (!child.isDirectory()) continue;
        if (child.name.startsWith(".") || SKIP_DIRS.has(child.name)) continue;
        const dir = join(parent, child.name);
        if (await hasGitEntry(dir)) {
          if (repos.length >= MAX_REPOS) {
            truncated = true;
            break;
          }
          found(dir);
        }
        next.push(dir);
      }
      if (truncated) break;
    }
    level = next;
  }
  return { repos, truncated };
}

// ── Listing ─────────────────────────────────────────────────────────────────────────────────────

/** One status record, before counts. `submodule` marks a gitlink entry. */
interface StatusEntry {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  submodule: boolean;
}

/** Map porcelain-v2's XY pair to one letter against HEAD (staged and unstaged together). */
function statusFromXY(xy: string): ChangeStatus | null {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  // Added to the index and then deleted from the worktree: nothing against HEAD.
  if (x === "A" && y === "D") return null;
  if (x === "A") return "A";
  if (x === "D" || y === "D") return "D";
  return "M";
}

/**
 * Parse `git status --porcelain=v2 -z`. Pure + exported for the test. A capped output's last,
 * partial record is dropped rather than guessed at.
 */
export function parseStatusV2(raw: string, complete = true): StatusEntry[] {
  const fields = raw.split("\0");
  if (!complete) fields.pop();
  const out: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    if (rec === "") continue;
    const kind = rec[0];
    if (kind === "?") {
      out.push({ path: rec.slice(2), status: "?", submodule: false });
      continue;
    }
    if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const parts = splitN(rec, 9);
      if (!parts) continue;
      const status = statusFromXY(parts[1]!);
      if (status) out.push({ path: parts[8]!, status, submodule: parts[2]![0] === "S" });
      continue;
    }
    if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = splitN(rec, 10);
      const oldPath = fields[i + 1];
      i++;
      if (!parts || oldPath === undefined) continue;
      const renamed = parts[8]![0] === "R";
      out.push({
        path: parts[9]!,
        oldPath,
        status: renamed ? "R" : "A",
        submodule: parts[2]![0] === "S",
      });
      continue;
    }
    if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path — a conflict reads as modified.
      const parts = splitN(rec, 11);
      if (parts) out.push({ path: parts[10]!, status: "M", submodule: parts[2]![0] === "S" });
    }
  }
  return out;
}

/** Split on the first `n - 1` spaces, so the last field (a path) keeps any spaces it holds. */
function splitN(rec: string, n: number): string[] | null {
  const parts: string[] = [];
  let rest = rec;
  for (let k = 0; k < n - 1; k++) {
    const at = rest.indexOf(" ");
    if (at < 0) return null;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

/** `git diff --numstat -z -M` → counts by NEW path. Pure + exported for the test. */
export function parseNumstatZ(
  raw: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    if (rec === "") continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let path = m[3]!;
    // A rename leaves the path empty and puts old and new in the next two fields.
    if (path === "") {
      path = fields[i + 2] ?? "";
      i += 2;
    }
    const binary = m[1] === "-";
    out.set(path, {
      added: binary ? 0 : Number(m[1]),
      removed: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return out;
}

/** The tree `diff` compares against: HEAD, or the empty tree in a repo with no commits yet. */
async function baseTree(git: string, repo: RepoDirs): Promise<string | null> {
  const head = await runGit(git, repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], [], 4096);
  if (head.code === 0) return "HEAD";
  // The empty tree's id depends on the repo's hash (SHA-1 or SHA-256), so ask rather than hard-code.
  const empty = await runGit(git, repo, ["hash-object", "-t", "tree", "/dev/null"], [], 4096);
  if (empty.code !== 0) return null;
  const id = empty.stdout.toString("utf8").trim();
  return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
}

/** First bytes of a file hold a NUL: git's own "binary" rule. */
function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/**
 * An untracked file's contents, read only when its real path is inside the repo's real path.
 * `null` = refused (escaped the repo, or gone). A symlink is shown as git shows one: its target.
 */
async function readUntracked(
  repo: RepoDirs,
  path: string,
): Promise<{ kind: "file"; bytes: Uint8Array; clipped: boolean } | { kind: "link"; target: string } | null> {
  const candidate = join(repo.workTree, path);
  const real = await containedRealpath(candidate, repo.workTree);
  if (real === null) return null;
  const st = await lstat(candidate).catch(() => null);
  if (st === null) return null;
  if (st.isSymbolicLink()) {
    const target = await readlink(candidate).catch(() => null);
    return target === null ? null : { kind: "link", target };
  }
  if (!st.isFile()) return null;
  const file = Bun.file(real);
  const clipped = file.size > MAX_FILE_READ_BYTES;
  const bytes = new Uint8Array(await file.slice(0, MAX_FILE_READ_BYTES).arrayBuffer());
  return { kind: "file", bytes, clipped };
}

/** One repo's status, with its hardening computed. `null` when git could not read it at all. */
async function repoStatus(
  git: string,
  repo: RepoDirs,
): Promise<{ entries: StatusEntry[]; truncated: boolean; config: string[] } | null> {
  const config = await filterOverrides(git, repo);
  if (config === null) return null;
  const run = await runGit(
    git,
    repo,
    ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=dirty"],
    config,
    MAX_LIST_BYTES,
  );
  if (run.timedOut || (run.code !== 0 && !run.capped)) return null;
  const entries = parseStatusV2(run.stdout.toString("utf8"), !run.capped);
  return { entries, truncated: run.capped, config };
}

/** Drop a parent's entry for a folder that discovery lists as a repo of its own. */
function withoutNestedRepos(repo: FoundRepo, entries: StatusEntry[], all: readonly FoundRepo[]) {
  const nested = new Set(all.filter((r) => r !== repo).map((r) => r.workTree));
  return entries.filter((e) => {
    const abs = join(repo.workTree, e.path.replace(/\/$/, ""));
    return !nested.has(abs);
  });
}

async function listRepo(
  git: string,
  repo: FoundRepo,
  all: readonly FoundRepo[],
  budget: { bytes: number },
): Promise<{ repo: ChangedRepo; truncated: boolean } | null> {
  const status = await repoStatus(git, repo);
  if (status === null) return null;
  let entries = withoutNestedRepos(repo, status.entries, all);
  let truncated = status.truncated;
  if (entries.length > MAX_FILES_PER_REPO) {
    entries = entries.slice(0, MAX_FILES_PER_REPO);
    truncated = true;
  }
  if (entries.length === 0) return { repo: { relPath: repo.relPath, name: repo.name, files: [] }, truncated };

  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  if (entries.some((e) => e.status !== "?")) {
    const base = await baseTree(git, repo);
    if (base !== null) {
      const run = await runGit(
        git,
        repo,
        ["diff", base, "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"],
        status.config,
        MAX_LIST_BYTES,
      );
      if (!run.timedOut) {
        for (const [k, v] of parseNumstatZ(run.stdout.toString("utf8"))) counts.set(k, v);
      }
    }
  }

  const files: ChangedFile[] = [];
  for (const e of entries) {
    const file: ChangedFile = { path: e.path, status: e.status, added: 0, removed: 0, binary: false };
    if (e.oldPath !== undefined) file.oldPath = e.oldPath;
    const c = counts.get(e.path);
    if (c) Object.assign(file, c);
    if (e.status === "?" && !e.path.endsWith("/") && budget.bytes > 0) {
      const read = await readUntracked(repo, e.path);
      if (read?.kind === "file") {
        budget.bytes -= read.bytes.byteLength;
        if (looksBinary(read.bytes)) file.binary = true;
        else file.added = countLines(new TextDecoder().decode(read.bytes));
      } else if (read?.kind === "link") {
        file.added = 1;
      }
    }
    files.push(file);
  }
  return { repo: { relPath: repo.relPath, name: repo.name, files }, truncated };
}

/** Run `fn` over `items`, at most `limit` at once, keeping order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Whether `cwd` is a folder we can look in at all. */
async function usableFolder(cwd: string): Promise<boolean> {
  if (cwd.trim() === "" || !cwd.startsWith("/")) return false;
  const st = await stat(cwd).catch(() => null);
  return st !== null && st.isDirectory();
}

/** The Changes list for a folder. `paneId` only rides into the body. */
export async function listChanges(
  paneId: string,
  cwd: string,
  params: Pick<ChangesParams, "depth" | "nested">,
): Promise<PaneChangesResponse> {
  if (!(await usableFolder(cwd))) return { paneId, available: false, reason: "no-folder" };
  const git = await gitBinary();
  if (git === null) return { paneId, available: false, reason: "no-git" };
  const found = await discoverRepos(cwd, params.depth, params.nested);
  const budget = { bytes: MAX_COUNT_BUDGET_BYTES };
  const listed = await mapLimited(found.repos, REPO_CONCURRENCY, (r) => listRepo(git, r, found.repos, budget));
  let truncated = found.truncated;
  const repos: ChangedRepo[] = [];
  for (const item of listed) {
    if (item === null) continue;
    if (item.truncated) truncated = true;
    if (item.repo.files.length > 0) repos.push(item.repo);
  }
  return { paneId, available: true, root: await realpath(cwd), repos, truncated };
}

// ── One file's diff ─────────────────────────────────────────────────────────────────────────────

/** A diff after the caps: the text kept, and whether anything was cut. */
export interface CappedDiff {
  diff: string;
  truncated: boolean;
}

/** Cut a diff at a line boundary under both caps. Pure + exported for the test. */
export function capDiff(text: string): CappedDiff {
  let lines = 0;
  let end = 0;
  while (end < text.length) {
    const nl = text.indexOf("\n", end);
    const stop = nl < 0 ? text.length : nl + 1;
    if (lines + 1 > MAX_DIFF_LINES || Buffer.byteLength(text.slice(0, stop), "utf8") > MAX_DIFF_BYTES) {
      return { diff: text.slice(0, end), truncated: true };
    }
    lines++;
    end = stop;
  }
  return { diff: text, truncated: false };
}

/** An all-added unified diff for a file git does not track yet. */
export function syntheticAddedDiff(path: string, content: string): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const noEol = content !== "" && !content.endsWith("\n");
  const head = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n`;
  if (lines.length === 0) return head;
  const body = lines.map((l) => `+${l}\n`).join("");
  return `${head}@@ -0,0 +1,${lines.length} @@\n${body}${noEol ? "\\ No newline at end of file\n" : ""}`;
}

/** One file's diff. Refuses a repo discovery did not return and a path git did not list. */
export async function fileDiff(
  paneId: string,
  cwd: string,
  params: ChangesParams,
): Promise<PaneChangeDiffResponse> {
  if (!(await usableFolder(cwd))) return { paneId, available: false, reason: "no-folder" };
  const git = await gitBinary();
  if (git === null) return { paneId, available: false, reason: "no-git" };
  const found = await discoverRepos(cwd, params.depth, params.nested);
  const repo = found.repos.find((r) => r.relPath === params.repo);
  if (repo === undefined) return { paneId, available: false, reason: "unknown-repo" };
  const status = await repoStatus(git, repo);
  if (status === null) return { paneId, available: false, reason: "unknown-repo" };
  const entry = withoutNestedRepos(repo, status.entries, found.repos).find((e) => e.path === params.path);
  if (entry === undefined) return { paneId, available: false, reason: "unknown-path" };

  const answer: Extract<PaneChangeDiffResponse, { available: true }> = {
    paneId,
    available: true,
    repo: repo.relPath,
    path: entry.path,
    status: entry.status,
    binary: false,
    directory: false,
    truncated: false,
    diff: "",
  };
  if (entry.oldPath !== undefined) answer.oldPath = entry.oldPath;

  if (entry.status === "?") {
    if (entry.path.endsWith("/")) return { ...answer, directory: true };
    const read = await readUntracked(repo, entry.path);
    if (read === null) return { paneId, available: false, reason: "unknown-path" };
    if (read.kind === "link") return { ...answer, diff: syntheticAddedDiff(entry.path, `${read.target}\n`) };
    if (looksBinary(read.bytes)) return { ...answer, binary: true };
    const capped = capDiff(syntheticAddedDiff(entry.path, new TextDecoder().decode(read.bytes)));
    return { ...answer, diff: capped.diff, truncated: capped.truncated || read.clipped };
  }

  const base = await baseTree(git, repo);
  if (base === null) return { paneId, available: false, reason: "unknown-repo" };
  const paths = entry.oldPath !== undefined ? [entry.oldPath, entry.path] : [entry.path];
  const run = await runGit(
    git,
    repo,
    ["diff", base, "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--ignore-submodules=dirty", "--", ...paths],
    status.config,
    MAX_DIFF_BYTES + 1,
  );
  const text = run.stdout.toString("utf8");
  if (/^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text)) {
    return { ...answer, binary: true };
  }
  const capped = capDiff(text);
  return { ...answer, diff: capped.diff, truncated: capped.truncated || run.capped || run.timedOut };
}

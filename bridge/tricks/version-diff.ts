import { createHash } from "node:crypto";
import { join } from "node:path";

import { gitBinary, gitEnv, HARDENING, looksBinary } from "../changes.ts";
import { redactText } from "../redact.ts";
import { CODE_BYTES_MAX, diskTrickFs, walkTrickCode, type TrickFs } from "./code-hash.ts";

// WHAT A TRICK'S NEW VERSION CHANGES (crew slice 3), for the "new version" card on the Hill.
//
// The approved copy and the waiting snapshot are two folders of plain files (approved.ts). Each code
// file the walk lists (code-hash.ts `walkTrickCode`) is compared by its bytes; a changed or added or
// removed text file is handed to `git diff --no-index`, one file at a time, for its `+` and `-` lines.
//
// ── GIT, HARDENED ──────────────────────────────────────────────────────────────────────────────────
// A trick's folder is anybody's code, so git reads nothing a folder could plant: the run starts in `/`
// (no repo is discovered, so no repo config, no attributes file, no hooks), the bridge's environment
// loses every GIT_* variable and gains GIT_CONFIG_NOSYSTEM (changes.ts `gitEnv`), every `-c` of the
// Files view's hardening is passed (no pager, no fsmonitor, no external diff), and the diff itself runs
// with --no-ext-diff, --no-textconv and --no-color. Each run is cut at {@link DIFF_TIMEOUT_MS} and at
// {@link DIFF_OUTPUT_MAX} bytes. Paths go after `--`, so none reads as an option.
//
// ── NO GIT ─────────────────────────────────────────────────────────────────────────────────────────
// Without git on the machine, or when it fails, the card still lists each file and what happened to it;
// only the line counts and the diffs are left out.
//
// ── WHAT LEAVES ────────────────────────────────────────────────────────────────────────────────────
// Every diff line goes through `redactText` (bridge/redact.ts), the mask the bridge puts on any screen
// text it serves, so a key in the code is not on the phone. Tabs become spaces and any other control
// character a `?`, so the line fits a Decision's view (web/src/lib/tricks/schema.ts).

/** One git run's limit. */
export const DIFF_TIMEOUT_MS = 5000;
/** The bytes kept of one git run's output. */
export const DIFF_OUTPUT_MAX = 256 * 1024;
/** At most this many files get a line count; the rest are listed by what happened to them. */
export const DIFF_FILES_MAX = 12;
/** A file larger than this gets no line count. */
export const DIFF_FILE_BYTES_MAX = 512 * 1024;

export type FileChange = "added" | "changed" | "removed";

/** One code file the new version adds, changes or removes. Counts are null when not known. */
export interface ChangedFile {
  rel: string;
  change: FileChange;
  plus: number | null;
  minus: number | null;
  /** The file's hunks, masked, one line each without the patch headers. Null when not read. */
  hunk: string[] | null;
}

export interface VersionDiff {
  /** Every changed code file, in path order. */
  files: ChangedFile[];
  /** False when git was not there or failed for every file: then no counts and no hunks. */
  counted: boolean;
}

/** One git run: its exit code and what it printed, cut at the cap. */
export interface DiffRun {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface VersionDiffOptions {
  /** The approved copy, or null when none runs (everything is added). */
  base: string | null;
  /** The waiting snapshot. */
  next: string;
  fs?: TrickFs;
  /** The git binary; null for none. Default: the one the Files view uses (changes.ts `gitBinary`). */
  git?: string | null;
  /** Runs one argv. Default: a hardened spawn. A test passes a fake. */
  run?: (argv: readonly string[]) => Promise<DiffRun>;
}

/** The sum of one code entry: its kind and the sha256 of its bytes (or its link target). */
async function sums(dir: string, fs: TrickFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = await walkTrickCode(fs, dir);
  if (!walk.ok) return out;
  for (const entry of walk.entries) {
    const bytes = entry.kind === "file" ? await fs.read(join(dir, entry.rel), CODE_BYTES_MAX) : null;
    const link = entry.kind === "symlink" ? await fs.readlink(join(dir, entry.rel)) : null;
    const body = bytes === null ? (link ?? "") : createHash("sha256").update(bytes).digest("hex");
    out.set(entry.rel, `${entry.kind}:${body}`);
  }
  return out;
}

/** The argv of one hardened `git diff --no-index` between two paths (`/dev/null` for none). */
export function diffArgv(git: string, left: string, right: string): string[] {
  return [git, "--no-pager", ...HARDENING, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "-U2", "--", left, right];
}

/** Spawn one argv from `/` with git's environment cleaned, cut at the time and byte caps. */
async function spawnDiff(argv: readonly string[]): Promise<DiffRun> {
  const proc = Bun.spawn([...argv], { cwd: "/", env: gitEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, DIFF_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of proc.stdout) {
      if (size + chunk.byteLength > DIFF_OUTPUT_MAX) {
        chunks.push(chunk.subarray(0, DIFF_OUTPUT_MAX - size));
        proc.kill();
        break;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const code = await proc.exited;
    return { code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** A line as a Decision's view takes it: masked, tabs as two spaces, any other control character a `?`. */
export function viewLine(raw: string): string {
  let out = "";
  for (const ch of redactText(raw)) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\t") out += "  ";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += "?";
    else if ((code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) out += "?";
    else out += ch;
  }
  return out;
}

/** One patch as the card reads it: its `+` and `-` line counts and its hunk lines. */
export interface PatchRead {
  plus: number;
  minus: number;
  hunk: string[];
}

/** The `+` and `-` lines of one patch, and its hunks (from the first `@@`), header lines left out. */
export function readPatch(patch: string): PatchRead {
  let plus = 0;
  let minus = 0;
  const hunk: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) plus += 1;
    if (line.startsWith("-")) minus += 1;
    hunk.push(line);
  }
  while (hunk.length > 0 && hunk.at(-1) === "") hunk.pop();
  return { plus, minus, hunk };
}

/** Whether a path names a text file small enough to count. */
async function countable(fs: TrickFs, path: string): Promise<boolean> {
  const bytes = await fs.read(path, DIFF_FILE_BYTES_MAX + 1);
  return bytes !== null && bytes.byteLength <= DIFF_FILE_BYTES_MAX && !looksBinary(bytes);
}

/**
 * What the new version changes against the approved copy: each changed code file, and for at most
 * {@link DIFF_FILES_MAX} text files their line counts and masked hunks. Never throws.
 */
export async function versionDiff(opts: VersionDiffOptions): Promise<VersionDiff> {
  const fs = opts.fs ?? diskTrickFs;
  const [old, now] = await Promise.all([opts.base === null ? Promise.resolve(new Map<string, string>()) : sums(opts.base, fs), sums(opts.next, fs)]);
  const rels = [...new Set([...old.keys(), ...now.keys()])].toSorted();
  const files: ChangedFile[] = [];
  for (const rel of rels) {
    const was = old.get(rel);
    const is = now.get(rel);
    if (was === is) continue;
    const change: FileChange = was === undefined ? "added" : is === undefined ? "removed" : "changed";
    files.push({ rel, change, plus: null, minus: null, hunk: null });
  }
  const git = opts.git === undefined ? await gitBinary().catch(() => null) : opts.git;
  if (git === null) return { files, counted: false };
  const run = opts.run ?? spawnDiff;
  let counted = false;
  for (const file of files.slice(0, DIFF_FILES_MAX)) {
    const left = file.change === "added" || opts.base === null ? "/dev/null" : join(opts.base, file.rel);
    const right = file.change === "removed" ? "/dev/null" : join(opts.next, file.rel);
    // A symlink or a binary is listed, not counted: git would print a link target or "Binary files differ".
    const isText = (left === "/dev/null" || (await countable(fs, left))) && (right === "/dev/null" || (await countable(fs, right)));
    if (!isText) continue;
    const answer = await run(diffArgv(git, left, right)).catch((): DiffRun => ({ code: null, stdout: "", timedOut: false }));
    // `--no-index` exits 1 when the files differ, 0 when they are the same, and anything else on an error.
    if (answer.timedOut || (answer.code !== 0 && answer.code !== 1)) continue;
    const read = readPatch(answer.stdout);
    file.plus = read.plus;
    file.minus = read.minus;
    file.hunk = read.hunk.map(viewLine);
    counted = true;
  }
  return { files, counted };
}

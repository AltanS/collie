import { createHash } from "node:crypto";
import { join } from "node:path";

import { gitBinary, gitEnv, HARDENING, looksBinary } from "../changes.ts";
import { redactText } from "../redact.ts";
import { CODE_BYTES_MAX, diskTrickFs, unsafeText, walkTrickCode, type TrickFs } from "./code-hash.ts";

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
// text it serves, so a key in the code is not on the phone. Tabs become spaces and any other character
// a Decision's view refuses (code-hash.ts `unsafeText`) a `?`, so one line never drops the whole view
// (web/src/lib/tricks/schema.ts). A file whose hunk is not whole, because git's output hit the cap, a
// line was masked, or a character in a line became a `?`, is marked `cut`: the card then does not
// count it as shown, and recommends nothing. The CR of a CRLF line end is dropped and does not count.

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
  /** Set when the hunk is not the whole change as it is: git's output was cut at the cap, a line was masked, or a character became a `?`. */
  cut?: true;
  /** How many of the hunk's lines the mask changed (a key masked, a character as `?`). Absent for none. */
  masked?: number;
  /** Set when a line holds a run of more than {@link VIEW_GAP_MAX} spaces as the card shows it: a proposal with one is refused (review 7 R2). */
  gap?: true;
  /** The file became executable (`+x`) or stopped being so (`-x`), its bytes changed or not (review 7). */
  mode?: "+x" | "-x";
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
  /** True when the output was cut at {@link DIFF_OUTPUT_MAX}. */
  truncated?: boolean;
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
  /** How many files get a line count and a hunk. Default {@link DIFF_FILES_MAX}; a group of cards asks for more. */
  filesMax?: number;
  /**
   * The files of `next` that are executable, when its own modes do not say (a stored proposal is 0600,
   * its bits kept apart). Absent: read off the disk.
   */
  nextExec?: ReadonlySet<string>;
}

/** The sums of a folder's code entries, and which of its files are executable. */
interface Sums {
  sum: Map<string, string>;
  exec: Set<string>;
}

/** The sum of one code entry: its kind and the sha256 of its bytes (or its link target); and its x bit. */
async function sums(dir: string, fs: TrickFs): Promise<Sums> {
  const out: Sums = { sum: new Map(), exec: new Set() };
  const walk = await walkTrickCode(fs, dir);
  if (!walk.ok) return out;
  for (const entry of walk.entries) {
    const bytes = entry.kind === "file" ? await fs.read(join(dir, entry.rel), CODE_BYTES_MAX) : null;
    const link = entry.kind === "symlink" ? await fs.readlink(join(dir, entry.rel)) : null;
    const body = bytes === null ? (link ?? "") : createHash("sha256").update(bytes).digest("hex");
    out.sum.set(entry.rel, `${entry.kind}:${body}`);
    if (entry.kind === "file" && (((await fs.lstat(join(dir, entry.rel)))?.mode ?? 0) & 0o111) !== 0) out.exec.add(entry.rel);
  }
  return out;
}

/** `+x` or `-x` when a file in both folders changed its executable bit. */
function modeChange(rel: string, old: Sums, now: ReadonlySet<string>): "+x" | "-x" | undefined {
  if (!old.sum.has(rel)) return undefined;
  const was = old.exec.has(rel);
  const is = now.has(rel);
  if (was === is) return undefined;
  return is ? "+x" : "-x";
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
  let truncated = false;
  try {
    for await (const chunk of proc.stdout) {
      if (size + chunk.byteLength > DIFF_OUTPUT_MAX) {
        chunks.push(chunk.subarray(0, DIFF_OUTPUT_MAX - size));
        truncated = true;
        proc.kill();
        break;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const code = await proc.exited;
    return { code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, truncated };
  } finally {
    clearTimeout(timer);
  }
}

/** A line as a Decision's view takes it, and whether it differs from the file's line beyond its tabs. */
export interface ViewLineRead {
  line: string;
  /**
   * True when the person would not read the line as it is in the file: a key was masked, or a
   * character the view refuses (a bidi mark, a control character) became a `?` (third security
   * review). A tab as two spaces, or the CR of a CRLF line end, hides nothing and does not count.
   */
  masked: boolean;
  /** True when the line holds a run of more than {@link VIEW_GAP_MAX} spaces, a tab counting as two. */
  gap: boolean;
}

/**
 * The longest run of spaces a proposed line may hold, a tab counting as two (review 7 R2). A longer run
 * would push the code after it far to the right of a phone's screen, past where a person reads.
 */
export const VIEW_GAP_MAX = 40;
const WIDE_GAP = new RegExp(` {${String(VIEW_GAP_MAX + 1)},}`, "u");

/** A line as a Decision's view takes it, and whether it differs from the file's line beyond its tabs. */
export function readViewLine(raw: string): ViewLineRead {
  // A CRLF file's line keeps its CR after the split on LF: it is the line end, not text, so it goes.
  const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const redacted = redactText(text);
  let line = "";
  let replaced = false;
  for (const ch of redacted) {
    if (ch === "\t") {
      line += "  ";
      continue;
    }
    const refused = unsafeText(ch);
    if (refused) replaced = true;
    line += refused ? "?" : ch;
  }
  return { line, masked: redacted !== text || replaced, gap: WIDE_GAP.test(line) };
}

/** A line as a Decision's view takes it: masked, tabs as two spaces, any character the view refuses a `?`. */
export function viewLine(raw: string): string {
  return readViewLine(raw).line;
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
  const none: Sums = { sum: new Map(), exec: new Set() };
  const [old, now] = await Promise.all([opts.base === null ? Promise.resolve(none) : sums(opts.base, fs), sums(opts.next, fs)]);
  const nowExec = opts.nextExec ?? now.exec;
  const rels = [...new Set([...old.sum.keys(), ...now.sum.keys()])].toSorted();
  const files: ChangedFile[] = [];
  let modeOnly = false;
  for (const rel of rels) {
    const was = old.sum.get(rel);
    const is = now.sum.get(rel);
    const mode = is === undefined ? undefined : modeChange(rel, old, nowExec);
    if (was === is && mode === undefined) continue;
    const change: FileChange = was === undefined ? "added" : is === undefined ? "removed" : "changed";
    // Only the bit moved: nothing to count and no line to show, so it is whole as it is.
    if (was === is && mode !== undefined) {
      files.push({ rel, change, plus: 0, minus: 0, hunk: [], mode });
        modeOnly = true;
      continue;
    }
    const file: ChangedFile = { rel, change, plus: null, minus: null, hunk: null };
    if (mode !== undefined) file.mode = mode;
    files.push(file);
  }
  const git = opts.git === undefined ? await gitBinary().catch(() => null) : opts.git;
  if (git === null) return { files, counted: false };
  const run = opts.run ?? spawnDiff;
  // A file whose bit alone moved is whole as it is: nothing for git to count.
  let counted = modeOnly;
  for (const file of files.slice(0, opts.filesMax ?? DIFF_FILES_MAX)) {
    if (file.hunk !== null) continue;
    const left = file.change === "added" || opts.base === null ? "/dev/null" : join(opts.base, file.rel);
    const right = file.change === "removed" ? "/dev/null" : join(opts.next, file.rel);
    // A symlink or a binary is listed, not counted: git would print a link target or "Binary files differ".
    const isText = (left === "/dev/null" || (await countable(fs, left))) && (right === "/dev/null" || (await countable(fs, right)));
    if (!isText) continue;
    const answer = await run(diffArgv(git, left, right)).catch((): DiffRun => ({ code: null, stdout: "", timedOut: false }));
    // `--no-index` exits 1 when the files differ, 0 when they are the same, and anything else on an error.
    if (answer.timedOut || (answer.code !== 0 && answer.code !== 1)) continue;
    const read = readPatch(answer.stdout);
    const lines = read.hunk.map(readViewLine);
    file.plus = read.plus;
    file.minus = read.minus;
    file.hunk = lines.map((line) => line.line);
    if (answer.truncated === true || lines.some((line) => line.masked)) file.cut = true;
    const masked = lines.filter((line) => line.masked).length;
    if (masked > 0) file.masked = masked;
    if (lines.some((line) => line.gap)) file.gap = true;
    counted = true;
  }
  return { files, counted };
}

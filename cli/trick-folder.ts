import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_FILE, isPictureName, PICTURE_DIRS } from "../bridge/tricks/code-hash.ts";
import { asJsonObject, asJsonString, parseJson, type JsonValue } from "../web/src/lib/json.ts";
import type { ParsedTrickDocument } from "../web/src/lib/tricks/schema.ts";
import { foldKey, isConfigPath, proposedPathProblem, proposedPictureProblem, PROPOSE_LIMITS, PROPOSE_PICTURES, type ProposedFile } from "../bridge/tricks/propose-wire.ts";

// The folder read of `collie trick propose` (crew slice 8), on its own so `collie trick check` can count
// the cards of the same files without a loop of imports: regular files only, never through a link,
// within the caps. Left behind, never read: dot files and dot folders, `node_modules/`, `*.log`, the
// bridge's own `inputs/`, and `config.toml`.
//
// PICTURES (2026-11-18): the top `media/` and `captures/` folders bring their PICTURES, as the approved copy
// seeds them for a trick `collie trick add` brought (bridge/tricks/approved.ts): a regular file named
// `.png`, `.jpg`, `.jpeg` or `.webp` whose first bytes are a PNG, JPEG or WebP picture, at most
// {@link PROPOSE_PICTURES}.bytes each and {@link PROPOSE_PICTURES}.files together, never through a link.
// They are read after the code, so a picture never pushes code past the proposal's caps: a picture past
// them stays behind. Every other file there stays behind too, each with its reason ({@link LeftPicture}).

/** The most entries the folder walk looks at, skipped ones included, before it gives up. */
export const PROPOSE_WALK_MAX = 2000;

/** A file of `media/` or `captures/` that stays behind, and why, in a few words after its path. */
export interface LeftPicture {
  rel: string;
  why: string;
}

/** The folder read for a proposal: the code files and the pictures to send, and what was left behind. */
export type FolderRead =
  | { ok: true; files: ProposedFile[]; pictures: ProposedFile[]; left: number; leftPictures: LeftPicture[]; config: boolean }
  | { ok: false; error: string };

/** The top-level names left behind, folded: the bridge's `inputs/` and the person's settings. */
const LEFT_TOP: ReadonlySet<string> = new Set(["inputs", CONFIG_FILE]);

/** Whether a top-level name is a picture folder spelled exactly so: the code hash skips only those spellings. */
function isPictureDir(name: string): boolean {
  return PICTURE_DIRS.some((dir) => dir === name);
}

/** Whether a name is left behind: not code, or the bridge's own. */
function leftBehind(rel: string, isDir: boolean): boolean {
  const steps = rel.split("/");
  const name = steps.at(-1) ?? "";
  if (steps.some((step) => step.startsWith(".") || foldKey(step) === "node_modules")) return true;
  // The bridge's own inputs/ and the person's settings: a proposal never carries them.
  if (steps.length === 1 && LEFT_TOP.has(foldKey(name))) return true;
  // `Media/` in another case is not the folder the code hash skips, and never a picture folder: it stays behind.
  if (steps.length === 1 && !isPictureDir(name) && PICTURE_DIRS.some((dir) => dir === foldKey(name))) return true;
  if (!isDir && name.endsWith(".log")) return true;
  return false;
}

/** A picture read from a trick folder, or why it is not one a proposal brings. */
export type PictureRead = { ok: true; bytes: Uint8Array } | { ok: false; why: string };

/**
 * Read `rel` (a path under `media/` or `captures/`) from `folder` as a picture a proposal brings: every
 * step below the folder a real folder (never a link), the file itself a regular file with a picture's name,
 * within the cap, and a PNG, JPEG or WebP by its first bytes. Never throws.
 */
export async function readFolderPicture(folder: string, rel: string): Promise<PictureRead> {
  const steps = rel.split("/");
  if (steps.length < 2 || !isPictureDir(steps[0] ?? "")) return { ok: false, why: "is not in media/ or captures/" };
  for (let i = 1; i < steps.length; i += 1) {
    const up = steps.slice(0, i).join("/");
    const st = await lstat(join(folder, up)).catch(() => null);
    if (st === null) return { ok: false, why: "is not in the folder" };
    if (st.isSymbolicLink()) return { ok: false, why: `sits under ${up}, a symbolic link` };
    if (!st.isDirectory()) return { ok: false, why: `sits under ${up}, which is not a folder` };
  }
  const st = await lstat(join(folder, rel)).catch(() => null);
  if (st === null) return { ok: false, why: "is not in the folder" };
  if (st.isSymbolicLink()) return { ok: false, why: "is a symbolic link" };
  if (!st.isFile()) return { ok: false, why: "is not a regular file" };
  if (!isPictureName(steps.at(-1) ?? "")) return { ok: false, why: "is not a .png, .jpg, .jpeg or .webp file" };
  if (st.size > PROPOSE_PICTURES.bytes) return { ok: false, why: `is larger than ${String(PROPOSE_PICTURES.bytes / (1024 * 1024))} MB` };
  const body = await readFile(join(folder, rel)).catch(() => null);
  if (body === null) return { ok: false, why: "cannot be read" };
  const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const bad = proposedPictureProblem({ bytes, executable: false });
  return bad === null ? { ok: true, bytes } : { ok: false, why: bad };
}

/** The entries of a folder in byte order of their names. */
async function sorted(dir: string): Promise<Dirent[]> {
  return (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Read a trick folder for a proposal: regular files only, never through a link, within the caps. */
export async function readTrickFolder(folder: string): Promise<FolderRead> {
  const files: ProposedFile[] = [];
  const pictures: ProposedFile[] = [];
  const leftPictures: LeftPicture[] = [];
  const pictureDirs: string[] = [];
  let left = 0;
  let config = false;
  let seen = 0;
  let bytes = 0;
  const tooMany = (): string => `The folder holds more than ${String(PROPOSE_WALK_MAX)} entries. A trick is small.`;
  /** Leave one file of a picture folder behind, with its reason. */
  const leave = (rel: string, why: string): void => {
    left += 1;
    leftPictures.push({ rel, why });
  };
  const walk = async (rel: string, depth: number): Promise<string | null> => {
    const here = rel === "" ? folder : join(folder, rel);
    for (const entry of await sorted(here)) {
      seen += 1;
      if (seen > PROPOSE_WALK_MAX) return tooMany();
      const sub = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const st = await lstat(join(folder, sub));
      // The picture folders are read after the code, within what the code left of the caps.
      if (rel === "" && isPictureDir(entry.name)) {
        if (st.isDirectory() && !st.isSymbolicLink()) pictureDirs.push(sub);
        else leave(sub, st.isSymbolicLink() ? "is a symbolic link, so its pictures stay behind" : "is not a folder");
        continue;
      }
      if (leftBehind(sub, st.isDirectory())) {
        left += 1;
        if (isConfigPath(sub)) config = true;
        continue;
      }
      if (st.isSymbolicLink()) return `${sub} is a symbolic link. A trick holds regular files only.`;
      if (st.isDirectory()) {
        if (depth >= PROPOSE_LIMITS.depth) return `${sub} sits deeper than ${String(PROPOSE_LIMITS.depth)} folders.`;
        const deeper = await walk(sub, depth + 1);
        if (deeper !== null) return deeper;
        continue;
      }
      if (!st.isFile()) return `${sub} is not a regular file. A trick holds regular files only.`;
      bytes += st.size;
      if (files.length + 1 > PROPOSE_LIMITS.files) return `The trick holds more than ${String(PROPOSE_LIMITS.files)} files.`;
      if (bytes > PROPOSE_LIMITS.bytes) return `The trick holds more than ${String(PROPOSE_LIMITS.bytes / (1024 * 1024))} MB.`;
      const body = await readFile(join(folder, sub));
      files.push({ rel: sub, bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), executable: (st.mode & 0o111) !== 0 });
    }
    return null;
  };
  /** The folded names of the pictures taken: two that fold alike would refuse the whole proposal. */
  const taken = new Set<string>();
  /** One picture folder: its pictures within the caps, everything else left behind with its reason. */
  const takePictures = async (rel: string, depth: number): Promise<string | null> => {
    for (const entry of await sorted(join(folder, rel))) {
      seen += 1;
      if (seen > PROPOSE_WALK_MAX) return tooMany();
      const sub = `${rel}/${entry.name}`;
      // A dot name stays behind as everywhere else, with no line of its own.
      if (entry.name.startsWith(".")) {
        left += 1;
        continue;
      }
      const st = await lstat(join(folder, sub));
      if (st.isDirectory() && !st.isSymbolicLink()) {
        if (depth >= PROPOSE_LIMITS.depth) {
          leave(sub, `sits deeper than ${String(PROPOSE_LIMITS.depth)} folders`);
          continue;
        }
        const deeper = await takePictures(sub, depth + 1);
        if (deeper !== null) return deeper;
        continue;
      }
      const read = await readFolderPicture(folder, sub);
      // A name the wire refuses (a control or invisible character, too long) would refuse the whole proposal.
      const named = read.ok ? proposedPathProblem(sub) : null;
      if (!read.ok) leave(sub, read.why);
      else if (named !== null) leave(sub, named);
      else if (taken.has(foldKey(sub))) leave(sub, "differs only in case or Unicode form from another picture");
      else if (pictures.length >= PROPOSE_PICTURES.files) leave(sub, `is past the ${String(PROPOSE_PICTURES.files)} pictures a proposal brings`);
      else if (files.length + pictures.length + 1 > PROPOSE_LIMITS.files || bytes + read.bytes.length > PROPOSE_LIMITS.bytes) leave(sub, `would take the trick past ${String(PROPOSE_LIMITS.files)} files or ${String(PROPOSE_LIMITS.bytes / (1024 * 1024))} MB`);
      else {
        bytes += read.bytes.length;
        taken.add(foldKey(sub));
        pictures.push({ rel: sub, bytes: read.bytes, executable: false });
      }
    }
    return null;
  };
  try {
    const error = await walk("", 0);
    if (error !== null) return { ok: false, error };
    for (const dir of pictureDirs) {
      const problem = await takePictures(dir, 1);
      if (problem !== null) return { ok: false, error: problem };
    }
    return { ok: true, files, pictures, left, leftPictures, config };
  } catch (err) {
    return { ok: false, error: `The folder could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── The pictures a run names (`collie trick check --run`, `collie trick dev`) ──────────────────────

/** The most picture names one run's check reads from disk. */
const MEDIA_REFS_MAX = 64;

/**
 * The `media/` and `captures/` files a run's parts and Decisions name, each once, in document order: an
 * `image` node's or a `float` sprite's `src`, a Decision picture's `file`. A walk of the parsed values (as
 * JSON), so any later part that names a picture the same way counts too.
 */
export function namedPictures(doc: JsonValue): string[] {
  const out = new Set<string>();
  const visit = (value: JsonValue, depth: number): void => {
    if (out.size >= MEDIA_REFS_MAX || depth > 32) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const row = asJsonObject(value);
    if (row === undefined) return;
    for (const [key, item] of Object.entries(row)) {
      if (item === undefined) continue;
      const text = key === "src" || key === "file" ? asJsonString(item) : undefined;
      if (text !== undefined && text.includes("/") && isPictureDir(text.split("/")[0] ?? "")) out.add(text);
      else visit(item, depth + 1);
    }
  };
  visit(doc, 0);
  return [...out];
}

/** A run's accepted parts and Decisions as one JSON value, for {@link namedPictures}. */
export function runPictureDoc(parsed: Pick<ParsedTrickDocument, "parts" | "decisions">): JsonValue {
  return parseJson(JSON.stringify([parsed.parts, parsed.decisions])) ?? null;
}

/**
 * One warning for each picture a run names that a proposal would not bring: missing from the folder, not a
 * picture by its bytes, too large, or behind a link. The phone shows nothing in its place.
 */
export async function namedPictureWarnings(folder: string, parsed: Pick<ParsedTrickDocument, "parts" | "decisions">): Promise<string[]> {
  const warnings: string[] = [];
  for (const rel of namedPictures(runPictureDoc(parsed))) {
    const read = await readFolderPicture(folder, rel);
    if (read.ok) continue;
    const why = read.why === "is not in the folder" ? "is not in the folder" : `${read.why}, so a proposal leaves it behind`;
    warnings.push(`${rel} is named by the output but ${why}. The phone shows no picture there.`);
  }
  return warnings;
}

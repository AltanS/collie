import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HOST, isInside } from "./host.ts";
import { containedRealpath } from "./journal/files.ts";
import type { JsonObject, JsonValue } from "./json.ts";

// The slash commands Claude Code loads from disk for a pane's working directory.
//
// A bounded scan of Claude Code's documented personal and project skill and command folders, not a
// registry: the terminal's `/` menu stays the authority, and a row here proves only that a file exists
// where Claude Code looks. Every path is built from the operator's home, the bridge's own environment
// and the pane's cwd as the multiplexer reported it, never from a request, and every read resolves
// through `containedRealpath` against its owning root (the personal config dir / home, or the
// repository root).

export interface ClaudeCommand {
  /** Includes the leading slash, e.g. `/to-spec` or `/frontend:component`. */
  command: string;
  description: string;
  /** The frontmatter `argument-hint`, or empty when the file declares none. */
  argHint: string;
}

export interface ReadFileOptions {
  maxBytes?: number;
  truncate?: boolean;
}

/** Kept behind an interface so discovery is testable without a disk. */
export interface DiscoveryIo {
  /** Canonical path of `dir` when it exists and resolves inside `roots`, else null. */
  realDir(dir: string, roots: readonly string[]): Promise<string | null>;
  /** True when `<dir>/.git` exists and resolves inside `roots`. */
  hasGit(dir: string, roots: readonly string[]): Promise<boolean>;
  /** The entries of `dir`, symlinks followed and sorted by name; null when absent, unreadable, or outside `roots`. */
  list(dir: string, roots: readonly string[]): Promise<Array<{ name: string; dir: boolean }> | null>;
  /** The file's text, or null when absent, unreadable, not a regular file, or outside `roots`. */
  read(path: string, roots: readonly string[], opts?: ReadFileOptions): Promise<string | null>;
}

/** Frontmatter sits at the top; a skill or command file larger than this is read only this far. */
const MAX_FILE_BYTES = 64 * 1024;
/** Settings files are parsed as whole JSON documents; larger files are skipped with a warning. */
const MAX_SETTINGS_BYTES = 256 * 1024;
/** Maximum commands returned in one response. */
export const MAX_COMMANDS = 1000;
/** Maximum directory entries inspected in a single folder. */
const MAX_DIR_ENTRIES = 256;
/** Shared work budget across all directory entries and file reads in a single discovery call. */
export const MAX_SCAN_OPS = 1000;
/** How many folders the walk from the cwd to the repository root may climb. */
const MAX_WALK = 32;
const MAX_DESCRIPTION = 200;
/** A single folder, skill, or file name segment: letters, digits and `._-` (no colons or control chars). */
const NAME_SEGMENT = /^[\p{L}\p{N}._-]{1,64}$/u;
/** Full command name after the leading slash: letters, digits and `._:-`, up to 120 characters. */
const COMMAND_BODY = /^[\p{L}\p{N}._:-]{1,120}$/u;

type OverrideState = "on" | "name-only" | "user-invocable-only" | "off";

function isOverrideState(value: string): value is OverrideState {
  return value === "on" || value === "name-only" || value === "user-invocable-only" || value === "off";
}

async function realUnder(candidate: string, roots: readonly string[]): Promise<string | null> {
  for (const root of roots) {
    const real = await containedRealpath(candidate, root);
    if (real !== null) return real;
  }
  return null;
}

export const discoveryDiskIo: DiscoveryIo = {
  async realDir(dir, roots) {
    const real = await realUnder(dir, roots);
    if (real === null) return null;
    try {
      const info = await stat(real);
      return info.isDirectory() ? real : null;
    } catch {
      return null;
    }
  },
  async hasGit(dir, roots) {
    return (await realUnder(join(dir, ".git"), roots)) !== null;
  },
  async list(dir, roots) {
    const realDir = await realUnder(dir, roots);
    if (realDir === null) return null;
    let names: string[];
    try {
      names = await readdir(realDir);
    } catch {
      return null;
    }
    const out: Array<{ name: string; dir: boolean }> = [];
    for (const name of names.toSorted((a, b) => a.localeCompare(b)).slice(0, MAX_DIR_ENTRIES)) {
      const realEntry = await realUnder(join(realDir, name), roots);
      if (realEntry === null) continue;
      try {
        const info = await stat(realEntry);
        if (info.isDirectory() || info.isFile()) out.push({ name, dir: info.isDirectory() });
      } catch {
        // A dangling symlink is not a skill; Claude Code skips it too.
      }
    }
    return out;
  },
  async read(path, roots, opts) {
    const realPath = await realUnder(path, roots);
    if (realPath === null) return null;
    const maxBytes = opts?.maxBytes ?? MAX_FILE_BYTES;
    const truncate = opts?.truncate ?? true;
    try {
      const info = await stat(realPath);
      if (!info.isFile()) return null;
      const file = Bun.file(realPath);
      if (info.size > maxBytes) {
        return truncate ? await file.slice(0, maxBytes).text() : await file.slice(0, maxBytes + 1).text();
      }
      return await file.text();
    } catch {
      return null;
    }
  },
};

export interface Frontmatter {
  name?: string;
  description?: string;
  argumentHint?: string;
  userInvocable?: boolean;
}

export function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringEntries(value: JsonValue | undefined): Map<string, OverrideState> {
  const out = new Map<string, OverrideState>();
  for (const [key, entry] of Object.entries(asObject(value) ?? {})) {
    if (typeof entry === "string" && isOverrideState(entry)) out.set(key, entry);
  }
  return out;
}

/**
 * The YAML block at the top of a skill or command file. Null when the file opens with a block that
 * does not parse, which the caller reports; an empty object when there is no block at all, which is
 * an ordinary command file.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!/^---\r?\n/.test(body)) return {};
  const end = body.search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (end < 0) return null;
  let doc: JsonValue;
  try {
    // SAFETY: `Bun.YAML.parse` answers with a plain YAML value (scalars, arrays, objects), and the
    // lines below read it only through asObject/asString and one boolean check.
    doc = Bun.YAML.parse(body.slice(body.indexOf("\n") + 1, end)) as JsonValue;
  } catch {
    return null;
  }
  if (doc === null) return {};
  const fields = asObject(doc);
  if (fields === null) return null;
  const invocable = fields["user-invocable"];
  return {
    name: asString(fields.name),
    description: asString(fields.description),
    argumentHint: asString(fields["argument-hint"]),
    userInvocable: invocable === true || invocable === false ? invocable : undefined,
  };
}

export function cleanDescription(raw: string | undefined): string {
  // Control characters out: the text reaches a phone screen, and Claude Code strips them as well.
  const flat = (raw ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

async function readSkillOverrides(
  io: DiscoveryIo,
  path: string,
  roots: readonly string[],
  warn: (m: string) => void,
): Promise<Map<string, OverrideState>> {
  const text = await io.read(path, roots, { maxBytes: MAX_SETTINGS_BYTES, truncate: false });
  if (text === null) return new Map();
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) {
    warn(`${path} exceeds ${String(MAX_SETTINGS_BYTES)} bytes; its skill settings are ignored`);
    return new Map();
  }
  try {
    // SAFETY: `JSON.parse` answers with a JSON value by definition, narrowed via asObject/stringEntries.
    const doc = JSON.parse(text) as JsonValue;
    return stringEntries(asObject(doc)?.skillOverrides);
  } catch (err) {
    warn(`${path} could not be parsed (${String(err)}); its skill settings are ignored`);
    return new Map();
  }
}

/**
 * The folders from `cwd` up to the repository root, nearest first. With no repository above it the
 * cwd alone counts, which is where Claude Code started. The walk never climbs past `home`: a
 * `.claude` there is the personal folder, read once as such.
 */
export async function projectDirs(io: DiscoveryIo, cwd: string, home: string): Promise<string[]> {
  if (!isInside(HOST, cwd, home)) return [];
  const dirs: string[] = [];
  let dir = cwd;
  for (let i = 0; i < MAX_WALK; i++) {
    if (dir === home) break;
    dirs.push(dir);
    if (await io.hasGit(dir, [home])) return dirs;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirs.slice(0, 1);
}

interface ScanBudget {
  ops: number;
  visitedDirs: Set<string>;
}

async function readCommandFile(
  io: DiscoveryIo,
  path: string,
  fallbackName: string,
  prefix: string,
  useFrontName: boolean,
  roots: readonly string[],
  budget: ScanBudget,
  warn: (m: string) => void,
): Promise<ClaudeCommand | null> {
  if (budget.ops <= 0) return null;
  budget.ops -= 1;
  const text = await io.read(path, roots);
  if (text === null) return null;
  const front = parseFrontmatter(text);
  if (front === null) {
    warn(`${path}: the frontmatter does not parse, so the command is left out`);
    return null;
  }
  if (front.userInvocable === false) return null;
  const name = (useFrontName ? front.name?.trim() : undefined) || fallbackName;
  if (!NAME_SEGMENT.test(name)) return null;
  const body = `${prefix}${name}`;
  if (!COMMAND_BODY.test(body)) return null;
  return {
    command: `/${body}`,
    description: cleanDescription(front.description),
    argHint: cleanDescription(front.argumentHint),
  };
}

/** `<root>/<name>/SKILL.md` for every skill folder under `root`. */
async function skillsIn(
  io: DiscoveryIo,
  root: string,
  roots: readonly string[],
  budget: ScanBudget,
  warn: (m: string) => void,
): Promise<ClaudeCommand[]> {
  if (budget.ops <= 0) return [];
  budget.ops -= 1;
  const entries = await io.list(root, roots);
  if (entries === null) return [];
  const out: ClaudeCommand[] = [];
  for (const entry of entries) {
    if (budget.ops <= 0 || out.length >= MAX_COMMANDS) break;
    if (!entry.dir || !NAME_SEGMENT.test(entry.name)) continue;
    const row = await readCommandFile(io, join(root, entry.name, "SKILL.md"), entry.name, "", true, roots, budget, warn);
    if (row !== null) out.push(row);
  }
  return out;
}

/** `.md` files under `root`, a subfolder becoming a `:`-joined namespace. */
async function commandsIn(
  io: DiscoveryIo,
  root: string,
  prefix: string,
  roots: readonly string[],
  budget: ScanBudget,
  warn: (m: string) => void,
  depth = 0,
): Promise<ClaudeCommand[]> {
  if (depth > 4 || budget.ops <= 0) return [];
  const canonical = await io.realDir(root, roots);
  if (canonical === null || budget.visitedDirs.has(canonical)) return [];
  budget.visitedDirs.add(canonical);
  budget.ops -= 1;
  const entries = await io.list(root, roots);
  if (entries === null) return [];
  const out: ClaudeCommand[] = [];
  for (const entry of entries) {
    if (budget.ops <= 0 || out.length >= MAX_COMMANDS) break;
    const path = join(root, entry.name);
    if (entry.dir) {
      if (!NAME_SEGMENT.test(entry.name)) continue;
      const sub = await commandsIn(io, path, `${prefix}${entry.name}:`, roots, budget, warn, depth + 1);
      for (const item of sub) {
        if (out.length >= MAX_COMMANDS) break;
        out.push(item);
      }
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!NAME_SEGMENT.test(name)) continue;
    const row = await readCommandFile(io, path, name, prefix, false, roots, budget, warn);
    if (row !== null) out.push(row);
  }
  return out;
}

/**
 * The Claude config dir to read: the parent of the first Claude journal root when that root is a
 * `projects` folder, which is how an operator running a `CLAUDE_CONFIG_DIR` profile already points
 * Collie at it (`COLLIE_TRANSCRIPT_ROOT`); `<home>/.claude` otherwise.
 */
export function claudeConfigDir(journalRoots: readonly string[], home: string): string {
  const first = journalRoots[0];
  return first !== undefined && basename(first) === "projects" ? dirname(first) : join(home, ".claude");
}

export interface DiscoverOptions {
  home: string;
  /** The pane's cwd as the multiplexer reported it; null reads only what is not per-project. */
  cwd: string | null;
  /** See {@link claudeConfigDir}. */
  configDir: string;
  io?: DiscoveryIo;
  warn?: (message: string) => void;
}

/**
 * Documented skill and command file candidates under `<configDir>` and `cwd`, one row per name.
 * Precedence: personal skills, personal commands, then each folder from `cwd` up to the repository
 * root (skills before commands in each folder).
 */
export async function discoverClaudeCommands(opts: DiscoverOptions): Promise<ClaudeCommand[]> {
  const io = opts.io ?? discoveryDiskIo;
  const warn = opts.warn ?? ((m: string) => console.warn(`[claude-commands] ${m}`));
  const { home, configDir } = opts;
  const realHome = opts.io === undefined ? await containedRealpath(home, home) : home;
  const realCwd =
    opts.cwd === null || realHome === null
      ? null
      : opts.io === undefined
        ? await containedRealpath(opts.cwd, realHome)
        : isInside(HOST, opts.cwd, realHome)
          ? opts.cwd
          : null;
  const dirs = realCwd === null || realHome === null ? [] : await projectDirs(io, realCwd, realHome);
  const personalRoots = [configDir, home];

  // Narrowest last, so it wins the merge: user, then the project root's shared and local files.
  const root = dirs.at(-1);
  const overrides = await readSkillOverrides(io, join(configDir, "settings.json"), personalRoots, warn);
  if (root !== undefined) {
    for (const [k, v] of await readSkillOverrides(io, join(root, ".claude", "settings.json"), [root], warn)) {
      overrides.set(k, v);
    }
    for (const [k, v] of await readSkillOverrides(io, join(root, ".claude", "settings.local.json"), [root], warn)) {
      overrides.set(k, v);
    }
  }

  const budget: ScanBudget = { ops: MAX_SCAN_OPS, visitedDirs: new Set() };
  const ordered: ClaudeCommand[] = [
    ...(await skillsIn(io, join(configDir, "skills"), personalRoots, budget, warn)),
    ...(await commandsIn(io, join(configDir, "commands"), "", personalRoots, budget, warn)),
  ];
  for (const dir of dirs) {
    if (budget.ops <= 0) break;
    const projectRoots = [root ?? dir];
    ordered.push(...(await skillsIn(io, join(dir, ".claude", "skills"), projectRoots, budget, warn)));
    ordered.push(...(await commandsIn(io, join(dir, ".claude", "commands"), "", projectRoots, budget, warn)));
  }

  const byName = new Map<string, ClaudeCommand>();
  for (const row of ordered) {
    if (overrides.get(row.command.slice(1)) === "off") continue;
    if (!byName.has(row.command)) {
      byName.set(row.command, row);
      if (byName.size >= MAX_COMMANDS) break;
    }
  }
  return [...byName.values()];
}

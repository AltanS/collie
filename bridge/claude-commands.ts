import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { HOST, isInside } from "./host.ts";
import { containedRealpath } from "./journal/files.ts";
import type { JsonObject, JsonValue } from "./json.ts";

// The slash commands Claude Code loads from disk for a pane's working directory.
//
// A bounded scan of Claude Code's documented personal and project skill and command folders, plus the
// skills and commands of installed, enabled plugins, not a registry: the terminal's `/` menu stays the authority, and a row here proves only that a file exists
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
export const MAX_SETTINGS_BYTES = 256 * 1024;
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
export const NAME_SEGMENT = /^[\p{L}\p{N}._-]{1,64}$/u;
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
  /** omp's `enabled: false`; Claude Code ignores it. */
  enabled?: boolean;
  /** Antigravity's `disable-slash-command: true`; Claude Code ignores it. */
  disableSlashCommand?: boolean;
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

export function parseJson(text: string): JsonValue {
  // SAFETY: `JSON.parse` answers with a JSON value by definition, and every reader below narrows it
  // through asObject/asString/stringEntries/booleanEntries before believing a field.
  return JSON.parse(text) as JsonValue;
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
  const enabled = fields.enabled;
  const disabled = fields["disable-slash-command"];
  return {
    name: asString(fields.name),
    description: asString(fields.description),
    argumentHint: asString(fields["argument-hint"]),
    userInvocable: invocable === true || invocable === false ? invocable : undefined,
    enabled: enabled === true || enabled === false ? enabled : undefined,
    disableSlashCommand: disabled === true || disabled === false ? disabled : undefined,
  };
}

export function cleanDescription(raw: string | undefined): string {
  // Control characters out: the text reaches a phone screen, and Claude Code strips them as well.
  const flat = (raw ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

/**
 * Read a settings or trust file up to {@link MAX_SETTINGS_BYTES}; null when absent or oversized so a
 * truncated document is never parsed as a partial configuration.
 */
export async function readSettingsText(
  io: DiscoveryIo,
  path: string,
  roots: readonly string[],
  onOversize?: () => void,
): Promise<string | null> {
  const text = await io.read(path, roots, { maxBytes: MAX_SETTINGS_BYTES, truncate: false });
  if (text === null) return null;
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) {
    onOversize?.();
    return null;
  }
  return text;
}

/** One JSON file as an object; null when absent, oversized or unparseable (the last two reported). */
async function readJsonObject(
  io: DiscoveryIo,
  path: string,
  roots: readonly string[],
  warn: (m: string) => void,
  ignored = "its skill and plugin settings are ignored",
): Promise<JsonObject | null> {
  const text = await readSettingsText(io, path, roots, () =>
    warn(`${path} exceeds ${String(MAX_SETTINGS_BYTES)} bytes; ${ignored}`),
  );
  if (text === null) return null;
  try {
    return asObject(parseJson(text));
  } catch (err) {
    warn(`${path} could not be parsed (${String(err)}); ${ignored}`);
    return null;
  }
}

function booleanEntries(value: JsonValue | undefined): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [key, entry] of Object.entries(asObject(value) ?? {})) {
    if (typeof entry === "boolean") out.set(key, entry);
  }
  return out;
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
  prefix = "",
): Promise<ClaudeCommand[]> {
  if (budget.ops <= 0) return [];
  budget.ops -= 1;
  const entries = await io.list(root, roots);
  if (entries === null) return [];
  const out: ClaudeCommand[] = [];
  for (const entry of entries) {
    if (budget.ops <= 0 || out.length >= MAX_COMMANDS) break;
    if (!entry.dir || !NAME_SEGMENT.test(entry.name)) continue;
    const row = await readCommandFile(io, join(root, entry.name, "SKILL.md"), entry.name, prefix, true, roots, budget, warn);
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

/** Enabled plugins read in one response. Disabled ones never take a slot. */
const MAX_PLUGINS = 64;

interface InstalledPlugin {
  /** `<plugin>@<marketplace>`, the key `enabledPlugins` uses. */
  key: string;
  /** The part of the key before `@`: the prefix of every command the plugin offers. */
  name: string;
  installPath: string;
}

/**
 * The install `installed_plugins.json` records for each plugin. A key can hold several entries (one
 * per scope). A `project` or `local` entry counts only when its `projectPath` is one of the folders
 * of this pane's project, and then it wins; otherwise the entry with the newest `installedAt` wins,
 * which in practice is the `user` install. Only enabled plugins are returned, and the cap counts
 * them alone, so a disabled plugin can never push an enabled one out of the list.
 */
function installedPlugins(
  doc: JsonObject,
  enabledPlugins: ReadonlyMap<string, boolean>,
  projectFolders: readonly string[],
  warn: (m: string) => void,
): InstalledPlugin[] {
  const plugins = asObject(doc.plugins);
  if (plugins === null) {
    warn("installed_plugins.json has no `plugins` map, so no plugin is listed");
    return [];
  }
  // ASSUMPTION, checked with `claude plugin list`: a plugin that no settings file sets to `true`
  // is off. The marketplace install step writes the `enabledPlugins` entry (it is where the
  // manifest's `defaultEnabled` applies), so Collie does not second-guess an absent key.
  const enabled = Object.entries(plugins).filter(([key]) => enabledPlugins.get(key) === true);
  if (enabled.length > MAX_PLUGINS) {
    warn(`${String(enabled.length)} enabled plugins, the first ${String(MAX_PLUGINS)} are listed`);
  }
  const out: InstalledPlugin[] = [];
  for (const [key, value] of enabled.slice(0, MAX_PLUGINS)) {
    const name = key.split("@")[0] ?? "";
    if (!NAME_SEGMENT.test(name) || !Array.isArray(value)) continue;
    let best: { path: string; local: boolean; at: number } | null = null;
    for (const item of value) {
      const entry = asObject(item);
      const path = asString(entry?.installPath);
      if (entry === null || path === undefined || !isAbsolute(path)) continue;
      const scope = asString(entry.scope);
      const projectPath = asString(entry.projectPath);
      const local = scope === "project" || scope === "local";
      if (local && (projectPath === undefined || !projectFolders.some((dir) => resolve(dir) === resolve(projectPath)))) continue;
      const at = Date.parse(asString(entry.installedAt) ?? "") || 0;
      if (best === null || (local && !best.local) || (local === best.local && at > best.at)) best = { path, local, at };
    }
    if (best !== null) out.push({ key, name, installPath: best.path });
  }
  return out;
}

/** A manifest path (`./x` or `.`) as an absolute path inside the plugin root; null when it is neither. */
function insidePlugin(root: string, raw: JsonValue | undefined): string | null {
  if (typeof raw !== "string" || (raw !== "." && !raw.startsWith("./"))) return null;
  // `join`, not `resolve`: `root` is already absolute and real, and on Windows `resolve` puts the
  // current drive in front of a root that has none, so the path no longer names the plugin's files.
  // The trailing "." drops a trailing separator (`./x/`), so the same folder is spelled one way.
  const full = join(root, raw, ".");
  return isInside(HOST, full, root) ? full : null;
}

function manifestPaths(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/**
 * The rows of one plugin: its `skills` folders and its `commands`, every name carrying `<plugin>:`.
 * `installedPlugins` has already checked that the merged `enabledPlugins` maps say `true` for it.
 *
 * Not read yet: the single-skill plugin form (a root SKILL.md with no `skills/` folder and no
 * `skills` key in the manifest).
 */
async function pluginRows(
  io: DiscoveryIo,
  plugin: InstalledPlugin,
  personalRoots: readonly string[],
  budget: ScanBudget,
  warn: (m: string) => void,
): Promise<ClaudeCommand[]> {
  // The plugin folder is a personal location: it must resolve inside the config dir or the home.
  // Every read below is then contained in the plugin's own folder, so a link inside it cannot leave.
  const root = await io.realDir(plugin.installPath, personalRoots);
  if (root === null) {
    warn(`${plugin.key}: ${plugin.installPath} is not a folder inside the config dir or home, so the plugin is left out`);
    return [];
  }
  const roots = [root];
  const manifestPath = join(root, ".claude-plugin", "plugin.json");
  const text = await io.read(manifestPath, roots, { maxBytes: MAX_SETTINGS_BYTES, truncate: false });
  let manifest: JsonObject = {};
  if (text !== null) {
    try {
      manifest = asObject(parseJson(text)) ?? {};
    } catch (err) {
      warn(`${manifestPath} could not be parsed (${String(err)}); the plugin is left out`);
      return [];
    }
  }
  const prefix = `${plugin.name}:`;
  const refuse = (field: string, raw: JsonValue) =>
    warn(`${plugin.key}: the ${field} path ${JSON.stringify(raw)} is not a ./ path inside the plugin folder, so it is left out`);
  const out: ClaudeCommand[] = [];

  // `skills` adds to the default `skills/` folder. A listed folder holds <name>/SKILL.md folders or
  // is itself one skill folder.
  const skillDirs = [join(root, "skills")];
  for (const raw of manifestPaths(manifest.skills)) {
    const dir = insidePlugin(root, raw);
    if (dir === null) refuse("skills", raw);
    else if (!skillDirs.includes(dir)) skillDirs.push(dir);
  }
  for (const dir of skillDirs) {
    const own = dir === root ? plugin.name : basename(dir);
    const single = dir === join(root, "skills") ? null : await readCommandFile(io, join(dir, "SKILL.md"), own, prefix, true, roots, budget, warn);
    if (single !== null) out.push(single);
    out.push(...(await skillsIn(io, dir, roots, budget, warn, prefix)));
  }

  // `commands` replaces the default `commands/` folder: a folder, a flat .md file, or a name map.
  const commands = manifest.commands;
  const commandMap = Array.isArray(commands) ? null : asObject(commands);
  if (commandMap !== null) {
    for (const [name, spec] of Object.entries(commandMap).slice(0, MAX_DIR_ENTRIES)) {
      const entry = asObject(spec);
      if (entry === null || !NAME_SEGMENT.test(name)) continue;
      const source = insidePlugin(root, entry.source);
      let row: ClaudeCommand | null = null;
      if (source !== null) {
        row = await readCommandFile(io, source, name, prefix, false, roots, budget, warn);
      } else if (entry.source !== undefined) {
        refuse("commands", entry.source);
      } else if (typeof entry.content === "string" && COMMAND_BODY.test(`${prefix}${name}`)) {
        row = { command: `/${prefix}${name}`, description: "", argHint: "" };
      }
      if (row === null) continue;
      const description = asString(entry.description);
      const hint = asString(entry.argumentHint);
      out.push({
        ...row,
        description: description === undefined ? row.description : cleanDescription(description),
        argHint: hint === undefined ? row.argHint : cleanDescription(hint),
      });
    }
  } else {
    const listed = commands === undefined ? [join(root, "commands")] : manifestPaths(commands).map((raw) => {
      const path = insidePlugin(root, raw);
      if (path === null) refuse("commands", raw);
      return path;
    });
    for (const path of listed) {
      if (path === null) continue;
      if (!path.endsWith(".md")) {
        out.push(...(await commandsIn(io, path, prefix, roots, budget, warn)));
        continue;
      }
      const name = basename(path).slice(0, -3);
      const row = NAME_SEGMENT.test(name) ? await readCommandFile(io, path, name, prefix, false, roots, budget, warn) : null;
      if (row !== null) out.push(row);
    }
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
  const settingsFiles: Array<{ path: string; roots: readonly string[] }> = [
    { path: join(configDir, "settings.json"), roots: personalRoots },
  ];
  if (root !== undefined) {
    settingsFiles.push(
      { path: join(root, ".claude", "settings.json"), roots: [root] },
      { path: join(root, ".claude", "settings.local.json"), roots: [root] },
    );
  }
  const overrides = new Map<string, OverrideState>();
  const enabledPlugins = new Map<string, boolean>();
  for (const file of settingsFiles) {
    const settings = await readJsonObject(io, file.path, file.roots, warn);
    for (const [k, v] of stringEntries(settings?.skillOverrides)) overrides.set(k, v);
    for (const [k, v] of booleanEntries(settings?.enabledPlugins)) enabledPlugins.set(k, v);
  }

  // Scan order is the budget's priority: personal and project rows are read before any plugin row,
  // so a plugin-heavy machine cannot starve them. Precedence for a clashing name is the order below.
  const budget: ScanBudget = { ops: MAX_SCAN_OPS, visitedDirs: new Set() };
  const personal: ClaudeCommand[] = [
    ...(await skillsIn(io, join(configDir, "skills"), personalRoots, budget, warn)),
    ...(await commandsIn(io, join(configDir, "commands"), "", personalRoots, budget, warn)),
  ];
  const project: ClaudeCommand[] = [];
  for (const dir of dirs) {
    if (budget.ops <= 0) break;
    const projectRoots = [root ?? dir];
    project.push(...(await skillsIn(io, join(dir, ".claude", "skills"), projectRoots, budget, warn)));
    project.push(...(await commandsIn(io, join(dir, ".claude", "commands"), "", projectRoots, budget, warn)));
  }
  const plugin: ClaudeCommand[] = [];
  const installed = await readJsonObject(
    io,
    join(configDir, "plugins", "installed_plugins.json"),
    personalRoots,
    warn,
    "no plugin is listed",
  );
  if (installed !== null) {
    for (const item of installedPlugins(installed, enabledPlugins, dirs, warn)) {
      if (budget.ops <= 0) break;
      plugin.push(...(await pluginRows(io, item, personalRoots, budget, warn)));
    }
  }

  // Personal, then plugins, then project: a plugin's name carries its `plugin:` prefix, so a clash
  // is rare, and the folders the operator owns still win one.
  const byName = new Map<string, { row: ClaudeCommand; fromPlugin: boolean }>();
  const sources: Array<[ClaudeCommand[], boolean]> = [[personal, false], [plugin, true], [project, false]];
  for (const [rows, fromPlugin] of sources) {
    for (const row of rows) {
      if (overrides.get(row.command.slice(1)) === "off") continue;
      if (!byName.has(row.command)) byName.set(row.command, { row, fromPlugin });
    }
  }
  // One cap for the response: past it, plugin rows give way before personal and project rows do.
  let room = MAX_COMMANDS;
  let pluginRoom = MAX_COMMANDS - [...byName.values()].filter((e) => !e.fromPlugin).length;
  const out: ClaudeCommand[] = [];
  for (const { row, fromPlugin } of byName.values()) {
    if (room <= 0) break;
    if (fromPlugin && pluginRoom-- <= 0) continue;
    room -= 1;
    out.push(row);
  }
  return out;
}

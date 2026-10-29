import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { HOST, isInside } from "./host.ts";
import { containedRealpath } from "./journal/files.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  asObject,
  asString,
  cleanDescription,
  discoveryDiskIo,
  MAX_COMMANDS,
  MAX_SCAN_OPS,
  NAME_SEGMENT,
  parseFrontmatter,
  parseJson,
  projectDirs,
  readSettingsText,
  type ClaudeCommand,
  type DiscoveryIo,
  type Frontmatter,
} from "./claude-commands.ts";

// The skills and prompt commands seven agents other than Claude would load for a pane, read off this
// machine's disk, the sibling of claude-commands.ts and held to the same habits:
// a best-effort mirror of each agent's loader, not a registry, so a row proves only that a file exists
// where that agent looks. Every path is built from the operator's home, the bridge's own environment
// and the pane's cwd as the multiplexer reported it, never from a request, and every read resolves
// through `containedRealpath` against its owning root (the personal config dir / home, the plugin
// folder, or the repository root). Nothing is executed and nothing is written; a missing folder is a
// quiet empty list and a file that does not parse is skipped.
//
// Each rule below was read from the agent's source or documentation, or checked live against its `/`
// menu (Codex 0.159.3, opencode 1.18.34 and 1.19.2, pi 1.1.0 and 1.3.0, omp 18.10.1, Grok 1.0.52,
// Antigravity 1.3.5, Muse 1.4.8). Because the phone only stages a selected command into the composer,
// a loader difference between agent releases at most adds or omits a searchable suggestion row.

const SKILL_AGENTS = ["codex", "opencode", "pi", "omp", "grok", "agy", "muse"] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

const KNOWN_AGENTS: ReadonlySet<string> = new Set(SKILL_AGENTS);

export function isSkillAgent(agent: string): agent is SkillAgent {
  return KNOWN_AGENTS.has(agent);
}

/** Other names Herdr reports an agent under, each filed under the loader's own name. */
const SKILL_AGENT_ALIASES = new Map<string, SkillAgent>([["antigravity", "agy"]]);

/** The loader for an agent name as the pane reports it, aliases folded in; undefined when there is none. */
export function skillAgentFor(agent: string): SkillAgent | undefined {
  if (isSkillAgent(agent)) return agent;
  return SKILL_AGENT_ALIASES.get(agent);
}

export interface SkillDiscovery {
  home: string;
  /** The pane's cwd as the multiplexer reported it; null reads only what is not per-project. */
  cwd: string | null;
  env: Readonly<Record<string, string | undefined>>;
}

const SKILL_FILE = "SKILL.md";
/** Folders below a skill root a recursive agent descends; Codex's own limit, reused for opencode and pi. */
const MAX_SCAN_DEPTH = 6;
/** Pi shows a prompt template's first body line cut here when the file has no description. */
const MAX_PROMPT_LINE = 60;
/** How many folders the walk up from the cwd looks for a trust entry. */
const MAX_TRUST_WALK = 64;

/** What can be typed after the slash: no whitespace and no control character, which also keep a name from breaking the row. */
const TYPEABLE = /^[^\s\p{Cc}\p{Cf}]+$/u;
/** Shape accepted by the phone's `fetchClaudeCommands` validator (`/` or `$` + up to 120 safe characters). */
const VALID_COMMAND = /^[/$][\p{L}\p{N}._:/-]{1,120}$/u;
/** A Codex mention is `$name`, and only these characters can be typed in one. */
const CODEX_NAME = /^[A-Za-z0-9_:-]+$/;
/** Muse's skill id, taken from the folder name. */
const MUSE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

interface ScanBudget {
  ops: number;
}

interface Found {
  /** The SKILL.md, or the loose markdown file itself. */
  path: string;
  /** The skill's folder name, or the loose file's stem. */
  name: string;
  /** Null when the file opens with a block that does not parse. */
  front: Frontmatter | null;
}

interface Parsed extends Found {
  front: Frontmatter;
}

interface ScanRules {
  /** 1 reads `<root>/<name>/SKILL.md` only; larger values descend that many folders. */
  depth: number;
  /** Skip `.`-prefixed entries, which keeps Codex's `.system` built-ins out. */
  skipHidden: boolean;
  /** A folder holding a SKILL.md is a skill root and is not descended further. */
  stopAtSkill: boolean;
  skip: ReadonlySet<string>;
  /** Top-level `*.md` files are skills too (Pi's own roots only). */
  loose: boolean;
}

const NO_SKIP: ReadonlySet<string> = new Set();
const ONE_LEVEL: ScanRules = { depth: 1, skipHidden: false, stopAtSkill: false, skip: NO_SKIP, loose: false };
const DEEP: ScanRules = { ...ONE_LEVEL, depth: MAX_SCAN_DEPTH };

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function envDir(env: SkillDiscovery["env"], key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function envFlag(env: SkillDiscovery["env"], key: string): boolean {
  const value = env[key]?.toLowerCase();
  return value === "true" || value === "1";
}

function parseToml(text: string): JsonObject | null {
  try {
    // SAFETY: `Bun.TOML.parse` answers with a plain object of TOML values; the readers below narrow it
    // through asObject/asString/Array.isArray before believing a field, and never inspect a date.
    return asObject(Bun.TOML.parse(text) as JsonValue);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    return asObject(parseJson(text));
  } catch {
    return null;
  }
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => asString(entry) ?? []) : [];
}

function nameOf(found: Parsed): string {
  const named = found.front.name?.trim();
  return named === undefined || named === "" ? found.name : named;
}

function hasDescription(front: Frontmatter): boolean {
  return cleanDescription(front.description) !== "";
}

function rowOf(command: string, front: Frontmatter, description?: string): ClaudeCommand {
  return {
    command,
    description: description ?? cleanDescription(front.description),
    argHint: cleanDescription(front.argumentHint),
  };
}

const parsed = (all: Found[]): Parsed[] => all.filter((found): found is Parsed => found.front !== null);

async function readSkillFile(
  io: DiscoveryIo,
  folder: string,
  roots: readonly string[],
  budget: ScanBudget,
): Promise<Found | null> {
  if (budget.ops <= 0) return null;
  budget.ops -= 1;
  const path = join(folder, SKILL_FILE);
  const text = await io.read(path, roots);
  return text === null ? null : { path, name: basename(folder), front: parseFrontmatter(text) };
}

/** The skills under `root`, entries in name order so a clash between two folders resolves the same way every time. */
async function scan(
  io: DiscoveryIo,
  root: string,
  roots: readonly string[],
  rules: ScanRules,
  budget: ScanBudget,
): Promise<Found[]> {
  const out: Found[] = [];
  const visited = new Set<string>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (budget.ops <= 0) return;
    const canonical = await io.realDir(dir, roots);
    if (canonical === null || visited.has(canonical)) return;
    visited.add(canonical);
    budget.ops -= 1;
    const entries = await io.list(dir, roots);
    if (entries === null) return;
    for (const entry of entries.toSorted(byName)) {
      if (budget.ops <= 0) break;
      if ((rules.skipHidden && entry.name.startsWith(".")) || rules.skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (!entry.dir) {
        if (depth === 0 && rules.loose && entry.name.endsWith(".md") && entry.name !== SKILL_FILE) {
          if (budget.ops <= 0) break;
          budget.ops -= 1;
          const text = await io.read(path, roots);
          if (text !== null) out.push({ path, name: entry.name.slice(0, -3), front: parseFrontmatter(text) });
        }
        continue;
      }
      const skill = await readSkillFile(io, path, roots, budget);
      if (skill !== null) out.push(skill);
      if (skill !== null && rules.stopAtSkill) continue;
      if (depth + 1 < rules.depth) await visit(path, depth + 1);
    }
  };
  await visit(root, 0);
  return out;
}

interface MarkdownFile {
  /** The path below the root without `.md`, one entry per folder. */
  rel: string[];
  text: string;
  front: Frontmatter;
}

/** `*.md` files under `root`, `depth` 1 meaning direct children only. */
async function markdownIn(
  io: DiscoveryIo,
  root: string,
  roots: readonly string[],
  depth: number,
  budget: ScanBudget,
): Promise<MarkdownFile[]> {
  const out: MarkdownFile[] = [];
  const visited = new Set<string>();
  const visit = async (dir: string, rel: string[]): Promise<void> => {
    if (budget.ops <= 0) return;
    const canonical = await io.realDir(dir, roots);
    if (canonical === null || visited.has(canonical)) return;
    visited.add(canonical);
    budget.ops -= 1;
    const entries = await io.list(dir, roots);
    if (entries === null) return;
    for (const entry of entries.toSorted(byName)) {
      if (budget.ops <= 0) break;
      const path = join(dir, entry.name);
      if (entry.dir) {
        if (rel.length + 1 < depth) await visit(path, [...rel, entry.name]);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      budget.ops -= 1;
      const text = await io.read(path, roots);
      const front = text === null ? null : parseFrontmatter(text);
      if (text !== null && front !== null) out.push({ rel: [...rel, entry.name.slice(0, -3)], text, front });
    }
  };
  await visit(root, []);
  return out;
}

function bodyOf(text: string): string {
  const body = text.replace(/^﻿/, "");
  if (!/^---\r?\n/.test(body)) return body;
  const end = /\r?\n---[ \t]*(\r?\n|$)/.exec(body);
  return end === null ? body : body.slice(end.index + end[0].length);
}

/** An absolute path, or a `~/` one spelled from `home`; anything else a settings file might hold is not ours to resolve. */
function absoluteFrom(raw: string, home: string): string | null {
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : null;
}

function atOrUnder(path: string, ancestor: string): boolean {
  const here = resolve(path);
  return here === ancestor || here.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}

/** `decisions` keyed by path: the nearest folder at or above `cwd` with an entry decides. */
function nearestDecision(cwd: string, decisions: ReadonlyMap<string, boolean>): boolean {
  let dir = resolve(cwd);
  for (let i = 0; i < MAX_TRUST_WALK; i++) {
    const decision = decisions.get(dir);
    if (decision !== undefined) return decision;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

function decisionsFrom(entries: ReadonlyArray<[string, JsonValue | undefined]>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [path, decision] of entries) {
    if ((decision === true || decision === false) && isAbsolute(path)) out.set(resolve(path), decision);
  }
  return out;
}

// ── codex ──────────────────────────────────────────────────────────────────────────────────────

interface CodexDisabled {
  names: Set<string>;
  /** Resolved paths of a SKILL.md or of its folder. */
  paths: Set<string>;
}

/** `[[skills.config]]` entries with `enabled = false`; a config that does not parse disables nothing. */
async function codexDisabled(io: DiscoveryIo, path: string, roots: readonly string[]): Promise<CodexDisabled> {
  const out: CodexDisabled = { names: new Set(), paths: new Set() };
  const text = await readSettingsText(io, path, roots);
  const config = text === null ? null : parseToml(text);
  const entries = asObject(config?.skills)?.config;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const fields = asObject(entry);
    if (fields === null || fields.enabled !== false) continue;
    const name = asString(fields.name);
    const where = asString(fields.path);
    if (name !== undefined) out.names.add(name);
    if (where !== undefined && isAbsolute(where)) out.paths.add(resolve(where));
  }
  return out;
}

async function codexRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const codexHome = envDir(where.env, "CODEX_HOME") ?? join(where.home, ".codex");
  const personalRoots = [codexHome, where.home];
  const disabled = await codexDisabled(io, join(codexHome, "config.toml"), personalRoots);
  // The built-in `.system` skills are shipped as static rows by the phone; scanning them would list them twice.
  const rules: ScanRules = { ...DEEP, skipHidden: true };
  const roots: Array<[string, readonly string[]]> = [
    ...dirs.map((dir): [string, readonly string[]] => [join(dir, ".agents", "skills"), projectRoots]),
    [join(codexHome, "skills"), personalRoots],
    [join(where.home, ".agents", "skills"), personalRoots],
  ];
  const rows: ClaudeCommand[] = [];
  for (const [root, allowedRoots] of roots) {
    for (const found of parsed(await scan(io, root, allowedRoots, rules, budget))) {
      const name = nameOf(found);
      if (!hasDescription(found.front) || !CODEX_NAME.test(name)) continue;
      if (disabled.names.has(name) || disabled.paths.has(resolve(found.path)) || disabled.paths.has(resolve(dirname(found.path)))) continue;
      rows.push(rowOf(`$${name}`, found.front));
    }
  }
  return rows;
}

// ── opencode ───────────────────────────────────────────────────────────────────────────────────

const skillAndSkills = (base: string) => [join(base, "skill"), join(base, "skills")];

async function opencodeRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const config = join(envDir(where.env, "XDG_CONFIG_HOME") ?? join(where.home, ".config"), "opencode");
  const customConfig = envDir(where.env, "OPENCODE_CONFIG_DIR");
  const disableExternal = envFlag(where.env, "OPENCODE_DISABLE_EXTERNAL_SKILLS");
  const disableClaude =
    disableExternal ||
    envFlag(where.env, "OPENCODE_DISABLE_CLAUDE_CODE") ||
    envFlag(where.env, "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
  const disableProject = envFlag(where.env, "OPENCODE_DISABLE_PROJECT_CONFIG");
  const personalRoots = [config, where.home, ...(customConfig === undefined ? [] : [customConfig])];
  const projectDirsToScan = disableProject ? [] : dirs;
  const externalDirsToScan = disableExternal ? [] : dirs;
  const roots: Array<[string, readonly string[]]> = [
    ...externalDirsToScan.flatMap((dir): Array<[string, readonly string[]]> =>
      disableClaude
        ? [[join(dir, ".agents", "skills"), projectRoots]]
        : [
            [join(dir, ".claude", "skills"), projectRoots],
            [join(dir, ".agents", "skills"), projectRoots],
          ],
    ),
    ...projectDirsToScan.flatMap((dir) => skillAndSkills(join(dir, ".opencode")).map((r): [string, readonly string[]] => [r, projectRoots])),
    ...skillAndSkills(config).map((r): [string, readonly string[]] => [r, personalRoots]),
    ...skillAndSkills(join(where.home, ".opencode")).map((r): [string, readonly string[]] => [r, personalRoots]),
    ...(customConfig === undefined
      ? []
      : skillAndSkills(customConfig).map((r): [string, readonly string[]] => [r, personalRoots])),
    ...(disableClaude ? [] : ([[join(where.home, ".claude", "skills"), personalRoots]] satisfies Array<[string, readonly string[]]>)),
    ...(disableExternal ? [] : ([[join(where.home, ".agents", "skills"), personalRoots]] satisfies Array<[string, readonly string[]]>)),
  ];
  const rows: ClaudeCommand[] = [];
  for (const [root, allowedRoots] of roots) {
    for (const found of parsed(await scan(io, root, allowedRoots, DEEP, budget))) {
      // No folder fallback: opencode skips a SKILL.md that names nothing.
      const name = found.front.name?.trim() ?? "";
      if (TYPEABLE.test(name)) rows.push(rowOf(`/${name}`, found.front));
    }
  }
  // Listed order is the precedence for a clashing command name; if a future opencode release merges
  // project commands ahead of the user's config folder, only the winning row's description differs.
  const commandBases: Array<[string, readonly string[]]> = [
    [config, personalRoots],
    ...projectDirsToScan.map((dir): [string, readonly string[]] => [join(dir, ".opencode"), projectRoots]),
    [join(where.home, ".opencode"), personalRoots],
    ...(customConfig === undefined ? [] : ([[customConfig, personalRoots]] satisfies Array<[string, readonly string[]]>)),
  ];
  for (const [base, allowedRoots] of commandBases) {
    for (const root of [join(base, "command"), join(base, "commands")]) {
      for (const file of await markdownIn(io, root, allowedRoots, MAX_SCAN_DEPTH, budget)) {
        const name = file.rel.join("/");
        if (TYPEABLE.test(name)) rows.push(rowOf(`/${name}`, file.front));
      }
    }
  }
  return rows;
}

// ── pi ─────────────────────────────────────────────────────────────────────────────────────────

interface PiSettings {
  enableSkillCommands: boolean | undefined;
  /** Paths a skill may not sit at or under (`settings.json` `skills` entries starting with `-`). */
  excluded: string[];
}

async function piSettings(
  io: DiscoveryIo,
  path: string,
  roots: readonly string[],
  home: string,
  baseDir: string,
): Promise<PiSettings> {
  const text = await readSettingsText(io, path, roots);
  const settings = text === null ? null : parseJsonObject(text);
  const excluded: string[] = [];
  for (const entry of stringList(settings?.skills)) {
    if (!entry.startsWith("-")) continue;
    const raw = entry.slice(1);
    if (raw === "") continue;
    const target = absoluteFrom(raw, home) ?? resolve(baseDir, raw);
    excluded.push(target);
  }
  const flag = settings?.enableSkillCommands;
  return {
    enableSkillCommands: flag === true || flag === false ? flag : undefined,
    excluded,
  };
}

async function piTrusted(
  io: DiscoveryIo,
  agentDir: string,
  roots: readonly string[],
  cwd: string,
): Promise<boolean> {
  const text = await readSettingsText(io, join(agentDir, "trust.json"), roots);
  const trust = text === null ? null : parseJsonObject(text);
  if (trust === null) return false;
  const decisions = decisionsFrom(Object.entries(trust));
  // pi keys a folder by its real path (`canonicalizePath`), so a cwd reached through a link is looked up
  // by both spellings.
  return nearestDecision(cwd, decisions) || nearestDecision(await realPath(cwd), decisions);
}

async function piRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const agentDir = envDir(where.env, "PI_CODING_AGENT_DIR") ?? join(where.home, ".pi", "agent");
  const personalRoots = [agentDir, where.home];
  const here = dirs[0];
  const trusted =
    here !== undefined && where.cwd !== null && (await piTrusted(io, agentDir, personalRoots, where.cwd));
  const rules: ScanRules = { ...DEEP, skipHidden: true, stopAtSkill: true, skip: new Set(["node_modules"]) };
  const loose: ScanRules = { ...rules, loose: true };
  const globalSettings = await piSettings(
    io,
    join(agentDir, "settings.json"),
    personalRoots,
    where.home,
    agentDir,
  );
  const projectSettings =
    trusted && here !== undefined
      ? await piSettings(io, join(here, ".pi", "settings.json"), projectRoots, where.home, join(here, ".pi"))
      : null;
  const enableSkillCommands = (projectSettings?.enableSkillCommands ?? globalSettings.enableSkillCommands) ?? true;
  const excluded = [...globalSettings.excluded, ...(projectSettings?.excluded ?? [])];
  const rows: ClaudeCommand[] = [];
  if (enableSkillCommands) {
    const roots: Array<[string, readonly string[], ScanRules]> = [
      ...(trusted && here !== undefined
        ? ([[join(here, ".pi", "skills"), projectRoots, loose]] satisfies Array<[string, readonly string[], ScanRules]>)
        : []),
      ...(trusted
        ? dirs.map((dir): [string, readonly string[], ScanRules] => [join(dir, ".agents", "skills"), projectRoots, rules])
        : []),
      [join(agentDir, "skills"), personalRoots, loose],
      [join(where.home, ".agents", "skills"), personalRoots, rules],
    ];
    for (const [root, allowedRoots, scanRules] of roots) {
      for (const found of parsed(await scan(io, root, allowedRoots, scanRules, budget))) {
        const name = nameOf(found);
        if (!hasDescription(found.front) || !TYPEABLE.test(name)) continue;
        if (excluded.some((ancestor) => atOrUnder(found.path, ancestor))) continue;
        rows.push(rowOf(`/skill:${name}`, found.front));
      }
    }
  }
  const promptRoots: Array<[string, readonly string[]]> = [
    ...(trusted && here !== undefined
      ? ([[join(here, ".pi", "prompts"), projectRoots]] satisfies Array<[string, readonly string[]]>)
      : []),
    [join(agentDir, "prompts"), personalRoots],
  ];
  for (const [promptRoot, allowedRoots] of promptRoots) {
    for (const file of await markdownIn(io, promptRoot, allowedRoots, 1, budget)) {
      const name = file.rel.join("/");
      if (!TYPEABLE.test(name)) continue;
      const firstLine = bodyOf(file.text).split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
      const fallback = cleanDescription(firstLine).slice(0, MAX_PROMPT_LINE);
      rows.push(rowOf(`/${name}`, file.front, hasDescription(file.front) ? undefined : fallback));
    }
  }
  return rows;
}

// ── omp ────────────────────────────────────────────────────────────────────────────────────────

async function ompRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const here = dirs[0];
  const { home } = where;
  const personalRoots = [home];
  // The walk never includes home, so `.omp/skills` there is read once, as the user's own. Foreign user
  // folders (`~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`) are off by default in omp.
  const tiers: Array<[string, readonly string[], boolean]> = [
    [join(home, ".omp", "agent", "skills"), personalRoots, false],
    ...dirs.map((dir): [string, readonly string[], boolean] => [join(dir, ".omp", "skills"), projectRoots, false]),
    [join(home, ".agents", "skills"), personalRoots, false],
    [join(home, ".agent", "skills"), personalRoots, false],
    ...dirs.flatMap((dir): Array<[string, readonly string[], boolean]> => [
      [join(dir, ".agents", "skills"), projectRoots, false],
      [join(dir, ".agent", "skills"), projectRoots, false],
    ]),
    ...dirs.map((dir): [string, readonly string[], boolean] => [join(dir, ".claude", "skills"), projectRoots, false]),
    ...(here === undefined
      ? []
      : ([
          [join(here, ".codex", "skills"), projectRoots, false],
          [join(here, ".opencode", "skills"), projectRoots, false],
          [join(here, ".github", "skills"), projectRoots, true],
        ] satisfies Array<[string, readonly string[], boolean]>)),
  ];
  const rows: ClaudeCommand[] = [];
  for (const [root, allowedRoots, needsDescription] of tiers) {
    for (const found of parsed(await scan(io, root, allowedRoots, ONE_LEVEL, budget))) {
      const name = nameOf(found);
      if (found.front.enabled === false || name.includes("/") || name.includes("\\") || !TYPEABLE.test(name)) continue;
      if (needsDescription && !hasDescription(found.front)) continue;
      rows.push(rowOf(`/skill:${name}`, found.front));
    }
  }
  return rows;
}

// ── grok ───────────────────────────────────────────────────────────────────────────────────────

/** Grok's names are lowercase with `-` for spaces and underscores. */
const grokName = (raw: string) => raw.toLowerCase().replace(/[\s_]/g, "-");

async function grokTrusted(
  io: DiscoveryIo,
  grokHome: string,
  roots: readonly string[],
  cwd: string,
): Promise<boolean> {
  const text = await readSettingsText(io, join(grokHome, "trusted_folders.toml"), roots);
  const doc = text === null ? null : parseToml(text);
  const folders = asObject(doc?.folders);
  if (folders === null) return false;
  // The nearest ancestor with an explicit `trusted` boolean decides, matching pi's trust walk; a nearer
  // `trusted = false` therefore withholds project rows beneath a trusted parent folder.
  const entries = Object.entries(folders).map((entry): [string, JsonValue | undefined] => [entry[0], asObject(entry[1])?.trusted]);
  const decisions = decisionsFrom(entries);
  // Grok keys a folder by its real path (live: `/private/var/...` for a cwd under `/var/...`), so the
  // cwd is looked up by both spellings.
  return nearestDecision(cwd, decisions) || nearestDecision(await realPath(cwd), decisions);
}

interface GrokPlace {
  /** The `.grok` / `.agents` / `.claude` / `.cursor` folder. */
  base: string;
  /** `.cursor` has a skills folder but no commands one. */
  commands: boolean;
  /** Project places load only in a trusted folder. */
  project: boolean;
}

const project = (base: string, commands: boolean): GrokPlace => ({ base, commands, project: true });
const user = (base: string, commands: boolean): GrokPlace => ({ base, commands, project: false });

async function grokRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const { home } = where;
  const grokHome = envDir(where.env, "GROK_HOME") ?? join(home, ".grok");
  const personalRoots = [grokHome, home];
  const here = dirs[0];
  const trusted =
    here !== undefined && where.cwd !== null && (await grokTrusted(io, grokHome, personalRoots, where.cwd));
  const places: GrokPlace[] = [
    ...(here === undefined ? [] : [project(join(here, ".grok"), true), project(join(here, ".agents"), true)]),
    ...dirs.slice(1).flatMap((dir) => [project(join(dir, ".grok"), true), project(join(dir, ".agents"), true)]),
    user(grokHome, true),
    ...(here === undefined ? [] : [project(join(here, ".claude"), true)]),
    user(join(home, ".claude"), true),
    ...(here === undefined ? [] : [project(join(here, ".cursor"), false)]),
    user(join(home, ".cursor"), false),
  ];

  const configText = await readSettingsText(io, join(grokHome, "config.toml"), personalRoots);
  const config = asObject((configText === null ? null : parseToml(configText))?.skills);
  const disabled = new Set(stringList(config?.disabled).map(grokName));
  const ignored = stringList(config?.ignore).flatMap((entry) => absoluteFrom(entry, home) ?? []);

  const rows: ClaudeCommand[] = [];
  for (const place of places) {
    if (place.project && !trusted) continue;
    const allowedRoots = place.project ? projectRoots : personalRoots;
    for (const found of parsed(await scan(io, join(place.base, "skills"), allowedRoots, ONE_LEVEL, budget))) {
      const name = grokName(nameOf(found));
      if (found.front.userInvocable === false || disabled.has(name) || !TYPEABLE.test(name)) continue;
      if (ignored.some((ancestor) => atOrUnder(found.path, ancestor))) continue;
      rows.push(rowOf(`/${name}`, found.front));
    }
    if (!place.commands) continue;
    for (const file of await markdownIn(io, join(place.base, "commands"), allowedRoots, 1, budget)) {
      const name = grokName(file.rel.join("/"));
      if (file.front.userInvocable !== false && TYPEABLE.test(name)) rows.push(rowOf(`/${name}`, file.front));
    }
  }
  return rows;
}

// ── agy ────────────────────────────────────────────────────────────────────────────────────────

async function agyRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const gemini = join(where.home, ".gemini");
  const personalRoots = [gemini, where.home];
  // `~/.gemini/antigravity/skills` and `~/.agents/skills` are deliberately absent: checked live in agy
  // 1.3.5, neither shows in its `/` menu, so reading them would list skills the agent cannot run.
  const tiers: Array<[string, readonly string[], string]> = [
    ...dirs.flatMap((dir) =>
      [".agents", ".agent", "_agents", "_agent"].map((name): [string, readonly string[], string] => [
        join(dir, name, "skills"),
        projectRoots,
        "",
      ]),
    ),
    [join(gemini, "skills"), personalRoots, ""],
  ];
  const plugins = join(gemini, "antigravity-cli", "plugins");
  if (budget.ops > 0) {
    budget.ops -= 1;
    for (const plugin of ((await io.list(plugins, personalRoots)) ?? []).toSorted(byName)) {
      if (!plugin.dir || !NAME_SEGMENT.test(plugin.name)) continue;
      const pluginRoot = await io.realDir(join(plugins, plugin.name), personalRoots);
      if (pluginRoot !== null) tiers.push([join(pluginRoot, "skills"), [pluginRoot], `${plugin.name}:`]);
    }
  }
  const rows: ClaudeCommand[] = [];
  for (const [root, allowedRoots, prefix] of tiers) {
    for (const found of parsed(await scan(io, root, allowedRoots, ONE_LEVEL, budget))) {
      const name = nameOf(found);
      if (found.front.disableSlashCommand === true || !TYPEABLE.test(name)) continue;
      rows.push(rowOf(`/${prefix}${name}`, found.front));
    }
  }
  return rows;
}

// ── muse ───────────────────────────────────────────────────────────────────────────────────────

async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Muse's trust store records the REAL path (seen live in Muse 1.4.8: a cwd under macOS `/var/...`
 * is keyed `/private/var/...`), so the cwd and the repository root are compared by both spellings.
 * Only an exact key for the cwd or the repository root counts, with no ancestor walk above the
 * repository root, so an untrusted sub-repo never inherits trust from a parent directory.
 */
async function museTrusted(
  io: DiscoveryIo,
  trustFile: string,
  roots: readonly string[],
  dirs: string[],
): Promise<boolean> {
  const here = dirs[0];
  const root = dirs.at(-1);
  if (here === undefined || root === undefined) return false;
  const text = await readSettingsText(io, trustFile, roots);
  const projects = asObject((text === null ? null : parseJsonObject(text))?.projects);
  if (projects === null) return false;
  const keys = new Set([here, root, await realPath(here), await realPath(root)]);
  return Object.entries(projects).some(([key, entry]) => keys.has(key) && asObject(entry)?.decision === "trusted");
}

async function museRows(
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  const { home } = where;
  const config = envDir(where.env, "XDG_CONFIG_HOME") ?? join(home, ".config");
  const codexHome = envDir(where.env, "CODEX_HOME") ?? join(home, ".codex");
  const personalRoots = [config, codexHome, home];
  const trusted = await museTrusted(io, join(config, "muse", "trust.json"), personalRoots, dirs);
  // Walk from the cwd to the repository root, as the other project-aware loaders do; if a Muse
  // release reads only the repository root, a nested folder's `.agents`/`.codex`/`.claude` skills
  // appear as extra staged suggestions.
  const roots: Array<[string, readonly string[]]> = [
    ...(trusted
      ? dirs.flatMap((dir) =>
          [".agents", ".codex", ".claude"].map((name): [string, readonly string[]] => [
            join(dir, name, "skills"),
            projectRoots,
          ]),
        )
      : []),
    [join(config, "muse", "skills"), personalRoots],
    [join(home, ".agents", "skills"), personalRoots],
    [join(home, ".claude", "skills"), personalRoots],
    [join(codexHome, "skills"), personalRoots],
  ];
  const rules: ScanRules = { ...ONE_LEVEL, skipHidden: true };
  const rows: ClaudeCommand[] = [];
  for (const [root, allowedRoots] of roots) {
    for (const found of parsed(await scan(io, root, allowedRoots, rules, budget))) {
      // The id is the folder name; a frontmatter `name` does not rename it.
      if (found.front.userInvocable === false || !MUSE_ID.test(found.name)) continue;
      rows.push(rowOf(`/${found.name}`, found.front));
    }
  }
  return rows;
}

/**
 * Every skill and prompt command `agent` would offer in `where.cwd`, one row per command, sorted. When
 * two places define a name the first in the agent's own search order wins, and a skill an agent hides
 * does not shadow one below it.
 */
export async function discoverAgentSkills(
  agent: SkillAgent,
  where: SkillDiscovery,
  io?: DiscoveryIo,
): Promise<ClaudeCommand[]> {
  const diskIo = io ?? discoveryDiskIo;
  const realHome = io === undefined ? await containedRealpath(where.home, where.home) : where.home;
  if (realHome === null) return [];
  const realCwd =
    where.cwd === null
      ? null
      : io === undefined
        ? await containedRealpath(where.cwd, realHome)
        : isInside(HOST, where.cwd, realHome)
          ? where.cwd
          : null;
  // On real disk `realCwd` is already verified inside `realHome`; when a custom `io` is supplied for
  // unit tests, keep the caller's spelling so symlink-keyed trust tests can exercise both paths.
  const walkCwd = realCwd === null ? null : io === undefined ? realCwd : where.cwd;
  const dirs = walkCwd === null ? [] : await projectDirs(diskIo, walkCwd, realHome);
  const projectRoots: readonly string[] = dirs.length > 0 ? [dirs.at(-1)!] : [];
  const budget: ScanBudget = { ops: MAX_SCAN_OPS };
  const rows = await rowsFor(agent, { ...where, home: realHome, cwd: where.cwd }, diskIo, dirs, projectRoots, budget);
  const byCommand = new Map<string, ClaudeCommand>();
  for (const row of rows) {
    if (!VALID_COMMAND.test(row.command)) continue;
    if (!byCommand.has(row.command)) byCommand.set(row.command, row);
  }
  return [...byCommand.values()].slice(0, MAX_COMMANDS).toSorted((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
}

function rowsFor(
  agent: SkillAgent,
  where: SkillDiscovery,
  io: DiscoveryIo,
  dirs: string[],
  projectRoots: readonly string[],
  budget: ScanBudget,
): Promise<ClaudeCommand[]> {
  switch (agent) {
    case "codex":
      return codexRows(where, io, dirs, projectRoots, budget);
    case "opencode":
      return opencodeRows(where, io, dirs, projectRoots, budget);
    case "pi":
      return piRows(where, io, dirs, projectRoots, budget);
    case "omp":
      return ompRows(where, io, dirs, projectRoots, budget);
    case "grok":
      return grokRows(where, io, dirs, projectRoots, budget);
    case "agy":
      return agyRows(where, io, dirs, projectRoots, budget);
    case "muse":
      return museRows(where, io, dirs, projectRoots, budget);
  }
}

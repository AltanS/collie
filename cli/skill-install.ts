import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

import { codexHome } from "./codex-hooks.ts";
import { WALKY_TALKY_SKILL_TEMPLATE } from "./docs-embed.ts";
import { type CliContext, collieVersion } from "./context.ts";
import { claudeSettingsTargets, realpathVia, resolveHookCommand } from "./hooks.ts";
import { EXIT, type Io } from "./io.ts";
import type { LinkReader } from "./link.ts";
import { type SyncResult, syncLines } from "./skill-sync-result.ts";
import type { Files } from "./sys.ts";

// `collie skill install|uninstall|sync|status [--check]|print` — putting the walky talky skill into the
// agents' own skills folders, and telling when this build's text has moved on from what is there.
//
// It is the same shape as `collie hooks install` (cli/hooks.ts), and it borrows that file's guards:
//
//  - ONLY THE SKILL VERBS AND THE UPDATE WRITE. `collie skill install` and `collie skill sync` write a
//    harness file, and every successful `collie update` (rollback and switch included) runs `skill
//    sync` through the new binary (ADR 0111). No bridge start, and no other verb, touches one.
//    `collie skill uninstall` leaves a marker under the state dir, so the next sync leaves that
//    target out.
//  - A SYMLINKED FILE IS REFUSED, an unreadable one too. A rename onto a symlink replaces the link
//    (home-manager's read-only store profile). A symlinked DIRECTORY resolves, as in hooks.
//  - ONE `.collie-backup` BEFORE THE FIRST CHANGE, temp file plus rename, and a second install changes
//    no byte: "already there" is decided by comparing the bytes, never by finding a marker and stopping.
//
// One form since #770: every harness Collie writes for reads a skills folder, and gets the whole file
// `<its skills folder>/collie-walky-talky/SKILL.md`, which Collie owns. It is replaced as a whole. A file
// at that path that does not carry our stamp is somebody else's and is refused. Only the front matter's
// `name` and `description` reach the agent's prompt; the body is read when the agent opens the skill.
//
// THE OLD BLOCK. Until 1.28.2, Codex, opencode, pi and Gemini CLI got a managed block in a global
// instruction file that is the operator's (Collie owned only the text between {@link BLOCK_BEGIN} and
// {@link BLOCK_END}), and the whole block was prompt in every session. Each of those rows names that file
// as `legacy`. `install` and `sync` cut the old block out once the skill file is in place, never before,
// so no update leaves a harness with neither. A legacy file whose markers are damaged or doubled, or that
// is a symlink, is left alone and named, in the verb's output and in `doctor`. The block itself lives on
// only in `collie skill print generic`, for a hand paste into a harness Collie does not know.
//
// DRIFT. The last line of the skill is the stamp, `<!-- collie-skill walky-talky v1 collie 1.23.0 -->`.
// `status` renders this build's text and compares it with each target. The version inside the stamp is
// NOT compared: a release that did not change the skill must not tell every operator to reinstall. The
// stamp's own `v1` is compared, so changing the shape of the text (a bump of {@link SKILL_FORMAT}) goes
// stale on purpose. A different path in the examples (the binary moved) or a different word is stale.

// ── The text ─────────────────────────────────────────────────────────────────

/** The text's format version. Bump it when an installed copy must be replaced whatever the words say. */
export const SKILL_FORMAT = 1;

export const BLOCK_BEGIN = `<!-- collie:walky-talky v${String(SKILL_FORMAT)} begin -->`;
export const BLOCK_END = `<!-- collie:walky-talky v${String(SKILL_FORMAT)} end -->`;

/** What makes a file or block ours, at any text version. */
const STAMP_PREFIX = "<!-- collie-skill walky-talky v";
const BEGIN_ANY = /^<!-- collie:walky-talky v\d+ begin -->[ \t]*$/gmu;
const END_ANY = /^<!-- collie:walky-talky v\d+ end -->[ \t]*$/gmu;
const STAMP_VERSION = /^(<!-- collie-skill walky-talky v\d+ collie ).*( -->)[ \t]*$/mu;
/** The stamp line in either spelling, the build's or the hash's. */
const STAMP_LINE = /^<!-- collie-skill walky-talky v\d+ .*-->[ \t]*$/mu;

/** The skill's own name, which is the folder Claude Code reads it from. */
export const SKILL_NAME = "collie-walky-talky";

/** The embedded template with `{{COLLIE_BIN}}` and `{{COLLIE_VERSION}}` resolved. Front matter included. */
export function renderWalkySkill(ctx: CliContext, fs: LinkReader): string {
  const binary = resolveHookCommand(ctx, fs).binary;
  const version = collieVersion(ctx.root);
  return WALKY_TALKY_SKILL_TEMPLATE.replaceAll("{{COLLIE_BIN}}", binary)
    .replaceAll("{{COLLIE_VERSION}}", version)
    .replace(/\n+$/u, "\n");
}

/** The text without its `---` front matter: what a harness reads inside an instruction file. */
function withoutFrontMatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const close = text.indexOf("\n---\n", 4);
  return close < 0 ? text : text.slice(close + "\n---\n".length).replace(/^\n+/u, "");
}

/**
 * The managed block for a rendered skill: markers around the body, no trailing newline. The body's last
 * line is the block's own stamp, the format and the first 12 hex digits of a sha256 of the text above
 * it, so the block's bytes move only when its words or its format move (#770).
 */
export function blockOf(rendered: string): string {
  const body = withoutFrontMatter(withLf(rendered)).replace(STAMP_LINE, "").replace(/\n+$/u, "");
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return `${BLOCK_BEGIN}\n${body}\n${STAMP_PREFIX}${String(SKILL_FORMAT)} text ${hash} -->\n${BLOCK_END}`;
}

/** Text with the stamp's collie version blanked, so two builds of one text compare equal. */
function withoutStampVersion(text: string): string {
  return text.replace(STAMP_VERSION, "$1-$2");
}

/** Line ends do not make a skill stale: an editor on Windows may save the file with CRLF. */
const withLf = (text: string): string => text.replaceAll("\r\n", "\n");

const sameText = (a: string, b: string): boolean => withoutStampVersion(withLf(a)) === withoutStampVersion(withLf(b));

// ── The targets ──────────────────────────────────────────────────────────────

export interface SkillTarget {
  readonly harness: string;
  /** Every path this harness reads, in the order they print. Claude has one per config profile. */
  readonly paths: (ctx: Pick<CliContext, "home" | "env">) => string[];
  /** The harness's own config folder for a path of this row. `install all` skips a harness whose folder is not there. */
  readonly home: (path: string) => string;
  /**
   * The instruction file an earlier Collie put this harness's block in, for a row that moved to a skill
   * file (#770). `install` and `sync` cut that block out once the file is in place; `uninstall` cuts it too.
   */
  readonly legacy?: (ctx: Pick<CliContext, "home" | "env">) => string;
}

/**
 * The Claude profile folders the skill goes into: every one the hooks installer knows, then
 * `CLAUDE_CONFIG_DIR` when it is set to an absolute path. A relative value names no folder Collie
 * could find again, so it is left out.
 */
export function claudeProfileDirs(ctx: Pick<CliContext, "home" | "env">): string[] {
  // `~/.claude` stays in the list even when `CLAUDE_CONFIG_DIR` replaces it in the hooks' targets: the
  // skill goes beside it as it always did (this change is about where hooks are written).
  const dirs = [join(ctx.home, ".claude"), ...claudeSettingsTargets(ctx).map((t) => t.dir)];
  const own = ctx.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (own !== "" && isAbsolute(own)) dirs.push(own.replace(/[\\/]+$/u, "") || own);
  return [...new Set(dirs)];
}

/** `<skills>/collie-walky-talky/SKILL.md`. */
const skillIn = (skills: string): string => join(skills, SKILL_NAME, "SKILL.md");
/** The harness folder that holds `skills/collie-walky-talky/SKILL.md`. */
const threeUp = (path: string): string => dirname(dirname(dirname(path)));
/** `$XDG_CONFIG_HOME`, else `~/.config`: the base opencode reads, as `bridge/agent-skills.ts` spells it. */
const configBase = (ctx: Pick<CliContext, "home" | "env">): string => {
  const set = (ctx.env.XDG_CONFIG_HOME ?? "").trim();
  return set === "" ? join(ctx.home, ".config") : set;
};
const piAgentDir = (ctx: Pick<CliContext, "home" | "env">): string => {
  const set = (ctx.env.PI_CODING_AGENT_DIR ?? "").trim();
  return set === "" ? join(ctx.home, ".pi", "agent") : set;
};

/**
 * Where each harness reads the skill from (#770). Every row is a skills folder the harness loads at
 * start, one of the roots `bridge/agent-skills.ts` names for it, and always the harness's OWN user folder,
 * never the shared `~/.agents/skills`: the harnesses that read that folder would each list the skill a
 * second time beside their own copy. Each row was checked against the harness's own code on 2026-11-12;
 * the evidence and the first version are on the lines above the row.
 *
 * Three harnesses have no row, because a row of theirs would be a second copy in a folder they already
 * read: Antigravity (`agy`) reads `~/.gemini/skills`, Gemini CLI's row; Grok reads `~/.claude/skills`;
 * Muse reads `~/.claude/skills` and `$CODEX_HOME/skills` ({@link COVERED_BY}).
 *
 * `generic` is not in the table on purpose: it has no file. `collie skill print generic` prints the
 * block for a hand paste.
 */
export const SKILL_TARGETS: readonly SkillTarget[] = [
  {
    // https://code.claude.com/docs/en/skills (2026-10-17): "Personal skills: ~/.claude/skills/<skill-name>/SKILL.md".
    // A `CLAUDE_CONFIG_DIR` profile replaces `~/.claude`, so every profile the hooks installer knows
    // (`claudeSettingsTargets`) gets the same folder, and so does the profile `CLAUDE_CONFIG_DIR`
    // itself names in the install's own environment (a profile set only that way, M62 live rig).
    harness: "claude",
    home: threeUp,
    paths: (ctx) => claudeProfileDirs(ctx).map((dir) => skillIn(join(dir, "skills"))),
  },
  {
    // The Codex 0.150.0 binary (the floor of the verified range) loads user skills from
    // "`$CODEX_HOME/skills`, or `~/.codex/skills` when `CODEX_HOME` is unset", and so does 0.167.2. It
    // also reads `~/.agents/skills`, never `~/.claude/skills`. Until 1.28.2 the skill was a block in the
    // `AGENTS.md` of the Codex home.
    harness: "codex",
    home: threeUp,
    paths: (ctx) => [skillIn(join(codexHome(ctx), "skills"))],
    legacy: (ctx) => join(codexHome(ctx), "AGENTS.md"),
  },
  {
    // opencode 1.19.5 globs `{skill,skills}/**/SKILL.md` in its config folder; the palette read the same
    // live in 1.18.34. It also reads `~/.claude/skills` and `~/.agents/skills`, and a name found twice is
    // one skill with a "duplicate skill name" log line, never two rows, so a Claude copy beside this one
    // costs a log line. This copy stays: without it, opencode on a machine with no Claude has no skill.
    // Until 1.28.2 the block sat in `~/.config/opencode/AGENTS.md`, which never followed XDG_CONFIG_HOME.
    harness: "opencode",
    home: threeUp,
    paths: (ctx) => [skillIn(join(configBase(ctx), "opencode", "skills"))],
    legacy: (ctx) => join(ctx.home, ".config", "opencode", "AGENTS.md"),
  },
  {
    // pi's CHANGELOG: skills since 0.19.0 (2025-12-12), `SKILL.md` since 0.20.0, so the whole verified
    // range (0.85.0 on) has them; 1.3.0's `loadSkills` reads `<agentDir>/skills`. A description is
    // required. Until 1.28.2 the block sat in `<agentDir>/AGENTS.md`.
    harness: "pi",
    home: threeUp,
    paths: (ctx) => [skillIn(join(piAgentDir(ctx), "skills"))],
    legacy: (ctx) => join(piAgentDir(ctx), "AGENTS.md"),
  },
  {
    // omp 18.6.1 `src/discovery/builtin.ts` reads `~/.omp/agent/skills` (`omp skill list` since 18.3.3).
    // Claude's and Codex's user folders are off unless the operator turns them on; a copy found twice with
    // the same bytes collapses into one. Collie never wrote anything for omp before.
    harness: "omp",
    home: threeUp,
    paths: (ctx) => [skillIn(join(ctx.home, ".omp", "agent", "skills"))],
  },
  {
    // Gemini CLI reads `~/.gemini/skills` (`Storage.getUserSkillsDir`): behind `experimental.skills` in
    // 0.24.0 and 0.25.0, on by default since 0.26.0 (2026-01-28), checked in the npm packages 0.24.0 to
    // 0.60.0. A later root wins a clash by name, with a warning, so it is never listed twice. Antigravity
    // reads this folder too, so this one file serves both. Until 1.28.2 the block sat in
    // `~/.gemini/GEMINI.md` (https://geminicli.com/docs/cli/gemini-md/, 2026-10-17).
    harness: "gemini",
    home: threeUp,
    paths: (ctx) => [skillIn(join(ctx.home, ".gemini", "skills"))],
    legacy: (ctx) => join(ctx.home, ".gemini", "GEMINI.md"),
  },
];

/**
 * The harnesses that read a row's folder and so have no row of their own, with the row(s) that serve
 * them. `install <name>` points there instead of writing a second copy.
 */
export const COVERED_BY = {
  agy: ["gemini"],
  grok: ["claude"],
  muse: ["claude", "codex"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Harness names the verbs accept. `generic` only prints. */
export const SKILL_HARNESSES: readonly string[] = [...SKILL_TARGETS.map((t) => t.harness), "generic"];

/** One concrete file, with the row it came from, and the instruction file an earlier build used for it. */
export interface SkillFile {
  readonly target: SkillTarget;
  readonly path: string;
  readonly legacy: string | null;
}

export function skillFiles(ctx: Pick<CliContext, "home" | "env">, harnesses?: readonly string[]): SkillFile[] {
  return SKILL_TARGETS.filter((t) => harnesses === undefined || harnesses.includes(t.harness)).flatMap((target) =>
    target.paths(ctx).map((path) => ({ target, path, legacy: target.legacy?.(ctx) ?? null })),
  );
}

// ── Reading a target ─────────────────────────────────────────────────────────

export interface SkillReadDeps {
  readonly ctx: CliContext;
  readonly files: Files;
  readonly fs: LinkReader;
}

export interface SkillDeps extends SkillReadDeps {
  readonly io: Io;
}

export type SkillState =
  | { readonly kind: "installed" }
  | { readonly kind: "stale" }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string };

/** The path as it must be written, or the sentence that says why it may not be. */
function resolveFile(deps: SkillReadDeps, path: string): { path: string } | { reason: string } {
  const dir = dirname(path);
  const real = realpathVia(deps.fs, dir);
  if (real !== dir && deps.fs.probe(real).kind === "absent") {
    return { reason: `${dir} is a symlink to ${real}, which does not exist` };
  }
  const resolved = join(real, path.slice(dir.length + 1));
  if (deps.fs.probe(resolved).kind === "symlink") return { reason: `${resolved} is a symlink` };
  return { path: resolved };
}

/** Where the managed block sits. `end` is one past the end marker. */
type BlockLookup =
  | { readonly kind: "none" }
  | { readonly kind: "span"; readonly start: number; readonly end: number }
  | { readonly kind: "damaged"; readonly reason: string };

function findBlock(text: string): BlockLookup {
  const begins = [...text.matchAll(BEGIN_ANY)];
  const ends = [...text.matchAll(END_ANY)];
  if (begins.length === 0 && ends.length === 0) return { kind: "none" };
  const begin = begins[0];
  const end = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    return { kind: "damaged", reason: "its WalkyTalky markers are not one begin and one end" };
  }
  if (end.index < begin.index) return { kind: "damaged", reason: "its WalkyTalky end marker comes before the begin marker" };
  return { kind: "span", start: begin.index, end: end.index + end[0].length };
}

interface Reading {
  readonly path: string;
  /** The file's text, null when absent. */
  readonly text: string | null;
  readonly refusal: string | null;
}

function readFile(deps: SkillReadDeps, raw: string): Reading {
  const resolved = resolveFile(deps, raw);
  if ("reason" in resolved) return { path: raw, text: null, refusal: resolved.reason };
  if (!deps.files.exists(resolved.path)) return { path: resolved.path, text: null, refusal: null };
  const text = deps.files.read(resolved.path);
  if (text === null) return { path: resolved.path, text: null, refusal: `${resolved.path} cannot be read` };
  return { path: resolved.path, text, refusal: null };
}

/** The verdict for one file against this build's text. */
export function skillState(deps: SkillReadDeps, file: SkillFile, rendered: string): SkillState {
  const reading = readFile(deps, file.path);
  if (reading.refusal !== null) return { kind: "refused", reason: reading.refusal };
  if (reading.text === null) return { kind: "absent" };
  if (!reading.text.includes(STAMP_PREFIX)) return { kind: "refused", reason: "it is not a Collie skill file" };
  return sameText(reading.text, rendered) ? { kind: "installed" } : { kind: "stale" };
}

/** What an earlier build left in a row's old instruction file (#770). */
export type LegacyState =
  | { readonly kind: "none" }
  | { readonly kind: "block"; readonly path: string }
  | { readonly kind: "refused"; readonly path: string; readonly reason: string };

const NO_LEGACY: LegacyState = { kind: "none" };

/**
 * Does the row's old instruction file still carry our block? A file with no marker is none of our
 * business. Damaged or doubled markers, and a symlinked file, are refused: the cut would have to guess,
 * and the file is the operator's.
 */
export function legacyState(deps: SkillReadDeps, file: SkillFile): LegacyState {
  if (file.legacy === null) return NO_LEGACY;
  const text = deps.files.read(file.legacy);
  if (text === null) return NO_LEGACY;
  const found = findBlock(text);
  if (found.kind === "none") return NO_LEGACY;
  if (found.kind === "damaged") return { kind: "refused", path: file.legacy, reason: `${found.reason}, so the old block there was left alone` };
  const resolved = resolveFile(deps, file.legacy);
  if ("reason" in resolved) return { kind: "refused", path: file.legacy, reason: `${resolved.reason}, so the old block there was left alone` };
  return { kind: "block", path: resolved.path };
}

/** Cut the old block out of a legacy file. A file left blank is removed, as `uninstall` does. */
function cutLegacy(deps: Pick<SkillReadDeps, "files">, path: string): void {
  const text = deps.files.read(path);
  if (text === null) return;
  const next = removeBlock(text);
  if (next === text) return;
  if (next.trim() === "") deps.files.remove(path);
  else writeAtomic(deps, path, text, next);
}

export interface SkillReport {
  readonly file: SkillFile;
  readonly state: SkillState;
  readonly legacy: LegacyState;
}

/** Every target's verdict. The one reading `status`, `--check` and `doctor` all use. */
export function skillReport(deps: SkillReadDeps): SkillReport[] {
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  return skillFiles(deps.ctx).map((file) => ({ file, state: skillState(deps, file, rendered), legacy: legacyState(deps, file) }));
}

/**
 * Is any installed copy behind this build? Absent is the operator's choice and refused is `status`'s
 * business, so neither counts. An old block that a sync would cut counts: it is an installed copy in the
 * old place. The question `collie update` asks of the NEW binary.
 */
export function skillIsStale(deps: SkillReadDeps): boolean {
  return skillReport(deps).some((r) => r.state.kind === "stale" || r.legacy.kind === "block");
}

// ── Writing ──────────────────────────────────────────────────────────────────

const backupOf = (path: string): string => `${path}.collie-backup`;

/** Temp file plus rename, with the one-time backup. New files are 0644, an existing file keeps its mode. */
function writeAtomic(deps: Pick<SkillReadDeps, "files">, path: string, previous: string | null, text: string): void {
  if (previous !== null && !deps.files.exists(backupOf(path))) deps.files.write(backupOf(path), previous, 0o600);
  const temp = `${path}.collie-tmp`;
  try {
    deps.files.write(temp, text, deps.files.mode(path) ?? 0o644);
    deps.files.rename(temp, path);
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

/**
 * `existing` with our block cut out, and the blank line an install of 1.28.2 or before put before it,
 * which gives back the file as it was before that install. Every other byte stays.
 */
export function removeBlock(existing: string): string {
  const found = findBlock(existing);
  if (found.kind !== "span") return existing;
  let before = existing.slice(0, found.start);
  let after = existing.slice(found.end);
  if (after.startsWith("\n")) after = after.slice(1);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  return `${before}${after}`;
}

/** The harness folders `install all` leaves alone when the harness was never set up here. */
function configDirExists(deps: SkillReadDeps, file: SkillFile, path: string): boolean {
  return deps.files.entryType(file.target.home(path)) !== null;
}

/** The status line for a row's old block (#770), or null when there is none. */
function legacyNote(legacy: LegacyState): string | null {
  if (legacy.kind === "none") return null;
  if (legacy.kind === "refused") return `note: ${legacy.path}: ${legacy.reason}. Remove the WalkyTalky lines there by hand.`;
  return `note: ${legacy.path} still carries the old WalkyTalky block. \`collie skill sync\` cuts it out.`;
}

// ── The uninstall marker ─────────────────────────────────────────────────────
// `collie skill uninstall` is the operator saying no, and the next update must not say yes for them.
// The marker is the list of target paths they removed, as `skillFiles` spells them, one per line in
// one small file under this instance's state dir. `skill sync` skips a listed path; `skill install`
// takes it off.

/** `<stateDir>/skill/uninstalled` — one target path per line. */
export const uninstalledFile = (stateDir: string): string => join(stateDir, "skill", "uninstalled");

/** The paths the operator uninstalled. A missing or unreadable file is an empty list. */
export function readUninstalled(files: Files, stateDir: string): Set<string> {
  const text = files.read(uninstalledFile(stateDir)) ?? "";
  return new Set(text.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
}

/**
 * Did the operator uninstall this target? A path recorded before the row moved to the file form (#770)
 * still counts: an uninstall of the old block is a no for the new file too.
 */
function wasUninstalled(uninstalled: ReadonlySet<string>, file: SkillFile): boolean {
  return uninstalled.has(file.path) || (file.legacy !== null && uninstalled.has(file.legacy));
}

/** A target's paths as the uninstall marker spells them: the file, and the old block's file when the row moved. */
const markerPaths = (files: readonly SkillFile[]): string[] => files.flatMap((f) => (f.legacy === null ? [f.path] : [f.path, f.legacy]));

/** Add or take off paths. Writes only when the list changes; an empty list removes the file. */
function updateUninstalled(files: Files, stateDir: string, add: readonly string[], drop: readonly string[]): void {
  const before = readUninstalled(files, stateDir);
  const next = new Set(before);
  for (const p of add) next.add(p);
  for (const p of drop) next.delete(p);
  if (next.size === before.size && [...next].every((p) => before.has(p))) return;
  const path = uninstalledFile(stateDir);
  if (next.size === 0) {
    files.remove(path);
    return;
  }
  files.write(path, `${[...next].toSorted().join("\n")}\n`, 0o600);
}

// ── Sync ─────────────────────────────────────────────────────────────────────
// `collie skill sync` keeps every harness on this machine at this build's text, and `collie update`
// runs it through the new binary after each successful swap (ADR 0111). Per target:
//
//   installed                          nothing
//   stale                              rewritten in place
//   absent, harness folder exists      installed (the rule `install all` uses)
//   absent, no harness folder          skipped: the harness is not on this machine
//   uninstalled by the operator        skipped, whatever the file says
//   refused                            reported, nothing written
//
// Then, for a row that moved to the file form (#770), its old block: cut once the file is installed,
// and left where it is while the file is refused or failed, so an update never leaves a harness without
// WalkyTalky. A damaged or doubled marker pair there is reported and left alone. An absent file with an
// old block is installed even when `install all` would skip the harness: the operator had the skill.
//
// The result's shape and its printed lines live in `cli/skill-sync-result.ts`, which imports nothing:
// `collie update` reads them, and the update must not pull the embedded docs into its import graph.

/** What `sync` decided and did. `failed` is an unexpected I/O error: the verb exits 1 on it. */
export function syncSkills(deps: SkillReadDeps, dryRun: boolean): SyncResult & { failed: boolean } {
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  const uninstalled = readUninstalled(deps.files, deps.ctx.stateDir);
  const result: SyncResult & { failed: boolean } = { changed: [], refused: [], skipped: [], failed: false };
  for (const file of skillFiles(deps.ctx)) {
    const harness = file.target.harness;
    if (wasUninstalled(uninstalled, file)) {
      result.skipped.push({ harness, path: file.path, reason: "uninstalled" });
      continue;
    }
    const legacy = legacyState(deps, file);
    const state = skillState(deps, file, rendered);
    if (state.kind !== "installed" && !syncOne(deps, { file, state, legacy, rendered, dryRun }, result)) continue;
    syncLegacy(deps, harness, legacy, dryRun, result);
  }
  return result;
}

interface SyncStep {
  readonly file: SkillFile;
  readonly state: Exclude<SkillState, { kind: "installed" }>;
  readonly legacy: LegacyState;
  readonly rendered: string;
  readonly dryRun: boolean;
}

/** Bring one target that is not current up to this build. True when it is now (or, dry, would be) installed. */
function syncOne(deps: SkillReadDeps, step: SyncStep, result: SyncResult & { failed: boolean }): boolean {
  const { file, state } = step;
  const harness = file.target.harness;
  const reading = readFile(deps, file.path);
  if (state.kind === "refused") {
    result.refused.push({ harness, path: reading.path, reason: state.reason });
    return false;
  }
  if (state.kind === "absent" && step.legacy.kind !== "block" && !configDirExists(deps, file, reading.path)) {
    result.skipped.push({ harness, path: reading.path, reason: "not on this machine" });
    return false;
  }
  const action = state.kind === "stale" ? "updated" : "installed";
  const parent = dirname(reading.path);
  if (deps.files.entryType(parent) !== null && deps.files.writable(parent) === false) {
    result.refused.push({ harness, path: reading.path, reason: `${parent} cannot be written to` });
    return false;
  }
  if (!step.dryRun) {
    try {
      writeAtomic(deps, reading.path, reading.text, step.rendered);
    } catch (err) {
      result.refused.push({ harness, path: reading.path, reason: `could not write it: ${err instanceof Error ? err.message : String(err)}` });
      result.failed = true;
      return false;
    }
  }
  result.changed.push({ harness, path: reading.path, action });
  return true;
}

/** The old block of a row that moved (#770): cut, or named when it cannot be cut. Called once the file is current. */
function syncLegacy(deps: SkillReadDeps, harness: string, legacy: LegacyState, dryRun: boolean, result: SyncResult & { failed: boolean }): void {
  if (legacy.kind === "none") return;
  if (legacy.kind === "refused") {
    result.refused.push({ harness, path: legacy.path, reason: legacy.reason });
    return;
  }
  if (!dryRun) {
    try {
      cutLegacy(deps, legacy.path);
    } catch (err) {
      result.refused.push({ harness, path: legacy.path, reason: `could not cut the old block: ${err instanceof Error ? err.message : String(err)}` });
      result.failed = true;
      return;
    }
  }
  result.changed.push({ harness, path: legacy.path, action: "cut" });
}

/**
 * `collie skill sync [--json] [--dry-run]` — idempotent: a second run prints nothing. Exit 0 always,
 * a refusal included, except an unexpected I/O error (exit 1). `--json` prints the whole result.
 */
export function cmdSkillSync(deps: SkillDeps, args: readonly string[] = []): number {
  const dryRun = args.includes("--dry-run");
  let outcome: ReturnType<typeof syncSkills>;
  try {
    outcome = syncSkills(deps, dryRun);
  } catch (err) {
    deps.io.err(`error: skill sync stopped — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  const { failed, ...result } = outcome;
  if (args.includes("--json")) deps.io.out(JSON.stringify(result));
  else for (const line of syncLines(result, dryRun)) deps.io.out(line);
  return failed ? EXIT.FAIL : EXIT.OK;
}

// ── The verbs ────────────────────────────────────────────────────────────────

export const SKILL_SUBCOMMANDS = ["install", "uninstall", "sync", "status", "print"] as const;

export function skillUsage(): string {
  return `usage: collie skill [{${SKILL_SUBCOMMANDS.join("|")}}]`;
}

/** The harness arguments as rows, or null after a usage line. `all` is every row; `generic` is none. */
function chooseHarnesses(deps: SkillDeps, verb: string, args: readonly string[], allowGeneric: boolean): string[] | null {
  const name = args.find((a) => !a.startsWith("-"));
  const names = SKILL_TARGETS.map((t) => t.harness);
  if (name === "all") return names;
  if (name !== undefined && names.includes(name)) return [name];
  deps.io.err(`usage: collie skill ${verb} {${[...names, ...(allowGeneric ? ["generic"] : []), "all"].join("|")}}`);
  if (name === "generic" && !allowGeneric) {
    deps.io.err("  `generic` has no file. `collie skill print generic` prints the block for a hand paste.");
  } else if (name !== undefined) {
    deps.io.err(coveredHint(verb, name) ?? `  \`${name}\` is not a harness this build knows.`);
  }
  return null;
}

/** The line that sends a harness without a row of its own to the row that serves it, or null. */
function coveredHint(verb: string, name: string): string | null {
  const rows: readonly string[] | undefined = Object.entries(COVERED_BY).find(([covered]) => covered === name)?.[1];
  if (rows === undefined) return null;
  const commands = rows.map((row) => `\`collie skill ${verb} ${row}\``).join(" or ");
  return `  \`${name}\` reads the skill from the folder of ${rows.join(" or ")}, so it has no copy of its own: ${commands} covers it.`;
}

/** `collie skill install <harness|all>` */
export function cmdSkillInstall(deps: SkillDeps, args: readonly string[]): number {
  const harnesses = chooseHarnesses(deps, "install", args, false);
  if (harnesses === null) return EXIT.USAGE;
  const everything = args.includes("all");
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  let failed = false;
  let wrote = 0;
  // Asking for a harness by name, or for `all`, takes back an earlier uninstall: sync follows it again.
  try {
    updateUninstalled(deps.files, deps.ctx.stateDir, [], markerPaths(skillFiles(deps.ctx, harnesses)));
  } catch (err) {
    deps.io.err(`error: could not clear the uninstall marker — ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
  for (const file of skillFiles(deps.ctx, harnesses)) {
    const reading = readFile(deps, file.path);
    if (reading.refusal !== null) {
      deps.io.err(`error: ${file.target.harness}: ${reading.refusal} — refusing to write there.`);
      failed = true;
      continue;
    }
    const legacy = legacyState(deps, file);
    if (everything && reading.text === null && legacy.kind !== "block" && !configDirExists(deps, file, reading.path)) {
      deps.io.out(`- ${file.target.harness}: no ${file.target.home(reading.path)} here, skipped. \`collie skill install ${file.target.harness}\` creates it.`);
      continue;
    }
    if (reading.text !== null && !reading.text.includes(STAMP_PREFIX)) {
      deps.io.err(`error: ${reading.path} is not a Collie skill file — refusing to overwrite it.`);
      failed = true;
      continue;
    }
    const next = rendered;
    if (next === reading.text) {
      deps.io.out(`${reading.path} already has it — no bytes changed.`);
    } else {
      const parent = dirname(reading.path);
      if (deps.files.entryType(parent) !== null && deps.files.writable(parent) === false) {
        deps.io.err(`error: ${parent} cannot be written to — refusing to write there.`);
        failed = true;
        continue;
      }
      try {
        writeAtomic(deps, reading.path, reading.text, next);
      } catch (err) {
        deps.io.err(`error: could not write ${reading.path} — ${err instanceof Error ? err.message : String(err)}`);
        failed = true;
        continue;
      }
      deps.io.out(`✓ ${file.target.harness}: ${reading.path}`);
      wrote += 1;
    }
    // The file is in place, so the old block of a row that moved (#770) can go.
    if (!cutLegacyLoud(deps, file.target.harness, legacy)) failed = true;
  }
  if (failed) return EXIT.FAIL;
  if (wrote > 0) deps.io.out("  A running agent reads its instructions at start. Restart it to pick the skill up.");
  return EXIT.OK;
}

/**
 * Cut a row's old block (#770) and say so, or say why it stays. False on a refusal or an error, which
 * fails the verb: the operator has a line to act on.
 */
function cutLegacyLoud(deps: SkillDeps, harness: string, legacy: LegacyState): boolean {
  if (legacy.kind === "none") return true;
  if (legacy.kind === "refused") {
    deps.io.err(`error: ${harness}: ${legacy.path}: ${legacy.reason}. Remove the WalkyTalky lines there by hand.`);
    return false;
  }
  try {
    cutLegacy(deps, legacy.path);
  } catch (err) {
    deps.io.err(`error: could not cut the old WalkyTalky block from ${legacy.path} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  deps.io.out(`✓ ${harness}: cut the old WalkyTalky block from ${legacy.path}; every other line is untouched.`);
  return true;
}

/** `collie skill uninstall <harness|all>` — removes our file or our block and nothing else. */
export function cmdSkillUninstall(deps: SkillDeps, args: readonly string[]): number {
  const harnesses = chooseHarnesses(deps, "uninstall", args, false);
  if (harnesses === null) return EXIT.USAGE;
  let failed = false;
  let removed = 0;
  /** Every target that ends this run without the skill: sync must leave each one out from now on. */
  const without: string[] = [];
  for (const file of skillFiles(deps.ctx, harnesses)) {
    // The old block of a row that moved (#770) goes too, whatever the file says.
    const legacy = legacyState(deps, file);
    if (legacy.kind === "block") removed += 1;
    if (!cutLegacyLoud(deps, file.target.harness, legacy)) failed = true;
    const outcome = uninstallOne(deps, file);
    if (outcome === "failed") failed = true;
    if (outcome === "removed") removed += 1;
    if (outcome !== "failed" && outcome !== "foreign") without.push(file.path);
  }
  try {
    updateUninstalled(deps.files, deps.ctx.stateDir, without, []);
  } catch (err) {
    deps.io.err(`error: could not record the uninstall — ${err instanceof Error ? err.message : String(err)}. The next update may put the skill back.`);
    return EXIT.FAIL;
  }
  if (failed) return EXIT.FAIL;
  if (removed === 0) deps.io.out("nothing to remove: no instruction file here carries the WalkyTalky skill.");
  if (without.length > 0) {
    deps.io.out("  `collie update` and `collie skill sync` leave it out from now on. `collie skill install <harness>` brings it back.");
  }
  return EXIT.OK;
}

/** Remove one target's own file. `foreign`: a file at our path that is not ours, left alone and not marked. */
function uninstallOne(deps: SkillDeps, file: SkillFile): "removed" | "none" | "foreign" | "failed" {
  const reading = readFile(deps, file.path);
  if (reading.refusal !== null) {
    deps.io.err(`error: ${file.target.harness}: ${reading.refusal} — refusing to touch it.`);
    return "failed";
  }
  if (reading.text === null) return "none";
  // Not ours, so not removed, and not marked: sync would refuse that file anyway.
  if (!reading.text.includes(STAMP_PREFIX)) return "foreign";
  try {
    deps.files.remove(reading.path);
    const folder = dirname(reading.path);
    if (deps.files.list(folder).length === 0) deps.files.removeTree(folder);
  } catch (err) {
    deps.io.err(`error: could not change ${reading.path} — ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  deps.io.out(`✓ ${file.target.harness}: removed the WalkyTalky skill from ${reading.path}; every other line is untouched.`);
  return "removed";
}

const STATE_WORDS = {
  installed: "installed",
  stale: "stale — run `collie skill sync` to bring it up to this build",
  absent: "absent",
  refused: "refused",
} satisfies Record<SkillState["kind"], string>;

/**
 * `collie skill status` — read-only. `--check` prints nothing and answers with the exit code:
 * `EXIT.STATE` when any installed copy is stale, `EXIT.OK` otherwise.
 */
export function cmdSkillStatus(deps: SkillDeps, args: readonly string[] = []): number {
  if (args.includes("--check")) return skillIsStale(deps) ? EXIT.STATE : EXIT.OK;
  const uninstalled = readUninstalled(deps.files, deps.ctx.stateDir);
  for (const { file, state, legacy } of skillReport(deps)) {
    const word =
      state.kind === "refused"
        ? `refused — ${state.reason}`
        : state.kind === "absent" && wasUninstalled(uninstalled, file)
          ? "absent — you uninstalled it, so sync leaves it out"
          : STATE_WORDS[state.kind];
    deps.io.out(`${file.target.harness.padEnd(9)} ${file.path}: ${word}`);
    const note = legacyNote(legacy);
    if (note !== null) deps.io.out(`          ${note}`);
  }
  deps.io.out("generic   no file: `collie skill print generic` prints the block for a hand paste");
  return EXIT.OK;
}

/** `collie skill print <harness|all>` — the text an install would write, to stdout. */
export function cmdSkillPrint(deps: SkillDeps, args: readonly string[]): number {
  const name = args.find((a) => !a.startsWith("-"));
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  const emit = (text: string): void => {
    for (const line of text.replace(/\n+$/u, "").split("\n")) deps.io.out(line);
  };
  if (name === "all") {
    for (const file of skillFiles(deps.ctx)) {
      deps.io.out(`<!-- collie skill: ${file.target.harness} → ${file.path} -->`);
      emit(rendered);
    }
    return EXIT.OK;
  }
  if (name === "generic" || name === "walky-talky") {
    emit(blockOf(rendered));
    return EXIT.OK;
  }
  const file = name === undefined ? undefined : skillFiles(deps.ctx, [name])[0];
  if (file === undefined) {
    deps.io.err(`usage: collie skill print {${[...SKILL_HARNESSES, "all"].join("|")}}`);
    if (name !== undefined) deps.io.err(coveredHint("print", name) ?? `  \`${name}\` is not a harness this build knows.`);
    return EXIT.USAGE;
  }
  emit(rendered);
  return EXIT.OK;
}

/** The five sub-verbs. A bare `collie skill` is not here: it prints the general brief (`cli/docs.ts`). */
export function cmdSkillVerb(deps: SkillDeps, sub: string, rest: readonly string[]): number {
  switch (sub) {
    case "install":
      return cmdSkillInstall(deps, rest);
    case "uninstall":
      return cmdSkillUninstall(deps, rest);
    case "sync":
      return cmdSkillSync(deps, rest);
    case "status":
      return cmdSkillStatus(deps, rest);
    case "print":
      return cmdSkillPrint(deps, rest);
    default:
      deps.io.err(`error: unknown skill subcommand \`${sub}\``);
      deps.io.err(skillUsage());
      deps.io.err("  (no argument)  print the general brief on Collie");
      deps.io.err("  install        write the WalkyTalky skill: `skill install <harness|all>`");
      deps.io.err("  uninstall      remove only the file or block Collie wrote");
      deps.io.err("  sync           bring every harness on this machine up to this build's skill (--json, --dry-run)");
      deps.io.err("  status         what each target carries now, and whether it is behind (--check for the exit code)");
      deps.io.err("  print          the text an install writes: `skill print <harness|all|generic>`");
      return EXIT.USAGE;
  }
}

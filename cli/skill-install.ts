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
// agents' own instruction files, and telling when this build's text has moved on from what is there.
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
// Two forms, by who owns the file:
//
//  - `file`: Claude Code reads a skill from its own folder, so Collie owns the whole file
//    `<config dir>/skills/collie-walky-talky/SKILL.md`. It is replaced as a whole. A file at that path
//    that does not carry our stamp is somebody else's and is refused.
//  - `block`: every other harness reads one global instruction file that is the operator's. Collie owns
//    only the text between {@link BLOCK_BEGIN} and {@link BLOCK_END}. The block is replaced in place,
//    the file is created when it is absent, and every other byte stays where it was.
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

/** The managed block for a rendered skill: markers around the body, no trailing newline. */
export function blockOf(rendered: string): string {
  return `${BLOCK_BEGIN}\n${withoutFrontMatter(withLf(rendered)).replace(/\n+$/u, "")}\n${BLOCK_END}`;
}

/** Text with the stamp's collie version blanked, so two builds of one text compare equal. */
function withoutStampVersion(text: string): string {
  return text.replace(STAMP_VERSION, "$1-$2");
}

/** Line ends do not make a skill stale: an editor on Windows may save the file with CRLF. */
const withLf = (text: string): string => text.replaceAll("\r\n", "\n");

const sameText = (a: string, b: string): boolean => withoutStampVersion(withLf(a)) === withoutStampVersion(withLf(b));

// ── The targets ──────────────────────────────────────────────────────────────

export type SkillForm = "file" | "block";

export interface SkillTarget {
  readonly harness: string;
  readonly form: SkillForm;
  /** Every path this harness reads, in the order they print. Claude has one per config profile. */
  readonly paths: (ctx: Pick<CliContext, "home" | "env">) => string[];
  /** The harness's own config folder for a path of this row. `install all` skips a harness whose folder is not there. */
  readonly home: (path: string) => string;
  /** A file next to the target that makes the harness ignore it, when there is one. */
  readonly override?: string;
}

/**
 * Where each harness reads a global instruction from. Every row was read against the vendor's own
 * documentation on 2026-10-17; the page that says it is on the line above the row.
 *
 * `generic` is not in the table on purpose: it has no file. `collie skill print generic` prints the
 * block for a hand paste.
 */
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

export const SKILL_TARGETS: readonly SkillTarget[] = [
  {
    // https://code.claude.com/docs/en/skills (2026-10-17): "Personal skills: ~/.claude/skills/<skill-name>/SKILL.md".
    // A `CLAUDE_CONFIG_DIR` profile replaces `~/.claude`, so every profile the hooks installer knows
    // (`claudeSettingsTargets`) gets the same folder, and so does the profile `CLAUDE_CONFIG_DIR`
    // itself names in the install's own environment (a profile set only that way, M62 live rig).
    harness: "claude",
    form: "file",
    home: (path) => dirname(dirname(dirname(path))),
    paths: (ctx) => claudeProfileDirs(ctx).map((dir) => join(dir, "skills", SKILL_NAME, "SKILL.md")),
  },
  {
    // https://learn.chatgpt.com/docs/agent-configuration/agents-md (2026-10-17; developers.openai.com redirects
    // there): the global file is `AGENTS.md` in the Codex home, "~/.codex unless you set CODEX_HOME".
    // `AGENTS.override.md` in the same folder is read INSTEAD of it.
    harness: "codex",
    form: "block",
    home: dirname,
    paths: (ctx) => [join(codexHome(ctx), "AGENTS.md")],
    override: "AGENTS.override.md",
  },
  {
    // https://opencode.ai/docs/rules/ (2026-10-17): "global rules in a ~/.config/opencode/AGENTS.md file".
    // The page names no variable that moves it.
    harness: "opencode",
    form: "block",
    home: dirname,
    paths: (ctx) => [join(ctx.home, ".config", "opencode", "AGENTS.md")],
  },
  {
    // https://pi.dev/docs/latest/configuration (2026-10-17): the agent dir is `~/.pi/agent`, moved by
    // PI_CODING_AGENT_DIR; its `AGENTS.md` is the global context file, and `AGENTS.override.md` there wins.
    harness: "pi",
    form: "block",
    home: dirname,
    paths: (ctx) => {
      const set = (ctx.env.PI_CODING_AGENT_DIR ?? "").trim();
      return [join(set === "" ? join(ctx.home, ".pi", "agent") : set, "AGENTS.md")];
    },
    override: "AGENTS.override.md",
  },
  {
    // https://geminicli.com/docs/cli/gemini-md/ (2026-10-17): "~/.gemini/GEMINI.md" in the user's home.
    // `context.fileName` in settings.json can rename the file; the folder cannot be moved.
    harness: "gemini",
    form: "block",
    home: dirname,
    paths: (ctx) => [join(ctx.home, ".gemini", "GEMINI.md")],
  },
];

/** Harness names the verbs accept. `generic` only prints. */
export const SKILL_HARNESSES: readonly string[] = [...SKILL_TARGETS.map((t) => t.harness), "generic"];

/** One concrete file, with the row it came from. */
export interface SkillFile {
  readonly target: SkillTarget;
  readonly path: string;
}

export function skillFiles(ctx: Pick<CliContext, "home" | "env">, harnesses?: readonly string[]): SkillFile[] {
  return SKILL_TARGETS.filter((t) => harnesses === undefined || harnesses.includes(t.harness)).flatMap((target) =>
    target.paths(ctx).map((path) => ({ target, path })),
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
    return { kind: "damaged", reason: "its walky talky markers are not one begin and one end" };
  }
  if (end.index < begin.index) return { kind: "damaged", reason: "its walky talky end marker comes before the begin marker" };
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
  if (file.target.form === "file") {
    if (!reading.text.includes(STAMP_PREFIX)) return { kind: "refused", reason: "it is not a Collie skill file" };
    return sameText(reading.text, rendered) ? { kind: "installed" } : { kind: "stale" };
  }
  const found = findBlock(reading.text);
  if (found.kind === "damaged") return { kind: "refused", reason: found.reason };
  if (found.kind === "none") return { kind: "absent" };
  return sameText(reading.text.slice(found.start, found.end), blockOf(rendered)) ? { kind: "installed" } : { kind: "stale" };
}

export interface SkillReport {
  readonly file: SkillFile;
  readonly state: SkillState;
}

/** Every target's verdict. The one reading `status`, `--check` and `doctor` all use. */
export function skillReport(deps: SkillReadDeps): SkillReport[] {
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  return skillFiles(deps.ctx).map((file) => ({ file, state: skillState(deps, file, rendered) }));
}

/**
 * Is any installed copy behind this build? Absent is the operator's choice and refused is `status`'s
 * business, so neither counts. The question `collie update` asks of the NEW binary.
 */
export function skillIsStale(deps: SkillReadDeps): boolean {
  return skillReport(deps).some((r) => r.state.kind === "stale");
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

/** `existing` with our block in, replacing the old one in place. A string result is a refusal. */
export function insertBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === "") return `${block}\n`;
  const found = findBlock(existing);
  if (found.kind === "damaged") throw new Error(found.reason);
  if (found.kind === "span") return `${existing.slice(0, found.start)}${block}${existing.slice(found.end)}`;
  const lead = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${lead}\n${block}\n`;
}

/** `existing` with our block cut out, and the blank line install put before it. */
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

function overrideNote(deps: SkillReadDeps, file: SkillFile, path: string): string | null {
  const name = file.target.override;
  if (name === undefined) return null;
  const other = join(dirname(path), name);
  const text = deps.files.read(other);
  if (text === null || text.trim() === "") return null;
  return `note: ${other} exists, and ${file.target.harness} reads it instead of ${path}. Add the skill there by hand.`;
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
// The result's shape and its printed lines live in `cli/skill-sync-result.ts`, which imports nothing:
// `collie update` reads them, and the update must not pull the embedded docs into its import graph.

/** What `sync` decided and did. `failed` is an unexpected I/O error: the verb exits 1 on it. */
export function syncSkills(deps: SkillReadDeps, dryRun: boolean): SyncResult & { failed: boolean } {
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  const block = blockOf(rendered);
  const uninstalled = readUninstalled(deps.files, deps.ctx.stateDir);
  const result: SyncResult & { failed: boolean } = { changed: [], refused: [], skipped: [], failed: false };
  for (const file of skillFiles(deps.ctx)) {
    const harness = file.target.harness;
    if (uninstalled.has(file.path)) {
      result.skipped.push({ harness, path: file.path, reason: "uninstalled" });
      continue;
    }
    const state = skillState(deps, file, rendered);
    if (state.kind === "installed") continue;
    const reading = readFile(deps, file.path);
    if (state.kind === "refused") {
      result.refused.push({ harness, path: reading.path, reason: state.reason });
      continue;
    }
    if (state.kind === "absent" && !configDirExists(deps, file, reading.path)) {
      result.skipped.push({ harness, path: reading.path, reason: "not on this machine" });
      continue;
    }
    const action = state.kind === "stale" ? "updated" : "installed";
    const parent = dirname(reading.path);
    if (deps.files.entryType(parent) !== null && deps.files.writable(parent) === false) {
      result.refused.push({ harness, path: reading.path, reason: `${parent} cannot be written to` });
      continue;
    }
    if (!dryRun) {
      try {
        const next = file.target.form === "file" ? rendered : insertBlock(reading.text, block);
        writeAtomic(deps, reading.path, reading.text, next);
      } catch (err) {
        result.refused.push({ harness, path: reading.path, reason: `could not write it: ${err instanceof Error ? err.message : String(err)}` });
        result.failed = true;
        continue;
      }
    }
    result.changed.push({ harness, path: reading.path, action });
  }
  return result;
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
    deps.io.err(`  \`${name}\` is not a harness this build knows.`);
  }
  return null;
}

/** `collie skill install <harness|all>` */
export function cmdSkillInstall(deps: SkillDeps, args: readonly string[]): number {
  const harnesses = chooseHarnesses(deps, "install", args, false);
  if (harnesses === null) return EXIT.USAGE;
  const everything = args.includes("all");
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  const block = blockOf(rendered);
  let failed = false;
  let wrote = 0;
  // Asking for a harness by name, or for `all`, takes back an earlier uninstall: sync follows it again.
  try {
    updateUninstalled(deps.files, deps.ctx.stateDir, [], skillFiles(deps.ctx, harnesses).map((f) => f.path));
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
    if (everything && reading.text === null && !configDirExists(deps, file, reading.path)) {
      deps.io.out(`- ${file.target.harness}: no ${file.target.home(reading.path)} here, skipped. \`collie skill install ${file.target.harness}\` creates it.`);
      continue;
    }
    let next: string;
    if (file.target.form === "file") {
      if (reading.text !== null && !reading.text.includes(STAMP_PREFIX)) {
        deps.io.err(`error: ${reading.path} is not a Collie skill file — refusing to overwrite it.`);
        failed = true;
        continue;
      }
      next = rendered;
    } else {
      try {
        next = insertBlock(reading.text, block);
      } catch (err) {
        deps.io.err(`error: ${reading.path}: ${err instanceof Error ? err.message : String(err)} — leaving it alone.`);
        failed = true;
        continue;
      }
    }
    const note = overrideNote(deps, file, reading.path);
    if (next === reading.text) {
      deps.io.out(`${reading.path} already has it — no bytes changed.`);
      if (note !== null) deps.io.out(`  ${note}`);
      continue;
    }
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
    if (note !== null) deps.io.out(`  ${note}`);
    wrote += 1;
  }
  if (failed) return EXIT.FAIL;
  if (wrote > 0) deps.io.out("  A running agent reads its instructions at start. Restart it to pick the skill up.");
  return EXIT.OK;
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
    const reading = readFile(deps, file.path);
    if (reading.refusal !== null) {
      deps.io.err(`error: ${file.target.harness}: ${reading.refusal} — refusing to touch it.`);
      failed = true;
      continue;
    }
    if (reading.text === null) {
      without.push(file.path);
      continue;
    }
    try {
      if (file.target.form === "file") {
        // Not ours, so not removed, and not marked: sync would refuse that file anyway.
        if (!reading.text.includes(STAMP_PREFIX)) continue;
        deps.files.remove(reading.path);
        const folder = dirname(reading.path);
        if (deps.files.list(folder).length === 0) deps.files.removeTree(folder);
      } else {
        const found = findBlock(reading.text);
        if (found.kind === "damaged") {
          deps.io.err(`error: ${reading.path}: ${found.reason} — leaving it alone.`);
          failed = true;
          continue;
        }
        if (found.kind === "none") {
          without.push(file.path);
          continue;
        }
        const next = removeBlock(reading.text);
        if (next.trim() === "") deps.files.remove(reading.path);
        else writeAtomic(deps, reading.path, reading.text, next);
      }
    } catch (err) {
      deps.io.err(`error: could not change ${reading.path} — ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
      continue;
    }
    deps.io.out(`✓ ${file.target.harness}: removed the walky talky skill from ${reading.path}; every other line is untouched.`);
    without.push(file.path);
    removed += 1;
  }
  try {
    updateUninstalled(deps.files, deps.ctx.stateDir, without, []);
  } catch (err) {
    deps.io.err(`error: could not record the uninstall — ${err instanceof Error ? err.message : String(err)}. The next update may put the skill back.`);
    return EXIT.FAIL;
  }
  if (failed) return EXIT.FAIL;
  if (removed === 0) deps.io.out("nothing to remove: no instruction file here carries the walky talky skill.");
  if (without.length > 0) {
    deps.io.out("  `collie update` and `collie skill sync` leave it out from now on. `collie skill install <harness>` brings it back.");
  }
  return EXIT.OK;
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
  for (const { file, state } of skillReport(deps)) {
    const word =
      state.kind === "refused"
        ? `refused — ${state.reason}`
        : state.kind === "absent" && uninstalled.has(file.path)
          ? "absent — you uninstalled it, so sync leaves it out"
          : STATE_WORDS[state.kind];
    deps.io.out(`${file.target.harness.padEnd(9)} ${file.path}: ${word}`);
    const note = overrideNote(deps, file, file.path);
    if (note !== null) deps.io.out(`          ${note}`);
  }
  deps.io.out("generic   no file: `collie skill print generic` prints the block for a hand paste");
  return EXIT.OK;
}

/** `collie skill print <harness|all>` — the text an install would write, to stdout. */
export function cmdSkillPrint(deps: SkillDeps, args: readonly string[]): number {
  const name = args.find((a) => !a.startsWith("-"));
  const rendered = renderWalkySkill(deps.ctx, deps.fs);
  const body = (file: SkillFile | null): string => (file?.target.form === "file" ? rendered : blockOf(rendered));
  const emit = (text: string): void => {
    for (const line of text.replace(/\n+$/u, "").split("\n")) deps.io.out(line);
  };
  if (name === "all") {
    for (const file of skillFiles(deps.ctx)) {
      deps.io.out(`<!-- collie skill: ${file.target.harness} → ${file.path} -->`);
      emit(body(file));
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
    if (name !== undefined) deps.io.err(`  \`${name}\` is not a harness this build knows.`);
    return EXIT.USAGE;
  }
  emit(body(file));
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
      deps.io.err("  install        write the walky talky skill: `skill install <harness|all>`");
      deps.io.err("  uninstall      remove only the file or block Collie wrote");
      deps.io.err("  sync           bring every harness on this machine up to this build's skill (--json, --dry-run)");
      deps.io.err("  status         what each target carries now, and whether it is behind (--check for the exit code)");
      deps.io.err("  print          the text an install writes: `skill print <harness|all|generic>`");
      return EXIT.USAGE;
  }
}

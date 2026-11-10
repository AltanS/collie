import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { basename, join } from "node:path";

import { trickHelperSource } from "../../cli/trick-kit/source.ts" with { type: "macro" };
import { TRICK_WARNINGS_MAX, type TrickManifest, type TrickWarningKind, type WireTrickWarning } from "../../web/src/lib/tricks/schema.ts";
import { diskTrickFs, walkTrickCode, type CodeEntry, type TrickFs } from "./code-hash.ts";
import { MANIFEST_FILE } from "./paths.ts";
import { runtimeScript } from "./run.ts";

// THE CHECK SCAN (M94): what a grep of a trick's code flags, for `collie trick check` and for the moment of
// consent. `collie trick on` prints these warnings above its confirmation, and the bridge puts a short form
// of them on the row of a trick that is off or changed, so Settings → Tricks shows them before the switch.
// A warning never refuses anything: the switch stays one tap, and `check` still passes.
//
// It is a grep, honest but not a proof: a program can build a command out of pieces no pattern sees, and
// a trick runs with the full rights of the user. Every surface that shows a warning says so.
//
// Moved here from cli/trick.ts (review 15) unchanged, so the CLI and the bridge read one scan.

/** What a warning is about. */
export type CheckWarningKind = TrickWarningKind;

/** One line a grep flags. A warning, never a refusal: `check` still passes. */
export interface CheckWarning {
  kind: CheckWarningKind;
  file: string;
  line: number;
  text: string;
}

/** One command-looking line of the program's source. */
export interface RunsLine {
  file: string;
  line: number;
  text: string;
}

/** The programs a "runs:" line names. */
const TOOL_WORDS = "curl|wget|gh|git|darius|collie|bunx?|node|npx|npm|pnpm|yarn|deno|python3?|pip3?|ruby|perl|ssh|scp|rsync|rm|mv|cp|chmod|chown|sudo|doas|docker|podman|systemctl|kill|pkill|eval|exec|nc|tailscale|herdr|tmux|zellij|make|jq";
/**
 * A line that runs or reaches something: a tool a program would call, a subshell, a spawn, a fetch.
 * In a shell file every word is in command position, so a tool's name is enough. In a code file a tool
 * runs only from a string (`t.sh("git", ...)`, `Bun.spawn(["gh", ...])`), so the name must be a whole
 * string literal, never a word inside an identifier, a comment or a sentence ("node" in `v.node`).
 * A grep, honest but not a proof: a program can build a command out of pieces no pattern sees.
 */
const SHELL_COMMAND_LINE = new RegExp(`\\b(?:${TOOL_WORDS})\\b|\\$\\(|\`|Bun\\.spawn|Bun\\.\\$|child_process|\\bspawn(?:Sync)?\\(|\\bexec(?:Sync|File)?\\(|\\bfetch\\(`);
const CODE_COMMAND_LINE = new RegExp(`(["'\`])(?:${TOOL_WORDS})\\1|\\.sh\\s*\\(|\\bBun\\.spawn|\\bBun\\.\\$|child_process|\\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork|exec)\\s*\\(|\\bfetch\\s*\\(`);
/** The most "runs:" lines printed. */
export const RUNS_MAX = 40;
/** The most warnings kept. */
export const WARNINGS_MAX = 60;
const RUNS_TEXT_MAX = 160;
/** The bytes of a source file read for the grep and the binary test. */
export const SOURCE_READ_MAX = 256 * 1024;

/** The agent programs and model APIs a timer should never call. */
const AGENT_NAMES = "claude|codex|pi|opencode|omp";
/**
 * What each warning looks for in a code file. A shell file adds its own forms below. `t.sh(` is the
 * helper's spawn. A tool that reaches the network is named as a whole string literal (`t.sh("gh", ...)`),
 * never as a word in a sentence.
 */
const WARN_PATTERNS = {
  spawn: /\.sh\s*\(|\bBun\.spawn(?:Sync)?\b|\bBun\.\$|child_process|\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(|\bexec\s*\(|\bsubprocess\b|\bos\.system\b/,
  network: /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bnet\.connect\b|\bhttps?\.(?:request|get)\s*\(|\brequests\.(?:get|post|put|delete)\b|\burllib\b|(["'`])(?:gh|curl|wget|ssh)\1/,
  write: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync)\s*\(|\bBun\.write\s*\((?!\s*Bun\.std(?:out|err)\b)/,
  model: new RegExp(`\\b(?:anthropic|openai|openrouter)\\b|\\[\\s*["'\`](?:${AGENT_NAMES})["'\`]|\\b(?:which|findTool|tool|Bun\\.which)\\s*\\(\\s*["'\`](?:${AGENT_NAMES})["'\`]`, "i"),
} satisfies Record<Exclude<CheckWarningKind, "import">, RegExp>;
/** In a shell file: a subshell, a tool that reaches the network by its bare name, a redirect into a file, and an agent program in command position. */
const SHELL_SPAWN = /\$\(/;
const SHELL_NETWORK = /\bcurl\b|\bwget\b|\bssh\b|\bgh\s+(?:api|pr|issue|run|repo|release|search)\b/;
const SHELL_WRITE = /(?:^|[^<>&0-9=-])>>?\s*(?!&|\/dev\/null)[^\s>&|;)]/;
const SHELL_MODEL = new RegExp(`(?:^|[;&|(]|\\$\\(|\\bexec\\s+|\\bcommand\\s+-v\\s+)\\s*(?:${AGENT_NAMES})(?=\\s|$|\\))`);
/** A write that names the state folder (or the trick's own media folder) is the trick's own business. */
const OWN_PLACES = /state|STATE|media|\/dev\/null/;

/** The words `collie trick check` and `collie trick on` print after each warning's place. */
export const WARN_TEXT = {
  spawn: "starts a process",
  network: "reaches the network",
  write: "writes a file outside the trick's state folder, as far as a grep can tell",
  model: "calls an agent program or a model API; a timer run should only read; a timer that calls a model spends your subscription with no session to show for it",
  import: "imports a package; a script Collie's runtime runs gets no install, so it may import only files in its own folder and node: or bun: built-ins",
} satisfies Record<CheckWarningKind, string>;

/**
 * One sentence per kind, for a person at the switch: the row of a trick that is off or changed carries
 * these (English; the phone has its own words for the kinds it knows, and shows these for any other).
 */
export const WARN_PLAIN = {
  spawn: "This trick starts other programs on this machine.",
  network: "This trick reaches the network.",
  write: "This trick writes files outside its own state folder.",
  model: "On a timer this trick starts an agent or calls a model. Each run can use your subscription.",
  import: "This trick imports a package Collie does not install, so it may not run.",
} satisfies Record<CheckWarningKind, string>;

/** The order the kinds are listed in, on the row and in the summary. */
const KIND_ORDER: readonly CheckWarningKind[] = ["model", "network", "spawn", "write", "import"];

/** The line printed beside every list of warnings: what they are and are not. */
export const WARNINGS_HONESTY = "These come from a text search of the code, not a proof: a program can do any of this in a way no pattern sees, and a trick runs with your full rights.";

/** The import specifiers of one source line: `import ... from "x"`, `export ... from "x"`, `import("x")`, `require("x")`. */
const IMPORT_SPECIFIERS = /(?:^|[\s;])(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
/** The file names a runtime-run trick's sources are read for imports by. */
const SCRIPT_FILE = /\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx)$/;
/** The names a script may import bare: Bun's own module and Node's built-ins. */
const BARE_BUILTINS: ReadonlySet<string> = new Set(["bun", ...builtinModules]);

/** Whether an import specifier needs an install: not relative, not absolute, not `node:` or `bun:`, not a built-in. */
export function isBareImport(specifier: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return false;
  return !BARE_BUILTINS.has(specifier);
}

/**
 * The warnings for a trick Collie's own runtime runs: every line of a script file that imports a
 * package by a bare name. A grep, as the others are: an import built at run time is not seen.
 */
export function importWarnings(sources: readonly { file: string; text: string }[]): CheckWarning[] {
  const out: CheckWarning[] = [];
  for (const { file, text } of sources) {
    if (!SCRIPT_FILE.test(file)) continue;
    text
      .slice(0, SOURCE_READ_MAX)
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const t = raw.trim();
        // A type import is erased before the script runs: it needs no install.
        if (isCommentLine(t) || /^(?:import|export)\s+type\s/u.test(t)) return;
        const bare = [...t.matchAll(IMPORT_SPECIFIERS)].some((m) => isBareImport(m[1] ?? m[2] ?? "./"));
        if (bare) out.push({ kind: "import", file, line: i + 1, text: shortLine(t) });
      });
  }
  return out;
}

/** Whether a file's head looks like a compiled program rather than source. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000") || /^(?:\u007fELF|MZ|Ïúíþ|Êþº¾)/.test(text);
}

function shortLine(t: string): string {
  return t.length > RUNS_TEXT_MAX ? `${t.slice(0, RUNS_TEXT_MAX - 1)}…` : t;
}

function isCommentLine(t: string): boolean {
  return t === "" || t.startsWith("#") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

/** A code line without its trailing `// comment` (a `//` after a space, so an `https://` stays). */
function codePart(t: string): string {
  return t.replace(/\s\/\/.*$/u, "");
}

/** The command-looking lines of the program's code files. */
export function runsLines(sources: readonly { file: string; text: string; shell?: boolean }[]): RunsLine[] {
  const out: RunsLine[] = [];
  for (const { file, text, shell: asShell } of sources) {
    const shell = asShell ?? isShell(file, text);
    const lines = text.slice(0, SOURCE_READ_MAX).split(/\r?\n/);
    lines.forEach((raw, i) => {
      const t = raw.trim();
      if (isCommentLine(t)) return;
      if (!(shell ? SHELL_COMMAND_LINE.test(t) : CODE_COMMAND_LINE.test(codePart(t)))) return;
      out.push({ file, line: i + 1, text: shortLine(t) });
    });
  }
  return out;
}

/**
 * Whether a file is code the grep reads: not a doc, data or a test. README.md, SKILL.md, AGENTS.md and
 * every `*.md`, `*.toml`, `*.json` and `*.txt`, a `test.sh`, a `*.test.*` file and anything under a
 * `fixtures/` folder are skipped. They still count in the code hash.
 */
export function isScannedFile(rel: string): boolean {
  const name = basename(rel);
  if (/\.(?:md|toml|json|txt)$/iu.test(name) || name === "test.sh" || /\.test\./u.test(name)) return false;
  return !rel.split("/").includes("fixtures");
}

/** Whether a source file is a shell script: by its name, or by its first line. */
function isShell(file: string, text: string): boolean {
  if (/\.(?:sh|bash|zsh)$/.test(file)) return true;
  return !/\.[a-z0-9]+$/i.test(file) && /^#!.*\b(?:sh|bash|zsh|dash)\b/.test(text);
}

/**
 * The warnings a grep of the sources gives. `timer` is whether the trick has `every`: only then is an
 * agent program or a model API a warning. A grep, not a proof.
 */
export function checkWarnings(sources: readonly { file: string; text: string; shell?: boolean }[], timer: boolean): CheckWarning[] {
  const out: CheckWarning[] = [];
  for (const { file, text, shell: asShell } of sources) {
    const shell = asShell ?? isShell(file, text);
    text
      .slice(0, SOURCE_READ_MAX)
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const t = raw.trim();
        if (isCommentLine(t)) return;
        const code = shell ? t : codePart(t);
        const hit = (kind: CheckWarningKind) => out.push({ kind, file, line: i + 1, text: shortLine(t) });
        if (WARN_PATTERNS.spawn.test(code) || (shell && SHELL_SPAWN.test(t))) hit("spawn");
        if (WARN_PATTERNS.network.test(code) || (shell && SHELL_NETWORK.test(t))) hit("network");
        if ((WARN_PATTERNS.write.test(code) || (shell && SHELL_WRITE.test(t))) && !OWN_PLACES.test(code)) hit("write");
        if (timer && (WARN_PATTERNS.model.test(code) || (shell && SHELL_MODEL.test(t)))) hit("model");
      });
  }
  return out;
}

// ── the helper this Collie ships ─────────────────────────────────────────────

/** The helper file a TypeScript trick imports. */
export const HELPER_FILE = "trick.ts";
/** The version of the helper this Collie writes. Its first line names it: `// collie trick helper v3`. */
export const HELPER_VERSION = 3;
/** The helper's source (cli/trick-kit/trick.ts), held in the binary as text. */
export const TRICK_HELPER: string = trickHelperSource();

/** The version a helper file names on its first line, or null when it names none. */
export function helperVersion(text: string): number | null {
  const match = /^\/\/ collie trick helper v(\d+)\r?\n/u.exec(text);
  return match === null ? null : Number(match[1]);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/**
 * The older helpers this Collie shipped, by the SHA-256 of their text: v1 (1.29.0-edge, M94 review 4) and
 * v2 (the facts' `v`, `t.hillAnswer` beside `t.tap`; M94 review 11 made it v3).
 */
const OLDER_HELPERS: ReadonlyMap<string, number> = new Map([
  ["534f992f9aa2a4a6e53945c1b46e7b407ab9528b3839970e6552d83b23ed13bb", 1],
  ["ec9ce0acd1c1691f61bb63a0f9f136578c9bf9250c7aa66d3d1186ee030b98a9", 2],
]);

/** The version of a helper this Collie ships (this one, or one of `older`) whose bytes `text` are, or null for any other text. */
export function shippedHelperVersion(text: string, older: ReadonlyMap<string, number> = OLDER_HELPERS): number | null {
  const hash = sha256(text);
  return hash === sha256(TRICK_HELPER) ? HELPER_VERSION : (older.get(hash) ?? null);
}

// ── one folder ───────────────────────────────────────────────────────────────

/** The sources of every code file in the folder (the walk the code hash takes), text files only. */
export async function folderSources(folder: string, entries: readonly CodeEntry[], fs: TrickFs = diskTrickFs): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const bytes = await fs.read(join(folder, entry.rel), SOURCE_READ_MAX);
    if (bytes === null) continue;
    const text = new TextDecoder().decode(bytes);
    if (looksBinary(text)) continue;
    out.push({ file: entry.rel, text });
  }
  return out;
}

/** What the scan of one folder found. */
export interface FolderScan {
  /** The files the grep read: code, not docs, data, tests or a shipped helper. */
  sources: { file: string; text: string }[];
  /** The files the grep skips: docs, data, tests and fixtures, and a `trick.ts` that is a helper this Collie ships. */
  notScanned: string[];
  /** What `trick.ts` is, when it names itself a helper. */
  helper?: { version: number; current: boolean; modified: boolean };
  /** What the grep flags, capped at {@link WARNINGS_MAX}. */
  warnings: CheckWarning[];
}

/**
 * The scan of a trick folder whose code walk is `entries`: the sources, the helper, the warnings. The
 * run line itself is graded as a shell command line, whatever it names. Reads only.
 */
export async function scanTrickFolder(folder: string, manifest: TrickManifest, entries: readonly CodeEntry[], fs: TrickFs = diskTrickFs): Promise<FolderScan> {
  const all = await folderSources(folder, entries, fs);
  // A `trick.ts` whose bytes are a helper this Collie ships is Collie's code, not the trick's: it is named,
  // not grepped. A file that names itself a helper but differs is grepped as code, and flagged.
  const helperText = all.find((src) => src.file === HELPER_FILE)?.text;
  const shipped = helperText === undefined ? null : shippedHelperVersion(helperText);
  const claimed = helperText === undefined ? null : helperVersion(helperText);
  const out: FolderScan = { sources: [], notScanned: [], warnings: [] };
  if (shipped !== null) out.helper = { version: shipped, current: shipped === HELPER_VERSION, modified: false };
  else if (claimed !== null) out.helper = { version: claimed, current: false, modified: true };
  out.sources = all.filter((src) => src.file !== MANIFEST_FILE && isScannedFile(src.file) && !(src.file === HELPER_FILE && shipped !== null));
  out.notScanned = all.filter((src) => src.file !== MANIFEST_FILE && !out.sources.includes(src)).map((src) => src.file);
  const graded = [...out.sources, { file: MANIFEST_FILE, text: manifest.run, shell: true }];
  const imports = runtimeScript(manifest.run) === null ? [] : importWarnings(out.sources);
  out.warnings = [...checkWarnings(graded, manifest.everyMs !== undefined), ...imports].slice(0, WARNINGS_MAX);
  return out;
}

/** The warnings of a trick folder, read fresh, or an empty list when its code cannot be walked (then it is refused anyway). */
export async function trickWarnings(folder: string, manifest: TrickManifest, fs: TrickFs = diskTrickFs): Promise<CheckWarning[]> {
  const walk = await walkTrickCode(fs, folder);
  if (!walk.ok) return [];
  return (await scanTrickFolder(folder, manifest, walk.entries, fs)).warnings;
}

/**
 * The warnings as a trick's row carries them: one per kind, in a fixed order, each with its plain
 * sentence, at most {@link TRICK_WARNINGS_MAX}. The file and the line stay with the CLI.
 */
export function wireWarnings(warnings: readonly CheckWarning[]): WireTrickWarning[] {
  const kinds = new Set(warnings.map((w) => w.kind));
  return KIND_ORDER.filter((kind) => kinds.has(kind))
    .map((kind) => ({ kind, text: WARN_PLAIN[kind] }))
    .slice(0, TRICK_WARNINGS_MAX);
}

/** One printed line per warning, as `check` and `on` print them. */
export function warningLines(warnings: readonly CheckWarning[]): string[] {
  return warnings.map((w) => `warn: ${w.file}:${w.line} ${WARN_TEXT[w.kind]}: ${w.text}`);
}

import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { basename, join, posix } from "node:path";

import { trickHelperSource } from "../../cli/trick-kit/source.ts" with { type: "macro" };
import { TRICK_WARNINGS_MAX, type TrickManifest, type TrickWarningKind, type WireTrickWarning } from "../../web/src/lib/tricks/schema.ts";
import { diskTrickFs, walkTrickCode, type CodeEntry, type TrickFs } from "./code-hash.ts";
import { MANIFEST_FILE } from "./paths.ts";
import { runtimeScript } from "./run.ts";

// THE CHECK SCAN (M94): what a grep of a trick's code flags, for `collie trick check` and for the moment of
// consent. `collie trick on` prints these warnings above its confirmation, and the bridge puts a short form
// of them on the row of a trick that is off or changed, so Settings → Tricks and the Hill shows them before the switch.
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
  network: /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bnet\.connect\b|\bcreateConnection\b|\bBun\.connect\b|\bhttps?\.(?:request|get)\s*\(|\brequests\.(?:get|post|put|delete)\b|\burllib\b|(["'`])(?:gh|curl|wget|ssh)\1/,
  write: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync)\s*\(|\bBun\.write\s*\((?!\s*Bun\.std(?:out|err)\b)/,
  model: new RegExp(`\\b(?:anthropic|openai|openrouter)\\b|\\[\\s*["'\`](?:${AGENT_NAMES})["'\`]|\\b(?:which|findTool|tool|Bun\\.which)\\s*\\(\\s*["'\`](?:${AGENT_NAMES})["'\`]`, "i"),
  // Collie's local socket named by its path (`api/sock`, or `"api", "sock"` joined), by the facts that carry it
  // (`facts.api.socket`, `api?.socket`, `api.token`), a `unix:` option, or `collie api` itself, in a line or as the
  // program and first word of an argument list: the trick talks past its helper (M105 spec 04; review 3, item 1).
  // Since spec 05 the socket answers only a connection that names its run's token in `hello`, so such a trick
  // would have to read its own token from its own facts and send it itself; the warning stays, because then the
  // level check is the bridge's alone and the helper's clear refusal before the dial is gone. The shipped helper
  // dials this way itself, and is never grepped (scanTrickFolder). `createConnection` and `Bun.connect` are the
  // `network` kind for any target, a TCP host or a variable: a grep cannot tell which socket a variable names,
  // and a dial that names none of the above is a network dial (counsel on Edge build 5, A8). A dial that also
  // names the socket (`createConnection(t.facts.api.socket)`) is both kinds.
  api: /\bapi\/sock\b|(["'`])api\1\s*,\s*(["'`])sock\2|\bapi\s*\??\.\s*(?:socket|token)\b|\bunix\s*:|\bcollie\s+api\b|(["'`])collie\3\s*,\s*\[?\s*(["'`])api\4/,
} satisfies Record<Exclude<CheckWarningKind, "import">, RegExp>;
/** In a shell file: a subshell, a tool that reaches the network by its bare name, a redirect into a file, and an agent program in command position. */
const SHELL_SPAWN = /\$\(/;
const SHELL_NETWORK = /\bcurl\b|\bwget\b|\bssh\b|\bgh\s+(?:api|pr|issue|run|repo|release|search)\b/;
const SHELL_WRITE = /(?:^|[^<>&0-9=-])>>?\s*(?!&|\/dev\/null)[^\s>&|;)]/;
// `exec` and `-v` need a blank after them, and the shared `\s*` reads it: written `exec\s+` before that
// `\s*`, the two split a run of blanks every way there is (quadratic, 5.5 s on a 64 KB line).
const SHELL_MODEL = new RegExp(`(?:^|[;&|(]|\\$\\(|\\bexec(?=\\s)|\\bcommand\\s+-v(?=\\s))\\s*(?:${AGENT_NAMES})(?=\\s|$|\\))`);
/** A write that names the state folder (or the trick's own media folder) is the trick's own business. */
const OWN_PLACES = /state|STATE|media|\/dev\/null/;

/** The words `collie trick check` and `collie trick on` print after each warning's place. */
export const WARN_TEXT = {
  spawn: "starts a process",
  network: "reaches the network",
  write: "writes a file outside the trick's state folder, as far as a grep can tell",
  model: "calls an agent program or a model API; a timer run should only read; a timer that calls a model spends your subscription with no session to show for it",
  import: "imports a package; a script Collie's runtime runs gets no install, so it may import only files in its own folder and node: or bun: built-ins",
  api: "names or dials Collie's local API socket, opens a socket of its own, or runs collie api itself, past the helper that holds the level the trick declares",
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
  api: "This trick talks to Collie's local API directly, past its helper.",
} satisfies Record<CheckWarningKind, string>;

/** The order the kinds are listed in, on the row and in the summary. */
const KIND_ORDER: readonly CheckWarningKind[] = ["model", "api", "network", "spawn", "write", "import"];

/** The line printed beside every list of warnings: what they are and are not. */
export const WARNINGS_HONESTY = "These come from a text search of the code, not a proof: a program can do any of this in a way no pattern sees, and a trick runs with your full rights.";

const QUOTED_AT = /["']([^"']+)["']/y;
const FROM_AT = /\sfrom\s+["']([^"']+)["']/y;
const CALL_AT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/y;
const BLANKS_AT = /\s+/y;
const STOPS = `'"\`;`;

/** The specifier a sticky pattern captures at `at`, and where its match ends; null when it does not match there. */
function stickyAt(re: RegExp, text: string, at: number): { spec: string; end: number } | null {
  re.lastIndex = at;
  const m = re.exec(text);
  return m ? { spec: m[1] ?? "", end: re.lastIndex } : null;
}

/**
 * The import specifiers of a source text, in order: `import ... from "x"`, `export ... from "x"`,
 * `import "x"`, `import("x")`, `require("x")`. The same matches as the regex
 * `/(?:^|[\s;])(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g`,
 * walked by hand. That regex read the rest of a stretch with no quote or `;` again from each
 * `import` in it, looking for a ` from "x"` (quadratic, 3.4 s for a 256 KB line); here each stretch
 * is read once, from the right, for the first ` from "x"` at or after each place.
 */
export function importSpecifiers(text: string): string[] {
  const n = text.length;
  // nextFrom[i]: the first ` from "x"` at or after i; nextStop[i]: the first quote, backtick or `;`.
  const nextFrom = new Int32Array(n + 1).fill(n);
  const nextStop = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    const ch = text[i] ?? "";
    nextStop[i] = STOPS.includes(ch) ? i : nextStop[i + 1]!;
    nextFrom[i] = text.startsWith("from", i + 1) && stickyAt(FROM_AT, text, i) !== null ? i : nextFrom[i + 1]!;
  }
  // `import` or `export` at `k`, then blanks, then `"x"` either at once or after a stretch with no
  // quote or `;` that ends in ` from "x"`, the first such. The regex tried the blanks all taken first.
  const importAt = (k: number): { spec: string; end: number } | null => {
    if (!text.startsWith("import", k) && !text.startsWith("export", k)) return null;
    BLANKS_AT.lastIndex = k + 6;
    if (!BLANKS_AT.test(text)) return null;
    const w = BLANKS_AT.lastIndex;
    if (nextFrom[w]! < nextStop[w]!) return stickyAt(FROM_AT, text, nextFrom[w]!);
    // The blanks one shorter: the last blank may start ` from "x"` itself.
    return stickyAt(QUOTED_AT, text, w) ?? (w - 1 > k + 6 ? stickyAt(FROM_AT, text, w - 1) : null);
  };
  const specs: string[] = [];
  for (let i = 0; i < n; ) {
    const hit = (i === 0 ? importAt(0) : null) ?? (/[\s;]/.test(text[i] ?? "") ? importAt(i + 1) : null) ?? stickyAt(CALL_AT, text, i);
    if (hit === null) {
      i++;
      continue;
    }
    specs.push(hit.spec);
    i = hit.end;
  }
  return specs;
}
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
        const bare = importSpecifiers(t).some(isBareImport);
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

// ── what the run line names (the first full trick run, 2026-11-16, decision 2) ──────────────────────
// No run target escapes the scan: `run = "fixtures/main.ts"` or `run = "sh payload.txt"` once named a file
// the skip list above leaves out, and the card said nothing. Every file of the trick a run line names is
// read as code, whatever its name or folder, and so is every file a read file imports by a relative path.
// A run line that hands a file to a shell or an interpreter, and that file was not read as code (binary,
// not in the folder, or code given on the line itself), gets a warning of its own. When in doubt, warn.

/** The shells a run line can hand a file to: the file is then graded as a shell script. */
const RUN_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", "."]);
/** The programs a run line can hand a file to as code: shells, script runtimes, and the launchers that start one. */
const RUN_INTERPRETERS: ReadonlySet<string> = new Set([...RUN_SHELLS, "bun", "node", "deno", "tsx", "python", "python3", "perl", "ruby", "php", "lua", "awk", "env", "exec", "npx", "bunx"]);
/** The flags that hand an interpreter code on the line itself. */
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(["-c", "-e", "--eval", "-p", "--print"]);

/**
 * The words of a run line, split on white space AND on shell punctuation (quotes, `;|&<>()$=` and the
 * backtick), so a path is found wherever it stands: after `env FOO=bar`, inside `sh -c '...'` or
 * `$(cat x)`, after `;`, `&&` or a pipe. A grep's split, not a shell's.
 */
function runWords(run: string): string[] {
  return run.split(/[\s"';|&<>()$=`]+/u).filter((word) => word !== "");
}

/** The extensions a named file keeps its own grading for on a shell line; any other is graded as a shell script. */
const RUN_CODE_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "js", "mjs", "mts", "cjs", "py", "rb", "pl", "php", "lua"]);

/** A shell line that builds a name the scan cannot follow: a variable or a substitution, a backtick, a glob, or `eval`. */
const RUN_DYNAMIC = /[$`*?[]|(^|[\s;|&(])eval(\s|$)/u;
/** The words after {@link RUN_UNREAD} for such a line. */
export const RUN_DYNAMIC_WORDS = "a name the line builds ($, a backtick, a glob or eval)";

/** A word as a path inside the trick's folder, or null for an absolute path or one that leaves the folder. */
function folderRel(word: string): string | null {
  // A run line is a POSIX shell line (tricks are gated on Windows): its absolute paths are POSIX ones.
  if (word === "" || posix.isAbsolute(word) || word.startsWith("~") || word.startsWith("-")) return null;
  const rel = posix.normalize(word);
  return rel === "." || rel.startsWith("../") || rel === ".." ? null : rel;
}

/** What a run line hands to a shell or an interpreter. */
export interface RunTargets {
  /** The trick's files the line names, each to be read as code. */
  named: string[];
  /** The ones a shell gets, graded as shell scripts. */
  shell: Set<string>;
  /** What the line hands to an interpreter that is not one of the trick's files: a path outside it, or code on the line. */
  unread: string[];
}

/**
 * The files of the trick a run line names, and what it hands to an interpreter that is no file of the
 * trick. On a shell line every named file is graded as a shell script unless its extension is a code
 * runtime's ({@link RUN_CODE_EXTENSIONS}): the superset grading, whatever the word's position. An
 * interpreter counts wherever it stands (after `;`, `&&`, a pipe, `timeout`, `nice`, `busybox`...).
 */
export function runTargets(run: string, files: ReadonlySet<string>): RunTargets {
  const out: RunTargets = { named: [], shell: new Set(), unread: [] };
  const script = runtimeScript(run);
  if (script !== null) {
    out.named.push(posix.normalize(script));
    return out;
  }
  let interpreter: string | null = null;
  for (const word of runWords(run)) {
    const name = basename(word);
    if (RUN_INTERPRETERS.has(name)) {
      if (name !== "env" && name !== "exec") interpreter = name;
      continue;
    }
    if (interpreter !== null && INLINE_CODE_FLAGS.has(word) && !RUN_SHELLS.has(interpreter)) out.unread.push(`${word} (code on the run line)`);
    const rel = folderRel(word);
    if (rel !== null && files.has(rel)) {
      if (!out.named.includes(rel)) out.named.push(rel);
      if (!RUN_CODE_EXTENSIONS.has(posix.extname(rel).slice(1))) out.shell.add(rel);
      continue;
    }
    // A word that looks like a file, handed to an interpreter, that is not a file of the trick: never read.
    if (interpreter !== null && !word.startsWith("-") && !word.includes("://") && (word.includes("/") || /\.[A-Za-z0-9]+$/u.test(word))) out.unread.push(word);
  }
  if (RUN_DYNAMIC.test(run)) out.unread.push(RUN_DYNAMIC_WORDS);
  return out;
}

/** The trick's files a source imports by a relative path (`./lib.ts`, `../x`), with the runtime's extensions tried. */
function relativeImports(src: { file: string; text: string }, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const spec of importSpecifiers(src.text.slice(0, SOURCE_READ_MAX))) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const rel = folderRel(posix.join(posix.dirname(src.file), spec));
    if (rel === null) continue;
    const hit = [rel, ...["ts", "js", "mjs", "mts"].map((ext) => `${rel}.${ext}`)].find((candidate) => files.has(candidate));
    if (hit !== undefined) out.push(hit);
  }
  return out;
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
        if (WARN_PATTERNS.api.test(code)) hit("api");
        if (timer && (WARN_PATTERNS.model.test(code) || (shell && SHELL_MODEL.test(t)))) hit("model");
      });
  }
  return out;
}

// ── the helper this Collie ships ─────────────────────────────────────────────

/** The helper file a TypeScript trick imports. */
export const HELPER_FILE = "trick.ts";
/**
 * The version of the helper this Collie writes. Its first line names it: `// collie trick helper v10`. It moves
 * with EVERY change of the helper's text, shipped or not (the dev lane and an Edge build serve the text too):
 * scan.test.ts pins the text's SHA-256 to this number and fails with "bump the helper version". A text that
 * changed under an old number is read as a hand-edited helper, so a trick that kept the file counts it as its own
 * code. On a bump, add the old text's hash to {@link OLDER_HELPERS}, and never edit a pin.
 */
export const HELPER_VERSION = 10;
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
 * v2 (the facts' `v`, `t.hillAnswer` beside `t.tap`; M94 review 11 made it v3), and v3 (contract 1 only; v4
 * reads contract 2's `inputs` and prints the facts' own contract as `v`), and v4 (v5 adds `t.menu` and a
 * belt mark's `sessions`), and v5 (v6 ends a run after the pipe took the output, not with `process.exit`
 * over a write in flight, which Windows lost; it speaks contract 3 and reads its `values` as `t.values`), and v6
 * (v7 adds `t.api`, Collie's local API through the declared `access`), and v7 (v8 names the run's token in
 * `hello`, M105 spec 05: a v7 copy still runs, and its `t.api` hears `api.no_run_token`), and v8 (1.29.0, and the
 * released tricks repository's four helpers; v9 adds the float place's types and a draft button's `does`; v10 adds
 * a sprite's `after`). A version can hold several texts: a text committed under a version line that then moved
 * without a bump (four of v8 on the dev lane, two of v9) stays known too, because a draft was written with it.
 * A trick folder keeps the copy it was approved with: an older one stays Collie's code, so a new Collie asks for no yes.
 */
export const OLDER_HELPERS: ReadonlyMap<string, number> = new Map([
  ["534f992f9aa2a4a6e53945c1b46e7b407ab9528b3839970e6552d83b23ed13bb", 1],
  ["ec9ce0acd1c1691f61bb63a0f9f136578c9bf9250c7aa66d3d1186ee030b98a9", 2],
  ["15d022db6ff7efb5a19e148c7f29478b3cc50fd4d4dc9fb868ce576b84f03ad6", 3],
  ["c25f26e2450c71b92146bf62ca45978978890fa6afc085caf0909b64372a200b", 4],
  ["433bb8cae8929213274ed421f82cc63255a5a763732491a785c61f9f40bd4a1d", 5],
  ["52fed09e380c66a9902731aa111cc299c63bc2fcec83227f4f91963070789dfe", 6],
  ["647ee21270299c997325d9dcd76f6a3ff9dcaf51cc2e3b7f89aa5e918fab80cd", 7],
  ["f1abca55dae2c534c378e9670e343e681519ca4fa55c50d7c5476b44e99ebc26", 8],
  // v8 as the dev lane served it before v9 (ce9f17f0d, c5c9dd62c, 5985e73d3, 63bd78934): never in a tag.
  ["7cc9c32214394c6e6cf529799ba951991d5ca5efd8843d892e24bca54a0f8ee0", 8],
  ["d8b71b8e568b699da2db886d2c5a1a8659d5bc8c1ea514450ff485eaa29cef56", 8],
  ["e20931773e1e193c09ce6f39139175c4c13ed8add88428ee7ed51fde4e18e9ad", 8],
  ["6e63071b76e7f7fd38abaf37e9131648801e58749bd6eb00a710ca1edc9eed0a", 8],
  // v9 as of 701ce4ce4, and v9 as of bcc2135aa (sprite.after).
  ["ed3bbcc08f02073fbd345d869e1702bc78437f07089a59bc03df6d5e74c5db8e", 9],
  ["e3d318649b1736a68fc11c253c890ae2809fc15a4f9db82808ef3b9bc1d9234f", 9],
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
export async function scanTrickFolder(folder: string, manifest: Pick<TrickManifest, "run" | "everyMs">, entries: readonly CodeEntry[], fs: TrickFs = diskTrickFs): Promise<FolderScan> {
  const all = await folderSources(folder, entries, fs);
  // A `trick.ts` whose bytes are a helper this Collie ships is Collie's code, not the trick's: it is named,
  // not grepped. A file that names itself a helper but differs is grepped as code, and flagged.
  const helperText = all.find((src) => src.file === HELPER_FILE)?.text;
  const shipped = helperText === undefined ? null : shippedHelperVersion(helperText);
  const claimed = helperText === undefined ? null : helperVersion(helperText);
  const out: FolderScan = { sources: [], notScanned: [], warnings: [] };
  if (shipped !== null) out.helper = { version: shipped, current: shipped === HELPER_VERSION, modified: false };
  else if (claimed !== null) out.helper = { version: claimed, current: false, modified: true };
  // Every file of the walk, text or not: a run line may name a binary file, which is then not read as code.
  const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.rel));
  const targets = manifest.run === undefined ? null : runTargets(manifest.run, files);
  // The files that must be read as code whatever their names (decision 2): the run line's, then what they import.
  const forced = new Set(targets?.named ?? []);
  // The shipped helper stays Collie's code also when the program imports it, as every program does.
  const isShippedHelper = (file: string) => file === HELPER_FILE && shipped !== null;
  const isCode = (src: { file: string }) => !isShippedHelper(src.file) && (forced.has(src.file) || (src.file !== MANIFEST_FILE && isScannedFile(src.file)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const src of all.filter(isCode)) {
      for (const rel of relativeImports(src, files)) {
        if (forced.has(rel)) continue;
        forced.add(rel);
        grew = true;
      }
    }
  }
  out.sources = all.filter(isCode).map((src) => (targets?.shell.has(src.file) === true ? Object.assign({ shell: true }, src) : src));
  out.notScanned = all.filter((src) => src.file !== MANIFEST_FILE && !isCode(src)).map((src) => src.file);
  // A trick that is only an agent view has no run line: its files are graded, and nothing is imported.
  const graded = manifest.run === undefined ? out.sources : [...out.sources, { file: MANIFEST_FILE, text: manifest.run, shell: true }];
  const imports = manifest.run === undefined || runtimeScript(manifest.run) === null ? [] : importWarnings(out.sources);
  out.warnings = [...unreadTargets(manifest.run, targets, all, runLineOf(all)), ...checkWarnings(graded, manifest.everyMs !== undefined), ...imports].slice(0, WARNINGS_MAX);
  return out;
}

/** The order the kinds of a warning are named in: {@link KIND_ORDER}, for a reader that marks lines. */
export function kindRank(kind: CheckWarningKind): number {
  return KIND_ORDER.indexOf(kind);
}

/** The line of `run =` in `trick.toml`, or 1. */
function runLineOf(all: readonly { file: string; text: string }[]): number {
  const text = all.find((src) => src.file === MANIFEST_FILE)?.text ?? "";
  const at = text.split(/\r?\n/u).findIndex((line) => /^\s*run\s*=/u.test(line));
  return at < 0 ? 1 : at + 1;
}

/**
 * One `spawn` warning per thing the run line hands to a shell or an interpreter that the scan did not read
 * as code: a named file that is binary or unreadable, a path that is no file of the trick, code on the line.
 */
function unreadTargets(run: string | undefined, targets: RunTargets | null, read: readonly { file: string }[], line: number): CheckWarning[] {
  if (run === undefined || targets === null) return [];
  const readFiles = new Set(read.map((src) => src.file));
  const unread = [...targets.named.filter((rel) => !readFiles.has(rel)), ...targets.unread];
  return unread.map((what) => ({ kind: "spawn", file: MANIFEST_FILE, line, text: shortLine(`${RUN_UNREAD} ${what}`) }));
}

/** The words before what a run line hands over unread, in the warning's text. */
export const RUN_UNREAD = "the run line hands over code the scan did not read:";

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
  return warnings.map((w) => `warning: ${w.file}:${w.line} ${WARN_TEXT[w.kind]}: ${w.text}`);
}

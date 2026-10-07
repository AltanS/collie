// File paths the agent prints, found in text and resolved to a path under the Changes root
// (ADR 0088). Pure: no DOM, no React, no network. The screens that draw chat prose, tool cards and
// the terminal mirror ask this module where a path is, and the Files view opens it.
//
// WHAT COUNTS AS A PATH
//
// Plain text is dense with dotted and slashed tokens that are not files: `and/or`, `e.g.`,
// `1.2.3`, `example.com`, `process.env`, `foo.map(...)`. A tap on one of them must not open an empty
// Files screen, so the rules lean towards text:
//
//   - In plain text a path needs a folder part (`a/b.ts`, `./x`, `~/x`, `/x`). With no explicit
//     start (`/`, `~/`, `./`, `../`) it also needs an extension, so `and/or` stays a word.
//   - In a code span the whole span must be one path. A folder part OR an extension is enough
//     (`README.md`), minus the code names below.
//   - An extension is 1 to 8 letters or digits with at least one letter, so `1.2.3` has none.
//   - A token with no folder part is not a file when it reads as code or a host: a known object
//     (`process.env`, `Math.random`, `console.log`, `fs.readFile`), a member that is code
//     (`.map`, `.then`, `.length`) or a top-level domain (`example.com`).
//   - A version (`1.2.3`, `v20.1.0`) is not a path: the part before the extension needs a letter.
//   - A path whose first folder is a domain (`github.com/a/b.git`) is an address, not a file.
//   - Nothing inside a `://` run is a file path: that run belongs to the URL autolinker.
//   - `name.ext(` is a call (`foo.ts(` is rare, `util.inspect(` is common), except a compiler's
//     `Name.tsx(12,5)`, which is a line and a column.
//   - A suffix `:12`, `:12:5` or `(12,5)` is a line and an optional column.
//
// No backslash paths this round: a Windows path (`C:\x`, `\\share`) is not found, and a root that
// is not a POSIX path resolves nothing.

/** A path as the agent printed it, with the line and column its suffix named, when it named them. */
export interface PrintedPath {
  /** The path as printed, without the line suffix. */
  path: string;
  line?: number;
  col?: number;
}

/** One path found in a run of text. `start`/`end` cover the printed path AND its line suffix. */
export interface FoundPath extends PrintedPath {
  start: number;
  end: number;
}

/** What a name is made of: letters, digits, the marks that complete them, and `_`. */
const NAME = "\\p{L}\\p{N}\\p{M}_";

// One path, then an optional line suffix. The look-behind keeps a path from starting inside a word,
// a longer path, a `C:` drive, a `\` path or a URL scheme; the look-ahead keeps it from ending inside
// one. The name's own character class has no `:` and no `(`, so the suffix is never swallowed.
const PATH_SOURCE =
  `(?<![${NAME}/.@~:\\\\-])` +
  `((?:~/|\\.{1,2}/|/)?(?:[${NAME}@.+-]+/)*[${NAME}@+.-][${NAME}@.+-]*)` +
  `(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:,\\s?(\\d+))?\\))?` +
  `(?![${NAME}/\\\\])`;

/** Global, for a scan over a run of text. A fresh one per call, so `lastIndex` is never shared. */
const pathScanner = () => new RegExp(PATH_SOURCE, "gu");
/** Anchored, for a code span that must be one path and nothing else. */
const CODE_PATH = new RegExp(`^${PATH_SOURCE}$`, "u");

/** `name.ext(` after a path: a call. `(12)` and `(12,5)` were taken as a line suffix already. */
const CALL_AFTER = /\s*\(/y;

/** A line longer than this is not prose with paths in it (a minified bundle, a blob): left alone. */
const MAX_SCAN_CHARS = 8192;

const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

// A Map/Set, never an object literal: every key here is compared with text the agent printed.

/** The first part of a dotted token that makes it code, not a file: `process.env`, `fs.readFile`. */
const CODE_OBJECTS = new Set([
  "process", "Math", "JSON", "console", "Object", "Array", "Promise", "Number", "String", "Date",
  "Reflect", "Symbol", "Intl", "window", "document", "navigator", "location", "globalThis", "this",
  "self", "import", "module", "exports", "require", "os", "sys", "fs", "path", "util", "crypto",
  "http", "https", "url", "req", "res", "ctx", "event", "err", "e", "React", "Bun", "Deno", "vi",
  "expect", "jest", "np", "pd", "torch", "tf",
]);

/** An extension that is a member, not a file type: `items.map`, `p.then`, `list.length`. */
const CODE_MEMBERS = new Set([
  "map", "then", "length", "filter", "forEach", "push", "pop", "shift", "catch", "finally", "bind",
  "call", "apply", "exec", "split", "join", "slice", "splice", "keys", "values", "entries",
  "current", "props", "state", "value", "error", "warn", "info", "debug", "random", "floor", "ceil",
  "round", "max", "min", "abs", "parse", "assign", "freeze", "from", "isArray", "all", "race",
  "resolve", "reject", "readFile", "exists", "test", "only", "skip", "each", "mock", "fn", "default", "prototype", "name", "id", "type",
  "size", "get", "set", "has", "add", "delete", "clear", "find", "some", "every", "reduce", "sort",
  "includes", "indexOf", "trim", "replace", "match", "toString",
]);

/** Top-level domains an agent prints: `example.com` and `github.com/a/b` are addresses. */
const DOMAIN_ENDINGS = new Set([
  "com", "org", "net", "io", "dev", "app", "ai", "co", "de", "uk", "eu", "me", "gg", "xyz", "info",
  "edu", "gov", "tv", "ly", "us", "cloud", "page", "site",
]);

/** The extension of a path's last name, or null: 1 to 8 letters or digits, at least one letter. */
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = EXTENSION.exec(name);
  if (m === null || !/[A-Za-z]/.test(m[1]!)) return null;
  // `.` alone before the extension is a dot-file (`.env`), which is a name with no extension, but
  // still a file: it counts as having one, the way `a/.env` reads to a person.
  return m[1]!;
}

/** Whether the path opens with an explicit start: `/`, `~/`, `./` or `../`. */
function hasStart(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || path.startsWith("./") || path.startsWith("../");
}

/**
 * A token with no folder part that reads as code or as a host. A dot-file (`.env`, `.gitignore`) is
 * a file unless its name is a member (`.map`, `.then`), which is how a method is written in prose.
 */
function isCodeName(path: string): boolean {
  const dot = path.indexOf(".");
  if (dot > 0 && CODE_OBJECTS.has(path.slice(0, dot))) return true;
  const last = path.slice(path.lastIndexOf(".") + 1);
  return CODE_MEMBERS.has(last) || DOMAIN_ENDINGS.has(last.toLowerCase());
}

/** A first folder that is a host name: `github.com/` or `docs.example.org/`. */
function startsWithDomain(path: string): boolean {
  if (hasStart(path)) return false;
  const first = path.slice(0, path.indexOf("/"));
  const dot = first.lastIndexOf(".");
  return dot > 0 && DOMAIN_ENDINGS.has(first.slice(dot + 1).toLowerCase());
}

/**
 * Whether a printed token is a path, by the rules in the header. `span` is a code span, where a bare
 * file name (`README.md`) counts; in plain text a folder part is required.
 */
function isPath(path: string, span: boolean): boolean {
  if (path === "" || path.endsWith("/") || path === "." || path === "..") return false;
  const folder = path.includes("/");
  const ext = extensionOf(path);
  if (!folder && (!span || ext === null || isCodeName(path))) return false;
  if (folder && ext === null && !hasStart(path)) return false;
  // A version or a number: the part before the extension holds no letter at all.
  // A dot-file (`.env`) is all extension, so its whole name is the stem.
  const cut = ext === null ? path : path.slice(0, -(ext.length + 1));
  const stem = cut === "" || cut.endsWith("/") ? path : cut;
  if (!/\p{L}/u.test(stem)) return false;
  if (folder && startsWithDomain(path)) return false;
  return true;
}

/** Trailing dots belong to the sentence, not the path: `see src/a.ts.` */
function trimDots(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === ".") end--;
  return path.slice(0, end);
}

/** The runs of `text` that hold `://`, each from the whitespace before to the whitespace after. */
function addressRuns(text: string): [number, number][] {
  const runs: [number, number][] = [];
  let end = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", end)) {
    let start = at;
    while (start > end && !/\s/.test(text[start - 1]!)) start--;
    end = at + 3;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    runs.push([start, end]);
  }
  return runs;
}

/** A line or a column as a number, or undefined for none, zero, or one past any real file. */
function positive(digits: string | undefined): number | undefined {
  if (digits === undefined) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Sets `line` and `col` on `found` from one match's suffix groups, each only when present. */
function addLine<T extends PrintedPath>(found: T, m: RegExpExecArray): T {
  const line = positive(m[2] ?? m[4]);
  if (line === undefined) return found;
  found.line = line;
  const col = positive(m[3] ?? m[5]);
  if (col !== undefined) found.col = col;
  return found;
}

/** Every file path in a run of plain text, in order, never overlapping. */
export function findFilePaths(text: string): FoundPath[] {
  if (text.length > MAX_SCAN_CHARS || !text.includes("/")) return [];
  const runs = addressRuns(text);
  const found: FoundPath[] = [];
  let run = 0;
  for (const m of text.matchAll(pathScanner())) {
    const index = m.index;
    while (run < runs.length && runs[run]![1] <= index) run++;
    if (run < runs.length && runs[run]![0] <= index) continue;
    const printed = m[1]!;
    const path = trimDots(printed);
    if (!isPath(path, false)) continue;
    const suffixed = m[2] !== undefined || m[4] !== undefined;
    // Dots trimmed off the end leave the suffix behind them unreadable (`a.ts.:3`): no suffix then.
    if (suffixed && path !== printed) continue;
    const end = suffixed ? index + m[0].length : index + path.length;
    CALL_AFTER.lastIndex = end;
    if (!suffixed && CALL_AFTER.test(text)) continue;
    const at: FoundPath = { start: index, end, path };
    found.push(suffixed ? addLine(at, m) : at);
  }
  return found;
}

/** A code span that is one file path and nothing else (`README.md`, `src/a.ts:12`), or null. */
export function codeSpanPath(code: string): PrintedPath | null {
  const text = code.trim();
  if (text === "" || text.includes("://")) return null;
  const m = CODE_PATH.exec(text);
  if (m === null) return null;
  const path = m[1]!;
  if (path !== trimDots(path) || !isPath(path, true)) return null;
  return addLine({ path }, m);
}

// ── Where a printed path leads ────────────────────────────────────────────────────────────────────

/** `/a//b/` as `/a/b`, `.` and `..` folded; null when `..` climbs past `/` or the path is not POSIX. */
function normalizeAbsolute(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0")) return null;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Fedora Atomic and Silverblue link `/home` to `/var/home`. The bridge's root and an agent's printed
 * path may spell the same folder either way, so a printed `/home/x` is also tried as `/var/home/x`
 * and the other way round. Nothing else is folded.
 */
function homeSpellings(abs: string): string[] {
  if (abs.startsWith("/var/home/")) return [abs, abs.slice(4)];
  if (abs.startsWith("/home/")) return [abs, `/var${abs}`];
  return [abs];
}

/** `abs` relative to `root`, or null when it is not strictly below it. Both normalised. */
function under(root: string, abs: string): string | null {
  for (const spelling of homeSpellings(abs)) {
    if (root === "/") return spelling === "/" ? null : spelling.slice(1);
    if (spelling.startsWith(`${root}/`)) return spelling.slice(root.length + 1);
  }
  return null;
}

/**
 * `~/rest` with no home dir known: the root is `<home>/<tail>`, so a printed `~/<tail>/x` is `x`.
 * The longest tail of the root that the printed path starts with wins. Null when none does.
 */
function underUnknownHome(root: string, rest: string): string | null {
  const segments = root.split("/").filter((s) => s !== "");
  for (let k = 1; k < segments.length; k++) {
    const tail = segments.slice(k).join("/");
    if (rest.startsWith(`${tail}/`)) return rest.slice(tail.length + 1);
  }
  return null;
}

/** A root-relative path the Files view can be asked for: no `..`, no `.git`, nothing empty. */
function readable(rel: string | null): string | null {
  if (rel === null || rel === "") return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.toLowerCase() === ".git")) return null;
  return rel;
}

export interface FilePathLinkInput {
  /** The path as the agent printed it, without a line suffix. */
  path: string;
  /** The Changes root, absolute (ADR 0083). Null or a non-POSIX root resolves nothing. */
  root: string | null;
  /** The pane's folder: absolute, or relative to the root. Relative paths resolve against it. */
  cwd: string;
  /** The home dir of the pane's machine, for `~/`. Absent: see `underUnknownHome`. */
  home?: string;
}

/**
 * Where a printed path leads, as a path relative to the Changes root, or null when it leads nowhere
 * Files can open: outside the root, the root itself, or a `.git` folder. Null renders as plain text.
 *
 * `/abs` must lie under the root. `~/` expands with `home`. `./x`, `../x` and a bare `a/b` resolve
 * against `cwd`. Nothing here reaches the bridge but the answer, which the bridge checks again.
 */
export function resolveFilePathLink({ path, root, cwd, home }: FilePathLinkInput): string | null {
  if (root === null || path.includes("\\") || path.includes("\0")) return null;
  const base = normalizeAbsolute(root);
  if (base === null) return null;
  if (path.startsWith("/")) {
    const abs = normalizeAbsolute(path);
    return abs === null ? null : readable(under(base, abs));
  }
  if (path === "~" || path.startsWith("~/")) {
    const rest = path.slice(2);
    if (home === undefined || home === "") return readable(underUnknownHome(base, normalizeRelative(rest) ?? ""));
    const abs = normalizeAbsolute(`${home}/${rest}`);
    return abs === null ? null : readable(under(base, abs));
  }
  if (path.startsWith("~")) return null; // `~user/` is another person's home
  const from = cwd === "" ? base : cwd.startsWith("/") ? cwd : `${base}/${cwd}`;
  const abs = normalizeAbsolute(`${from}/${path}`);
  return abs === null ? null : readable(under(base, abs));
}

/** A relative path with `.` folded and no `..` left at its head, or null when one climbs out. */
function normalizeRelative(rel: string): string | null {
  const abs = normalizeAbsolute(`/${rel}`);
  return abs === null ? null : abs.slice(1);
}

// ── The root, as the bridge picks it ─────────────────────────────────────────────────────────────

/** The pane fields the root lookup reads. `AgentView` satisfies it. */
export interface RootPane {
  workspaceId: string;
  cwd: string;
  host?: string;
}

/** The workspace fields the root lookup reads. `WorkspaceView` satisfies it. */
export interface RootWorkspace {
  workspaceId: string;
  folder?: string;
  host?: string;
}

/** A POSIX folder with its trailing slashes gone, or null for anything else (blank, relative, Windows). */
function folderOf(path: string | undefined): string | null {
  if (path === undefined) return null;
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  return normalizeAbsolute(trimmed);
}

/** Whether a root is narrow enough: not `/`, not home, not above home (`bridge/changes-root.ts`). */
function withinBound(path: string, home: string): boolean {
  if (path === "/") return false;
  if (home === "/" || home === "") return true;
  return !(home === path || home.startsWith(`${path}/`));
}

/** The deepest folder every path sits in, `/` at the least. */
function commonAncestor(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  let parts = paths[0]!.split("/").filter((s) => s !== "");
  for (const path of paths.slice(1)) {
    const other = path.split("/").filter((s) => s !== "");
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return `/${parts.join("/")}`;
}

/**
 * The Changes root of one pane, worked out from the snapshot the way the bridge's pane Files route
 * picks it (`bridge/changes-root.ts`, `workspaceRoot`, then the pane's own cwd): the workspace's
 * folder, else the folder all its panes share, else the pane's own cwd, each only when it lies below
 * home. Null when none does, when home is not known yet (the bound cannot be checked), or on a
 * machine whose paths are not POSIX. The bridge looks the root up again on every read; this copy
 * only decides which printed paths are worth a link.
 */
export function paneFilesRoot({
  pane,
  panes,
  workspaces,
  home,
}: {
  pane: RootPane;
  panes: readonly RootPane[];
  workspaces: readonly RootWorkspace[];
  home: string;
}): string | null {
  const h = folderOf(home);
  if (h === null) return null;
  const sameSpace = (p: { workspaceId: string; host?: string }) => p.workspaceId === pane.workspaceId && p.host === pane.host;
  const folder = folderOf(workspaces.find(sameSpace)?.folder);
  if (folder !== null && withinBound(folder, h)) return folder;
  const cwds = panes.filter(sameSpace).map((p) => folderOf(p.cwd)).filter((c): c is string => c !== null);
  const common = commonAncestor(cwds);
  if (common !== null && withinBound(common, h)) return common;
  const own = folderOf(pane.cwd);
  return own !== null && withinBound(own, h) ? own : null;
}

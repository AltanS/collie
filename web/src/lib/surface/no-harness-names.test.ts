import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// M56 spec 02: the surface code never names a harness. The ids are the file stems in `profiles/`,
// read by directory, so a new profile joins this check with no edit here. An id that appears as an
// identifier or as a string literal in `web/src/lib/surface/*.ts`, `bridge/surface/*.ts` or
// `bridge/walky/*.ts` fails.
// Comments are not scanned. Test files are not scanned either: a test of a profile has to name it.
// `profiles/` itself is the one place a name may live, and it is not in either glob.

// Walky talky (M62) holds the same rule: a message names its sender's harness as an open string.
const SURFACE_DIRS = [
  join(import.meta.dirname),
  join(import.meta.dirname, "..", "..", "..", "..", "bridge", "surface"),
  join(import.meta.dirname, "..", "..", "..", "..", "bridge", "walky"),
];
const PROFILES_DIR = join(import.meta.dirname, "profiles");

function profileIds(): string[] {
  return readdirSync(PROFILES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""));
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name));
}

/** Words inside a token: `claudeProfile`, `claude-code` and `Claude Code` all hold the word `claude`. */
function words(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

const IDENT_START = /[A-Za-z_$\u00c0-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u00c0-\uffff]/;
/** A `/` after one of these opens a regular expression, not a division. */
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * Every identifier, string literal, template text and regular expression body in a file, comments
 * skipped. A small lexer rather than the compiler's scanner: the web tree's TypeScript 7 has no
 * scanner API. It tracks template nesting and regex-versus-division from the previous token, which
 * is enough for files this repo writes.
 */
export function tokensOf(source: string): string[] {
  const out: string[] = [];
  const braces: number[] = []; // one counter per open `${`
  let previous = ""; // the last significant character or word
  let i = 0;

  const scanTemplate = (): void => {
    // `i` sits just after the opening backtick or the closing brace of a substitution.
    let body = "";
    while (i < source.length) {
      const c = source[i]!;
      if (c === "\\") {
        body += source.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        i++;
        out.push(body);
        previous = "`";
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        i += 2;
        out.push(body);
        braces.push(0);
        previous = "{";
        return;
      } else {
        body += c;
        i++;
      }
    }
    out.push(body);
  };

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      let body = "";
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") {
          body += source.slice(i, i + 2);
          i += 2;
        } else body += source[i++];
      }
      i++;
      out.push(body);
      previous = c;
    } else if (c === "`") {
      i++;
      scanTemplate();
    } else if (c === "/" && REGEX_AFTER.has(previous)) {
      let body = "";
      let inClass = false;
      i++;
      while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") {
          body += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        body += source[i++];
      }
      i++;
      out.push(body);
      previous = "/";
    } else if (IDENT_START.test(c)) {
      let word = "";
      while (i < source.length && IDENT_PART.test(source[i]!)) word += source[i++];
      out.push(word);
      previous = word === "return" || word === "typeof" || word === "case" ? "" : "a";
    } else if (c === "{" && braces.length > 0) {
      braces[braces.length - 1]!++;
      previous = c;
      i++;
    } else if (c === "}" && braces.length > 0) {
      const top = braces.length - 1;
      i++;
      if (braces[top] === 0) {
        braces.pop();
        scanTemplate();
      } else {
        braces[top]!--;
        previous = "}";
      }
    } else {
      previous = /[0-9]/.test(c) ? "a" : c === ")" || c === "]" ? "a" : c;
      i++;
    }
  }
  return out;
}

/** The ids found in a source text, as `id: token` lines. */
export function namesIn(source: string, ids: readonly string[]): string[] {
  const found: string[] = [];
  for (const token of tokensOf(source)) {
    const tokenWords = words(token);
    for (const id of ids) if (tokenWords.includes(id)) found.push(`${id}: ${token}`);
  }
  return found;
}

/**
 * Profile ids that are also an ordinary word the walky talky wire uses: `cursor` is the report's ack
 * cursor (`walky: { receipts, cursor }`, `readWalkyCursor`), not the Cursor CLI. The ban skips these
 * ids in the walky folder only; the surface folders keep the full ban.
 */
const WALKY_WIRE_WORDS: ReadonlySet<string> = new Set(["cursor"]);

/** The ids to ban in one scanned folder. */
function idsFor(dir: string, ids: readonly string[]): readonly string[] {
  return dir === SURFACE_DIRS[2] ? ids.filter((id) => !WALKY_WIRE_WORDS.has(id)) : ids;
}

describe("no harness names in the surface code", () => {
  it("finds profile ids by directory", () => {
    expect(profileIds()).toContain("claude");
  });

  it("scans the web surface folder, and the bridge folder when it exists", () => {
    expect(sourceFiles(SURFACE_DIRS[0]!).some((file) => file.endsWith("profile.ts"))).toBe(true);
  });

  it("finds a name as an identifier or a string, and skips comments", () => {
    const ids = ["claude"];
    expect(namesIn("const claudeProfile = 1;", ids)).toHaveLength(1);
    expect(namesIn('const x = "claude";', ids)).toHaveLength(1);
    expect(namesIn("const x = `a ${y} claude`;", ids)).toHaveLength(1);
    expect(namesIn("// claude\n/* claude */ const x = 1;", ids)).toEqual([]);
    expect(namesIn("const re = /claude/u;", ids)).toHaveLength(1);
    expect(namesIn("const q = a / b; // claude", ids)).toEqual([]);
    expect(namesIn("const t = `${a + `x`} claude`;", ids)).toHaveLength(1);
    expect(namesIn('const x = "clauded";', ids)).toEqual([]);
  });

  it("codex: the second profile joins the ban by directory, and no surface file names it (M56 spec 13)", () => {
    expect(profileIds()).toContain("codex");
    expect(namesIn('const queueKey = codexProfile.keys["Tab"];', ["codex"])).toHaveLength(1);
    expect(namesIn("// a Codex screen steers on Enter\nconst x = 1;", ["codex"])).toEqual([]);
    const hits: string[] = [];
    for (const dir of SURFACE_DIRS) {
      for (const file of sourceFiles(dir)) for (const hit of namesIn(readFileSync(file, "utf8"), ["codex"])) hits.push(`${file}: ${hit}`);
    }
    expect(hits).toEqual([]);
  });

  it("the M56 spec 14 profiles join the ban by directory, and no surface file names them", () => {
    const added = ["opencode", "pi", "omp", "grok", "agy", "muse", "hermes", "cursor"];
    for (const id of added) {
      expect(profileIds()).toContain(id);
      expect(namesIn(`const key = ${id}Profile.keys;`, [id])).toHaveLength(1);
      expect(namesIn(`// a ${id} screen\nconst x = 1;`, [id])).toEqual([]);
    }
    const hits: string[] = [];
    for (const dir of SURFACE_DIRS) {
      for (const file of sourceFiles(dir)) for (const hit of namesIn(readFileSync(file, "utf8"), idsFor(dir, added))) hits.push(`${file}: ${hit}`);
    }
    expect(hits).toEqual([]);
  });

  it("holds in web/src/lib/surface/*.ts and bridge/surface/*.ts", () => {
    const ids = profileIds();
    const hits: string[] = [];
    for (const dir of SURFACE_DIRS) {
      for (const file of sourceFiles(dir)) {
        for (const hit of namesIn(readFileSync(file, "utf8"), idsFor(dir, ids))) hits.push(`${file}: ${hit}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

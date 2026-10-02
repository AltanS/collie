import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// THE HOST GUARD (M43 spec 11). Source that runs on Windows reads its path flavour and its binary
// name from the `Host` object in `bridge/host.ts`. These four spellings are how that rule gets
// broken without anyone noticing, because each one is right on Linux and silently wrong on Windows:
//
//   startsWith("/")        a Windows folder starts with `C:\`, never with a slash
//   new URL(...).pathname  a file URL's pathname is `/C:/x` on Windows; `fileURLToPath` is the answer
//   .split("/")            a Windows path splits at backslashes too
//   "bin", "collie"        the binary is `collie.exe` there; `collieBinary(root, host)` names it
//
// A new hit fails the test. The fix is one of two things: read the host (`host.path`, `isInside`,
// `collieBinary`), or, when Windows never reaches the line, add it to NOT_REACHED_BY_WINDOWS with the
// reason in one line. The two lists carry a count per file, so a site that is removed also fails
// the test until its entry goes: the lists cannot rot into a blanket permission.

const ROOT = join(import.meta.dir, "..");
const SCANNED = ["bridge", "cli", "scripts"];

const PATTERNS = {
  startsWithSlash: /\.startsWith\(\s*"\/"\s*\)/,
  urlPathname: /new URL\([^\n]*\)\.pathname/,
  splitOnSlash: /\.split\(\s*"\/"\s*\)/,
  binaryNameJoin: /"bin",\s*"collie"/,
} as const;
type PatternId = keyof typeof PATTERNS;

interface Allowed {
  readonly file: string;
  readonly pattern: PatternId;
  /** How many lines of the file match. Any other number fails, up or down. */
  readonly count: number;
  readonly why: string;
}

/** Sites Windows never reaches: URLs and routes, tmux and zellij, systemd, test-only helpers. */
const NOT_REACHED_BY_WINDOWS: readonly Allowed[] = [
  { file: "bridge/mux/tmux/exec.ts", pattern: "startsWithSlash", count: 1, why: "tmux has no Windows build" },
  { file: "bridge/mux/zellij/exec.ts", pattern: "startsWithSlash", count: 1, why: "zellij has no Windows build" },
  { file: "bridge/mux/tmux/adapter.ts", pattern: "splitOnSlash", count: 1, why: "tmux session path, tmux has no Windows build" },
  { file: "bridge/operator-commands.ts", pattern: "startsWithSlash", count: 1, why: "a slash command such as /model, not a path" },
  { file: "bridge/config.ts", pattern: "splitOnSlash", count: 1, why: "COLLIE_BASE_PATH is a URL mount, always slashes" },
  { file: "bridge/crew/forward.ts", pattern: "splitOnSlash", count: 3, why: "crew route names, URL paths" },
  { file: "bridge/crew/peer-client.ts", pattern: "urlPathname", count: 1, why: "an HTTP route, never a file" },
  { file: "cli/install-kind.ts", pattern: "splitOnSlash", count: 2, why: "git remote URLs, always slashes" },
  { file: "cli/update.ts", pattern: "splitOnSlash", count: 2, why: "a literal list of payload names, joined by path.join; and a systemd unit path" },
  { file: "cli/fakes.ts", pattern: "splitOnSlash", count: 2, why: "test-only fake filesystem, keys are POSIX by design" },
];

/**
 * Sites Windows DOES reach and that spec 11 left alone. They stay listed so they stay visible: each
 * one is a line to fix when a Windows spec reaches its module. Do not add to this list to get a
 * build green; read the host instead.
 */
const KNOWN_WINDOWS_GAPS: readonly Allowed[] = [
  { file: "bridge/beacon/hint.ts", pattern: "splitOnSlash", count: 1, why: "base name of a pane command, a `C:\\x\\claude.exe` keeps its folders" },
  { file: "bridge/state-engine.ts", pattern: "splitOnSlash", count: 1, why: "base name of the foreground command, same Windows gap as beacon/hint.ts" },
  { file: "cli/ssh-config.ts", pattern: "startsWithSlash", count: 1, why: "ssh Include paths are read as POSIX; crew add from a Windows lead" },
  { file: "cli/ssh-config.ts", pattern: "splitOnSlash", count: 1, why: "the same ssh Include handling" },
];

const ALLOWED: readonly Allowed[] = [...NOT_REACHED_BY_WINDOWS, ...KNOWN_WINDOWS_GAPS];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    const isSource = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
    const isTest = /\.test\.tsx?$/.test(entry.name);
    if (isSource && !isTest && entry.name !== "fixtures.ts") out.push(full);
  }
  return out;
}

/** A line that is only a comment is prose about the pattern, not a use of it. */
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

function hitsByFile(): Map<string, number> {
  const hits = new Map<string, number>();
  for (const top of SCANNED) {
    for (const file of sourceFiles(join(ROOT, top))) {
      const name = relative(ROOT, file).split(sep).join("/");
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (isCommentLine(line)) continue;
        for (const [id, re] of Object.entries(PATTERNS)) {
          if (re.test(line)) hits.set(`${name}\t${id}`, (hits.get(`${name}\t${id}`) ?? 0) + 1);
        }
      }
    }
  }
  return hits;
}

describe("the host guard: platform-blind spellings in source Windows runs", () => {
  const hits = hitsByFile();
  const allowed = new Map(ALLOWED.map((a) => [`${a.file}\t${a.pattern}`, a.count]));

  test("no site uses one of the four spellings outside the two lists", () => {
    const unlisted = [...hits]
      .filter(([key, n]) => (allowed.get(key) ?? 0) < n)
      .map(([key, n]) => `${key.replace("\t", "  ")} x${n} (listed: ${allowed.get(key) ?? 0})`);
    expect(unlisted).toEqual([]);
  });

  test("every listed site still exists, so a fixed one leaves the list", () => {
    const stale = ALLOWED.filter((a) => (hits.get(`${a.file}\t${a.pattern}`) ?? 0) < a.count).map(
      (a) => `${a.file}  ${a.pattern} x${a.count} (found: ${hits.get(`${a.file}\t${a.pattern}`) ?? 0})`,
    );
    expect(stale).toEqual([]);
  });

  test("a list entry names a real pattern, a reason and no duplicate", () => {
    const seen = new Set<string>();
    for (const a of ALLOWED) {
      expect(Object.keys(PATTERNS)).toContain(a.pattern);
      expect(a.why.length).toBeGreaterThan(10);
      const key = `${a.file}\t${a.pattern}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("the binary name is written in one place, bridge/host.ts", () => {
    expect([...hits.keys()].filter((k) => k.endsWith("\tbinaryNameJoin"))).toEqual([]);
    expect(readFileSync(join(ROOT, "bridge", "host.ts"), "utf8")).toContain("collie${host.exeSuffix}");
  });

  test("the patterns catch what they name", () => {
    expect(PATTERNS.startsWithSlash.test('if (p.startsWith("/")) return;')).toBe(true);
    expect(PATTERNS.splitOnSlash.test('const base = p.split("/").pop();')).toBe(true);
    expect(PATTERNS.urlPathname.test("const f = new URL(\"./x\", import.meta.url).pathname;")).toBe(true);
    expect(PATTERNS.binaryNameJoin.test('join(root, "bin", "collie")')).toBe(true);
    expect(PATTERNS.binaryNameJoin.test('join(root, "bin", "collie.new")')).toBe(false);
    expect(PATTERNS.startsWithSlash.test('p.startsWith("//")')).toBe(false);
  });
});

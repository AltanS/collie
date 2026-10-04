import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every write to a pane's keyboard starts the poll burst, because `sendKeys` and `sendReply` in
// lib/api.ts stamp it (see `withSendBurst` there). That holds only while every write goes THROUGH
// those two functions, so this scan pins the other half: no source file calls a `sendKeys(` or
// `sendReply(` it did not import from lib/api, and nothing else knows the two endpoints. A second
// door to the pane would be a write that leaves the card on a stale picture until the idle poll.

const SRC = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

/** The code of a file with whole-line comments dropped, so prose that names `sendKeys(` is not a call. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("every key and reply write goes through lib/api.ts", () => {
  const files = sourceFiles(SRC).filter((f) => relative(SRC, f) !== join("lib", "api.ts"));

  for (const name of ["sendKeys", "sendReply"]) {
    it(`${name}( is only called where it was imported from lib/api`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const code = codeOf(file);
        const calls = new RegExp(`(?<![.\\w])${name}\\(`).test(code);
        const viaNamespace = new RegExp(`\\bapi\\.${name}\\(`).test(code);
        if (!calls && !viaNamespace) continue;
        const importsIt = new RegExp(
          `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'](?:\\./|\\.\\./|@/lib/)(?:lib/)?api["']`,
        ).test(code);
        const importsNamespace = /import\s*\*\s*as\s+api\s+from\s*["']@\/lib\/api["']/.test(code);
        if (calls && !importsIt) offenders.push(`${relative(SRC, file)}: ${name}( without an import from lib/api`);
        if (viaNamespace && !importsNamespace) offenders.push(`${relative(SRC, file)}: api.${name}( without the lib/api namespace`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it("no other file addresses the keys or reply endpoint", () => {
    const offenders = files.filter((file) => /\/api\/pane\/[^"'`\n]*\/(keys|reply)\b/.test(codeOf(file)));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("the scan sees the files it is meant to guard", () => {
    const names = files.map((f) => relative(SRC, f));
    expect(names).toContain(join("lib", "dialog-guard.ts"));
    expect(names).toContain(join("components", "composer.tsx"));
  });
});

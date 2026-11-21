import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// EVERY DYNAMIC IMPORT OF THE APP IS ONE OF THE KNOWN DOORS (ADR 0169). A chunk the app loads on demand must
// survive an update under an open tab: it goes through `lazyScreen` (a route) or `lazyChunk` (any other door),
// both in lib/lazy-route.ts, which import through `reloadOnChunkError` and put the chunk on the idle preload.
// The doors that came before them load chunks a tab may never need, and each is listed below with its reason.
// A new `import(` anywhere else fails this test with its file and line.

const SRC = join(import.meta.dirname);

/** Files with dynamic imports of their own, and why they are neither `lazyScreen` nor `lazyChunk`. */
const OWN_DOORS = {
  "lib/i18n/index.ts": "a device needs one language: the other ten catalogs stay out of the preload; `reloadOnChunkError` covers a missing one",
  "lib/diff-highlight.ts": "the highlighter loads on the first diff, through `reloadOnChunkError`, and paints plain text until then",
  "lib/diff-highlight-engine.ts": "one grammar per language, loaded by the highlighter for the language a file needs",
  "lib/stt.ts": "the speech engine loads only when a person turns on the phone's engine (ADR 0096)",
  "lib/math/engine.ts": "a math engine is out of the precache and a device's opt-in; it loads by URL (lib/math/engine.ts)",
  "components/brand-mark.tsx": "a theme mark is out of the precache; the Collie mark draws until the chosen one is in",
  "components/icons/glyphs.ts": "a glyph set is out of the precache; lucide draws until the set is in (ADR 0137)",
  "components/report-door.tsx": "the report sheet loads on the first report tap; a failure there leaves the app as it was",
} satisfies Readonly<Record<string, string>>;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["playground", "test", "pick"].includes(entry.name) ? [] : sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$|\.d\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

/** The code of a file with its comments blanked, line breaks kept so a line number still points home. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Every runtime `import(` of a file, by line: not `typeof import(…)` and not a type `import("x").Name`. */
function dynamicImports(code: string): { line: number; text: string }[] {
  const lines = withoutComments(code).split("\n");
  return lines.flatMap((text, index) => {
    const hits = [...text.matchAll(/(?<![\w.$])import\(/g)].filter((m) => {
      const before = text.slice(0, m.index);
      const after = text.slice(m.index);
      if (/typeof\s+$/.test(before)) return false;
      return !/^import\(\s*["'][^"']*["']\s*\)\.(?!then\b)[A-Za-z_$]/.test(after);
    });
    return hits.length > 0 ? [{ line: index + 1, text: text.trim() }] : [];
  });
}

describe("dynamic imports", () => {
  it("are lazyScreen or lazyChunk doors, or one of the listed own doors", () => {
    const strays: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel in OWN_DOORS) continue;
      for (const hit of dynamicImports(readFileSync(file, "utf8"))) {
        if (/\blazy(Screen|Chunk)\(/.test(hit.text)) continue;
        strays.push(`${rel}:${String(hit.line)}: ${hit.text}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("lists no own door that holds no dynamic import any more", () => {
    const stale = Object.keys(OWN_DOORS).filter((rel) => dynamicImports(readFileSync(join(SRC, rel), "utf8")).length === 0);
    expect(stale).toEqual([]);
  });

  it("finds a stray import and passes a door", () => {
    expect(dynamicImports('const a = () => import("./x");')).toHaveLength(1);
    expect(dynamicImports('const b = lazyChunk(() => import("./x"));')).toHaveLength(1);
    expect(dynamicImports('type E = typeof import("./x");')).toEqual([]);
    expect(dynamicImports('let d: import("./x").Data;')).toEqual([]);
    expect(dynamicImports('// see import("./x")')).toEqual([]);
    expect(dynamicImports('const m = (await import("./x")).de;')).toHaveLength(1);
  });
});

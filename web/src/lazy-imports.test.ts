import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// EVERY DYNAMIC IMPORT OF THE APP IS ONE OF THE KNOWN DOORS (ADR 0169). A chunk the app loads on demand must
// survive an update under an open tab: it goes through `lazyScreen` (a route) or `lazyChunk` (any other door),
// both in lib/lazy-route.ts, which import through `reloadOnChunkError` and put the chunk on the idle preload.
// The doors that came before them load chunks a tab may never need, and each is listed below with its reason.
// A new `import(` anywhere else fails this test with its file and line.

const SRC = join(import.meta.dirname);

/**
 * The dynamic imports of their own, each keyed by `file: specifier`, and why each is neither `lazyScreen` nor
 * `lazyChunk`. A `*` in the specifier stands for one name of a family (one catalog per language); `(url)` is an
 * import of a computed URL. A new import in a listed file, of a module not listed, still fails.
 */
const OWN_DOORS = {
  "lib/i18n/index.ts: ./messages/*":
    "a device needs one language: the other ten catalogs stay out of the preload; `reloadOnChunkError` covers a missing one",
  "lib/diff-highlight.ts: @/lib/diff-highlight-engine":
    "the highlighter loads on the first diff, through `reloadOnChunkError`, and paints plain text until then",
  "lib/diff-highlight-engine.ts: sugar-high/lang/*": "one grammar per language, loaded by the highlighter for the language a file needs",
  "lib/stt.ts: @/lib/stt-engine": "the speech engine loads only when a person turns on the phone's engine (ADR 0096)",
  "lib/math/engine.ts: (url)": "a math engine is out of the precache and a device's opt-in; it loads by URL",
  "lib/math/engine.ts: ./math-markup": "the formula renderer loads with the first math engine, beside it",
  "components/brand-mark.tsx: ./*-mark": "a theme mark is out of the precache; the Collie mark draws until the chosen one is in",
  "components/icons/glyphs.ts: virtual:collie-glyphs/*": "a glyph set is out of the precache; lucide draws until the set is in (ADR 0137)",
  "components/report-door.tsx: @/components/report-sheet":
    "the report sheet loads on the first report tap; a failure there leaves the app as it was",
} satisfies Readonly<Record<string, string>>;

/** Whether `file: specifier` is one of OWN_DOORS. */
function ownDoorOf(file: string, specifier: string): string | null {
  for (const key of Object.keys(OWN_DOORS)) {
    const [doorFile, pattern] = key.split(": ");
    if (doorFile !== file || pattern === undefined) continue;
    const parts = pattern.split("*").map((part) => part.replace(/[.()]/g, "\\$&"));
    if (new RegExp(`^${parts.join("[\\w-]+")}$`).test(specifier)) return key;
  }
  return null;
}

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

/**
 * Every runtime `import(` of a file, by line, with its specifier: not `typeof import(…)` and not a type
 * `import("x").Name`. A specifier that is no string literal reads `(url)`.
 */
function dynamicImports(code: string): { line: number; text: string; specifier: string }[] {
  const lines = withoutComments(code).split("\n");
  return lines.flatMap((text, index) =>
    [...text.matchAll(/(?<![\w.$])import\(/g)].flatMap((m) => {
      const before = text.slice(0, m.index);
      const after = text.slice(m.index);
      if (/typeof\s+$/.test(before)) return [];
      if (/^import\(\s*["'][^"']*["']\s*\)\.(?!then\b)[A-Za-z_$]/.test(after)) return [];
      const literal = /^import\(\s*["'`]([^"'`$]*)["'`]\s*\)/.exec(after);
      return [{ line: index + 1, text: text.trim(), specifier: literal?.[1] ?? "(url)" }];
    }),
  );
}

describe("dynamic imports", () => {
  it("are lazyScreen or lazyChunk doors, or one of the listed own doors", () => {
    const strays: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      for (const hit of dynamicImports(readFileSync(file, "utf8"))) {
        if (/\blazy(Screen|Chunk)\(/.test(hit.text)) continue;
        if (ownDoorOf(rel, hit.specifier) !== null) continue;
        strays.push(`${rel}:${String(hit.line)}: ${hit.specifier}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("lists no own door that holds no such import any more", () => {
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      for (const hit of dynamicImports(readFileSync(file, "utf8"))) {
        const door = ownDoorOf(rel, hit.specifier);
        if (door !== null) used.add(door);
      }
    }
    expect(Object.keys(OWN_DOORS).filter((door) => !used.has(door))).toEqual([]);
  });

  it("keys a door by file and specifier", () => {
    expect(ownDoorOf("lib/i18n/index.ts", "./messages/zh-TW")).toBe("lib/i18n/index.ts: ./messages/*");
    // The same file, another module: a stray.
    expect(ownDoorOf("lib/i18n/index.ts", "@/routes/settings-sections")).toBeNull();
    expect(ownDoorOf("lib/i18n/index.ts", "./messages/de/extra")).toBeNull();
    // The same module, another file: a stray.
    expect(ownDoorOf("lib/stt-engine.ts", "@/lib/stt-engine")).toBeNull();
    expect(ownDoorOf("lib/math/engine.ts", "(url)")).toBe("lib/math/engine.ts: (url)");
  });

  it("finds a stray import and passes a door", () => {
    expect(dynamicImports('const a = () => import("./x");')).toEqual([{ line: 1, text: 'const a = () => import("./x");', specifier: "./x" }]);
    expect(dynamicImports("const u = import(/* @vite-ignore */ mounted(path));")[0]?.specifier).toBe("(url)");
    expect(dynamicImports('const b = lazyChunk(() => import("./x"));')).toHaveLength(1);
    expect(dynamicImports('type E = typeof import("./x");')).toEqual([]);
    expect(dynamicImports('let d: import("./x").Data;')).toEqual([]);
    expect(dynamicImports('// see import("./x")')).toEqual([]);
    expect(dynamicImports('const m = (await import("./x")).de;')).toHaveLength(1);
  });
});

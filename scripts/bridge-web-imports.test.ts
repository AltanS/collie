// The bridge and the CLI import a few pure modules from the web tree (`web/src/lib/...`), and two CI
// jobs ("typecheck + tests", "backend tests on the Bun floor") run them with ONLY the root install:
// no `web/node_modules`. So nothing those imports reach may need a web-only package. On
// release-1.29.0-edge.1 the trick layout imported one constant from `components/ui/diff-lines.tsx`,
// which imports `@/lib/utils`, which imports `clsx`: the root `tsc` and `bun test ./bridge` both
// failed on the runner and passed on every laptop that had run the web install.
//
// This test walks every import from every file under `bridge/` and `cli/`, following relative and
// `@/` (the web tree's alias) imports transitively, type-only ones included (`tsc` resolves those
// too), and fails on a reached file under `web/src/components/`, or on a bare package that only
// `web/package.json` declares. It reads source text, so it needs no install of its own.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WEB_SRC = join(ROOT, "web", "src");
const COMPONENTS = join(WEB_SRC, "components") + sep;
const ROOTS = ["bridge", "cli"];
const SOURCE = /\.(ts|tsx|mts|cts)$/;

function deps(path: string): Set<string> {
  // SAFETY: both files are this repository's own package.json; a missing field reads as no names.
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string> | undefined>;
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
}

const ROOT_DEPS = deps(join(ROOT, "package.json"));
const WEB_ONLY = new Set([...deps(join(ROOT, "web", "package.json"))].filter((name) => !ROOT_DEPS.has(name)));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Drop comments, so an import written in a doc comment is not followed. Strings stay as they are. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Every module specifier in a file: static imports and re-exports (type-only too), side-effect imports, `import()`, `require()`. */
function specifiers(text: string): string[] {
  const body = stripComments(text);
  const out: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of body.matchAll(pattern)) out.push(match[1]!);
  return out;
}

/** A relative or `@/` specifier to its file on disk, the way the bundler resolution finds it; undefined when it is not on disk. */
function resolveLocal(from: string, spec: string): string | undefined {
  const base = spec.startsWith("@/") ? join(WEB_SRC, spec.slice(2)) : resolve(dirname(from), spec);
  const stem = base.replace(/\.js$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

/** The package name of a bare specifier: `clsx`, `@scope/name`. */
function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

interface Finding {
  chain: string[];
  what: string;
}

interface Walk {
  findings: Finding[];
  reached: number;
}

function walk(): Walk {
  const seen = new Map<string, string[]>();
  const queue: string[] = [];
  for (const dir of ROOTS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      seen.set(file, [file]);
      queue.push(file);
    }
  }
  const findings: Finding[] = [];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!;
    const chain = seen.get(file)!;
    if (file.startsWith(COMPONENTS)) {
      findings.push({ chain, what: "a web component" });
      continue;
    }
    if (!SOURCE.test(file)) continue;
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        const target = resolveLocal(file, spec);
        if (target === undefined || seen.has(target)) continue;
        seen.set(target, [...chain, target]);
        queue.push(target);
        continue;
      }
      if (WEB_ONLY.has(packageName(spec))) findings.push({ chain, what: `the web-only package "${packageName(spec)}"` });
    }
  }
  return { findings, reached: seen.size };
}

describe("bridge and CLI imports stay within the root install", () => {
  test("the web-only package list is not empty (the guard reads web/package.json)", () => {
    expect(WEB_ONLY.has("clsx")).toBe(true);
    expect(WEB_ONLY.has("react")).toBe(false);
  });

  test("no file reachable from bridge/ or cli/ imports web/src/components/** or a package only web/ installs", () => {
    const { findings, reached } = walk();
    expect(reached).toBeGreaterThan(100);
    const lines = findings.map(({ chain, what }) => `${what}: ${chain.map((path) => relative(ROOT, path)).join(" -> ")}`);
    expect(lines).toEqual([]);
  });

  test("the walk follows @/ and relative imports into the web tree", () => {
    expect(resolveLocal(join(ROOT, "bridge", "x.ts"), "@/lib/tricks/layout")).toBe(join(WEB_SRC, "lib", "tricks", "layout.ts"));
    expect(resolveLocal(join(WEB_SRC, "lib", "tricks", "layout.ts"), "./schema")).toBe(join(WEB_SRC, "lib", "tricks", "schema.ts"));
    expect(specifiers('import type { A } from "./a";\nexport { b } from "@/b";\n// import c from "c";\nconst d = await import("./d");')).toEqual(["./a", "@/b", "./d"]);
  });
});

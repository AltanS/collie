import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { BOOTSTRAP_VERBS, bootstrapVerb, loadFailure } from "./main.ts";
import { COMMANDS } from "./program.ts";

// ── THE REGRESSION PIN ───────────────────────────────────────────────────────
// `collie build` is what runs `bun install`, so everything that reaches it has to run with no
// dependencies installed at all: `scripts/collie-ctl.sh` builds the binary from source on a fresh
// `herdr plugin install` checkout, and `pack add`'s install leg runs the same from-source build on a
// checkout `git fetch` has just advanced past its `node_modules`. That invariant was live but
// unpinned, and a top-level `import { Command } from "commander"` in this module's ancestor broke it
// in the field: every such install died with `Cannot find package 'commander'` before a line of
// Collie ran.
//
// So the invariant is asserted structurally rather than by executing a build in a sandbox: walk the
// STATIC import graph from `cli/main.ts` and require every specifier in it to be a builtin or a
// repo-relative file. Dynamic `import()` edges are deliberately not followed — being behind one is
// exactly what makes a package (commander, ink, react, web-push, qrcode-terminal) safe to depend on
// here, because the specifier is only resolved if that branch runs.

const CLI = import.meta.dir;
const REPO = resolve(CLI, "..");

/** Resolve a relative specifier to a file on disk, tolerating an extensionless one. */
function resolveFile(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
  }
  return null;
}

interface Closure {
  /** Every repo file reachable from the entry point through static imports. */
  readonly files: readonly string[];
  /** `<importer> -> <specifier>` for every static import of something that is not a repo file. */
  readonly packages: readonly string[];
  /** A relative specifier that resolved to nothing on disk — a broken edge, reported as one. */
  readonly unresolved: readonly string[];
}

function staticClosure(entry: string): Closure {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved = new Set<string>();
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
      // `scanImports` reports dynamic imports too; only the static ones cost a resolution at load.
      if (imported.kind !== "import-statement") continue;
      const spec = imported.path;
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      if (!spec.startsWith(".")) {
        packages.add(`${relative(REPO, file)} -> ${spec}`);
        continue;
      }
      const target = resolveFile(file, spec);
      if (target === null) unresolved.add(`${relative(REPO, file)} -> ${spec}`);
      else walk(target);
    }
  };
  walk(entry);
  return {
    files: [...files].map((f) => relative(REPO, f)),
    packages: [...packages],
    unresolved: [...unresolved],
  };
}

describe("the bare-checkout bootstrap", () => {
  const closure = staticClosure(resolve(CLI, "main.ts"));

  test("nothing on the path to `build` is a package — builtins and repo files only", () => {
    // If this fails, the named import is the one to move behind a dynamic `import()`. Do not
    // "fix" it by installing the dependency: the checkouts this protects have no node_modules.
    expect(closure.packages).toEqual([]);
  });

  test("every relative import in that closure resolves to a file", () => {
    expect(closure.unresolved).toEqual([]);
  });

  test("the closure really does reach the build and update implementations", () => {
    // Without this the assertion above would pass just as happily on an empty entry point.
    expect(closure.files).toContain("cli/build.ts");
    expect(closure.files).toContain("cli/update.ts");
    expect(closure.files).toContain("cli/lifecycle.ts");
  });

  test("the verb table is NOT in it — commander stays behind the dynamic import", () => {
    expect(closure.files).not.toContain("cli/program.ts");
  });

  test("every bootstrap verb is still declared in the table it bypasses", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const verb of BOOTSTRAP_VERBS) expect(names).toContain(verb);
  });
});

describe("the pre-dispatch", () => {
  test("routes the build verb, wherever `--plain` sits", () => {
    expect(bootstrapVerb(["build"])).toBe("build");
    expect(bootstrapVerb(["--plain", "build"])).toBe("build");
    expect(bootstrapVerb(["build", "--plain"])).toBe("build");
    expect(bootstrapVerb(["_apply-update"])).toBe("_apply-update");
  });

  test("routes nothing else — every other verb is the table's", () => {
    for (const argv of [[], ["status"], ["--plain"], ["pack", "add", "nas"], ["buildx"], [""]]) {
      expect(bootstrapVerb(argv)).toBeNull();
    }
  });

  test("a missing dependency tree is one legible line, not a module-resolution stack", () => {
    const err = new Error(`Cannot find package 'commander' from '${REPO}/cli/program.ts'`);
    expect(loadFailure(err)).toBe(
      "error: dependencies are not installed — run `collie build` (or bun install) first",
    );
    // Anything else still says what it was, rather than being mislabelled as a missing install.
    expect(loadFailure(new Error("boom"))).toBe("error: boom");
  });
});

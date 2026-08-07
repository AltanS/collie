import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolvePluginRoot } from "./root.ts";

// The checkout root is the anchor for web/dist, the manifest and the bridge source stamp. Getting it
// wrong under `bun build --compile` does not throw — it silently points at the embedded bundle and
// the PWA 503s — so the compiled shape is pinned here explicitly.

const CHECKOUT = "/home/tester/collie";
const MARKER = `${CHECKOUT}/herdr-plugin.toml`;

function resolve(opts: {
  env?: Record<string, string | undefined>;
  execPath: string;
  source: string | null;
  present?: string[];
}) {
  const files = new Set(opts.present ?? []);
  return resolvePluginRoot({
    env: opts.env ?? {},
    execPath: opts.execPath,
    source: opts.source,
    exists: (p) => files.has(p),
  });
}

describe("resolvePluginRoot", () => {
  test("source mode: the module's own directory's parent", () => {
    expect(
      resolve({
        execPath: "/home/tester/.bun/bin/bun",
        source: `${CHECKOUT}/bridge/root.ts`,
        present: [MARKER],
      }),
    ).toBe(CHECKOUT);
  });

  test("compiled: <root>/bin/collie resolves to <root>", () => {
    expect(
      resolve({
        execPath: `${CHECKOUT}/bin/collie`,
        // In a compiled binary the module's source path lives in the embedded filesystem…
        source: "/$bunfs/root/main",
        present: [MARKER],
      }),
    ).toBe(CHECKOUT);
  });

  test("the embedded root is rejected even though it reports as existing", () => {
    // …and `/$bunfs` is a REAL virtual filesystem inside the binary, so an existence check on the
    // source path answers true. Only the manifest — which the bundle does not carry — separates the
    // two, which is why the marker file and not a compiled-ness sniff decides this.
    expect(
      resolve({
        execPath: `${CHECKOUT}/bin/collie`,
        source: "/$bunfs/root/main",
        present: [MARKER, "/$bunfs/root/main", "/$bunfs/herdr-plugin.toml"],
      }),
    ).toBe(CHECKOUT);
  });

  test("COLLIE_PLUGIN_ROOT wins — the answer for a binary kept outside its checkout", () => {
    expect(
      resolve({
        env: { COLLIE_PLUGIN_ROOT: "/opt/collie" },
        execPath: `${CHECKOUT}/bin/collie`,
        source: `${CHECKOUT}/bridge/root.ts`,
        present: [MARKER],
      }),
    ).toBe("/opt/collie");
  });

  test("a relative or blank COLLIE_PLUGIN_ROOT is ignored, not half-honoured", () => {
    for (const bad of ["", "   ", "./collie"]) {
      expect(
        resolve({
          env: { COLLIE_PLUGIN_ROOT: bad },
          execPath: `${CHECKOUT}/bin/collie`,
          source: null,
          present: [MARKER],
        }),
      ).toBe(CHECKOUT);
    }
  });

  test("no checkout anywhere still returns a path — verbs report their own missing files", () => {
    expect(
      resolve({ execPath: "/opt/x/bin/collie", source: "/$bunfs/root/main", present: [] }),
    ).toBe("/opt/x");
  });
});

// The ban, enforced rather than remembered. `import.meta.dir` in shipped bridge or CLI code is a
// silent failure under `bun build --compile`: it resolves into the embedded bundle, so web/dist
// simply is not there and the PWA 503s with nothing in the logs pointing at the cause. Tests are
// exempt — they only ever run from the checkout, never from a compiled binary.
describe("the import.meta.dir ban", () => {
  const ROOT = join(import.meta.dir, "..");

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sources(p));
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  test("no shipped bridge/ or cli/ module resolves a path from its own directory", () => {
    const offenders: string[] = [];
    for (const file of [...sources(join(ROOT, "bridge")), ...sources(join(ROOT, "cli"))]) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const hit = line.indexOf("import.meta.dir");
        if (hit < 0) return;
        // A mention inside a `//` comment is documentation (root.ts explains the ban), not a use.
        const comment = line.indexOf("//");
        if (comment >= 0 && comment < hit) return;
        offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

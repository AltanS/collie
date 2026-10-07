import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// REMIX3.md, "Lists and keys": an `rmx-*` attribute WITHOUT the `data-` prefix type-checks (JSX
// accepts any hyphenated name) and the runtime ignores it. `rmx-key` is the trap: the row looks
// keyed and is not. The runtime reads `data-rmx-key`, `data-rmx-target`, `data-rmx-src`, ... only.
// This test fails on any JSX attribute that starts `rmx-`.

const SRC = join(import.meta.dir, "..");
const SELF = "lib/rmx-attributes.test.ts";

/** An attribute position: whitespace, then `rmx-name=`, never `data-rmx-name=`. */
const BARE_RMX_ATTRIBUTE = /(?<=\s)rmx-[a-z][a-z0-9-]*(?==)/gu;

/** `file:line: text` for every bare `rmx-*` attribute in `source`. Comment lines are skipped. */
export function bareRmxAttributes(file: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, index) => {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    for (const hit of line.matchAll(BARE_RMX_ATTRIBUTE)) found.push(`${file}:${String(index + 1)}: ${hit[0]}`);
  });
  return found;
}

describe("rmx attributes carry the data- prefix", () => {
  test("the detector flags a bare attribute and passes the prefixed one", () => {
    expect(bareRmxAttributes("a.tsx", '<div rmx-key="a" />')).toEqual(["a.tsx:1: rmx-key"]);
    expect(bareRmxAttributes("a.tsx", '<div\n  rmx-target="x"\n  class="y">')).toEqual(["a.tsx:2: rmx-target"]);
    expect(bareRmxAttributes("a.tsx", '<div data-rmx-key="a" data-rmx-target="x" />')).toEqual([]);
    expect(bareRmxAttributes("a.tsx", '<script id="rmx-data" />')).toEqual([]);
    expect(bareRmxAttributes("a.tsx", "// rmx-key=x is ignored")).toEqual([]);
  });

  test("no file under src/ writes one", () => {
    const hits: string[] = [];
    for (const name of new Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
      if (name === SELF) continue; // its fixtures are the bad examples
      hits.push(...bareRmxAttributes(name, readFileSync(join(SRC, name), "utf8")));
    }
    expect(hits).toEqual([]);
  });
});

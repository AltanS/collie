import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The guard that keeps multiplexer names out of the frontend's decisions (M10/06), tested the way
// CLAUDE.md asks any pattern-matching guard to be tested: a planted violation IN scope and a
// negative control OUT of it. A grep that matches nothing passes everything, and this file is the
// difference between "the check ran" and "the check works".

const SCRIPT = join(import.meta.dir, "check-mux-names.sh");

interface Run {
  code: number;
  out: string;
}

function run(target?: string): Run {
  const proc = Bun.spawnSync(["bash", SCRIPT, ...(target === undefined ? [] : [target])], {
    cwd: join(import.meta.dir, ".."),
  });
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

/**
 * A scratch tree, scanned as if it were `web/src`.
 *
 * Every tree gets one innocent source file alongside whatever the case plants, because a tree the
 * guard finds NOTHING to read in is refused outright (see the last case) — without it, "this file
 * was skipped" and "there was nothing to scan" would be the same exit code.
 */
function scan(fileName: string, contents: string): Run {
  const dir = mkdtempSync(join(tmpdir(), "collie-mux-names-"));
  try {
    writeFileSync(join(dir, "innocent.ts"), "export const ok = true;\n");
    writeFileSync(join(dir, fileName), contents);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-mux-names — the real tree", () => {
  test("web/src branches on no multiplexer name", () => {
    const { code, out } = run();
    expect(out).toContain("✓");
    expect(code).toBe(0);
  });

  test("the banned names are DERIVED from the adapters, so a fourth is covered on arrival", () => {
    // Printed on success precisely so the list can be read back — a guard whose alphabet is
    // invisible is a guard nobody notices going empty.
    const { out } = run();
    for (const name of ["herdr", "tmux", "zellij"]) expect(out).toContain(name);
  });
});

describe("check-mux-names — planted violations", () => {
  test("a comparison against a multiplexer name fails the check", () => {
    const { code, out } = scan("thing.ts", 'export const x = cfg.mux === "tmux";\n');
    expect(code).toBe(1);
    expect(out).toContain("hard-coded");
    expect(out).toContain("thing.ts");
  });

  test("every quote style is caught, and every registered name", () => {
    for (const line of [
      'const a = "herdr";',
      "const b = 'tmux';",
      "const c = `zellij`;",
      'const d = "Herdr";', // case is not a hiding place
    ]) {
      expect(scan("thing.ts", `${line}\n`).code).toBe(1);
    }
  });

  test("a .tsx component is scanned too — the branch usually lives there", () => {
    expect(scan("thing.tsx", 'if (name === "zellij") return null;\n').code).toBe(1);
  });
});

describe("check-mux-names — what is deliberately allowed", () => {
  test("prose keeps the word: a comment about a real bridge is documentation", () => {
    const src = "// Herdr never sets `truncated`, so tmux and zellij are not the odd ones out.\n";
    expect(scan("thing.ts", src).code).toBe(0);
  });

  test("an explanation sentence passes — it names the mux inside a longer string, and in practice arrives as data", () => {
    const src = 'export const copy = "tmux keeps no agent session log for Collie to read.";\n';
    expect(scan("thing.ts", src).code).toBe(0);
  });

  test("interpolating the name the bridge published is the sanctioned shape", () => {
    const src = "export const copy = (mux: string) => `${mux} cannot do this.`;\n";
    expect(scan("thing.ts", src).code).toBe(0);
  });

  test("tests may fabricate a named multiplexer — that is how the behaviour above is asserted", () => {
    expect(scan("thing.test.ts", 'const cfg = { name: "tmux" };\n').code).toBe(0);
    expect(scan("thing.test.tsx", 'const cfg = { name: "zellij" };\n').code).toBe(0);
  });

  test("an empty scan is refused, not passed — a guard with nothing to read proves nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-mux-names-empty-"));
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("no files to scan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

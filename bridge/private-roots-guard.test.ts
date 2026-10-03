import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PRIVATE_ROOTS } from "./acl-policy.ts";

// THE PRIVATE-ROOTS GUARD (M43 spec 04). On Windows a secret is private because it sits in a folder
// whose access list start-up made private (`PRIVATE_ROOTS`: the state folder and the config folder),
// and every file written there inherits that list. A `mode: 0o600` or a `0o700` folder anywhere else
// is a promise only POSIX keeps. So every such write site in `bridge/` and `cli/` must name a
// private root on its line or in the lines just above it (each root's `sourceNames`), or sit in
// ELSEWHERE with a one-line reason and a count per file. A new site fails this test; the fix is to
// write under the state or config folder, or to add the site here with the reason it is safe.
//
// The second test holds the temp-then-rename writes to the same rule: the temp file is a sibling of
// the target (`${target}.tmp`) or is joined onto the folder being written, so it is born inside the
// private folder and inherits its list, never in the system temp folder.

const ROOT = join(import.meta.dir, "..");
const SCANNED = ["bridge", "cli"];
/** How far above a site its private root may be named: the function that computes the path. */
const LOOK_BACK = 12;

const SITE = /mode: 0o700|mode: 0o600|[(,]\s*0o600\)|[(,]\s*0o700\)|BEACON_DIR_MODE\)/;

interface Elsewhere {
  readonly file: string;
  /** How many sites in the file are allowed. Any other number fails, up or down. */
  readonly count: number;
  readonly why: string;
}

const ELSEWHERE: readonly Elsewhere[] = [
  { file: "bridge/activity.ts", count: 2, why: "`this.dir` is `cfg.stateDir`, set in the constructor" },
  { file: "bridge/audit.ts", count: 1, why: "the appender is handed `<stateDir>/audit.log` by index.ts and cli/crew.ts" },
  { file: "bridge/config.ts", count: 1, why: "the POSIX mode rule tightens a config file in place; Windows reads its access list instead" },
  { file: "cli/context.ts", count: 1, why: "the POSIX mode rule tightens .env in place; Windows reads its access list instead" },
  { file: "cli/config.ts", count: 2, why: "`collie config set` writes config.toml into the config folder or ~/.collie, which the loader checks" },
  { file: "cli/hooks.ts", count: 2, why: "an agent's own settings file (~/.claude), not Collie's; documented as not covered" },
  { file: "cli/update.ts", count: 1, why: "the staging log is `stagingLogPath(deps.ctx.stateDir, runId)`, set further up the same function" },
  { file: "bridge/stt/local-cli.ts", count: 2, why: "one recording's mkdtemp folder under the OS temp dir, the user's own; removed in finally" },
  { file: "bridge/owner-only.ts", count: 2, why: "the private-folder code itself: the backup folder inside the state folder, and the folder being made private" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath, entry.name);
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (full: string): string => relative(ROOT, full).split(sep).join("/");

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rooted: boolean;
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const dir of SCANNED) {
    for (const full of sourceFiles(dir)) {
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((text, i) => {
        const code = text.replace(/\/\/.*$/, "");
        if (!SITE.test(code) || /^\s*\*/.test(text)) return;
        const context = lines.slice(Math.max(0, i - LOOK_BACK), i + 1).join("\n");
        out.push({ file: rel(full), line: i + 1, text: text.trim(), rooted: PRIVATE_ROOTS.some((r) => r.sourceNames.test(context)) });
      });
    }
  }
  return out;
}

describe("every private write lives under a private root", () => {
  test("a 0600 file or 0700 folder names the state or config folder, or is listed with its reason", () => {
    const loose = sites().filter((s) => !s.rooted);
    const byFile = new Map<string, Site[]>();
    for (const s of loose) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    const problems: string[] = [];
    for (const [file, list] of byFile) {
      const allowed = ELSEWHERE.find((e) => e.file === file);
      if (allowed === undefined) {
        problems.push(
          ...list.map(
            (s) =>
              `${s.file}:${String(s.line)} writes a private file outside the state and config folders (${s.text}). ` +
              "Write it under one of them, or list the file in ELSEWHERE in bridge/private-roots-guard.test.ts with the reason it is safe on Windows.",
          ),
        );
      } else if (allowed.count !== list.length) {
        problems.push(`${file}: ELSEWHERE allows ${String(allowed.count)} site(s), the file has ${String(list.length)}. Update the count.`);
      }
    }
    for (const e of ELSEWHERE) {
      if (!byFile.has(e.file)) problems.push(`${e.file}: listed in ELSEWHERE but has no unrooted site any more. Remove the entry.`);
    }
    expect(problems).toEqual([]);
  });

  test("the scan finds the known sites, so a broken pattern cannot pass by finding nothing", () => {
    const found = sites().map((s) => s.file);
    for (const file of ["bridge/push.ts", "bridge/pairing.ts", "bridge/crew/trust-store.ts", "cli/pairing.ts", "cli/push-keys.ts"]) {
      expect(found).toContain(file);
    }
  });

  test("a temp file for a temp-then-rename write is born inside the folder of its target", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const dir of SCANNED) {
      for (const full of sourceFiles(dir)) {
        readFileSync(full, "utf8")
          .split("\n")
          .forEach((text, i) => {
            const m = /const (tmp|temp|temporary)\s*=\s*(.+);$/.exec(text.trim());
            if (m === null) return;
            seen++;
            const expr = m[2]!;
            const sibling = /^`\$\{[\w.]+\}\.[^`/\\]*`$/.test(expr);
            const joined = /^join\(\s*(dir|\w*Dir)\b/.test(expr);
            if (!sibling && !joined) bad.push(`${rel(full)}:${String(i + 1)} ${text.trim()}`);
          });
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});

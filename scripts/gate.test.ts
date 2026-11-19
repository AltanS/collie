// The rules that join `scripts/test-sets.ts` to the repo: which tests are near a change, which paths
// wake a CI job, and that the lists name files that exist. A list that drifts from the tree fails here.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changedPaths, decide } from "./ci-changes.ts";
import {
  BUN_NEAR_AREAS,
  FROZEN_BUN_IGNORE,
  FROZEN_PATHS,
  GUARD_BUN,
  GUARD_BUN_NAMED,
  GUARD_SCRIPTS,
  GUARD_WEB,
  IGNORE_ALWAYS,
  SHELL_NEAR_AREAS,
  capNames,
  gateFooter,
  isExcludedFromNear,
  nearReport,
  nearTests,
  slowNearTests,
  stemOf,
  wakes,
  withoutNearTest,
} from "./test-sets.ts";

const ROOT = join(import.meta.dir, "..");

function trackedFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT });
  return listed.stdout.toString().split("\n").filter((file) => file !== "");
}

describe("near tests", () => {
  const all = [
    "bridge/foo.ts",
    "bridge/foo.test.ts",
    "bridge/foo.part.test.ts",
    "bridge/foo.slow.test.ts",
    "bridge/foo.quarantine.test.ts",
    "bridge/foo.rig.ts",
    "bridge/foobar.test.ts",
    "bridge/other.test.ts",
    "bridge/sub/foo.test.ts",
    "cli/run.sh",
    "cli/run.test.sh",
    "web/src/foo.test.tsx",
    "web/src/foo.tsx",
  ];

  test("a source file picks its own tests and its parts, in its own folder only", () => {
    expect(nearTests(["bridge/foo.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/foo.part.test.ts", "bridge/foo.test.ts"]);
  });

  test("a changed test file picks itself and the parts beside it", () => {
    expect(nearTests(["bridge/other.test.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/other.test.ts"]);
    expect(nearTests(["bridge/foo.part.test.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/foo.part.test.ts", "bridge/foo.test.ts"]);
  });

  test("a slow or quarantined file is never picked, not even when it is the changed file", () => {
    expect(nearTests(["bridge/foo.slow.test.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/foo.part.test.ts", "bridge/foo.test.ts"]);
    expect(isExcludedFromNear("bridge/foo.quarantine.test.ts")).toBe(true);
    expect(isExcludedFromNear("bridge/foo.test.ts")).toBe(false);
  });

  test("a changed rig beside a test and its slow file picks the quick tests only", () => {
    expect(nearTests(["bridge/foo.rig.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/foo.part.test.ts", "bridge/foo.test.ts"]);
  });

  test("a file outside the bun areas, or one that does not exist, picks nothing", () => {
    expect(nearTests(["web/src/foo.tsx"], all, BUN_NEAR_AREAS, "bun")).toEqual([]);
    expect(nearTests(["bridge/gone.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual([]);
  });

  test("shell tests are picked by the same rule, and only as shell", () => {
    expect(nearTests(["cli/run.sh"], all, SHELL_NEAR_AREAS, "shell")).toEqual(["cli/run.test.sh"]);
    expect(nearTests(["cli/run.sh"], all, BUN_NEAR_AREAS, "bun")).toEqual([]);
  });

  test("the stem is the name up to the first dot", () => {
    expect(stemOf("bridge/surface/protocol.not-sure.test.ts")).toBe("protocol");
    expect(stemOf("cli/Makefile")).toBe("Makefile");
  });
});

describe("the CI job paths", () => {
  test("a docs-only change wakes no heavy job", () => {
    expect(decide("pull_request", ["README.md", "docs/crew.md"])).toEqual(["frozen=false", "bun_floor=false", "durable=false", "swap=false"]);
  });

  test("each frozen path wakes the frozen tests and nothing else of the four", () => {
    for (const file of ["cli/harness-link.ts", "bridge/inside/hub.ts", "web/e2e/rig/rig.ts", "scripts/harness-canary/run.ts", "inside/claude/hooks/core.ts"]) {
      expect(decide("push", [file])).toEqual(["frozen=true", "bun_floor=false", "durable=false", "swap=false"]);
    }
  });

  test("a nightly run, a manual run and an unknown diff run every job", () => {
    const every = ["frozen=true", "bun_floor=true", "durable=true", "swap=true"];
    expect(decide("schedule", [])).toEqual(every);
    expect(decide("workflow_dispatch", ["README.md"])).toEqual(every);
    expect(decide("push", null)).toEqual(every);
  });

  test("the floor, the durable example and the swap specs each wake on their own paths", () => {
    expect(wakes("bunFloor", ["cli/update-check.ts"])).toBe(true);
    expect(wakes("durable", ["examples/durable-member/package.json"])).toBe(true);
    expect(wakes("swap", ["web/src/sw.ts"])).toBe(true);
    expect(wakes("swap", ["web/src/lib/update-run-store.ts"])).toBe(true);
    expect(wakes("swap", ["web/src/components/agent-card.tsx"])).toBe(false);
  });

  test("a change to ci.yml or the lists wakes every job", () => {
    for (const file of [".github/workflows/ci.yml", "scripts/test-sets.ts"]) {
      expect(decide("pull_request", [file])).toEqual(["frozen=true", "bun_floor=true", "durable=true", "swap=true"]);
    }
  });
});

describe("changedPaths", () => {
  const head = "HEAD";

  test("an all-zero base (a new branch) is unknown, so every job runs", () => {
    expect(changedPaths("0".repeat(40), head)).toBeNull();
  });

  test("an empty base or head is unknown", () => {
    expect(changedPaths("", head)).toBeNull();
    expect(changedPaths("HEAD~1", "")).toBeNull();
  });

  test("a base that is not in the repo (a force push, a shallow clone) is unknown", () => {
    expect(changedPaths("deadbeef".repeat(5), head)).toBeNull();
  });

  // In a repo of its own: CI checks out one commit, so this repo has no HEAD~1 there.
  test("two real commits give the paths the second one changed", () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-changes-"));
    try {
      const git = (...args: string[]): void => {
        const done = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
        if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
      };
      git("init", "-q");
      writeFileSync(join(repo, "a.txt"), "a\n");
      git("add", "a.txt");
      git("commit", "-q", "-m", "one");
      writeFileSync(join(repo, "b.txt"), "b\n");
      git("add", "b.txt");
      git("commit", "-q", "-m", "two");
      expect(changedPaths("HEAD~1", "HEAD", repo)).toEqual(["b.txt"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("what the gate did not run", () => {
  const all = [
    "bridge/foo.ts",
    "bridge/foo.test.ts",
    "bridge/foo.slow.test.ts",
    "bridge/lonely.ts",
    "bridge/slowonly.ts",
    "bridge/slowonly.slow.test.ts",
    "bridge/types.d.ts",
    "bridge/data.json",
    "bridge/quar.ts",
    "bridge/quar.quarantine.test.ts",
    "cli/run.sh",
    "cli/run.test.sh",
    "web/src/foo.tsx",
  ];

  test("a source file with no test of any kind is listed, one with a quick or a slow test is not", () => {
    const changed = ["bridge/foo.ts", "bridge/lonely.ts", "bridge/slowonly.ts", "cli/run.sh"];
    expect(withoutNearTest(changed, all, SHELL_NEAR_AREAS)).toEqual(["bridge/lonely.ts"]);
  });

  test("a quarantined test does not count as a near test", () => {
    expect(withoutNearTest(["bridge/quar.ts"], all, SHELL_NEAR_AREAS)).toEqual(["bridge/quar.ts"]);
  });

  test("a test file, a declaration, data, a web file and a deleted file are never listed", () => {
    const changed = ["bridge/foo.test.ts", "bridge/types.d.ts", "bridge/data.json", "web/src/foo.tsx", "bridge/gone.ts"];
    expect(withoutNearTest(changed, all, SHELL_NEAR_AREAS)).toEqual([]);
  });

  test("the slow files near a change are the ones the quick selection left out", () => {
    expect(slowNearTests(["bridge/foo.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/foo.slow.test.ts"]);
    expect(slowNearTests(["bridge/slowonly.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/slowonly.slow.test.ts"]);
    expect(slowNearTests(["bridge/foo.slow.test.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual(["bridge/foo.slow.test.ts"]);
    expect(slowNearTests(["bridge/lonely.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual([]);
    expect(slowNearTests(["bridge/quar.ts"], all, BUN_NEAR_AREAS, "bun")).toEqual([]);
    expect(slowNearTests(["cli/run.sh"], all, SHELL_NEAR_AREAS, "shell")).toEqual([]);
  });

  test("the report counts the quick files and carries both lists", () => {
    expect(nearReport(["bridge/foo.ts", "bridge/lonely.ts", "cli/run.sh"], all)).toEqual({
      bunFiles: 1,
      shellFiles: 1,
      noNearTest: ["bridge/lonely.ts"],
      slowNear: ["bridge/foo.slow.test.ts"],
    });
  });

  const names = Array.from({ length: 13 }, (_, index) => `f${index}.ts`);

  test("a list of names is cut at ten, with the rest counted", () => {
    expect(capNames(names.slice(0, 10))).toBe(names.slice(0, 10).join(", "));
    expect(capNames(names)).toBe(`${names.slice(0, 10).join(", ")} and 3 more`);
  });

  test("the footer names each gap, and always ends with what only CI runs", () => {
    const quiet = gateFooter({ bunFiles: 3, shellFiles: 0, noNearTest: [], slowNear: [] });
    expect(quiet[0]).toBe("near tests: 3 bun files, web via vitest --changed");
    expect(quiet).toHaveLength(2);
    const loud = gateFooter({ bunFiles: 0, shellFiles: 2, noNearTest: ["bridge/lonely.ts"], slowNear: ["bridge/foo.slow.test.ts"] });
    expect(loud).toEqual([
      "near tests: 0 bun files, 2 shell files, web via vitest --changed",
      "no near test for: bridge/lonely.ts",
      "slow tests near the change, not run: bridge/foo.slow.test.ts",
      "run them: bun test bridge/foo.slow.test.ts",
      loud.at(-1) ?? "",
    ]);
    for (const lines of [quiet, loud]) expect(lines.at(-1)).toStartWith("not run here: the full suites, Windows, WebKit; CI runs them");
    expect(gateFooter(null)).toHaveLength(1);
    const many = gateFooter({ bunFiles: 1, shellFiles: 0, noNearTest: [], slowNear: names.map((name) => name.replace(".ts", ".slow.test.ts")) });
    expect(many.at(-2)).toStartWith("run them: bun test .slow.test");
  });
});

describe("the frozen tests", () => {
  const tracked = trackedFiles();
  const backendTests = tracked.filter((file) => BUN_NEAR_AREAS.some((area) => file.startsWith(`${area}/`)) && /\.test\.(ts|sh)$/.test(file));
  const ignored = (file: string) => FROZEN_BUN_IGNORE.some((glob) => new Bun.Glob(glob).match(file));
  const frozen = (file: string) => FROZEN_PATHS.some((pattern) => pattern.test(file));

  test("the CI skip list and the path list name the same backend test files", () => {
    expect(backendTests.filter((file) => ignored(file) !== frozen(file))).toEqual([]);
  });

  test("the skip list names at least one file per glob, so a rename does not empty it", () => {
    for (const glob of FROZEN_BUN_IGNORE) {
      expect(tracked.some((file) => new Bun.Glob(glob).match(file))).toBe(true);
    }
  });
});

describe("the guard lists", () => {
  test("every guard names a file or a script that exists, and none is slow, quarantined or frozen", () => {
    const files = [...GUARD_BUN.map(([file]) => file), ...GUARD_BUN_NAMED.map(([file]) => file)];
    for (const file of files) {
      expect(existsSync(join(ROOT, file))).toBe(true);
      expect(isExcludedFromNear(file)).toBe(false);
      expect(FROZEN_PATHS.some((pattern) => pattern.test(file))).toBe(false);
    }
    for (const [file] of GUARD_WEB) expect(existsSync(join(ROOT, "web", file))).toBe(true);
    for (const [command] of GUARD_SCRIPTS) expect(existsSync(join(ROOT, command[1] ?? ""))).toBe(true);
  });

  test("a guard is listed once", () => {
    const names = [...GUARD_BUN.map(([file]) => file), ...GUARD_WEB.map(([file]) => `web/${file}`)];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("bunfig.toml", () => {
  test("its ignore list is the one the CLI runs restate", () => {
    const parsed = Bun.TOML.parse(readFileSync(join(ROOT, "bunfig.toml"), "utf8"));
    expect(parsed).toMatchObject({ test: { pathIgnorePatterns: IGNORE_ALWAYS } });
  });
});

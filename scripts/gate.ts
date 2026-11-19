// `bun run gate`: the quick check to run before a commit or a push. About three minutes on an idle
// machine for a small change. The full suites run in CI.
//
//   bun run gate           typecheck, lint, the guard tests, and the tests near the change
//   bun run gate --full    the same, with the full suites in place of the near tests (what CI runs)
//   bun run gate --base <ref>   compare with another ref than the merge base with origin/main
//
// Steps run in three stages, and the steps of one stage run side by side:
//   1. static      typecheck (root), typecheck (web), lint
//   2. guards      the repo-rule tests that read source (`GUARD_*` in scripts/test-sets.ts), always
//   3. near tests  the tests of the files you changed; or, with --full, every suite
//
// Near tests: for each changed file in bridge, cli, scripts, herdr-app-mod and omp-extension, the
// changed test file itself, and the tests in the same folder named after a changed source file
// (`foo.ts` gives `foo.test.ts` and `foo.part.test.ts`). In `web/`, `vitest --changed <base>` runs the
// files whose imports reach a change. `*.slow.test.*` and `*.quarantine.test.*` are left out.
//
// Escape hatches, the same names the git hooks use: SKIP_TYPECHECK=1 leaves out both typechecks,
// SKIP_LINT_CHECK=1 the lint, SKIP_TESTS=1 the guards and the tests. The pre-push hook runs this
// script, so `SKIP_TESTS=1 git push` still skips the tests.
//
// Exit code 0 when every step passed. Output of a step is shown only when it fails. A quick run ends
// with a footer that names what it did not run: changed files with no near test, slow tests near the
// change, and the suites that only CI runs.

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  BUN_NEAR_AREAS,
  GUARD_BUN,
  GUARD_BUN_NAMED,
  GUARD_SCRIPTS,
  GUARD_WEB,
  SHELL_NEAR_AREAS,
  gateFooter,
  nearReport,
  nearTests,
} from "./test-sets.ts";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "web");

interface Step {
  name: string;
  /** Commands that run one after another; the step stops at the first failure. */
  commands: readonly (readonly string[])[];
  cwd?: string;
  env?: Record<string, string>;
}

interface Outcome {
  name: string;
  status: "pass" | "fail" | "skip";
  seconds: number;
  note: string;
  output: string;
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** The merge base with origin/main, or "" when this checkout has no origin/main. */
function mergeBase(ref: string): string {
  return git("merge-base", ref, "HEAD");
}

/** Committed since the base, staged, unstaged and untracked. Deleted files are left out. */
function changedFiles(base: string): string[] {
  const tracked = git("diff", "--name-only", "--diff-filter=ACMR", base).split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked])].filter((file) => file !== "").toSorted();
}

function allFiles(): string[] {
  return git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter((file) => file !== "");
}

function runStep(step: Step): Promise<Outcome> {
  const started = performance.now();
  const chunks: string[] = [];
  const finish = (status: "pass" | "fail", note: string): Outcome => ({
    name: step.name,
    status,
    seconds: (performance.now() - started) / 1000,
    note,
    output: chunks.join(""),
  });
  const runCommand = (command: readonly string[]): Promise<number> =>
    new Promise((resolve) => {
      const [bin, ...args] = command;
      chunks.push(`$ ${command.join(" ")}\n`);
      const child = spawn(bin ?? "", args, {
        cwd: step.cwd ?? ROOT,
        env: { ...process.env, ...step.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
      child.stderr.on("data", (data: Buffer) => chunks.push(data.toString()));
      child.on("error", (error) => {
        chunks.push(`${error.message}\n`);
        resolve(1);
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
  return (async () => {
    for (const command of step.commands) {
      const code = await runCommand(command);
      if (code !== 0) return finish("fail", `exit ${code}`);
    }
    return finish("pass", "");
  })();
}

function skipped(name: string, note: string): Outcome {
  return { name, status: "skip", seconds: 0, note, output: "" };
}

/** A step, or its skipped outcome when the person set the escape hatch for it. */
function unlessSkipped(hatch: string, step: Step): Step | Outcome {
  return process.env[hatch] === "1" ? skipped(step.name, `${hatch}=1`) : step;
}

async function runStage(title: string, steps: readonly (Step | Outcome)[]): Promise<Outcome[]> {
  console.log(`\n== ${title}`);
  const runs = steps.map(async (step) => {
    const outcome = "commands" in step ? await runStep(step) : step;
    console.log(`  ${mark(outcome)} ${outcome.name} (${outcome.seconds.toFixed(1)}s)${outcome.note === "" ? "" : ` ${outcome.note}`}`);
    return outcome;
  });
  return Promise.all(runs);
}

function mark(outcome: Outcome): string {
  if (outcome.status === "pass") return "ok  ";
  if (outcome.status === "skip") return "skip";
  return "FAIL";
}

function tail(output: string, lines: number): string {
  const all = output.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function guardSteps(): Step[] {
  const files = GUARD_BUN.map(([file]) => `./${file}`);
  const named = GUARD_BUN_NAMED.map(([file, name]): Step["commands"][number] => ["bun", "test", `./${file}`, "-t", name]);
  return [
    { name: "guards (bun tests)", commands: [["bun", "test", ...files], ...named] },
    { name: "guards (web tests)", cwd: WEB, commands: [["bunx", "vitest", "run", ...GUARD_WEB.map(([file]) => file)]] },
    { name: "guards (scripts)", commands: GUARD_SCRIPTS.map(([command]) => command) },
  ];
}

function nearSteps(base: string, changed: readonly string[]): (Step | Outcome)[] {
  const all = allFiles();
  const bunFiles = nearTests(changed, all, BUN_NEAR_AREAS, "bun");
  const shellFiles = nearTests(changed, all, SHELL_NEAR_AREAS, "shell");
  const bunStep: Step | Outcome =
    bunFiles.length === 0
      ? skipped("near tests (bun)", "no bun test near the change")
      : { name: `near tests (bun, ${bunFiles.length} files)`, commands: [["bun", "test", ...bunFiles.map((file) => `./${file}`)]] };
  const shellStep: Step | Outcome =
    shellFiles.length === 0
      ? skipped("near tests (shell)", "no shell test near the change")
      : { name: `near tests (shell, ${shellFiles.length} files)`, commands: shellFiles.map((file) => ["bash", file]) };
  const webStep: Step = {
    name: "near tests (web, vitest --changed)",
    cwd: WEB,
    env: { COLLIE_SKIP_SLOW: "1" },
    commands: [["bunx", "vitest", "run", "--changed", base, "--passWithNoTests", "--reporter=dot"]],
  };
  return [bunStep, shellStep, webStep];
}

function fullSteps(): Step[] {
  return [
    { name: "full suite (bun and shell, bun run test)", commands: [["bun", "scripts/test.ts"]] },
    { name: "full suite (web, vitest)", cwd: WEB, commands: [["bunx", "vitest", "run", "--reporter=dot"]] },
  ];
}

interface GateArgs {
  full: boolean;
  baseRef: string;
}

function parseArgs(argv: readonly string[]): GateArgs {
  let full = false;
  let baseRef = "origin/main";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--full") full = true;
    else if (arg === "--base") baseRef = argv[++index] ?? "";
    else throw new Error(`gate: unknown argument ${arg ?? ""}. Use --full or --base <ref>.`);
  }
  if (baseRef === "") throw new Error("gate: --base needs a ref");
  return { full, baseRef };
}

async function main(): Promise<number> {
  const { full: fullFlag, baseRef } = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const base = mergeBase(baseRef);
  // With nothing to compare against, the near tests cannot be chosen: run the full suites instead.
  const full = fullFlag || base === "";
  const changed = base === "" ? [] : changedFiles(base);
  const mode = fullFlag ? "full suites" : base === "" ? `full suites (no ${baseRef} to compare with)` : "near tests";
  console.log(`gate: ${mode}${base === "" ? "" : `, base ${base.slice(0, 9)}, ${changed.length} changed files`}`);

  const outcomes: Outcome[] = [];
  outcomes.push(
    ...(await runStage("static", [
      unlessSkipped("SKIP_TYPECHECK", { name: "typecheck (root)", commands: [["bun", "run", "typecheck"]] }),
      unlessSkipped("SKIP_TYPECHECK", { name: "typecheck (web)", cwd: WEB, commands: [["bun", "run", "typecheck"]] }),
      unlessSkipped("SKIP_LINT_CHECK", { name: "lint", commands: [["bun", "run", "lint"]] }),
    ])),
  );
  if (process.env.SKIP_TESTS === "1") {
    console.log("\n== guards and tests\n  skip SKIP_TESTS=1");
  } else {
    outcomes.push(...(await runStage("guards", guardSteps())));
    outcomes.push(...(await runStage(full ? "full suites" : "near tests", full ? fullSteps() : nearSteps(base, changed))));
  }

  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  for (const outcome of failed) {
    console.log(`\n---- ${outcome.name}: last 80 lines ----\n${tail(outcome.output, 80)}`);
  }
  const width = Math.max(...outcomes.map((outcome) => outcome.name.length));
  console.log("\nsummary");
  for (const outcome of outcomes) {
    console.log(`  ${outcome.name.padEnd(width)}  ${outcome.status.padEnd(4)}  ${outcome.seconds.toFixed(1).padStart(6)}s`);
  }
  const wall = (performance.now() - started) / 1000;
  const sum = outcomes.reduce((total, outcome) => total + outcome.seconds, 0);
  console.log(`  ${"total".padEnd(width)}  ${failed.length === 0 ? "pass" : "FAIL"}  ${wall.toFixed(1).padStart(6)}s wall, ${sum.toFixed(0)}s of step time`);
  if (!full) {
    const report = process.env.SKIP_TESTS === "1" ? null : nearReport(changed, allFiles());
    console.log(`\n${gateFooter(report).join("\n")}`);
  }
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());

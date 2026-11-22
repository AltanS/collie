// `bun run test`: the whole backend suite, one command after another, stopping at the first one that
// fails. It was a chain of `&&` in package.json; it is a script so the CI test job can leave the
// frozen tests out (`--skip-frozen`, see `FROZEN_PATHS` in `scripts/test-sets.ts`) and the quarantine
// job can run only the quarantined files (`--quarantine`).
//
//   bun run test                  every suite, as before
//   bun run test --skip-frozen    the same without the frozen tests (CI, when no frozen path changed)
//   bun run test --quarantine     only `*.quarantine.test.*` files, bun and web, for the non-blocking CI
//                                 job; no such file is a pass

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { FROZEN_BUN_IGNORE, IGNORE_ALWAYS, IGNORE_ENGINE_TESTS, ignoreFlags } from "./test-sets.ts";

const ROOT = join(import.meta.dir, "..");

const BUN_SUITES = ["./bridge", "./cli", "./scripts", "./herdr-app-mod", "./omp-extension", "./pi-extension"];
const SHELL_SUITES = [
  "scripts/collie-ctl.test.sh",
  "scripts/collie-cli.test.sh",
  "scripts/check-payload-links.test.sh",
  "scripts/upstream-bun.test.sh",
  "scripts/check-tag.test.sh",
  "scripts/check-flake-lock.test.sh",
  "scripts/pre-commit.test.sh",
  "packaging/aur/pkgbuild.test.sh",
  "packaging/refresh.test.sh",
];

function run(command: readonly string[], cwd: string, env: Record<string, string> = {}): number {
  console.log(`\n$ ${command.join(" ")}`);
  const [bin, ...args] = command;
  const result = spawnSync(bin ?? "", args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  return result.status ?? 1;
}

function quarantineFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.quarantine.test.*"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listed.stdout.split("\n").filter((file) => file !== "");
}

function quarantine(): number {
  const files = quarantineFiles();
  if (files.length === 0) {
    console.log("quarantine: no *.quarantine.test.* file in the tree, nothing to run");
    return 0;
  }
  const web = files.filter((file) => file.startsWith("web/")).map((file) => file.slice("web/".length));
  const backend = files.filter((file) => !file.startsWith("web/")).map((file) => `./${file}`);
  let failed = 0;
  // The flag replaces the list in bunfig.toml, which holds the quarantine pattern, so restate the rest.
  if (backend.length > 0) failed += run(["bun", "test", ...ignoreFlags(IGNORE_ENGINE_TESTS), ...backend], ROOT) === 0 ? 0 : 1;
  if (web.length > 0) failed += run(["bunx", "vitest", "run", ...web], join(ROOT, "web"), { COLLIE_QUARANTINE: "only" }) === 0 ? 0 : 1;
  return failed;
}

function suites(skipFrozen: boolean): number {
  // With no flag the run is the one bunfig.toml sets up. The ignore list is restated only to add
  // the frozen paths, because the flag replaces the file's list.
  const ignore = skipFrozen ? ignoreFlags([...IGNORE_ALWAYS, ...FROZEN_BUN_IGNORE]) : [];
  for (const suite of BUN_SUITES) {
    const status = run(["bun", "test", suite, ...ignore], ROOT);
    if (status !== 0) return status;
  }
  for (const suite of SHELL_SUITES) {
    const status = run(["bash", suite], ROOT);
    if (status !== 0) return status;
  }
  return 0;
}

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--skip-frozen" && arg !== "--quarantine");
if (unknown.length > 0) {
  console.error(`test: unknown argument ${unknown.join(" ")}`);
  process.exit(2);
}

process.exit(args.includes("--quarantine") ? quarantine() : suites(args.includes("--skip-frozen")));

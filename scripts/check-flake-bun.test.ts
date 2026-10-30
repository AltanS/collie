import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The flake's pinned Bun and MIN_BUN are two statements about ONE fact: the Bun this tree is built
// and measured on. If the flake ever pins a Bun BELOW MIN_BUN, the preflight warns the operator
// about the very Bun the release was built with — a check that calls its own build stale. So the
// two are read straight out of the files that hold them and compared here.

const ROOT = join(import.meta.dir, "..");

/** The pinned Bun, from the one line in flake.nix that states it. */
function flakeBunVersion(): string {
  const source = readFileSync(join(ROOT, "flake.nix"), "utf8");
  const match = /^\s*bunVersion\s*=\s*"([^"]+)";/m.exec(source);
  if (match === null) {
    throw new Error("flake.nix no longer declares `bunVersion = \"x.y.z\";` — this test reads that line");
  }
  return match[1]!;
}

/** MIN_BUN, from cli/update-check.ts. Read as text: the constant is module-private on purpose. */
function minBun(): string {
  const source = readFileSync(join(ROOT, "cli", "update-check.ts"), "utf8");
  const match = /^const MIN_BUN\s*=\s*"([^"]+)";/m.exec(source);
  if (match === null) {
    throw new Error("cli/update-check.ts no longer declares `const MIN_BUN = \"x.y.z\";`");
  }
  return match[1]!;
}

/** -1, 0 or 1. Numeric per component, so 1.10.0 sorts above 1.9.0 rather than below it. */
function compare(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

describe("flake.nix and MIN_BUN", () => {
  test("the flake pins a Bun at least MIN_BUN", () => {
    const pinned = flakeBunVersion();
    const floor = minBun();
    expect(compare(pinned, floor)).toBeGreaterThanOrEqual(0);
  });

  test("both versions are plain three-part numbers", () => {
    // A range, a tag or a `latest` in either place would make the comparison above meaningless.
    expect(flakeBunVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(minBun()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the archive URLs the flake fetches carry the pinned version", () => {
    // The version and the three sources are one pin. A `version` bumped without new hashes would
    // fetch the old archives under the new name, and every claim above it would be a lie.
    const source = readFileSync(join(ROOT, "flake.nix"), "utf8");
    const urls = [...source.matchAll(/url = "([^"]*oven-sh\/bun[^"]*)";/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toContain("bun-v${finalAttrs.version}");
    }
  });

  test("the nixpkgs revision in flake.nix is the one flake.lock recorded", () => {
    // `inputs.nixpkgs.url` and the lock are one pin written twice, and only the LOCK is what `nix
    // build` fetches. Editing the rev without running `nix flake lock` therefore builds the old
    // nixpkgs under a new commit id, and the release would name a toolchain it did not use.
    const declared = /inputs\.nixpkgs\.url = "github:NixOS\/nixpkgs\/([0-9a-f]{40})";/.exec(
      readFileSync(join(ROOT, "flake.nix"), "utf8"),
    );
    if (declared === null) {
      throw new Error("flake.nix no longer pins nixpkgs by a 40-character revision — this test reads that line");
    }
    // SAFETY: the shape is asserted, not trusted — every step to `rev` is optional, so a lock that
    // does not have it reads as `undefined` and fails the comparison below rather than throwing.
    const lock = JSON.parse(readFileSync(join(ROOT, "flake.lock"), "utf8")) as {
      nodes: { nixpkgs?: { locked?: { rev?: string } } };
    };
    expect(lock.nodes.nixpkgs?.locked?.rev).toBe(declared[1]!);
  });

  test("compare orders versions numerically, not as text", () => {
    expect(compare("1.10.0", "1.9.0")).toBe(1);
    expect(compare("1.3.14", "1.3.14")).toBe(0);
    expect(compare("1.3.13", "1.3.14")).toBe(-1);
    expect(compare("1.4", "1.4.0")).toBe(0);
  });
});

describe("the floor job runs MIN_BUN", () => {
  test("ci.yml has a bun-floor job that sets up exactly MIN_BUN and runs the three backend suites", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    // SAFETY: `Bun.YAML.parse` answers plain data; the fields read are compared against strings.
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, { needs?: unknown; if?: unknown; "continue-on-error"?: unknown; steps: { uses?: string; run?: string; if?: unknown; "continue-on-error"?: unknown; with?: Record<string, string> }[] }>;
    };
    const job = parsed.jobs["bun-floor"];
    expect(job).toBeDefined();
    expect(job!.needs).toBeUndefined();
    // A floor that can be skipped or allowed to fail measures nothing.
    expect(job!.if).toBeUndefined();
    expect(job!["continue-on-error"]).toBeUndefined();
    for (const step of job!.steps) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    const setup = job!.steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@") === true);
    expect(setup).toHaveLength(1);
    expect(String(setup[0]?.with?.["bun-version"])).toBe(minBun());
    const runs = job!.steps.map((s) => s.run);
    for (const suite of ["./bridge", "./cli", "./scripts"]) expect(runs).toContain(`bun test ${suite}`);
  });
});

describe("the Windows check runs the flake's Bun", () => {
  test("windows.yml pins setup-bun to flake.nix's bunVersion", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "windows.yml"), "utf8");
    // SAFETY: `Bun.YAML.parse` answers plain data; the one field read is compared against a string.
    const parsed = Bun.YAML.parse(workflow) as { jobs: Record<string, { steps: { uses?: string; with?: Record<string, string> }[] }> };
    const steps = Object.values(parsed.jobs).flatMap((j) => j.steps);
    const setup = steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@") === true);
    expect(setup).toHaveLength(1);
    expect(String(setup[0]?.with?.["bun-version"])).toBe(flakeBunVersion());
  });

  test("windows-suites.ps1 gives each suite its own skip budget, 180 in all, each skip named", () => {
    const script = readFileSync(join(ROOT, "scripts", "windows-suites.ps1"), "utf8");
    const budget = (suite: string): number => Number(new RegExp(`\\[int\\]\\$MaxSkips${suite} = (\\d+)`).exec(script)?.[1] ?? Number.NaN);
    expect([budget("Bridge"), budget("Cli"), budget("Scripts")]).toEqual([98, 57, 25]);
    // The bridge allowance is the local-cli tests that stay POSIX-only, the one real-engine Whistle
    // case that needs the uncommitted model, the one scan of real links to /etc, the 5 hold socket tests, the 6
    // walky mode and socket tests, the 30 durable example tests, the 10 durable-harness adapter skips and the 36 durable socket tests; the comment
    // names them all.
    const localCli = readFileSync(join(ROOT, "bridge", "stt", "local-cli.test.ts"), "utf8");
    const posixOnly = [...localCli.matchAll(/test\.if\(posix\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(posixOnly).toHaveLength(4);
    const holdSocket = [...readFileSync(join(ROOT, "bridge", "surface", "hook-ask.test.ts"), "utf8").matchAll(/test\.skipIf\(POSIX_ONLY\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(holdSocket).toHaveLength(5);
    for (const name of holdSocket) expect(script).toContain(name);
    // The walky tests: a file mode or a Unix socket, each one a skipped test beside a part that runs on Windows.
    const walkySkips = ["instances", "log", "refusals", "seen", "socket"].flatMap((file) =>
      [...readFileSync(join(ROOT, "bridge", "walky", `${file}.test.ts`), "utf8").matchAll(/test\.skipIf\(POSIX_ONLY\)\("([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(walkySkips).toHaveLength(6);
    for (const name of walkySkips) expect(script).toContain(name);
    expect(script).toContain("bridge/mux/durable/example-durable-harness.test.ts");
    // The /etc link scan: the one skip in bridge/claude-commands.test.ts.
    const etcLinks = [...readFileSync(join(ROOT, "bridge", "claude-commands.test.ts"), "utf8").matchAll(/test\.skipIf\([^)]*\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(etcLinks).toHaveLength(1);
    for (const name of etcLinks) expect(script).toContain(name);
    // The pane's program reads (.adr/0124): two boundedRun tests start a POSIX sh, the live /proc probe is
    // Linux only, and the "two copies" describe's one test and its hook use POSIX sh fakes.
    const boundedRunSkips = [...readFileSync(join(ROOT, "bridge", "surface", "binary-version.test.ts"), "utf8").matchAll(/test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(boundedRunSkips).toHaveLength(2);
    for (const name of boundedRunSkips) expect(script).toContain(name);
    const paneBinary = readFileSync(join(ROOT, "bridge", "pane-binary.test.ts"), "utf8");
    expect(paneBinary).toContain('test.skipIf(process.platform !== "linux")("procProbe sees a live process\'s executable and folder"');
    expect(paneBinary).toContain('describe.skipIf(process.platform === "win32")("two copies of one harness');
    expect(script).toContain("procProbe sees a live process's executable and folder");
    expect(script).toContain("two copies of one harness");
    expect(budget("Bridge")).toBe(posixOnly.length + 1 + etcLinks.length + holdSocket.length + walkySkips.length + 30 + 10 + 36 + boundedRunSkips.length + 1 + 2);
    // The cli allowance adds the three real runs of the POSIX install leg a crew member runs, and the
    // 36 tests of cli/walky.test.ts that talk to a real walky socket (`socketTest`).
    const walkySocketTests = readFileSync(join(ROOT, "cli", "walky.test.ts"), "utf8").match(/^ {2}socketTest\(/gm) ?? [];
    expect(walkySocketTests).toHaveLength(36);
    // The statusLine wrapper's "runShell stops the whole command" block (3 tests) is skipped off Linux.
    expect(readFileSync(join(ROOT, "cli", "statusline.test.ts"), "utf8")).toContain('describe.skipIf(process.platform !== "linux")("runShell stops the whole command"');
    expect(script).toContain("runShell stops the whole command");
    // cli/sys.test.ts: two tests start POSIX children (`sh -c`, a signal), both `test.skipIf` on win32.
    const sysSkips = [...readFileSync(join(ROOT, "cli", "sys.test.ts"), "utf8").matchAll(/test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(sysSkips).toHaveLength(2);
    for (const name of sysSkips) expect(script).toContain(name);
    expect(budget("Cli")).toBe(sysSkips.length + 1 + 12 + 3 + walkySocketTests.length + 3);
    for (const name of posixOnly) expect(script).toContain(name);
    expect(script).toContain("a 13 s WAV becomes text through a real child of this Collie");
    expect(script).toContain("a child of this checkout's CLI turns 10.4 s of speech into text");
    expect(script).toContain("installScript from a shallow lead, run for real");
    // The scripts allowance is the 23 install.sh tests plus the two harness lab skips the script names.
    expect(budget("Scripts")).toBe(23 + 2);
    expect(script).toContain("POSIX only: the login copy has mode 600");
    expect(script).toContain("a real throwaway server starts, shows its pane, stops, and leaves no socket");
    expect(script).not.toContain("[int]$MaxSkips = ");
    expect(script).toContain("if ($skip -gt $skipBudget[$name])");
  });
});

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

/** The tests a POSIX-only describe holds: each `test(` line from a line that starts with `opener` to its `});` at column 0. */
function testsInBlocks(text: string, opener: string): number {
  let inside = false;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith(opener)) inside = true;
    else if (inside && line.startsWith("});")) inside = false;
    else if (inside && /^\s+test\(/u.test(line)) count += 1;
  }
  return count;
}

/** The names of the tests `file` (from the repository root) opens with `pattern`, its first group being the name. */
function namesIn(file: string, pattern: RegExp): string[] {
  return [...readFileSync(join(ROOT, file), "utf8").matchAll(pattern)].map((m) => m[1]!);
}

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

  test("windows-suites.ps1 gives each suite its own skip budget, 370 in all, each skip named", () => {
    const script = readFileSync(join(ROOT, "scripts", "windows-suites.ps1"), "utf8");
    const budget = (suite: string): number => Number(new RegExp(`\\[int\\]\\$MaxSkips${suite} = (\\d+)`).exec(script)?.[1] ?? Number.NaN);
    expect([budget("Bridge"), budget("Cli"), budget("Scripts")]).toEqual([172, 164, 34]);
    // The bridge allowance is the local-cli tests that stay POSIX-only, the one real-engine Whistle
    // case that needs the uncommitted model, the one scan of real links to /etc, the one telemetry file mode, the 5 hold socket tests, the 7
    // walky mode and socket tests, the 6 walky sibling registry tests, the 30 durable example tests, the 10 durable-harness adapter skips and the 36 durable socket tests; the comment
    // names them all.
    const localCli = readFileSync(join(ROOT, "bridge", "stt", "local-cli.test.ts"), "utf8");
    const posixOnly = [...localCli.matchAll(/test\.if\(posix\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(posixOnly).toHaveLength(4);
    const holdSocket = [...readFileSync(join(ROOT, "bridge", "surface", "hook-ask.test.ts"), "utf8").matchAll(/test\.skipIf\(POSIX_ONLY\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(holdSocket).toHaveLength(5);
    for (const name of holdSocket) expect(script).toContain(name);
    // The walky tests: a file mode or a Unix socket, each one a skipped test beside a part that runs on Windows.
    const walkySkips = ["instances", "log", "off", "refusals", "seen", "socket"].flatMap((file) =>
      [...readFileSync(join(ROOT, "bridge", "walky", `${file}.test.ts`), "utf8").matchAll(/test\.skipIf\(POSIX_ONLY\)\("([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(walkySkips).toHaveLength(7);
    for (const name of walkySkips) expect(script).toContain(name);
    expect(script).toContain("bridge/mux/durable/example-durable-harness.test.ts");
    // The /etc link scan: the one skip in bridge/claude-commands.test.ts.
    const etcLinks = [...readFileSync(join(ROOT, "bridge", "claude-commands.test.ts"), "utf8").matchAll(/test\.skipIf\([^)]*\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(etcLinks).toHaveLength(1);
    for (const name of etcLinks) expect(script).toContain(name);
    // The telemetry file mode: a POSIX mode, its own skipped test beside the telemetry tests that run on Windows.
    const telemetrySkips = [...readFileSync(join(ROOT, "bridge", "telemetry.test.ts"), "utf8").matchAll(/test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(telemetrySkips).toHaveLength(1);
    for (const name of telemetrySkips) expect(script).toContain(name);
    // The walky sibling registry: the cases that walk a live hook target registry, which needs a pid start-time probe win32 lacks.
    const siblingSkips = [...readFileSync(join(ROOT, "bridge", "walky", "siblings.test.ts"), "utf8").matchAll(/test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(siblingSkips).toHaveLength(6);
    for (const name of siblingSkips) expect(script).toContain(name);
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
    // N9 (trouble check 2026-11-08): the off-PATH agent is a `#!/bin/sh` script, so the describe's one test
    // and its hook skip on Windows, as "two copies" does.
    expect(paneBinary).toContain('describe.skipIf(process.platform === "win32")("createPaneVersion — a harness off the login PATH"');
    expect(script).toContain("createPaneVersion — a harness off the login PATH");
    const offPathSkips = 2;
    // The new worktree's fake git (M81): POSIX sh scripts Windows cannot spawn, each `test.skipIf` on win32.
    const fakeGitSkips = [...readFileSync(join(ROOT, "bridge", "worktree-add.test.ts"), "utf8").matchAll(/test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(fakeGitSkips).toHaveLength(6);
    for (const name of fakeGitSkips) expect(script).toContain(name);
    // The no-named-key one-line send test sits in a loop over claude, omp and pi and runs for claude and omp (pi's Alt+Enter stays a named key), so it skips once on every platform.
    const rawEnterSkips = readFileSync(join(ROOT, "bridge", "surface", "protocol.unstyled.test.ts"), "utf8").includes('test.if(harness.id === "claude" || harness.id === "omp")(') ? 1 : 0;
    expect(rawEnterSkips).toBe(1);
    expect(script).toContain("protocol.unstyled.test.ts");
    // The agent view's pictures (bridge/agent-view/media.test.ts): each test keeps files under a 0700 folder and
    // reads them through the hill's POSIX checks, so each is `posix(...)`, a `test.skipIf` on win32.
    const viewMediaSkips = [...readFileSync(join(ROOT, "bridge", "agent-view", "media.test.ts"), "utf8").matchAll(/^ {2}posix\("([^"]+)"/gm)].map((m) => m[1]!);
    expect(viewMediaSkips).toHaveLength(15);
    expect(script).toContain("bridge/agent-view/media.test.ts");
    // The Hill and the tricks: a symlink, a FIFO, a device, the walky socket or a `#!/bin/sh` program, each named.
    const WIN = /test\.skipIf\((?:HOST|process)\.platform === "win32"\)\("([^"]+)"/g;
    const hillSkips = [
      ...namesIn("bridge/hill/media.test.ts", /^ {2}posix\("([^"]+)"/gm),
      ...namesIn("bridge/hill/routes.test.ts", WIN),
      ...namesIn("bridge/tricks/hill.test.ts", WIN),
      ...namesIn("bridge/tricks/inputs.test.ts", WIN),
      ...namesIn("bridge/tricks/units.test.ts", WIN),
    ];
    expect(hillSkips).toHaveLength(9);
    for (const name of hillSkips) expect(script).toContain(name);
    expect(readFileSync(join(ROOT, "bridge", "tricks", "hill.test.ts"), "utf8")).toContain('describe.skipIf(process.platform === "win32")("end to end with the legs trick"');
    expect(script).toContain('"end to end with the legs trick"');
    const legsEndToEnd = 1;
    // The add from the official list: its POSIX-only describes and its `test.if(posix)` cases.
    const official = readFileSync(join(ROOT, "bridge", "tricks", "official.test.ts"), "utf8");
    const officialSkips = testsInBlocks(official, "describe.if(posix)(") + (official.match(/^ {2}test\.if\(posix\)\(/gm) ?? []).length;
    expect(officialSkips).toBe(32);
    expect(script).toContain("bridge/tricks/official.test.ts");
    expect(budget("Bridge")).toBe(
      viewMediaSkips.length + posixOnly.length + 1 + etcLinks.length + holdSocket.length + walkySkips.length + siblingSkips.length + telemetrySkips.length + 30 + 10 + 36 + boundedRunSkips.length + 1 + 2 + rawEnterSkips + fakeGitSkips.length + offPathSkips +
        hillSkips.length + legsEndToEnd + officialSkips,
    );
    // The cli allowance adds the three real runs of the POSIX install leg a crew member runs, and the
    // 50 tests of cli/walky.test.ts that talk to a real walky socket (`socketTest`).
    const walkySocketTests = readFileSync(join(ROOT, "cli", "walky.test.ts"), "utf8").match(/^ {2}socketTest\(/gm) ?? [];
    expect(walkySocketTests).toHaveLength(50);
    // The statusLine wrapper's "runShell stops the whole command" block (3 tests) is skipped off Linux.
    expect(readFileSync(join(ROOT, "cli", "statusline.test.ts"), "utf8")).toContain('describe.skipIf(process.platform !== "linux")("runShell stops the whole command"');
    expect(script).toContain("runShell stops the whole command");
    // cli/sys.test.ts: two tests start POSIX children (`sh -c`, a signal), both `test.skipIf` on win32.
    const sysSkips = [...readFileSync(join(ROOT, "cli", "sys.test.ts"), "utf8").matchAll(/test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(sysSkips).toHaveLength(2);
    for (const name of sysSkips) expect(script).toContain(name);
    // M84: the hc-only home probe in cli/remote.test.ts runs a POSIX `sh` against a stand-in `hc`.
    const hcProbe = "the real probe on an hc-only home reports the core and Collie's own config dir";
    expect(readFileSync(join(ROOT, "cli", "remote.test.ts"), "utf8")).toContain(hcProbe);
    expect(script).toContain(hcProbe);
    // The probe's dirty check runs the same POSIX probe with /bin/sh against a real git checkout: 2 tests.
    const dirtyProbe = "the probe's dirty check, run for real";
    expect(readFileSync(join(ROOT, "cli", "remote.test.ts"), "utf8")).toContain(`("${dirtyProbe}"`);
    expect(script).toContain(dirtyProbe);
    // The agent view verbs (cli/trick-view.test.ts) talk to a real walky socket, as cli/walky.test.ts does (`socketTest`).
    const viewSocketTests = readFileSync(join(ROOT, "cli", "trick-view.test.ts"), "utf8").match(/^ {2}socketTest\(/gm) ?? [];
    expect(viewSocketTests).toHaveLength(21);
    expect(script).toContain("cli/trick-view.test.ts");
    // The Hill verbs, the picture staging, the trick verbs and the helper's POSIX tools.
    const hillSocketTests = readFileSync(join(ROOT, "cli", "hill.test.ts"), "utf8").match(/^ +socketTest\(/gm) ?? [];
    expect(hillSocketTests).toHaveLength(28);
    expect(script).toContain("cli/hill.test.ts");
    const stagingSkips = readFileSync(join(ROOT, "cli", "image-stage.test.ts"), "utf8").match(/^ {2}linux\(/gm) ?? [];
    expect(stagingSkips).toHaveLength(7);
    expect(script).toContain("cli/image-stage.test.ts");
    const addSkips = testsInBlocks(readFileSync(join(ROOT, "cli", "trick-add.test.ts"), "utf8"), "describe.if(posix)(");
    expect(addSkips).toBe(17);
    expect(script).toContain("cli/trick-add.test.ts");
    const proposeSkips = readFileSync(join(ROOT, "cli", "trick-propose.test.ts"), "utf8").match(/^ +(?:socketTest|posixTest)\(/gm) ?? [];
    expect(proposeSkips).toHaveLength(15);
    expect(script).toContain("refuses a symbolic link, even to a file inside the folder");
    const helperSkips = namesIn("cli/trick-kit/trick.test.ts", /test\.skipIf\(process\.platform === "win32"\)\("([^"]+)"/g);
    expect(helperSkips).toHaveLength(2);
    for (const name of helperSkips) expect(script).toContain(name);
    expect(budget("Cli")).toBe(
      sysSkips.length + 1 + 12 + 3 + walkySocketTests.length + viewSocketTests.length + 3 + 1 + 2 + hillSocketTests.length + stagingSkips.length + addSkips + proposeSkips.length + helperSkips.length,
    );
    for (const name of posixOnly) expect(script).toContain(name);
    expect(script).toContain("a 13 s WAV becomes text through a real child of this Collie");
    expect(script).toContain("a child of this checkout's CLI turns 10.4 s of speech into text");
    expect(script).toContain("installScript from a shallow lead, run for real");
    // The scripts allowance is the 23 install.sh tests, the two harness lab skips the script names, and every test of
    // the official list's maintainer script (POSIX-only describes).
    const officialScript = testsInBlocks(readFileSync(join(ROOT, "scripts", "official-tricks.test.ts"), "utf8"), "describe.if(posix)(");
    expect(officialScript).toBe(9);
    expect(script).toContain("scripts/official-tricks.test.ts");
    expect(budget("Scripts")).toBe(23 + 2 + officialScript);
    expect(script).toContain("POSIX only: the login copy has mode 600");
    expect(script).toContain("a real throwaway server starts, shows its pane, stops, and leaves no socket");
    expect(script).not.toContain("[int]$MaxSkips = ");
    expect(script).toContain("if ($skip -gt $skipBudget[$name])");
  });
});

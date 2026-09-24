import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeExec, fakeFiles, HOME } from "./fakes.ts";
import {
  BUN_PROBE_TIMEOUT_MS,
  realExec,
  resolveRunnableBun,
  resolveTool,
  toolCandidates,
  withEnvOverride,
  withoutGitRelocators,
  withPathPrefix,
} from "./sys.ts";

// The one place Collie looks for Bun, and the proof that the two shell copies of it agree.
//
// There is no fourth implementation to add: `scripts/collie-ctl.sh` bootstraps the binary Bun
// compiles, `cli/remote.ts` ships a probe down an ssh pipe, and `cli/sys.ts` is what everything in
// process asks. The parity block below reads the two shell sources off disk, so a candidate added
// to one of them and not the others fails this suite rather than a host months later (#169).

const REPO = `${import.meta.dir}/..`;

/** A `which` that answers `found` for `bun` and null for everything else. */
const whichIs = (found: string | null) => ({
  which: (tool: string): string | null => (tool === "bun" ? found : null),
});

describe("the canonical tool candidate list", () => {
  test("BUN_INSTALL outranks the default ~/.bun, and an empty value counts as unset", () => {
    expect(toolCandidates({ BUN_INSTALL: "/opt/bun" }, HOME, "bun")[0]).toBe("/opt/bun/bin/bun");
    expect(toolCandidates({ BUN_INSTALL: "" }, HOME, "bun")[0]).toBe(`${HOME}/.bun/bin/bun`);
    expect(toolCandidates({}, HOME, "bun")[0]).toBe(`${HOME}/.bun/bin/bun`);
  });

  test("the order is the shim's, extended by the remote probe's tail", () => {
    expect(toolCandidates({}, HOME, "bun")).toEqual([
      `${HOME}/.bun/bin/bun`,
      `${HOME}/.bun/bin/bun`,
      `${HOME}/.local/bin/bun`,
      "/usr/local/bin/bun",
      "/opt/homebrew/bin/bun",
      "/usr/bin/bun",
      "/bin/bun",
      "/usr/sbin/bun",
      "/sbin/bun",
    ]);
  });

  test("every candidate is absolute", () => {
    for (const c of toolCandidates({ BUN_INSTALL: "/opt/bun" }, HOME, "bun")) {
      expect(c.startsWith("/")).toBe(true);
    }
  });
});

describe("resolveTool", () => {
  test("PATH answers first, and the answer is reported as on-PATH", () => {
    const r = resolveTool(whichIs("/usr/local/bin/bun"), fakeFiles(), {}, HOME, "bun");
    expect(r).toEqual({ path: "/usr/local/bin/bun", onPath: true });
  });

  test("a shell function is not an absolute path, so `command -v`'s bare word is refused", () => {
    // `command -v bun` reports a `bun()` function as the bare word `bun`. Taking it would resolve
    // the tool through whatever cwd and PATH said later, which is the trap all three copies guard.
    const files = fakeFiles({ "/usr/bin/bun": "" });
    const r = resolveTool(whichIs("bun"), files, {}, HOME, "bun");
    expect(r).toEqual({ path: "/usr/bin/bun", onPath: false });
  });

  test("a Bun off PATH is found at a candidate, BUN_INSTALL first", () => {
    const files = fakeFiles({ "/opt/bun/bin/bun": "", [`${HOME}/.bun/bin/bun`]: "" });
    expect(resolveTool(whichIs(null), files, { BUN_INSTALL: "/opt/bun" }, HOME, "bun")?.path).toBe(
      "/opt/bun/bin/bun",
    );
    expect(resolveTool(whichIs(null), files, {}, HOME, "bun")?.path).toBe(`${HOME}/.bun/bin/bun`);
  });

  test("a candidate that is present but not executable is skipped, exactly as `[ -x ]` skips it", () => {
    // Both shells ask `[ -x "$candidate" ]`. A path that exists and cannot be run — a half-written
    // download, an empty file left where an uninstall took the binary from — is not the tool, and
    // taking it would hand the update an absolute path that dies with EACCES.
    const files = fakeFiles({ [`${HOME}/.bun/bin/bun`]: "", "/usr/bin/bun": "" });
    files.notExecutable.add(`${HOME}/.bun/bin/bun`);
    expect(resolveTool(whichIs(null), files, {}, HOME, "bun")?.path).toBe("/usr/bin/bun");
    files.notExecutable.add("/usr/bin/bun");
    expect(resolveTool(whichIs(null), files, {}, HOME, "bun")).toBeNull();
  });

  test("nothing anywhere is null, never a guess", () => {
    expect(resolveTool(whichIs(null), fakeFiles(), {}, HOME, "bun")).toBeNull();
  });
});

describe("a runnable Bun", () => {
  test("proves the resolved absolute path with a bounded version probe", () => {
    const bun = "/opt/bun/bin/bun";
    const exec = fakeExec({ absent: ["bun"], answers: [[`${bun} --version`, { stdout: "1.1.0\n" }]] });
    const readiness = resolveRunnableBun(exec, fakeFiles({ [bun]: "" }), { BUN_INSTALL: "/opt/bun" }, HOME);
    expect(readiness).toEqual({ kind: "ready", bun: { path: bun, onPath: false, version: "1.1.0" } });
    expect(exec.calls).toContain(`${bun} --version`);
    expect(exec.timeouts).toContainEqual({ call: `${bun} --version`, ms: BUN_PROBE_TIMEOUT_MS });
  });

  test("rejects a resolved Bun that fails or does not answer a readable version", () => {
    const bun = "/fake/bun";
    for (const answer of [{ code: 1 }, { code: 124 }, { stdout: "\n" }]) {
      const readiness = resolveRunnableBun(
        fakeExec({ answers: [[`${bun} --version`, answer]] }),
        fakeFiles(),
        {},
        HOME,
      );
      expect(readiness).toEqual({ kind: "unrunnable", tool: { path: bun, onPath: true } });
    }
  });
});

describe("the PATH a resolved tool's child gets", () => {
  // A phone-started update runs in a transient systemd user unit with no operator PATH. Resolving
  // Bun to `~/.bun/bin/bun` and spawning that absolute path is not enough: `bun cli/main.ts build`
  // shells out to `bunx tsc`, and `bunx` is found by NAME or not at all. A lab run died exactly
  // there — `bunx: command not found`, exit 127, checkout already advanced.
  test("the resolved tool's directory goes to the FRONT, so it outranks anything else", () => {
    expect(withPathPrefix({ PATH: "/usr/bin:/bin" }, "/home/pat/.bun/bin").PATH).toBe(
      "/home/pat/.bun/bin:/usr/bin:/bin",
    );
  });

  test("an empty or absent PATH becomes the directory alone, never a stray colon", () => {
    expect(withPathPrefix({}, "/opt/bun/bin").PATH).toBe("/opt/bun/bin");
    expect(withPathPrefix({ PATH: "" }, "/opt/bun/bin").PATH).toBe("/opt/bun/bin");
  });

  test("a directory already on the PATH is left where it is, as the shim leaves it", () => {
    expect(withPathPrefix({ PATH: "/usr/bin:/opt/bun/bin" }, "/opt/bun/bin").PATH).toBe(
      "/usr/bin:/opt/bun/bin",
    );
  });

  test("no prefix hands back the same environment, untouched", () => {
    const env = { PATH: "/usr/bin" };
    expect(withPathPrefix(env, undefined)).toBe(env);
    expect(withPathPrefix(env, "")).toBe(env);
  });
});

// ── Parity ───────────────────────────────────────────────────────────────────

/**
 * The candidates a shell `for` list spells, read out of the source between `for … in` and `; do`.
 *
 * Both sources are read as TEXT — `cli/remote.ts`'s list is a shell script held in a TS array, so
 * the TS quoting (`'`, `,`, an escaped `\\`) and the shell's own line continuations are stripped
 * before the words are split.
 */
function shellCandidates(source: string, start: string): string[] {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const end = source.indexOf("; do", from);
  expect(end).toBeGreaterThan(from);
  return source
    .slice(from + start.length, end)
    .replace(/[\\',]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => w.replace(/"/g, ""));
}

/** Expand the shell words the way the shell would, for a stated `$HOME` and `$BUN_INSTALL`. */
function expand(word: string, home: string, bunInstall: string | undefined, tool: string): string {
  const bunRoot = bunInstall === undefined || bunInstall === "" ? `${home}/.bun` : bunInstall;
  return word
    .replace("${BUN_INSTALL:-${HOME}/.bun}", bunRoot)
    .replace("${BUN_INSTALL:-$HOME/.bun}", bunRoot)
    .replace(/\$\{HOME\}|\$HOME/g, home)
    .replace(/\$_n/g, tool);
}

describe("bun lookup parity", () => {
  const shim = Bun.file(`${REPO}/scripts/collie-ctl.sh`).text();
  const remote = Bun.file(`${REPO}/cli/remote.ts`).text();

  const cases: [label: string, bunInstall: string | undefined][] = [
    ["with BUN_INSTALL unset", undefined],
    ["with BUN_INSTALL set", "/opt/bun"],
  ];

  for (const [label, bunInstall] of cases) {
    test(`scripts/collie-ctl.sh's resolve_bun spells the canonical list ${label}`, async () => {
      const words = shellCandidates(await shim, "for candidate in");
      expect(words.map((w) => expand(w, HOME, bunInstall, "bun"))).toEqual(
        toolCandidates({ BUN_INSTALL: bunInstall }, HOME, "bun"),
      );
    });

    test(`cli/remote.ts's TOOL_LOOKUP spells the canonical list ${label}`, async () => {
      const words = shellCandidates(await remote, "for _c in");
      expect(words.map((w) => expand(w, HOME, bunInstall, "bun"))).toEqual(
        toolCandidates({ BUN_INSTALL: bunInstall }, HOME, "bun"),
      );
    });
  }

  test("both shell sources test a candidate with `[ -x ]`, the predicate resolveTool asks", async () => {
    // The order is not the whole contract: a list walked with `[ -e ]` on one side and `[ -x ]` on
    // the other resolves to different paths on the same host. `Files.executable` is this side's.
    expect(await shim).toContain('if [ -x "$candidate" ]; then');
    expect(await remote).toContain('if [ -x "$_c" ]; then printf');
  });

  test("both shell sources take `command -v` only when the answer is absolute", async () => {
    expect(await shim).toContain("case \"$candidate\" in");
    expect(await remote).toContain("/*) printf '%s' \"$_p\"; return 0 ;;");
  });
});

describe("realExec.capture timeout", () => {
  const shell = { PATH: process.env.PATH ?? "" };

  test("reports 124 after SIGKILL stops a direct child that ignores SIGTERM", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-capture-"));
    try {
      const started = performance.now();
      const result = realExec(shell, dir).capture(
        "sh",
        ["-c", "trap '' TERM; while :; do :; done"],
        200,
      );
      expect(result.found).toBe(true);
      expect(result.code).toBe(124);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the bounded, logged client call the handoff waits for", () => {
  // The only seam in `Exec` whose whole purpose is an ANSWER from a detaching launcher, so it is
  // proved against a real child rather than a fake: the append and the bound are the contract.
  const shell = { PATH: process.env.PATH ?? "" };

  test("it appends both streams to the log and answers the child's own exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-runlogged-"));
    try {
      // Under a directory that does not exist yet, the way a fresh config dir arrives.
      const log = join(dir, "state", "collie.log");
      const exec = realExec(shell, dir);
      const first = exec.runLogged(["sh", "-c", "echo accepted; echo refused 1>&2; exit 3"], {
        cwd: dir,
        env: shell,
        logPath: log,
        timeoutMs: 10_000,
      });
      expect(first.code).toBe(3);
      expect(first.timedOut).toBe(false);
      expect(first.stderr.trim()).toBe("refused");
      expect(readFileSync(log, "utf8")).toContain("accepted");
      expect(readFileSync(log, "utf8")).toContain("refused");
      // Appended, never truncated: the runner opens this same file for append after us.
      exec.runLogged(["sh", "-c", "echo second"], { cwd: dir, env: shell, logPath: log, timeoutMs: 10_000 });
      expect(readFileSync(log, "utf8")).toContain("accepted");
      expect(readFileSync(log, "utf8")).toContain("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child that never answers is a timeout, with the coreutils code", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-runlogged-"));
    try {
      const wedged = realExec(shell, dir).runLogged(["sh", "-c", "sleep 30"], {
        cwd: dir,
        env: shell,
        logPath: join(dir, "collie.log"),
        timeoutMs: 300,
      });
      expect(wedged.timedOut).toBe(true);
      expect(wedged.code).toBe(124);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tool that is not installed anywhere is 127, never a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-runlogged-"));
    try {
      const missing = realExec({ PATH: dir }, dir).runLogged(["definitely-not-a-tool"], {
        cwd: dir,
        env: {},
        logPath: join(dir, "collie.log"),
        timeoutMs: 1_000,
      });
      expect(missing.code).toBe(127);
      expect(missing.timedOut).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── No child inherits a redirected repository (ADR 0049) ─────────────────────
// Git obeys `GIT_DIR` from any working directory, `-C` included. That is how a hook-run `git -C
// <sandbox> init` once re-initialised the CALLER'S repository and wrote `bare = true` into a shared
// config (the lesson `scripts/collie-cli.test.sh` records at its top, and defends itself with
// `unset "${!GIT_@}"`). The shipped CLI runs in the same place — a pre-push hook that calls collie
// hands it the same variables — so the seam strips them for every child.

describe("withoutGitRelocators", () => {
  test("an environment carrying none is returned unchanged, by identity", () => {
    // Identity, not equality: this is the every-call case, and it must allocate nothing.
    const env = { PATH: "/usr/bin", HOME: "/home/x", GIT_CEILING_DIRECTORIES: "/home/x" };
    expect(withoutGitRelocators(env)).toBe(env);
  });

  test("every relocating name is removed and nothing else is touched", () => {
    const env = {
      PATH: "/usr/bin",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_COMMON_DIR: "/elsewhere/.git",
      GIT_INDEX_FILE: "/elsewhere/.git/index",
      GIT_OBJECT_DIRECTORY: "/elsewhere/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/other/objects",
      GIT_NAMESPACE: "ns",
      GIT_PREFIX: "sub/",
      // Kept on purpose: these decide how git AUTHENTICATES or how far it walks UP, not which
      // repository it is looking at, and the hermetic test paths set the config ones deliberately.
      GIT_CEILING_DIRECTORIES: "/home/x",
      GIT_CONFIG_GLOBAL: "/tmp/g",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_SSH_COMMAND: "ssh -i /k",
    };
    expect(withoutGitRelocators(env)).toEqual({
      PATH: "/usr/bin",
      GIT_CEILING_DIRECTORIES: "/home/x",
      GIT_CONFIG_GLOBAL: "/tmp/g",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_SSH_COMMAND: "ssh -i /k",
    });
    // The caller's own object is never mutated — `ctx.env` is read by everything else.
    expect(env.GIT_DIR).toBe("/elsewhere/.git");
  });
});

describe("realExec strips them from the child it actually starts", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "collie-gitenv-"));

  test("a hostile GIT_DIR does not reach the child, and `-C` decides alone", () => {
    const d = dir();
    try {
      // The real shape: `git -C <sandbox> init` while `GIT_DIR` points somewhere else. Unstripped,
      // git initialises the directory GIT_DIR names and the sandbox stays empty.
      const victim = join(d, "victim");
      const sandbox = join(d, "sandbox");
      mkdirSync(victim, { recursive: true });
      mkdirSync(sandbox, { recursive: true });
      const exec = realExec(
        { PATH: process.env.PATH ?? "", GIT_DIR: join(victim, ".git"), GIT_WORK_TREE: victim },
        d,
      );
      const r = exec.capture("git", ["-C", sandbox, "init", "-q"]);
      expect(r.found).toBe(true);
      expect(r.code).toBe(0);
      // It landed where `-C` aimed it, and the victim was never touched.
      expect(readFileSync(join(sandbox, ".git", "HEAD"), "utf8").length).toBeGreaterThan(0);
      expect(() => readFileSync(join(victim, ".git", "HEAD"), "utf8")).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("`envAdd` cannot put one back — the seam's own env is spread last", () => {
    const d = dir();
    try {
      const exec = realExec({ PATH: process.env.PATH ?? "" }, d);
      const r = exec.capture("sh", ["-c", "echo \"[${GIT_DIR:-unset}]\""], undefined, {
        GIT_DIR: "/elsewhere/.git",
      });
      // `envAdd` layers UNDER the Exec's env, and the Exec's env no longer carries the name, so
      // without the post-merge filter this one WOULD reach the child. No caller passes a git name
      // today; the invariant is not allowed to depend on that staying true.
      expect(r.stdout.trim()).toBe("[unset]");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("a per-call override wins over the Exec's own environment (#283)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "collie-envover-"));
  const PRINT = 'echo "[${COLLIE_PLUGIN_ROOT:-unset}][${FOO:-unset}][${GIT_DIR:-unset}]"';

  test("withEnvOverride: null removes, a string sets, nothing to apply allocates nothing", () => {
    const env = { COLLIE_PLUGIN_ROOT: "/old", FOO: "exec" };
    expect(withEnvOverride(env, undefined)).toBe(env);
    expect(withEnvOverride(env, {})).toBe(env);
    expect(withEnvOverride(env, { COLLIE_PLUGIN_ROOT: null, FOO: "over" })).toEqual({ FOO: "over" });
    // The caller's object is never mutated: `ctx.env` is read by everything else.
    expect(env.COLLIE_PLUGIN_ROOT).toBe("/old");
  });

  test("capture: envAdd < the Exec's env < envOverride, and the relocators are filtered after all three", () => {
    const d = dir();
    try {
      const exec = realExec({ PATH: process.env.PATH ?? "", COLLIE_PLUGIN_ROOT: "/old", FOO: "exec" }, d);
      // envAdd alone loses to the Exec's own env.
      expect(exec.capture("sh", ["-c", PRINT], undefined, { FOO: "add" }).stdout.trim()).toBe("[/old][exec][unset]");
      // The override beats both, removing one name and replacing the other.
      expect(
        exec.capture("sh", ["-c", PRINT], undefined, { FOO: "add" }, { COLLIE_PLUGIN_ROOT: null, FOO: "over" }).stdout.trim(),
      ).toBe("[unset][over][unset]");
      // And cannot put a git relocator back.
      expect(exec.capture("sh", ["-c", PRINT], undefined, undefined, { GIT_DIR: "/elsewhere/.git" }).stdout.trim()).toBe(
        "[/old][exec][unset]",
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("runIn takes the same override, and the same filter", () => {
    const d = dir();
    try {
      const exec = realExec({ PATH: process.env.PATH ?? "", COLLIE_PLUGIN_ROOT: "/old" }, d);
      const out = join(d, "out");
      const r = exec.runIn("sh", ["-c", `${PRINT} > ${out}`], d, undefined, { COLLIE_PLUGIN_ROOT: null, GIT_DIR: "/x" });
      expect(r.code).toBe(0);
      expect(readFileSync(out, "utf8").trim()).toBe("[unset][unset][unset]");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a child killed by a signal says which one", () => {
    const d = dir();
    try {
      const r = realExec({ PATH: process.env.PATH ?? "" }, d).capture("sh", ["-c", "kill -KILL $$"]);
      expect(r.signal).toBe("SIGKILL");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

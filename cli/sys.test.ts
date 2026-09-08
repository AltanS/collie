import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeFiles, HOME } from "./fakes.ts";
import { realExec, resolveTool, toolCandidates, withPathPrefix } from "./sys.ts";

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

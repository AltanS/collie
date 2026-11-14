// The typed WalkyTalky line at a shell prompt (backport of fix/walky-line-fields, 1.29.0). Collie types
// the line into a pane it found running an agent; when the agent exits between that check and the keys,
// the line lands at a shell prompt and the Enter runs it. So the line must do nothing there, whatever
// its fields hold.
//
// Every line below is built by the real formatter from hostile values and handed to `<shell> -c` in an
// empty folder whose HOME and XDG folders are inside it too. The payload is always `touch canary` (a file
// in that folder), spelled for every way a shell runs a command: a separator, a pipe, `&&`, a backtick,
// `$()`, fish's `(...)`, brace expansion, a newline, a glob, a redirect, a quote that would end the label's
// quotes, and plain WORDS standing where a shell might take them for a command. Each value stands in every
// place a value reaches the line: the label, the harness, the address, and an id or a reply id that
// skipped the log's and the hop's checks, for an agent with a harness, an agent without one, and an
// operator. (1.28 has no subject; 1.29 adds one, in quotes, with its own allow-list.) A shell that is
// not installed gets no test (see below).
//
// Shells not run here, by their grammar (Windows 11 with Herdr is a supported host, and a Windows bridge
// does type lines: the phone's messages and a crew member's arrive there, only the agent's socket is
// missing). Reasoned, not run. PowerShell: `[walky-talky <id>]` at the start of a statement is a type literal with a space in
// it, most likely a parse error that refuses the whole line; and past it, double quotes expand only `$` and the backtick
// escapes, and neither can reach the line; `( ) { } ; | & < >` are all outside the allow-list, and a kept `@`
// can at most splat a variable, which reads it and runs nothing. pwsh and nu are not installed here. cmd:
// runs only through `& | && || < >` and `^` escapes, none of which can reach the line; `%x%` only reads a
// variable. nushell: `$`, `( )`, `^` and `;` are what run or substitute there, none can reach the line.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatEnvelope, NUDGE_MARK, type WalkyMessage } from "./types.ts";

/** Each shell, and how it runs one line with no start-up file of the person's. */
const SHELL_ARGS = [
  ["bash", ["--norc", "--noprofile", "-c"]],
  ["zsh", ["-f", "-c"]],
  ["dash", ["-c"]],
  ["fish", ["--no-config", "-c"]],
  ["ksh", ["-c"]],
] as const;
const installed = (shell: string): boolean => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;
const SHELLS: readonly string[] = SHELL_ARGS.map(([shell]) => shell).filter(installed);
/** The shells the Linux CI job must have (COLLIE_REQUIRE_SHELLS=1). ksh is optional everywhere. */
const REQUIRED_SHELLS = ["bash", "dash", "zsh", "fish"] as const;
const argsOf = (shell: string): readonly string[] => SHELL_ARGS.find(([name]) => name === shell)?.[1] ?? ["-c"];

/** What the canary run left behind: every path under the temp root that is not the empty work folder or HOME's own files. */
async function run(shell: string, line: string): Promise<{ canary: boolean; workLeft: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "walky-line-shell-"));
  const work = join(root, "work");
  const home = join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state") };
  await new Promise<void>((resolve) => {
    const child = spawn(shell, [...argsOf(shell), line], { cwd: work, env, stdio: "ignore", timeout: 10_000 });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  const all = readdirSync(root, { recursive: true }).map(String);
  const left = { canary: all.some((path) => path.split(/[\\/]/u).some((part) => part.startsWith("canary"))), workLeft: readdirSync(work) };
  // The root holds only work/ and home/: nothing was written beside them.
  expect(readdirSync(root).toSorted()).toEqual(["home", "work"]);
  rmSync(root, { recursive: true, force: true });
  return left;
}

const PAYLOADS = {
  "plain words": "touch canary",
  ";": "x;touch canary",
  "|": "x|touch canary",
  "&&": "x&&touch canary",
  "||": "x||touch canary",
  "&": "x&touch canary",
  backtick: "x`touch canary`",
  "$()": "x$(touch canary)",
  "fish (...)": "x(touch canary)",
  "( ) alone": "(touch canary)",
  "brace expansion": "{touch,canary}",
  newline: "x\ntouch canary",
  "U+2028": "x touch canary",
  glob: "*",
  redirect: "x>canary",
  "closing quote": 'x"; touch canary; "',
  "single quote": "x'; touch canary; '",
};

const agent: WalkyMessage = {
  v: 1,
  id: "wt_qoo5tvg2ldhj",
  kind: "agent",
  from: { memberId: "lodge", address: "lodge/w6:p3", harness: "claude", label: "klaracase#main" },
  to: "desk/w1:p1",
  replyTo: null,
  at: 1_790_000_000_000,
  body: "all green",
  signer: null,
  signature: null,
};

/** Every place a value reaches the typed line, for each sender kind. */
function linesFor(payload: string) {
  const firstLine = (message: WalkyMessage): string => formatEnvelope(message).split("\n")[0]!;
  const noHarness = { ...agent.from, harness: null };
  const operator: WalkyMessage = { ...agent, kind: "operator", from: { memberId: null, address: null, harness: null, label: payload } };
  return {
    "agent label": firstLine({ ...agent, from: { ...agent.from, label: payload } }),
    "agent label, no harness": firstLine({ ...agent, from: { ...noHarness, label: payload } }),
    "agent harness": firstLine({ ...agent, from: { ...agent.from, harness: payload } }),
    "agent address, pane part": firstLine({ ...agent, from: { ...agent.from, address: `lodge/${payload}` } }),
    "agent address, member part": firstLine({ ...agent, from: { ...noHarness, address: `${payload}/w6:p3` } }),
    "operator label": firstLine(operator),
    "agent id (forged)": firstLine({ ...agent, id: payload }),
    "agent reply id (forged)": firstLine({ ...agent, replyTo: payload }),
    "operator id (forged)": firstLine({ ...operator, from: { ...operator.from, label: "Pixel 9" }, id: payload }),
    "operator reply id (forged)": firstLine({ ...operator, from: { ...operator.from, label: "Pixel 9" }, replyTo: payload }),
  };
}

describe("the typed line at a shell prompt runs nothing (fix/walky-line-fields)", () => {
  // A shell this machine lacks gets no test at all rather than a skipped one, so the Windows skip budget
  // (scripts/windows-suites.ps1) is untouched: on Windows `sh` is missing and only this first test runs.
  // With COLLIE_REQUIRE_SHELLS=1 (the Linux bridge job of ci.yml, which installs zsh and fish) a missing
  // bash, dash, zsh or fish FAILS here instead of leaving its tests out, so CI always runs the real shells.
  // Not keyed on CI: release, windows, webkit and packaging runs set CI too and lack these shells.
  test(`the shells this machine has: ${SHELLS.length === 0 ? "none" : SHELLS.join(", ")}`, () => {
    expect(SHELLS.every((shell) => SHELL_ARGS.some(([name]) => name === shell))).toBe(true);
    if (process.env.COLLIE_REQUIRE_SHELLS === "1") expect(REQUIRED_SHELLS.filter((shell) => !SHELLS.includes(shell))).toEqual([]);
  });

  // Measured 2026-11-14 on bash 5.3.9, zsh 5.9 and fish 4.6.0, a header line as the only input:
  //   bash  `bash: line 1: [walky-talky: command not found`, exit 127 (the line's first word is looked up
  //         as a command; with the older form bash refused the whole line, a syntax error at `(`)
  //   zsh   `zsh:1: bad pattern: [walky-talky`, exit 1 (an unclosed `[` glob; zsh still expands every
  //         word first, which is how a backtick ran in the older form)
  //   fish  `fish: Unknown command: '[walky-talky'`, exit 127
  // So the first word runs only if a command named `[walky-talky` exists (bash's command_not_found_handle
  // may run its own lookup). The texts differ between shells and versions (dash, and the older fish of
  // Ubuntu's runner, were not measured here), so the test asserts only what the rule needs, in every shell
  // this machine has: the shell ran no command from the line (no file appears) and did not exit 0.
  for (const shell of SHELLS) {
    test(`${shell}: the first word \`[walky-talky\` runs no command, and the shell does not exit 0`, () => {
      const root = mkdtempSync(join(tmpdir(), "walky-line-first-"));
      const work = join(root, "work");
      mkdirSync(work);
      const out = spawnSync(shell, [...argsOf(shell), '[walky-talky wt_qoo5tvg2ldhj] from operator "Pixel 9"'], { cwd: work, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, ".local/share"), XDG_CACHE_HOME: join(root, ".cache") }, timeout: 10_000 });
      const left = readdirSync(work);
      rmSync(root, { recursive: true, force: true });
      expect(out.status).not.toBe(0);
      expect(left).toEqual([]);
    });
  }

  for (const shell of SHELLS) {
    test(`${shell}: the canary works (a plain \`touch canary\` makes it)`, async () => {
      expect((await run(shell, "touch canary")).canary).toBe(true);
    });

    test(
      `${shell}: no hostile label, harness, address or id makes the canary, for any sender kind`,
      async () => {
        const failures: string[] = [];
        for (const [name, payload] of Object.entries(PAYLOADS)) {
          const lines = Object.entries(linesFor(payload));
          const results = await Promise.all(lines.map(async ([where, line]) => ({ where, line, left: await run(shell, line) })));
          for (const { where, line, left } of results) if (left.canary || left.workLeft.length > 0) failures.push(`${name} in ${where}: ${line}`);
        }
        expect(failures).toEqual([]);
      },
      120_000,
    );
  }

  if (SHELLS.includes("fish")) test("fish ran the older form: `(<label>)` is a command substitution there (why the line changed)", async () => {
    const older = `[walky-talky wt_qoo5tvg2ldhj] from operator (touch canary)`;
    expect((await run("fish", older)).canary).toBe(true);
    const olderAgent = `[walky-talky wt_qoo5tvg2ldhj] from agent lodge/w6:p3 (claude, x;touch canary)${NUDGE_MARK} Read it: collie walky inbox wt_qoo5tvg2ldhj`;
    expect((await run("fish", olderAgent)).canary).toBe(true);
  });
});

// The slow cases of line-shells.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEnvelope, type WalkyMessage } from "./types.ts";

/** Each shell, and how it runs one line with no start-up file of the person's. */
const SHELL_ARGS = [
  ["bash", ["--norc", "--noprofile", "-c"]],
  ["zsh", ["-f", "-c"]],
  ["dash", ["-c"]],
  ["fish", ["--no-config", "-c"]],
  ["ksh", ["-c"]],
] as const;

const argsOf = (shell: string): readonly string[] => SHELL_ARGS.find(([name]) => name === shell)?.[1] ?? ["-c"];

// A shell counts as installed when THIS process can spawn it by its bare name and it can run `touch`,
// the canary every test below relies on. The older probe asked `sh -c "command -v <shell>"`. On Windows
// that `sh` is the one of Git for Windows, and it can find a `dash` in Git's own `usr/bin` that a process
// spawning "dash" itself cannot start, or that starts with no `touch` on its PATH. The shell then ran
// nothing, and the dash canary test read false. A shell that fails the probe gets no test, as a missing one does.
function installed(shell: string): boolean {
  const root = mkdtempSync(join(tmpdir(), "walky-line-probe-"));
  try {
    spawnSync(shell, [...argsOf(shell), "touch probe"], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }, timeout: 10_000 });
    return readdirSync(root).includes("probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SHELLS: readonly string[] = SHELL_ARGS.map(([shell]) => shell).filter(installed);

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
  const firstLine = (message: WalkyMessage, outside = false): string => formatEnvelope(message, outside ? "outside" : undefined).split("\n")[0]!;
  const noHarness = { ...agent.from, harness: null };
  const operator: WalkyMessage = { ...agent, kind: "operator", from: { memberId: null, address: null, harness: null, label: payload } };
  return {
    "agent label": firstLine({ ...agent, from: { ...agent.from, label: payload } }),
    "agent label, no harness": firstLine({ ...agent, from: { ...noHarness, label: payload } }),
    "agent harness": firstLine({ ...agent, from: { ...agent.from, harness: payload } }),
    "agent address, pane part": firstLine({ ...agent, from: { ...agent.from, address: `lodge/${payload}` } }),
    "agent address, member part": firstLine({ ...agent, from: { ...noHarness, address: `${payload}/w6:p3` } }),
    "agent subject": firstLine({ ...agent, subject: payload, replyTo: "wt_8ab2k1m4q7zx" }, true),
    "operator label": firstLine(operator),
    "operator subject": firstLine({ ...operator, from: { ...operator.from, label: "Pixel 9" }, subject: payload }),
    "agent id (forged)": firstLine({ ...agent, id: payload }),
    "agent reply id (forged)": firstLine({ ...agent, replyTo: payload }),
    "operator id (forged)": firstLine({ ...operator, from: { ...operator.from, label: "Pixel 9" }, id: payload }),
    "operator reply id (forged)": firstLine({ ...operator, from: { ...operator.from, label: "Pixel 9" }, replyTo: payload }),
  };
}

describe("the typed line at a shell prompt runs nothing (fix/walky-line-fields)", () => {
  for (const shell of SHELLS) {
    test(`${shell}: the canary works (a plain \`touch canary\` makes it)`, async () => {
      expect((await run(shell, "touch canary")).canary).toBe(true);
    });

    test(
      `${shell}: no hostile label, harness, address or subject makes the canary, for any sender kind`,
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
});

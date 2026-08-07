import { describe, expect, test } from "bun:test";

import {
  type Command,
  COMMANDS,
  EXIT,
  findCommand,
  type Io,
  parseArgv,
  run,
  usageLine,
} from "./main.ts";

// The dispatch surface is a contract with the plugin manifest and with anyone's muscle memory from
// `collie-ctl.sh`, so the verb table and the 0/1/2 exit codes are pinned here rather than left to
// whatever the last edit happened to leave behind.

// The shell's dispatch (scripts/collie-ctl.sh:862-879), in its order.
const SHELL_VERBS = [
  "start",
  "stop",
  "restart",
  "uninstall",
  "update",
  "_apply-update",
  "_exec-bridge",
  "build",
  "serve",
  "unserve",
  "status",
  "url",
  "version",
  "push-test",
  "logs",
];

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

describe("the verb table", () => {
  test("covers every verb the shell dispatches, plus help", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([...SHELL_VERBS, "help"]);
  });

  test("hides exactly the shell's internal verbs from the usage line", () => {
    expect(COMMANDS.filter((c) => c.internal === true).map((c) => c.name)).toEqual([
      "_apply-update",
      "_exec-bridge",
    ]);
  });

  test("the usage line names every public verb", () => {
    const line = usageLine();
    for (const c of COMMANDS) {
      if (c.internal === true) continue;
      expect(line).toContain(c.name);
    }
    expect(line.startsWith("usage: collie {")).toBe(true);
  });

  test("no verb name is duplicated", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every verb has a summary", () => {
    for (const c of COMMANDS) expect(c.summary.length).toBeGreaterThan(0);
  });
});

describe("parseArgv", () => {
  test("a known verb carries its remaining args", () => {
    expect(parseArgv(["logs", "200"])).toEqual({ kind: "verb", name: "logs", args: ["200"] });
  });

  test("an internal verb is dispatchable even though it is not advertised", () => {
    expect(parseArgv(["_exec-bridge"])).toEqual({
      kind: "verb",
      name: "_exec-bridge",
      args: [],
    });
  });

  test("help, -h and --help are help", () => {
    for (const a of ["help", "-h", "--help"]) expect(parseArgv([a])).toEqual({ kind: "help" });
  });

  test("no argv at all is a usage error, as in the shell's `case`", () => {
    expect(parseArgv([])).toEqual({ kind: "unknown", name: "" });
  });

  test("an unrecognised verb is a usage error naming what was typed", () => {
    expect(parseArgv(["nonsense"])).toEqual({ kind: "unknown", name: "nonsense" });
  });
});

describe("exit codes", () => {
  test("an unknown verb exits 2 with the usage line on stderr", async () => {
    const io = capture();
    expect(await run(["nonsense"], io)).toBe(EXIT.USAGE);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("\n")).toContain("unknown command `nonsense`");
    expect(io.stderr.join("\n")).toContain(usageLine());
  });

  test("no verb exits 2 with usage but does not accuse the user of typing something", async () => {
    const io = capture();
    expect(await run([], io)).toBe(EXIT.USAGE);
    expect(io.stderr.join("\n")).not.toContain("unknown command");
    expect(io.stderr.join("\n")).toContain(usageLine());
  });

  test("help exits 0 on stdout — it is output, not a diagnostic", async () => {
    const io = capture();
    expect(await run(["--help"], io)).toBe(EXIT.OK);
    expect(io.stderr).toEqual([]);
    expect(io.stdout.join("\n")).toContain(usageLine());
    for (const c of COMMANDS) {
      if (c.internal === true) continue;
      expect(io.stdout.join("\n")).toContain(c.summary);
    }
  });

  test("a verb still owned by the shell exits 1 and says where it lives", async () => {
    const io = capture();
    expect(await run(["start"], io)).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("\n")).toContain("scripts/collie-ctl.sh start");
  });

  test("a verb that throws becomes an operational failure, not a stack trace", async () => {
    const io = capture();
    const boom: Command = {
      name: "boom",
      summary: "explodes",
      run() {
        throw new Error("kaboom");
      },
    };
    expect(await run(["boom"], io, [boom])).toBe(EXIT.FAIL);
    expect(io.stderr.join("\n")).toContain("kaboom");
    expect(io.stderr.join("\n")).not.toContain("at ");
  });

  test("version prints one undecorated line to stdout and exits 0", async () => {
    const io = capture();
    expect(await run(["version"], io)).toBe(EXIT.OK);
    expect(io.stdout).toHaveLength(1);
    expect(io.stdout[0]!.trim()).toBe(io.stdout[0]!);
    expect(io.stdout[0]).not.toBe("");
  });
});

describe("findCommand", () => {
  test("resolves by exact name only — no prefixes, no aliases", () => {
    expect(findCommand("version")?.name).toBe("version");
    expect(findCommand("vers")).toBeUndefined();
    expect(findCommand("VERSION")).toBeUndefined();
  });
});

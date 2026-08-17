import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PACK_SUBCOMMANDS } from "./pack.ts";
import { DEVICES_SUBCOMMANDS } from "./pairing.ts";
import { PUSH_SUBCOMMANDS } from "./push.ts";
import {
  type Command,
  COMMANDS,
  EXIT,
  findCommand,
  helpText,
  type Io,
  run,
  usageLine,
} from "./program.ts";

// The dispatch surface is a contract with the plugin manifest and with anyone's muscle memory from
// `collie-ctl.sh`, so the verb table and the 0/1/2 exit codes are pinned here rather than left to
// whatever the last edit happened to leave behind.

// Every verb the shell dispatched, in its order, before M6/01 reduced `scripts/collie-ctl.sh` to a
// bootstrap shim that `exec`s this binary. A `collie-ctl.sh <verb>` spelling — a README recipe, a
// <0.8.0 Herdr install's cached action set (ADR 0006) — still lands on exactly this table.
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
  "qr",
  "version",
  // `push-keys` has no shell ancestor on this branch — main implemented it in `collie-ctl.sh`
  // because it has no `cli/`; here it is a verb like every other, and the shim delegates it. It
  // sits beside `push-test` because both keep the hyphenated spelling the Herdr action names.
  "push-keys",
  "push-test",
  "logs",
];

// The pack verbs (M4/07). They have no shell ancestor — `collie-ctl.sh` never knew about federation
// — so they are listed separately: the assertion above is "the port kept every verb the shell had",
// and this one is "the binary grew exactly these".
const PACK_VERBS = ["join", "leave", "pack", "promote", "reconnect"];

// The diagnostic verbs (M7/02). No shell ancestor either, and they sit between the two groups above
// because that is where they are declared — the usage line's order is the table's order.
const DIAGNOSTIC_VERBS = ["doctor"];

// The device-pairing verbs. Declared between the diagnostics and the pack, because that is where
// they sit in the table, and grouped separately for the same reason as the two above.
const PAIRING_VERBS = ["pair", "devices"];

// The push-subscription verb (#104). `push-test` sits in SHELL_VERBS above — it is the shell's, and
// keeps its spelling — while `push` is the tree that grew around it, declared next to `devices`
// because it answers the same question about a different register.
const PUSH_VERBS = ["push"];

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

describe("the verb table", () => {
  test("covers every verb the shell dispatches, plus help", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      ...SHELL_VERBS,
      ...DIAGNOSTIC_VERBS,
      ...PAIRING_VERBS,
      ...PUSH_VERBS,
      ...PACK_VERBS,
      "help",
    ]);
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

// ── The grammar commander now owns ───────────────────────────────────────────
// These used to be assertions about `parseArgv`, the hand-rolled splitter commander replaced. They
// are asserted through `run` now — the parser is an implementation detail, "what does typing this
// do" is the contract. Every verb below is a spy, so nothing here touches the world.
describe("dispatch", () => {
  function spy(name: string, sub?: readonly string[]): { command: Command; seen: string[][] } {
    const seen: string[][] = [];
    const command: Command = {
      name,
      summary: `spy on ${name}`,
      subcommands: sub?.map((s) => ({
        name: s,
        summary: `spy on ${name} ${s}`,
        run: (args) => {
          seen.push([s, ...args]);
          return EXIT.OK;
        },
      })),
      run: (args) => {
        seen.push(["(parent)", ...args]);
        return EXIT.OK;
      },
    };
    return { command, seen };
  }

  // Every dispatch below goes through this helper rather than a literal `run([…])`, so the
  // "no world-touching verb is spelled out in this file" grep further down stays honest: these
  // argvs name real verbs, but they land on the spy table passed alongside them, never on COMMANDS.
  const go = (argv: string[], commands: readonly Command[]) => run(argv, capture(), commands);

  test("a known verb carries its remaining args, flags and all, in order", async () => {
    const { command, seen } = spy("logs");
    expect(await go(["logs", "200"], [command])).toBe(EXIT.OK);
    expect(await go(["logs", "--json", "-n", "7"], [command])).toBe(EXIT.OK);
    expect(seen).toEqual([
      ["(parent)", "200"],
      ["(parent)", "--json", "-n", "7"],
    ]);
  });

  test("a verb's own `--help` stays the verb's argument — commander does not intercept it", async () => {
    const { command, seen } = spy("logs");
    expect(await go(["logs", "--help"], [command])).toBe(EXIT.OK);
    expect(seen).toEqual([["(parent)", "--help"]]);
  });

  test("a subcommand is matched by name; anything else reaches the parent", async () => {
    const { command, seen } = spy("pack", ["invite", "status"]);
    for (const argv of [["pack", "status", "--no-probe"], ["pack"], ["pack", "nonsense"]]) {
      expect(await go(argv, [command])).toBe(EXIT.OK);
    }
    expect(seen).toEqual([
      ["status", "--no-probe"],
      ["(parent)"],
      ["(parent)", "nonsense"],
    ]);
  });

  test("an internal verb is dispatchable even though it is not advertised", async () => {
    const { command, seen } = spy("_exec-bridge");
    const internal: Command = { ...command, internal: true };
    expect(await go(["_exec-bridge"], [internal])).toBe(EXIT.OK);
    expect(seen).toEqual([["(parent)"]]);
    expect(usageLine([internal])).toBe("usage: collie {}");
  });

  test("--plain is accepted anywhere and never reaches the verb", async () => {
    const { command, seen } = spy("pack", ["status"]);
    expect(await go(["--plain", "pack", "status"], [command])).toBe(EXIT.OK);
    expect(await go(["pack", "status", "--plain", "--no-probe"], [command])).toBe(EXIT.OK);
    expect(seen).toEqual([
      ["status"],
      ["status", "--no-probe"],
    ]);
  });

  test("a verb's exit code is the run's exit code — every family, unaltered", async () => {
    for (const code of [EXIT.OK, EXIT.FAIL, EXIT.USAGE, EXIT.STATE, EXIT.REFUSED, EXIT.UNREACHABLE]) {
      const command: Command = { name: "x", summary: "returns a code", run: () => code };
      expect(await go(["x"], [command])).toBe(code);
    }
  });
});

describe("the subcommand trees", () => {
  test("`pack` declares exactly `cli/pack.ts`'s sub-verbs, in its order", () => {
    const pack = findCommand("pack");
    expect(pack?.subcommands?.map((s) => s.name)).toEqual([...PACK_SUBCOMMANDS]);
  });

  test("`devices` declares exactly `cli/pairing.ts`'s sub-verbs, in its order", () => {
    const devices = findCommand("devices");
    expect(devices?.subcommands?.map((s) => s.name)).toEqual([...DEVICES_SUBCOMMANDS]);
  });

  test("`push` declares exactly `cli/push.ts`'s sub-verbs, in its order", () => {
    expect(findCommand("push")?.subcommands?.map((s) => s.name)).toEqual([...PUSH_SUBCOMMANDS]);
  });

  test("no other verb declares a tree — the grammar is one level deep everywhere else", () => {
    expect(COMMANDS.filter((c) => c.subcommands !== undefined).map((c) => c.name)).toEqual([
      "devices",
      "push",
      "pack",
    ]);
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

  // Three spellings, one text. `help` is a verb in the table, `-h`/`--help` are commander's, and
  // commander is configured to print this file's `helpText` for both — so they cannot drift apart.
  test("`help`, `-h` and `--help` print the identical body", async () => {
    for (const spelling of ["help", "-h", "--help"]) {
      const io = capture();
      expect(await run([spelling], io)).toBe(EXIT.OK);
      expect(io.stderr).toEqual([]);
      expect(io.stdout).toEqual(helpText());
    }
  });

  test("the help body names --plain and hides every internal verb", async () => {
    const body = helpText().join("\n");
    expect(body).toContain("--plain");
    for (const c of COMMANDS) if (c.internal === true) expect(body).not.toContain(c.name);
  });

  test("an unknown verb with arguments is still reported by its own name", async () => {
    const io = capture();
    expect(await run(["nonsense", "--flag", "x"], io)).toBe(EXIT.USAGE);
    expect(io.stderr.join("\n")).toContain("unknown command `nonsense`");
  });

  // NOTHING in this file may dispatch a verb that touches the world. Dispatching `start` here would
  // write a unit into the developer's own ~/.config and `enable --now` it; dispatching `build` did
  // exactly this once during M3/04 and rebuilt the DEPLOYMENT HOST's live bundle from a dirty tree.
  // Those verbs are covered in their own suites against fakes, and end to end in
  // scripts/collie-cli.test.sh against a scratch PATH and a throwaway $HOME.
  //
  // `version` and `help` are the only verbs this file may run: they read, they never write.
  test("every verb is dispatchable, and only the two read-only ones may be run here", () => {
    const worldTouching = [
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
      "logs",
      "push-keys",
      "push-test",
      "url",
      // `qr` shells out to `tailscale` to decide which URL is worth encoding.
      "qr",
      // Every pack verb writes the trust store, dials another machine, or restarts the service —
      // and `pack` with no subcommand would still resolve a real context and a real audit path. All
      // of them are covered in cli/pack.test.ts against fakes.
      ...PACK_VERBS,
      // `doctor` writes nothing, but it is not runnable here either: it shells out to `tailscale`
      // and would dial this host's real pack members. cli/doctor.test.ts drives it against fakes.
      ...DIAGNOSTIC_VERBS,
      // `pair` writes a pending pairing into the developer's own state dir, and `devices` resolves
      // that same real dir before it decides anything. cli/pairing.test.ts drives both against fakes.
      ...PAIRING_VERBS,
      // Every `push` sub-verb resolves the real state dir, and `push test` would send to this host's
      // own subscribed phones. cli/push.test.ts drives all three against a throwaway dir.
      ...PUSH_VERBS,
    ];
    const readOnly = ["version", "help"];
    for (const name of [...worldTouching, ...readOnly]) expect(findCommand(name)).toBeDefined();
    expect([...worldTouching, ...readOnly].length).toBe(COMMANDS.length);
    // The grep stops at the verb's closing quote, NOT at the `"]` that used to follow it: a verb
    // dispatched WITH arguments — a comma where the bracket was — slipped straight through the
    // narrower form. (Which is also why this comment cannot spell one out; it would match itself.)
    const source = readFileSync(new URL("./main.test.ts", import.meta.url), "utf8");
    for (const name of worldTouching) expect(source).not.toContain(`run(["${name}"`);
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

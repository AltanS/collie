import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createLauncherSwitches,
  createOperatorLaunchers,
  DEFAULT_SWITCHES,
  launcherSwitches,
  validateOperatorLaunchers,
} from "./operator-launchers.ts";
import type { OperatorFileIo } from "./operator-file.ts";

// The dashboard's launch strip: the operator's own shell-line rows, typed verbatim into a new
// Space's shell. Driven exactly like the commands.toml and keys.toml suites — the validator with
// parsed TOML, the reader through a fake io.

const quiet = () => {};

/** Parse a TOML source the way the reader does, then validate it — the whole grammar in one call. */
function rows(toml: string) {
  return validateOperatorLaunchers(Bun.TOML.parse(toml), quiet);
}

describe("validateOperatorLaunchers", () => {
  test("nothing declared yields nothing", () => {
    expect(rows("")).toEqual([]);
    expect(rows("launchers = []")).toEqual([]);
    expect(validateOperatorLaunchers(undefined, quiet)).toEqual([]);
    expect(validateOperatorLaunchers(null, quiet)).toEqual([]);
  });

  test("a minimal row keeps the command, defaults the label, and leaves cwd absent", () => {
    const out = rows(`[[launchers]]
command = "rumen-peek"`);
    expect(out).toEqual([{ command: "rumen-peek", label: "rumen-peek" }]);
    expect(out[0]).not.toHaveProperty("cwd");
  });

  test("label defaults to the command's first whitespace-separated token", () => {
    expect(rows(`[[launchers]]
command = "make test"`)[0]!.label).toBe("make");
    expect(rows(`[[launchers]]
command = "  bun   run   foo  "`)[0]!.label).toBe("bun");
    // A single-token command labels itself.
    expect(rows(`[[launchers]]
command = "htop"`)[0]!.label).toBe("htop");
  });

  test("an explicit label wins over the default", () => {
    const out = rows(`[[launchers]]
command = "rumen-peek"
label = "Runs & quota"`);
    expect(out[0]!.label).toBe("Runs & quota");
    expect(out[0]!.label).not.toBe("rumen-peek");
  });

  test("cwd expansion of ~ and ~/sub, and absent staying absent", () => {
    expect(rows(`[[launchers]]
command = "a"
cwd = "~"`)[0]!.cwd).toBe(homedir());
    expect(rows(`[[launchers]]
command = "a"
cwd = "~/sub"`)[0]!.cwd).toBe(
      join(homedir(), "sub"),
    );
    expect(rows(`[[launchers]]
command = "a"
cwd = "~/a/b"`)[0]!.cwd).toBe(
      join(homedir(), "a/b"),
    );
    // A non-tilde cwd is passed through verbatim (after trim).
    expect(rows(`[[launchers]]
command = "a"
cwd = "/tmp/foo"`)[0]!.cwd).toBe("/tmp/foo");
    // No cwd stays ABSENT — "here", resolved on the bridge at launch time (home from the
    // dashboard, the pane's own cwd from a pane), never defaulted by the parser.
    const out = rows(`[[launchers]]
command = "a"`)[0]!;
    expect(out.cwd).toBeUndefined();
    expect(out).not.toHaveProperty("cwd");
  });

  test("drops a row whose command is missing, empty, non-string, or control-character-bearing", () => {
    // Missing/empty/non-string command — the allowlist key itself is absent.
    expect(rows(`[[launchers]]
label = "A"`)).toEqual([]);
    expect(rows(`[[launchers]]
command = ""`)).toEqual([]);
    expect(rows(`[[launchers]]
command = "   "`)).toEqual([]);
    expect(rows(`[[launchers]]
command = 42`)).toEqual([]);
    // A control character means the shell would see a second line nobody reviewed — the row is
    // dropped, not sanitised. Use object-level validation because TOML cannot encode a raw newline
    // inside a basic string without escaping.
    expect(validateOperatorLaunchers({ launchers: [{ command: "a\nb" }] }, quiet)).toEqual([]);
    expect(validateOperatorLaunchers({ launchers: [{ command: "a\tb" }] }, quiet)).toEqual([]);
    expect(validateOperatorLaunchers({ launchers: [{ command: "a\x00b" }] }, quiet)).toEqual([]);
    expect(validateOperatorLaunchers({ launchers: [{ command: "a\rb" }] }, quiet)).toEqual([]);
    expect(validateOperatorLaunchers({ launchers: [{ command: "a\x7fb" }] }, quiet)).toEqual([]);
    // Good siblings survive a bad row.
    expect(
      validateOperatorLaunchers({ launchers: [{ command: "a\nb" }, { command: "ok" }] }, quiet),
    ).toMatchObject([{ command: "ok" }]);
  });

  test("a non-string or empty label drops the row, not silently falls back", () => {
    expect(rows(`[[launchers]]
command = "a"
label = 42`)).toEqual([]);
    expect(rows(`[[launchers]]
command = "a"
label = ""`)).toEqual([]);
    expect(rows(`[[launchers]]
command = "a"
label = "   "`)).toEqual([]);
    // Good siblings survive.
    expect(
      rows(`
        [[launchers]]
        command = "a"
        label = ""

        [[launchers]]
        command = "ok"
      `),
    ).toMatchObject([{ command: "ok" }]);
  });

  test("a non-string or empty cwd drops the row", () => {
    expect(rows(`[[launchers]]
command = "a"
cwd = 42`)).toEqual([]);
    expect(rows(`[[launchers]]
command = "a"
cwd = ""`)).toEqual([]);
    expect(rows(`[[launchers]]
command = "a"
cwd = "   "`)).toEqual([]);
    expect(
      rows(`
        [[launchers]]
        command = "a"
        cwd = ""

        [[launchers]]
        command = "ok"
      `),
    ).toMatchObject([{ command: "ok" }]);
  });

  test("a later row for the same command replaces the earlier one IN PLACE with a warning", () => {
    const out = rows(`
      [[launchers]]
      command = "rumen-peek"
      label = "A"

      [[launchers]]
      command = "other"
      label = "B"

      [[launchers]]
      command = "rumen-peek"
      label = "C"
    `);
    expect(out.map((r) => r.label)).toEqual(["C", "B"]);
    expect(out.map((r) => r.command)).toEqual(["rumen-peek", "other"]);
    expect(out).toHaveLength(2);
  });

  test("a `launchers` value that is not an array warns and yields []", () => {
    expect(validateOperatorLaunchers({ launchers: "nope" }, quiet)).toEqual([]);
    expect(validateOperatorLaunchers({ launchers: 42 }, quiet)).toEqual([]);
    // An object where an array belongs costs the whole file, not just its own key.
    expect(validateOperatorLaunchers({ launchers: { command: "a" } }, quiet)).toEqual([]);
    // But a row that is not a table only costs itself — its siblings survive.
    expect(
      validateOperatorLaunchers({ launchers: ["not a table", { command: "ok" }] }, quiet),
    ).toMatchObject([{ command: "ok" }]);
  });

  test("a row that is not a table is dropped while its siblings survive", () => {
    expect(
      validateOperatorLaunchers(
        { launchers: [{ command: "ok" }, "bad", 42, null, { command: "ok2" }] },
        quiet,
      ),
    ).toMatchObject([{ command: "ok" }, { command: "ok2" }]);
  });
});

/** An io whose file contents and mtime are set by hand, counting every read it is asked for. */
function fakeIo(initial: { mtime: number | null; text: string }) {
  const state = { ...initial, reads: 0 };
  const io: OperatorFileIo = {
    mtime: async () => state.mtime,
    read: async () => {
      state.reads += 1;
      if (state.mtime === null) throw new Error("ENOENT");
      return state.text;
    },
  };
  return { io, state };
}

const ONE_ROW = `[[launchers]]
command = "a"`;
const TWO_ROWS = `${ONE_ROW}

[[launchers]]
command = "b"`;

describe("createOperatorLaunchers", () => {
  test("parses once and serves the cache until the mtime moves", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: ONE_ROW });
    const read = createOperatorLaunchers("/cfg/launchers.toml", io, quiet);
    expect(await read()).toMatchObject([{ command: "a" }]);
    expect(await read()).toMatchObject([{ command: "a" }]);
    expect(state.reads).toBe(1);

    state.text = TWO_ROWS;
    state.mtime = 200;
    expect(await read()).toMatchObject([{ command: "a" }, { command: "b" }]);
    expect(state.reads).toBe(2);
  });

  test("a malformed rewrite keeps the last good rows, and does not re-read", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: ONE_ROW });
    const read = createOperatorLaunchers("/cfg/launchers.toml", io, quiet);
    expect(await read()).toMatchObject([{ command: "a" }]);

    state.text = "[[launchers]\ncommand = ";
    state.mtime = 200;
    expect(await read()).toMatchObject([{ command: "a" }]);
    // Warned once per change, not once per request: the failed mtime is remembered too.
    expect(await read()).toMatchObject([{ command: "a" }]);
    expect(state.reads).toBe(2);

    state.text = TWO_ROWS;
    state.mtime = 300;
    expect(await read()).toMatchObject([{ command: "a" }, { command: "b" }]);
  });

  test("no file at all is not an error", async () => {
    const { io, state } = fakeIo({ mtime: null, text: "" });
    const read = createOperatorLaunchers("/cfg/launchers.toml", io, quiet);
    expect(await read()).toEqual([]);
    expect(state.reads).toBe(0);

    state.text = ONE_ROW;
    state.mtime = 100;
    expect(await read()).toMatchObject([{ command: "a" }]);
  });

  test("a file that never parsed serves empty rather than failing", async () => {
    const { io } = fakeIo({ mtime: 100, text: "nonsense = [" });
    const read = createOperatorLaunchers("/cfg/launchers.toml", io, quiet);
    expect(await read()).toEqual([]);
  });
});

// ── ADR 0094: the row keys that feed the New sheet, and the operator's [phone] switches ──────────

describe("validateOperatorLaunchers: harness and no_prompts", () => {
  test("harness names the agent that reads the row; no_prompts marks a hidden flag", () => {
    expect(
      rows(`[[launchers]]
command = "claude-danger"
label = "Claude Code, no prompts"
harness = "claude"
no_prompts = true`),
    ).toEqual([{ command: "claude-danger", label: "Claude Code, no prompts", kind: "agent", harness: "claude", noPrompts: true }]);
    expect(
      rows(`[[launchers]]
command = "htop"
no_prompts = false`),
    ).toEqual([{ command: "htop", label: "htop" }]);
  });

  test("an unknown harness or a non-boolean no_prompts drops the row", () => {
    const warnings: string[] = [];
    const out = validateOperatorLaunchers(
      Bun.TOML.parse(`[[launchers]]
command = "a"
harness = "bash"

[[launchers]]
command = "b"
no_prompts = "yes"

[[launchers]]
command = "c"`),
      (m) => warnings.push(m),
    );
    expect(out.map((r) => r.command)).toEqual(["c"]);
    expect(warnings).toHaveLength(2);
  });

  test("a bidi control or a C1 character drops the row like a newline does", () => {
    expect(validateOperatorLaunchers({ launchers: [{ command: "ls \u202Etxt" }, { command: "a\u0085b" }, { command: "ok" }] }, quiet)).toEqual([
      { command: "ok", label: "ok" },
    ]);
  });
});

describe("launcherSwitches", () => {
  test("defaults: recipes on, free text off", () => {
    expect(launcherSwitches(Bun.TOML.parse(""), quiet)).toEqual(DEFAULT_SWITCHES);
    expect(DEFAULT_SWITCHES).toEqual({ adds: true, freeText: false });
    expect(launcherSwitches(undefined, quiet)).toEqual({ adds: true, freeText: false });
  });

  test("the [phone] table, wherever it sits in the file", () => {
    const doc = Bun.TOML.parse(`[[launchers]]
command = "htop"

[phone]
adds = false
free_text = true`);
    expect(launcherSwitches(doc, quiet)).toEqual({ adds: false, freeText: true });
    expect(validateOperatorLaunchers(doc, quiet)).toEqual([{ command: "htop", label: "htop" }]);
  });

  test("a value that is not true or false reads as OFF", () => {
    const warnings: string[] = [];
    expect(launcherSwitches(Bun.TOML.parse(`[phone]\nadds = "yes"\nfree_text = 1`), (m) => warnings.push(m))).toEqual({
      adds: false,
      freeText: false,
    });
    expect(warnings).toHaveLength(2);
    expect(launcherSwitches(Bun.TOML.parse(`phone = "on"`), quiet)).toEqual({ adds: false, freeText: false });
  });

  test("the reader holds the last good switches across a broken edit", async () => {
    let text = `[phone]\nadds = false`;
    let mtime = 1;
    const io: OperatorFileIo = { mtime: () => Promise.resolve(mtime), read: () => Promise.resolve(text) };
    const read = createLauncherSwitches("/x/launchers.toml", io, quiet);
    expect(await read()).toEqual({ adds: false, freeText: false });
    text = "[phone\n";
    mtime = 2;
    expect(await read()).toEqual({ adds: false, freeText: false });
    const none: OperatorFileIo = { mtime: () => Promise.resolve(null), read: () => Promise.reject(new Error("no")) };
    expect(await createLauncherSwitches("/x/none.toml", none, quiet)()).toEqual(DEFAULT_SWITCHES);
  });
});

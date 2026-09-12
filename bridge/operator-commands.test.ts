import { describe, expect, test } from "bun:test";

import { createOperatorCommands, validateOperatorCommands, type CommandsFileIo } from "./operator-commands.ts";

// The palette's escape hatch: an operator-declared row for a command the shipped catalog cannot
// vouch for (a plugin's, or their own). The validator is pure, so it is driven with parsed TOML
// directly; the reader is driven through a fake io, so the caching contract needs no fs.

const quiet = () => {};

/** Parse a TOML source the way the reader does, then validate it — the whole grammar in one call. */
function rows(toml: string) {
  return validateOperatorCommands(Bun.TOML.parse(toml), quiet);
}

describe("validateOperatorCommands", () => {
  test("nothing declared yields nothing", () => {
    expect(rows("")).toEqual([]);
    expect(rows("commands = []")).toEqual([]);
    expect(validateOperatorCommands(undefined, quiet)).toEqual([]);
    expect(validateOperatorCommands(null, quiet)).toEqual([]);
  });

  test("scopes a row to one agent and keeps its description", () => {
    expect(
      rows(`
        [[commands]]
        scope = "omp"
        command = "/fork-in-herdr"
        description = "Fork into a new herdr tab"
      `),
    ).toEqual([
      {
        agent: "omp",
        command: "/fork-in-herdr",
        description: "Fork into a new herdr tab",
        takesArg: false,
        argHint: "",
        confirm: false,
        bar: false,
      },
    ]);
  });

  test("an unscoped row carries no agent, so every pane gets it", () => {
    const out = rows(`[[commands]]\ncommand = "/deploy"`);
    expect(out).toEqual([
      {
        command: "/deploy",
        description: "Custom command",
        takesArg: false,
        argHint: "",
        confirm: false,
        bar: false,
      },
    ]);
    expect("agent" in out[0]!).toBe(false);
  });

  test("a hint after the command marks the row arg-taking", () => {
    expect(
      rows(`
        [[commands]]
        scope = "claude"
        command = "/model <name>"
        description = "Switch model"
      `),
    ).toMatchObject([{ command: "/model", argHint: "<name>", takesArg: true }]);
  });

  test("trims fields and lowercases the agent", () => {
    expect(
      rows(`
        [[commands]]
        scope = " OMP "
        command = "  /a  "
        description = "  One  "
      `).map((c) => [c.agent, c.command, c.description]),
    ).toEqual([["omp", "/a", "One"]]);
  });

  test("a colon in the command belongs to the command", () => {
    const out = rows(`[[commands]]\ncommand = "/skill:review"\ndescription = "Run the review skill"`);
    expect(out[0]!.agent).toBeUndefined();
    expect(out[0]!.command).toBe("/skill:review");
  });

  test("prose the env grammar banned now survives intact", () => {
    // The whole reason the rows moved out of an env var: a comma no longer ends the row, and an `=`
    // no longer starts the description.
    expect(
      rows(`
        [[commands]]
        command = "/set [key=value]"
        description = "Set a key, then read it back"
      `),
    ).toMatchObject([
      { command: "/set", argHint: "[key=value]", description: "Set a key, then read it back" },
    ]);
  });

  test("drops rows that are not slash commands, keeping the rest", () => {
    expect(
      rows(`
        [[commands]]
        command = "fork-in-herdr"

        [[commands]]
        command = "/"

        [[commands]]
        scope = "omp"
        command = "/ok"
      `),
    ).toMatchObject([{ agent: "omp", command: "/ok" }]);
  });

  test("a redefinition wins, in place, without disturbing another scope", () => {
    expect(
      rows(`
        [[commands]]
        scope = "omp"
        command = "/x"
        description = "first"

        [[commands]]
        scope = "codex"
        command = "/x"
        description = "other"

        [[commands]]
        scope = "omp"
        command = "/x"
        description = "second"
      `).map((c) => [c.agent, c.description]),
    ).toEqual([
      ["omp", "second"],
      ["codex", "other"],
    ]);
  });

  test("an empty scope is rejected, never widened to every agent", () => {
    // `scope = ""` is someone reaching for a narrower rule than they typed. Dropping the empty scope
    // would hand them a row on every pane — the one outcome they were not asking for.
    expect(rows(`[[commands]]\nscope = ""\ncommand = "/wipe"`)).toEqual([]);
    expect(rows(`[[commands]]\nscope = "  "\ncommand = "/wipe"`)).toEqual([]);
    expect(rows(`[[commands]]\nscope = 7\ncommand = "/wipe"`)).toEqual([]);
  });

  test("confirm = true marks the operator's own row dangerous", () => {
    expect(rows(`[[commands]]\ncommand = "/deploy"\nconfirm = true`)[0]!.confirm).toBe(true);
    expect(rows(`[[commands]]\ncommand = "/deploy"\nconfirm = false`)[0]!.confirm).toBe(false);
  });

  test("an unusable confirm drops the row, never leaving it one-tap", () => {
    // `confirm = "yes"` is someone reaching for a brake. Honouring it as false would hand them the
    // one row they were trying to slow down, firing on a single tap.
    expect(rows(`[[commands]]\ncommand = "/deploy"\nconfirm = "yes"`)).toEqual([]);
    expect(rows(`[[commands]]\ncommand = "/deploy"\nconfirm = 1`)).toEqual([]);
  });

  test("a `commands` key that is not an array of tables costs only its own rows", () => {
    expect(validateOperatorCommands({ commands: "/deploy" }, quiet)).toEqual([]);
    expect(validateOperatorCommands({ commands: ["/deploy", { command: "/ok" }] }, quiet)).toMatchObject([
      { command: "/ok" },
    ]);
  });
});


// The two harness-bar keys. `bar` is the only way onto the bar, so an unusable one is a hard drop;
// `bar_label` only decides how the button READS, so it never costs the operator their row. ADR 0043.
describe("the bar keys", () => {
  const warnings: string[] = [];
  const loud = (m: string) => {
    warnings.push(m);
  };

  test("bar defaults to false and needs no label", () => {
    expect(rows(`[[commands]]\ncommand = "/a"`)).toMatchObject([{ bar: false }]);
    expect("barLabel" in rows(`[[commands]]\ncommand = "/a"`)[0]!).toBe(false);
  });

  test("bar = true with a label keeps both", () => {
    expect(
      rows(`
        [[commands]]
        scope = "claude"
        command = "/statusline"
        description = "Set the status line"
        bar = true
        bar_label = "Status"
      `),
    ).toMatchObject([{ command: "/statusline", bar: true, barLabel: "Status" }]);
  });

  test("a non-boolean bar DROPS the row, fail-closed like confirm", () => {
    warnings.length = 0;
    expect(
      validateOperatorCommands(Bun.TOML.parse(`[[commands]]\ncommand = "/a"\nbar = "yes"`), loud),
    ).toEqual([]);
    expect(warnings.join(" ")).toContain("bar must be true or false");
  });

  test("a bad bar drops only its own row", () => {
    expect(
      rows(`
        [[commands]]
        command = "/good"
        bar = true

        [[commands]]
        command = "/bad"
        bar = 1
      `),
    ).toMatchObject([{ command: "/good", bar: true }]);
  });

  test("a 13-character bar_label is cut to 11 plus an ellipsis and the row survives", () => {
    warnings.length = 0;
    const label = "Thirteenchar!"; // exactly 13
    expect(label.length).toBe(13);
    const out = validateOperatorCommands(
      Bun.TOML.parse(`[[commands]]\ncommand = "/a"\nbar = true\nbar_label = "${label}"`),
      loud,
    );
    expect(out).toMatchObject([{ command: "/a", bar: true, barLabel: "Thirteencha\u2026" }]);
    expect(out[0]!.barLabel!.length).toBe(12);
    expect(warnings.join(" ")).toContain("longer than 12 characters");
  });

  test("a 12-character bar_label is kept whole", () => {
    expect(
      rows(`[[commands]]\ncommand = "/a"\nbar = true\nbar_label = "Twelvechars!"`),
    ).toMatchObject([{ barLabel: "Twelvechars!" }]);
  });

  test("an empty or non-string bar_label falls back to the command name, keeping the row", () => {
    warnings.length = 0;
    const blank = validateOperatorCommands(
      Bun.TOML.parse(`[[commands]]\ncommand = "/deploy"\nbar = true\nbar_label = "   "`),
      loud,
    );
    expect(blank).toMatchObject([{ command: "/deploy", bar: true }]);
    expect("barLabel" in blank[0]!).toBe(false);

    const numeric = validateOperatorCommands(
      Bun.TOML.parse(`[[commands]]\ncommand = "/deploy"\nbar = true\nbar_label = 7`),
      loud,
    );
    expect(numeric).toMatchObject([{ command: "/deploy", bar: true }]);
    expect("barLabel" in numeric[0]!).toBe(false);
    expect(warnings.join(" ")).toContain("bar_label must be a non-empty string");
  });

  test("bar_label on a row that is not on the bar is simply not carried", () => {
    const out = rows(`[[commands]]\ncommand = "/a"\nbar_label = "Ignored"`);
    expect(out).toMatchObject([{ bar: false }]);
    expect("barLabel" in out[0]!).toBe(false);
  });
});

/** An io whose file contents and mtime are set by hand, counting every read it is asked for. */
function fakeIo(initial: { mtime: number | null; text: string }) {
  const state = { ...initial, reads: 0 };
  const io: CommandsFileIo = {
    mtime: async () => state.mtime,
    read: async () => {
      state.reads += 1;
      if (state.mtime === null) throw new Error("ENOENT");
      return state.text;
    },
  };
  return { io, state };
}

const ONE_ROW = `[[commands]]\ncommand = "/a"\ndescription = "One"`;
const TWO_ROWS = `${ONE_ROW}\n\n[[commands]]\ncommand = "/b"\ndescription = "Two"`;

describe("createOperatorCommands", () => {
  test("parses once and serves the cache until the mtime moves", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: ONE_ROW });
    const read = createOperatorCommands("/cfg/commands.toml", io, quiet);
    expect(await read()).toMatchObject([{ command: "/a" }]);
    expect(await read()).toMatchObject([{ command: "/a" }]);
    expect(state.reads).toBe(1);

    state.text = TWO_ROWS;
    state.mtime = 200;
    expect(await read()).toMatchObject([{ command: "/a" }, { command: "/b" }]);
    expect(state.reads).toBe(2);
  });

  test("a malformed rewrite keeps the last good rows, and does not re-read", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: ONE_ROW });
    const read = createOperatorCommands("/cfg/commands.toml", io, quiet);
    expect(await read()).toMatchObject([{ command: "/a" }]);

    state.text = "[[commands]\ncommand = ";
    state.mtime = 200;
    expect(await read()).toMatchObject([{ command: "/a" }]);
    // Warned once per change, not once per request: the failed mtime is remembered too.
    expect(await read()).toMatchObject([{ command: "/a" }]);
    expect(state.reads).toBe(2);

    // Fixing the file recovers on the next mtime move.
    state.text = TWO_ROWS;
    state.mtime = 300;
    expect(await read()).toMatchObject([{ command: "/a" }, { command: "/b" }]);
  });

  test("no file at all is not an error", async () => {
    const { io, state } = fakeIo({ mtime: null, text: "" });
    const read = createOperatorCommands("/cfg/commands.toml", io, quiet);
    expect(await read()).toEqual([]);
    expect(state.reads).toBe(0);

    state.text = ONE_ROW;
    state.mtime = 100;
    expect(await read()).toMatchObject([{ command: "/a" }]);
  });

  test("a file that never parsed serves empty rather than failing", async () => {
    const { io } = fakeIo({ mtime: 100, text: "nonsense = [" });
    const read = createOperatorCommands("/cfg/commands.toml", io, quiet);
    expect(await read()).toEqual([]);
  });
});

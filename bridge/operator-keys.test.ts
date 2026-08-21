import { describe, expect, test } from "bun:test";

import { createOperatorKeys, normalizeChord, validateOperatorKeys } from "./operator-keys.ts";
import type { OperatorFileIo } from "./operator-file.ts";

// The Keys tray's escape hatch: the operator's own labelled chords, replacing the shipped Ctrl
// presets on the panes their rows address. Driven exactly like the commands.toml suite — the
// validator with parsed TOML, the reader through a fake io.

const quiet = () => {};

/** Parse a TOML source the way the reader does, then validate it — the whole grammar in one call. */
function rows(toml: string) {
  return validateOperatorKeys(Bun.TOML.parse(toml), quiet);
}

describe("normalizeChord", () => {
  test("accepts the grammar herdr verified", () => {
    // Bare named keys, canonically spelled whatever case they arrive in.
    expect(normalizeChord("Escape")).toBe("Escape");
    expect(normalizeChord("escape")).toBe("Escape");
    expect(normalizeChord("Up")).toBe("Up");
    expect(normalizeChord("BS")).toBe("Backspace");
    // Function keys — the F-keys row's own grammar (#119).
    expect(normalizeChord("F7")).toBe("F7");
    expect(normalizeChord("f12")).toBe("F12");
    expect(normalizeChord("ctrl+F7")).toBe("ctrl+F7");
    // Chords, in any modifier order, including the multi-modifier case verified against 0.7.3.
    expect(normalizeChord("ctrl+c")).toBe("ctrl+c");
    expect(normalizeChord("shift+tab")).toBe("shift+Tab");
    expect(normalizeChord("CTRL+Shift+p")).toBe("ctrl+shift+p");
    expect(normalizeChord("alt+Up")).toBe("alt+Up");
    // A single literal character is typed as itself, case intact.
    expect(normalizeChord("1")).toBe("1");
    expect(normalizeChord("Z")).toBe("Z");
    expect(normalizeChord("+")).toBe("+");
    expect(normalizeChord("ctrl++")).toBe("ctrl++");
    expect(normalizeChord("  ctrl+c  ")).toBe("ctrl+c");
  });

  test("rejects everything herdr answers with invalid_key", () => {
    // The four keys HERDR_API.md pins as unsupported, in any spelling.
    expect(normalizeChord("PageUp")).toBeNull();
    expect(normalizeChord("pagedown")).toBeNull();
    expect(normalizeChord("Home")).toBeNull();
    expect(normalizeChord("End")).toBeNull();
    expect(normalizeChord("Delete")).toBeNull();
    // tmux notation — the spelling this codebase keeps out of sight because herdr rejects it.
    expect(normalizeChord("C-c")).toBeNull();
    expect(normalizeChord("M-x")).toBeNull();
    expect(normalizeChord("BTab")).toBeNull();
    // Not a modifier, not a key, not nothing.
    expect(normalizeChord("meta+c")).toBeNull();
    expect(normalizeChord("ctrl+nope")).toBeNull();
    expect(normalizeChord("ctrl+")).toBeNull();
    expect(normalizeChord("")).toBeNull();
    expect(normalizeChord("   ")).toBeNull();
    expect(normalizeChord("F13")).toBeNull();
    expect(normalizeChord("F0")).toBeNull();
  });
});

describe("validateOperatorKeys", () => {
  test("nothing declared yields nothing", () => {
    expect(rows("")).toEqual([]);
    expect(rows("keys = []")).toEqual([]);
    expect(validateOperatorKeys(undefined, quiet)).toEqual([]);
    expect(validateOperatorKeys(null, quiet)).toEqual([]);
  });

  test("scopes a row to one agent and normalises its chords", () => {
    expect(
      rows(`
        [[keys]]
        scope = "Claude"
        label = "Back"
        keys = ["shift+tab"]
      `),
    ).toEqual([{ agent: "claude", label: "Back", keys: ["shift+Tab"], danger: false }]);
  });

  test("an unscoped row carries no agent, so every pane gets it", () => {
    const out = rows(`[[keys]]\nlabel = "Interrupt"\nkeys = ["ctrl+c"]`);
    expect(out).toEqual([{ label: "Interrupt", keys: ["ctrl+c"], danger: false }]);
    expect("agent" in out[0]!).toBe(false);
  });

  test("a row may carry a whole sequence, sent as one batch", () => {
    expect(rows(`[[keys]]\nlabel = "Yes"\nkeys = ["Down", "Enter"]`)[0]!.keys).toEqual([
      "Down",
      "Enter",
    ]);
  });

  test("drops a row with no label, keeping the rest", () => {
    expect(
      rows(`
        [[keys]]
        keys = ["ctrl+c"]

        [[keys]]
        label = "   "
        keys = ["ctrl+c"]

        [[keys]]
        label = "Ok"
        keys = ["Enter"]
      `),
    ).toMatchObject([{ label: "Ok" }]);
  });

  test("drops a row whose keys are missing, empty, or not chords", () => {
    expect(rows(`[[keys]]\nlabel = "A"`)).toEqual([]);
    expect(rows(`[[keys]]\nlabel = "A"\nkeys = []`)).toEqual([]);
    expect(rows(`[[keys]]\nlabel = "A"\nkeys = "ctrl+c"`)).toEqual([]);
    expect(rows(`[[keys]]\nlabel = "A"\nkeys = [7]`)).toEqual([]);
    expect(rows(`[[keys]]\nlabel = "A"\nkeys = ["PageUp"]`)).toEqual([]);
    expect(rows(`[[keys]]\nlabel = "A"\nkeys = ["C-c"]`)).toEqual([]);
    // One bad step drops the WHOLE row: a sequence missing a step is a different sequence, and this
    // one would type into a real terminal.
    expect(rows(`[[keys]]\nlabel = "A"\nkeys = ["Down", "Home", "Enter"]`)).toEqual([]);
  });

  test("danger = true puts the operator's own row behind the two-tap", () => {
    expect(rows(`[[keys]]\nlabel = "Quit"\nkeys = ["ctrl+d"]\ndanger = true`)[0]!.danger).toBe(true);
    expect(rows(`[[keys]]\nlabel = "Quit"\nkeys = ["ctrl+d"]\ndanger = false`)[0]!.danger).toBe(false);
  });

  test("an unusable danger drops the row, never leaving it one-tap", () => {
    expect(rows(`[[keys]]\nlabel = "Quit"\nkeys = ["ctrl+d"]\ndanger = "yes"`)).toEqual([]);
    expect(rows(`[[keys]]\nlabel = "Quit"\nkeys = ["ctrl+d"]\ndanger = 1`)).toEqual([]);
  });

  test("an empty scope is rejected, never widened to every agent", () => {
    expect(rows(`[[keys]]\nscope = ""\nlabel = "A"\nkeys = ["ctrl+c"]`)).toEqual([]);
    expect(rows(`[[keys]]\nscope = "  "\nlabel = "A"\nkeys = ["ctrl+c"]`)).toEqual([]);
    expect(rows(`[[keys]]\nscope = 7\nlabel = "A"\nkeys = ["ctrl+c"]`)).toEqual([]);
  });

  test("a redefinition wins, in place, without disturbing another scope", () => {
    expect(
      rows(`
        [[keys]]
        scope = "claude"
        label = "X"
        keys = ["ctrl+a"]

        [[keys]]
        scope = "codex"
        label = "X"
        keys = ["ctrl+b"]

        [[keys]]
        scope = "claude"
        label = "X"
        keys = ["ctrl+z"]
      `).map((r) => [r.agent, r.keys[0]]),
    ).toEqual([
      ["claude", "ctrl+z"],
      ["codex", "ctrl+b"],
    ]);
  });

  test("a `keys` key that is not an array of tables costs only its own rows", () => {
    expect(validateOperatorKeys({ keys: "ctrl+c" }, quiet)).toEqual([]);
    expect(
      validateOperatorKeys({ keys: ["ctrl+c", { label: "A", keys: ["ctrl+c"] }] }, quiet),
    ).toMatchObject([{ label: "A" }]);
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

const ONE_ROW = `[[keys]]\nlabel = "A"\nkeys = ["ctrl+a"]`;
const TWO_ROWS = `${ONE_ROW}\n\n[[keys]]\nlabel = "B"\nkeys = ["ctrl+b"]`;

describe("createOperatorKeys", () => {
  test("parses once and serves the cache until the mtime moves", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: ONE_ROW });
    const read = createOperatorKeys("/cfg/keys.toml", io, quiet);
    expect(await read()).toMatchObject([{ label: "A" }]);
    expect(await read()).toMatchObject([{ label: "A" }]);
    expect(state.reads).toBe(1);

    state.text = TWO_ROWS;
    state.mtime = 200;
    expect(await read()).toMatchObject([{ label: "A" }, { label: "B" }]);
    expect(state.reads).toBe(2);
  });

  test("a malformed rewrite keeps the last good rows, and does not re-read", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: ONE_ROW });
    const read = createOperatorKeys("/cfg/keys.toml", io, quiet);
    expect(await read()).toMatchObject([{ label: "A" }]);

    state.text = "[[keys]\nlabel = ";
    state.mtime = 200;
    expect(await read()).toMatchObject([{ label: "A" }]);
    // Warned once per change, not once per request: the failed mtime is remembered too.
    expect(await read()).toMatchObject([{ label: "A" }]);
    expect(state.reads).toBe(2);

    state.text = TWO_ROWS;
    state.mtime = 300;
    expect(await read()).toMatchObject([{ label: "A" }, { label: "B" }]);
  });

  test("no file at all is not an error", async () => {
    const { io, state } = fakeIo({ mtime: null, text: "" });
    const read = createOperatorKeys("/cfg/keys.toml", io, quiet);
    expect(await read()).toEqual([]);
    expect(state.reads).toBe(0);

    state.text = ONE_ROW;
    state.mtime = 100;
    expect(await read()).toMatchObject([{ label: "A" }]);
  });

  test("a file that never parsed serves empty rather than failing", async () => {
    const { io } = fakeIo({ mtime: 100, text: "nonsense = [" });
    const read = createOperatorKeys("/cfg/keys.toml", io, quiet);
    expect(await read()).toEqual([]);
  });
});

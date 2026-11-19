import { describe, expect, test } from "bun:test";

import type { OperatorFileIo } from "./operator-file.ts";
import { createOperatorShortcuts, validateOperatorShortcuts } from "./operator-shortcuts.ts";

// The keyboard shortcuts file: the bridge checks the SHAPE of the `[keys]` table and nothing else,
// because the web keymap owns the grammar. Driven like the keys.toml suite: the validator with parsed
// TOML, the reader through a fake io.

const quiet = () => {};

/** Parse a TOML source the way the reader does, then validate it, whole grammar in one call. */
function read(toml: string, warn: (message: string) => void = quiet) {
  return validateOperatorShortcuts(Bun.TOML.parse(toml), warn);
}

describe("validateOperatorShortcuts", () => {
  test("a string becomes a one-item list, a list is kept, and an empty string is []", () => {
    expect(
      read(`
        [keys]
        prefix = "ctrl+a"
        new_tab = ["prefix+c", "ctrl+alt+c"]
        zoom = ""
        close_column = []
      `),
    ).toEqual([{ prefix: ["ctrl+a"], new_tab: ["prefix+c", "ctrl+alt+c"], zoom: [], close_column: [] }]);
  });

  test("it holds no action list: an unknown name travels to the web", () => {
    expect(read(`[keys]\nmake_coffee = "prefix+k"`)).toEqual([{ make_coffee: ["prefix+k"] }]);
  });

  test("the binding strings are not parsed here", () => {
    expect(read(`[keys]\nzoom = ["not a chord", "ctrl+"]`)).toEqual([{ zoom: ["not a chord", "ctrl+"] }]);
  });

  test("no file, no document and no [keys] table all answer nothing to send", () => {
    expect(validateOperatorShortcuts(undefined, quiet)).toEqual([]);
    expect(validateOperatorShortcuts(null, quiet)).toEqual([]);
    expect(read("")).toEqual([]);
    expect(read(`[other]\nzoom = "z"`)).toEqual([]);
  });

  test("an empty [keys] table is a table: it answers an empty set of bindings", () => {
    expect(read(`[keys]`)).toEqual([{}]);
  });

  test("a bad entry is dropped with its name in the log, the rest of the file loads", () => {
    const logged: string[] = [];
    const out = read(
      `
        [keys]
        Zoom = "z"
        "new-tab" = "c"
        goto = 7
        help = ["prefix+?", 3]
        settings = true
        find = { key = "prefix+/" }
        home = "prefix+q"
      `,
      (message) => logged.push(message),
    );
    expect(out).toEqual([{ home: ["prefix+q"] }]);
    expect(logged).toHaveLength(6);
    for (const name of ["Zoom", "new-tab", "goto", "help", "settings", "find"]) {
      expect(logged.some((line) => line.includes(`"${name}"`))).toBe(true);
    }
  });

  test("`keys` that is not a table costs the file's bindings and nothing else", () => {
    const logged: string[] = [];
    expect(validateOperatorShortcuts({ keys: "ctrl+b" }, (m) => logged.push(m))).toEqual([]);
    expect(validateOperatorShortcuts({ keys: ["a"] }, (m) => logged.push(m))).toEqual([]);
    expect(logged).toHaveLength(2);
  });

  test("a name that would reach Object.prototype stays plain data", () => {
    const [bindings] = read(`[keys]\n__proto__ = "x"`);
    expect(Object.hasOwn(bindings ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(bindings)).toBe(Object.prototype);
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

describe("createOperatorShortcuts", () => {
  test("parses once and serves the cache until the mtime moves", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: `[keys]\nzoom = "prefix+z"` });
    const reader = createOperatorShortcuts("/cfg/shortcuts.toml", io, quiet);
    expect(await reader()).toEqual({ zoom: ["prefix+z"] });
    expect(await reader()).toEqual({ zoom: ["prefix+z"] });
    expect(state.reads).toBe(1);

    state.text = `[keys]\nzoom = ""`;
    state.mtime = 200;
    expect(await reader()).toEqual({ zoom: [] });
    expect(state.reads).toBe(2);
  });

  test("no file at all is null, not an error, and never reads", async () => {
    const { io, state } = fakeIo({ mtime: null, text: "" });
    const reader = createOperatorShortcuts("/cfg/shortcuts.toml", io, quiet);
    expect(await reader()).toBeNull();
    expect(state.reads).toBe(0);

    state.text = `[keys]\nhelp = "prefix+?"`;
    state.mtime = 100;
    expect(await reader()).toEqual({ help: ["prefix+?"] });
  });

  test("a file that is deleted again stops sending its bindings", async () => {
    const { io, state } = fakeIo({ mtime: 100, text: `[keys]\nhelp = "prefix+?"` });
    const reader = createOperatorShortcuts("/cfg/shortcuts.toml", io, quiet);
    expect(await reader()).toEqual({ help: ["prefix+?"] });
    state.mtime = null;
    expect(await reader()).toBeNull();
  });

  test("a malformed rewrite keeps the last good bindings and warns once", async () => {
    const logged: string[] = [];
    const { io, state } = fakeIo({ mtime: 100, text: `[keys]\nhelp = "prefix+?"` });
    const reader = createOperatorShortcuts("/cfg/shortcuts.toml", io, (m) => logged.push(m));
    expect(await reader()).toEqual({ help: ["prefix+?"] });

    state.text = "[keys\nhelp = ";
    state.mtime = 200;
    expect(await reader()).toEqual({ help: ["prefix+?"] });
    expect(await reader()).toEqual({ help: ["prefix+?"] });
    expect(state.reads).toBe(2);
    expect(logged).toHaveLength(1);
  });

  test("a file that never parsed serves null rather than failing", async () => {
    const { io } = fakeIo({ mtime: 100, text: "nonsense = [" });
    const reader = createOperatorShortcuts("/cfg/shortcuts.toml", io, quiet);
    expect(await reader()).toBeNull();
  });
});

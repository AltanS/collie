import { describe, expect, test } from "bun:test";

import type { OperatorFileIo } from "./operator-file.ts";
import { createOperatorShortcuts, SHORTCUT_LIMITS, validateOperatorShortcuts } from "./operator-shortcuts.ts";

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
        zen_mode = ""
        remove_from_view = []
      `),
    ).toEqual([{ prefix: ["ctrl+a"], new_tab: ["prefix+c", "ctrl+alt+c"], zen_mode: [], remove_from_view: [] }]);
  });

  test("it holds no action list: an unknown name travels to the web", () => {
    expect(read(`[keys]\nmake_coffee = "prefix+k"`)).toEqual([{ make_coffee: ["prefix+k"] }]);
  });

  test("the binding strings are not parsed here", () => {
    expect(read(`[keys]\nzen_mode = ["not a chord", "ctrl+"]`)).toEqual([{ zen_mode: ["not a chord", "ctrl+"] }]);
  });

  test("no file, no document and no [keys] table all answer nothing to send", () => {
    expect(validateOperatorShortcuts(undefined, quiet)).toEqual([]);
    expect(validateOperatorShortcuts(null, quiet)).toEqual([]);
    expect(read("")).toEqual([]);
    expect(read(`[other]\nzen_mode = "z"`)).toEqual([]);
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
        switch_pane = 7
        help = ["prefix+?", 3]
        settings = true
        find = { key = "prefix+/" }
        open_dashboard = "prefix+q"
      `,
      (message) => logged.push(message),
    );
    expect(out).toEqual([{ open_dashboard: ["prefix+q"] }]);
    expect(logged).toHaveLength(6);
    for (const name of ["Zoom", "new-tab", "switch_pane", "help", "settings", "find"]) {
      expect(logged.some((line) => line.includes(`"${name}"`))).toBe(true);
    }
  });

  describe("bounds", () => {
    const limits = SHORTCUT_LIMITS;

    /** A lower-case, unique word for an index (action names are letters and underscores). */
    function numberWord(i: number): string {
      return i.toString(26).replace(/[0-9a-p]/g, (c) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(c, 26)));
    }

    function run(keys: Record<string, string | string[]>) {
      const logged: string[] = [];
      const out = validateOperatorShortcuts({ keys }, (m) => logged.push(m));
      return { out: out[0] ?? {}, logged };
    }

    test("a name of exactly the cap loads, one over is dropped with one warn", () => {
      const atCap = "a".repeat(limits.maxNameLength);
      const overCap = "a".repeat(limits.maxNameLength + 1);
      const { out, logged } = run({ [atCap]: "x", [overCap]: "y", ok: "z" });
      expect(Object.keys(out)).toEqual([atCap, "ok"]);
      expect(logged).toHaveLength(1);
    });

    test("a list of exactly the cap loads, one over drops that entry only", () => {
      const list = (n: number) => Array.from({ length: n }, () => "ctrl+a");
      const { out, logged } = run({
        at: list(limits.maxBindingsPerName),
        over: list(limits.maxBindingsPerName + 1),
        ok: "z",
      });
      expect(Object.keys(out)).toEqual(["at", "ok"]);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('"over"');
    });

    test("a binding of exactly the cap loads, one over drops that entry only", () => {
      const { out, logged } = run({
        at: "k".repeat(limits.maxBindingLength),
        over: ["ctrl+a", "k".repeat(limits.maxBindingLength + 1)],
        ok: "z",
      });
      expect(Object.keys(out)).toEqual(["at", "ok"]);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('"over"');
    });

    test("the cap of names loads, the next one stops the table with one warn", () => {
      const keys: Record<string, string> = {};
      for (let i = 0; i < limits.maxNames + 5; i += 1) keys[`name_${numberWord(i)}`] = "x";
      expect(Object.keys(keys)).toHaveLength(limits.maxNames + 5);
      const { out, logged } = run(keys);
      expect(Object.keys(out)).toHaveLength(limits.maxNames);
      expect(logged).toHaveLength(1);
      const exact = run(Object.fromEntries(Object.entries(keys).slice(0, limits.maxNames)));
      expect(Object.keys(exact.out)).toHaveLength(limits.maxNames);
      expect(exact.logged).toHaveLength(0);
    });
  });

  describe("log forging", () => {
    test("a rejected name with a newline or a control character is quoted onto one line", () => {
      const logged: string[] = [];
      validateOperatorShortcuts(
        { keys: { "a\nb": "x", "bell\u0007\u001b[31m": "y", ["z".repeat(200)]: "w" } },
        (m) => logged.push(m),
      );
      expect(logged).toHaveLength(3);
      for (const line of logged) expect([...line].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)).toBe(false);
      expect(logged[0]).toContain('"a\\nb"');
      expect(logged[2]?.length).toBeLessThan(200);
    });

    test("a quoted TOML key holding an escaped newline reaches the warn without a newline", () => {
      const logged: string[] = [];
      read('[keys]\n"fake\\n[shortcuts] all good" = "x"', (m) => logged.push(m));
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toContain("\n");
    });
  });

  describe("control characters in a binding", () => {
    const hasControl = (line: string) => [...line].some((ch) => /\p{Cc}/u.test(ch));

    test.each([
      ["a newline", "prefix+\nc"],
      ["an escape", "ctrl+\x1b[31m"],
      ["a DEL", "ctrl+\x7f"],
      ["a C1 control", "ctrl+\u009b"],
    ])("a binding with %s drops that entry only, and the warn line holds no control character", (_label, binding) => {
      const logged: string[] = [];
      const out = validateOperatorShortcuts({ keys: { bad: binding, list: ["ctrl+a", binding], ok: "prefix+q" } }, (m) => logged.push(m));
      expect(out).toEqual([{ ok: ["prefix+q"] }]);
      expect(logged).toHaveLength(2);
      expect(logged[0]).toContain('"bad"');
      expect(logged[1]).toContain('"list"');
      for (const line of logged) expect(hasControl(line)).toBe(false);
    });
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
    const { io, state } = fakeIo({ mtime: 100, text: `[keys]\nzen_mode = "prefix+z"` });
    const reader = createOperatorShortcuts("/cfg/shortcuts.toml", io, quiet);
    expect(await reader()).toEqual({ zen_mode: ["prefix+z"] });
    expect(await reader()).toEqual({ zen_mode: ["prefix+z"] });
    expect(state.reads).toBe(1);

    state.text = `[keys]\nzen_mode = ""`;
    state.mtime = 200;
    expect(await reader()).toEqual({ zen_mode: [] });
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

import { describe, expect, test } from "bun:test";

import {
  createOperatorQuickReplies,
  validateOperatorQuickReplies,
} from "./operator-quick-replies.ts";
import type { OperatorFileIo } from "./operator-file.ts";

// The Quick dock's escape hatch: the operator's own groups, replacing the shipped English phrases
// on the panes their rows address. Driven exactly like the keys.toml suite — the validator with
// parsed TOML, the reader through a fake io.

const quiet = () => {};

/** Parse a TOML source the way the reader does, then validate it — the whole grammar in one call. */
function rows(toml: string) {
  return validateOperatorQuickReplies(Bun.TOML.parse(toml), quiet);
}

describe("validateOperatorQuickReplies", () => {
  test("reads a group, scoped and unscoped", () => {
    expect(
      rows(`
        [[replies]]
        title = "confirm"
        items = ["ja", "nein"]

        [[replies]]
        scope = "Claude"
        title = "common"
        items = ["weiter", "nochmal"]
      `),
    ).toEqual([
      { title: "confirm", items: ["ja", "nein"] },
      { agent: "claude", title: "common", items: ["weiter", "nochmal"] },
    ]);
  });

  test("no file and no rows are both simply empty", () => {
    expect(validateOperatorQuickReplies(undefined, quiet)).toEqual([]);
    expect(validateOperatorQuickReplies(null, quiet)).toEqual([]);
    expect(rows("")).toEqual([]);
  });

  test("a malformed row is dropped, the rest of the file survives", () => {
    expect(
      rows(`
        [[replies]]
        title = ""
        items = ["x"]

        [[replies]]
        title = "no items"
        items = []

        [[replies]]
        title = "not a string"
        items = ["ok", 7]

        [[replies]]
        title = "blank item"
        items = ["ok", "  "]

        [[replies]]
        title = "kept"
        items = ["yes"]
      `),
    ).toEqual([{ title: "kept", items: ["yes"] }]);
  });

  test("an unusable scope drops the row rather than widening it to every pane", () => {
    // Fail closed: reading a broken scope as "unscoped" would aim the row at panes the operator
    // never addressed — the opposite of what typing a scope was for.
    expect(
      rows(`
        [[replies]]
        scope = ""
        title = "confirm"
        items = ["ja"]

        [[replies]]
        scope = 7
        title = "common"
        items = ["weiter"]
      `),
    ).toEqual([]);
  });

  test("items are trimmed", () => {
    expect(rows(`[[replies]]\ntitle = "confirm"\nitems = ["  ja  "]`)).toEqual([
      { title: "confirm", items: ["ja"] },
    ]);
  });

  test("a redefined title wins in place, keeping the dock's order", () => {
    expect(
      rows(`
        [[replies]]
        title = "confirm"
        items = ["first"]

        [[replies]]
        title = "common"
        items = ["middle"]

        [[replies]]
        title = "confirm"
        items = ["second"]
      `),
    ).toEqual([
      { title: "confirm", items: ["second"] },
      { title: "common", items: ["middle"] },
    ]);
  });

  test("the same title under two scopes is two rows", () => {
    expect(
      rows(`
        [[replies]]
        title = "confirm"
        items = ["global"]

        [[replies]]
        scope = "claude"
        title = "confirm"
        items = ["scoped"]
      `),
    ).toEqual([
      { title: "confirm", items: ["global"] },
      { agent: "claude", title: "confirm", items: ["scoped"] },
    ]);
  });

  test("a replies key that is not an array costs the file, not a crash", () => {
    expect(rows(`replies = "nope"`)).toEqual([]);
  });
});

describe("createOperatorQuickReplies", () => {
  /** A fake disk whose mtime and text the test drives. */
  function fakeIo(state: { mtime: number | null; text: string; reads: number }): OperatorFileIo {
    return {
      mtime: async () => state.mtime,
      read: async () => {
        state.reads += 1;
        return state.text;
      },
    };
  }

  test("re-reads only when the mtime moves", async () => {
    const state = { mtime: 1, text: `[[replies]]\ntitle = "a"\nitems = ["x"]`, reads: 0 };
    const read = createOperatorQuickReplies("/cfg/quick-replies.toml", fakeIo(state), quiet);
    expect(await read()).toEqual([{ title: "a", items: ["x"] }]);
    expect(await read()).toEqual([{ title: "a", items: ["x"] }]);
    expect(state.reads).toBe(1);

    state.text = `[[replies]]\ntitle = "b"\nitems = ["y"]`;
    state.mtime = 2;
    expect(await read()).toEqual([{ title: "b", items: ["y"] }]);
    expect(state.reads).toBe(2);
  });

  test("a missing file is empty, not an error", async () => {
    const state = { mtime: null, text: "", reads: 0 };
    const read = createOperatorQuickReplies("/cfg/quick-replies.toml", fakeIo(state), quiet);
    expect(await read()).toEqual([]);
  });

  test("a file that stops parsing keeps serving the last good rows", async () => {
    const state = { mtime: 1, text: `[[replies]]\ntitle = "a"\nitems = ["x"]`, reads: 0 };
    const read = createOperatorQuickReplies("/cfg/quick-replies.toml", fakeIo(state), quiet);
    expect(await read()).toEqual([{ title: "a", items: ["x"] }]);

    state.text = "[[replies]] this is not toml";
    state.mtime = 2;
    expect(await read()).toEqual([{ title: "a", items: ["x"] }]);
  });
});

import { describe, expect, it } from "vitest";

import { ACTIONS, NO_CONTROL_ACTIONS } from "./actions";

// THE KEY HINTS KEEP TRACK OF THEMSELVES (M108). While the prefix waits, every control that an action
// key would press wears that key (components/shortcut-hint-layer.tsx), and a control names its action
// with `shortcutTarget("<id>")` (lib/shortcuts/target.ts). This test reads the sources, so nobody has to
// remember: an action with a default `prefix+` key that no control names, and that `NO_CONTROL_ACTIONS`
// does not list with a reason, fails here, and the message says what to add.

const SOURCES = import.meta.glob<string>(["../../**/*.ts", "../../**/*.tsx", "!../../**/*.test.ts", "!../../**/*.test.tsx", "!./target.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const CALL = /shortcutTarget\(\s*"([a-z_]+)"/g;

/** A line of prose in a comment may show a call as an example; it names no control. */
function isComment(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith("//") || text.startsWith("*") || text.startsWith("/*") || text.startsWith("{/*");
}

function namedActions(): Set<string> {
  const named = new Set<string>();
  for (const source of Object.values(SOURCES)) {
    for (const line of source.split("\n")) {
      if (isComment(line)) continue;
      for (const match of line.matchAll(CALL)) if (match[1] !== undefined) named.add(match[1]);
    }
  }
  return named;
}

const KNOWN = new Set<string>(ACTIONS.map((action) => action.id));
const NO_CONTROL = new Set<string>(Object.keys(NO_CONTROL_ACTIONS));
const hasPrefixKey = (defaults: readonly string[]) => defaults.some((binding) => binding.startsWith("prefix+"));

describe("key hints cover every action with a prefix key", () => {
  const named = namedActions();

  it("reads the sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(named.size).toBeGreaterThan(5);
  });

  it("names a control for each action with a default prefix key, or lists it with a reason", () => {
    const missing = ACTIONS.filter((action) => hasPrefixKey(action.defaults))
      .map((action) => action.id)
      .filter((id) => !named.has(id) && !NO_CONTROL.has(id));
    expect(
      missing,
      `${missing.join(", ")} has a default prefix key and no control wears it: add {...shortcutTarget("<id>")} to its control, or list it in NO_CONTROL_ACTIONS (lib/shortcuts/actions.ts) with the reason it has none`,
    ).toEqual([]);
  });

  it("lists no action twice: one that a control names is not on the no-control list", () => {
    const both = [...NO_CONTROL].filter((id) => named.has(id));
    expect(both, `${both.join(", ")} is named by a control and also listed in NO_CONTROL_ACTIONS: remove it from one`).toEqual([]);
  });

  it("names only actions of the table, and lists only actions of the table", () => {
    expect([...named].filter((id) => !KNOWN.has(id))).toEqual([]);
    expect([...NO_CONTROL].filter((id) => !KNOWN.has(id))).toEqual([]);
  });

  it("gives every listed action a one-line reason", () => {
    for (const [id, reason] of Object.entries(NO_CONTROL_ACTIONS)) {
      expect(reason.length, id).toBeGreaterThan(10);
      expect(reason, id).not.toContain("\n");
    }
  });
});

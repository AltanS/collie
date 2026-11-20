import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { asJsonString, parseJson } from "@/lib/json";
import { ACTIONS, DEFAULT_PREFIX } from "./actions";
import { buildKeymap } from "./keymap";
import type { UserShortcuts } from "./types";

// `shortcuts.toml.example` at the repo root is what an operator copies. Its commented lines are the
// defaults, so a row that drifts from the action table (a new action, a changed key) is a file that
// tells the operator the wrong key. Each row is `# name = "binding"` or `# name = ["a", "b"]`, which
// is also valid JSON on the right of the `=`.

const EXAMPLE = readFileSync(resolve(import.meta.dirname, "../../../../shortcuts.toml.example"), "utf8");
const ROW = /^# ([a-z_]+) = (.+)$/;

function bindingsOf(raw: string): string[] {
  const value = parseJson(raw);
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    const text = asJsonString(item);
    if (text === undefined) throw new Error(`shortcuts.toml.example: not a string or a list of strings: ${raw}`);
    return text;
  });
}

function exampleRows(): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of EXAMPLE.split("\n")) {
    const match = ROW.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    expect(rows.has(match[1]), `${match[1]} is listed twice`).toBe(false);
    rows.set(match[1], bindingsOf(match[2]));
  }
  return rows;
}

describe("shortcuts.toml.example", () => {
  const rows = exampleRows();

  it("lists every action of the table with its exact default", () => {
    for (const action of ACTIONS) expect(rows.get(action.id), action.id).toEqual([...action.defaults]);
  });

  it("lists nothing the table does not have", () => {
    const known = new Set<string>(["prefix", ...ACTIONS.map((action) => action.id)]);
    for (const name of rows.keys()) expect(known.has(name), name).toBe(true);
  });

  it("shows the default prefix", () => {
    expect(rows.get("prefix")).toEqual([DEFAULT_PREFIX]);
  });

  it("loads with no diagnostic when every line is switched on, and changes nothing", () => {
    const user: UserShortcuts = Object.fromEntries(rows);
    const loaded = buildKeymap({ defaults: ACTIONS, user });
    const shipped = buildKeymap({ defaults: ACTIONS });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.bindings).toEqual(shipped.bindings);
  });
});

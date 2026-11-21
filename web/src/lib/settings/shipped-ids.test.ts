import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ALIASES, SETTINGS } from "./index";

// EVERY SETTING ID THAT SHIPPED STAYS FOUND (ADR 0170, "an id survives a move"). `shipped-ids.json` is the list of
// every id a Collie build has declared. A search result in an old tab links to `/settings/<page>#<id>`, and a
// settings file will key on the id, so an id in the list is never dropped and never names another value: it is
// declared, or it is a key of `ALIASES` that names the id holding the value now.
//
// A new row adds its id to the list. From `web/`:
//
//     UPDATE_SHIPPED_IDS=1 bunx vitest run src/lib/settings/shipped-ids.test.ts
//
// writes the list with every declared id added, never one removed, and the diff goes in the same commit.

const FILE = join(import.meta.dirname, "shipped-ids.json");
const HOW = "add it: UPDATE_SHIPPED_IDS=1 bunx vitest run src/lib/settings/shipped-ids.test.ts (in web/), and commit shipped-ids.json";

function shipped(): string[] {
  // SAFETY: the file is this test's own output, a JSON list of ids written by the update below and read in review.
  return JSON.parse(readFileSync(FILE, "utf8")) as string[];
}

const declared = new Set<string>(SETTINGS.map((s) => s.id));
const aliases = new Map<string, string>(Object.entries(ALIASES));

if (process.env.UPDATE_SHIPPED_IDS === "1") {
  const next = [...new Set([...shipped(), ...declared])].toSorted();
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
}

describe("the shipped setting ids", () => {
  it("are sorted and unique, so a diff of the file reads", () => {
    const ids = shipped();
    expect(ids).toEqual([...new Set(ids)].toSorted());
  });

  it("each is still declared, or is an alias of the id that holds its value now", () => {
    const lost = shipped().filter((id) => !declared.has(id) && !aliases.has(id));
    expect(lost, "a shipped id is never dropped: declare it again, or add it to ALIASES (pages.ts) with the id it moved to").toEqual([]);
  });

  it("holds every declared id", () => {
    const list = new Set(shipped());
    const fresh = [...declared].filter((id) => !list.has(id));
    expect(fresh, `a new setting id is not in shipped-ids.json; ${HOW}`).toEqual([]);
  });

  it("has aliases that shipped, are not declared again, and name a declared id", () => {
    const list = new Set(shipped());
    for (const [old, now] of aliases) {
      expect(list.has(old), `${old}: an alias key is an id that shipped`).toBe(true);
      expect(declared.has(old), `${old}: an alias key is never declared again`).toBe(false);
      expect(declared.has(now), `${old} -> ${now}: an alias names a declared id`).toBe(true);
    }
  });
});

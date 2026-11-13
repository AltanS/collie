import { describe, expect, it } from "vitest";

import { entryMatches, findEntries, queryWords } from "./find";

const WALKY = { id: "walky", title: "WalkyTalky", keywords: ["ItemView", "PaneActionsSheet", "walky-talky"] };
const CHANGES = { id: "changes", title: "Changes", keywords: ["diff", "worktree", "FileView"] };
const PANE = { id: "pane-settings", title: "Pane settings", keywords: ["PaneSettingsView", "sheet"] };

describe("finding an entry", () => {
  it("splits a query into lower-case words and drops a leading #", () => {
    expect(queryWords("  #Walky   Sheet ")).toEqual(["walky", "sheet"]);
    expect(queryWords("")).toEqual([]);
  });

  it("matches the title, the id and the keywords, in any case, as part of a word", () => {
    expect(entryMatches(WALKY, "talky")).toBe(true);
    expect(entryMatches(CHANGES, "WORKTREE")).toBe(true);
    expect(entryMatches(PANE, "pane-settings")).toBe(true);
    expect(entryMatches(PANE, "#pane-settings")).toBe(true);
    expect(entryMatches(WALKY, "itemv")).toBe(true);
  });

  it("needs every word of the query", () => {
    expect(entryMatches(WALKY, "walky sheet")).toBe(true);
    expect(entryMatches(WALKY, "walky diff")).toBe(false);
  });

  it("finds every entry for an empty query and none for a word nobody carries, in their own order", () => {
    expect(findEntries([WALKY, CHANGES, PANE], " ").map((e) => e.id)).toEqual(["walky", "changes", "pane-settings"]);
    expect(findEntries([WALKY, CHANGES, PANE], "sheet").map((e) => e.id)).toEqual(["walky", "pane-settings"]);
    expect(findEntries([WALKY, CHANGES, PANE], "zzz")).toEqual([]);
  });
});

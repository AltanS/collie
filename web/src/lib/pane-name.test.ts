import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isUnnamedTab,
  paneCwdLine,
  paneName,
  panePlace,
  panePlaceParts,
  paneHasOwnName,
  PLACE_SEP,
  tabCellTitle,
  tabTitle,
} from "./pane-name";
import type { AgentView, TabView } from "./types";

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w0:p1",
    workspaceId: "w0",
    workspaceLabel: "moonward_os",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/kon/dev/moonward",
    focused: false,
    kind: "agent",
    ...over,
  };
}

const tab = (over: Partial<TabView> = {}): TabView => ({
  tabId: "w0:t1",
  workspaceId: "w0",
  number: 1,
  label: "fix-auth",
  focused: false,
  paneCount: 1,
  ...over,
});

// ── THE SHARED FIXTURES ──────────────────────────────────────────────────────
// The rule is written twice — here and in bridge/pane-name.ts, because a push has to name a pane the
// way the screens do and the two trees cannot import one another. `bridge/pane-name.fixtures.json` is
// the one set of cases BOTH sides run (bridge/pane-name.test.ts is the other reader), so a rule
// changed on one side alone turns one of the two red.
interface Fixtures {
  names: { case: string; pane: Partial<AgentView> & { agent: string }; name: string }[];
  tabs: { label: string | null; unnamed: boolean }[];
  places: { space: string; tab: string | null; place: string }[];
}
// SAFETY: the file is this repo's own, it is read at test time only, and its shape is asserted by
// every case below — a field renamed there fails here as an undefined expectation rather than
// passing silently. The bridge's own reader (bridge/pane-name.test.ts) imports the same file typed.
const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../bridge/pane-name.fixtures.json"), "utf8"),
) as Fixtures;

describe("paneName — the one name rule, on the shared fixtures", () => {
  for (const c of fixtures.names) {
    it(c.case, () => {
      expect(paneName(pane(c.pane))).toBe(c.name);
    });
  }

  it("ignores the place entirely: a pane in a named tab still reads as itself", () => {
    expect(paneName(pane({ tabLabel: "UI work", terminalTitle: "Reviewing the diff" }))).toBe(
      "Reviewing the diff",
    );
    // …and a pane with nothing of its own reads as its agent, never as `space › tab`. The header used
    // to answer this one with the address, which is what made one pane read two ways.
    expect(paneName(pane({ tabLabel: "UI work" }))).toBe("claude");
  });
});

describe("isUnnamedTab — on the shared fixtures", () => {
  for (const c of fixtures.tabs) {
    it(`${JSON.stringify(c.label)} is ${c.unnamed ? "unnamed" : "a name"}`, () => {
      expect(isUnnamedTab(c.label)).toBe(c.unnamed);
    });
  }

  it("is undefined-safe, because a pane's own tabLabel is optional", () => {
    expect(isUnnamedTab(undefined)).toBe(true);
  });
});

describe("panePlace — the one place rule, on the shared fixtures", () => {
  for (const c of fixtures.places) {
    it(`${c.space} + ${JSON.stringify(c.tab)} reads as ${c.place}`, () => {
      const view = c.tab === null ? pane({ workspaceLabel: c.space }) : pane({ workspaceLabel: c.space, tabLabel: c.tab });
      // The fixture's own `place` is the MIRRORED expectation — what `isUnnamedTab`/`placeOf` still
      // share with the bridge (drop the tab entirely). A positional tab (unnamed, a digit sitting in
      // the raw label) is the one case web and bridge now disagree on ON PURPOSE: the web's
      // `panePlace` reads the tab's POSITION (`tabTitle`, web-only) instead of dropping it, so its
      // expectation here is derived locally rather than taken from the shared fixture.
      const title = c.tab === null ? null : tabTitle(c.tab);
      const expected = title?.positional ? `${c.space}${PLACE_SEP}${title.text}` : c.place;
      expect(panePlace(view)).toBe(expected);
    });
  }

  it("joins with the crumb, never a middot — a space CONTAINS a tab", () => {
    expect(PLACE_SEP).toBe(" › ");
    expect(panePlace(pane({ tabLabel: "fix-auth" }))).toBe("moonward_os › fix-auth");
  });

  it("falls back to the workspace id when a space has no label at all", () => {
    expect(panePlace(pane({ workspaceLabel: "" }))).toBe("w0");
  });
});

describe("panePlaceParts — the two halves, so the tab survives truncation", () => {
  it("keeps the halves apart", () => {
    expect(panePlaceParts(pane({ tabLabel: "fix-auth" }))).toEqual({
      space: "moonward_os",
      tab: { text: "fix-auth", positional: false },
    });
  });

  it("reports the tab's position, not its raw number, when the tab is unnamed", () => {
    expect(panePlaceParts(pane({ tabLabel: "1" })).tab).toEqual({ text: "tab 1", positional: true });
    expect(panePlaceParts(pane()).tab).toBeNull();
  });

  it("prefers the RAW tab list when the caller has one — the pane header's path", () => {
    // The header reads `tabs[]`, which is unfiltered: the positional label the bridge already
    // dropped from `tabLabel` is still there, and the SAME rule has to drop it a second time.
    expect(panePlaceParts(pane(), [tab({ label: "1" })]).tab).toEqual({
      text: "tab 1",
      positional: true,
    });
    expect(panePlaceParts(pane(), [tab({ label: "UI work" })]).tab).toEqual({
      text: "UI work",
      positional: false,
    });
  });

  it("never takes another machine's tab of the same id", () => {
    const mine = pane({ host: "alpha" });
    expect(panePlaceParts(mine, [{ ...tab(), host: "beta", label: "theirs" }]).tab).toBeNull();
    expect(panePlaceParts(mine, [{ ...tab(), host: "alpha", label: "mine" }]).tab).toEqual({
      text: "mine",
      positional: false,
    });
    // An untagged tab is ambient, the same rule lib/hosts.ts makes, so a solo snapshot is unchanged.
    expect(panePlaceParts(mine, [tab({ label: "solo" })]).tab).toEqual({
      text: "solo",
      positional: false,
    });
  });

  it("trims, so a padded tab name does not render with its padding", () => {
    expect(panePlaceParts(pane({ tabLabel: "  deploy  " })).tab).toEqual({
      text: "deploy",
      positional: false,
    });
  });
});

describe("tabTitle — one function for a tab's title, named or positional", () => {
  it("names a real tab, unchanged", () => {
    expect(tabTitle("fix-auth")).toEqual({ text: "fix-auth", positional: false });
  });

  it("trims a real name", () => {
    expect(tabTitle("  deploy  ")).toEqual({ text: "deploy", positional: false });
  });

  it("reads a herdr-numbered tab's position off its digit", () => {
    expect(tabTitle("2")).toEqual({ text: "tab 2", positional: true });
  });

  it("reads a zellij-numbered tab's position off its digit", () => {
    expect(tabTitle("Tab #3")).toEqual({ text: "tab 3", positional: true });
  });

  it("is null for an empty label — no name and no digit to read", () => {
    expect(tabTitle("")).toBeNull();
    expect(tabTitle(undefined)).toBeNull();
    expect(tabTitle(null)).toBeNull();
  });
});

describe("paneCwdLine — line 2 where the place is already the heading", () => {
  it("shortens the path for a phone row", () => {
    expect(paneCwdLine(pane({ cwd: "/home/kon/dev/moonward" }))).toBe("~/dev/moonward");
  });

  it("says nothing when the multiplexer reports no cwd (every zellij pane)", () => {
    expect(paneCwdLine(pane({ cwd: "" }))).toBeNull();
  });
});

// A BELT CELL NAMES WHAT THE HEADER NAMES. A one-pane tab is that pane, so the cell says the pane's
// name (`paneName`) and the open cell matches the header line above it. The tab's own title stays
// for a group, for an empty tab, and for a sole pane that has only a kind to its name.
describe("tabCellTitle — what a belt cell says", () => {
  it("names a one-pane tab after its pane", () => {
    expect(tabCellTitle("work", [pane({ sessionName: "plumbing" })])).toEqual({
      text: "plumbing",
      positional: false,
    });
  });

  it("prefers the pane's name even over a positional tab label", () => {
    expect(tabCellTitle("1", [pane({ terminalTitle: "Figaro ad removal test" })])).toEqual({
      text: "Figaro ad removal test",
      positional: false,
    });
  });

  it("keeps the tab's title when the sole pane has only a kind to its name", () => {
    expect(paneHasOwnName(pane())).toBe(false);
    expect(tabCellTitle("docs", [pane()])).toEqual({ text: "docs", positional: false });
    expect(tabCellTitle("2", [pane({ kind: "shell", agent: "shell" })])).toEqual({
      text: "tab 2",
      positional: true,
    });
  });

  it("treats a stale title as no name", () => {
    expect(paneHasOwnName(pane({ terminalTitle: "vim", terminalTitleStale: true }))).toBe(false);
    expect(tabCellTitle("docs", [pane({ terminalTitle: "vim", terminalTitleStale: true })])?.text).toBe("docs");
  });

  it("keeps the tab's title for a group of panes, and for an empty tab", () => {
    const two = [pane({ terminalTitle: "one" }), pane({ paneId: "w0:p2", terminalTitle: "two" })];
    expect(tabCellTitle("work", two)?.text).toBe("work");
    expect(tabCellTitle("work", [])?.text).toBe("work");
    expect(tabCellTitle("", [])).toBeNull();
  });
});

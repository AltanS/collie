import { describe, expect, test } from "bun:test";

import fixtures from "./pane-name.fixtures.json" with { type: "json" };
import { isUnnamedTab, paneName, panePlace, placeOf, PLACE_SEP } from "./pane-name.ts";
import type { AgentView } from "./types.ts";

// The bridge half of a mirrored rule. `web/src/lib/pane-name.test.ts` runs the SAME file's cases over
// the web's copy, so a rule changed on one side alone turns one of the two red. Anything that is not
// the shared rule — how a push spends it — is pinned in notifications.test.ts.

function pane(over: Partial<AgentView> & { agent: string }): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    status: "idle",
    cwd: "/home/you/demo",
    focused: false,
    kind: "agent",
    ...over,
  };
}

describe("paneName — the one name rule, on the shared fixtures", () => {
  for (const c of fixtures.names) {
    test(c.case, () => {
      // SAFETY: every `pane` in the fixture file carries a string `agent` and otherwise only fields
      // AgentView declares — the shape is pinned by this file's own cases, and a case missing `agent`
      // fails the very assertion below rather than passing silently.
      const fields = c.pane as Partial<AgentView> & { agent: string };
      expect(paneName(pane(fields))).toBe(c.name);
    });
  }
});

describe("isUnnamedTab — on the shared fixtures", () => {
  for (const c of fixtures.tabs) {
    test(`${JSON.stringify(c.label)} is ${c.unnamed ? "unnamed" : "a name"}`, () => {
      expect(isUnnamedTab(c.label)).toBe(c.unnamed);
    });
  }

  test("is undefined-safe, because a pane's own tabLabel is optional", () => {
    expect(isUnnamedTab(undefined)).toBe(true);
  });
});

describe("panePlace — the one place rule, on the shared fixtures", () => {
  for (const c of fixtures.places) {
    test(`${c.space} + ${JSON.stringify(c.tab)} reads as ${c.place}`, () => {
      expect(placeOf(c.space, c.tab)).toBe(c.place);
    });
  }

  test("joins with the crumb, never a middot — a space CONTAINS a tab", () => {
    expect(PLACE_SEP).toBe(" › ");
    expect(panePlace(pane({ agent: "claude", tabLabel: "UI work" }))).toBe("demo › UI work");
  });

  test("a pane whose tab the bridge already filtered carries the space alone", () => {
    expect(panePlace(pane({ agent: "claude" }))).toBe("demo");
  });
});

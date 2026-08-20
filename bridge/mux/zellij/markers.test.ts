import { describe, expect, test } from "bun:test";

import { FakeZellij, SESSION } from "./fixture.ts";
import { zellijBeaconMatcher } from "./markers.ts";
import { ZELLIJ_MUX } from "./adapter.ts";
import { ZellijSessionBinding } from "./session.ts";
import type { MuxPane } from "../types.ts";

// The zellij half of the beacon join: the prefix and the session scope, each pinned on its own.

function pane(paneId: string): MuxPane {
  return {
    paneId,
    spaceId: "session",
    spaceLabel: SESSION,
    spaceNumber: 1,
    tabId: "tab_1",
    cwd: "",
    focused: false,
    alive: true,
    agent: "shell",
    status: "unknown",
  };
}

function matcher(): ReturnType<typeof zellijBeaconMatcher> {
  return zellijBeaconMatcher(ZELLIJ_MUX, new ZellijSessionBinding(new FakeZellij(), ""));
}

describe("zellijBeaconMatcher", () => {
  test("reads its own namespace, which is the registry key the emitter writes", () => {
    expect(matcher().namespace).toBe(ZELLIJ_MUX);
  });

  test("the scope is the session the binding resolved, not its display label", async () => {
    expect(await matcher().scope()).toBe(SESSION);
  });

  test("a bare ZELLIJ_PANE_ID joins the prefixed Collie id", () => {
    expect(matcher().matches(pane("terminal_3"), { namespace: ZELLIJ_MUX, scope: SESSION, pane: "3" }, SESSION)).toBe(true);
  });

  test("the bare integer alone never matches — plugin_3 and terminal_3 both exist", () => {
    expect(matcher().matches(pane("3"), { namespace: ZELLIJ_MUX, scope: SESSION, pane: "3" }, SESSION)).toBe(false);
    expect(matcher().matches(pane("plugin_3"), { namespace: ZELLIJ_MUX, scope: SESSION, pane: "3" }, SESSION)).toBe(false);
  });

  test("another session's same-numbered pane is a different pane", () => {
    expect(matcher().matches(pane("terminal_3"), { namespace: ZELLIJ_MUX, scope: "elsewhere", pane: "3" }, SESSION)).toBe(false);
  });
});

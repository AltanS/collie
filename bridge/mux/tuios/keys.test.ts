import { describe, expect, test } from "bun:test";

import { MUX_NAMED_KEYS } from "../keys.ts";
import { defaultTuiosSocket } from "./client.ts";
import { routeEvent, subscriptionTypes } from "./events.ts";
import { toTuiosKey, TUIOS_UNSENDABLE_KEYS } from "./keys.ts";

// The key table, the event routing and the socket default are pure, so they are pinned here rather
// than only through the conformance world. Each expectation is a spelling the probe saw tuios take.

describe("toTuiosKey", () => {
  test("every named key keeps its contract name", () => {
    for (const key of MUX_NAMED_KEYS) expect(toTuiosKey(key)).toEqual({ ok: true, key });
  });

  test.each([
    ["ctrl+c", "ctrl+c"],
    ["shift+Tab", "shift+Tab"],
    ["ctrl+alt+Delete", "ctrl+alt+Delete"],
    ["a", "a"],
    ["+", "+"],
    [" ", "Space"],
    ["ctrl+ ", "ctrl+Space"],
  ])("%p goes on the wire as %p", (neutral, wire) => {
    expect(toTuiosKey(neutral)).toEqual({ ok: true, key: wire });
  });

  test("a comma is spelled Comma, because the daemon splits keys on commas", () => {
    expect(toTuiosKey(",")).toEqual({ ok: true, key: "Comma" });
    expect(toTuiosKey("alt+,")).toEqual({ ok: true, key: "alt+Comma" });
  });

  test("a meta chord is refused: tuios has no Super or Command key", () => {
    expect(toTuiosKey("meta+k")).toEqual({ ok: false, reason: "meta" });
  });

  test("tuios sends the whole alphabet, so no key is declared unsendable", () => {
    expect(TUIOS_UNSENDABLE_KEYS).toEqual([]);
  });
});

describe("routeEvent", () => {
  const watched = new Set(["w1"]);

  test("a window, workspace or session change is topology", () => {
    for (const type of ["window-created", "window-closed", "window-retitled", "workspace-switched", "workspace-renamed", "session-closed", "gap"]) {
      expect(routeEvent(type, "w1", watched)).toEqual({ kind: "topology" });
    }
  });

  test("a watched pane's state or output is that pane's change", () => {
    expect(routeEvent("agent-state", "w1", watched)).toEqual({ kind: "pane", paneId: "w1" });
    expect(routeEvent("output", "w1", watched)).toEqual({ kind: "pane", paneId: "w1" });
  });

  test("an unwatched pane's state re-reads the herd; its output reads nothing", () => {
    expect(routeEvent("agent-state", "w2", watched)).toEqual({ kind: "topology" });
    expect(routeEvent("output", "w2", watched)).toEqual({ kind: "none" });
  });

  test("output is subscribed only while a pane is watched", () => {
    expect(subscriptionTypes([])).not.toContain("output");
    expect(subscriptionTypes(["w1"])).toContain("output");
  });
});

describe("defaultTuiosSocket", () => {
  test("the runtime dir wins, and /tmp/tuios-<uid> is the fallback, as in tuios", () => {
    expect(defaultTuiosSocket("/run/user/1000", 1000)).toBe("/run/user/1000/tuios/tuios.sock");
    expect(defaultTuiosSocket(undefined, 1000)).toBe("/tmp/tuios-1000/tuios.sock");
    expect(defaultTuiosSocket("  ", 1000)).toBe("/tmp/tuios-1000/tuios.sock");
  });
});

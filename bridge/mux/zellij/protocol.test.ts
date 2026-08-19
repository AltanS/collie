import { describe, expect, test } from "bun:test";

import { formatMuxKey } from "../keys.ts";
import { toZellijKey } from "./keys.ts";
import {
  censusSignature,
  chooseSession,
  closeTabArgs,
  dumpScreenArgs,
  parsePaneList,
  parseSessionList,
  parseStreamEvent,
  parseTabList,
  renameTabArgs,
  sendKeysArgs,
  subscribeArgs,
  tabNumberOf,
  writeCharsArgs,
  ZELLIJ_LIST_PANES_ARGS,
} from "./protocol.ts";

// Every fixture below is a verbatim shape from the M10/05 probe against zellij 0.44.2. A parser
// tested against invented JSON tests the invention.

const PROBED_PANES = JSON.stringify([
  { id: 0, is_plugin: true, is_focused: false, title: "(.) - zellij:link", exited: false, tab_id: 0, tab_position: 0, tab_name: "Tab #1" },
  { id: 1, is_plugin: true, is_focused: false, title: "tab-bar", exited: false, tab_id: 0, tab_position: 0, tab_name: "Tab #1" },
  {
    id: 0,
    is_plugin: false,
    is_focused: true,
    title: "Pane #1",
    exited: false,
    pane_content_rows: 23,
    terminal_command: null,
    tab_id: 0,
    tab_position: 0,
    tab_name: "Tab #1",
  },
  {
    id: 2,
    is_plugin: false,
    is_focused: false,
    title: "probepane",
    exited: true,
    pane_content_rows: 23,
    terminal_command: null,
    tab_id: 1,
    tab_position: 1,
    tab_name: "probetab",
  },
]);

describe("parsePaneList", () => {
  test("keeps terminals, drops zellij's own plugin furniture", () => {
    const panes = parsePaneList(PROBED_PANES);
    expect(panes?.map((pane) => pane.paneId)).toEqual(["terminal_0", "terminal_2"]);
  });

  // `plugin_0` and `terminal_0` both existed in the probe, so the bare integer is not an identity.
  test("the namespaced spelling is what makes the id unique", () => {
    const panes = parsePaneList(PROBED_PANES);
    expect(new Set(panes?.map((pane) => pane.paneId)).size).toBe(2);
  });

  test("carries the fields the snapshot and the census both read", () => {
    const pane = parsePaneList(PROBED_PANES)?.at(1);
    expect(pane).toEqual({
      paneId: "terminal_2",
      focused: false,
      exited: true,
      title: "probepane",
      tabNumber: 1,
      tabPosition: 1,
      tabName: "probetab",
      contentRows: 23,
    });
  });

  test("anything that is not a listing is null, not an empty herd", () => {
    expect(parsePaneList("")).toBeNull();
    expect(parsePaneList("Session 'x' not found.")).toBeNull();
    expect(parsePaneList("{}")).toBeNull();
  });

  test("a row missing the two fields identity needs is skipped, not guessed at", () => {
    expect(parsePaneList('[{"is_plugin":false,"title":"orphan"}]')).toEqual([]);
  });
});

describe("parseTabList", () => {
  const probed = JSON.stringify([
    {
      position: 0,
      name: "Tab #1",
      active: true,
      tab_id: 0,
      selectable_tiled_panes_count: 1,
      selectable_floating_panes_count: 1,
    },
  ]);

  test("counts tiled and floating panes together — both are places a shell runs", () => {
    expect(parseTabList(probed)).toEqual([{ tabNumber: 0, position: 0, name: "Tab #1", active: true, paneCount: 2 }]);
  });
});

describe("censusSignature", () => {
  const panes = parsePaneList(PROBED_PANES) ?? [];

  test("moves when a tab is renamed", () => {
    const renamed = panes.map((pane) => ({ ...pane, tabName: "renamed" }));
    expect(censusSignature(renamed)).not.toBe(censusSignature(panes));
  });

  // Focus changes every time the operator looks at another pane; a topology callback for it is a
  // snapshot re-read with nothing in it.
  test("does not move when focus does", () => {
    const refocused = panes.map((pane) => ({ ...pane, focused: !pane.focused }));
    expect(censusSignature(refocused)).toBe(censusSignature(panes));
  });
});

describe("parseSessionList / chooseSession", () => {
  // Verbatim from `zellij list-sessions --no-formatting`.
  const probed = "chatty-salamander [Created 3months 12days ago] (EXITED - attach to resurrect)\ncollieprobe [Created 6m 36s ago] \n";

  test("reads the name and whether it is still running", () => {
    expect(parseSessionList(probed)).toEqual([
      { name: "chatty-salamander", running: false },
      { name: "collieprobe", running: true },
    ]);
  });

  test("no configured name means the single running session", () => {
    expect(chooseSession(parseSessionList(probed), "")).toEqual({ ok: true, session: "collieprobe" });
  });

  test("a configured name is honoured", () => {
    expect(chooseSession(parseSessionList(probed), "collieprobe")).toEqual({ ok: true, session: "collieprobe" });
  });

  // An exited session is refused BY NAME rather than silently replaced by a neighbour: a collie
  // pointed at "work" must never quietly start driving "scratch".
  test("a configured session that has exited is refused, and the message says how to bring it back", () => {
    const choice = chooseSession(parseSessionList(probed), "chatty-salamander");
    expect(choice.ok).toBe(false);
    if (choice.ok) throw new Error("expected a refusal");
    expect(choice.detail).toContain("exited");
    expect(choice.detail).toContain("attach");
  });

  test("two running sessions and no configured name is refused rather than guessed", () => {
    const choice = chooseSession(
      [
        { name: "one", running: true },
        { name: "two", running: true },
      ],
      "",
    );
    expect(choice.ok).toBe(false);
    if (choice.ok) throw new Error("expected a refusal");
    expect(choice.detail).toContain("COLLIE_MUX_ENDPOINT_ZELLIJ");
  });

  test("no running session at all is a refusal, not an empty herd", () => {
    expect(chooseSession([], "").ok).toBe(false);
  });
});

describe("parseStreamEvent", () => {
  test("a repaint carries the pane and its screen", () => {
    const line = JSON.stringify({
      event: "pane_update",
      is_initial: true,
      pane_id: "terminal_2",
      scrollback: null,
      viewport: ["[mfirst", "[msecond"],
    });
    expect(parseStreamEvent(line)).toEqual({ kind: "update", paneId: "terminal_2", text: "[mfirst\n[msecond" });
  });

  // The one topology fact zellij's command line does announce.
  test("a closed pane is its own event", () => {
    expect(parseStreamEvent('{"event":"pane_closed","pane_id":"terminal_3"}')).toEqual({
      kind: "closed",
      paneId: "terminal_3",
    });
  });

  test("anything else on the stream is ignored rather than half-read", () => {
    expect(parseStreamEvent("")).toBeNull();
    expect(parseStreamEvent("not json")).toBeNull();
    expect(parseStreamEvent('{"event":"pane_update"}')).toBeNull();
    expect(parseStreamEvent('{"event":"something_new","pane_id":"terminal_1"}')).toBeNull();
  });
});

describe("the argv", () => {
  test("a listing always asks for the machine form", () => {
    expect(ZELLIJ_LIST_PANES_ARGS).toContain("--json");
  });

  test("styling and scope are real branches, not fields nobody reads", () => {
    expect(dumpScreenArgs("terminal_1", true, false)).toEqual(["action", "dump-screen", "--pane-id", "terminal_1", "--ansi"]);
    expect(dumpScreenArgs("terminal_1", false, true)).toEqual(["action", "dump-screen", "--pane-id", "terminal_1", "--full"]);
  });

  // Probed: without `--`, `-n hello` was rejected as an unknown option.
  test("operator text always sits behind `--`, so a leading dash is text", () => {
    expect(writeCharsArgs("terminal_1", "-n hello").at(-2)).toBe("--");
    expect(sendKeysArgs("terminal_1", ["-"]).at(-2)).toBe("--");
    expect(renameTabArgs(3, "-label")).toEqual(["action", "rename-tab-by-id", "--", "3", "-label"]);
  });

  test("the stream names every pane it follows", () => {
    expect(subscribeArgs(["terminal_1", "terminal_2"])).toEqual([
      "subscribe",
      "--ansi",
      "--format",
      "json",
      "--pane-id",
      "terminal_1",
      "--pane-id",
      "terminal_2",
    ]);
  });

  test("a tab is addressed by its stable id", () => {
    expect(closeTabArgs(2)).toEqual(["action", "close-tab-by-id", "--", "2"]);
  });
});

describe("tabNumberOf", () => {
  test("round-trips a tab id and refuses anything that is not one", () => {
    expect(tabNumberOf("tab_0")).toBe(0);
    expect(tabNumberOf("tab_12")).toBe(12);
    // A pane id must never resolve to a tab: the two namespaces are unrelated.
    expect(tabNumberOf("terminal_1")).toBeNull();
    expect(tabNumberOf("tab_")).toBeNull();
    expect(tabNumberOf("tab_x")).toBeNull();
  });
});

describe("toZellijKey", () => {
  // The neutral chords are COMPOSED rather than spelled out, for the reason keys.ts gives about
  // itself: a literal chord of another multiplexer's grammar must not exist anywhere under this
  // directory, or a future translation could be written to match on one.
  test.each([
    [formatMuxKey({ modifiers: [], key: "c" }), "c"],
    [formatMuxKey({ modifiers: ["ctrl"], key: "c" }), "Ctrl c"],
    [formatMuxKey({ modifiers: ["alt", "shift"], key: "b" }), "Alt Shift b"],
    [formatMuxKey({ modifiers: [], key: "Escape" }), "Esc"],
    [formatMuxKey({ modifiers: ["shift"], key: "Tab" }), "Shift Tab"],
    [formatMuxKey({ modifiers: [], key: "PageUp" }), "PageUp"],
    [formatMuxKey({ modifiers: [], key: "Delete" }), "Delete"],
    [formatMuxKey({ modifiers: [], key: "F7" }), "F7"],
    [formatMuxKey({ modifiers: [], key: ";" }), ";"],
  ])("%s becomes %s", (neutral, zellij) => {
    expect(toZellijKey(neutral)).toEqual({ ok: true, key: zellij });
  });

  // Probed: `send-keys "Super a"` exits 0 and the pane receives a bare `a`. Passing the chord through
  // would turn "send Super+a" into "type a" at a live agent.
  test("a Super/Command chord is refused rather than delivered as the bare key", () => {
    expect(toZellijKey(formatMuxKey({ modifiers: ["meta"], key: "a" }))).toEqual({ ok: false, reason: "meta" });
  });

  test("something that is not a key at all is refused before a process is spawned", () => {
    expect(toZellijKey("Nonsense")).toEqual({ ok: false, reason: "unparsed" });
    expect(toZellijKey("")).toEqual({ ok: false, reason: "unparsed" });
  });
});

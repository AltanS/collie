import { describe, expect, test } from "bun:test";

import { CAPS } from "./clean.ts";
import { hasHostileChars, helloFixture, hostileText, snapshotFixture, type FakeSnapshot } from "./fixture.ts";
import {
  DURABLE_SERVICE,
  NOT_A_DURABLE_PROGRAM,
  incompatibleDetail,
  negotiateVersion,
  parseHello,
  parseProblem,
  parseSnapshot,
  parseStarterReply,
  statusOf,
  toMuxSnapshot,
  type DurableAsk,
  type DurableSnapshot,
} from "./protocol.ts";

const EPOCH = "e4b1c7a09d3f5e826b7a1c0d94f3e582";

/** The recorded snapshot with a change made to it, as the text a program would send. */
function snapshotText(change: (snapshot: FakeSnapshot) => void = () => undefined): string {
  const snapshot = snapshotFixture();
  change(snapshot);
  return JSON.stringify({ rev: 12, epoch: EPOCH, ...snapshot });
}

function read(change?: (snapshot: FakeSnapshot) => void): DurableSnapshot {
  const parsed = parseSnapshot(snapshotText(change), true);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}

describe("version negotiation", () => {
  test("the highest version inside both ranges wins", () => {
    expect(negotiateVersion({ min: 1, max: 1 })).toBe(1);
    expect(negotiateVersion({ min: 1, max: 4 })).toBe(1);
    expect(negotiateVersion({ min: 0, max: 9 })).toBe(1);
  });

  test("ranges that do not meet have no version", () => {
    expect(negotiateVersion({ min: 2, max: 3 })).toBeNull();
    expect(negotiateVersion({ min: 0, max: 0 })).toBeNull();
  });

  test("the detail starts with incompatible and names both ranges", () => {
    expect(incompatibleDetail({ min: 2, max: 3 })).toBe(
      "incompatible: program speaks 2..3, this Collie speaks 1..1",
    );
    expect(incompatibleDetail(null)).toBe("incompatible");
  });
});

describe("hello", () => {
  test("the recorded hello decodes, and terminal is ignored", () => {
    const parsed = parseHello(JSON.stringify({ ...helloFixture(), protocol: { min: 1, max: 1 }, epoch: EPOCH, ready: true }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        protocol: { min: 1, max: 1 },
        hostName: "denis-laptop",
        epoch: EPOCH,
        ready: true,
        caps: { asks: true, starters: true, send: true, steer: true, abort: true },
      },
    });
  });

  test("an absent cap is false, and null reads as absent", () => {
    const parsed = parseHello(
      JSON.stringify({ service: "collie-durable", protocol: { min: 1, max: 1 }, host: null, epoch: EPOCH, ready: false, caps: { asks: null, send: true } }),
    );
    expect(parsed.ok && parsed.value.caps).toEqual({ asks: false, starters: false, send: true, steer: false, abort: false });
    expect(parsed.ok && parsed.value.hostName).toBe("");
  });

  test("a hello with no usable range, epoch or ready flag is refused", () => {
    const base = { protocol: { min: 1, max: 1 }, host: { name: "h" }, epoch: EPOCH, ready: true, caps: {} };
    for (const broken of [
      { ...base, protocol: { min: 2, max: 1 } },
      { ...base, protocol: { min: -1, max: 1 } },
      { ...base, protocol: { min: 1.5, max: 2 } },
      { ...base, protocol: null },
      { ...base, epoch: "has space" },
      { ...base, epoch: "" },
      { ...base, ready: "yes" },
    ]) {
      expect(parseHello(JSON.stringify(broken)).ok).toBe(false);
    }
    expect(parseHello("not json").ok).toBe(false);
    expect(parseHello("[]").ok).toBe(false);
  });

  test("the host name is cleaned and capped like every display string", () => {
    const parsed = parseHello(
      JSON.stringify({ service: "collie-durable", protocol: { min: 1, max: 1 }, host: { name: hostileText("evil", 200) }, epoch: EPOCH, ready: true }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.hostName.startsWith("evil")).toBe(true);
    expect(parsed.value.hostName.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(parsed.value.hostName)).toBeLessThanOrEqual(CAPS.hostName);
  });

  test("a hello without the service name is not a durable program, whatever else it says", () => {
    const base = { protocol: { min: 1, max: 1 }, host: { name: "h" }, epoch: EPOCH, ready: true, caps: {} };
    for (const service of [undefined, null, "", "collie", "Collie-Durable", 1]) {
      expect(parseHello(JSON.stringify({ ...base, service }))).toEqual({ ok: false, detail: NOT_A_DURABLE_PROGRAM });
    }
    expect(parseHello(JSON.stringify({ ...base, service: DURABLE_SERVICE })).ok).toBe(true);
    // Checked first: a wrong socket with no range at all is still named as a wrong program.
    expect(parseHello(JSON.stringify({ hello: "world" }))).toEqual({ ok: false, detail: NOT_A_DURABLE_PROGRAM });
  });

  test("an error body gives its code and range", () => {
    expect(parseProblem(JSON.stringify({ code: "incompatible", range: { min: 2, max: 3 } }))).toEqual({
      code: "incompatible",
      message: "",
      range: { min: 2, max: 3 },
    });
    expect(parseProblem("<html>")).toEqual({ code: "", message: "", range: null });
  });

  test("an error body's message is cleaned and cut to 512 bytes", () => {
    const parsed = parseProblem(JSON.stringify({ code: "starter-failed", message: hostileText("no model", 2000) }));
    expect(hasHostileChars(parsed.message)).toBe(false);
    expect(Buffer.byteLength(parsed.message)).toBeLessThanOrEqual(CAPS.problemMessage);
  });

  test("a starter reply needs a usable pane id", () => {
    expect(parseStarterReply(JSON.stringify({ paneId: "ws:p1" }))).toEqual({ ok: true, value: { paneId: "ws:p1", replayed: false } });
    expect(parseStarterReply(JSON.stringify({ paneId: "ws:p1", replayed: true }))).toEqual({ ok: true, value: { paneId: "ws:p1", replayed: true } });
    expect(parseStarterReply(JSON.stringify({ paneId: "a/b" })).ok).toBe(false);
    expect(parseStarterReply(JSON.stringify({})).ok).toBe(false);
    expect(parseStarterReply("<html>").ok).toBe(false);
  });
});

describe("the state mapping (WIRE.md section 5)", () => {
  const pane = (state: string, asks: readonly DurableAsk[] = []) => ({ state, openAsks: asks });
  const ask = read().panes.find((candidate) => candidate.id === "conv-02")?.openAsks[0];

  test("working is working, waiting is blocked, idle is idle", () => {
    expect(statusOf(pane("working"))).toBe("working");
    expect(statusOf(pane("waiting"))).toBe("blocked");
    expect(statusOf(pane("idle"))).toBe("idle");
  });

  test("an open ask wins over whatever state says", () => {
    expect(ask).toBeDefined();
    if (ask === undefined) return;
    for (const state of ["idle", "working", "waiting", "sleeping", ""]) expect(statusOf(pane(state, [ask]))).toBe("blocked");
  });

  test("any other state is unknown, and the program never sends done", () => {
    for (const state of ["done", "sleeping", "WORKING", "", "blocked"]) expect(statusOf(pane(state))).toBe("unknown");
  });
});

describe("snapshot fixture", () => {
  test("the recorded snapshot maps to the expected workspaces, tabs and panes", () => {
    const mux = toMuxSnapshot(read());

    expect(mux.spaces.map((space) => [space.spaceId, space.number, space.label, space.tabCount, space.paneCount, space.folder])).toEqual([
      ["ws-notes", 1, "notes", 2, 3, "/home/denis/notes"],
      ["ws-site", 2, "site", 1, 2, "/home/denis/site"],
    ]);
    expect(mux.tabs.map((tab) => [tab.tabId, tab.spaceId, tab.number, tab.label, tab.paneCount])).toEqual([
      ["ws-notes:main", "ws-notes", 1, "main", 2],
      ["ws-notes:research", "ws-notes", 2, "research", 1],
      ["ws-site:main", "ws-site", 1, "main", 2],
    ]);
    expect(mux.panes.map((pane) => [pane.paneId, pane.spaceNumber, pane.status])).toEqual([
      ["conv-01", 1, "working"],
      ["conv-02", 1, "blocked"],
      ["conv-03", 2, "idle"],
      ["conv-04", 1, "blocked"],
      ["conv-05", 2, "unknown"],
    ]);
  });

  test("a pane is a durable agent that nobody focuses, with the program's title and no operator label", () => {
    const mux = toMuxSnapshot(read());
    const pane = mux.panes.find((candidate) => candidate.paneId === "conv-01");
    expect(pane).toEqual({
      paneId: "conv-01",
      spaceId: "ws-notes",
      spaceLabel: "notes",
      spaceNumber: 1,
      tabId: "ws-notes:main",
      tabLabel: "main",
      cwd: "/home/denis/notes",
      focused: false,
      alive: true,
      agent: "durable",
      status: "working",
      terminalTitle: "Plan the week",
      // The conversation id is the session: it names the bridge's own log of the pane.
      agentSession: { kind: "id", value: "conv-01" },
    });
    expect(pane?.tabNamed).toBeUndefined();
    expect(pane?.paneLabel).toBeUndefined();
    // The harness string is display text. It never becomes the agent name.
    for (const each of mux.panes) expect(each.agent).toBe("durable");
  });

  test("a pane's cwd is its own, else its workspace's, else empty", () => {
    const mux = toMuxSnapshot(
      read((snapshot) => {
        snapshot.workspaces = snapshot.workspaces.map((workspace) => (workspace.id === "ws-site" ? { id: workspace.id, title: workspace.title } : workspace));
      }),
    );
    const cwd = (id: string) => mux.panes.find((pane) => pane.paneId === id)?.cwd;
    expect(cwd("conv-02")).toBe("/home/denis/notes/papers");
    expect(cwd("conv-01")).toBe("/home/denis/notes");
    expect(cwd("conv-03")).toBe("");
  });

  test("a relative cwd and a cwd over the cap are ignored, not cut", () => {
    const snapshot = read((raw) => {
      raw.workspaces = raw.workspaces.map((workspace) =>
        workspace.id === "ws-notes" ? { ...workspace, cwd: "notes/relative" } : { ...workspace, cwd: `/${"d".repeat(CAPS.cwd)}` },
      );
    });
    expect(snapshot.workspaces.map((workspace) => workspace.cwd)).toEqual([undefined, undefined]);
  });

  test("a workspace or tab with no pane is still listed", () => {
    const mux = toMuxSnapshot(read((snapshot) => (snapshot.panes = [])));
    expect(mux.panes).toEqual([]);
    expect(mux.spaces).toHaveLength(2);
    expect(mux.tabs).toHaveLength(3);
    expect(mux.tabs.every((tab) => tab.paneCount === 0)).toBe(true);
  });

  test("the starter list is read only when the program opens starters", () => {
    expect(read().starters).toEqual([{ id: "notes-new", label: "New note chat" }]);
    const closed = parseSnapshot(snapshotText(), false);
    expect(closed.ok && closed.value.starters).toEqual([]);
  });

  // M50 spec 14: wire v1 reserves `sessionId` on every pane for the machine-scoped session id. The adapter reads a
  // pane with it, null or a string, exactly as one without it, and keeps nothing of it today.
  test("a pane's reserved sessionId, null or a string, is read and ignored", () => {
    const plain = toMuxSnapshot(read());
    for (const sessionId of [null, "s-1"]) {
      const snapshot = read((raw) => {
        for (const pane of raw.panes) Object.assign(pane, { sessionId });
      });
      expect(snapshot.panes.map((pane) => pane.id)).toEqual(read().panes.map((pane) => pane.id));
      expect(snapshot.panes.every((pane) => !("sessionId" in pane))).toBe(true);
      expect(toMuxSnapshot(snapshot)).toEqual(plain);
    }
  });

  test("a snapshot without rev, epoch or its lists is not a snapshot", () => {
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ epoch: EPOCH, workspaces: [], tabs: [], panes: [] }),
      JSON.stringify({ rev: 1, workspaces: [], tabs: [], panes: [] }),
      JSON.stringify({ rev: -1, epoch: EPOCH, workspaces: [], tabs: [], panes: [] }),
      JSON.stringify({ rev: 1, epoch: "a/b", workspaces: [], tabs: [], panes: [] }),
      JSON.stringify({ rev: 1, epoch: EPOCH, workspaces: [], tabs: [] }),
    ]) {
      expect(parseSnapshot(text, true).ok).toBe(false);
    }
  });
});

describe("the id rule drops what hangs from a bad id", () => {
  test("a pane with a bad id is dropped and the others stay", () => {
    const snapshot = read((raw) => {
      raw.panes = raw.panes.map((pane) => (pane.id === "conv-03" ? { ...pane, id: "has space" } : pane));
    });
    expect(snapshot.panes.map((pane) => pane.id)).toEqual(["conv-01", "conv-02", "conv-04", "conv-05"]);
  });

  test("a tab with a bad id is dropped, and so is every pane that names it", () => {
    const snapshot = read((raw) => {
      raw.tabs = raw.tabs.map((tab) => (tab.id === "ws-notes:research" ? { ...tab, id: "ws-notes/research" } : tab));
    });
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(["ws-notes:main", "ws-site:main"]);
    expect(snapshot.panes.map((pane) => pane.id)).toEqual(["conv-01", "conv-03", "conv-04", "conv-05"]);
  });

  test("a workspace with a bad id is dropped with its tabs and panes, and the spaces renumber", () => {
    const snapshot = read((raw) => {
      raw.workspaces = raw.workspaces.map((workspace) => (workspace.id === "ws-notes" ? { ...workspace, id: "ws#notes" } : workspace));
    });
    expect(snapshot.workspaces.map((workspace) => workspace.id)).toEqual(["ws-site"]);
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(["ws-site:main"]);
    expect(snapshot.panes.map((pane) => pane.id)).toEqual(["conv-03", "conv-05"]);
    expect(toMuxSnapshot(snapshot).spaces[0]?.number).toBe(1);
  });

  test("a pane with a bad turn id is dropped, and a pane in another workspace's tab is dropped", () => {
    const snapshot = read((raw) => {
      raw.panes = raw.panes.map((pane) => {
        if (pane.id === "conv-01") return { ...pane, turnId: "bad turn" };
        if (pane.id === "conv-05") return { ...pane, workspaceId: "ws-notes" };
        return pane;
      });
    });
    expect(snapshot.panes.map((pane) => pane.id)).toEqual(["conv-02", "conv-03", "conv-04"]);
  });

  test("a repeated id keeps the first object", () => {
    const snapshot = read((raw) => {
      raw.panes = [...raw.panes, ...raw.panes.map((pane) => Object.assign({}, pane, { title: "second" }))];
    });
    expect(snapshot.panes).toHaveLength(5);
    expect(snapshot.panes.every((pane) => pane.title !== "second")).toBe(true);
  });

  test("an ask with a bad id is dropped from its pane, and the pane stays", () => {
    const snapshot = read((raw) => {
      raw.panes = raw.panes.map((pane) =>
        pane.id === "conv-02" ? { ...pane, openAsks: pane.openAsks.map((ask) => ({ ...ask, toolCallId: "no good" })) } : pane,
      );
    });
    expect(snapshot.panes.find((pane) => pane.id === "conv-02")?.openAsks).toEqual([]);
  });

  test("an option with a bad id or an unknown effect is dropped", () => {
    const snapshot = read((raw) => {
      raw.panes = raw.panes.map((pane) =>
        pane.id === "conv-02"
          ? {
              ...pane,
              openAsks: pane.openAsks.map((ask) => ({
                ...ask,
                options: [
                  { id: "ok", label: "Fine", effect: "allow" as const },
                  { id: "bad id", label: "Bad", effect: "deny" as const },
                  // SAFETY: a test of the reader, which must drop an effect outside the four.
                  { id: "odd", label: "Odd", effect: "launch" as "deny" },
                ],
              })),
            }
          : pane,
      );
    });
    expect(snapshot.panes.find((pane) => pane.id === "conv-02")?.openAsks[0]?.options.map((option) => option.id)).toEqual(["ok"]);
  });
});

describe("clean: every string in a snapshot is cleaned and capped", () => {
  const hostile = (field: string) => hostileText(field);

  test("clean titles, harness and starter labels pass through the same cleaning", () => {
    const snapshot = read((raw) => {
      raw.workspaces = raw.workspaces.map((workspace) => ({ ...workspace, title: hostile("w") }));
      raw.tabs = raw.tabs.map((tab) => ({ ...tab, title: hostile("t") }));
      raw.panes = raw.panes.map((pane) => ({ ...pane, title: hostile("p"), harness: hostile("h") }));
      raw.starters = [{ id: "s", label: hostile("s") }];
    });
    const strings = [
      ...snapshot.workspaces.map((workspace) => [workspace.title, CAPS.title] as const),
      ...snapshot.tabs.map((tab) => [tab.title, CAPS.title] as const),
      ...snapshot.panes.map((pane) => [pane.title, CAPS.title] as const),
      ...snapshot.panes.map((pane) => [pane.harness, CAPS.harness] as const),
      ...snapshot.starters.map((starter) => [starter.label, CAPS.starterLabel] as const),
    ];
    expect(strings.length).toBeGreaterThan(10);
    for (const [text, cap] of strings) {
      expect(hasHostileChars(text)).toBe(false);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
      expect(text.endsWith("…")).toBe(true);
    }
  });

  test("clean ask text keeps newlines in reason, summary and output, and cuts each at its own cap", () => {
    const snapshot = read((raw) => {
      raw.panes = raw.panes.map((pane) =>
        pane.id === "conv-02"
          ? {
              ...pane,
              openAsks: pane.openAsks.map((ask) => ({
                ...ask,
                title: hostile("ask"),
                reason: `why\nbecause${String.fromCodePoint(0x202e)}${"r".repeat(5000)}`,
                tool: { kind: "other" as const, name: hostile("n"), summary: `a\nb${"s".repeat(3000)}`, output: `o\nk${"o".repeat(40000)}` },
                options: ask.options.map((option) => ({ ...option, label: hostile("l") })),
              })),
            }
          : pane,
      );
    });
    const ask = snapshot.panes.find((pane) => pane.id === "conv-02")?.openAsks[0];
    expect(ask).toBeDefined();
    if (ask === undefined) return;
    expect(ask.reason?.startsWith("why\nbecause")).toBe(true);
    expect(ask.reason).not.toContain(String.fromCodePoint(0x202e));
    expect(Buffer.byteLength(ask.reason ?? "")).toBeLessThanOrEqual(CAPS.reason);
    expect(ask.tool?.summary.startsWith("a\nb")).toBe(true);
    expect(Buffer.byteLength(ask.tool?.summary ?? "")).toBeLessThanOrEqual(CAPS.toolSummary);
    expect(ask.tool?.output?.startsWith("o\nk")).toBe(true);
    expect(Buffer.byteLength(ask.tool?.output ?? "")).toBeLessThanOrEqual(CAPS.toolOutput);
    expect(Buffer.byteLength(ask.title)).toBeLessThanOrEqual(CAPS.askTitle);
    expect(Buffer.byteLength(ask.tool?.name ?? "")).toBeLessThanOrEqual(CAPS.toolName);
    for (const option of ask.options) {
      expect(Buffer.byteLength(option.label)).toBeLessThanOrEqual(CAPS.optionLabel);
      expect(hasHostileChars(option.label)).toBe(false);
    }
  });

  test("clean list caps keep the first entries: 64 workspaces, 256 tabs, 256 panes, 50 asks, 6 options, 50 starters", () => {
    const snapshot = read((raw) => {
      const fixtureAsk = snapshotFixture().panes[1]?.openAsks[0];
      if (fixtureAsk === undefined) throw new Error("the fixture lost its ask");
      raw.workspaces = Array.from({ length: 80 }, (_item, i) => ({ id: `w${String(i)}`, title: `w${String(i)}` }));
      raw.tabs = Array.from({ length: 300 }, (_item, i) => ({ id: `t${String(i)}`, workspaceId: "w0", title: "t" }));
      raw.panes = Array.from({ length: 300 }, (_item, i) => ({
        id: `p${String(i)}`,
        workspaceId: "w0",
        tabId: "t0",
        title: "p",
        harness: "pi",
        state: "waiting",
        lastActiveAt: 1,
        turnId: `turn${String(i)}`,
        openAsks:
          i === 0
            ? Array.from({ length: 60 }, (_ask, n) => ({
                ...fixtureAsk,
                id: `ask${String(n)}`,
                options: Array.from({ length: 9 }, (_option, o) => ({ id: `o${String(o)}`, label: "o", effect: "allow" as const })),
              }))
            : [],
      }));
      raw.starters = Array.from({ length: 70 }, (_item, i) => ({ id: `s${String(i)}`, label: "s" }));
    });
    expect(snapshot.workspaces).toHaveLength(CAPS.workspaces);
    expect(snapshot.workspaces.at(-1)?.id).toBe("w63");
    expect(snapshot.tabs).toHaveLength(CAPS.tabs);
    expect(snapshot.panes).toHaveLength(CAPS.panes);
    expect(snapshot.panes[0]?.openAsks).toHaveLength(CAPS.openAsksPerPane);
    expect(snapshot.panes[0]?.openAsks[0]?.id).toBe("ask0");
    expect(snapshot.panes[0]?.openAsks[0]?.options).toHaveLength(CAPS.optionsPerAsk);
    expect(snapshot.starters).toHaveLength(CAPS.starters);
  });
});

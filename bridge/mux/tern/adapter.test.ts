import { describe, expect, test } from "bun:test";

import type { MuxWatchOptions } from "../types.ts";
import { TERN_BINARY_OPTION, ternMuxFactory } from "./adapter.ts";
import { FakeTern, ternConformanceFixture } from "./fixture.ts";
import { TernWatch } from "./watch.ts";

describe("TernMux adapter unit tests", () => {
  test("reachable returns true when fake responds", async () => {
    const world = await ternConformanceFixture.create();
    expect(await world.adapter.reachable()).toBe(true);
  });

  test("snapshot maps sessions to spaces and tabs to tabs", async () => {
    const world = await ternConformanceFixture.create();
    const snap = await world.adapter.snapshot();
    expect(snap.spaces.length).toBe(2);
    expect(snap.tabs.length).toBe(3);
    expect(snap.panes.length).toBe(4);

    const defaultSpace = snap.spaces.find((s) => s.label === "Default");
    expect(defaultSpace).toBeDefined();
    expect(defaultSpace?.focused).toBe(true);
  });

  test("readGrid returns text with revision", async () => {
    const world = await ternConformanceFixture.create();
    const res = await world.adapter.readGrid("101", { lines: 10, scope: "viewport", styling: "strip" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.paneId).toBe("101");
      expect(res.value.text).toContain("screen row 1");
      expect(res.value.revision).toBeGreaterThan(0);
    }
  });

  test("typeText submits text to pane", async () => {
    const world = await ternConformanceFixture.create();
    const res = await world.adapter.typeText("101", "echo hello");
    expect(res.ok).toBe(true);
    expect(world.writes().some((w) => w.payload.includes("echo hello"))).toBe(true);
  });

  test("setFocus moves focus to target pane", async () => {
    const world = await ternConformanceFixture.create();
    const res = await world.adapter.setFocus("103");
    expect(res.ok).toBe(true);
    const snap = await world.adapter.snapshot();
    const p103 = snap.panes.find((p) => p.paneId === "103");
    expect(p103?.focused).toBe(true);
    // The tab it left still remembers its own focused block; that must not read as focused.
    expect(snap.panes.filter((p) => p.focused).map((p) => p.paneId)).toEqual(["103"]);
  });

  // Tern's `focused` is per TAB (measured on 0.4.5: one shown session with three tabs reported three
  // focused blocks). Only the block in the shown tab of the shown session is the one on screen.
  test("only the shown tab of the shown session yields a focused pane", async () => {
    const world = await ternConformanceFixture.create();
    const snap = await world.adapter.snapshot();
    expect(snap.panes.filter((p) => p.focused).map((p) => p.paneId)).toEqual(["101"]);
  });
});

describe("ternMuxFactory", () => {
  test("reads the tern binary from its own option key, not a generic one", () => {
    expect(TERN_BINARY_OPTION).toBe("ternBin");
    // A configured path that is not there resolves to no binary, so the call answers with the
    // missing-binary message rather than spawning whatever the fallback list found.
    const adapter = ternMuxFactory.create({
      endpoint: "",
      timeoutMs: 0,
      options: { [TERN_BINARY_OPTION]: "/nonexistent/tern" },
    });
    return expect(adapter.snapshot()).rejects.toThrow("COLLIE_TERN_BIN");
  });
});

describe("TernWatch event kinds", () => {
  function watching(fake: FakeTern) {
    const seen = { topology: 0 };
    const options: MuxWatchOptions = {
      panes: [],
      onUp: () => undefined,
      onDown: () => undefined,
      onTopologyChange: () => {
        seen.topology += 1;
      },
      onPaneChange: () => undefined,
    };
    const watch = new TernWatch(fake, options);
    return { seen, watch };
  }

  // Every kind tern 0.4.5 accepts in `tern events --filter` that moves the topology.
  for (const kind of ["pane_created", "pane_spawned", "pane_closed", "pane_exited", "tab_created", "tab_closed", "layout_changed", "title_changed", "cwd_changed"]) {
    test(`${kind} pokes the topology`, () => {
      const fake = new FakeTern();
      const { seen, watch } = watching(fake);
      fake.emit(kind, 101);
      expect(seen.topology).toBe(1);
      watch.close();
    });
  }

  test("CLI connection chatter is not topology", () => {
    const fake = new FakeTern();
    const { seen, watch } = watching(fake);
    fake.emit("client_connected");
    fake.emit("client_left");
    expect(seen.topology).toBe(0);
    watch.close();
  });
});

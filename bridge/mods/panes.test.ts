import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isModSessionId, isScopeKey, partKey, type ModPart, type WireModInfo, type WireModPart } from "../../web/src/lib/mods/schema.ts";
import { MODS_SPACE_LABEL, modSessionPanes, modSessionStatus, pastWindow, placeModSessions, type ModSessionSource } from "./panes.ts";

const NOW = Date.parse("2026-11-08T09:41:00Z");
const HOST = "bluefin";
const VIEW = { kind: "text", text: "23/34", lines: 1 } as const;

function info(id: string, extra: Partial<WireModInfo> = {}): WireModInfo {
  return { host: HOST, id, name: id === "legs" ? "Browser leg" : "Tracker", icon: "flask", on: true, state: "ok", places: ["session"], ...extra };
}

let rev = 0;
function part(mod: string, value: ModPart, extra: Partial<WireModPart> = {}): WireModPart {
  rev += 1;
  return { host: HOST, mod, part: value.id, rev, value, asOf: "2026-11-08T09:41:00Z", fresh: "90s", ...extra };
}

function source(parts: WireModPart[], mods: WireModInfo[] = [info("legs"), info("tracker")], now = NOW): ModSessionSource {
  return { host: HOST, mods, parts, dirOf: (id) => `/home/me/.config/collie/mods/${id}`, now };
}

const LEGS = part("legs", {
  at: "session",
  id: "legs",
  name: "Browser leg",
  tone: "working",
  subtitle: "case 24 red",
  badge: { count: 1 },
  progress: { kind: "percent", value: 68 },
  actions: [{ id: "rerun", label: "Rerun red", intent: "rerun", icon: "refresh" }],
  view: VIEW,
});

describe("the mod sessions as panes", () => {
  test("one pane per session part, in one Mods Space, one tab per mod in manifest order", () => {
    const tracker = part("tracker", { at: "session", id: "due", tone: "ok", view: VIEW });
    const tracker2 = part("tracker", { at: "session", id: "next", name: "Next task", view: VIEW });
    const belt = part("legs", { at: "belt", id: "belt", mark: { face: "23/34" } });
    const found = modSessionPanes(source([tracker, belt, LEGS, tracker2]));
    expect(found?.workspace).toEqual({ workspaceId: "mod:bluefin", label: MODS_SPACE_LABEL, focused: false, activeTabId: "mod:bluefin:legs", tabCount: 2, paneCount: 3 });
    expect(found?.tabs.map((t) => [t.tabId, t.label, t.paneCount])).toEqual([
      ["mod:bluefin:legs", "Browser leg", 1],
      ["mod:bluefin:tracker", "Tracker", 2],
    ]);
    expect(found?.panes.map((p) => [p.paneId, p.tabId, p.tabPosition])).toEqual([
      ["mod:bluefin:legs:legs", "mod:bluefin:legs", 0],
      ["mod:bluefin:tracker:due", "mod:bluefin:tracker", 0],
      ["mod:bluefin:tracker:next", "mod:bluefin:tracker", 1],
    ]);
    // The ids are mod session ids, one URL path segment each, and never a real session's key.
    for (const pane of found?.panes ?? []) {
      expect(isModSessionId(pane.paneId)).toBe(true);
      expect(pane.paneId).not.toContain("/");
      expect(isScopeKey(`${HOST}:${pane.paneId}`)).toBe(false);
    }
  });

  test("a pane carries the name, the pane marks, the actions, the folder and its part key", () => {
    const pane = modSessionPanes(source([LEGS]))?.panes[0];
    expect(pane).toEqual({
      paneId: "mod:bluefin:legs:legs",
      workspaceId: "mod:bluefin",
      workspaceLabel: "Mods",
      tabId: "mod:bluefin:legs",
      agent: "legs",
      status: "working",
      cwd: "/home/me/.config/collie/mods/legs",
      focused: false,
      kind: "mod",
      paneLabel: "Browser leg",
      sessionName: "Browser leg",
      tabLabel: "Browser leg",
      tabPosition: 0,
      view: partKey(LEGS),
      subtitle: "case 24 red",
      badge: { count: 1 },
      progress: { kind: "percent", value: 68 },
      actions: [{ id: "rerun", label: "Rerun red", icon: "refresh" }],
    });
    // A part with no name takes the mod's.
    const bare = modSessionPanes(source([part("tracker", { at: "session", id: "due", view: VIEW })]))?.panes[0];
    expect(bare?.paneLabel).toBe("Tracker");
  });

  test("the status: working only for a fresh working part of a mod that runs, idle for every other case", () => {
    expect(modSessionStatus("working", true)).toBe("working");
    for (const tone of ["ok", "plain", "muted", "error", "warn", "unknown", undefined] as const) expect(modSessionStatus(tone, true), String(tone)).toBe("idle");
    expect(modSessionStatus("working", false)).toBe("idle");
    const status = (parts: WireModPart[], mods?: WireModInfo[], now?: number) => modSessionPanes(source(parts, mods, now))?.panes[0]?.status;
    expect(status([LEGS])).toBe("working");
    expect(status([{ ...LEGS, stale: true, problem: "exit 1" }])).toBe("idle");
    expect(status([LEGS], [info("legs", { state: "failing" })])).toBe("idle");
    expect(status([LEGS], [info("legs", { state: "stopped" })])).toBe("idle");
    expect(status([LEGS], undefined, NOW + 91_000)).toBe("idle");
    // Never a status that reads as "needs you" or "done" anywhere in the app.
    const tones = ["plain", "muted", "ok", "warn", "error", "working", "unknown"] as const;
    for (const tone of tones) {
      const got = status([part("legs", { at: "session", id: "legs", tone, view: VIEW })]);
      expect(got === "blocked" || got === "done", tone).toBe(false);
    }
  });

  test("past the fresh window by the phone's rule", () => {
    expect(pastWindow({ asOf: "2026-11-08T09:41:00Z", fresh: "90s" }, NOW + 90_000)).toBe(false);
    expect(pastWindow({ asOf: "2026-11-08T09:41:00Z", fresh: "90s" }, NOW + 90_001)).toBe(true);
    expect(pastWindow({}, NOW + 10 ** 9)).toBe(false);
  });

  test("a mod that is off, another host's part and a mod with no session part make no pane", () => {
    expect(modSessionPanes(source([LEGS], [info("legs", { on: false })]))).toBeUndefined();
    expect(modSessionPanes(source([{ ...LEGS, host: "minibuch" }]))).toBeUndefined();
    expect(modSessionPanes(source([part("legs", { at: "belt", id: "belt", mark: { face: "x" } })]))).toBeUndefined();
    expect(modSessionPanes(source([]))).toBeUndefined();
  });

  test("the pane fields keep WIRE.md's caps even when a stored part breaks them", () => {
    const loud = part("legs", {
      at: "session",
      id: "legs",
      subtitle: "x".repeat(200),
      badge: { text: "a very long badge" },
      progress: { kind: "steps", steps: Array.from({ length: 20 }, (_, i) => ({ label: `s${i}`, state: "todo" as const })) },
      actions: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: `A${i}`, intent: "go" })),
      view: VIEW,
    });
    const pane = modSessionPanes(source([loud]))?.panes[0];
    expect([...(pane?.subtitle ?? "")]).toHaveLength(120);
    expect(pane?.badge).toEqual({ text: "a very long " });
    expect(pane?.progress?.kind === "steps" ? pane.progress.steps.length : 0).toBe(12);
    expect(pane?.actions).toHaveLength(4);
    const over = part("legs", { at: "session", id: "legs", progress: { kind: "percent", value: 140 }, badge: { count: 12_000 }, view: VIEW });
    const capped = modSessionPanes(source([over]))?.panes[0];
    expect(capped?.progress).toEqual({ kind: "percent", value: 100 });
    expect(capped?.badge).toBeUndefined();
  });
});

describe("placing the Mods Space in a body", () => {
  test("numbered after the real Spaces, tabs from 1, and tagged with the primary session only when widened", () => {
    const found = modSessionPanes(source([LEGS]));
    if (found === undefined) throw new Error("no panes");
    const placed = placeModSessions(found, { numbers: [1, 2, 4] });
    expect(placed.workspace.number).toBe(5);
    expect(placed.tabs.map((t) => t.number)).toEqual([1]);
    expect(placed.panes[0]?.workspaceNumber).toBe(5);
    expect("session" in (placed.panes[0] ?? {})).toBe(false);
    expect(placeModSessions(found, { numbers: [] }).workspace.number).toBe(1);
    expect(placeModSessions(found, { numbers: [3], session: "default" }).panes[0]?.session).toBe("default");
  });

  test("server.ts adds the Space after `sessions` took its counts, and outside every state engine", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const snapshot = src.slice(src.indexOf("const localSnapshot = ("), src.indexOf("const watchedPaneIds = ()"));
    const counts = snapshot.indexOf("sessions: withSessionLabels(registry.list()");
    const added = snapshot.indexOf("const modSessions = opts.mods?.sessionPanes();");
    expect(counts).toBeGreaterThan(0);
    expect(added).toBeGreaterThan(counts);
    expect(snapshot.slice(added, added + 900)).toContain("body.agents = [...body.agents, ...placed.panes];");
    expect(snapshot.slice(added, added + 900)).toContain("session: widen ? registry.primary : undefined");
  });
});

describe("the service", () => {
  test("a session part a run stored becomes a pane; switched off, it goes", async () => {
    const { ModsService } = await import("./service.ts");
    const { MODS_DIR } = await import("./paths.ts");
    const { withSwitch, writeSwitches } = await import("./switches.ts");
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "collie-mods-panes-"));
    try {
      const configDir = join(root, "config");
      const stateDir = join(root, "state");
      const dir = join(configDir, MODS_DIR, "legs");
      await mkdir(dir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(dir, "mod.toml"), 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nplaces = ["session"]\n');
      await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-08T09:00:00Z"));
      const doc = JSON.stringify({ v: 1, asOf: "2026-11-08T09:41:00Z", parts: [{ at: "session", id: "legs", tone: "working", subtitle: "case 24 red", view: VIEW }] });
      const clock = { t: NOW };
      const service = new ModsService({
        configDir,
        stateDir,
        host: () => HOST,
        world: () => ({ sessions: [], spaces: [] }),
        env: { PATH: "/usr/bin:/bin" },
        now: () => clock.t,
        warn: () => {},
        revBase: 1000,
        run: async () => ({ kind: "exited", code: 0, stdout: doc, stderr: "", ms: 1 }),
      });
      expect(service.sessionPanes()).toBeUndefined();
      service.noteWatched();
      await service.refresh(true);
      await service.tick();
      const found = service.sessionPanes();
      expect(found?.panes.map((p) => [p.paneId, p.status, p.subtitle, p.cwd])).toEqual([["mod:bluefin:legs:legs", "working", "case 24 red", dir]]);
      await writeSwitches(stateDir, { on: new Map() });
      await service.refresh(true);
      expect(service.sessionPanes()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

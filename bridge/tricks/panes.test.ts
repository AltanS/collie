import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { isTrickSessionId, isScopeKey, partKey, type TrickPart, type View, type WireTrickInfo, type WireTrickPart } from "../../web/src/lib/tricks/schema.ts";
import { hillSessionName } from "../hill/walky.ts";
import { realAgentPanes, TRICKS_SPACE_LABEL, trickSessionPanes, trickSessionStatus, pastWindow, placeTrickSessions, type TrickSessionSource } from "./panes.ts";

const NOW = Date.parse("2026-11-08T09:41:00Z");
const HOST = "lodge";
const VIEW: View = [{ kind: "para", text: "23/34" }];

function info(id: string, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: HOST, id, name: id === "legs" ? "Browser leg" : "Tracker", icon: "flask", on: true, state: "ok", places: ["session"], ...extra };
}

let rev = 0;
function part(trick: string, value: TrickPart, extra: Partial<WireTrickPart> = {}): WireTrickPart {
  rev += 1;
  return { host: HOST, trick, part: value.id, rev, value, asOf: "2026-11-08T09:41:00Z", fresh: "90s", ...extra };
}

function source(parts: WireTrickPart[], tricks: WireTrickInfo[] = [info("legs"), info("tracker")], now = NOW): TrickSessionSource {
  return { host: HOST, tricks, parts, dirOf: (id) => `/home/me/.config/collie/tricks/${id}`, now };
}

const LEGS = part("legs", {
  at: "session",
  id: "legs",
  name: "Browser leg",
  tone: "accent",
  subtitle: "case 24 red",
  badge: { count: 1 },
  progress: { value: 3, max: 4 },
  actions: [{ id: "rerun", label: "Rerun red", intent: "rerun", icon: "refresh" }],
  view: VIEW,
});

describe("the trick sessions as panes", () => {
  test("one pane per session part, in one Tricks Space, one tab per trick in manifest order", () => {
    const tracker = part("tracker", { at: "session", id: "due", tone: "ok", view: VIEW });
    const tracker2 = part("tracker", { at: "session", id: "next", name: "Next task", view: VIEW });
    const belt = part("legs", { at: "belt", id: "belt", mark: { label: "23/34" } });
    const found = trickSessionPanes(source([tracker, belt, LEGS, tracker2]));
    expect(found?.workspace).toEqual({ workspaceId: "trick:lodge", label: TRICKS_SPACE_LABEL, focused: false, activeTabId: "trick:lodge:legs", tabCount: 2, paneCount: 3 });
    expect(found?.tabs.map((t) => [t.tabId, t.label, t.paneCount])).toEqual([
      ["trick:lodge:legs", "Browser leg", 1],
      ["trick:lodge:tracker", "Tracker", 2],
    ]);
    expect(found?.panes.map((p) => [p.paneId, p.tabId, p.tabPosition])).toEqual([
      ["trick:lodge:legs:legs", "trick:lodge:legs", 0],
      ["trick:lodge:tracker:due", "trick:lodge:tracker", 0],
      ["trick:lodge:tracker:next", "trick:lodge:tracker", 1],
    ]);
    // The ids are trick session ids, one URL path segment each, and never a real session's key.
    for (const pane of found?.panes ?? []) {
      expect(isTrickSessionId(pane.paneId)).toBe(true);
      expect(pane.paneId).not.toContain("/");
      expect(isScopeKey(`${HOST}:${pane.paneId}`)).toBe(false);
    }
  });

  test("a pane carries the name, the pane marks, the actions, the folder and its part key", () => {
    const pane = trickSessionPanes(source([LEGS]))?.panes[0];
    expect(pane).toEqual({
      paneId: "trick:lodge:legs:legs",
      workspaceId: "trick:lodge",
      workspaceLabel: "Tricks",
      tabId: "trick:lodge:legs",
      agent: "legs",
      status: "working",
      cwd: "/home/me/.config/collie/tricks/legs",
      focused: false,
      kind: "trick",
      paneLabel: "Browser leg",
      sessionName: "Browser leg",
      tabLabel: "Browser leg",
      tabPosition: 0,
      view: partKey(LEGS),
      subtitle: "case 24 red",
      badge: { count: 1 },
      progress: { kind: "percent", value: 75 },
      actions: [{ id: "rerun", label: "Rerun red", icon: "refresh" }],
    });
    // A part with no name takes the trick's.
    const bare = trickSessionPanes(source([part("tracker", { at: "session", id: "due", view: VIEW })]))?.panes[0];
    expect(bare?.paneLabel).toBe("Tracker");
  });

  test("the status: working only for a fresh accent part of a trick that runs, idle for every other case", () => {
    expect(trickSessionStatus("accent", true)).toBe("working");
    for (const tone of ["ok", "plain", "muted", "danger", "warn", undefined] as const) expect(trickSessionStatus(tone, true), String(tone)).toBe("idle");
    expect(trickSessionStatus("accent", false)).toBe("idle");
    const status = (parts: WireTrickPart[], tricks?: WireTrickInfo[], now?: number) => trickSessionPanes(source(parts, tricks, now))?.panes[0]?.status;
    expect(status([LEGS])).toBe("working");
    expect(status([{ ...LEGS, stale: true, problem: "exit 1" }])).toBe("idle");
    expect(status([LEGS], [info("legs", { state: "failing" })])).toBe("idle");
    expect(status([LEGS], [info("legs", { state: "stopped" })])).toBe("idle");
    expect(status([LEGS], undefined, NOW + 91_000)).toBe("idle");
    // Never a status that reads as "needs you" or "done" anywhere in the app.
    const tones = ["plain", "muted", "ok", "warn", "danger", "accent"] as const;
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

  test("a trick that is off, another host's part and a trick with no session part make no pane", () => {
    expect(trickSessionPanes(source([LEGS], [info("legs", { on: false })]))).toBeUndefined();
    expect(trickSessionPanes(source([{ ...LEGS, host: "workshop" }]))).toBeUndefined();
    expect(trickSessionPanes(source([part("legs", { at: "belt", id: "belt", mark: { label: "x" } })]))).toBeUndefined();
    expect(trickSessionPanes(source([]))).toBeUndefined();
  });

  test("the pane fields keep WIRE.md's caps even when a stored part breaks them", () => {
    const loud = part("legs", {
      at: "session",
      id: "legs",
      subtitle: "x".repeat(200),
      badge: { text: "a very long badge" },
      progress: { value: 7, max: 20 },
      actions: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: `A${i}`, intent: "go" })),
      view: VIEW,
    });
    const pane = trickSessionPanes(source([loud]))?.panes[0];
    expect([...(pane?.subtitle ?? "")]).toHaveLength(120);
    expect(pane?.badge).toEqual({ text: "a very long " });
    expect(pane?.progress).toEqual({ kind: "percent", value: 35 });
    expect(pane?.actions).toHaveLength(4);
    const over = part("legs", { at: "session", id: "legs", progress: { value: 1.4 }, badge: { count: 12_000 }, view: VIEW });
    const capped = trickSessionPanes(source([over]))?.panes[0];
    expect(capped?.progress).toEqual({ kind: "percent", value: 100 });
    expect(capped?.badge).toBeUndefined();
  });
});

describe("placing the Tricks Space in a body", () => {
  test("numbered after the real Spaces, tabs from 1, and tagged with the primary session only when widened", () => {
    const found = trickSessionPanes(source([LEGS]));
    if (found === undefined) throw new Error("no panes");
    const placed = placeTrickSessions(found, { numbers: [1, 2, 4] });
    expect(placed.workspace.number).toBe(5);
    expect(placed.tabs.map((t) => t.number)).toEqual([1]);
    expect(placed.panes[0]?.workspaceNumber).toBe(5);
    expect("session" in (placed.panes[0] ?? {})).toBe(false);
    expect(placeTrickSessions(found, { numbers: [] }).workspace.number).toBe(1);
    expect(placeTrickSessions(found, { numbers: [3], session: "default" }).panes[0]?.session).toBe("default");
  });

  test("server.ts adds the Space after `sessions` took its counts, and outside every state engine", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const snapshot = src.slice(src.indexOf("const localSnapshot = ("), src.indexOf("const watchedPaneIds = ()"));
    const counts = snapshot.indexOf("sessions: withSessionLabels(registry.list()");
    const added = snapshot.indexOf("const trickSessions = opts.tricks?.sessionPanes();");
    expect(counts).toBeGreaterThan(0);
    expect(added).toBeGreaterThan(counts);
    expect(snapshot.slice(added, added + 900)).toContain("body.agents = [...body.agents, ...placed.panes];");
    expect(snapshot.slice(added, added + 900)).toContain("session: widen ? registry.primary : undefined");
  });

  test("a member's crew-facing snapshot carries no tricks: no rev, no Space, no tab, no pane (review row 12)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const snapshot = src.slice(src.indexOf("const localSnapshot = ("), src.indexOf("const watchedPaneIds = ()"));
    const cut = snapshot.indexOf("if (forCrew) return body;");
    expect(cut).toBeGreaterThan(0);
    // Everything about tricks comes after the cut, so a crew body returns before any of it.
    for (const line of ["const tricksRev = opts.tricks?.rev();", "const trickSessions = opts.tricks?.sessionPanes();", "body.workspaces = [...body.workspaces, placed.workspace];", "body.tabs = [...body.tabs, ...placed.tabs];"]) {
      expect(snapshot.indexOf(line), line).toBeGreaterThan(cut);
    }
    expect(snapshot.slice(0, cut)).not.toContain("opts.tricks");
    // The crew closure asks for the crew body; the browser's route does not.
    const crew = src.slice(src.indexOf("const crewHandler = opts.crewRouter?.({"));
    expect(crew.slice(0, 2000)).toContain("snapshot: (view) => localSnapshot(view.session, null, view.widen, true),");
    const calls = [...src.matchAll(/localSnapshot\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.filter((args) => args?.endsWith("true"))).toHaveLength(1);
  });
});

describe("the service", () => {
  test("a session part a run stored becomes a pane; switched off, it goes", async () => {
    const { TricksService } = await import("./service.ts");
    const { TRICKS_DIR } = await import("./paths.ts");
    const { withSwitch, writeSwitches } = await import("./switches.ts");
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "collie-tricks-panes-"));
    try {
      const configDir = join(root, "config");
      const stateDir = join(root, "state");
      const dir = join(configDir, TRICKS_DIR, "legs");
      await mkdir(dir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(dir, "trick.toml"), 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nplaces = ["session"]\n');
      const { trickCodeHash } = await import("./code-hash.ts");
      const code = await trickCodeHash(dir);
      const { powersOfDir } = await import("./approved.ts");
      await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-08T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, "legs")));
      const doc = JSON.stringify({ v: 1, asOf: "2026-11-08T09:41:00Z", parts: [{ at: "session", id: "legs", tone: "accent", subtitle: "case 24 red", view: VIEW }] });
      const clock = { t: NOW };
      const service = new TricksService({
        configDir,
        stateDir,
        memberId: HOST,
        world: () => ({ machine: "lodge.lan", sessions: [], spaces: [] }),
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
      expect(found?.panes.map((p) => [p.paneId, p.status, p.subtitle, p.cwd])).toEqual([["trick:lodge:legs:legs", "working", "case 24 red", dir]]);
      await writeSwitches(stateDir, { on: new Map() });
      await service.refresh(true);
      expect(service.sessionPanes()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the one filter for real agent panes (review row 30)", () => {
  const real = { paneId: "w6X:3", kind: "agent" as const, agent: "claude", paneLabel: "composer" };
  const trick = { paneId: "trick:lodge:legs:legs", kind: "trick" as const, agent: "legs", paneLabel: "Browser leg" };

  test("realAgentPanes drops trick sessions and hands back the same array when there is none", () => {
    expect(realAgentPanes([real, trick])).toEqual([real]);
    const plain = [real];
    expect(realAgentPanes(plain)).toBe(plain);
  });

  test("the hill's session naming never names a trick pane", () => {
    const name = hillSessionName({
      place: (address) => ({ address, label: "x", host: null, unattended: false }),
      views: () => [real, trick],
      memberId: null,
      redact: false,
    });
    expect(name("local/w6X:3#aaaa")).toBe("composer");
    expect(name(`local/${trick.paneId}#aaaa`)).toBeNull();
  });

  test("no bridge file but panes.ts tests a pane's kind for a trick: push, the crew notifier and the hill read realAgentPanes", () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const file = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
      // panes.ts owns the filter; the hill's reader and service test a Decision's sender kind, never a pane's.
      if (file === "tricks/panes.ts" || file === "hill/parse.ts" || file === "hill/service.ts") continue;
      // A Decision's `from.kind` names its sender, not a pane.
      if (/(?<!from\.)\bkind\s*[!=]==\s*"trick"/.test(readFileSync(join(root, file), "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    for (const file of ["crew/notify.ts", "hill/walky.ts"]) {
      expect(readFileSync(join(root, file), "utf8"), file).toContain("realAgentPanes(");
    }
  });
});

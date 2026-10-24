// The hook edge's own pieces (M56 spec 11): the record the emitter writes and the bridge parses, the
// spool that hands each file over once, and the herdr matcher that places an edge on a herdr pane.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileEdgeSpool, fileSourceStore, registerHookTarget } from "../beacon-io.ts";
import { hookTargetFileName, hookTargetsDir, parseHookTarget } from "./hook-targets.ts";
import { herdrMuxFactory } from "../mux/herdr/adapter.ts";
import { herdrBeaconMatcher } from "../mux/herdr/markers.ts";
import { parseEdge } from "./parse.ts";
import { edgesDir } from "./paths.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "./types.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-edges-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const RECORD: EdgeRecord = {
  schemaVersion: EDGE_SCHEMA_VERSION,
  harness: "claude",
  event: "Notification",
  detail: "permission_prompt",
  pid: 4242,
  pidStartTime: 777,
  markers: [{ namespace: "herdr", scope: "/run/herdr.sock", pane: "w1:p1" }],
  at: 1_000_000,
  promptHash: null,
};

describe("parseEdge", () => {
  test("reads the record the emitter writes", () => {
    expect(parseEdge(JSON.stringify(RECORD))).toEqual(RECORD);
    const hashed = { ...RECORD, event: "UserPromptSubmit", detail: null, promptHash: "a".repeat(64) };
    expect(parseEdge(JSON.stringify(hashed))).toEqual(hashed);
  });

  test("refuses a record with a field it cannot trust", () => {
    for (const bad of [
      { ...RECORD, schemaVersion: 2 },
      { ...RECORD, pid: 0 },
      { ...RECORD, markers: [] },
      { ...RECORD, event: "Stop; rm -rf" },
      { ...RECORD, detail: 7 },
      { ...RECORD, promptHash: "plain prompt text" },
    ]) {
      expect(parseEdge(JSON.stringify(bad))).toBeNull();
    }
    expect(parseEdge("not json")).toBeNull();
  });
});

describe("the edge spool", () => {
  test("hands each edge file over once, in name order, and leaves other files alone", async () => {
    mkdirSync(edgesDir(dir), { recursive: true });
    writeFileSync(join(edgesDir(dir), "2000-1-b.json"), "second");
    writeFileSync(join(edgesDir(dir), "1000-1-a.json"), "first");
    writeFileSync(join(edgesDir(dir), ".1000-1-c.json.tmp"), "half written");
    const spool = fileEdgeSpool(dir);
    expect(await spool.take()).toEqual(["first", "second"]);
    expect(await spool.take()).toEqual([]);
    expect(readdirSync(edgesDir(dir))).toEqual([".1000-1-c.json.tmp"]);
  });

  test("deletes unread an edge file another user owns", async () => {
    mkdirSync(edgesDir(dir), { recursive: true });
    writeFileSync(join(edgesDir(dir), "1000-1-a.json"), "foreign");
    expect(await fileEdgeSpool(dir, 4_000_000).take()).toEqual([]);
    expect(readdirSync(edgesDir(dir))).toEqual([]);
  });

  test("takes nothing, and throws nothing, when the folder is not there", async () => {
    expect(await fileEdgeSpool(join(dir, "none")).take()).toEqual([]);
  });
});

describe("the herdr beacon matcher", () => {
  test("places a herdr pane id on the pane of the same socket, in either spelling of the path", async () => {
    const real = join(dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "herdr.sock"), "");
    symlinkSync(real, join(dir, "link"));
    const matcher = herdrBeaconMatcher("herdr", join(dir, "link", "herdr.sock"));
    const scope = await matcher.scope();
    expect(scope).toBe(join(real, "herdr.sock"));
    expect(matcher.matches({ paneId: "w1:p1" }, { namespace: "herdr", scope: join(real, "herdr.sock"), pane: "w1:p1" }, scope!)).toBe(true);
    expect(matcher.matches({ paneId: "w1:p1" }, { namespace: "herdr", scope: join(dir, "link", "herdr.sock"), pane: "w1:p1" }, scope!)).toBe(true);
  });

  test("never places a herdr edge from another socket, or on another pane", async () => {
    writeFileSync(join(dir, "a.sock"), "");
    writeFileSync(join(dir, "b.sock"), "");
    const matcher = herdrBeaconMatcher("herdr", join(dir, "a.sock"));
    const scope = (await matcher.scope())!;
    expect(matcher.matches({ paneId: "w1:p1" }, { namespace: "herdr", scope: join(dir, "b.sock"), pane: "w1:p1" }, scope)).toBe(false);
    expect(matcher.matches({ paneId: "w1:p2" }, { namespace: "herdr", scope: join(dir, "a.sock"), pane: "w1:p1" }, scope)).toBe(false);
    expect(await herdrBeaconMatcher("herdr", "  ").scope()).toBeNull();
  });

  test("the herdr factory has a matcher for edges, and its adapter still sees agents on its own", () => {
    const target = { endpoint: join(dir, "a.sock"), timeoutMs: 1000, options: {} };
    expect(herdrMuxFactory.beaconMatcher?.(target)?.namespace).toBe("herdr");
    // The bridge decorates an adapter for identity only when it sees no agent (withBeaconsIfBlind).
    const adapter = herdrMuxFactory.create(target);
    expect(adapter.capabilities.supports.agentDetection).toBe(true);
  });
});

describe("the hook target registry on disk", () => {
  test("a bridge writes its target at boot under XDG_STATE_HOME and removes it on a clean stop", () => {
    const env = { XDG_STATE_HOME: join(dir, "xdg") };
    const target = registerHookTarget("/srv/lab-state", env, "/nowhere");
    const path = join(hookTargetsDir(env, "/nowhere"), hookTargetFileName("/srv/lab-state"));
    const record = parseHookTarget(readFileSync(path, "utf8"));
    expect(record?.stateDir).toBe("/srv/lab-state");
    expect(record?.pid).toBe(process.pid);
    target.remove();
    expect(existsSync(path)).toBe(false);
  });

  test("the stop leaves a newer bridge's file on the same state dir alone", () => {
    const env = { XDG_STATE_HOME: join(dir, "xdg") };
    const target = registerHookTarget("/srv/lab-state", env, "/nowhere");
    const path = join(hookTargetsDir(env, "/nowhere"), hookTargetFileName("/srv/lab-state"));
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, stateDir: "/srv/lab-state", pid: process.pid + 1, pidStartTime: null, bootedAt: 1 }));
    target.remove();
    expect(existsSync(path)).toBe(true);
  });

  test("keep writes the file again when an emitter deleted it, or when it names another pid", () => {
    const env = { XDG_STATE_HOME: join(dir, "xdg") };
    const target = registerHookTarget("/srv/lab-state", env, "/nowhere");
    const path = join(hookTargetsDir(env, "/nowhere"), hookTargetFileName("/srv/lab-state"));
    const before = readFileSync(path, "utf8");
    // Its own file stays as it is.
    target.keep();
    expect(readFileSync(path, "utf8")).toBe(before);
    // An emitter read a dead pid and deleted the file while this bridge restarted.
    rmSync(path);
    target.keep();
    expect(parseHookTarget(readFileSync(path, "utf8"))?.pid).toBe(process.pid);
    // Another bridge's record on this state dir.
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, stateDir: "/srv/lab-state", pid: process.pid + 1, pidStartTime: null, bootedAt: 1 }));
    target.keep();
    expect(parseHookTarget(readFileSync(path, "utf8"))?.pid).toBe(process.pid);
    target.remove();
  });

  test("without XDG_STATE_HOME the registry sits under ~/.local/state/collie", () => {
    expect(hookTargetsDir({}, "/home/pat")).toBe(join("/home/pat", ".local", "state", "collie", "hook-targets"));
  });
});

describe("the live hook sources across a restart", () => {
  test("saves and loads the sources, and reads a broken file as none", () => {
    const store = fileSourceStore(dir);
    expect(store.load()).toEqual([]);
    store.save([{ session: "main", paneId: "w1:p1", record: RECORD }]);
    expect(store.load()).toEqual([{ session: "main", paneId: "w1:p1", record: RECORD }]);
    writeFileSync(join(dir, "surface", "hook-sources.json"), "not json");
    expect(store.load()).toEqual([]);
  });

  test("keeps a start's model and the time its hook ran; a time that is not a number is dropped", () => {
    const store = fileSourceStore(dir);
    const started = { ...RECORD, event: "Stop", detail: null, model: "claude-opus-5-5[1m]" };
    store.save([{ session: "main", paneId: "w1:p1", record: started, modelAt: 999_000 }]);
    expect(store.load()).toEqual([{ session: "main", paneId: "w1:p1", record: started, modelAt: 999_000 }]);
    writeFileSync(join(dir, "surface", "hook-sources.json"), JSON.stringify([{ session: "main", paneId: "w1:p1", record: started, modelAt: "soon" }]));
    expect(store.load()).toEqual([{ session: "main", paneId: "w1:p1", record: started }]);
  });
});

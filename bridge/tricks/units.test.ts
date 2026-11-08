import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentView, WorkspaceView } from "../types.ts";
import { parseFacts } from "../../web/src/lib/tricks/schema.ts";
import { createTrickScanner, diskScanIo, readManifestText, type ScanIo } from "./discover.ts";
import { buildFacts, factsWorldOf, tricksHostName } from "./facts.ts";
import { switchesPath } from "./paths.ts";
import { TRICKS_ROUTE_RIGHTS, tricksSwitchRoute, tricksTapRoute, parseSince } from "./routes.ts";
import type { TricksSurface } from "./service.ts";
import { createSwitchReader, parseSwitches, renderSwitches, withSwitch, writeSwitches } from "./switches.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-units-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("the switch file", () => {
  test("written at 0600 in a 0700 folder, read back, off by default", async () => {
    const stateDir = await tempDir();
    const warnings: string[] = [];
    const read = createSwitchReader(stateDir, (l) => warnings.push(l));
    expect((await read()).on.size).toBe(0);
    await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-08T09:00:00.000Z"));
    expect((await stat(switchesPath(stateDir))).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateDir, "tricks"))).mode & 0o777).toBe(0o700);
    expect([...(await read()).on.keys()]).toEqual(["legs"]);
    expect(warnings).toEqual([]);
  });

  test("a file that does not parse reads as every trick off, with one warning per change", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"));
    await writeFile(switchesPath(stateDir), "{ not json");
    const warnings: string[] = [];
    const read = createSwitchReader(stateDir, (l) => warnings.push(l));
    expect((await read()).on.size).toBe(0);
    expect((await read()).on.size).toBe(0);
    expect(warnings.length).toBe(1);
  });

  test("render is stable and on/off round-trips", () => {
    const one = withSwitch({ on: new Map() }, "b", true, "t1");
    const two = withSwitch(one, "a", true, "t2");
    expect(renderSwitches(two)).toBe('{\n  "v": 1,\n  "on": {\n    "a": "t2",\n    "b": "t1"\n  }\n}\n');
    expect(parseSwitches(renderSwitches(two)).switches.on.get("b")).toBe("t1");
    expect(withSwitch(two, "b", true, "later").on.get("b")).toBe("t1");
    expect([...withSwitch(two, "a", false, "x").on.keys()]).toEqual(["b"]);
  });
});

describe("discovery", () => {
  test("a manifest is parsed again only when the folder's fingerprint moves", async () => {
    const root = await tempDir();
    await mkdir(join(root, "legs"));
    await writeFile(join(root, "legs", "trick.toml"), 'id = "legs"\nname = "Legs"\nrun = "./x"\nplaces = ["belt"]\n');
    let reads = 0;
    const counting: ScanIo = {
      list: (dir) => diskScanIo.list(dir),
      mtime: (p) => diskScanIo.mtime(p),
      read: (p) => {
        reads += 1;
        return diskScanIo.read(p);
      },
    };
    const scanner = createTrickScanner(root, counting);
    const first = await scanner.scan();
    expect(first.tricks[0]?.manifest?.name).toBe("Legs");
    await scanner.scan();
    expect(reads).toBe(1);
    await Bun.sleep(5);
    await writeFile(join(root, "legs", "trick.toml"), 'id = "legs"\nname = "Legs 2"\nrun = "./x"\nplaces = ["belt"]\n');
    const third = await scanner.scan();
    expect(reads).toBe(2);
    expect(third.tricks[0]?.manifest?.name).toBe("Legs 2");
  });

  test("no folder is `exists: false`; TOML that does not parse is one refusal", async () => {
    expect(await createTrickScanner("/nonexistent/collie-tricks").scan()).toEqual({ exists: false, tricks: [] });
    const read = readManifestText("id = ", "x");
    expect(read.manifest).toBeUndefined();
    expect(read.refusals[0]?.reason).toStartWith("trick.toml is not TOML");
    expect(readManifestText(null, "x").refusals[0]?.code).toBe("missing");
  });

  test("the folder name must match the id", () => {
    const read = readManifestText('id = "legs"\nname = "L"\nrun = "./x"\nplaces = ["belt"]\n', "other");
    expect(read.manifest).toBeUndefined();
    expect(read.refusals[0]?.path).toBe("/id");
  });
});

const pane = (over: Partial<AgentView>): AgentView => ({
  paneId: "w6X:3",
  workspaceId: "w6X",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w6X:t1",
  agent: "claude",
  status: "working",
  cwd: "/work/collie",
  focused: false,
  ...over,
});
function space(label: string, folder?: string): WorkspaceView {
  const ws: WorkspaceView = { workspaceId: label, number: 1, label, focused: false, activeTabId: "t", tabCount: 1, paneCount: 1 };
  if (folder !== undefined) ws.folder = folder;
  return ws;
}

describe("the facts", () => {
  test("sessions by scope key, spaces with folders, and the document the schema reads back", () => {
    const world = factsWorldOf({
      host: "bluefin",
      runtimes: [
        {
          name: "default",
          agents: [pane({ paneLabel: "composer", tabLabel: "fix", agentSession: { kind: "path", value: "/secret/path.jsonl" } })],
          shellPanes: [pane({ paneId: "w6X:4", kind: "shell", agent: "shell", status: "idle", workspaceLabel: "home" })],
          workspaces: [space("collie", "/work/collie-workspace"), space("home")],
        },
        { name: "yt", agents: [], shellPanes: [], workspaces: [] },
      ],
      folderOf: (name) => (name === "yt" ? "/work/yt" : undefined),
      labelOf: (name) => (name === "yt" ? "YouTube" : undefined),
      activeAt: () => Date.parse("2026-11-08T09:41:00Z"),
    });
    expect(world.sessions).toEqual([
      {
        id: "bluefin:w6X:3",
        memberId: "bluefin",
        sessionId: "bluefin:w6X:3",
        paneId: "w6X:3",
        host: "bluefin",
        status: "working",
        name: "composer",
        agent: "claude",
        cwd: "/work/collie",
        space: "collie",
        tab: "fix",
        lastActiveAt: "2026-11-08T09:41:00.000Z",
      },
      { id: "bluefin:w6X:4", memberId: "bluefin", sessionId: "bluefin:w6X:4", paneId: "w6X:4", host: "bluefin", status: "idle", name: "shell", cwd: "/work/collie", space: "home", lastActiveAt: "2026-11-08T09:41:00.000Z" },
    ]);
    expect(world.spaces).toEqual([{ name: "collie", folder: "/work/collie-workspace" }, { name: "home" }, { name: "YouTube", folder: "/work/yt" }]);
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(JSON.stringify(facts)).not.toContain("/secret/path.jsonl");
    const back = parseFacts(JSON.parse(JSON.stringify(facts)));
    expect(back.refusals).toEqual([]);
    expect(back.facts).toEqual(facts);
  });

  test("the host is the member id, else the short host name, else local", () => {
    expect(tricksHostName("bluefin-hc", "bluefin.lan")).toBe("bluefin-hc");
    expect(tricksHostName(null, "bluefin.tail1234.ts.net")).toBe("bluefin");
    expect(tricksHostName(null, "")).toBe("local");
    expect(tricksHostName(null, "trick")).toBe("local");
  });
});

describe("the routes", () => {
  test("since is a whole number or every part", () => {
    expect(parseSince(null)).toBeUndefined();
    expect(parseSince("0")).toBe(0);
    expect(parseSince("1762595000123")).toBe(1762595000123);
    expect(parseSince("-1")).toBeUndefined();
    expect(parseSince("1e3")).toBeUndefined();
    expect(parseSince("99999999999999999")).toBeUndefined();
  });

  test("the tap path is decoded and handed on", async () => {
    const calls: [string, string][] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      sessionPanes: () => undefined,
      tap: async (host, id) => {
        calls.push([host, id]);
        return { status: 404, body: { error: "unknown-trick" } };
      },
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/tap$/;
    const match = route.exec("/api/tricks/blue%66in/legs/tap");
    if (match === null) throw new Error("no match");
    await tricksTapRoute(surface, match, {});
    expect(calls).toEqual([["bluefin", "legs"]]);
    const broken = route.exec("/api/tricks/%E0%A4%A/legs/tap");
    if (broken === null) throw new Error("no match");
    expect(await tricksTapRoute(surface, broken, {})).toEqual({ status: 404, body: { error: "unknown-host" } });
  });

  test("the switch path is decoded, the body must be exactly { on: boolean }", async () => {
    const calls: [string, string, boolean][] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async (host, id, on) => {
        calls.push([host, id, on]);
        return { status: 404, body: { error: "unknown-trick" } };
      },
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/switch$/;
    const match = route.exec("/api/tricks/blue%66in/legs/switch");
    if (match === null) throw new Error("no match");
    await tricksSwitchRoute(surface, match, { on: false });
    expect(calls).toEqual([["bluefin", "legs", false]]);
    for (const body of [undefined, null, [], {}, { on: "yes" }, { on: true, extra: 1 }]) {
      expect(await tricksSwitchRoute(surface, match, body)).toEqual({ status: 400, body: { error: "switch-invalid" } });
    }
    expect(calls.length).toBe(1);
    const broken = route.exec("/api/tricks/%E0%A4%A/legs/switch");
    if (broken === null) throw new Error("no match");
    expect(await tricksSwitchRoute(surface, broken, { on: true })).toEqual({ status: 404, body: { error: "unknown-host" } });
  });

  test("server.ts gates the list as a read and the tap as a write, stamps the watch for a paired phone only, the switch as a write, and declares both routes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const list = src.slice(src.indexOf('if (pathname === "/api/tricks" && req.method === "GET")'));
    // The rights live in one table in routes.ts; server.ts reads each route's level from it.
    expect(TRICKS_ROUTE_RIGHTS).toEqual({ reply: "read", tap: "write", switch: "write" });
    expect(list.slice(0, 400)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.reply, pairingGate)");
    expect(list.slice(0, 600)).toContain("if (pairedLabel(req, pairingGate) !== null) tricks.noteWatched();");
    const tap = src.slice(src.indexOf("const tricksTap = TRICKS_TAP_ROUTE.exec(pathname);"));
    expect(tap.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.tap, pairingGate)");
    const sw = src.slice(src.indexOf("const tricksSwitch = TRICKS_SWITCH_ROUTE.exec(pathname);"));
    expect(sw.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.switch, pairingGate)");
    expect(src).toContain("const TRICKS_SWITCH_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/switch$/;");
    expect(src).toContain("const TRICKS_TAP_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/tap$/;");
    expect(src).toContain("if (poller !== null) opts.tricks?.noteWatched();");
    expect(src).toContain("if (tricksRev !== undefined) body.tricksRev = tricksRev;");
  });
});

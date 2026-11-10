import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentView, WorkspaceView } from "../types.ts";
import { parseFacts, TRICK_CONTRACT } from "../../web/src/lib/tricks/schema.ts";
import { CODE_FILES_MAX, diskTrickFs, trickCodeHash, type TrickFs } from "./code-hash.ts";
import { createTrickScanner, MANIFEST_BYTES_MAX, readManifestText, TRICKS_MAX } from "./discover.ts";
import { buildFacts, factsWorldOf } from "./facts.ts";
import { switchesPath } from "./paths.ts";
import { TRICKS_ROUTE_RIGHTS, tricksAutoRoute, tricksMediaRoute, tricksSwitchRoute, tricksTapRoute, tricksUndoRoute, parseSince } from "./routes.ts";
import type { TricksSurface } from "./service.ts";
import { createSwitchReader, parseSwitches, renderSwitches, SWITCH_LOCK_STALE_MS, updateSwitches, withApproval, withEntry, withSwitch, writeSwitches } from "./switches.ts";

const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

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
    await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-08T09:00:00.000Z", HASH));
    expect((await stat(switchesPath(stateDir))).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateDir, "tricks"))).mode & 0o777).toBe(0o700);
    expect([...(await read()).on.entries()]).toEqual([["legs", { at: "2026-11-08T09:00:00.000Z", hash: HASH, auto: false, by: "cli", powers: null }]]);
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

  test("render is version 3 and stable, on/off round-trips, and switching on again stores the new hash", () => {
    const one = withSwitch({ on: new Map() }, "b", true, "t1", HASH);
    const two = withSwitch(one, "a", true, "t2");
    const entry = (at: string, hash: string | null) => `{\n      "at": "${at}",\n      "hash": ${hash === null ? "null" : `"${hash}"`},\n      "auto": false,\n      "by": "cli",\n      "powers": null\n    }`;
    expect(renderSwitches(two)).toBe(`{\n  "v": 3,\n  "on": {\n    "a": ${entry("t2", null)},\n    "b": ${entry("t1", HASH)}\n  }\n}\n`);
    expect(parseSwitches(renderSwitches(two)).switches.on.get("b")).toEqual({ at: "t1", hash: HASH, auto: false, by: "cli", powers: null });
    expect(parseSwitches(renderSwitches(two)).switches.version).toBe(3);
    expect(withSwitch(two, "b", true, "later", HASH2).on.get("b")).toEqual({ at: "later", hash: HASH2, auto: false, by: "cli", powers: null });
    expect([...withSwitch(two, "a", false, "x").on.keys()]).toEqual(["b"]);
  });

  test("a version 3 entry keeps auto, by, powers, previous and declined through a round trip", () => {
    const set = withApproval({ on: new Map() }, "legs", { at: "t1", hash: HASH, by: "cli", powers: "0123456789abcdef" });
    const auto = withEntry(set, "legs", { ...set.on.get("legs")!, auto: true });
    const next = withApproval(auto, "legs", { at: "t2", hash: HASH2, by: "auto", powers: "0123456789abcdef" });
    const declined = withEntry(next, "legs", { ...next.on.get("legs")!, declined: HASH });
    const back = parseSwitches(renderSwitches(declined)).switches.on.get("legs");
    expect(back).toEqual({ at: "t2", hash: HASH2, auto: true, by: "auto", powers: "0123456789abcdef", previous: { hash: HASH, at: "t1", by: "cli", powers: "0123456789abcdef" }, declined: HASH });
    // Approving the same hash again keeps the earlier `previous`; a new approval clears a decline.
    expect(withApproval(declined, "legs", { at: "t3", hash: HASH2, by: "phone", powers: null }).on.get("legs")?.previous?.hash).toBe(HASH);
    expect(withApproval(declined, "legs", { at: "t3", hash: HASH2, by: "phone", powers: null }).on.get("legs")?.declined).toBeUndefined();
  });

  test("a version 1 and a version 2 file still read, with their version; a newer one reads as all off", () => {
    const v1 = parseSwitches('{ "v": 1, "on": { "legs": "2026-11-08T09:00:00Z" } }');
    expect(v1.problem).toBeNull();
    expect(v1.switches.version).toBe(1);
    expect(v1.switches.on.get("legs")).toEqual({ at: "2026-11-08T09:00:00Z", hash: null, auto: false, by: "cli", powers: null });
    const v2 = parseSwitches(`{ "v": 2, "on": { "legs": { "at": "t", "hash": "${HASH}" } } }`);
    expect(v2.switches.version).toBe(2);
    expect(v2.switches.on.get("legs")?.hash).toBe(HASH);
    const v4 = parseSwitches('{ "v": 4, "on": { "legs": { "at": "t" } } }');
    expect(v4.switches.on.size).toBe(0);
    expect(v4.problem).toContain("not a version 1, 2 or 3");
  });

  test("two writers at once both land: each re-reads the file under the lock", async () => {
    const stateDir = await tempDir();
    await Promise.all(["a", "b", "c", "d"].map((id) => updateSwitches(stateDir, (now) => withSwitch(now, id, true, "t", HASH))));
    expect([...parseSwitches(readFileSync(switchesPath(stateDir), "utf8")).switches.on.keys()].toSorted()).toEqual(["a", "b", "c", "d"]);
    expect(existsSync(`${switchesPath(stateDir)}.lock`)).toBe(false);
  });

  test("a lock left by a writer that died is taken over after 5 s", async () => {
    const stateDir = await tempDir();
    await mkdir(join(stateDir, "tricks"), { recursive: true });
    const lock = `${switchesPath(stateDir)}.lock`;
    await writeFile(lock, "999999\n");
    const old = new Date(Date.now() - SWITCH_LOCK_STALE_MS - 1000);
    await utimes(lock, old, old);
    await updateSwitches(stateDir, (now) => withSwitch(now, "legs", true, "t", HASH));
    expect(parseSwitches(readFileSync(switchesPath(stateDir), "utf8")).switches.on.has("legs")).toBe(true);
  });
});

/** A trick folder under `root` with a manifest and files (nested paths allowed). */
async function trickDir(root: string, id: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), `id = "${id}"\nname = "${id}"\nrun = "./p.sh"\nplaces = ["belt"]\n`);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

/** A file system that counts reads of `trick.toml`. */
function counting() {
  let reads = 0;
  const fs: TrickFs = {
      ...diskTrickFs,
      read: (p, max) => {
        if (p.endsWith("trick.toml")) reads += 1;
        return diskTrickFs.read(p, max);
      },
  };
  return { fs, reads: () => reads };
}

describe("discovery", () => {
  test("a manifest is parsed again only when the folder's fingerprint moves", async () => {
    const root = await tempDir();
    await trickDir(root, "legs");
    const { fs, reads } = counting();
    const scanner = createTrickScanner(root, { fs });
    const first = await scanner.scan();
    expect(first.tricks[0]?.manifest?.name).toBe("legs");
    // Once for the manifest, once for the code hash.
    expect(reads()).toBe(2);
    await scanner.scan();
    expect(reads()).toBe(2);
    await Bun.sleep(5);
    await writeFile(join(root, "legs", "trick.toml"), 'id = "legs"\nname = "Legs 2"\nrun = "./x"\nplaces = ["belt"]\n');
    const third = await scanner.scan();
    expect(reads()).toBe(4);
    expect(third.tricks[0]?.manifest?.name).toBe("Legs 2");
  });

  test("a log, media/ and captures/ move nothing; code moves the code hash; config.toml moves only its own hash", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "legs", { "p.sh": "#!/bin/sh\n", "lib/util.sh": "x=1\n", "config.toml": "a = 1\n" });
    const { fs, reads } = counting();
    const scanner = createTrickScanner(root, { fs });
    const first = (await scanner.scan()).tricks[0]!;
    expect(first.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.configHash).toMatch(/^[0-9a-f]{64}$/);
    await Bun.sleep(5);
    await writeFile(join(dir, "run.log"), "a line\n");
    await mkdir(join(dir, "media"));
    await writeFile(join(dir, "media", "shot.png"), "png");
    await mkdir(join(dir, "captures"));
    await writeFile(join(dir, "captures", "c.json"), "{}");
    await writeFile(join(dir, ".cache"), "x");
    const quiet = (await scanner.scan()).tricks[0]!;
    expect(quiet).toBe(first);
    expect(reads()).toBe(2);
    await writeFile(join(dir, "config.toml"), "a = 2\n");
    const configured = (await scanner.scan()).tricks[0]!;
    expect(configured.codeHash).toBe(first.codeHash);
    expect(configured.configHash).not.toBe(first.configHash);
    await writeFile(join(dir, "lib", "util.sh"), "x=2\n");
    const edited = (await scanner.scan()).tricks[0]!;
    expect(edited.codeHash).not.toBe(first.codeHash);
    expect((await trickCodeHash(dir)).ok && (await trickCodeHash(dir))).toEqual({ ok: true, hash: edited.codeHash! });
  });

  test("B3: a symlink is refused, never followed: the row says why and the trick has no code hash", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "legs");
    const outside = join(root, "outside.sh");
    await writeFile(outside, "one\n");
    await symlink(outside, join(dir, "p.sh"));
    expect(await trickCodeHash(dir)).toMatchObject({ ok: false, code: "link" });
    const found = (await createTrickScanner(root).scan()).tricks[0]!;
    expect(found.codeHash).toBeUndefined();
    expect(found.manifest).toBeUndefined();
    expect(found.refusals.map((r) => r.reason)).toContain("p.sh is a symbolic link. A trick holds regular files only: put the file itself there.");
  });

  test("more than 2000 files refuses the trick with a reason", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "big");
    await mkdir(join(dir, "lib"));
    await Promise.all(Array.from({ length: CODE_FILES_MAX + 1 }, (_, i) => writeFile(join(dir, "lib", `f${String(i)}.ts`), "")));
    const found = (await createTrickScanner(root).scan()).tricks[0]!;
    expect(found.manifest).toBeUndefined();
    expect(found.refusals.at(-1)?.reason).toContain(`more than ${String(CODE_FILES_MAX)} files`);
  });

  test.skipIf(process.platform === "win32")("a FIFO as trick.toml or config.toml is refused and never hangs the scan", async () => {
    const root = await tempDir();
    const dir = join(root, "fifo");
    await mkdir(dir);
    expect(Bun.spawnSync(["mkfifo", join(dir, "trick.toml")]).exitCode).toBe(0);
    const other = await trickDir(root, "other", { "p.sh": "" });
    expect(Bun.spawnSync(["mkfifo", join(other, "config.toml")]).exitCode).toBe(0);
    const scan = await createTrickScanner(root, { timeoutMs: 2000 }).scan();
    expect(scan.kept).toBeUndefined();
    expect(scan.tricks.find((t) => t.id === "fifo")?.refusals[0]?.reason).toBe("trick.toml is not a regular file.");
    const found = scan.tricks.find((t) => t.id === "other");
    expect(found?.manifest).toBeUndefined();
    expect(found?.refusals.map((r) => r.reason)).toContain("config.toml is not a regular file.");
  });

  test("a trick.toml over 64 KiB is refused unread", async () => {
    const root = await tempDir();
    const dir = await trickDir(root, "huge");
    await writeFile(join(dir, "trick.toml"), `# ${"x".repeat(MANIFEST_BYTES_MAX)}\n`);
    const found = (await createTrickScanner(root).scan()).tricks[0]!;
    expect(found.manifest).toBeUndefined();
    expect(found.refusals[0]).toMatchObject({ code: "size", reason: "trick.toml is larger than 64 KiB." });
  });

  test("a scan that runs over keeps the last good result, and no second scan starts while it hangs", async () => {
    const root = await tempDir();
    await trickDir(root, "legs");
    let hang = false;
    let lists = 0;
    const stuck: TrickFs = {
      ...diskTrickFs,
      list: (dir) => {
        if (dir === root) lists += 1;
        return hang && dir === root ? new Promise(() => {}) : diskTrickFs.list(dir);
      },
    };
    const warnings: string[] = [];
    const scanner = createTrickScanner(root, { fs: stuck, timeoutMs: 50, warn: (l) => warnings.push(l) });
    const good = await scanner.scan();
    hang = true;
    const kept = await scanner.scan();
    expect(kept.kept).toContain("longer than");
    expect(kept.tricks).toEqual(good.tricks);
    const again = await scanner.scan();
    expect(again.kept).toContain("still running");
    expect(lists).toBe(2);
    expect(warnings.length).toBe(2);
  });

  test("only ENOENT means no tricks; any other listing error keeps the last scan", async () => {
    const root = await tempDir();
    await trickDir(root, "legs");
    let fail = false;
    const flaky: TrickFs = { ...diskTrickFs, list: (dir) => (fail && dir === root ? Promise.resolve({ ok: false, missing: false, error: "EACCES" }) : diskTrickFs.list(dir)) };
    const scanner = createTrickScanner(root, { fs: flaky });
    const good = await scanner.scan();
    fail = true;
    const kept = await scanner.scan();
    expect(kept.kept).toContain("EACCES");
    expect(kept.tricks.map((t) => t.id)).toEqual(["legs"]);
    expect(good.exists).toBe(true);
    expect(await createTrickScanner("/nonexistent/collie-tricks").scan()).toEqual({ exists: false, tricks: [] });
  });

  test("past 64 folders the rest are listed as refused, and a new folder never pushes out one already read", async () => {
    const root = await tempDir();
    await Promise.all(Array.from({ length: TRICKS_MAX + 1 }, (_, i) => trickDir(root, `t${String(i).padStart(3, "0")}`)));
    const scanner = createTrickScanner(root);
    const first = await scanner.scan();
    expect(first.tricks).toHaveLength(TRICKS_MAX + 1);
    const over = first.tricks.filter((t) => t.manifest === undefined);
    expect(over.map((t) => t.id)).toEqual([`t${String(TRICKS_MAX).padStart(3, "0")}`]);
    expect(over[0]?.refusals[0]?.reason).toContain("more than 64 trick folders");
    await trickDir(root, "a-first");
    const second = await scanner.scan();
    expect(second.tricks[0]?.id).toBe("a-first");
    expect(second.tricks[0]?.manifest).toBeUndefined();
    expect(second.tricks.find((t) => t.id === "t000")?.manifest).toBeDefined();
    // A fresh scanner (a restart) reads the ones switched on first.
    const fresh = await createTrickScanner(root).scan(new Set(["a-first"]));
    expect(fresh.tricks[0]?.manifest).toBeDefined();
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

  test("env in the manifest: names only, each one listed once", () => {
    const read = readManifestText('id = "x"\nname = "X"\nrun = "./x"\nplaces = ["belt"]\nenv = ["GH_TOKEN", "GH_TOKEN", "DBUS_SESSION_BUS_ADDRESS"]\n', "x");
    expect(read.manifest?.env).toEqual(["GH_TOKEN", "DBUS_SESSION_BUS_ADDRESS"]);
    const bad = readManifestText('id = "x"\nname = "X"\nrun = "./x"\nplaces = ["belt"]\nenv = ["1BAD"]\n', "x");
    expect(bad.manifest).toBeUndefined();
    expect(bad.refusals[0]?.path).toBe("/env/0");
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
      memberId: "bluefin-hc",
      machine: "bluefin",
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
        id: "bluefin-hc:w6X:3",
        memberId: "bluefin-hc",
        sessionId: "bluefin-hc:w6X:3",
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
      { id: "bluefin-hc:w6X:4", memberId: "bluefin-hc", sessionId: "bluefin-hc:w6X:4", paneId: "w6X:4", host: "bluefin", status: "idle", name: "shell", cwd: "/work/collie", space: "home", lastActiveAt: "2026-11-08T09:41:00.000Z" },
    ]);
    expect(world.spaces).toEqual([{ name: "collie", folder: "/work/collie-workspace" }, { name: "home" }, { name: "YouTube", folder: "/work/yt" }]);
    expect(world.memberId).toBe("bluefin-hc");
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(JSON.stringify(facts)).not.toContain("/secret/path.jsonl");
    const back = parseFacts(JSON.parse(JSON.stringify(facts)));
    expect(back.refusals).toEqual([]);
    expect(back.facts).toEqual(facts);
    // The member id is the key a program keeps; `host` is the machine's name, for display only.
    expect(facts.memberId).toBe("bluefin-hc");
    expect(facts.host).toBe("bluefin");
    // One contract number on the facts, no `v` beside it.
    expect(facts.contract).toBe(TRICK_CONTRACT);
    expect(Object.keys(facts)).not.toContain("v");
  });

  test("a solo install keys its sessions on its install id, never on the host name", () => {
    const world = factsWorldOf({
      memberId: "m_k3x9q2w7ab",
      machine: "bluefin.lan",
      runtimes: [{ name: "default", agents: [pane({})], shellPanes: [], workspaces: [] }],
    });
    expect(world.sessions[0]).toMatchObject({ id: "m_k3x9q2w7ab:w6X:3", memberId: "m_k3x9q2w7ab", sessionId: "m_k3x9q2w7ab:w6X:3", host: "bluefin.lan" });
    const facts = buildFacts(world, { id: "legs", dir: "/c/tricks/legs", state: "/s/tricks/legs" }, { kind: "timer" });
    expect(facts).toMatchObject({ memberId: "m_k3x9q2w7ab", host: "bluefin.lan" });
    expect(JSON.stringify(facts)).not.toContain('"bluefin.lan:');
    expect(parseFacts(JSON.parse(JSON.stringify(facts))).refusals).toEqual([]);
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
      media: async () => null,
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
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
      media: async () => null,
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
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

  test("auto takes exactly { on: boolean } and undo exactly {}; both decode the path; server.ts gates both as writes", async () => {
    const calls: string[] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      media: async () => null,
      autoRoute: async (host, id, on) => {
        calls.push(`auto ${host} ${id} ${String(on)}`);
        return { status: 409, body: { error: "off", message: "The trick is off." } };
      },
      undoRoute: async (host, id) => {
        calls.push(`undo ${host} ${id}`);
        return { status: 409, body: { error: "no-previous", message: "There is no earlier version to go back to." } };
      },
    };
    const auto = /^\/api\/tricks\/([^/]+)\/([^/]+)\/auto$/.exec("/api/tricks/blue%66in/legs/auto");
    const undo = /^\/api\/tricks\/([^/]+)\/([^/]+)\/undo$/.exec("/api/tricks/bluefin/legs/undo");
    if (auto === null || undo === null) throw new Error("no match");
    expect(await tricksAutoRoute(surface, auto, { on: true })).toEqual({ status: 409, body: { error: "off", message: "The trick is off." } });
    expect(await tricksUndoRoute(surface, undo, {})).toMatchObject({ status: 409, body: { error: "no-previous" } });
    for (const body of [undefined, null, [], {}, { on: "yes" }, { on: true, extra: 1 }]) {
      expect(await tricksAutoRoute(surface, auto, body)).toEqual({ status: 400, body: { error: "auto-invalid" } });
    }
    for (const body of [undefined, null, [], { hash: "a" }]) {
      expect(await tricksUndoRoute(surface, undo, body)).toEqual({ status: 400, body: { error: "undo-invalid" } });
    }
    expect(calls).toEqual(["auto bluefin legs true", "undo bluefin legs"]);
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    expect(src).toContain("const TRICKS_AUTO_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/auto$/;");
    expect(src).toContain("const TRICKS_UNDO_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/undo$/;");
    const block = src.slice(src.indexOf("const tricksVersion = TRICKS_AUTO_ROUTE.exec(pathname)"));
    expect(block.slice(0, 400)).toContain("guard(req, cfg, auto ? TRICKS_ROUTE_RIGHTS.auto : TRICKS_ROUTE_RIGHTS.undo, pairingGate)");
  });

  test("the media path is decoded and handed on; a segment that does not decode is a miss", async () => {
    const calls: [string, string, string][] = [];
    const surface: TricksSurface = {
      rev: () => 1,
      noteWatched: () => {},
      reply: async () => ({ rev: 1, tricks: [], parts: [], present: [] }),
      tap: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      sessionPanes: () => undefined,
      setSwitch: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      media: async (host, id, rel) => {
        calls.push([host, id, rel]);
        return null;
      },
      autoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
      undoRoute: async () => ({ status: 404, body: { error: "unknown-trick" } }),
    };
    const route = /^\/api\/tricks\/([^/]+)\/([^/]+)\/(media\/.+)$/;
    const match = route.exec("/api/tricks/blue%66in/legs/media/shots/case%2024.png");
    if (match === null) throw new Error("no match");
    expect(await tricksMediaRoute(surface, match)).toBeNull();
    expect(calls).toEqual([["bluefin", "legs", "media/shots/case 24.png"]]);
    for (const path of ["/api/tricks/%E0%A4%A/legs/media/a.png", "/api/tricks/bluefin/legs/media/%E0%A4%A.png"]) {
      const broken = route.exec(path);
      if (broken === null) throw new Error("no match");
      expect(await tricksMediaRoute(surface, broken)).toBeNull();
    }
    expect(calls.length).toBe(1);
    expect(route.exec("/api/tricks/bluefin/legs/trick.toml")).toBeNull();
  });

  test("server.ts gates the list as a read and the tap as a write, stamps the watch for a paired phone only, the switch as a write, and declares both routes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const list = src.slice(src.indexOf('if (pathname === "/api/tricks" && req.method === "GET")'));
    // The rights live in one table in routes.ts; server.ts reads each route's level from it.
    expect(TRICKS_ROUTE_RIGHTS).toEqual({ reply: "read", tap: "write", switch: "write", media: "read", auto: "write", undo: "write" });
    expect(list.slice(0, 400)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.reply, pairingGate)");
    expect(list.slice(0, 600)).toContain("if (pairedLabel(req, pairingGate) !== null) tricks.noteWatched();");
    const tap = src.slice(src.indexOf("const tricksTap = TRICKS_TAP_ROUTE.exec(pathname);"));
    expect(tap.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.tap, pairingGate)");
    const sw = src.slice(src.indexOf("const tricksSwitch = TRICKS_SWITCH_ROUTE.exec(pathname);"));
    expect(sw.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.switch, pairingGate)");
    expect(src).toContain("const TRICKS_SWITCH_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/switch$/;");
    expect(src).toContain("const TRICKS_TAP_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/tap$/;");
    // A picture: read-gated, the hill image's headers, and one 404 for every miss.
    expect(src).toContain("const TRICKS_MEDIA_ROUTE = /^\\/api\\/tricks\\/([^/]+)\\/([^/]+)\\/(media\\/.+)$/;");
    const media = src.slice(src.indexOf("const tricksMedia = TRICKS_MEDIA_ROUTE.exec(pathname);"));
    expect(media.slice(0, 200)).toContain('req.method === "GET"');
    expect(media.slice(0, 300)).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.media, pairingGate)");
    expect(media.slice(0, 900)).toContain("secure(new Response(file.bytes, { headers: { \"content-type\": file.mime, ...HILL_MEDIA_HEADERS } }))");
    expect(src).toContain("if (poller !== null) opts.tricks?.noteWatched();");
    expect(src).toContain("if (tricksRev !== undefined) body.tricksRev = tricksRev;");
  });
});

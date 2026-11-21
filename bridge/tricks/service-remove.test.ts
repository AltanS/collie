import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentViewStore, trickViewsDir, viewEntry } from "../agent-view/store.ts";
import { AuditLog } from "../audit.ts";
import { HOST as THIS_HOST } from "../host.ts";
import type { JsonValue } from "../json.ts";
import { asJsonObject, parseJsonObject } from "../../web/src/lib/json.ts";
import { officialWire, type OfficialEntry } from "./official.ts";
import { approvedTrickDir, TRICKS_DIR, tricksStateDir, trickStateDir } from "./paths.ts";
import { REMOVE_RECEIPTS_FILE, REMOVE_UNKNOWN_LINE, memoryRemoveReceipts, type RemoveAnswer } from "./remove-receipts.ts";
import { payloadDigest } from "../worktree-receipts.ts";
import { REMOVE_ON_LINE, REMOVE_RUNNING_LINE } from "./remove.ts";
import { TRICKS_ROUTE_RIGHTS, tricksRemoveRoute } from "./routes.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { TricksService, type TricksServiceDeps } from "./service.ts";
import { trickCodeHash } from "./code-hash.ts";
import { powersOfDir } from "./approved.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";

// ADR 0168: `POST /api/tricks/<host>/<id>/remove` through the tricks service. Every refusal is proven to delete
// nothing; the happy path drops the three folders, the trick's parts, views and open Decisions; a replay of a
// request id answers the first answer and touches nothing, also after a restart. Every trick lives in a temp folder.

const posix = !THIS_HOST.caseInsensitive && process.platform !== "win32";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-remove-route-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-11-21T09:00:00Z");
const HOST = "lodge";
const RID = "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const RID2 = "8f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const RID3 = "9f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt", "session"]\n';
const ROUTE = /^\/api\/tricks\/([^/]+)\/([^/]+)\/remove$/;

const belt = (label: string): string => JSON.stringify({ v: 1, asOf: "2026-11-21T09:00:00Z", parts: [{ at: "belt", id: "belt", mark: { label, intent: "x" } }] });
const exited = (stdout: string): RunOutcome => ({ kind: "exited", code: 0, stdout, stderr: "", ms: 5 });
type Scripted = RunOutcome | { later: () => Promise<RunOutcome> };

interface Rig {
  configDir: string;
  stateDir: string;
  clock: { t: number };
  service: TricksService;
  specs: RunSpec[];
  audits: { action: string; detail: Record<string, string>; device?: string | null }[];
  offs: string[];
  forgot: string[];
  views: AgentViewStore;
  deps: TricksServiceDeps;
}

async function rig(outcomes: Scripted[], extra: Partial<TricksServiceDeps> = {}, at?: { configDir: string; stateDir: string }): Promise<Rig> {
  const root = await tempDir();
  const configDir = at?.configDir ?? join(root, "config");
  const stateDir = at?.stateDir ?? join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const clock = { t: T0 };
  const specs: RunSpec[] = [];
  const audits: Rig["audits"] = [];
  const offs: string[] = [];
  const forgot: string[] = [];
  const views = new AgentViewStore(trickViewsDir(stateDir), () => clock.t, () => {});
  let i = 0;
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    feature: { on: () => true },
    memberId: HOST,
    world: (memberId) => ({ machine: "desk", sessions: [{ id: `${memberId}:w6X:3`, memberId, sessionId: `${memberId}:w6X:3`, paneId: "w6X:3", host: "desk", name: "composer", agent: "claude", status: "working" }], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COLLIE_TOKEN: "tok-placeholder" },
    now: () => clock.t,
    warn: () => {},
    revBase: 1000,
    run: async (spec) => {
      specs.push(spec);
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (next === undefined) throw new Error("no outcome scripted");
      return "later" in next ? await next.later() : next;
    },
    audit: (entry) => void audits.push(entry),
    decisions: { sync: () => [], off: (trick) => void offs.push(trick.id), prune: () => {}, seenOf: () => undefined },
    forgetTrick: (id) => {
      forgot.push(id);
      views.dropTrick(id);
    },
    ...extra,
  };
  return { configDir, stateDir, clock, service: new TricksService(deps), specs, audits, offs, forgot, views, deps };
}

async function makeTrick(r: Pick<Rig, "configDir">, id = "legs", manifest = MANIFEST): Promise<string> {
  const dir = join(r.configDir, TRICKS_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), manifest);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

async function switchOn(r: Pick<Rig, "configDir" | "stateDir">, id = "legs"): Promise<void> {
  const dir = join(r.configDir, TRICKS_DIR, id);
  const code = await trickCodeHash(dir);
  const switches: Switches = withSwitch({ on: new Map() }, id, true, "2026-11-21T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, id));
  await writeSwitches(r.stateDir, switches);
}

async function tick(r: Rig): Promise<void> {
  r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
  await r.service.idle();
}

/** Post the remove route as server.ts does after its gate. */
async function post(r: Rig, path: string, body: JsonValue | undefined, device: string | null = "pixel-8"): Promise<RemoveAnswer> {
  const match = ROUTE.exec(path);
  if (match === null) throw new Error(`no route: ${path}`);
  return await tricksRemoveRoute(r.service, match, body, device);
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/** A trick that ran once (its approved copy, its state folder, a belt mark), then went off, with a view of it. */
async function ranAndOff(r: Rig): Promise<string> {
  const dir = await makeTrick(r);
  await switchOn(r);
  await tick(r);
  expect((await r.service.reply(undefined)).parts.some((p) => p.trick === "legs")).toBe(true);
  expect((await r.service.setSwitch(HOST, "legs", false)).status).toBe(200);
  r.views.put(viewEntry({ trick: "legs", session: `${HOST}/w6X:3`, on: true, shows: 0, changedAt: 1 }));
  return dir;
}

async function kept(r: Rig, dir: string): Promise<void> {
  expect(await exists(join(dir, "trick.toml"))).toBe(true);
  expect(await exists(trickStateDir(r.stateDir, "legs"))).toBe(true);
}

describe.if(posix)("POST /api/tricks/<host>/<id>/remove", () => {
  test("removes a trick that is off: the three folders, its row, its parts, its views and its open Decisions; one audit line", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await ranAndOff(r);
    expect(await exists(approvedTrickDir(r.configDir, "legs"))).toBe(true);
    expect(await exists(trickStateDir(r.stateDir, "legs"))).toBe(true);
    const entry: OfficialEntry = { id: "legs", name: "Legs", description: "A leg.", repo: "https://example.com/o/r", dir: "legs", commit: "a".repeat(40), hash: "b".repeat(64), extras: "c".repeat(64), rules: null, contract: 1, places: ["belt"], previous: [] };
    expect((await officialWire(r.configDir, [entry]))[0]?.state).toBe("taken");

    expect(await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).toEqual({ status: 200, body: { rid: RID, code: "removed", id: "legs" } });
    for (const path of [dir, trickStateDir(r.stateDir, "legs"), approvedTrickDir(r.configDir, "legs")]) expect(await exists(path)).toBe(false);
    // The next poll: no row, no part, no view of it; its open Decisions were withdrawn and its Hill keys forgotten.
    const reply = await r.service.reply(undefined);
    expect(reply.tricks.map((t) => t.id)).not.toContain("legs");
    expect(reply.parts.filter((p) => p.trick === "legs")).toEqual([]);
    expect(r.views.all().filter((v) => v.trick === "legs")).toEqual([]);
    expect(r.forgot).toEqual(["legs"]);
    expect(r.offs).toContain("legs");
    // An official trick of that id is an entry a person can add again.
    expect((await officialWire(r.configDir, [entry]))[0]?.state).toBe("absent");
    // The record: who, what; never content of the trick.
    expect(r.audits.filter((a) => a.action === "trick.remove")).toEqual([{ action: "trick.remove", device: "pixel-8", detail: { trick: "legs" } }]);
    const file = parseJsonObject(await readFile(join(tricksStateDir(r.stateDir), REMOVE_RECEIPTS_FILE), "utf8"));
    const list = Array.isArray(file?.receipts) ? file.receipts : [];
    expect(list).toHaveLength(1);
    const stored = asJsonObject(list[0]) ?? {};
    expect(Object.keys(stored).toSorted()).toEqual(["at", "device", "outcome", "payloadDigest", "pending", "requestId", "trick", "v"]);
    expect({ trick: stored.trick, device: stored.device, outcome: stored.outcome, pending: stored.pending }).toEqual({ trick: "legs", device: "pixel-8", outcome: "removed", pending: false });
  });

  test("a trick that is on is refused with the reason the app shows, and nothing is deleted", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await makeTrick(r);
    await switchOn(r);
    await tick(r);
    expect(await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).toEqual({ status: 409, body: { error: "on", message: REMOVE_ON_LINE, rid: RID } });
    await kept(r, dir);
    expect(r.audits.filter((a) => a.action === "trick.remove")).toEqual([]);
    expect((await r.service.reply(undefined)).tricks.find((t) => t.id === "legs")?.on).toBe(true);
  });

  test("a run still going after the switch went off is refused and deletes nothing; once it ended a new request removes", async () => {
    let release: () => void = () => {};
    const slow: Scripted = { later: () => new Promise((resolve) => (release = () => resolve(exited(belt("1"))))) };
    const r = await rig([slow]);
    const dir = await makeTrick(r);
    await switchOn(r);
    r.service.noteWatched();
    await r.service.refresh(true);
    const going = r.service.tick();
    await Bun.sleep(30);
    expect(r.specs).toHaveLength(1);
    // Off does not stop the run that goes (service.ts `applyOne`): its tokens die, the program runs to its end.
    expect((await r.service.setSwitch(HOST, "legs", false)).status).toBe(200);
    expect(await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).toEqual({ status: 409, body: { error: "running", message: REMOVE_RUNNING_LINE, rid: RID } });
    await kept(r, dir);
    expect(await exists(approvedTrickDir(r.configDir, "legs"))).toBe(true);
    release();
    await going;
    await r.service.idle();
    // The same request id answers its first answer again; a new confirm (a new id) removes.
    expect((await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).status).toBe(409);
    await kept(r, dir);
    expect((await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID2 })).status).toBe(200);
    expect(await exists(dir)).toBe(false);
  });

  test("no run starts for an off trick between the check and the rename: the timer, a tap and a start run read the switch first", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await ranAndOff(r);
    const runs = r.specs.length;
    // Every way a run begins, asked while the trick is off and while the remove runs: none starts a program.
    r.clock.t = T0 + 3_600_000;
    const removing = post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID });
    const ticking = r.service.tick();
    const tapping = r.service.tap(HOST, "legs", { rid: RID3, node: "belt", intent: "x" });
    const [removed] = await Promise.all([removing, ticking, tapping]);
    expect(removed.status).toBe(200);
    expect(r.specs.length).toBe(runs);
    expect(await exists(dir)).toBe(false);
  });

  test("a replay of the request id answers the first answer and never touches a new trick of the same id, also after a restart", async () => {
    const r = await rig([exited(belt("1"))]);
    await ranAndOff(r);
    const first = await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID });
    expect(first.status).toBe(200);
    // A different trick, added later under the same id.
    const fresh = await makeTrick(r);
    await r.service.refresh(true);
    expect(await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).toEqual(first);
    expect(await exists(join(fresh, "trick.toml"))).toBe(true);
    // The bridge restarts: the receipt is on disk, the answer is the same, and the new trick stays.
    const again = await rig([exited(belt("1"))], {}, { configDir: r.configDir, stateDir: r.stateDir });
    await again.service.refresh(true);
    expect(await post(again, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).toEqual(first);
    expect(await exists(join(fresh, "trick.toml"))).toBe(true);
    expect(again.audits.filter((a) => a.action === "trick.remove")).toEqual([]);
    // The same id for another trick is refused.
    expect(await post(again, `/api/tricks/${HOST}/other/remove`, { rid: RID })).toEqual({ status: 409, body: { error: "request-id-reused", rid: RID } });
  });

  test("two requests with the same id at once remove once", async () => {
    const r = await rig([exited(belt("1"))]);
    await ranAndOff(r);
    const [a, b] = await Promise.all([post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID }), post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })]);
    expect(a).toEqual(b);
    expect(a.status).toBe(200);
    expect(r.audits.filter((x) => x.action === "trick.remove")).toHaveLength(1);
  });

  test("a bridge that stopped mid-remove answers unknown for that id and removes nothing", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await ranAndOff(r);
    await writeFile(join(tricksStateDir(r.stateDir), REMOVE_RECEIPTS_FILE), JSON.stringify({ receipts: [{ requestId: RID, payloadDigest: payloadDigest(["remove", "legs"]), at: T0, trick: "legs", device: "pixel-8", pending: true, outcome: null }] }));
    const again = await rig([exited(belt("1"))], {}, { configDir: r.configDir, stateDir: r.stateDir });
    await again.service.refresh(true);
    expect(await post(again, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).toEqual({ status: 409, body: { error: "unknown", message: REMOVE_UNKNOWN_LINE, rid: RID } });
    await kept(r, dir);
  });

  test("a record of a later version or with an outcome this build does not know is kept and never acts", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await ranAndOff(r);
    const digest = payloadDigest(["remove", "legs"]);
    const later = { v: 2, requestId: RID, payloadDigest: digest, at: T0, trick: "legs", device: "pixel-8", pending: false, outcome: "removed" };
    const strange = { v: 1, requestId: RID2, payloadDigest: digest, at: T0, trick: "legs", device: "pixel-8", pending: false, outcome: "archived" };
    const file = join(tricksStateDir(r.stateDir), REMOVE_RECEIPTS_FILE);
    await writeFile(file, JSON.stringify({ receipts: [later, strange] }));
    const again = await rig([exited(belt("1"))], {}, { configDir: r.configDir, stateDir: r.stateDir });
    await again.service.refresh(true);
    for (const rid of [RID, RID2]) expect(await post(again, `/api/tricks/${HOST}/legs/remove`, { rid })).toEqual({ status: 409, body: { error: "unknown", message: REMOVE_UNKNOWN_LINE, rid } });
    await kept(r, dir);
    // A new remove writes the file again: both records are still there, whole.
    expect((await post(again, `/api/tricks/${HOST}/legs/remove`, { rid: RID3 })).status).toBe(200);
    const held = parseJsonObject(await readFile(file, "utf8"))?.receipts;
    const rows = Array.isArray(held) ? held : [];
    expect(rows.map((row) => asJsonObject(row)?.outcome)).toEqual(expect.arrayContaining(["removed", "archived"]));
    expect(rows.find((row) => asJsonObject(row)?.requestId === RID3) !== undefined).toBe(true);
    expect(asJsonObject(rows.find((row) => asJsonObject(row)?.requestId === RID) ?? null)?.v).toBe(2);
  });

  test("the audit line of a remove stays one line whatever the device label holds", async () => {
    const lines: string[] = [];
    const log = new AuditLog((line) => void lines.push(line), { now: () => T0 });
    const r = await rig([exited(belt("1"))], { audit: (entry) => log.record({ action: entry.action, device: entry.device ?? null, detail: entry.detail }) });
    await ranAndOff(r);
    const label = "pixel\n{\"action\":\"trick.remove\"}\r\u0007\u001b[31m\u2028x";
    expect((await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID }, label)).status).toBe(200);
    await Bun.sleep(10);
    const removes = lines.filter((line) => line.includes("trick.remove"));
    expect(removes).toHaveLength(1);
    const one = removes[0] ?? "";
    // One line, ended once, with no raw control character in it; the label reads back as it was sent.
    expect(one.endsWith("\n")).toBe(true);
    expect(Array.from(one.slice(0, -1)).filter((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)).toEqual([]);
    expect(one.slice(0, -1).split("\n")).toHaveLength(1);
    expect(parseJsonObject(one.slice(0, -1))?.device).toBe(label);
  });

  test("a scan drops the views of a trick id with no folder, and writes nothing when there is none", async () => {
    let pruned = 0;
    const r = await rig([exited(belt("1"))], {
      pruneTrickStores: (present) => {
        for (const view of r.views.all()) if (!present.has(view.trick)) pruned += r.views.dropTrick(view.trick);
      },
    });
    await makeTrick(r);
    // A view of `ghost`, whose folder is gone (a remove that crashed after its commit), and one of `legs`.
    r.views.put(viewEntry({ trick: "ghost", session: `${HOST}/w6X:3`, on: true, shows: 0, changedAt: 1 }));
    r.views.put(viewEntry({ trick: "legs", session: `${HOST}/w6X:3`, on: true, shows: 0, changedAt: 1 }));
    await r.service.refresh(true);
    expect(r.views.all().map((v) => v.trick)).toEqual(["legs"]);
    expect(pruned).toBe(1);
    await r.service.refresh(true);
    expect(pruned).toBe(1);
  });

  test("a broken trick is on the list and is removed: a bad trick.toml, a refused right, a missing file", async () => {
    // ADR 0168, the lead's security read, point 3: a scan keeps a refused folder as a found trick with its refusals,
    // so it has a runtime, a row on the list and a details page, and the route resolves it like any other.
    const r = await rig([exited(belt("1"))]);
    const broken: [string, string][] = [
      ["bad-toml", 'id = "bad-toml"\nname = "Bad\n'],
      ["bad-right", 'id = "bad-right"\nname = "Bad right"\nrun = "./legs.sh"\nplaces = ["belt"]\naccess = "everything"\n'],
      ["no-file", 'id = "no-file"\nname = "No file"\nrun = "./gone.sh"\nplaces = ["belt"]\n'],
    ];
    const folders: string[] = [];
    for (const [id, manifest] of broken) folders.push(await makeTrick(r, id, manifest));
    await r.service.refresh(true);
    const before = await r.service.reply(undefined);
    for (const [id] of broken) {
      const row = before.tricks.find((t) => t.id === id);
      // Listed, so the app has its details page and its Remove.
      expect(row?.host).toBe(HOST);
      expect(row?.on).toBe(false);
      // A folder the scan refuses is listed as skipped; a missing run file is found only at a run.
      expect(row?.state).toBe(id === "no-file" ? "off" : "skipped");
    }
    const asks: [string, string][] = [
      ["bad-toml", RID],
      ["bad-right", RID2],
      ["no-file", RID3],
    ];
    for (const [id, rid] of asks) expect(await post(r, `/api/tricks/${HOST}/${id}/remove`, { rid })).toEqual({ status: 200, body: { rid, code: "removed", id } });
    for (const dir of folders) expect(await exists(dir)).toBe(false);
    expect((await r.service.reply(undefined)).tricks).toEqual([]);
  });

  test("a receipt that cannot be written removes nothing", async () => {
    const r = await rig([exited(belt("1"))], { removeReceipts: memoryRemoveReceipts({ failFirst: true }) });
    const dir = await ranAndOff(r);
    expect((await post(r, `/api/tricks/${HOST}/legs/remove`, { rid: RID })).status).toBe(503);
    await kept(r, dir);
  });

  test("an id that is no trick, a path, an encoded slash, another host or a stray field is refused and deletes nothing", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await ranAndOff(r);
    for (const path of [`/api/tricks/${HOST}/nope/remove`, `/api/tricks/${HOST}/..%2Flegs/remove`, `/api/tricks/${HOST}/legs%2F..%2Flegs/remove`, `/api/tricks/${HOST}/%2Fetc/remove`, `/api/tricks/${HOST}/.collie-approved/remove`, `/api/tricks/${HOST}/%E0%A4%A/remove`]) {
      expect({ path, status: (await post(r, path, { rid: RID3 })).status }).toEqual({ path, status: 404 });
    }
    expect((await post(r, `/api/tricks/elsewhere/legs/remove`, { rid: RID2 })).body).toEqual({ error: "unknown-host" });
    for (const body of [undefined, null, [], {}, { rid: "not-a-uuid" }, { rid: RID2, id: "legs" }, { rid: 3 }]) {
      expect((await post(r, `/api/tricks/${HOST}/legs/remove`, body)).status).toBe(400);
    }
    await kept(r, dir);
    expect(r.audits.filter((a) => a.action === "trick.remove")).toEqual([]);
  });

  test("the route asks the write right and is a POST only (by source); a trick's program gets no bridge credential", async () => {
    expect(TRICKS_ROUTE_RIGHTS.remove).toBe("write");
    const src = await readFile(join(import.meta.dir, "..", "server.ts"), "utf8");
    const at = src.indexOf("const tricksRemove = TRICKS_REMOVE_ROUTE.exec(pathname);");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 600);
    expect(block).toContain('if (tricksRemove !== null && req.method === "POST")');
    expect(block).toContain("guard(req, cfg, TRICKS_ROUTE_RIGHTS.remove, pairingGate)");
    // Rule 8: the program's environment holds no COLLIE_ name and no token of the bridge (env.ts), so it holds
    // nothing the gate takes for a write.
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r);
    await switchOn(r);
    await tick(r);
    const env = r.specs[0]?.env ?? {};
    expect(Object.keys(env).filter((name) => name.startsWith("COLLIE_") || name.startsWith("HERDR_"))).toEqual([]);
    expect(Object.values(env)).not.toContain("tok-placeholder");
  });
});

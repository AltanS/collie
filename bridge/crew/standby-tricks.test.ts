import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import { createTrickScanner } from "../tricks/discover.ts";
import { switchesPath, tricksConfigDir } from "../tricks/paths.ts";
import { parseSwitches } from "../tricks/switches.ts";
import { carryAll, machine, PNG, putOnTrick, removeCarryDirs } from "./carry-fixtures.ts";
import { codeParts, leadTricks, readStateFiles } from "./standby-tricks-lead.ts";
import {
  CARRIED_TRICKS_MAX,
  CARRY_PART_BYTES,
  checkCarriedFiles,
  parseCarriedTrick,
  parseCodePart,
  parseStatePush,
  parseTricksList,
  parseTricksReport,
  StandbyTricksStore,
  statePathProblem,
  tricksCopyKept,
  tricksDigest,
  tricksReportFields,
  type CarriedTrick,
} from "./standby-tricks.ts";

afterAll(removeCarryDirs);

const HASH = "a".repeat(64);

function trick(over: Partial<CarriedTrick> = {}): CarriedTrick {
  return {
    id: "legs",
    hash: HASH,
    auto: false,
    at: "2026-11-10T10:00:00.000Z",
    by: "phone",
    powers: null,
    config: null,
    origin: null,
    files: [{ rel: "trick.toml", size: 10, x: false }],
    state: null,
    ...over,
  };
}

/** A trick as it crosses the wire: plain JSON. */
function wire(t: CarriedTrick): JsonObject {
  return { ...t, files: t.files.map((f) => ({ rel: f.rel, size: f.size, x: f.x })) };
}

const ROLE = { crewId: "crew-1", leads: false, leadMemberId: "desk", deputy: true };

describe("reading the wire", () => {
  test("a clean trick reads, and every field is checked", () => {
    expect(parseCarriedTrick(wire(trick()))).toEqual(trick());
    const bent: JsonObject[] = [
      { ...wire(trick()), id: "../etc" },
      { ...wire(trick()), hash: "short" },
      { ...wire(trick()), powers: "zz" },
      { ...wire(trick()), config: "not base64!" },
      { ...wire(trick()), state: "nope" },
      { ...wire(trick()), at: "line‮break" },
      { ...wire(trick()), origin: "x".repeat(9000) },
      { ...wire(trick()), files: [] },
    ];
    for (const b of bent) expect(parseCarriedTrick(b)).toBeNull();
  });

  test("a code file name that climbs, hides or doubles is refused", () => {
    const files = (...rels: string[]) => [{ rel: "trick.toml", size: 1, x: false }, ...rels.map((rel) => ({ rel, size: 1, x: false }))];
    expect(checkCarriedFiles(files("lib/a.ts"))).toBeNull();
    for (const bad of ["../a.ts", "/etc/passwd", "lib/../../a.ts", ".env", "a\\b.ts", "c:x.ts", "inputs/a.ts", "media/a.ts", "a.log"]) {
      expect(checkCarriedFiles(files(bad))).not.toBeNull();
    }
    // Twins once case and Unicode form are set aside, and a name used as a file and as a folder.
    expect(checkCarriedFiles(files("Lib/a.ts", "lib/b.ts"))).not.toBeNull();
    expect(checkCarriedFiles(files("a.ts", "A.ts"))).not.toBeNull();
    expect(checkCarriedFiles(files("x.ts", "x.ts/y.ts"))).not.toBeNull();
    expect(checkCarriedFiles([{ rel: "p.ts", size: 1, x: false }])).toBe("there is no trick.toml");
  });

  test("a list holds at most the cap and no repeated id; seq is a positive integer", () => {
    expect(parseTricksList({ seq: 1, tricks: [wire(trick())] })?.tricks.length).toBe(1);
    expect(parseTricksList({ seq: 0, tricks: [] })).toBeNull();
    expect(parseTricksList({ seq: 1, tricks: [wire(trick()), wire(trick())] })).toBeNull();
    const many = Array.from({ length: CARRIED_TRICKS_MAX + 1 }, (_, i) => wire(trick({ id: `t${String(i)}` })));
    expect(parseTricksList({ seq: 1, tricks: many })).toBeNull();
  });

  test("a code part is bounded and well formed", () => {
    const b64 = Buffer.from("hi").toString("base64");
    expect(parseCodePart({ id: "legs", hash: HASH, part: 0, parts: 1, chunks: [{ rel: "trick.toml", at: 0, b64 }] })).not.toBeNull();
    expect(parseCodePart({ id: "legs", hash: HASH, part: 1, parts: 1, chunks: [] })).toBeNull();
    expect(parseCodePart({ id: "legs", hash: HASH, part: 0, parts: 1, chunks: [{ rel: "trick.toml", at: -1, b64 }] })).toBeNull();
    const big = Buffer.alloc(CARRY_PART_BYTES + 1).toString("base64");
    expect(parseCodePart({ id: "legs", hash: HASH, part: 0, parts: 1, chunks: [{ rel: "trick.toml", at: 0, b64: big }] })).toBeNull();
  });

  test("a state path sits under state/, media/ or captures/, and a picture must be one", () => {
    expect(statePathProblem("state/notes.json")).toBeNull();
    expect(statePathProblem("media/logo.png")).toBeNull();
    for (const bad of ["notes.json", "inputs/a.png", "state/../x", "state/.hidden", "media/run.sh", "state/"]) expect(statePathProblem(bad)).not.toBeNull();
    const png = Buffer.from(PNG).toString("base64");
    const text = Buffer.from("not a picture").toString("base64");
    expect(parseStatePush({ id: "legs", digest: HASH, files: [{ rel: "media/a.png", b64: png }] })).not.toBeNull();
    expect(parseStatePush({ id: "legs", digest: HASH, files: [{ rel: "media/a.png", b64: text }] })).toBeNull();
    // A file and a folder of one name, and twins that fold to one name.
    expect(parseStatePush({ id: "legs", digest: HASH, files: [{ rel: "state/a", b64: text }, { rel: "state/a/b", b64: text }] })).toBeNull();
    expect(parseStatePush({ id: "legs", digest: HASH, files: [{ rel: "state/A", b64: text }, { rel: "state/a", b64: text }] })).toBeNull();
  });

  test("the report reads back off a hello body, and no report is no field at all", () => {
    expect(tricksReportFields(null)).toEqual({});
    const fields = tricksReportFields({ digest: HASH, seq: 7, need: 2 });
    expect(parseTricksReport(fields)).toEqual({ digest: HASH, seq: 7, need: 2 });
    expect(parseTricksReport({})).toBeNull();
  });
});

describe("the deputy's store", () => {
  test("a lead's ON trick lands whole: code checked, state kept, nothing executable, folders 0700", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", name: "Leg day", auto: true, files: { "lib/a.ts": "export const a = 1;\n", "config.toml": "token = 'sk-placeholder'\n" }, state: { "notes.json": "{}\n" } });
    const deputy = await machine("deputy");
    const store = new StandbyTricksStore(deputy.stateDir);
    await carryAll(lead, store);
    const report = store.report();
    expect(report?.need).toBe(0);
    const ready = await store.ready();
    expect(ready.map((r) => [r.trick.id, r.name, r.trick.auto])).toEqual([["legs", "Leg day", true]]);
    expect(await readFile(join(ready[0]?.codeDir ?? "", "lib", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await readFile(join(ready[0]?.heldState ?? "", "state", "notes.json"), "utf8")).toBe("{}\n");
    // The x bit rides the index, never the disk.
    expect(ready[0]?.trick.files.find((f) => f.rel === "p.sh")?.x).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(join(ready[0]?.codeDir ?? "", "p.sh"))).mode & 0o777).toBe(0o600);
      expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.dir, "index.json"))).mode & 0o777).toBe(0o600);
    }
    // The digest the deputy reports is the one the lead computes over what it would send.
    const tricks = await leadTricks(lead.stateDir, lead.configDir);
    expect(report?.digest).toBe(tricksDigest(tricks.map((t) => t.trick)));
  });

  test("the copy is invisible to the tricks loader and names no switch, before and after a restart", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const deputy = await machine("deputy");
    await mkdir(tricksConfigDir(deputy.configDir), { recursive: true });
    await carryAll(lead, new StandbyTricksStore(deputy.stateDir));
    for (const store of [new StandbyTricksStore(deputy.stateDir), new StandbyTricksStore(deputy.stateDir)]) {
      expect((await store.ready()).length).toBe(1);
      const scan = await createTrickScanner(tricksConfigDir(deputy.configDir)).scan();
      expect(scan.tricks.map((t) => t.id)).toEqual([]);
      const switches = parseSwitches(await readFile(switchesPath(deputy.stateDir), "utf8").catch(() => null));
      expect([...switches.switches.on.keys()]).toEqual([]);
    }
  });

  test("an older list from the same lead is refused, so a late push never rolls a trick back", async () => {
    const deputy = await machine("deputy");
    const store = new StandbyTricksStore(deputy.stateDir);
    expect((await store.applyList({ from: "desk", crewId: "crew-1", seq: 5, tricks: [trick()] })).ok).toBe(true);
    expect(await store.applyList({ from: "desk", crewId: "crew-1", seq: 5, tricks: [] })).toEqual({ ok: false, code: "stale" });
    expect(await store.applyList({ from: "desk", crewId: "crew-1", seq: 4, tricks: [] })).toEqual({ ok: false, code: "stale" });
    expect(store.report()?.seq).toBe(5);
    // The same seq read back after a restart still refuses.
    const again = new StandbyTricksStore(deputy.stateDir);
    expect(await again.applyList({ from: "desk", crewId: "crew-1", seq: 5, tricks: [] })).toEqual({ ok: false, code: "stale" });
  });

  test("code whose bytes do not hash to the approved hash is refused for good, and nothing is held", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const [lt] = await leadTricks(lead.stateDir, lead.configDir);
    if (lt === undefined) throw new Error("no trick");
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    await store.applyList({ from: "desk", crewId: "crew-1", seq: 1, tricks: [lt.trick] });
    const parts = (await codeParts(lt.copyDir, lt.trick.files)) ?? [];
    // Same sizes, one byte flipped.
    const bent = parts.map((p) => p.map((c) => ({ ...c, bytes: c.rel === "p.sh" ? new Uint8Array(c.bytes.map((b, i) => (i === 0 ? b ^ 1 : b))) : c.bytes })));
    const done = await store.applyCodePart({ id: lt.trick.id, hash: lt.trick.hash, part: 0, parts: bent.length, chunks: bent[0] ?? [] });
    expect(done).toMatchObject({ ok: false, code: "mismatch" });
    expect(await store.ready()).toEqual([]);
    expect(store.report()?.need).toBe(0);
    expect((await readdir(store.dir)).filter((n) => n.startsWith(".stage-"))).toEqual([]);
  });

  test("parts come in order and continue their file exactly; a part naming another file is refused", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const [lt] = await leadTricks(lead.stateDir, lead.configDir);
    if (lt === undefined) throw new Error("no trick");
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    await store.applyList({ from: "desk", crewId: "crew-1", seq: 1, tricks: [lt.trick] });
    const chunks = (await codeParts(lt.copyDir, lt.trick.files))?.[0] ?? [];
    expect(await store.applyCodePart({ id: "legs", hash: lt.trick.hash, part: 1, parts: 2, chunks })).toMatchObject({ ok: false, code: "order" });
    expect(await store.applyCodePart({ id: "legs", hash: lt.trick.hash, part: 0, parts: 1, chunks: [{ rel: "evil.ts", at: 0, bytes: new Uint8Array([1]) }] })).toMatchObject({ ok: false, code: "bad_part" });
    const skewed = chunks.map((c) => ({ ...c, at: c.at + 1 }));
    expect(await store.applyCodePart({ id: "legs", hash: lt.trick.hash, part: 0, parts: 1, chunks: skewed })).toMatchObject({ ok: false, code: "bad_part" });
    expect(await store.applyCodePart({ id: "legs", hash: "b".repeat(64), part: 0, parts: 1, chunks })).toMatchObject({ ok: false, code: "unknown" });
    // And the honest parts still land after all that.
    expect(await store.applyCodePart({ id: "legs", hash: lt.trick.hash, part: 0, parts: 1, chunks })).toEqual({ ok: true, held: true });
  });

  test("a list that changes a trick's hash drops the stage of the old one: no stage piles up (review 7 R3)", async () => {
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    const stages = async () => (await readdir(store.dir)).filter((name) => name.startsWith(".stage-"));
    const big = 3 * 1024 * 1024;
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const hash = String(cycle).repeat(64);
      const t = trick({ hash, files: [{ rel: "data.ts", size: big, x: false }] });
      expect((await store.applyList({ from: "desk", crewId: "crew-1", seq: cycle, tricks: [t] })).ok).toBe(true);
      // Part 0 of 2 lands, then the next list names a new hash before part 1.
      expect(await store.applyCodePart({ id: "legs", hash, part: 0, parts: 2, chunks: [{ rel: "data.ts", at: 0, bytes: new Uint8Array(CARRY_PART_BYTES) }] })).toEqual({ ok: true, held: false });
      expect((await stages()).length).toBe(1);
    }
    await store.applyList({ from: "desk", crewId: "crew-1", seq: 6, tricks: [] });
    expect(await stages()).toEqual([]);
  });

  test("a big trick goes in parts under the body cap, and lands whole", async () => {
    const lead = await machine("lead");
    const blob = new Uint8Array(CARRY_PART_BYTES + 1000).fill(65);
    await putOnTrick(lead, { id: "big", files: { "data/blob.ts": blob } });
    const [lt] = await leadTricks(lead.stateDir, lead.configDir);
    if (lt === undefined) throw new Error("no trick");
    const parts = (await codeParts(lt.copyDir, lt.trick.files)) ?? [];
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.reduce((n, c) => n + c.bytes.length, 0)).toBeLessThanOrEqual(CARRY_PART_BYTES);
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    await carryAll(lead, store);
    expect((await store.ready()).map((r) => r.trick.id)).toEqual(["big"]);
  });

  test("state lands at most once a minute per trick, and an oversize state is settled, not owed", async () => {
    let now = 1_000_000;
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", state: { "a.json": "1\n" } });
    const [lt] = await leadTricks(lead.stateDir, lead.configDir);
    if (lt === undefined || lt.trick.state === null) throw new Error("no state");
    const store = new StandbyTricksStore((await machine("deputy")).stateDir, () => now);
    await store.applyList({ from: "desk", crewId: "crew-1", seq: 1, tricks: [lt.trick] });
    const files = await readStateFiles(lt.state);
    expect(await store.applyState({ id: "legs", digest: lt.trick.state, files })).toEqual({ ok: true });
    expect(await store.applyState({ id: "legs", digest: lt.trick.state, files })).toMatchObject({ ok: false, code: "rate" });
    now += 60_000;
    const huge = [{ rel: "state/big.bin", bytes: new Uint8Array(4 * 1024 * 1024 + 1) }];
    expect(await store.applyState({ id: "legs", digest: lt.trick.state, files: huge })).toMatchObject({ ok: false, code: "too_large" });
    expect(store.report()?.need).toBe(1);
    expect(await store.applyState({ id: "nobody", digest: lt.trick.state, files })).toMatchObject({ ok: false, code: "unknown" });
  });
});

describe("whose copy it is", () => {
  test("kept only while this machine is the named deputy of the lead that sent it, in that crew", () => {
    const index = { crewId: "crew-1", from: "desk" };
    expect(tricksCopyKept(index, ROLE)).toBe(true);
    expect(tricksCopyKept(index, { ...ROLE, deputy: false })).toBe(false);
    expect(tricksCopyKept(index, { ...ROLE, leads: true })).toBe(false);
    expect(tricksCopyKept(index, { ...ROLE, leadMemberId: "attic" })).toBe(false);
    expect(tricksCopyKept(index, { ...ROLE, crewId: "crew-2" })).toBe(false);
    expect(tricksCopyKept(index, { ...ROLE, crewId: null })).toBe(false);
  });

  test("a demotion removes the whole copy from the disk, the config.toml with its secrets included", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", files: { "config.toml": "token = 'sk-placeholder'\n" } });
    const deputy = await machine("deputy");
    const store = new StandbyTricksStore(deputy.stateDir);
    await carryAll(lead, store);
    expect(await store.reconcile(ROLE)).toBe(false);
    expect(await store.reconcile({ ...ROLE, deputy: false })).toBe(true);
    expect(await readdir(deputy.stateDir)).not.toContain("standby-tricks");
    expect(await store.ready()).toEqual([]);
  });

  test("a hold keeps the copy through a role change while the tap adopts it", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    await carryAll(lead, store);
    const release = await store.hold();
    expect(await store.reconcile({ ...ROLE, leads: true })).toBe(false);
    expect((await store.ready()).length).toBe(1);
    release();
    expect(await store.reconcile({ ...ROLE, leads: true })).toBe(true);
  });

  test("a folder with no index that reads is removed unless a copy may be on its way", async () => {
    const deputy = await machine("deputy");
    const store = new StandbyTricksStore(deputy.stateDir);
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, "index.json"), "{ torn");
    expect(await store.reconcile(ROLE)).toBe(false);
    expect(await new StandbyTricksStore(deputy.stateDir).reconcile({ ...ROLE, deputy: false })).toBe(true);
  });
});

describe("the lead's half", () => {
  test("only ON tricks with an approved copy go, from the approved copy, with config, origin and pictures", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", files: { "config.toml": "rows = 3\n", "media/logo.png": PNG } });
    // A live edit after approval: the deputy carries what was approved, not what is on the disk now.
    await writeFile(join(tricksConfigDir(lead.configDir), "legs", "p.sh"), "#!/bin/sh\necho edited\n");
    const [lt] = await leadTricks(lead.stateDir, lead.configDir);
    expect(lt?.trick.config).toBe(Buffer.from("rows = 3\n").toString("base64"));
    expect(lt?.state.map((s) => s.rel)).toEqual(["media/logo.png"]);
    const parts = (await codeParts(lt?.copyDir ?? "", lt?.trick.files ?? [])) ?? [];
    const sh = parts.flat().find((c) => c.rel === "p.sh");
    expect(new TextDecoder().decode(sh?.bytes)).toBe("#!/bin/sh\necho 1\n");
  });

  test("an OFF trick, or a switch with no approved hash, carries nothing", async () => {
    const lead = await machine("lead");
    expect(await leadTricks(lead.stateDir, lead.configDir)).toEqual([]);
    await mkdir(join(lead.stateDir, "tricks"), { recursive: true });
    await writeFile(switchesPath(lead.stateDir), JSON.stringify({ version: 3, on: { legs: { at: "x", hash: null, auto: false, by: "cli", powers: null } } }));
    expect(await leadTricks(lead.stateDir, lead.configDir)).toEqual([]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { JsonValue } from "../json.ts";
import { decision } from "../hill/fixtures.ts";
import { hillDir, HillStore } from "../hill/store.ts";
import { switchesPath } from "../tricks/paths.ts";
import { ADOPT_MARKER_FILE, adoptAtBoot, carriedSeen, holdCopies, holdForTap, readAdoptMarker, writeAdoptMarker, type BootAdoptDeps } from "./carry-boot.ts";
import { carryAll, machine, putOnTrick, removeCarryDirs } from "./carry-fixtures.ts";
import { hillCarryRoutes, tricksCarryRoutes } from "./carry-surface.ts";
import { CREW_HILL_COPY_PATH, CREW_TRICKS_COPY_PATH } from "./router.ts";
import { parseHillList, StandbyHillStore } from "./standby-hill.ts";
import { StandbyTricksStore } from "./standby-tricks.ts";

afterAll(removeCarryDirs);

const ROLE = { crewId: "crew-1", leads: false, leadMemberId: "desk", deputy: true };
const LEADS = { crewId: "crew-1", leads: true, leadMemberId: null, deputy: false };

/** A deputy holding a copy of `desk`'s tricks and of one open Decision. */
async function deputyWithCopies() {
  const lead = await machine("lead");
  await putOnTrick(lead, { id: "legs", name: "Leg day" });
  const deputy = await machine("deputy");
  const tricks = new StandbyTricksStore(deputy.stateDir);
  await carryAll(lead, tricks, { crewId: "crew-1" });
  const hill = new StandbyHillStore(deputy.stateDir);
  // SAFETY: a JSON round trip.
  const record = JSON.parse(JSON.stringify(decision("dc_carried00001"))) as JsonValue;
  const list = parseHillList({ seq: 1, on: true, decisions: [record], closed: [], tricks: {} });
  if (list === null) throw new Error("bad list");
  await hill.applyList({ from: "desk", crewId: "crew-1", list });
  return { deputy, tricks, hill };
}

describe("the takeover commit holds both copies (§25)", () => {
  test("a role change in the middle of the commit removes neither copy; after it, both go", async () => {
    const { tricks, hill } = await deputyWithCopies();
    expect(await tricks.reconcile(ROLE)).toBe(false);
    const release = await holdCopies([tricks, hill]);
    // The commit made this machine the lead; a membership change runs the reconcile now.
    expect(await tricks.reconcile(LEADS)).toBe(false);
    expect(await hill.reconcile(LEADS)).toBe(false);
    expect(await hill.openCount()).toBe(1);
    release();
    release();
    expect(await hill.reconcile(LEADS)).toBe(true);
    expect(await tricks.reconcile(LEADS)).toBe(true);
  });
});

describe("what the page showed is what the tap takes (§25)", () => {
  test("the mark changes with a new list of either copy, and not without one", async () => {
    const { tricks, hill } = await deputyWithCopies();
    const first = carriedSeen(tricks, hill);
    expect(carriedSeen(tricks, hill)).toBe(first);
    const list = parseHillList({ seq: 2, on: true, decisions: [], closed: ["dc_carried00001"], tricks: {} });
    if (list === null) throw new Error("bad list");
    await hill.applyList({ from: "desk", crewId: "crew-1", list });
    expect(carriedSeen(tricks, hill)).not.toBe(first);
    expect(carriedSeen(null, null)).toBe(carriedSeen(null, null));
  });

  test("a list in flight when the tap holds lands before the hold answers; one after it is refused (review 7 R5)", async () => {
    const { tricks, hill } = await deputyWithCopies();
    const ctx = { from: "desk", crewId: "crew-1" };
    const before = carriedSeen(tricks, hill);
    // The lead's list starts its write, and the tap asks for the hold while it runs.
    const inFlight = hillCarryRoutes(hill).handle(CREW_HILL_COPY_PATH, ctx, { seq: 7, on: true, decisions: [], closed: ["dc_carried00001"], tricks: {} });
    // Its turn starts (a few microtasks), and it is writing to the disk when the hold is asked.
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
    const release = await holdCopies([tricks, hill]);
    const atHold = carriedSeen(tricks, hill);
    expect(atHold).not.toBe(before);
    expect((await inFlight)?.status).toBe(200);
    // Nothing moves the copies after the hold: what the tap reads now is what it adopts.
    const after = await tricksCarryRoutes(tricks).handle(CREW_TRICKS_COPY_PATH, ctx, { seq: 9, tricks: [] });
    expect(after?.body).toMatchObject({ code: "held" });
    expect(carriedSeen(tricks, hill)).toBe(atHold);
    release();
  });

  test("the tap's hold reads the mark again: a list that landed after the door's check refuses the tap and lets go (review 7 R5)", async () => {
    const { tricks, hill } = await deputyWithCopies();
    const shown = carriedSeen(tricks, hill);
    const mark = () => carriedSeen(tricks, hill);
    const kept = await holdForTap([tricks, hill], shown, mark);
    expect(kept).not.toBeNull();
    expect(tricks.held()).toBe(true);
    kept?.();
    expect(tricks.held()).toBe(false);
    // A list lands between the door's check and the hold.
    const list = parseHillList({ seq: 3, on: true, decisions: [], closed: ["dc_carried00001"], tricks: {} });
    if (list === null) throw new Error("bad list");
    await hill.applyList({ from: "desk", crewId: "crew-1", list });
    expect(await holdForTap([tricks, hill], shown, mark)).toBeNull();
    expect([tricks.held(), hill.held()]).toEqual([false, false]);
  });

  test("while the tap holds the copies, neither takes a list from the lead", async () => {
    const { tricks, hill } = await deputyWithCopies();
    const before = carriedSeen(tricks, hill);
    const release = await holdCopies([tricks, hill]);
    const ctx = { from: "desk", crewId: "crew-1" };
    const hillAnswer = await hillCarryRoutes(hill).handle(CREW_HILL_COPY_PATH, ctx, { seq: 9, on: true, decisions: [], closed: [], tricks: {} });
    const tricksAnswer = await tricksCarryRoutes(tricks).handle(CREW_TRICKS_COPY_PATH, ctx, { seq: 9, tricks: [] });
    expect([hillAnswer?.status, tricksAnswer?.status]).toEqual([409, 409]);
    expect(hillAnswer?.body).toMatchObject({ code: "held" });
    expect(carriedSeen(tricks, hill)).toBe(before);
    release();
    expect((await hillCarryRoutes(hill).handle(CREW_HILL_COPY_PATH, ctx, { seq: 9, on: true, decisions: [], closed: [], tricks: {} }))?.status).toBe(200);
  });
});

describe("the boot after the tap adopts both copies (§25)", () => {
  const T0 = 1_762_000_000_000;
  function boot(c: Awaited<ReturnType<typeof deputyWithCopies>>, over: Partial<BootAdoptDeps> = {}) {
    const lines: AuditEntry[] = [];
    const deps: BootAdoptDeps = { stateDir: c.deputy.stateDir, configDir: c.deputy.configDir, tricks: c.tricks, hill: c.hill, leads: true, self: "laptop", machine: "laptop", now: () => T0, audit: (e) => void lines.push(e), log: () => {}, ...over };
    return { lines, run: () => adoptAtBoot(deps) };
  }

  test("no marker, nothing adopted: the copies wait, and nothing is written", async () => {
    const c = await deputyWithCopies();
    expect(await boot(c).run()).toBeNull();
    expect(await c.hill.openCount()).toBe(1);
    expect(existsSync(switchesPath(c.deputy.stateDir))).toBe(false);
  });

  test("the takeover's marker: the tricks start, the Decision lands, both copies and the marker go", async () => {
    const c = await deputyWithCopies();
    await writeAdoptMarker(c.deputy.stateDir, { lead: "desk", by: "takeover", at: T0 });
    const b = boot(c);
    const result = await b.run();
    expect(result?.tricks.started.map((t) => t.id)).toEqual(["legs"]);
    expect(result?.hill).toEqual({ open: 1, closed: 0, dropped: 0 });
    expect(new HillStore(hillDir(c.deputy.stateDir)).get("dc_carried00001")?.state).toBe("open");
    expect(b.lines.map((l) => [l.action, l.detail?.by])).toEqual([
      ["tricks.carried", "takeover"],
      ["hill.carried", "takeover"],
    ]);
    expect(await readAdoptMarker(c.deputy.stateDir)).toBeNull();
    expect(await new StandbyHillStore(c.deputy.stateDir).load()).toBeNull();
  });

  test("adopt once: a throw on the way leaves no marker, and the next boot switches nothing back on (review 7 R7)", async () => {
    const c = await deputyWithCopies();
    await writeAdoptMarker(c.deputy.stateDir, { lead: "desk", by: "takeover", at: T0 });
    const failing = boot(c, {
      audit: () => {
        throw new Error("the disk is full");
      },
    });
    await expect(failing.run()).rejects.toThrow("the disk is full");
    expect(existsSync(join(c.deputy.stateDir, ADOPT_MARKER_FILE))).toBe(false);
    // The person switches the started trick off; the next boot must not switch it back on.
    const switches = switchesPath(c.deputy.stateDir);
    expect(existsSync(switches)).toBe(true);
    await writeFile(switches, "{}\n");
    expect(await boot(c).run()).toBeNull();
    expect(await readFile(switches, "utf8")).toBe("{}\n");
  });

  test("a marker that names another lead than the copies' adopts nothing", async () => {
    const c = await deputyWithCopies();
    await writeAdoptMarker(c.deputy.stateDir, { lead: "attic", by: "takeover", at: T0 });
    const result = await boot(c).run();
    expect(result?.tricks.started).toEqual([]);
    expect(result?.hill).toEqual({ open: 0, closed: 0, dropped: 0 });
    expect(new HillStore(hillDir(c.deputy.stateDir)).all()).toEqual([]);
    expect(existsSync(switchesPath(c.deputy.stateDir))).toBe(false);
  });

  test("a boot that does not lead adopts nothing and drops the marker", async () => {
    const c = await deputyWithCopies();
    await writeAdoptMarker(c.deputy.stateDir, { lead: "desk", by: "handover", at: T0 });
    expect(await boot(c, { leads: false }).run()).toBeNull();
    expect(existsSync(join(c.deputy.stateDir, ADOPT_MARKER_FILE))).toBe(false);
    expect(new HillStore(hillDir(c.deputy.stateDir)).all()).toEqual([]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { JsonValue } from "../json.ts";
import { decision } from "../hill/fixtures.ts";
import { hillDir, HillStore } from "../hill/store.ts";
import { switchesPath } from "../tricks/paths.ts";
import { ADOPT_MARKER_FILE, adoptAtBoot, holdCopies, readAdoptMarker, writeAdoptMarker, type BootAdoptDeps } from "./carry-boot.ts";
import { carryAll, machine, putOnTrick, removeCarryDirs } from "./carry-fixtures.ts";
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
    const release = holdCopies([tricks, hill]);
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

import { afterAll, describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import { decision } from "../hill/fixtures.ts";
import { holdCopies } from "./carry-boot.ts";
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

import { afterAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { tricksStateDir } from "../tricks/paths.ts";
import { hillCollieRef } from "../../web/src/lib/hill/wire.ts";
import { TAKEOVER_NOTICES_FILE, writeCarryNotices } from "./carry-adopt.ts";
import { machine, removeCarryDirs } from "./carry-fixtures.ts";
import { answerCarried, carriedCard, parseCarryNotices, postCarryNotices } from "./carry-notices.ts";

afterAll(removeCarryDirs);

const T0 = 1_762_000_000_000;
const FAIL = { id: "legs", name: "Leg day", hash: "c".repeat(64), reason: "its copy on this machine does not match the version you approved" };

function hillOf(opts: { mode?: "lead" | "peer"; on?: boolean } = {}) {
  let n = 0;
  return new HillService({
    store: new HillStore(null, () => T0),
    receipts: memoryHillReceipts(),
    place: () => null,
    send: async () => "typed",
    crewMode: () => opts.mode ?? "lead",
    walkyOn: () => false,
    memberId: "laptop",
    machine: "laptop",
    now: () => T0,
    mintId: () => `dc_car${String((n += 1)).padStart(9, "0")}`,
    hillSwitch: { on: () => opts.on ?? true },
    onCollieAnswer: async (ref, intent) => (ref.type === "carried" ? answerCarried(intent) : { ok: false, reason: "no" }),
  });
}

describe("a carried trick that did not start is said on the Hill (§25)", () => {
  test("the next boot as lead posts one OK card per trick, and the file goes", async () => {
    const m = await machine("deputy");
    await writeCarryNotices(m.stateDir, "desk", T0, [FAIL]);
    const hill = hillOf();
    expect(await postCarryNotices({ stateDir: m.stateDir, hill, warn: () => {} })).toBe(1);
    const [card] = hill.collieDecisions("carried");
    expect(card?.title).toBe("The trick Leg day did not start after the takeover");
    expect(card?.summary).toBe("It ran on desk. Collie did not start it on this machine: its copy on this machine does not match the version you approved. Switch it on again in Settings → Tricks when you want it here.");
    expect(card?.options.map((o) => [o.intent, o.label])).toEqual([["ok", "OK"]]);
    expect(card?.from).toMatchObject({ kind: "collie", label: "Collie", ref: { type: "carried", id: "legs", hash: FAIL.hash } });
    expect(await readdir(tricksStateDir(m.stateDir))).not.toContain(TAKEOVER_NOTICES_FILE);
  });

  test("a second boot with the same file posts the same card once", async () => {
    const hill = hillOf();
    for (let i = 0; i < 2; i += 1) {
      const m = await machine("deputy");
      await writeCarryNotices(m.stateDir, "desk", T0, [FAIL]);
      await postCarryNotices({ stateDir: m.stateDir, hill, warn: () => {} });
    }
    expect(hill.collieDecisions("carried")).toHaveLength(1);
  });

  test("a Hill that is off keeps the file for a later boot, which posts it", async () => {
    const m = await machine("deputy");
    await writeCarryNotices(m.stateDir, "desk", T0, [FAIL]);
    const warned: string[] = [];
    expect(await postCarryNotices({ stateDir: m.stateDir, hill: hillOf({ on: false }), warn: (l) => void warned.push(l) })).toBe(0);
    expect(await readdir(tricksStateDir(m.stateDir))).toContain(TAKEOVER_NOTICES_FILE);
    expect(warned).toHaveLength(1);
    expect(await postCarryNotices({ stateDir: m.stateDir, hill: hillOf(), warn: () => {} })).toBe(1);
  });

  test("OK closes it, and nothing else is an option", () => {
    expect(answerCarried("ok")).toEqual({ ok: true });
    expect(answerCarried("use")).toMatchObject({ ok: false });
  });

  test("the phone reads the ref, and the file reader is strict", () => {
    expect(hillCollieRef("carried", "legs", FAIL.hash)).toEqual({ type: "carried", id: "legs", hash: FAIL.hash });
    expect(parseCarryNotices(null)).toBeNull();
    expect(parseCarryNotices("{ torn")).toBeNull();
    expect(parseCarryNotices(JSON.stringify({ v: 1, lead: "desk", at: T0, failed: [{ ...FAIL, id: "../x" }] }))?.failed).toEqual([]);
    expect(carriedCard("desk", T0, FAIL).requestId).toBe(carriedCard("desk", T0, FAIL).requestId);
  });
});

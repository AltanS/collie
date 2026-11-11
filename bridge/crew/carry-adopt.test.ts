import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { trickCodeHash } from "../tricks/code-hash.ts";
import { createTrickScanner } from "../tricks/discover.ts";
import { approvedCopyDir, switchesPath, trickStateDir, tricksConfigDir, tricksStateDir } from "../tricks/paths.ts";
import { parseSwitches } from "../tricks/switches.ts";
import { adoptCarriedTricks, TAKEOVER_NOTICES_FILE, tricksStartingAtTap, writeCarryNotices } from "./carry-adopt.ts";
import { carryAll, machine, PNG, putOnTrick, removeCarryDirs, type LeadMachine } from "./carry-fixtures.ts";
import { StandbyTricksStore } from "./standby-tricks.ts";

afterAll(removeCarryDirs);

const TAP = Date.parse("2026-11-11T09:00:00.000Z");

async function switchesOf(m: LeadMachine) {
  return parseSwitches(await readFile(switchesPath(m.stateDir), "utf8").catch(() => null)).switches;
}

async function deputyWith(lead: LeadMachine): Promise<{ deputy: LeadMachine; store: StandbyTricksStore }> {
  const deputy = await machine("deputy");
  await mkdir(tricksConfigDir(deputy.configDir), { recursive: true });
  const store = new StandbyTricksStore(deputy.stateDir);
  await carryAll(lead, store);
  return { deputy, store };
}

describe("the person's tap starts the carried tricks", () => {
  test("a held trick starts: folder, approved copy, switch by takeover from the old lead, auto kept, state", async () => {
    const lead = await machine("lead");
    const hash = await putOnTrick(lead, { id: "legs", name: "Leg day", auto: true, files: { "config.toml": "rows = 3\n", "media/logo.png": PNG }, state: { "notes.json": "{\"n\":1}\n" } });
    const { deputy, store } = await deputyWith(lead);
    const result = await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    expect(result).toEqual({ started: [{ id: "legs", name: "Leg day" }], failed: [], keptFolder: [] });
    const entry = (await switchesOf(deputy)).on.get("legs");
    expect(entry).toMatchObject({ hash, auto: true, by: "takeover", from: "desk", at: new Date(TAP).toISOString() });
    // The approved copy is the normal one, and the folder the loader reads is the same code.
    const copy = approvedCopyDir(deputy.configDir, "legs", hash);
    expect(await trickCodeHash(copy)).toEqual({ ok: true, hash });
    const folder = join(tricksConfigDir(deputy.configDir), "legs");
    expect(await trickCodeHash(folder)).toEqual({ ok: true, hash });
    expect(await readFile(join(folder, "config.toml"), "utf8")).toBe("rows = 3\n");
    expect(new Uint8Array(await readFile(join(folder, "media", "logo.png")))).toEqual(PNG);
    expect(await readFile(join(trickStateDir(deputy.stateDir, "legs"), "notes.json"), "utf8")).toBe("{\"n\":1}\n");
    if (process.platform !== "win32") expect((await stat(join(folder, "p.sh"))).mode & 0o100).toBe(0o100);
    const scan = await createTrickScanner(tricksConfigDir(deputy.configDir)).scan();
    expect(scan.tricks.map((t) => t.id)).toEqual(["legs"]);
    // No staging folder is left beside it.
    expect((await readdir(tricksConfigDir(deputy.configDir))).filter((n) => n.startsWith(".collie-carry-"))).toEqual([]);
  });

  test("held code changed on the deputy's disk does not start, and is answered for the Hill", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const { deputy, store } = await deputyWith(lead);
    const [ready] = await store.ready();
    await writeFile(join(ready?.codeDir ?? "", "p.sh"), "#!/bin/sh\necho evil\n");
    const result = await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    expect(result.started).toEqual([]);
    expect(result.failed).toEqual([{ id: "legs", name: "legs", hash: ready?.trick.hash ?? "", reason: "its copy on this machine does not match the version you approved" }]);
    expect((await switchesOf(deputy)).on.has("legs")).toBe(false);
    expect(await readdir(tricksConfigDir(deputy.configDir))).not.toContain("legs");
    await writeCarryNotices(deputy.stateDir, "desk", TAP, result.failed);
    const notices = JSON.parse(await readFile(join(tricksStateDir(deputy.stateDir), TAKEOVER_NOTICES_FILE), "utf8"));
    expect(notices).toMatchObject({ v: 1, lead: "desk", at: TAP, failed: [{ id: "legs" }] });
  });

  test("a folder this machine already has is never written over; the carried version still runs", async () => {
    const lead = await machine("lead");
    const hash = await putOnTrick(lead, { id: "legs" });
    const { deputy, store } = await deputyWith(lead);
    const mine = join(tricksConfigDir(deputy.configDir), "legs");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "trick.toml"), 'id = "legs"\nname = "My legs"\nrun = "./q.sh"\nplaces = ["belt"]\n');
    const result = await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    expect(result.keptFolder).toEqual(["legs"]);
    expect(await readFile(join(mine, "trick.toml"), "utf8")).toContain("My legs");
    expect(await readdir(mine)).toEqual(["trick.toml"]);
    expect((await switchesOf(deputy)).on.get("legs")?.hash).toBe(hash);
    expect(await trickCodeHash(approvedCopyDir(deputy.configDir, "legs", hash))).toEqual({ ok: true, hash });
    // Its scratch folder went with it.
    expect((await readdir(store.dir)).filter((n) => n.startsWith(".adopt-"))).toEqual([]);
  });

  test("a state folder this machine already has is kept", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", state: { "notes.json": "lead\n" } });
    const { deputy, store } = await deputyWith(lead);
    await mkdir(trickStateDir(deputy.stateDir, "legs"), { recursive: true });
    await writeFile(join(trickStateDir(deputy.stateDir, "legs"), "notes.json"), "mine\n");
    await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "handover", now: () => TAP });
    expect(await readFile(join(trickStateDir(deputy.stateDir, "legs"), "notes.json"), "utf8")).toBe("mine\n");
    expect((await switchesOf(deputy)).on.get("legs")?.by).toBe("handover");
  });

  test("a copy from another lead starts nothing", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const { deputy, store } = await deputyWith(lead);
    const result = await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "attic", by: "takeover", now: () => TAP });
    expect(result).toEqual({ started: [], failed: [], keptFolder: [] });
    expect((await switchesOf(deputy)).on.size).toBe(0);
  });

  test("the page names what the tap starts, read off this machine's disk: carried first, then its own ON tricks", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", name: "Leg day" });
    const { deputy, store } = await deputyWith(lead);
    await putOnTrick(deputy, { id: "own", name: "Own one" });
    expect(await tricksStartingAtTap(store, deputy.stateDir, deputy.configDir)).toEqual(["Leg day", "Own one"]);
    expect(await tricksStartingAtTap(null, deputy.stateDir, null)).toEqual([]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { trickCodeHash } from "../tricks/code-hash.ts";
import { createTrickScanner } from "../tricks/discover.ts";
import { approvedCopyDir, switchesPath, trickStateDir, tricksConfigDir, tricksStateDir } from "../tricks/paths.ts";
import { parseSwitches, withEntry, writeSwitches } from "../tricks/switches.ts";
import { adoptCarriedTricks, CARRY_RIGHTS_REASON, TAKEOVER_NOTICES_FILE, tricksStartingAtTap, writeCarryNotices } from "./carry-adopt.ts";
import { carriedCard, parseCarryNotices } from "./carry-notices.ts";
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

  test("rights the lead's record names that are not the carried code's: the trick is written but stays off, with its card (review 7 R6)", async () => {
    const lead = await machine("lead");
    const hash = await putOnTrick(lead, { id: "legs", name: "Leg day", auto: true });
    // The lead's record says another set of rights was approved than the code asks for.
    const held = await switchesOf(lead);
    const entry = held.on.get("legs");
    if (entry === undefined) throw new Error("no switch");
    await writeSwitches(lead.stateDir, withEntry(held, "legs", { ...entry, powers: "0".repeat(16) }));
    const { deputy, store } = await deputyWith(lead);
    const result = await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    expect(result.started).toEqual([]);
    expect(result.failed).toEqual([{ id: "legs", name: "Leg day", hash, reason: CARRY_RIGHTS_REASON, kind: "rights" }]);
    // Off: no switch, no approved copy; the folder is there for the person to read.
    expect((await switchesOf(deputy)).on.has("legs")).toBe(false);
    expect(await stat(approvedCopyDir(deputy.configDir, "legs", hash)).catch(() => null)).toBeNull();
    expect(await trickCodeHash(join(tricksConfigDir(deputy.configDir), "legs"))).toEqual({ ok: true, hash });
    const card = carriedCard("desk", TAP, result.failed[0]!);
    expect(card.title).toBe("The trick Leg day is off after the takeover");
    expect(card.summary).toBe("It ran on desk, but the rights its code asks for are not the rights your lead says you approved. Collie left it off on this machine. Read its rights in Settings → Tricks before you switch it on.");
    // The notice keeps its kind through the file.
    await writeCarryNotices(deputy.stateDir, "desk", TAP, result.failed);
    const notices = parseCarryNotices(await readFile(join(tricksStateDir(deputy.stateDir), TAKEOVER_NOTICES_FILE), "utf8"));
    expect(notices?.failed[0]?.kind).toBe("rights");
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

  test("the lead's auto never reaches a kept folder of other code: no switch lets that folder run without a yes", async () => {
    // The deputy has its own folder `legs` at code Y, a version its person declined; the lead runs `legs`
    // at X with auto on. The tap approves X. Were auto carried, the folder's Y would be taken "by auto".
    const lead = await machine("lead");
    const hash = await putOnTrick(lead, { id: "legs", auto: true });
    const { deputy, store } = await deputyWith(lead);
    const mine = join(tricksConfigDir(deputy.configDir), "legs");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "trick.toml"), 'id = "legs"\nname = "My legs"\nrun = "./q.sh"\nplaces = ["belt"]\n');
    const folder = await trickCodeHash(mine);
    if (!folder.ok) throw new Error("folder hash");
    await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    const entry = (await switchesOf(deputy)).on.get("legs");
    expect(entry).toMatchObject({ hash, auto: false, by: "takeover", from: "desk" });
    // Nothing declined it here, so the folder's code is the usual new version card, waiting for a yes.
    expect(entry?.declined).toBeUndefined();
  });

  test("a decline this machine already holds for the kept folder's code stays", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", auto: true });
    const { deputy, store } = await deputyWith(lead);
    const mine = join(tricksConfigDir(deputy.configDir), "legs");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "trick.toml"), 'id = "legs"\nname = "My legs"\nrun = "./q.sh"\nplaces = ["belt"]\n');
    const folder = await trickCodeHash(mine);
    if (!folder.ok) throw new Error("folder hash");
    const old = "a".repeat(64);
    await writeSwitches(deputy.stateDir, withEntry({ on: new Map(), version: 3 }, "legs", { at: new Date(TAP - 1000).toISOString(), hash: old, auto: true, by: "cli", powers: null, declined: folder.hash }));
    await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    expect((await switchesOf(deputy)).on.get("legs")).toMatchObject({ auto: false, declined: folder.hash });
  });

  test("the lead's auto comes along when the folder here is the carried version", async () => {
    const lead = await machine("lead");
    const hash = await putOnTrick(lead, { id: "legs", auto: true });
    const { deputy, store } = await deputyWith(lead);
    const [ready] = await store.ready();
    // The same code already sits in the deputy's folder.
    const mine = join(tricksConfigDir(deputy.configDir), "legs");
    await mkdir(mine, { recursive: true });
    for (const file of ready?.trick.files ?? []) {
      await mkdir(join(mine, file.rel, ".."), { recursive: true });
      await writeFile(join(mine, file.rel), await readFile(join(ready?.codeDir ?? "", file.rel)), { mode: file.x ? 0o700 : 0o600 });
    }
    expect(await trickCodeHash(mine)).toEqual({ ok: true, hash });
    await adoptCarriedTricks({ stateDir: deputy.stateDir, configDir: deputy.configDir, store, lead: "desk", by: "takeover", now: () => TAP });
    expect((await switchesOf(deputy)).on.get("legs")).toMatchObject({ hash, auto: true });
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

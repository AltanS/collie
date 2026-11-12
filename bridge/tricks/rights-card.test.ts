import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { TRICKS_DIR } from "./paths.ts";
import { answerRights, RIGHTS_CARD_APPROVED, RIGHTS_CARD_MOVED, RIGHTS_CARD_OFF, RIGHTS_CARD_REMOVED, RightsCards } from "./rights-card.ts";
import { RIGHTS_LINE, TricksService } from "./service.ts";

// THE CARD THAT SAYS A TRICK ASKS FOR A NEW RIGHT (fault B): a real tricks runner beside a real Hill whose
// decisions live in a file, so a restart is two runners over the same folders.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "collie-rights-card-")));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-11-11T09:00:00Z");
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt", "session"]\n';
/** The powers of MANIFEST as a reader that knew only `belt` stored them. */
const OLDER_READER = "ef82e1c9bd8dcfc4";

interface Folders {
  configDir: string;
  stateDir: string;
  dir: string;
}

/** A trick folder, and a switch entry approved at its code with the powers given. */
async function folders(powers: string | null): Promise<Folders> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(join(stateDir, TRICKS_DIR), { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  await setPowers({ configDir, stateDir, dir }, powers);
  return { configDir, stateDir, dir };
}

async function setPowers(f: Folders, powers: string | null): Promise<void> {
  const code = await trickCodeHash(f.dir);
  if (!code.ok) throw new Error(code.reason);
  const entry = { at: "2026-11-01T08:00:00Z", hash: code.hash, auto: false, by: "phone", powers };
  await writeFile(join(f.stateDir, TRICKS_DIR, "switches.json"), `${JSON.stringify({ v: 2, layout: 3, on: { legs: entry } })}\n`);
}

interface Life {
  hill: HillService;
  service: TricksService;
  clock: { t: number };
  runs: number[];
  warnings: string[];
  /** The Hill's one switch, as `collie hill on|off` moves it. */
  hillOn: { value: boolean };
}

/** One bridge over the folders: its Hill keeps its decisions in the state folder, as the bridge's does. */
function life(f: Folders, hillOn = true): Life {
  const clock = { t: T0 };
  let n = 0;
  const runs: number[] = [];
  const warnings: string[] = [];
  const switchOf = { value: hillOn };
  const hill = new HillService({
    store: new HillStore(join(f.stateDir, "hill"), () => clock.t),
    receipts: memoryHillReceipts(),
    place: () => null,
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    hillSwitch: { on: () => switchOf.value },
    memberId: "lodge",
    machine: "lodge",
    now: () => clock.t,
    mintId: () => `dc_rig${String(clock.t).slice(-6)}${String((n += 1)).padStart(3, "0")}`,
    onCollieAnswer: (ref, intent) => Promise.resolve(ref.type === "rights" ? answerRights(intent) : { ok: false, reason: "no" }),
  });
  const service = new TricksService({
    configDir: f.configDir,
    stateDir: f.stateDir,
    memberId: "lodge",
    world: () => ({ machine: "lodge", sessions: [], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: (line) => warnings.push(line),
    revBase: 1000,
    run: async () => {
      runs.push(clock.t);
      return { kind: "exited", code: 0, stdout: JSON.stringify({ v: 1, parts: [] }), stderr: "", ms: 1 };
    },
    rights: new RightsCards({ hill, warn: (line) => warnings.push(line) }),
  });
  return { hill, service, clock, runs, warnings, hillOn: switchOf };
}

async function scan(l: Life, t: number): Promise<void> {
  l.clock.t = t;
  await l.service.refresh(true);
}

const cards = (l: Life): HillDecision[] => l.hill.collieDecisions("rights");

describe("fault B: the Hill card of a trick stopped for its rights", () => {
  test("fault B: one card per trick and mismatch, in Collie's own words with OK alone; scans and a restart post no second", async () => {
    const f = await folders(OLDER_READER);
    const one = life(f);
    await scan(one, T0);
    await scan(one, T0 + 60_000);
    expect(cards(one)).toHaveLength(1);
    const card = cards(one)[0];
    expect(card).toMatchObject({
      state: "open",
      title: "Browser leg changed its rights",
      summary: "Collie now reads other rights in this trick than the ones you said yes to, so the trick stopped. Read its rights in Settings → Tricks, and switch it on again if you want it.",
      options: [{ intent: "ok", label: "OK" }],
      from: { kind: "collie", label: "Collie", ref: { type: "rights", id: "legs" } },
    });
    expect((await one.service.reply(undefined)).tricks[0]).toMatchObject({ state: "stopped", error: RIGHTS_LINE, rightsMoved: true });
    // A restart: a second bridge over the same folders reads the same mismatch and posts nothing new.
    const two = life(f);
    await scan(two, T0 + 120_000);
    expect(cards(two)).toHaveLength(1);
    expect(cards(two)[0]?.id).toBe(card?.id);
    expect(two.runs).toEqual([]);
  });

  test("N8b: the row and the card say the rights changed, since the hash cannot tell more rights from fewer", async () => {
    const f = await folders(OLDER_READER);
    const l = life(f);
    await scan(l, T0);
    expect(RIGHTS_LINE).toBe("Its rights changed. Switch it on again.");
    expect(cards(l)[0]?.title).toBe("Browser leg changed its rights");
    expect(cards(l)[0]?.summary).not.toContain("new right");
  });

  test("fault B: OK closes it, and the closed card is not posted again, after a restart either", async () => {
    const f = await folders(OLDER_READER);
    const one = life(f);
    await scan(one, T0);
    const card = cards(one)[0];
    if (card === undefined) throw new Error("no card");
    const outcome = await one.hill.answer({ rid: "00000000-0000-4000-8000-000000000001", node: `hill/${card.id}`, intent: "ok", value: { text: null } }, card.id, "Pixel 9");
    expect(outcome.kind).toBe("receipt");
    expect(cards(one).map((decision) => decision.state)).toEqual(["answered"]);
    await scan(one, T0 + 60_000);
    const two = life(f);
    await scan(two, T0 + 120_000);
    expect(cards(two).map((decision) => decision.state)).toEqual(["answered"]);
  });

  test("fault B: the card goes once the rights hold again; a new mismatch gets a card of its own", async () => {
    const f = await folders(OLDER_READER);
    const l = life(f);
    await scan(l, T0);
    expect(cards(l).map((decision) => decision.state)).toEqual(["open"]);
    // The person switches it on again: the approval now stores the rights read now.
    await setPowers(f, await powersOfDir(f.dir, "legs"));
    await scan(l, T0 + 60_000);
    expect(cards(l).map((decision) => [decision.state, decision.closedReason ?? null])).toEqual([["withdrawn", RIGHTS_CARD_APPROVED]]);
    expect((await l.service.reply(undefined)).tricks[0]?.rightsMoved).toBeUndefined();
    // Other stored powers are another mismatch: a card of its own.
    await setPowers(f, "0000000000000000");
    await scan(l, T0 + 120_000);
    expect(cards(l).map((decision) => decision.state)).toEqual(["withdrawn", "open"]);
    // And one more: the open card closes with that reason, and the new one opens.
    await setPowers(f, "1111111111111111");
    await scan(l, T0 + 180_000);
    expect(cards(l).map((decision) => [decision.state, decision.closedReason ?? null])).toEqual([
      ["withdrawn", RIGHTS_CARD_APPROVED],
      ["withdrawn", RIGHTS_CARD_MOVED],
      ["open", null],
    ]);
  });

  test("fault B: a stopped trick shows its switch off; one switch on approves the rights it shows, and the card closes with its receipt", async () => {
    const f = await folders(OLDER_READER);
    const l = life(f);
    await scan(l, T0);
    const row = (await l.service.reply(undefined)).tricks[0];
    // Stopped is not on: the switch shows off, with the line, and the row shows the rights a yes approves.
    expect(row).toMatchObject({ on: false, rightsMoved: true, error: RIGHTS_LINE, places: ["belt", "session"] });
    expect(row?.approves).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.auto).toBeUndefined();
    expect(cards(l).map((decision) => decision.state)).toEqual(["open"]);
    // ONE tap on: the phone's switch call, naming the version the row showed. No off first.
    const answer = await l.service.setSwitch("lodge", "legs", true, row?.approves);
    expect(answer).toMatchObject({ status: 200, body: { on: true, state: "ok" } });
    const file = JSON.parse(await readFile(join(f.stateDir, TRICKS_DIR, "switches.json"), "utf8"));
    expect(file.on.legs.powers).toBe(await powersOfDir(f.dir, "legs"));
    await scan(l, T0 + 60_000);
    expect((await l.service.reply(undefined)).tricks[0]).toMatchObject({ on: true, state: "ok" });
    expect(cards(l).map((decision) => [decision.state, decision.closedReason ?? null])).toEqual([["withdrawn", RIGHTS_CARD_APPROVED]]);
  });

  test("rights card close: switched off, the card closes as off; removed, as removed", async () => {
    const f = await folders(OLDER_READER);
    const l = life(f);
    await scan(l, T0);
    expect((await l.service.setSwitch("lodge", "legs", false)).status).toBe(200);
    await scan(l, T0 + 60_000);
    expect(cards(l).map((decision) => [decision.state, decision.closedReason ?? null])).toEqual([["withdrawn", RIGHTS_CARD_OFF]]);
  });

  test("fault B: a stopped trick whose folder is removed closes its card with that receipt", async () => {
    const f = await folders(OLDER_READER);
    const l = life(f);
    await scan(l, T0);
    expect(cards(l).map((decision) => decision.state)).toEqual(["open"]);
    await rm(f.dir, { recursive: true, force: true });
    await scan(l, T0 + 60_000);
    expect(cards(l).map((decision) => [decision.state, decision.closedReason ?? null])).toEqual([["withdrawn", RIGHTS_CARD_REMOVED]]);
    expect(l.runs).toEqual([]);
  });

  test("fault B: with the Hill off nothing is posted and the row still says it; switched on, the card comes once", async () => {
    const f = await folders(OLDER_READER);
    const l = life(f, false);
    await scan(l, T0);
    await scan(l, T0 + 60_000);
    expect(cards(l)).toEqual([]);
    expect((await l.service.reply(undefined)).tricks[0]).toMatchObject({ error: RIGHTS_LINE, rightsMoved: true });
    expect(l.warnings.filter((line) => line.includes("its rights changed was not posted"))).toHaveLength(1);
    l.hillOn.value = true;
    await scan(l, T0 + 120_000);
    await scan(l, T0 + 180_000);
    expect(cards(l).map((decision) => decision.state)).toEqual(["open"]);
  });
});

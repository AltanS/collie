import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import type { HillDecision, HillReceipt } from "../../web/src/lib/hill/wire.ts";
import { singleCodeCard } from "../../web/src/lib/hill/code-card.ts";
import { DECIDES_IS_ASKS } from "../../web/src/lib/tricks/schema.ts";
import { powersOf } from "./approved.ts";
import { diskTrickFs, trickCodeHash } from "./code-hash.ts";
import { readEarlierManifest, readManifestText, scanTrickDir } from "./discover.ts";
import { TRICKS_DIR } from "./paths.ts";
import { PENDING_SETTLE_MS, TricksService } from "./service.ts";
import { withEntry, withSwitch, writeSwitches } from "./switches.ts";
import { VersionCards } from "./version-card.ts";
import { versionDiff, type DiffRun } from "./version-diff.ts";

// AN APPROVED COPY FROM THE BUILD BEFORE THE RENAME (ADR 0179): its manifest says `decides = "reply"`, which
// this build refuses. The "new version" card compares the new version's rights with what the person approved,
// read with the earlier key name (discover.ts `readEarlierManifest`): equal rights read as equal, changed rights
// as changed, and a manifest that still does not read as changed. `auto` never takes such a version. And the
// card is posted, served and answered with Asks off.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "collie-earlier-key-")));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const BASE = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt"]\n';
const EARLIER = `${BASE}decides = "reply"\n`;
const NOW = `${BASE}asks = "reply"\n`;
const T0 = Date.parse("2026-11-23T09:00:00Z");

/** The powers the build before the rename stored for a manifest: its `decides` is the parsed field this build calls `asks`. */
function earlierPowers(text: string): string {
  const read = readManifestText(text.replace(/^decides = /mu, "asks = "), "legs");
  if (read.manifest === undefined) throw new Error(JSON.stringify(read.refusals));
  return powersOf(read.manifest);
}

describe("readEarlierManifest", () => {
  async function folderWith(text: string): Promise<string> {
    const dir = join(await tempDir(), "legs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trick.toml"), text);
    await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
    return dir;
  }
  const earlierOf = async (text: string) => {
    const dir = await folderWith(text);
    const strict = (await scanTrickDir(diskTrickFs, dir, "legs")).refusals;
    return { strict: readManifestText(text, "legs"), earlier: await readEarlierManifest(diskTrickFs, dir, "legs", strict) };
  };

  test("decides = reply reads as asks = reply, with the same powers the earlier build stored", async () => {
    const { strict, earlier } = await earlierOf(EARLIER);
    expect(strict.manifest).toBeUndefined();
    expect(strict.refusals.map((r) => [r.code, r.path, r.reason])).toEqual([["unknown-key", "/decides", DECIDES_IS_ASKS]]);
    expect(earlier?.decides).toBe("reply");
    expect(earlier === undefined ? null : powersOf(earlier)).toBe(earlierPowers(EARLIER));
  });

  test("nothing else is mapped: another word, both keys, another refusal, or no decides at all read as none", async () => {
    expect((await earlierOf(`${BASE}decides = "always"\n`)).earlier).toBeUndefined();
    expect((await earlierOf(`${BASE}decides = "reply"\nasks = "reply"\n`)).earlier).toBeUndefined();
    expect((await earlierOf(`${EARLIER}bogus = 1\n`)).earlier).toBeUndefined();
    expect((await earlierOf(`${EARLIER}every = 5\n`)).earlier).toBeUndefined();
    expect((await earlierOf(`${BASE}bogus = 1\n`)).earlier).toBeUndefined();
    expect((await earlierOf(BASE)).earlier).toBeUndefined();
    expect((await earlierOf(NOW)).earlier).toBeUndefined();
  });

  test("a strict refusal the earlier read does not have (a refused config.toml) reads as none", async () => {
    const dir = await folderWith(EARLIER);
    const strict = [...readManifestText(EARLIER, "legs").refusals, { code: "size" as const, path: "", reason: "config.toml is larger than 64 KiB." }];
    expect(await readEarlierManifest(diskTrickFs, dir, "legs", strict)).toBeUndefined();
  });
});

// ── The card's life, on a real Hill with Asks OFF beside a real tricks runner ─────────────────────

interface Life {
  dir: string;
  stateDir: string;
  clock: { t: number };
  hill: HillService;
  cards: VersionCards;
  service: TricksService;
}

async function wholeFileDiff(argv: readonly string[]): Promise<DiffRun> {
  const lines = async (path: string | undefined): Promise<string[]> => (path === undefined || path === "/dev/null" ? [] : (await readFile(path, "utf8")).split("\n").filter((line) => line !== ""));
  const [left, right] = await Promise.all([lines(argv.at(-2)), lines(argv.at(-1))]);
  const patch = [`@@ -1,${String(left.length)} +1,${String(right.length)} @@`, ...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)];
  return { code: 1, stdout: `${patch.join("\n")}\n`, timedOut: false };
}

/** A trick approved under the build before the rename: its folder and switch entry as that build left them. */
async function life(approved: string, opts: { auto?: boolean; powers?: string | null } = {}): Promise<Life> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), approved);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  const code = await trickCodeHash(dir);
  if (!code.ok) throw new Error(code.reason);
  const powers = opts.powers === undefined ? earlierPowers(approved) : opts.powers;
  const switched = withSwitch({ on: new Map() }, "legs", true, "2026-11-20T08:00:00Z", code.hash, powers);
  const entry = switched.on.get("legs");
  if (entry === undefined) throw new Error("no switch entry");
  await writeSwitches(stateDir, opts.auto === true ? withEntry(switched, "legs", { ...entry, auto: true }) : switched);
  const clock = { t: T0 };
  let n = 0;
  let service: TricksService | null = null;
  let cards: VersionCards | null = null;
  const hill = new HillService({
    store: new HillStore(null, () => clock.t),
    receipts: memoryHillReceipts(),
    place: () => null,
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "lodge",
    machine: "lodge",
    now: () => clock.t,
    mintId: () => `ak_ear${String((n += 1)).padStart(9, "0")}`,
    // Asks is OFF, as after the clean slate: no file reads off.
    hillSwitch: { on: () => false, reading: () => "unset" },
    onCollieAnswer: (ref, intent) => cards?.answer(ref, intent) ?? Promise.resolve({ ok: false, reason: "no cards" }),
  });
  cards = new VersionCards({ hill, tricks: () => service, diff: (base, next) => versionDiff({ base, next, git: "/fake/git", run: wholeFileDiff }) });
  service = new TricksService({
    feature: { on: () => true },
    configDir,
    stateDir,
    memberId: "lodge",
    world: () => ({ machine: "lodge", sessions: [], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => undefined,
    revBase: 1000,
    officialEntries: () => [],
    run: async () => ({ kind: "exited", code: 0, stdout: JSON.stringify({ v: 1, parts: [] }), stderr: "", ms: 1 }),
    versions: cards,
  });
  await scan({ clock, service, cards }, T0);
  return { dir, stateDir, clock, hill, cards, service };
}

async function scan(l: Pick<Life, "clock" | "service" | "cards">, t: number): Promise<void> {
  l.clock.t = t;
  await l.service.refresh(true);
  await l.cards.settled();
}

/** The new version lands in the folder (an official Update, or the person's own edit) and settles. */
async function update(l: Life, at: number, manifest: string, program = "#!/bin/sh\necho 1\n"): Promise<string> {
  await writeFile(join(l.dir, "trick.toml"), manifest);
  await writeFile(join(l.dir, "legs.sh"), program);
  await scan(l, at);
  await scan(l, at + PENDING_SETTLE_MS);
  const code = await trickCodeHash(l.dir);
  if (!code.ok) throw new Error(code.reason);
  return code.hash;
}

const listed = (l: Life): HillDecision | undefined => l.hill.list().open.find((decision) => decision.from.ref?.type === "version");
const row = async (l: Life) => (await l.service.reply(undefined)).tricks.find((trick) => trick.id === "legs");
const switchFile = async (l: Life) => JSON.parse(await readFile(join(l.stateDir, TRICKS_DIR, "switches.json"), "utf8")).on.legs;

async function tap(l: Life, decision: HillDecision, intent: string): Promise<HillReceipt> {
  const request = { rid: "00000000-0000-4000-8000-000000000001", node: `hill/${decision.id}`, intent, value: { text: null } };
  const one = singleCodeCard(decision);
  const outcome = await l.hill.answer(one === null ? request : { ...request, group: { digest: one.digest, opened: [1] } }, decision.id, "Pixel 9");
  if (outcome.kind !== "receipt") throw new Error(outcome.kind);
  return outcome.receipt;
}

describe("a version after an approval the build before the rename gave", () => {
  test("the same rights read as the same; Asks off still serves the card, and the yes runs the new code", async () => {
    const l = await life(EARLIER);
    expect(l.hill.isOn()).toBe(false);
    // This build refuses the approved manifest: the trick runs nothing until the new version is approved.
    expect(await row(l)).toMatchObject({ state: "skipped" });
    const v2 = await update(l, T0 + 1000, NOW, "#!/bin/sh\necho 2\n");
    expect((await row(l))?.pending).toMatchObject({ hash: v2, powersChanged: false });
    const card = listed(l);
    expect(card).toMatchObject({ title: "Use the new version of legs?", summary: "2 files changed. It asks for no new rights." });
    expect(card?.options.map((option) => option.intent)).toEqual(["use", "always", "keep"]);
    expect(await tap(l, card!, "use")).toMatchObject({ code: "ok", state: "answered" });
    expect(await switchFile(l)).toMatchObject({ hash: v2, by: "phone", powers: earlierPowers(EARLIER) });
    await scan(l, T0 + 40_000);
    expect(await row(l)).toMatchObject({ state: "ok", decidesReply: true });
  });

  test("auto does not take it: an approved copy this build refuses always asks", async () => {
    const l = await life(EARLIER, { auto: true });
    const before = (await switchFile(l)).hash;
    const v2 = await update(l, T0 + 1000, NOW, "#!/bin/sh\necho 2\n");
    expect((await switchFile(l)).hash).toBe(before);
    expect((await row(l))?.pending).toMatchObject({ hash: v2, powersChanged: false });
    expect(listed(l)?.from.ref).toMatchObject({ type: "version", hash: v2 });
  });

  test("a real change of rights still reads as changed: a right dropped, a right added", async () => {
    const dropped = await life(EARLIER);
    await update(dropped, T0 + 1000, BASE, "#!/bin/sh\necho 2\n");
    expect((await row(dropped))?.pending).toMatchObject({ powersChanged: true });
    expect(listed(dropped)?.summary).toBe("2 files changed. Its rights changed.");
    expect(listed(dropped)?.options.map((option) => option.intent)).toEqual(["use", "keep"]);

    const added = await life(EARLIER);
    await update(added, T0 + 1000, `${NOW}env = ["GH_TOKEN"]\n`, "#!/bin/sh\necho 2\n");
    expect((await row(added))?.pending).toMatchObject({ powersChanged: true });
    expect(listed(added)?.summary).toBe("2 files changed. It now also asks for GH_TOKEN.");
  });

  test("an approved manifest that still does not read counts as changed, as before", async () => {
    const l = await life(`${BASE}decides = "reply"\nbogus = 1\n`, { powers: null });
    await update(l, T0 + 1000, NOW, "#!/bin/sh\necho 2\n");
    expect((await row(l))?.pending).toMatchObject({ powersChanged: true });
    expect(listed(l)?.options.map((option) => option.intent)).toEqual(["use", "keep"]);
  });
});

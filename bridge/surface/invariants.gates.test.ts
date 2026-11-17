// M102 spec 15, part 1a on the bridge: EVERY Surface (the full product of its fields, lib/surface/
// surface.ts) on a screen with a box and on one with no box (the null frame), through the Send
// Protocol's gates. The seam `surfaceSeam` puts the generated Surface on each read; the pane reacts to
// text like a terminal and logs every write. The assertions are the invariants, never a reading:
//
//   I4  a person's override with the rows hash is typed, or refused only for stale_surface, menu_open
//       or pane_gone, on every Surface that is not a known secret and not a read ask (spec 12).
//   I6  one request id gives at most one text write and one Enter; the same id again writes nothing;
//       Collie's own send (no person) never presses Enter on a screen that is not free.
//
// The product is 2880 Surfaces x 2 screens. Each seed runs a sample of it (SAMPLE per seed); the fixed
// seeds and one fresh seed together cover about a third of it per run, and a fresh seed moves the sample.

import { afterAll, describe, expect, test } from "bun:test";

import { isFree, type Surface } from "../../web/src/lib/surface/surface.ts";
import { replayHint, rngOf, runSeeds, sample } from "../../web/src/test/invariants/seed.ts";
import { allSurfaces, overrideReaches, type SurfaceCase } from "../../web/src/test/invariants/surfaces.ts";
import { collieOwn, invariantRig, keysOf, personOverride, retrySame, textWrites, type PaneDraw, type RigOptions } from "./invariants-rig.ts";

const TEXT = "please carry on with the parser fix";
/** The profile whose box the rig draws, pinned to one range so a lab run that moves its versions does not move the cases. */
const AGENT = { harness: "claude", pinVersions: [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }] } satisfies Pick<RigOptions, "harness" | "pinVersions">;
const SAMPLE = 320;
const SCREENS: readonly { readonly name: string; readonly draw: PaneDraw }[] = [
  { name: "box", draw: { kind: "box" } },
  { name: "null-frame", draw: { kind: "bare" } },
];

/** The refusals spec 12 allows an override (decision 2); every other refusal breaks I4. */
const OVERRIDE_REFUSALS: ReadonlySet<string> = new Set(["stale_surface", "menu_open", "pane_gone"]);

interface Case {
  readonly seed: number;
  readonly surface: SurfaceCase;
  readonly draw: string;
  readonly pane: PaneDraw;
}

function casesOf(seed: number): readonly Case[] {
  const rng = rngOf(seed);
  const all = allSurfaces().flatMap((surface) => SCREENS.map((s) => ({ seed, surface, draw: s.name, pane: s.draw })));
  return sample(all, SAMPLE, rng);
}

const SEEDS = runSeeds();
const CASES: readonly Case[] = SEEDS.flatMap(casesOf);
const covered = new Set(CASES.map((c) => `${c.surface.id} ${c.draw}`)).size;

/** Which bucket an I4 break belongs to, by what the bridge answered (both were red before M102 spec 12). */
type I4Bucket = "not-free" | "draft-no-box";
function i4Bucket(answer: { readonly outcome?: string; readonly reason?: string }): I4Bucket | null {
  if (answer.reason === "not_free" || answer.reason === "unconfirmed") return "not-free";
  if (answer.reason === "draft_present") return "draft-no-box";
  // Anything else is a break no entry names yet: the green test below fails on it.
  return null;
}

/** Not free for I6's second half: a modal that is not none, a box Collie cannot read, or a turn it cannot tell. */
function notFreeForCollie(surface: Surface): boolean {
  if (isFree(surface)) return false;
  if (surface.modal !== "none") return true;
  return surface.composer === "unknown" || surface.composer === "unreachable" || surface.turn === "unknown";
}

interface Outcome {
  readonly c: Case;
  readonly i4: string | null;
  readonly i4Bucket: I4Bucket | null;
  readonly i6: string | null;
  readonly i6Own: string | null;
}

async function runCase(c: Case): Promise<Outcome> {
  const hint = replayHint(c.seed, `${c.surface.id} screen=${c.draw}`);
  const person = invariantRig({ ...AGENT, draw: c.pane, surface: c.surface.surface });
  const own = invariantRig({ ...AGENT, draw: c.pane, surface: c.surface.surface });
  try {
    const { prepare, commit, writes, id } = await personOverride(person, TEXT);
    const receipt = commit.receipt;
    let i4: string | null = null;
    let bucket: I4Bucket | null = null;
    if (overrideReaches(c.surface.surface)) {
      // A draft in the box is the person's own road: Add to it or Replace it, both offered with the refusal.
      const draftRoad = receipt?.reason === "draft_present" && (commit.offers.includes("append") || commit.offers.includes("replace"));
      const refused = receipt?.outcome === "refused" && !OVERRIDE_REFUSALS.has(receipt.reason ?? "") && !draftRoad;
      if (receipt === undefined || refused || receipt.outcome === "held") {
        i4 = `override ${receipt?.outcome ?? "no receipt"}(${receipt?.reason ?? "-"}) on ${hint}`;
        bucket = i4Bucket({ outcome: receipt?.outcome, reason: receipt?.reason });
      }
    }
    // I6: at most one text write and one Enter per id, and nothing on a retry of the same id.
    let i6: string | null = null;
    const enters = keysOf(writes).filter((key) => key === "Enter").length;
    if (textWrites(writes, TEXT) > 1 || enters > 1) i6 = `id ${id} wrote the text ${String(textWrites(writes, TEXT))} times and Enter ${String(enters)} times on ${hint}`;
    const again = await retrySame(person, id, TEXT, prepare.rowsHash);
    if (again.writes.length > 0) i6 = `the same id ${id} wrote again (${again.writes.map((w) => `${w.kind}:${w.value}`).join(" ")}) on ${hint}`;
    // I6: Collie's own send never presses Enter on a screen that is not free.
    let i6Own: string | null = null;
    if (notFreeForCollie(c.surface.surface)) {
      const mine = await collieOwn(own, TEXT);
      if (keysOf(mine.writes).includes("Enter")) i6Own = `Collie's own send pressed Enter (${mine.answer.receipt?.outcome ?? "-"}) on ${hint}`;
    }
    return { c, i4, i4Bucket: bucket, i6, i6Own };
  } finally {
    person.dispose();
    own.dispose();
  }
}

let outcomes: readonly Outcome[] | null = null;
async function allOutcomes(): Promise<readonly Outcome[]> {
  if (outcomes === null) {
    const out: Outcome[] = [];
    for (const c of CASES) out.push(await runCase(c));
    outcomes = out;
  }
  return outcomes;
}

function breaks(list: readonly Outcome[], pick: (o: Outcome) => string | null): readonly string[] {
  return list.map(pick).filter((line): line is string => line !== null);
}

afterAll(() => {
  // The coverage line the report quotes.
  console.info(`[invariants.gates] seeds ${SEEDS.join(",")}: ${String(CASES.length)} cases, ${String(covered)} distinct of ${String(allSurfaces().length * SCREENS.length)} (Surface x screen)`);
});

describe("M102-15 part 1a, the bridge's gates over every Surface", () => {
  test("I6: one request id gives at most one text write and one Enter, and the same id again writes nothing", async () => {
    expect(breaks(await allOutcomes(), (o) => o.i6)).toEqual([]);
  }, 120_000);

  test("I6: Collie's own send never presses Enter on a screen that is not free", async () => {
    expect(breaks(await allOutcomes(), (o) => o.i6Own)).toEqual([]);
  }, 120_000);

  test("I4: the person's override is typed or refused only for stale_surface, menu_open or pane_gone, on a read that is no question and no secret, apart from the known-red buckets", async () => {
    const list = await allOutcomes();
    const unbucketed = list.filter((o) => o.i4 !== null && o.i4Bucket === null).map((o) => o.i4);
    expect(unbucketed).toEqual([]);
  }, 120_000);

  // Red on the base, green since M102 spec 12: a stale, torn, contested, unreachable or modal-less unknown
  // read (not-free), and a draft with no box Collie can find (draft-no-box), no longer refuse an override.
  for (const id of ["not-free", "draft-no-box"] as const) {
    test(`I4: no override is refused in the ${id} bucket`, async () => {
      const list = await allOutcomes();
      const hits = list.filter((o) => o.i4Bucket === id).map((o) => o.i4);
      // The named cases below run on every seed, so this expected failure is real whatever the sample reached.
      console.info(`[invariants.gates] ${id}: ${String(hits.length)} of ${String(list.length)} cases`);
      expect(hits).toEqual([]);
    }, 120_000);
  }
});

/** One fixed case per bucket, run on every seed, so each stays green whatever the sample reached. */
describe("M102-15 part 1a, the named cases of each I4 bucket", () => {
  const named: readonly { readonly id: I4Bucket; readonly surface: Surface; readonly draw: PaneDraw }[] = [
    { id: "not-free", surface: { revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" }, draw: { kind: "box" } },
    { id: "not-free", surface: { revision: 1, turn: "idle", modal: "none", composer: "unreachable" }, draw: { kind: "box" } },
    { id: "not-free", surface: { revision: 1, turn: "unknown", modal: "none", composer: "unknown" }, draw: { kind: "box" } },
    { id: "not-free", surface: { revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "torn" }, draw: { kind: "bare" } },
    { id: "draft-no-box", surface: { revision: 1, turn: "idle", modal: "none", composer: "draft" }, draw: { kind: "bare" } },
  ];
  for (const n of named) {
    const label = `turn=${n.surface.turn} modal=${String(n.surface.modal)} composer=${n.surface.composer} reason=${n.surface.reason ?? "-"} screen=${n.draw.kind}`;
    test(`I4 override on ${label} (${n.id})`, async () => {
      const rig = invariantRig({ ...AGENT, draw: n.draw, surface: n.surface });
      try {
        const { commit } = await personOverride(rig, TEXT);
        const receipt = commit.receipt;
        const ok = receipt !== undefined && receipt.outcome !== "held" && (receipt.outcome !== "refused" || OVERRIDE_REFUSALS.has(receipt.reason ?? ""));
        expect({ ok, outcome: receipt?.outcome, reason: receipt?.reason }).toMatchObject({ ok: true });
      } finally {
        rig.dispose();
      }
    });
  }
});

/**
 * I5 (spec 12 decision 6): a held send keeps waiting for proof, but after two minutes its receipt says
 * so (`heldLong: true`), so the phone can show the live screen, "Send it now" and Cancel. Today a hold
 * waits up to 30 minutes on a reading alone and says only "Something is open".
 */
describe("M102-15 I5, no long wait on a reading alone", () => {
  test("I5: a send held on a screen that is not free says heldLong after two minutes", async () => {
    const surface: Surface = { revision: 1, turn: "running", modal: "none", composer: "unknown" };
    const rig = invariantRig({ ...AGENT, draw: { kind: "box" }, surface, holds: true });
    try {
      const id = "inv-held-long-1";
      const first = await rig.handle({ id, text: TEXT, mode: "send", fromPhone: true });
      expect(first.receipt?.outcome).toBe("held");
      rig.clock.now += 125_000;
      await Promise.all(rig.protocol.tickHolds("main", () => surface));
      const receipt = rig.store.get(id)?.receipt;
      const entry = rig.holds?.get(id);
      const onReceipt = receipt !== undefined && "heldLong" in receipt && receipt.heldLong === true;
      const onEntry = entry !== undefined && entry !== null && "heldLong" in entry && entry.heldLong === true;
      expect(onReceipt || onEntry).toBe(true);
    } finally {
      rig.dispose();
    }
  });
});

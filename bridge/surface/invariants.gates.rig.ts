// Shared by invariants.gates.test.ts and invariants.gates.slow.test.ts: the helpers both files need. Not a test file.

import { isFree, type Surface } from "../../web/src/lib/surface/surface.ts";
import { replayHint, rngOf, runSeeds, sample } from "../../web/src/test/invariants/seed.ts";
import { allSurfaces, overrideReaches, type SurfaceCase } from "../../web/src/test/invariants/surfaces.ts";
import { collieOwn, invariantRig, keysOf, personOverride, retrySame, textWrites, type PaneDraw, type RigOptions } from "./invariants-rig.ts";

export const TEXT = "please carry on with the parser fix";

/** The profile whose box the rig draws, pinned to one range so a lab run that moves its versions does not move the cases. */
export const AGENT = { harness: "claude", pinVersions: [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }] } satisfies Pick<RigOptions, "harness" | "pinVersions">;

export const SAMPLE = 320;

export const SCREENS: readonly { readonly name: string; readonly draw: PaneDraw }[] = [
  { name: "box", draw: { kind: "box" } },
  { name: "null-frame", draw: { kind: "bare" } },
];

/** The refusals spec 12 allows an override (decision 2); every other refusal breaks I4. */
export const OVERRIDE_REFUSALS: ReadonlySet<string> = new Set(["stale_surface", "menu_open", "pane_gone"]);

export interface Case {
  readonly seed: number;
  readonly surface: SurfaceCase;
  readonly draw: string;
  readonly pane: PaneDraw;
}

export function casesOf(seed: number): readonly Case[] {
  const rng = rngOf(seed);
  const all = allSurfaces().flatMap((surface) => SCREENS.map((s) => ({ seed, surface, draw: s.name, pane: s.draw })));
  return sample(all, SAMPLE, rng);
}

export const SEEDS = runSeeds();

export const CASES: readonly Case[] = SEEDS.flatMap(casesOf);

export const covered = new Set(CASES.map((c) => `${c.surface.id} ${c.draw}`)).size;

/** Which bucket an I4 break belongs to, by what the bridge answered (both were red before M102 spec 12). */
export type I4Bucket = "not-free" | "draft-no-box";

export function i4Bucket(answer: { readonly outcome?: string; readonly reason?: string }): I4Bucket | null {
  if (answer.reason === "not_free" || answer.reason === "unconfirmed") return "not-free";
  if (answer.reason === "draft_present") return "draft-no-box";
  // Anything else is a break no entry names yet: the green test below fails on it.
  return null;
}

/** Not free for I6's second half: a modal that is not none, a box Collie cannot read, or a turn it cannot tell. */
export function notFreeForCollie(surface: Surface): boolean {
  if (isFree(surface)) return false;
  if (surface.modal !== "none") return true;
  return surface.composer === "unknown" || surface.composer === "unreachable" || surface.turn === "unknown";
}

export interface Outcome {
  readonly c: Case;
  readonly i4: string | null;
  readonly i4Bucket: I4Bucket | null;
  readonly i6: string | null;
  readonly i6Own: string | null;
}

export async function runCase(c: Case): Promise<Outcome> {
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

export let outcomes: readonly Outcome[] | null = null;

export async function allOutcomes(): Promise<readonly Outcome[]> {
  if (outcomes === null) {
    const out: Outcome[] = [];
    for (const c of CASES) out.push(await runCase(c));
    outcomes = out;
  }
  return outcomes;
}

export function breaks(list: readonly Outcome[], pick: (o: Outcome) => string | null): readonly string[] {
  return list.map(pick).filter((line): line is string => line !== null);
}

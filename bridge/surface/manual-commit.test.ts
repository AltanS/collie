// The manual Send's commit presses Enter only on the exact rows the person saw (2026-11-17, second review).
// The loose compare (digits and spinner glyphs masked, M102 spec 12) is for a road that presses no key: a
// commit whose rows match only loosely takes the override road (the text, no key), and a real change is
// refused `stale_surface` with the rows now. Before the fix the loose match let the commit press Enter, so
// "Delete 3 files?" turning into "Delete 312 files?" between the look and the tap still got its Enter.
import { afterEach, describe, expect, test } from "bun:test";

import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { invariantRig, keysOf, nextId, writesSince, type InvariantRig, type RigOptions } from "./invariants-rig.ts";

const AGENT = { harness: "claude", pinVersions: [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }] } satisfies Pick<RigOptions, "harness" | "pinVersions">;
/** A screen the reader cannot claim free: a weak cue, the manual Send. */
const MANUAL: Surface = { revision: 7, turn: "idle", modal: "unknown", composer: "empty" };
const TEXT = "yes go ahead";

const rigs: InvariantRig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.dispose();
});

/** The person's look (`prepare`), a change to the screen, then the commit tap with the hash of the look and `override`. */
async function lookChangeCommit(change: (rig: InvariantRig) => void) {
  const rig = invariantRig({ ...AGENT, draw: { kind: "box" }, surface: MANUAL });
  rigs.push(rig);
  rig.pane.transcript.push("Delete 3 files?");
  const prepare = await rig.handle({ text: "", mode: "prepare", fromPhone: true });
  expect(prepare.rowsHash).toBeString();
  change(rig);
  const from = rig.pane.log.length;
  const commit = await rig.handle({ id: nextId(), text: TEXT, mode: "send", fromPhone: true, override: true, rowsHash: prepare.rowsHash! });
  return { rig, commit, writes: writesSince(rig.pane, from) };
}

describe("the manual Send's commit and the rows the person saw", () => {
  test("the exact rows: the manual Send as before, the text and its Enter", async () => {
    const { commit, writes } = await lookChangeCommit(() => undefined);
    expect(commit.receipt?.outcome).toBe("sent");
    expect(keysOf(writes)).toContain("Enter");
  });

  test("rows that match only loosely (a number changed): the text goes in, no key is pressed", async () => {
    const { commit, writes } = await lookChangeCommit((rig) => {
      rig.pane.transcript[rig.pane.transcript.length - 1] = "Delete 312 files?";
    });
    expect(keysOf(writes)).not.toContain("Enter");
    expect(commit.receipt?.outcome).toBe("typed_not_submitted");
    expect(commit.receipt?.reason).toBe("override");
    expect(writes.filter((write) => write.kind !== "keys" && write.value.includes(TEXT))).toHaveLength(1);
  });

  test("a real change: refused stale_surface with the rows now and their hash, nothing typed", async () => {
    const { rig, commit, writes } = await lookChangeCommit((r) => {
      r.pane.box = "someone typed here";
    });
    expect(commit.receipt?.outcome).toBe("refused");
    expect(commit.receipt?.reason).toBe("stale_surface");
    expect(commit.rowsHash).toBeString();
    expect(writes).toEqual([]);
    expect(rig.pane.box).toBe("someone typed here");
  });

  test("a manual commit with no override and a number changed: stale_surface, no key", async () => {
    const rig = invariantRig({ ...AGENT, draw: { kind: "box" }, surface: MANUAL });
    rigs.push(rig);
    rig.pane.transcript.push("Delete 3 files?");
    const prepare = await rig.handle({ text: "", mode: "prepare", fromPhone: true });
    rig.pane.transcript[rig.pane.transcript.length - 1] = "Delete 312 files?";
    const from = rig.pane.log.length;
    const commit = await rig.handle({ id: nextId(), text: TEXT, mode: "send", fromPhone: true, rowsHash: prepare.rowsHash! });
    expect(commit.receipt?.reason).toBe("stale_surface");
    expect(writesSince(rig.pane, from)).toEqual([]);
  });
});

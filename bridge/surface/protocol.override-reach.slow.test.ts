// The slow cases of protocol.override-reach.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, pane, NO_PROFILE, FRAMELESS, ScreenPane, rig, refusedClean, useScratchDir } from "./protocol.override-reach.rig.ts";

// SAFETY: surface-labels.json is the corpus label file, written by its own tool with this shape.
const LABELS = JSON.parse(readFileSync(join(FIXTURES, "surface-labels.json"), "utf8")) as { fixtures: Record<string, { harness: string; state: string }> };

useScratchDir();

describe("2. the harm cases: an override never answers a question (M102 spec 12)", () => {
  const dialogs = Object.entries(LABELS.fixtures).filter(([, label]) => label.state === "dialog");

  // Each of the four walks reads every dialog fixture of the corpus (722 screens). That took 6.5 to 6.9 s
  // on the Windows VM and 4 s on a loaded Linux host, against bun's 5 s. The walk stays whole; the limit is
  // the one that a slow machine needs.
  const WALK_TIMEOUT_MS = 60_000;

  test("every dialog fixture of every harness, read unread (no frame, no reader): refused menu_open, nothing typed, no key", async () => {
    const harnesses = new Set<string>();
    const typed: string[] = [];
    for (const [name, label] of dialogs) {
      const screen = new ScreenPane(pane(name));
      const answer = await rig(screen, { harness: FRAMELESS }).override("1");
      if (answer.receipt?.reason !== "menu_open" || screen.writes.length > 0 || screen.keys.length > 0) typed.push(`${name}: ${answer.receipt?.outcome ?? "-"}(${answer.receipt?.reason ?? "-"}) writes=${String(screen.writes.length)} keys=${screen.keys.join(",")}`);
      else refusedClean(answer, screen, "menu_open");
      harnesses.add(label.harness);
    }
    expect(typed).toEqual([]);
    expect(harnesses.size).toBeGreaterThanOrEqual(11);
  }, WALK_TIMEOUT_MS);

  // On the blind road the sign is a guess (2026-11-25): it refuses the first send, and the person's override
  // past it goes in with no key at all, Enter included, only where the screen shows an agent's input box or
  // footer and the sign is no row of one-key items. Elsewhere (a strong cue alone included) the refusal carries
  // no rows hash and the override is refused too. Never a key on either tap. Measured 2026-11-25: 266 of the
  // 722 dialogs pass (all on a frame), 456 are guarded (436 cue only, 17 no agent rows, 3 single-key on a frame).
  for (const foreground of [undefined, "unknown", "program"] as const) {
    test(`the same dialogs on a pane with no profile (the blind road, foreground ${foreground ?? "not read"}): the first send refused menu_open, the override typed with no key or refused, never a key`, async () => {
      const wrong: string[] = [];
      let passed = 0;
      let guarded = 0;
      for (const [name] of dialogs) {
        const screen = new ScreenPane(pane(name));
        const r = rig(screen, { harness: NO_PROFILE, foreground });
        const first = await r.send("y", { fromPhone: true });
        if (first.receipt?.reason !== "menu_open" || first.receipt.menuSign === undefined || screen.writes.length > 0 || screen.keys.length > 0) {
          wrong.push(`${name}: first ${first.receipt?.outcome ?? "-"}(${first.receipt?.reason ?? "-"})`);
          continue;
        }
        if (first.rowsHash === undefined) {
          guarded++;
          const again = await r.override("y");
          if (again.receipt?.reason !== "menu_open" || screen.writes.length > 0 || screen.keys.length > 0) wrong.push(`${name}: guarded, then ${again.receipt?.outcome ?? "-"}(${again.receipt?.reason ?? "-"})`);
          continue;
        }
        const answer = await r.send("y", { rowsHash: first.rowsHash, override: true, fromPhone: true });
        const typed = answer.receipt?.outcome === "typed_not_submitted" && answer.receipt.reason === "override" && answer.receipt.menuSign !== undefined && answer.receipt.menuSign.kind !== "single-key";
        if (!typed || answer.receipt?.keys.length !== 0 || screen.keys.length > 0 || screen.writes.length !== 1) wrong.push(`${name}: ${answer.receipt?.outcome ?? "-"}(${answer.receipt?.reason ?? "-"}) keys=${screen.keys.join(",")}`);
        else passed++;
      }
      expect(wrong).toEqual([]);
      expect({ passed, guarded }).toEqual({ passed: 266, guarded: 456 });
    }, WALK_TIMEOUT_MS);
  }
});

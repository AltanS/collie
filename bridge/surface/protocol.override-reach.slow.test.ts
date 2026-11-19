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

  for (const foreground of [undefined, "unknown", "program"] as const) {
    test(`the same dialogs on a pane with no profile (the blind road, foreground ${foreground ?? "not read"}): refused menu_open, nothing typed, no key`, async () => {
      const typed: string[] = [];
      for (const [name] of dialogs) {
        const screen = new ScreenPane(pane(name));
        const answer = await rig(screen, { harness: NO_PROFILE, foreground }).override("y");
        if (answer.receipt?.reason !== "menu_open" || screen.writes.length > 0 || screen.keys.length > 0) typed.push(`${name}: ${answer.receipt?.outcome ?? "-"}(${answer.receipt?.reason ?? "-"})`);
        else expect(answer.receipt?.menuSign).toBeDefined();
      }
      expect(typed).toEqual([]);
    }, WALK_TIMEOUT_MS);
  }
});

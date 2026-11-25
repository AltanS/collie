// The window between the check and the write of the person's override (counsel, 2026-11-25). The override
// road binds the text to the rows the person saw (`rowsSeen`), checked on the run's first read. A screen
// that moves after that read and before the first byte (a program that prints, a menu that opens) must
// type nothing: the road reads the pane once more right before it writes.

import { describe, expect, test } from "bun:test";
import { type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { pane, NO_PROFILE, ScreenPane, rig, refusedClean, useScratchDir } from "./protocol.override-reach.rig.ts";

useScratchDir();

/** A pane whose screen turns into `next` after a number of reads, counted from {@link arm}. */
class MovingPane extends ScreenPane {
  private left = 0;
  constructor(
    screen: string,
    private readonly next: string,
  ) {
    super(screen);
  }
  /** The next `reads` reads show the screen as it is; every later read shows `next`. */
  arm(reads: number): void {
    this.left = reads;
  }
  override readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    const shown = this.screen;
    if (this.left > 0 && --this.left === 0) {
      this.screen = this.next;
      this.revision++;
    }
    return Promise.resolve({ ok: true, value: { paneId, text: shown, truncated: false, revision: this.revision } });
  };
}

/**
 * The person's override, with the screen moving right after the send's own check read: the blind road
 * reads once, the profile road's settled first read takes two.
 */
async function moveInWindow(screen: MovingPane, r: ReturnType<typeof rig>, text: string, checkReads = 1) {
  const seen = await r.prepare();
  screen.arm(checkReads);
  return r.send(text, { rowsHash: seen, override: true, fromPhone: true });
}

const QUESTION = ["$ ./tool", "", "Replace the settings file? (y/n)"].join("\n");
const MOVED = ["$ ./tool", "", "Replace the settings file? (y/n)", "Delete the old copy too? (y/n)"].join("\n");
const CLAUDE_DRAFT = "claude--draft-footer-single.txt";

describe("an override whose screen moves between the check and the write", () => {
  test("an override whose screen moves between the check and the write types nothing (no profile, past a sign)", async () => {
    const screen = new MovingPane(QUESTION, MOVED);
    const answer = await moveInWindow(screen, rig(screen, { harness: NO_PROFILE }), "y");
    refusedClean(answer, screen, "stale_surface");
    expect(answer.rows).toContain("Delete the old copy too? (y/n)");
  });

  test("an override whose screen moves between the check and the write types nothing (a profile, a draft in the box)", async () => {
    const base = pane(CLAUDE_DRAFT);
    const screen = new MovingPane(base, base.replace("❯", "❯ x"));
    const answer = await moveInWindow(screen, rig(screen), "then this", 2);
    refusedClean(answer, screen, "stale_surface");
  });

  test("a screen that stays put between the check and the write is typed, with no key", async () => {
    const screen = new MovingPane(QUESTION, QUESTION);
    const answer = await moveInWindow(screen, rig(screen, { harness: NO_PROFILE }), "y");
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", keys: [] });
    expect(screen.writes).toEqual([{ how: "paste", text: "y" }]);
    expect(screen.keys).toEqual([]);
  });
});

// The slow cases of unkind.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { HerdrCoreMux, HISTORY_READ_BUDGET_MS, OLDER_NOTE_READING } from "./adapter.ts";
import { FakeHcCore } from "./fake-core.ts";

/** Load older: the one read that reads history on the core (M79 spec 01). */
const OLDER = { scope: "recent", lines: 200, styling: "preserve", purpose: "older" } as const;

describe("a history read that hangs (HC_API.md, terminal.read `lines` and `how: stitched`; M78 spec 03, pi 2 and 3)", () => {
  test("a Load older whose history read never answers: the screen's rows, truncated, with the reading note, within the budget (the default 2 s)", async () => {
    const fake = new FakeHcCore();
    const adapter = new HerdrCoreMux(fake, "/home/dev", { log: () => undefined });
    fake.hangHistoryReads("t1");
    const started = performance.now();
    const grid = await adapter.readGrid("t1", OLDER);
    const took = performance.now() - started;
    if (!grid.ok) throw new Error(grid.detail);
    expect(took).toBeGreaterThanOrEqual(HISTORY_READ_BUDGET_MS - 20);
    expect(took).toBeLessThan(HISTORY_READ_BUDGET_MS + 500);
    expect(grid.value.truncated).toBe(true);
    expect(grid.value.olderNote).toBe(OLDER_NOTE_READING);
    expect(grid.value.partial).toBeUndefined();
    expect(grid.value.text).toContain("Allow edit to src/x.ts?");
    expect(grid.value.text).not.toContain("earlier line");
  });
});

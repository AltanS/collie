import { describe, expect, test } from "bun:test";

import { TIMED_OUT_CODE, timedOutMessage, type ZellijRunResult } from "./exec.ts";
import { FakeZellij, SESSION, zellijWorld } from "./fixture.ts";

describe("whether a space has a name of its own (M98)", () => {
  test("a zellij session always has one: the operator's name or zellij's own generated one", async () => {
    const { panes } = await zellijWorld(new FakeZellij()).world.adapter.snapshot();
    expect(panes.length).toBeGreaterThan(0);
    for (const pane of panes) {
      expect(pane.spaceLabel).toBe(SESSION);
      expect(pane.spaceNamed).toBe(true);
    }
  });
});

// M100 spec 03, item 2: a `write-chars` that ran out of budget was killed, maybe after it wrote. It is
// `unconfirmed` (the caller reads the box), never a refusal (which read as "nothing typed").
describe("a text write zellij does not finish in time", () => {
  class SlowZellij extends FakeZellij {
    override async run(args: readonly string[]): Promise<ZellijRunResult> {
      if (args.includes("write-chars")) return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, 5000) };
      return super.run(args);
    }
  }

  test("typeText answers unconfirmed, and says it may still arrive", async () => {
    const { adapter } = zellijWorld(new SlowZellij()).world;
    const pane = (await adapter.snapshot()).panes[0]!;
    const ack = await adapter.typeText(pane.paneId, "hello");
    expect(ack.ok ? "ok" : ack.reason).toBe("unconfirmed");
    if (!ack.ok) expect(ack.detail).toContain("may still arrive");
  });

  test("a write zellij refuses with its own exit code stays refused", async () => {
    class Refusing extends FakeZellij {
      override async run(args: readonly string[]): Promise<ZellijRunResult> {
        if (args.includes("write-chars")) return { code: 1, stdout: "", stderr: "no such pane" };
        return super.run(args);
      }
    }
    const { adapter } = zellijWorld(new Refusing()).world;
    const pane = (await adapter.snapshot()).panes[0]!;
    const ack = await adapter.typeText(pane.paneId, "hello");
    expect(ack.ok ? "ok" : ack.reason).toBe("refused");
  });
});

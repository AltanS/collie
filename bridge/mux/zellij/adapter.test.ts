import { describe, expect, test } from "bun:test";

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

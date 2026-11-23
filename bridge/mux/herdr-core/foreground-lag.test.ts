import { describe, expect, test } from "bun:test";

import { herdrMuxFactory } from "../herdr/adapter.ts";
import { tmuxMuxFactory } from "../tmux/adapter.ts";
import { zellijMuxFactory } from "../zellij/adapter.ts";
import { HERDR_CORE_FOREGROUND_LAG_MS, herdrCoreMuxFactory } from "./adapter.ts";

// The core answers a pane's foreground from its last snapshot, so its factory says how long that read may
// trail a new process (2026-11-24); the hook edges hold an edge that long. A live read says nothing, and its
// edges drop at once as before.

describe("the foreground lag a factory declares", () => {
  test("herdr-core declares its snapshot lag, within the 2 to 3 s the core's cadence gives", () => {
    expect(herdrCoreMuxFactory.foregroundLagMs).toBe(HERDR_CORE_FOREGROUND_LAG_MS);
    expect(HERDR_CORE_FOREGROUND_LAG_MS).toBeGreaterThanOrEqual(2000);
    expect(HERDR_CORE_FOREGROUND_LAG_MS).toBeLessThanOrEqual(3000);
  });

  test("Herdr, tmux and zellij declare none", () => {
    for (const factory of [herdrMuxFactory, tmuxMuxFactory, zellijMuxFactory]) expect(factory.foregroundLagMs).toBeUndefined();
  });
});

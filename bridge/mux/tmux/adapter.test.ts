import { describe, expect, test } from "bun:test";

import { TmuxMux } from "./adapter.ts";
import { FakeTmux } from "./fixture.ts";

// THE TWO THINGS CONFORMANCE CANNOT ASK FOR, pinned here on the real adapter over the real fake.
//
// Conformance (../conformance.test.ts) drives every capability of this adapter already. What it has
// no vocabulary for is a hazard that belongs to ONE multiplexer's binary, and a transport that dies
// mid-call:
//
//  • **The #4849 spawn guard.** tmux ≤ 3.6b segfaults its whole SERVER when it spawns a window while
//    the global `window-size` is `manual` — so the interesting assertion is that the argv was never
//    issued, which is a question about tmux's own option and no other adapter's.
//  • **Transport death.** The contract owns the rule (`unreachable`, never `refused` —
//    MUX_CONTRACT.md § Contract-owned rules), but the WORLD contract has no perturbation for it:
//    `reconnect()` models a socket that was already gone, and teaching every fixture in the registry
//    to kill a live transport mid-call would push a tmux-shaped fault onto Herdr and zellij, whose
//    transports fail in their own words. So it is pinned here, per-adapter, and the rule lives in the
//    contract for the next adapter to meet the same way.

/** The one sentence the operator sees, and it ends in the command that clears it. */
const REFUSAL =
  "tmux 3.6b crashes when it spawns a window while window-size is manual (tmux #4849, fixed in 3.7) — run: tmux set -g window-size latest";

/** Whether the fake was ever asked to spawn anything. The assertion the whole guard exists for. */
function spawned(fake: FakeTmux): boolean {
  return fake.invocations().some((group) => group.at(0) === "new-window" || group.at(0) === "new-session");
}

describe("the #4849 spawn guard", () => {
  test("a create on tmux 3.6b under `window-size manual` is refused, and NOTHING is spawned", async () => {
    const fake = new FakeTmux();
    fake.setWindowSize("manual");
    fake.setVersion("3.6b");
    const adapter = new TmuxMux(fake);

    const tab = await adapter.createTab({ spaceId: "$1" });
    expect(tab.ok).toBe(false);
    if (tab.ok) throw new Error("unreachable");
    expect(tab.reason).toBe("refused");
    expect(tab.detail).toBe(REFUSAL);

    const space = await adapter.createSpace({ cwd: "/tmp" });
    expect(space.ok).toBe(false);
    if (space.ok) throw new Error("unreachable");
    expect(space.reason).toBe("refused");
    expect(space.detail).toBe(REFUSAL);

    // The point of the whole change: the argv that kills the operator's server never reached tmux.
    expect(spawned(fake)).toBe(false);
  });

  test("the version is read once and then cached — a running server cannot change its binary", async () => {
    const fake = new FakeTmux();
    fake.setWindowSize("manual");
    const adapter = new TmuxMux(fake);
    await adapter.createTab({ spaceId: "$1" });
    await adapter.createTab({ spaceId: "$1" });
    const versionProbes = fake.invocations().filter((group) => group.at(0) === "display-message");
    expect(versionProbes.length).toBe(1);
    // The option itself is asked EVERY time: the operator can change it between two taps.
    expect(fake.invocations().filter((group) => group.at(0) === "show-options").length).toBe(2);
  });

  test("`manual` on tmux 3.7 spawns — the fix is in, so there is nothing to guard", async () => {
    const fake = new FakeTmux();
    fake.setWindowSize("manual");
    fake.setVersion("3.7");
    const created = await new TmuxMux(fake).createTab({ spaceId: "$1" });
    expect(created.ok).toBe(true);
    expect(spawned(fake)).toBe(true);
  });

  test("`window-size latest` on tmux 3.6b spawns — the hazard is the option, not the version", async () => {
    const fake = new FakeTmux();
    fake.setVersion("3.6b");
    const created = await new TmuxMux(fake).createTab({ spaceId: "$1" });
    expect(created.ok).toBe(true);
    expect(spawned(fake)).toBe(true);
  });

  test("a version tmux does not report reads as unsafe, and the sentence still says what to run", async () => {
    const fake = new FakeTmux();
    fake.setWindowSize("manual");
    fake.setVersion("");
    const created = await new TmuxMux(fake).createTab({ spaceId: "$1" });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("unreachable");
    expect(created.detail).toContain("this tmux crashes when it spawns a window");
    expect(created.detail).toContain("tmux set -g window-size latest");
    expect(spawned(fake)).toBe(false);
  });
});

describe("a transport that dies during the call", () => {
  test("`server exited unexpectedly` is `unreachable`, never `refused`", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    fake.killServerMidCall();

    const created = await adapter.createTab({ spaceId: "$1" });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("unreachable");
    expect(created.reason).toBe("unreachable");

    // Not a create-only rule: every write answers the same way, which is what raises one banner
    // instead of a red refusal per tap.
    const typed = await adapter.typeText("%3", "hello");
    expect(typed.ok).toBe(false);
    if (typed.ok) throw new Error("unreachable");
    expect(typed.reason).toBe("unreachable");
  });
});

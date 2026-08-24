import { describe, expect, test } from "bun:test";

import { TmuxMux } from "./adapter.ts";
import { FakeTmux } from "./fixture.ts";

// THE THINGS CONFORMANCE CANNOT ASK FOR, pinned here on the real adapter over the real fake.
//
// Conformance (../conformance.test.ts) drives every capability of this adapter already — including
// the contract's *Pane naming* rule, which the world contract CAN express (a program printing a
// title is a perturbation). What it has no vocabulary for is what that rule costs on tmux
// specifically — a title outliving its program, and a label outliving the process that remembers it
// — plus a hazard that belongs to ONE multiplexer's binary and a transport that dies mid-call:
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

/** The pane the seeded world gives a title to, and the title it carries. */
const TITLED_PANE = "%3";

/** One pane out of a fresh snapshot. */
async function paneOf(adapter: TmuxMux, paneId: string) {
  const pane = (await adapter.snapshot()).panes.find((candidate) => candidate.paneId === paneId);
  if (pane === undefined) throw new Error(`the fake lost pane ${paneId}`);
  return pane;
}

describe("tmux's one title slot", () => {
  test("a title the pane printed is a terminalTitle — never the operator's label", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    await fake.setProgramTitle(TITLED_PANE, "✳ waiting for soak time - server performance");

    const pane = await paneOf(adapter, TITLED_PANE);
    expect(pane.paneLabel).toBeUndefined();
    // Verbatim, glyph included: it is the program's own text, and Collie does not edit it.
    expect(pane.terminalTitle).toBe("✳ waiting for soak time - server performance");
  });

  test("a label set THROUGH Collie is the operator's, and clearing it hands the slot back", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);

    await adapter.renamePane(TITLED_PANE, "deploy");
    const labelled = await paneOf(adapter, TITLED_PANE);
    expect(labelled.paneLabel).toBe("deploy");
    // One slot, one string: the label is not ALSO reported as something the program said.
    expect(labelled.terminalTitle).toBeUndefined();

    await adapter.renamePane(TITLED_PANE, null);
    await fake.setProgramTitle(TITLED_PANE, "✳ back to being the program's");
    const cleared = await paneOf(adapter, TITLED_PANE);
    expect(cleared.paneLabel).toBeUndefined();
    expect(cleared.terminalTitle).toBe("✳ back to being the program's");
  });

  test("a program that overwrites the operator's label takes the slot back with it", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    await adapter.renamePane(TITLED_PANE, "deploy");
    await fake.setProgramTitle(TITLED_PANE, "✳ Reticulating splines");

    const pane = await paneOf(adapter, TITLED_PANE);
    expect(pane.paneLabel).toBeUndefined();
    expect(pane.terminalTitle).toBe("✳ Reticulating splines");
  });

  test("the memory is this process's: a fresh adapter reads its own earlier label as a title", async () => {
    const fake = new FakeTmux();
    await new TmuxMux(fake).renamePane(TITLED_PANE, "deploy");

    // What a `systemctl restart collie` looks like from tmux's side: the slot still holds the label,
    // and nothing alive remembers setting it. It degrades to a title — visible, never a false claim.
    const pane = await paneOf(new TmuxMux(fake), TITLED_PANE);
    expect(pane.paneLabel).toBeUndefined();
    expect(pane.terminalTitle).toBe("deploy");
  });

  // A pane that goes away drops its remembered label (`forgetGonePanes`), and that is memory hygiene
  // rather than behaviour: tmux never recycles a pane id (identity rule 4, pinned by conformance), so
  // no snapshot can ever be made to show the difference. There is nothing here to assert without
  // reaching into the adapter's private map, which would pin the mechanism instead of the rule.

  test("an exited program leaves `bash` in the foreground and its title behind", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    await fake.setProgramTitle(TITLED_PANE, "✳ waiting for soak time - server performance");
    await fake.exitProgram(TITLED_PANE);

    const pane = await paneOf(adapter, TITLED_PANE);
    // Both raw facts, reported as raw facts. Reading them TOGETHER as a stale title is the bridge's
    // job (state-engine.ts) — the adapter neither drops the title nor explains it.
    expect(pane.foregroundCommand).toBe("bash");
    expect(pane.terminalTitle).toBe("✳ waiting for soak time - server performance");
    expect(pane.paneLabel).toBeUndefined();
    expect(pane.agent).toBe("shell");
  });
});

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

// WHICH SESSION THE OPERATOR IS LOOKING AT — a question only tmux poses this way, because only tmux
// lets this adapter attach clients of its own. Conformance asks whether focus is reported and whether
// `setFocus` moves it; it has no vocabulary for "and Collie's own control client is not a person",
// which is the mistake the old activity-only heuristic was written around rather than fixed.
describe("focus follows a real terminal, not this adapter's own watch", () => {
  test("a session with a non-control client attached is the focused space", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    // The seeded world's SECOND session is the last-active one, so the activity fallback would pick
    // it — which is what makes attaching a terminal to the first one a real assertion.
    fake.attachClient("collie", { activity: 10 });

    const spaces = (await adapter.snapshot()).spaces;
    expect(spaces.find((space) => space.focused)?.label).toBe("collie");
  });

  test("a control client is nobody's screen — the fallback answers instead", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    fake.attachClient("collie", { control: true, activity: 99 });

    const spaces = (await adapter.snapshot()).spaces;
    expect(spaces.find((space) => space.focused)?.label).toBe("scratch");
  });

  test("`setFocus` moves the window and the pane in ONE invocation", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);

    const moved = await adapter.setFocus("%4");
    expect(moved.ok).toBe(true);
    // `;`-joined, so the fake splits it into two commands and BOTH ran — a screen left half-moved,
    // showing the right window and the wrong pane, is what the single invocation avoids.
    expect(fake.invocations().some((invocation) => invocation.at(0) === "select-window")).toBe(true);
    expect(fake.invocations().some((invocation) => invocation.at(0) === "select-pane")).toBe(true);
    expect((await paneOf(adapter, "%4")).focused).toBe(true);
  });

  test("`setFocus` carries an attached terminal that is sitting on another session", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    // The operator's terminal is on `scratch`; the pane they tapped lives in `collie`. Selecting the
    // window alone moves `collie`'s own current window and NOTHING on their screen.
    fake.attachClient("scratch", { tty: "/dev/pts/7" });

    const moved = await adapter.setFocus("%3");
    expect(moved.ok).toBe(true);
    const switched = fake.invocations().filter((invocation) => invocation.at(0) === "switch-client");
    expect(switched).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", "$1"]]);
    expect(fake.clientSessions().get("/dev/pts/7")).toBe("collie");
  });

  test("`setFocus` switches nothing when the terminal is already on the pane's session", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    fake.attachClient("collie", { tty: "/dev/pts/7" });

    const moved = await adapter.setFocus("%3");
    expect(moved.ok).toBe(true);
    expect(fake.invocations().some((invocation) => invocation.at(0) === "switch-client")).toBe(false);
  });

  test("`setFocus` never switches this adapter's own control client", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    fake.attachClient("scratch", { control: true, tty: "/dev/pts/9" });

    const moved = await adapter.setFocus("%3");
    expect(moved.ok).toBe(true);
    expect(fake.invocations().some((invocation) => invocation.at(0) === "switch-client")).toBe(false);
  });

  test("`setFocus` at a pane that has gone answers `gone` and spawns nothing", async () => {
    const fake = new FakeTmux();
    const adapter = new TmuxMux(fake);
    await fake.endPane("%3");

    const moved = await adapter.setFocus("%3");
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("unreachable");
    expect(moved.reason).toBe("gone");
    expect(fake.invocations().some((invocation) => invocation.at(0) === "select-window")).toBe(false);
  });
});

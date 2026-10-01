import { describe, expect, test } from "bun:test";

import { TuiosMux } from "./adapter.ts";
import { TuiosError, type WireHello, type WireSession, type WireWindowList } from "./client.ts";
import { FakeTuios } from "./fixture.ts";

// Three promises the conformance world does not reach: the pinned handshake, a revision that stays
// monotone across a daemon restart (tuios counts every pane's revision from 0 again), and a window
// on another machine being left out.

/** A daemon that answers the handshake with a protocol this adapter does not speak. */
class OtherProtocol extends FakeTuios {
  override hello(): Promise<WireHello> {
    return Promise.reject(new TuiosError("protocol_mismatch", "tuios hello: protocol_mismatch: client speaks 1, daemon serves 2 to 3"));
  }
}

/** A protocol-1 daemon from before `workspace-renamed`. */
class BeforeWorkspaceEvents extends FakeTuios {
  override subscribeTypes(): Promise<string[]> {
    return Promise.resolve(["window-created", "window-closed", "gap"]);
  }
}

describe("the daemon is pinned", () => {
  test("a protocol mismatch reads as unreachable, and the snapshot says what to update", async () => {
    const mux = new TuiosMux(new OtherProtocol());
    expect(await mux.reachable()).toBe(false);
    await expect(mux.snapshot()).rejects.toThrow("does not speak protocol 1");
  });

  test("a daemon without workspace-renamed is refused the same way", async () => {
    const mux = new TuiosMux(new BeforeWorkspaceEvents());
    expect(await mux.reachable()).toBe(false);
    await expect(mux.snapshot()).rejects.toThrow("does not send workspace-renamed events");
  });

  test("a current daemon is reachable", async () => {
    expect(await new TuiosMux(new FakeTuios()).reachable()).toBe(true);
  });
});

describe("revision", () => {
  test("never goes backwards when the daemon restarts and counts from 0 again", async () => {
    const fake = new FakeTuios();
    const mux = new TuiosMux(fake);
    const pane = (await mux.snapshot()).panes[0];
    if (pane === undefined) throw new Error("the fake has no pane");
    const read = async () => {
      const grid = await mux.readGrid(pane.paneId, { scope: "viewport", lines: 20, styling: "strip" });
      if (!grid.ok) throw new Error(grid.detail);
      return grid.value.revision;
    };
    await fake.changePane(pane.paneId);
    await fake.changePane(pane.paneId);
    const before = await read();
    await fake.restartMux();
    const after = await read();
    expect(after).toBeGreaterThan(before);
    await fake.changePane(pane.paneId);
    expect(await read()).toBeGreaterThan(after);
  });
});

/** A daemon with one extra window whose process runs on a linked host. */
class WithRemoteWindow extends FakeTuios {
  static readonly REMOTE = "00000000-0000-4000-8000-00000000beef";

  override async listSessions(): Promise<WireSession[]> {
    const [first, ...rest] = await super.listSessions();
    if (first === undefined) return rest;
    return [{ ...first, windowIds: [...first.windowIds, WithRemoteWindow.REMOTE] }, ...rest];
  }

  override async listWindows(sessionName: string): Promise<WireWindowList> {
    const listed = await super.listWindows(sessionName);
    const first = listed.windows[0];
    if (sessionName !== "collie" || first === undefined) return listed;
    const remote = { ...first, windowId: WithRemoteWindow.REMOTE, focused: false, host: "nas" };
    return { ...listed, windows: [...listed.windows, remote] };
  }
}

describe("a window on another machine", () => {
  test("is not a pane here, and does not count", async () => {
    const mux = new TuiosMux(new WithRemoteWindow());
    const snapshot = await mux.snapshot();
    expect(snapshot.panes.map((pane) => pane.paneId)).not.toContain(WithRemoteWindow.REMOTE);
    const space = snapshot.spaces.find((candidate) => candidate.label === "collie");
    expect(space?.paneCount).toBe(snapshot.panes.filter((pane) => pane.spaceLabel === "collie").length);
  });

  test("answers gone to a pane-addressed call", async () => {
    const mux = new TuiosMux(new WithRemoteWindow());
    const typed = await mux.typeText(WithRemoteWindow.REMOTE, "x");
    expect(typed.ok ? "ok" : typed.reason).toBe("gone");
  });
});

/** A daemon whose first window has tuios's placeholder title and whose second has a real one. */
class WithPlaceholderTitle extends FakeTuios {
  override async listWindows(sessionName: string): Promise<WireWindowList> {
    const listed = await super.listWindows(sessionName);
    if (sessionName !== "collie") return listed;
    const windows = listed.windows.map((window, index) =>
      index === 0 ? { ...window, title: `Terminal ${window.windowId.slice(0, 8)}` } : { ...window, title: "npm run dev" },
    );
    return { ...listed, windows };
  }
}

describe("the title tuios gives a window before its program sets one", () => {
  test("is not the program's title", async () => {
    const snapshot = await new TuiosMux(new WithPlaceholderTitle()).snapshot();
    const [placeholder, titled] = snapshot.panes.filter((pane) => pane.spaceLabel === "collie");
    expect(placeholder?.terminalTitle).toBeUndefined();
    // The positive half: a title the program did set still arrives.
    expect(titled?.terminalTitle).toBe("npm run dev");
  });
});

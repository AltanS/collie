import { describe, expect, test } from "bun:test";

import { TMUX_MUX } from "./adapter.ts";
import type { TmuxExec, TmuxControlClient, TmuxControlHandlers, TmuxRunResult } from "./exec.ts";
import { FakeTmux, FAKE_TMUX_SOCKET } from "./fixture.ts";
import { tmuxBeaconMatcher, TMUX_SOCKET_PATH_ARGS } from "./markers.ts";
import type { MuxPane } from "../types.ts";

// The tmux half of the beacon join: the pane id is tmux's own, and the scope is the server socket.

function pane(paneId: string): MuxPane {
  return {
    paneId,
    spaceId: "$1",
    spaceLabel: "collie",
    spaceNumber: 1,
    tabId: "@2",
    cwd: "/tmp",
    focused: false,
    alive: true,
    agent: "shell",
    status: "unknown",
  };
}

/** A tmux that answers nothing — no server, no binary. */
class SilentTmux implements TmuxExec {
  constructor(private readonly result: TmuxRunResult) {}
  run(): Promise<TmuxRunResult> {
    return Promise.resolve(this.result);
  }
  control(_args: readonly string[], _handlers: TmuxControlHandlers): TmuxControlClient {
    return { kill: () => undefined };
  }
}

describe("tmuxBeaconMatcher", () => {
  test("reads its own namespace, which is the registry key the emitter writes", () => {
    expect(tmuxBeaconMatcher(TMUX_MUX, new FakeTmux()).namespace).toBe(TMUX_MUX);
  });

  test("the scope is the server's own socket path, asked of the server", async () => {
    expect(await tmuxBeaconMatcher(TMUX_MUX, new FakeTmux()).scope()).toBe(FAKE_TMUX_SOCKET);
    expect(TMUX_SOCKET_PATH_ARGS).toEqual(["display-message", "-p", "-F", "#{socket_path}"]);
  });

  test("a server that does not answer has no scope, so nothing joins", async () => {
    const refused = new SilentTmux({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" });
    expect(await tmuxBeaconMatcher(TMUX_MUX, refused).scope()).toBeNull();
    const silent = new SilentTmux({ code: 0, stdout: "\n", stderr: "" });
    expect(await tmuxBeaconMatcher(TMUX_MUX, silent).scope()).toBeNull();
  });

  test("TMUX_PANE is the Collie pane id, unchanged", () => {
    const matcher = tmuxBeaconMatcher(TMUX_MUX, new FakeTmux());
    expect(matcher.matches(pane("%7"), { namespace: TMUX_MUX, scope: FAKE_TMUX_SOCKET, pane: "%7" }, FAKE_TMUX_SOCKET)).toBe(true);
    expect(matcher.matches(pane("%7"), { namespace: TMUX_MUX, scope: FAKE_TMUX_SOCKET, pane: "7" }, FAKE_TMUX_SOCKET)).toBe(false);
  });

  test("another server's same-numbered pane is a different pane", () => {
    const matcher = tmuxBeaconMatcher(TMUX_MUX, new FakeTmux());
    expect(matcher.matches(pane("%7"), { namespace: TMUX_MUX, scope: "/tmp/tmux-1000/other", pane: "%7" }, FAKE_TMUX_SOCKET)).toBe(false);
  });
});
